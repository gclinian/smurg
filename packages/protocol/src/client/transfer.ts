// The transfer connection (purpose 'transfer', ARCHITECTURE §5.2 "Transfer channel"; transfer.md §1.2-§1.6): its own
// socket to the TransferDO and its own Noise session, no outbox and no replay (uploads resume from the daemon's
// bitmap, file downloads by offset, zips restart). In the browser it runs inside a Web Worker.
//
// Flow control has two parts and needs both (transfer.md gotcha 1): the end-to-end ack window (AckWindow, at most
// TRANSFER_WINDOW_CHUNKS unacknowledged chunks per transfer) protects the relay and the daemon; waitForDrain()
// (`bufferedAmount` ≤ 8 MiB, polled every 5 ms) protects the local process.
//
// Upload loop sketch (the web / CLI engineers own the real one):
//   const begin = await xfer.request('file.upload.begin', { root, path, size, chunkSize, lastModified });
//   const window = new AckWindow();
//   for (const index of missingChunks(begin.have, begin.chunkCount)) {
//     await window.acquire(); await xfer.waitForDrain();
//     const data = readSlice(index); const hash = sha256(data); hashes[index] = hash;
//     xfer.request('file.upload.chunk', { uploadId, index, hash, data }).finally(() => window.release());
//   }
//   await window.idle();
//   await xfer.request('file.upload.commit', { uploadId, rootHash: uploadRootHash(size, chunkSize, hashes) });
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CHUNK_HASH_BYTES,
  TRANSFER_BUFFERED_AMOUNT_MAX,
  TRANSFER_BUFFERED_POLL_MS,
  TRANSFER_WINDOW_CHUNKS,
} from '../constants.ts';
import { SmurgError } from '../errors.ts';
import type { Welcome } from '../schema/handshake.ts';
import type { PayloadInputOf, PayloadOf, ResultOf } from '../schema/registry.ts';
import { ChannelEngine, type CommonConnectionOptions } from './engine.ts';
import { ClientRequestError } from './errors.ts';
import type { EventHandler, RequestOptions, TransferEventType, TransferNotifyType, TransferRequestType } from './message-types.ts';
import type { ConnectionState } from './state.ts';
import { waitForState, type WaitOptions } from './wait.ts';

/** Chunks of 4-8 MiB over a slow uplink take long: the transfer channel waits longer by default. */
export const DEFAULT_TRANSFER_REQUEST_TIMEOUT_MS = 120_000;

/**
 * No invite: the transfer socket connects in device mode only, after the interactive Connection was admitted (then the
 * device is registered and the daemon key pinned). Two sockets racing for one single-use invite would lose one join.
 */
export type TransferConnectionOptions = Omit<CommonConnectionOptions, 'invite' | 'preferInvite'>;

export interface DownloadChunk {
  readonly index: number;
  readonly offset: number;
  /** A view into the decrypted message (fresh per message): keep it or copy it, it is never reused. */
  readonly data: Uint8Array;
}

export interface DownloadOptions {
  /**
   * Called for each chunk, strictly in order. The chunk is acknowledged (one chunk of credit back to the daemon) only
   * after the returned promise resolves, so a slow disk slows the sender down. A throw cancels the download.
   */
  onChunk(chunk: DownloadChunk): void | Promise<void>;
  signal?: AbortSignal;
  /** Timeout of `file.download.begin` only. */
  timeoutMs?: number;
}

export interface ActiveDownload {
  readonly info: ResultOf<'file.download.begin'>;
  /**
   * Resolves with `file.download.end` once every chunk was handled. Rejects with the daemon's error (end.error), a
   * ClientRequestError ('cancelled', 'connection-lost', 'closed') or the error thrown by onChunk.
   */
  readonly done: Promise<PayloadOf<'file.download.end'>>;
  /** Sends file.download.cancel and rejects `done` with 'cancelled'. */
  cancel(): void;
}

export class TransferConnection {
  private readonly engine: ChannelEngine;

  constructor(options: TransferConnectionOptions) {
    this.engine = new ChannelEngine({
      ...options,
      invite: null,
      preferInvite: false,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TRANSFER_REQUEST_TIMEOUT_MS,
      purpose: 'transfer',
      silenceThresholdMs: null,
    });
  }

  start(): this {
    this.engine.start();
    return this;
  }

  close(): void {
    this.engine.close();
  }

  getState = (): ConnectionState => this.engine.getState();

  subscribe = (listener: (state: ConnectionState) => void): (() => void) => this.engine.subscribe(listener);

  get welcome(): Welcome | null {
    return this.engine.welcome;
  }

  async whenOnline(options?: WaitOptions): Promise<Welcome> {
    const state = await waitForState(this, (s) => s.kind === 'online', options);
    return (state as Extract<ConnectionState, { kind: 'online' }>).welcome;
  }

  /**
   * Rejects at once with ClientRequestError('not-connected') unless online (there is no outbox), and with
   * 'connection-lost' if the socket drops before the answer.
   */
  request<T extends TransferRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>> {
    return this.engine.request(type, payload, options) as Promise<ResultOf<T>>;
  }

  /** file.download.ack / cancel. False when not online (the message is dropped). */
  notify<T extends TransferNotifyType>(type: T, payload: PayloadInputOf<T>): boolean {
    return this.engine.notify(type, payload);
  }

  on<T extends TransferEventType>(type: T, handler: EventHandler<T>): () => void {
    return this.engine.on(type, handler as (payload: unknown, meta: { id: string; seq: number }) => void);
  }

  /** The socket's `bufferedAmount` (browser backpressure signal; 0 without a socket). */
  get bufferedAmount(): number {
    return this.engine.bufferedAmount;
  }

  /** Waits until `bufferedAmount` ≤ TRANSFER_BUFFERED_AMOUNT_MAX (8 MiB), polling every 5 ms. */
  waitForDrain(options?: BufferedAmountOptions): Promise<void> {
    return waitForBufferedAmount(this, options);
  }

  /**
   * Starts a download and delivers its chunks in order, acknowledging each after `onChunk` handled it. Listeners are
   * registered before `file.download.begin` is sent: the first chunks can arrive right behind `begin.ok`, before the
   * caller could subscribe.
   */
  async download(payload: PayloadInputOf<'file.download.begin'>, options: DownloadOptions): Promise<ActiveDownload> {
    type Event = { kind: 'chunk'; payload: PayloadOf<'file.download.chunk'> } | { kind: 'end'; payload: PayloadOf<'file.download.end'> };
    const early: Event[] = [];
    let downloadId: string | null = null;
    let handle: (event: Event) => void = () => {};
    const route = (event: Event): void => {
      if (downloadId === null) early.push(event);
      else if (event.payload.downloadId === downloadId) handle(event);
    };
    const offChunk = this.on('file.download.chunk', (p) => route({ kind: 'chunk', payload: p }));
    const offEnd = this.on('file.download.end', (p) => route({ kind: 'end', payload: p }));
    let info: ResultOf<'file.download.begin'>;
    try {
      info = await this.request('file.download.begin', payload, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch (error) {
      offChunk();
      offEnd();
      throw error;
    }
    const id = info.downloadId;
    downloadId = id;

    let resolveDone: (end: PayloadOf<'file.download.end'>) => void = () => {};
    let rejectDone: (error: unknown) => void = () => {};
    const done = new Promise<PayloadOf<'file.download.end'>>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // The caller may cancel without awaiting `done`; that must not surface as an unhandled rejection.
    done.catch(() => {});
    let finished = false;
    let chain: Promise<void> = Promise.resolve();
    let expectedIndex: number | null = null;
    const onAbort = (): void => cancel(new ClientRequestError('cancelled'));
    const offState = this.subscribe((state) => {
      if (state.kind !== 'online') finish(new ClientRequestError(state.kind === 'closed' ? 'closed' : 'connection-lost'));
    });
    const finish = (error: unknown, end?: PayloadOf<'file.download.end'>): void => {
      if (finished) return;
      finished = true;
      offChunk();
      offEnd();
      offState();
      options.signal?.removeEventListener('abort', onAbort);
      if (error === null && end) resolveDone(end);
      else rejectDone(error);
    };
    const cancel = (error: unknown): void => {
      if (finished) return;
      try {
        this.notify('file.download.cancel', { downloadId: id });
      } catch {
        // Closed: nothing to cancel.
      }
      finish(error);
    };
    handle = (event) => {
      if (finished) return;
      if (event.kind === 'chunk') {
        const chunk = event.payload;
        if (expectedIndex !== null && chunk.index !== expectedIndex) {
          cancel(new SmurgError('bad_request', 'download chunks arrived out of order', { reason: 'protocol' }));
          return;
        }
        expectedIndex = chunk.index + 1;
        chain = chain
          .then(async () => {
            if (finished) return;
            await options.onChunk({ index: chunk.index, offset: chunk.offset, data: chunk.data });
            if (!finished) this.notify('file.download.ack', { downloadId: id, index: chunk.index });
          })
          .catch((error: unknown) => cancel(error));
      } else {
        const end = event.payload;
        chain = chain.then(() => {
          if (end.error) finish(SmurgError.fromPayload(end.error));
          else finish(null, end);
        });
      }
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    if (this.getState().kind !== 'online') finish(new ClientRequestError('connection-lost'));
    for (const event of early.splice(0)) route(event);
    return { info, done, cancel: () => cancel(new ClientRequestError('cancelled')) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Flow-control primitives
// ---------------------------------------------------------------------------------------------------------------

/**
 * A counting window: at most `size` operations in flight (chunks sent but not yet acknowledged). Waiters are served
 * in FIFO order.
 */
export class AckWindow {
  readonly size: number;
  private used = 0;
  private readonly waiters: { resolve: () => void; reject: (error: unknown) => void; cleanup: () => void }[] = [];
  private readonly idleWaiters: (() => void)[] = [];

  constructor(size: number = TRANSFER_WINDOW_CHUNKS) {
    if (!(Number.isSafeInteger(size) && size >= 1)) throw new RangeError('window size must be a positive integer');
    this.size = size;
  }

  get inFlight(): number {
    return this.used;
  }

  /** Waits for a free slot and takes it. Rejects with ClientRequestError('cancelled') if `signal` fires first. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new ClientRequestError('cancelled'));
    if (this.used < this.size && this.waiters.length === 0) {
      this.used++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new ClientRequestError('cancelled'));
      };
      const waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Returns a slot (the chunk was acknowledged, or failed). */
  release(): void {
    if (this.used === 0) throw new Error('AckWindow.release() without acquire()');
    this.used--;
    const next = this.waiters.shift();
    if (next) {
      this.used++;
      next.cleanup();
      next.resolve();
    } else if (this.used === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** acquire → task → release. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Resolves when nothing is in flight. */
  idle(): Promise<void> {
    if (this.used === 0 && this.waiters.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Rejects every waiter (e.g. the connection dropped); slots already taken stay taken until released. */
  rejectWaiters(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}

export interface BufferedAmountOptions {
  /** Default TRANSFER_BUFFERED_AMOUNT_MAX (8 MiB). */
  max?: number;
  /** Default TRANSFER_BUFFERED_POLL_MS (5 ms): WebSocket has no drain event. */
  pollMs?: number;
  signal?: AbortSignal;
}

/** Resolves once `source.bufferedAmount` ≤ max. */
export function waitForBufferedAmount(
  source: { readonly bufferedAmount: number } | (() => number),
  options: BufferedAmountOptions = {},
): Promise<void> {
  const read = typeof source === 'function' ? source : () => source.bufferedAmount;
  const max = options.max ?? TRANSFER_BUFFERED_AMOUNT_MAX;
  const pollMs = options.pollMs ?? TRANSFER_BUFFERED_POLL_MS;
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new ClientRequestError('cancelled'));
  if (read() <= max) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new ClientRequestError('cancelled'));
    };
    const poll = (): void => {
      if (read() <= max) {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      } else {
        timer = setTimeout(poll, pollMs);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(poll, pollMs);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Upload arithmetic (ARCHITECTURE §5.2): chunk layout, the `have` bitmap and the hash-list root
// ---------------------------------------------------------------------------------------------------------------

function assertSizes(size: number, chunkSize: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('size must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 0xffff_ffff) throw new RangeError('invalid chunk size');
}

/** ceil(size / chunkSize); 0 for an empty file. */
export function uploadChunkCount(size: number, chunkSize: number): number {
  assertSizes(size, chunkSize);
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

/** Byte range of chunk `index` (the last one may be shorter). */
export function uploadChunkRange(size: number, chunkSize: number, index: number): { offset: number; length: number } {
  const count = uploadChunkCount(size, chunkSize);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('chunk index out of range');
  const offset = index * chunkSize;
  return { offset, length: Math.min(chunkSize, size - offset) };
}

/** `rootHash = SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1)`: the value file.upload.commit carries. */
export function uploadRootHash(size: number, chunkSize: number, chunkHashes: readonly Uint8Array[]): Uint8Array {
  const count = uploadChunkCount(size, chunkSize);
  if (chunkHashes.length !== count) throw new RangeError(`expected ${count} chunk hashes, got ${chunkHashes.length}`);
  const buffer = new Uint8Array(12 + CHUNK_HASH_BYTES * count);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, Math.floor(size / 0x1_0000_0000));
  view.setUint32(4, size >>> 0);
  view.setUint32(8, chunkSize);
  chunkHashes.forEach((hash, i) => {
    if (!(hash instanceof Uint8Array) || hash.length !== CHUNK_HASH_BYTES) throw new RangeError(`chunk hash ${i} must be 32 bytes`);
    buffer.set(hash, 12 + CHUNK_HASH_BYTES * i);
  });
  return sha256(buffer);
}

/** Bit `index & 7` of byte `index >> 3` (the daemon's `have` bitmap). */
export function bitmapHas(bitmap: Uint8Array, index: number): boolean {
  if (!Number.isSafeInteger(index) || index < 0) return false;
  const byte = bitmap[Math.floor(index / 8)];
  return byte !== undefined && (byte & (1 << (index & 7))) !== 0;
}

/** Indexes of the chunks the daemon does not have yet, ascending. */
export function missingChunks(have: Uint8Array, chunkCount: number): number[] {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) throw new RangeError('invalid chunk count');
  const missing: number[] = [];
  for (let i = 0; i < chunkCount; i++) if (!bitmapHas(have, i)) missing.push(i);
  return missing;
}
