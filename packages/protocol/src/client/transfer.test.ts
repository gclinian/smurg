import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concatBytes } from '../bytes.ts';
import { TRANSFER_BUFFERED_AMOUNT_MAX, TRANSFER_WINDOW_CHUNKS } from '../constants.ts';
import { SmurgError } from '../errors.ts';
import { MAIN_ROOT } from '../schema/paths.ts';
import { ClientRequestError } from './errors.ts';
import {
  AckWindow,
  bitmapHas,
  missingChunks,
  uploadChunkCount,
  uploadChunkRange,
  uploadRootHash,
  waitForBufferedAmount,
  type TransferConnection,
} from './transfer.ts';
import { FAKE_TIMERS, connect, connectTransfer, createDevice, createWorld, settle, type World } from './testing/world.ts';

const DISK = {
  totalBytes: 100,
  availableBytes: 90,
  reserveBytes: 5,
  pendingBytes: 0,
  requestedBytes: 10,
  freeAfterBytes: 80,
  ok: true,
};
const BEGIN = { root: MAIN_ROOT, path: 'big.bin', size: 10, chunkSize: 1 << 22, lastModified: 1 };
const BEGIN_OK = { uploadId: 'up_1', chunkCount: 1, have: new Uint8Array(1), received: 0, resumed: false, disk: DISK };

let opened: { close(): void }[] = [];

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
});

afterEach(() => {
  for (const c of opened) c.close();
  opened = [];
  vi.useRealTimers();
});

/** A device that already joined (so the transfer socket connects in device mode, as in the product). */
async function transferOnline(world: World): Promise<TransferConnection> {
  const device = createDevice(world);
  const invite = world.daemon.createInvite();
  const interactive = connect(world, device, { invite: invite.trust });
  opened.push(interactive);
  interactive.start();
  await settle();
  expect(interactive.getState().kind).toBe('online');
  const xfer = connectTransfer(world, device);
  opened.push(xfer);
  xfer.start();
  await settle();
  expect(xfer.getState().kind).toBe('online');
  return xfer;
}

describe('TransferConnection', () => {
  it('runs its own handshake on /xfer (purpose transfer, no resume) and answers typed requests', async () => {
    const world = createWorld();
    world.daemon.handlers['file.upload.begin'] = () => BEGIN_OK;
    const xfer = await transferOnline(world);
    const ws = world.relay.lastSocket();
    expect(ws.kind).toBe('xfer');
    expect(new URL(ws.url).pathname).toBe(`/xfer/${world.daemon.workspaceId}/client`);
    const result = await xfer.request('file.upload.begin', BEGIN);
    expect(result.uploadId).toBe('up_1');
    expect(bitmapHas(result.have, 0)).toBe(false);
    // Two admissions: interactive (invite) + transfer (device).
    expect(world.daemon.admissions.map((a) => a.mode)).toEqual(['invite', 'device']);
    expect(world.daemon.receivedOf('file.upload.begin')[0]?.seq).toBe(1);
  });

  it('never sends channel.ack and has no outbox: offline requests fail at once, in-flight ones fail on loss', async () => {
    const world = createWorld();
    world.daemon.handlers['file.upload.begin'] = () => new Promise(() => {});
    world.daemon.handlers['file.upload.abort'] = () => ({});
    const xfer = await transferOnline(world);
    const inFlight = xfer.request('file.upload.begin', BEGIN).catch((e: unknown) => e);
    await settle();
    world.relay.drop(world.relay.lastSocket());
    await settle();
    expect(await inFlight).toMatchObject({ failure: 'connection-lost' });
    expect(xfer.getState().kind).toBe('relay-unreachable');
    await expect(xfer.request('file.upload.abort', { uploadId: 'up_1' })).rejects.toMatchObject({ failure: 'not-connected' });
    expect(xfer.notify('file.download.ack', { downloadId: 'd', index: 0 })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(xfer.getState().kind).toBe('online');
    await xfer.request('file.upload.abort', { uploadId: 'up_1' });
    expect(world.daemon.receivedOf('file.upload.begin')).toHaveLength(1); // nothing was replayed
    expect(world.daemon.acksReceived).toEqual([]);
    // The transfer channel never goes host-offline for silence (the daemon sends no heartbeat on it).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(xfer.getState().kind).toBe('online');
  });

  it('connects in device mode only: without a pin it ends as closed(no-trust) and never touches an invite', async () => {
    const world = createWorld();
    const xfer = connectTransfer(world, createDevice(world));
    opened.push(xfer);
    xfer.start();
    await settle();
    expect(xfer.getState()).toEqual({ kind: 'closed', reason: 'no-trust' });
    expect(world.daemon.admissions).toEqual([]);
  });

  it('refuses interactive-only messages at runtime too', async () => {
    const world = createWorld();
    const xfer = await transferOnline(world);
    // @ts-expect-error — not a transfer request
    await expect(xfer.request('lock.list', {})).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'channel' } });
  });

  it('download(): chunks that arrive right behind begin.ok are delivered in order and acknowledged after onChunk', async () => {
    const world = createWorld();
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    world.daemon.handlers['file.download.begin'] = () => ({ downloadId: 'dl_1', name: 'a.bin', size: 6, zip: false });
    world.daemon.afterReply = (type) => {
      if (type !== 'file.download.begin') return;
      let offset = 0;
      parts.forEach((data, index) => {
        world.daemon.broadcastTransfer('file.download.chunk', { downloadId: 'dl_1', index, offset, data });
        offset += data.length;
      });
      world.daemon.broadcastTransfer('file.download.end', { downloadId: 'dl_1', totalBytes: 6, skipped: [], zip64: false });
    };
    const xfer = await transferOnline(world);
    const written: Uint8Array[] = [];
    const acksAtWrite: number[] = [];
    const download = await xfer.download(
      { file: { root: MAIN_ROOT, path: 'a.bin' } },
      {
        onChunk: async (chunk) => {
          acksAtWrite.push(world.daemon.receivedOf('file.download.ack').length);
          written.push(chunk.data);
          await Promise.resolve();
        },
      },
    );
    expect(download.info).toMatchObject({ downloadId: 'dl_1', size: 6 });
    const end = await download.done;
    expect(end.totalBytes).toBe(6);
    expect(concatBytes(...written)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    await settle();
    expect(world.daemon.receivedOf('file.download.ack').map((r) => (r.payload as { index: number }).index)).toEqual([0, 1, 2]);
    expect(acksAtWrite).toEqual([0, 1, 2]); // each ack went out only after the previous chunk was written
  });

  it('download(): end.error rejects done with the daemon error; cancel sends file.download.cancel', async () => {
    const world = createWorld();
    world.daemon.handlers['file.download.begin'] = (p: { file: { path: string } }) => ({
      downloadId: p.file.path === 'broken' ? 'dl_err' : 'dl_slow',
      name: 'x.bin',
      zip: false,
    });
    world.daemon.afterReply = (type, result) => {
      if (type === 'file.download.begin' && (result as { downloadId: string }).downloadId === 'dl_err') {
        world.daemon.broadcastTransfer('file.download.end', {
          downloadId: 'dl_err',
          totalBytes: 0,
          skipped: [],
          zip64: false,
          error: { code: 'not_found', message: 'gone' },
        });
      }
    };
    const xfer = await transferOnline(world);
    const broken = await xfer.download({ file: { root: MAIN_ROOT, path: 'broken' } }, { onChunk: () => {} });
    const error = await broken.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmurgError);
    expect(error).toMatchObject({ code: 'not_found' });

    const controller = new AbortController();
    const slow = await xfer.download({ file: { root: MAIN_ROOT, path: 'slow' } }, { onChunk: () => {}, signal: controller.signal });
    controller.abort();
    expect(await slow.done.catch((e: unknown) => e)).toMatchObject({ failure: 'cancelled' });
    await settle();
    expect(world.daemon.receivedOf('file.download.cancel').map((r) => r.payload)).toEqual([{ downloadId: 'dl_slow' }]);
  });

  it('download(): a throwing onChunk cancels the download; losing the socket rejects done', async () => {
    const world = createWorld();
    world.daemon.handlers['file.download.begin'] = () => ({ downloadId: 'dl_1', name: 'a.bin', zip: true });
    world.daemon.afterReply = () => {
      world.daemon.broadcastTransfer('file.download.chunk', { downloadId: 'dl_1', index: 0, offset: 0, data: new Uint8Array([1]) });
    };
    const xfer = await transferOnline(world);
    const failing = await xfer.download({ file: { root: MAIN_ROOT, path: 'a' } }, {
      onChunk: () => {
        throw new Error('disk full');
      },
    });
    expect(await failing.done.catch((e: unknown) => (e as Error).message)).toBe('disk full');
    await settle();
    expect(world.daemon.receivedOf('file.download.cancel')).toHaveLength(1);

    world.daemon.afterReply = null;
    const pending = await xfer.download({ file: { root: MAIN_ROOT, path: 'b' } }, { onChunk: () => {} });
    world.relay.drop(world.relay.lastSocket());
    await settle();
    expect(await pending.done.catch((e: unknown) => e)).toMatchObject({ failure: 'connection-lost' });
  });

  it('waitForDrain() follows the socket bufferedAmount', async () => {
    const world = createWorld();
    const xfer = await transferOnline(world);
    const ws = world.relay.lastSocket();
    ws.bufferedAmount = TRANSFER_BUFFERED_AMOUNT_MAX + 1;
    let drained = false;
    const wait = xfer.waitForDrain().then(() => (drained = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(drained).toBe(false);
    ws.bufferedAmount = TRANSFER_BUFFERED_AMOUNT_MAX;
    await vi.advanceTimersByTimeAsync(5);
    await wait;
    expect(drained).toBe(true);
  });
});

describe('AckWindow', () => {
  it('admits at most `size` at a time, FIFO, and reports idle', async () => {
    const window = new AckWindow();
    expect(window.size).toBe(TRANSFER_WINDOW_CHUNKS);
    for (let i = 0; i < 4; i++) await window.acquire();
    const order: number[] = [];
    const fifth = window.acquire().then(() => order.push(5));
    const sixth = window.acquire().then(() => order.push(6));
    await Promise.resolve();
    expect(order).toEqual([]);
    window.release();
    await fifth;
    expect(order).toEqual([5]);
    window.release();
    await sixth;
    expect(order).toEqual([5, 6]);
    expect(window.inFlight).toBe(4);
    let idle = false;
    const idlePromise = window.idle().then(() => (idle = true));
    for (let i = 0; i < 3; i++) window.release();
    await Promise.resolve();
    expect(idle).toBe(false);
    window.release();
    await idlePromise;
    expect(idle).toBe(true);
    expect(() => window.release()).toThrow();
  });

  it('run() releases on failure; waiters can be cancelled or rejected', async () => {
    const window = new AckWindow(1);
    await expect(window.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(window.inFlight).toBe(0);
    await window.acquire();
    const controller = new AbortController();
    const cancelled = window.acquire(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ClientRequestError);
    const rejected = window.acquire();
    window.rejectWaiters(new Error('connection lost'));
    await expect(rejected).rejects.toThrow('connection lost');
    expect(window.inFlight).toBe(1);
    expect(() => new AckWindow(0)).toThrow(RangeError);
  });
});

describe('waitForBufferedAmount', () => {
  it('polls every 5 ms until the amount is at most 8 MiB; abortable', async () => {
    let amount = 20 * 1024 * 1024;
    let done = false;
    const wait = waitForBufferedAmount(() => amount).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4);
    amount = 8 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(done).toBe(true);
    await expect(waitForBufferedAmount({ bufferedAmount: 0 })).resolves.toBeUndefined();
    const controller = new AbortController();
    const aborted = waitForBufferedAmount({ bufferedAmount: 1e9 }, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ failure: 'cancelled' });
  });
});

describe('upload arithmetic', () => {
  it('chunk count and ranges', () => {
    expect(uploadChunkCount(0, 4)).toBe(0);
    expect(uploadChunkCount(1, 4)).toBe(1);
    expect(uploadChunkCount(8, 4)).toBe(2);
    expect(uploadChunkCount(9, 4)).toBe(3);
    expect(uploadChunkRange(9, 4, 2)).toEqual({ offset: 8, length: 1 });
    expect(() => uploadChunkRange(9, 4, 3)).toThrow(RangeError);
    expect(() => uploadChunkCount(-1, 4)).toThrow(RangeError);
  });

  it('rootHash = SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1), cross-checked with node:crypto', () => {
    const size = 2 ** 33 + 5; // above 4 GiB: the u64 high word matters
    const chunkSize = 1 << 22;
    const count = uploadChunkCount(size, chunkSize);
    const hashes = Array.from({ length: count }, (_, i) => createHash('sha256').update(String(i)).digest());
    const header = Buffer.alloc(12);
    header.writeBigUInt64BE(BigInt(size), 0);
    header.writeUInt32BE(chunkSize, 8);
    const expected = createHash('sha256').update(header).update(Buffer.concat(hashes)).digest();
    expect(Buffer.from(uploadRootHash(size, chunkSize, hashes.map((h) => new Uint8Array(h))))).toEqual(expected);
    expect(() => uploadRootHash(size, chunkSize, [])).toThrow(RangeError);
  });

  it('bitmap: bit i & 7 of byte i >> 3', () => {
    const have = new Uint8Array([0b0000_0101, 0b1000_0000]);
    expect([0, 1, 2, 3, 15, 16].map((i) => bitmapHas(have, i))).toEqual([true, false, true, false, true, false]);
    expect(missingChunks(have, 17).length).toBe(14);
    expect(missingChunks(have, 3)).toEqual([1]);
    expect(missingChunks(new Uint8Array(0), 2)).toEqual([0, 1]);
  });
});

describe('ClientHello on the transfer socket', () => {
  it('declares purpose transfer and never asks to resume', async () => {
    const world = createWorld();
    const xfer = await transferOnline(world);
    const hello = world.daemon.hellos.at(-1);
    expect(hello).toMatchObject({ purpose: 'transfer', clientKind: 'cli', deviceName: 'Test CLI' });
    expect(hello?.resume).toBeUndefined();
    expect(xfer.welcome?.resumed).toBe(false);
  });
});
