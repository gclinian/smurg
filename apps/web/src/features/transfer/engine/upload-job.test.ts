// @vitest-environment node
// UploadJob: plan, conflict prompt, concurrency across files, disk refusal, automatic resume, pause / cancel, journal.
import { createHash } from 'node:crypto';
import { SmurgError, type DiskReport } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { FakeTransferLink } from '../testing/fake-link.ts';
import { createMemoryJournal, type UploadJournal } from './journal.ts';
import { Budget, Semaphore } from './limits.ts';
import { subtleSha256 } from './source.ts';
import { createSyntheticSource, instrumentSource, syntheticBytes } from './synthetic-source.ts';
import type { JobSnapshot } from './types.ts';
import { UploadJob, type UploadItem, type UploadJobSpec } from './upload-job.ts';

const MiB = 1024 * 1024;
const MAIN = { kind: 'main' } as const;
const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function fileItem(path: string, size: number, seed: number): UploadItem {
  return { path, kind: 'file', file: instrumentSource(createSyntheticSource({ size, seed, name: path.split('/').at(-1) as string })) };
}

interface Harness {
  readonly link: FakeTransferLink;
  readonly journal: UploadJournal & { readonly records: ReadonlyMap<string, unknown> };
  readonly snapshots: JobSnapshot[];
  readonly fileSlots: Semaphore;
  job(spec: Partial<UploadJobSpec> & Pick<UploadJobSpec, 'items'>): UploadJob;
}

function harness(options: { ackChunks?: 'auto' | 'manual'; fileSlots?: number } = {}): Harness {
  const link = new FakeTransferLink({ uploadChunkSize: MiB, ackChunks: options.ackChunks ?? 'auto' });
  link.daemon.put(MAIN, 'uploads', 'dir');
  const journal = createMemoryJournal();
  const snapshots: JobSnapshot[] = [];
  const budget = new Budget(4 * MiB);
  const fileSlots = new Semaphore(options.fileSlots ?? 4);
  return {
    link,
    journal,
    snapshots,
    fileSlots,
    job: (spec) =>
      new UploadJob(
        { id: 'job1', workspaceId: 'ws_test_transfer_000001', root: MAIN, targetDir: 'uploads', name: 'proj', ...spec },
        { link, budget, fileSlots, hasher: subtleSha256, journal, journalDelayMs: 0, onChange: (job) => snapshots.push(job.snapshot()) },
      ),
  };
}

function stored(link: FakeTransferLink, path: string): Uint8Array {
  const content = link.daemon.get(MAIN, path);
  if (!(content instanceof Uint8Array)) throw new Error(`nothing at ${path}`);
  return content;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

const refusing = (requestedBytes: number): DiskReport => ({
  totalBytes: 100 * 1024 ** 3,
  availableBytes: 6 * 1024 ** 3,
  reserveBytes: 5 * 1024 ** 3,
  pendingBytes: 0,
  requestedBytes,
  freeAfterBytes: 6 * 1024 ** 3 - requestedBytes,
  ok: false,
});

describe('UploadJob — folders', () => {
  it('拖曳檔案或資料夾到檔案樹，保留資料夾結構 — one plan for the batch creates every folder (also empty ones), then every file lands at its path', async () => {
    const h = harness();
    const items: UploadItem[] = [
      { path: 'proj', kind: 'dir' },
      fileItem('proj/a.txt', 10, 1),
      { path: 'proj/empty', kind: 'dir' },
      { path: 'proj/sub', kind: 'dir' },
      fileItem('proj/sub/b.bin', 3 * MiB + 17, 2),
      fileItem('proj/sub/zero.txt', 0, 3),
    ];
    const job = h.job({ items });
    job.start();
    await job.whenSettled();

    expect(job.snapshot()).toMatchObject({ status: 'done', files: 3, filesDone: 3, totalBytes: 10 + 3 * MiB + 17, doneBytes: 10 + 3 * MiB + 17 });
    const plans = h.link.requestsOf('file.upload.plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.entries).toEqual([
      { path: 'uploads/proj', kind: 'dir' },
      { path: 'uploads/proj/empty', kind: 'dir' },
      { path: 'uploads/proj/sub', kind: 'dir' },
      { path: 'uploads/proj/a.txt', kind: 'file', size: 10 },
      { path: 'uploads/proj/sub/b.bin', kind: 'file', size: 3 * MiB + 17 },
      { path: 'uploads/proj/sub/zero.txt', kind: 'file', size: 0 },
    ]);
    expect(h.link.daemon.get(MAIN, 'uploads/proj/empty')).toBe('dir');
    expect(sha(stored(h.link, 'uploads/proj/sub/b.bin'))).toBe(sha(syntheticBytes(2, 0, 3 * MiB + 17)));
    expect(stored(h.link, 'uploads/proj/sub/zero.txt').byteLength).toBe(0);
    // Nothing left to resume: the journal entry is gone.
    expect(h.journal.records.size).toBe(0);
  });

  it('limits the files in progress at once (shared across jobs), and still uploads them all', async () => {
    const h = harness({ ackChunks: 'manual', fileSlots: 2 });
    const items = Array.from({ length: 6 }, (_, i) => fileItem(`f${i}.bin`, MiB, 10 + i));
    const job = h.job({ items });
    job.start();
    await h.link.waitForHeld(2);
    await tick(60);
    const begun = (): number => h.link.requestsOf('file.upload.begin').length;
    expect(begun()).toBe(2);
    let maxOpen = 0;
    while (h.link.heldChunks.length > 0 || begun() < 6) {
      const open = begun() - h.link.requestsOf('file.upload.commit').length;
      maxOpen = Math.max(maxOpen, open);
      h.link.releaseChunks(1);
      await tick(10);
    }
    await job.whenSettled();
    expect(maxOpen).toBeLessThanOrEqual(2);
    expect(job.snapshot().status).toBe('done');
    expect(h.link.requestsOf('file.upload.commit')).toHaveLength(6);
  });

  it('splits a drop of more than 10,000 entries into several plans', async () => {
    const h = harness();
    const items: UploadItem[] = [{ path: 'many', kind: 'dir' }, ...Array.from({ length: 10_050 }, (_, i) => ({ path: `many/d${i}`, kind: 'dir' as const })), fileItem('many/x.txt', 4, 1)];
    const job = h.job({ items });
    job.start();
    await job.whenSettled();
    const plans = h.link.requestsOf('file.upload.plan');
    expect(plans.map((p) => p.entries.length)).toEqual([10_000, 52]);
    expect(job.snapshot().status).toBe('done');
  });
});

describe('UploadJob — name conflicts (覆蓋 / 另存 / 取消)', () => {
  function withExisting(): Harness {
    const h = harness();
    h.link.daemon.put(MAIN, 'uploads/proj', 'dir');
    h.link.daemon.put(MAIN, 'uploads/proj/a.txt', new Uint8Array([9]));
    return h;
  }
  const items = (): UploadItem[] => [{ path: 'proj', kind: 'dir' }, fileItem('proj/a.txt', 5, 1), fileItem('proj/b.txt', 6, 2)];

  it('asks, then overwrites when the person chooses 覆蓋', async () => {
    const h = withExisting();
    const job = h.job({ items: items() });
    job.start();
    await until(() => job.snapshot().conflict !== null, 'the conflict question');
    expect(job.snapshot().conflict).toEqual({ paths: ['uploads/proj/a.txt'], more: 0 });
    expect(h.link.requestsOf('file.upload.begin')).toHaveLength(0); // nothing is sent before the answer
    job.answer('overwrite');
    await job.whenSettled();
    expect(job.snapshot().status).toBe('done');
    expect(h.link.requestsOf('file.upload.plan').map((p) => p.onConflict)).toEqual(['fail', 'overwrite']);
    expect(sha(stored(h.link, 'uploads/proj/a.txt'))).toBe(sha(syntheticBytes(1, 0, 5)));
  });

  it('keeps both when the person chooses 另存 (the daemon picks a free name)', async () => {
    const h = withExisting();
    const job = h.job({ items: items() });
    job.start();
    await until(() => job.snapshot().conflict !== null, 'the conflict question');
    job.answer('rename');
    await job.whenSettled();
    expect(stored(h.link, 'uploads/proj/a.txt')).toEqual(new Uint8Array([9]));
    expect(sha(stored(h.link, 'uploads/proj/a (1).txt'))).toBe(sha(syntheticBytes(1, 0, 5)));
  });

  it('uploads nothing when the person chooses 取消', async () => {
    const h = withExisting();
    const job = h.job({ items: items() });
    job.start();
    await until(() => job.snapshot().conflict !== null, 'the conflict question');
    job.answer(null);
    await job.whenSettled();
    expect(job.snapshot()).toMatchObject({ status: 'failed', failure: { kind: 'conflict-declined', paths: ['uploads/proj/a.txt'] } });
    expect(h.link.requestsOf('file.upload.begin')).toHaveLength(0);
  });

  it('asks for a single file too (its begin finds the name taken) and resumes with the chosen policy', async () => {
    const h = harness();
    h.link.daemon.put(MAIN, 'uploads/one.txt', new Uint8Array([1]));
    const job = h.job({ items: [fileItem('one.txt', 3, 4)] });
    job.start();
    await until(() => job.snapshot().conflict !== null, 'the conflict question');
    job.answer('overwrite');
    await job.whenSettled();
    expect(h.link.requestsOf('file.upload.plan')).toHaveLength(0);
    expect(h.link.requestsOf('file.upload.begin').map((b) => b.onConflict)).toEqual(['fail', 'overwrite']);
    expect(sha(stored(h.link, 'uploads/one.txt'))).toBe(sha(syntheticBytes(4, 0, 3)));
  });
});

describe('UploadJob — disk space (R7.4 磁碟空間不足時，上傳在開始前就被拒絕)', () => {
  it('磁碟空間不足時，上傳在開始前就被拒絕，而不是傳到一半失敗 — the refusal carries the numbers and no chunk is sent', async () => {
    const h = harness();
    h.link.daemon.disk = refusing;
    const job = h.job({ items: [{ path: 'p', kind: 'dir' }, fileItem('p/a.bin', 2 * MiB, 1), fileItem('p/b.bin', MiB, 2)] });
    job.start();
    await job.whenSettled();
    const snap = job.snapshot();
    expect(snap.status).toBe('failed');
    expect(snap.failure).toEqual({ kind: 'disk', disk: refusing(3 * MiB), midway: false });
    expect(h.link.requestsOf('file.upload.begin')).toHaveLength(0);
    expect(h.link.requestsOf('file.upload.chunk')).toHaveLength(0);
  });

  it('a single file is refused at begin, before any chunk', async () => {
    const h = harness();
    h.link.daemon.disk = refusing;
    const job = h.job({ items: [fileItem('big.bin', 3 * MiB, 1)] });
    job.start();
    await job.whenSettled();
    expect(job.snapshot().failure).toMatchObject({ kind: 'disk', disk: { requestedBytes: 3 * MiB, ok: false } });
    expect(h.link.requestsOf('file.upload.chunk')).toHaveLength(0);
  });
});

describe('UploadJob — interruptions', () => {
  it('上傳中途斷線，重新連線後從中斷處繼續 — shows 「已暫停（離線）」 and continues by itself when the socket is back', async () => {
    const h = harness({ ackChunks: 'manual' });
    const job = h.job({ items: [fileItem('big.bin', 6 * MiB, 5)] });
    job.start();
    await h.link.waitForHeld(4);
    h.link.releaseChunks(2);
    await h.link.waitForHeld(4);
    h.link.goOffline();
    await until(() => job.snapshot().status === 'paused', 'paused while offline');
    expect(job.snapshot().pause).toBe('offline');
    h.link.setAckMode('auto');
    h.link.goOnline();
    await job.whenSettled();
    expect(job.snapshot().status).toBe('done');
    const sent = h.link.requestsOf('file.upload.chunk').map((c) => c.index);
    expect(sent.filter((i) => i === 0)).toHaveLength(1); // acknowledged chunks are never sent twice
    expect(sha(stored(h.link, 'uploads/big.bin'))).toBe(sha(syntheticBytes(5, 0, 6 * MiB)));
  });

  it('pause stops the job; start() continues where it stopped', async () => {
    const h = harness({ ackChunks: 'manual' });
    const job = h.job({ items: [fileItem('big.bin', 8 * MiB, 6)] });
    job.start();
    await h.link.waitForHeld(4);
    job.pauseJob();
    h.link.setAckMode('auto');
    await job.whenSettled();
    expect(job.snapshot()).toMatchObject({ status: 'paused', pause: 'user' });
    const before = h.link.requestsOf('file.upload.chunk').length;
    job.start();
    await job.whenSettled();
    expect(job.snapshot().status).toBe('done');
    expect(h.link.requestsOf('file.upload.chunk').length - before).toBe(4);
  });

  it('cancel stops the job and removes the partial upload from the host', async () => {
    const h = harness({ ackChunks: 'manual' });
    const job = h.job({ items: [fileItem('big.bin', 8 * MiB, 7)] });
    job.start();
    await h.link.waitForHeld(4);
    expect(h.link.daemon.uploads.size).toBe(1);
    h.link.setAckMode('auto');
    await job.cancel();
    expect(job.snapshot().status).toBe('cancelled');
    expect(h.link.requestsOf('file.upload.abort')).toHaveLength(1);
    expect(h.link.daemon.uploads.size).toBe(0);
    expect(h.link.daemon.get(MAIN, 'uploads/big.bin')).toBeUndefined();
    expect(h.journal.records.size).toBe(0);
  });

  it('上傳中途斷線，重新連線後從中斷處繼續 — after a page reload the journal resumes it: committed files are skipped, the partial is re-hashed and completed', async () => {
    const h = harness({ ackChunks: 'manual', fileSlots: 1 });
    const items = (): UploadItem[] => [{ path: 'p', kind: 'dir' }, fileItem('p/first.bin', MiB, 1), fileItem('p/second.bin', 6 * MiB, 2)];
    const before = h.job({ items: items() });
    before.start();
    await h.link.waitForHeld(1);
    h.link.releaseChunks(1); // first.bin: one chunk, committed
    await until(() => h.link.requestsOf('file.upload.commit').length === 1, 'first file committed');
    await h.link.waitForHeld(4);
    h.link.releaseChunks(3);
    await h.link.waitForHeld(3);
    await before.flushJournal();
    // The page goes away mid-upload: the old job simply stops (nothing is aborted on the host), the journal remains.
    h.link.goOffline();
    before.pauseJob();
    await before.whenSettled();
    const [record] = await h.journal.list('ws_test_transfer_000001');
    expect(record?.files.map((f) => [f.target, f.done])).toEqual([
      ['uploads/p/first.bin', true],
      ['uploads/p/second.bin', false],
    ]);

    h.link.goOnline();
    h.link.setAckMode('auto');
    const logFrom = h.link.log.length;
    const after = h.job({ id: 'job1', items: items(), resume: record });
    after.start();
    await after.whenSettled();
    expect(after.snapshot().status).toBe('done');
    const resumed = h.link.log.slice(logFrom);
    expect(resumed.some((e) => e.type === 'file.upload.plan')).toBe(false);
    expect(resumed.filter((e) => e.type === 'file.upload.begin').map((e) => (e.payload as { path: string }).path)).toEqual(['uploads/p/second.bin']);
    expect(resumed.some((e) => e.type === 'file.upload.hashes')).toBe(true);
    expect(sha(stored(h.link, 'uploads/p/second.bin'))).toBe(sha(syntheticBytes(2, 0, 6 * MiB)));
    expect(h.journal.records.size).toBe(0);
  });
});

describe('UploadJob — failures', () => {
  it('a file that cannot be read fails alone; the others are uploaded; retry uploads what is missing', async () => {
    const h = harness();
    let broken = true;
    const flaky: UploadItem = {
      path: 'p/flaky.bin',
      kind: 'file',
      file: {
        name: 'flaky.bin',
        size: 100,
        lastModified: 1,
        slice: (a: number, b: number) => ({ arrayBuffer: () => (broken ? Promise.reject(new DOMException('gone', 'NotReadableError')) : Promise.resolve(syntheticBytes(3, a, b).buffer)) }),
      },
    };
    const job = h.job({ items: [{ path: 'p', kind: 'dir' }, fileItem('p/ok.bin', 50, 1), flaky] });
    job.start();
    await job.whenSettled();
    expect(job.snapshot()).toMatchObject({ status: 'failed', filesDone: 1, fileFailures: [{ path: 'uploads/p/flaky.bin', failure: { kind: 'source-unreadable' } }] });
    broken = false;
    job.retry();
    await job.whenSettled();
    expect(job.snapshot()).toMatchObject({ status: 'done', filesDone: 2, fileFailures: [] });
  });

  it('a refusal that concerns the whole job (permission changed) stops every file of it', async () => {
    const h = harness();
    h.link.failNext('file.upload.begin', new SmurgError('forbidden', '沒有權限'), { times: 100 });
    const job = h.job({ items: [{ path: 'p', kind: 'dir' }, fileItem('p/a.bin', 10, 1), fileItem('p/b.bin', 10, 2)] });
    job.start();
    await job.whenSettled();
    expect(job.snapshot()).toMatchObject({ status: 'failed', failure: { kind: 'daemon', error: { code: 'forbidden' } } });
  });

  it('a transfer socket that ended for good (kicked) fails the job', async () => {
    const h = harness({ ackChunks: 'manual' });
    const job = h.job({ items: [fileItem('big.bin', 4 * MiB, 1)] });
    job.start();
    await h.link.waitForHeld(2);
    h.link.end({ kind: 'closed', reason: 'kicked' });
    await job.whenSettled();
    expect(job.snapshot()).toMatchObject({ status: 'failed', failure: { kind: 'connection-ended', state: 'closed:kicked' } });
  });
});
