// @vitest-environment node
// TransferManager: the socket's lifecycle (opened for work, closed when idle, reopened for a job resumed later),
// throttled progress, download outputs, the journal of interrupted uploads, and the R7.2 measurement mode.
import { describe, expect, it } from 'vitest';
import { FakeDaemonState, FakeTransferLink } from '../testing/fake-link.ts';
import { createMemoryJournal } from './journal.ts';
import { TransferManager, type ManagerEvent } from './manager.ts';
import { subtleSha256 } from './source.ts';
import { createSyntheticSource, syntheticBytes } from './synthetic-source.ts';
import type { UploadItem } from './upload-job.ts';

const MiB = 1024 * 1024;
const MAIN = { kind: 'main' } as const;
const WS = 'ws_test_transfer_000001';
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

function setup(options: { ackChunks?: 'auto' | 'manual'; linkIdleCloseMs?: number } = {}) {
  const daemon = new FakeDaemonState({ downloadChunkSize: 256 * 1024 });
  daemon.put(MAIN, 'in', 'dir');
  const links: FakeTransferLink[] = [];
  const events: ManagerEvent[] = [];
  const journal = createMemoryJournal();
  const manager = new TransferManager({
    workspaceId: WS,
    createLink: () => {
      const link = new FakeTransferLink({ daemon, uploadChunkSize: MiB, ackChunks: options.ackChunks ?? 'auto' });
      links.push(link);
      return link;
    },
    journal,
    hasher: subtleSha256,
    writers: { opfs: null },
    emit: (event) => events.push(event),
    linkIdleCloseMs: options.linkIdleCloseMs ?? 60_000,
    journalDelayMs: 0,
  });
  const last = (id: string) => [...events].reverse().find((e): e is Extract<ManagerEvent, { t: 'job' }> => e.t === 'job' && e.snapshot.id === id)?.snapshot;
  return { daemon, links, events, journal, manager, last };
}

const item = (path: string, size: number, seed: number): UploadItem => ({ path, kind: 'file', file: createSyntheticSource({ size, seed, name: path }) });

describe('TransferManager', () => {
  it('opens the transfer socket for the first job only, and closes it when nothing needs it any more', async () => {
    const { links, manager, last, events } = setup({ linkIdleCloseMs: 30 });
    expect(links).toHaveLength(0);
    manager.upload({ id: 'u1', root: MAIN, targetDir: 'in', name: 'a.bin', items: [item('a.bin', 2 * MiB, 1)] });
    expect(links).toHaveLength(1);
    await until(() => last('u1')?.status === 'done', 'u1 done');
    await until(() => links[0]?.closed === 1, 'the idle socket closed');
    expect(events.some((e) => e.t === 'link' && e.state === 'idle')).toBe(true);
    manager.upload({ id: 'u2', root: MAIN, targetDir: 'in', name: 'b.bin', items: [item('b.bin', MiB, 2)] });
    expect(links).toHaveLength(2);
    await until(() => last('u2')?.status === 'done', 'u2 done');
    await manager.dispose();
  });

  it('a job paused by the person survives the idle close and continues on a new socket', async () => {
    const { links, daemon, manager, last } = setup({ ackChunks: 'manual', linkIdleCloseMs: 30 });
    manager.upload({ id: 'u1', root: MAIN, targetDir: 'in', name: 'big.bin', items: [item('big.bin', 6 * MiB, 3)] });
    await (links[0] as FakeTransferLink).waitForHeld(4);
    manager.pause('u1');
    (links[0] as FakeTransferLink).setAckMode('auto');
    await until(() => last('u1')?.status === 'paused', 'paused');
    await until(() => links[0]?.closed === 1, 'the idle socket closed');
    manager.resume('u1');
    expect(links).toHaveLength(2);
    (links[1] as FakeTransferLink).setAckMode('auto');
    await until(() => last('u1')?.status === 'done', 'done on the second socket');
    const content = daemon.get(MAIN, 'in/big.bin');
    expect(content instanceof Uint8Array ? content.byteLength : -1).toBe(6 * MiB);
    expect((links[1] as FakeTransferLink).requestsOf('file.upload.begin')[0]?.uploadId).toBeDefined();
    await manager.dispose();
  });

  it('keeps the socket while a job waits offline for it', async () => {
    const { links, manager, last } = setup({ ackChunks: 'manual', linkIdleCloseMs: 10 });
    manager.upload({ id: 'u1', root: MAIN, targetDir: 'in', name: 'c.bin', items: [item('c.bin', 6 * MiB, 4)] });
    const link = links[0] as FakeTransferLink;
    await link.waitForHeld(4);
    link.goOffline();
    await until(() => last('u1')?.pause === 'offline', 'paused offline');
    await tick(60);
    expect(link.closed).toBe(0);
    link.setAckMode('auto');
    link.goOnline();
    await until(() => last('u1')?.status === 'done', 'done after reconnect');
    await manager.dispose();
  });

  it('reports progress at most every 200 ms per job, and every status change at once', async () => {
    const { manager, events, last } = setup();
    manager.upload({ id: 'u1', root: MAIN, targetDir: 'in', name: 'many', items: Array.from({ length: 40 }, (_, i) => item(`f${i}.bin`, 1000, i)) });
    await until(() => last('u1')?.status === 'done', 'done');
    const reports = events.filter((e) => e.t === 'job');
    // 40 files commit one after another; without the throttle that would be well over 80 reports.
    expect(reports.length).toBeLessThan(20);
    expect(reports.map((e) => (e.t === 'job' ? e.snapshot.status : '')).filter((s, i, all) => s !== all[i - 1])).toEqual(['queued', 'preparing', 'running', 'done']);
    await manager.dispose();
  });

  it('hands a finished download to the page as a Blob', async () => {
    const { daemon, manager, events, last } = setup();
    const content = syntheticBytes(5, 0, 700 * 1024);
    daemon.put(MAIN, 'in/r.bin', content);
    manager.download({ id: 'd1', file: { root: MAIN, path: 'in/r.bin' }, zip: false, name: 'r.bin' });
    await until(() => last('d1')?.status === 'done', 'download done');
    const output = events.find((e): e is Extract<ManagerEvent, { t: 'output' }> => e.t === 'output');
    expect(output?.id).toBe('d1');
    expect(new Uint8Array(await (output as { blob: Blob }).blob.arrayBuffer())).toEqual(content);
    await manager.dispose();
  });

  it('after a reload: reports the journalled upload as interrupted, resumes it with the files chosen again, or discards it', async () => {
    const first = setup({ ackChunks: 'manual' });
    first.manager.upload({ id: 'u1', root: MAIN, targetDir: 'in', name: 'p', items: [{ path: 'p', kind: 'dir' }, item('p/x.bin', 5 * MiB, 7)] });
    const link = first.links[0] as FakeTransferLink;
    await link.waitForHeld(4);
    link.releaseChunks(2);
    await link.waitForHeld(3);
    await first.manager.dispose(); // the page goes away: journal flushed, socket closed, nothing aborted

    // The new page: same daemon and journal, a fresh manager.
    const events: ManagerEvent[] = [];
    const links: FakeTransferLink[] = [];
    const manager = new TransferManager({
      workspaceId: WS,
      createLink: () => {
        const l = new FakeTransferLink({ daemon: first.daemon, uploadChunkSize: MiB });
        links.push(l);
        return l;
      },
      journal: first.journal,
      hasher: subtleSha256,
      writers: { opfs: null },
      emit: (event) => events.push(event),
      journalDelayMs: 0,
    });
    await manager.restore();
    const interrupted = events.find((e): e is Extract<ManagerEvent, { t: 'interrupted' }> => e.t === 'interrupted');
    expect(interrupted?.snapshot).toMatchObject({ id: 'u1', status: 'paused', pause: 'reload', totalBytes: 5 * MiB, files: 1 });
    expect(interrupted?.files).toEqual([{ path: 'p/x.bin', size: 5 * MiB, lastModified: 1_780_000_000_000 }]);
    expect(links).toHaveLength(0); // nothing is opened until the person acts

    manager.resumeUpload('u1', [item('p/x.bin', 5 * MiB, 7)]);
    await until(() => events.some((e) => e.t === 'job' && e.snapshot.id === 'u1' && e.snapshot.status === 'done'), 'resumed upload done');
    const sent = (links[0] as FakeTransferLink).requestsOf('file.upload.chunk').map((c) => c.index);
    expect(sent.length).toBeLessThan(5);
    expect(first.journal.records.size).toBe(0);
    await manager.dispose();
  });

  it('「放棄」 an interrupted upload removes its partial upload from the host and the journal entry', async () => {
    const first = setup({ ackChunks: 'manual' });
    first.manager.upload({ id: 'u1', root: MAIN, targetDir: 'in', name: 'y.bin', items: [item('y.bin', 5 * MiB, 8)] });
    await (first.links[0] as FakeTransferLink).waitForHeld(4);
    await first.manager.dispose();
    expect(first.daemon.uploads.size).toBe(1);

    const events: ManagerEvent[] = [];
    const manager = new TransferManager({
      workspaceId: WS,
      createLink: () => new FakeTransferLink({ daemon: first.daemon, uploadChunkSize: MiB }),
      journal: first.journal,
      hasher: subtleSha256,
      writers: { opfs: null },
      emit: (event) => events.push(event),
    });
    await manager.restore();
    await manager.cancel('u1');
    expect(first.daemon.uploads.size).toBe(0);
    expect(first.journal.records.size).toBe(0);
    expect(events.some((e) => e.t === 'removed' && e.id === 'u1')).toBe(true);
    await manager.dispose();
  });

  it('forgets journal entries older than the host keeps partial uploads (48 h)', async () => {
    const journal = createMemoryJournal();
    const base = { v: 1 as const, workspaceId: WS, root: MAIN, targetDir: 'in', name: 'x', chunkSize: MiB, policy: 'fail' as const, dirs: [], files: [{ path: 'x', target: 'in/x', size: 1, lastModified: 1, done: false }] };
    await journal.put({ ...base, jobId: 'old', createdAt: 0 });
    await journal.put({ ...base, jobId: 'recent', createdAt: 49 * 3_600_000 });
    const events: ManagerEvent[] = [];
    const manager = new TransferManager({
      workspaceId: WS,
      createLink: () => new FakeTransferLink(),
      journal,
      hasher: subtleSha256,
      writers: { opfs: null },
      emit: (event) => events.push(event),
      now: () => 50 * 3_600_000,
    });
    await manager.restore();
    expect(events.filter((e) => e.t === 'interrupted').map((e) => (e.t === 'interrupted' ? e.snapshot.id : ''))).toEqual(['recent']);
    expect([...journal.records.keys()]).toEqual(['recent']);
    await manager.dispose();
  });

  it('R7.2 measurement mode: uploads a synthetic source through the real engine and leaves nothing on the host', async () => {
    const { daemon, manager, events } = setup();
    manager.measure({ id: 'm1', root: MAIN, path: 'in/measure.bin', size: 6 * MiB + 1, seed: 9 });
    await until(() => events.some((e) => e.t === 'measured'), 'the measurement');
    const measured = events.find((e): e is Extract<ManagerEvent, { t: 'measured' }> => e.t === 'measured');
    expect(measured?.result).toMatchObject({ bytes: 6 * MiB + 1, status: 'done' });
    expect(measured?.result.peakBytesInFlight).toBeLessThanOrEqual(16 * MiB);
    expect(daemon.get(MAIN, 'in/measure.bin')).toBeUndefined();
    expect(daemon.uploads.size).toBe(0);
    await manager.dispose();
  });
});
