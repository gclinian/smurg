// @vitest-environment node
// FileUpload against the fake transfer link (a daemon that follows the real upload contract and validates every
// payload through the protocol registry). SPEC R7 upload bullets, ARCHITECTURE §5.2, transfer.md §1.3 / §1.9.
import { createHash } from 'node:crypto';
import { SmurgError } from '@smurg/protocol';
import { ClientRequestError, uploadRootHash } from '@smurg/protocol/client';
import { describe, expect, it } from 'vitest';
import { FakeTransferLink } from '../testing/fake-link.ts';
import { Budget } from './limits.ts';
import { TransferInterruptedError } from './link.ts';
import { subtleSha256 } from './source.ts';
import { createSyntheticSource, instrumentSource, syntheticBytes, type InstrumentedSource } from './synthetic-source.ts';
import { FileUpload, SourceChangedError, type FileUploadDeps } from './upload-file.ts';

const MiB = 1024 * 1024;
const CHUNK = MiB; // the smallest chunk size the protocol accepts keeps the tests fast
const MAIN = { kind: 'main' } as const;

function source(size: number, seed = 1, lastModified = 1_780_000_000_000): InstrumentedSource {
  return instrumentSource(createSyntheticSource({ size, seed, lastModified, name: 'data.bin' }));
}

function deps(link: FakeTransferLink, extra: Partial<FileUploadDeps> = {}): FileUploadDeps {
  return { link, budget: new Budget(4 * CHUNK), hasher: subtleSha256, ...extra };
}

function upload(src: InstrumentedSource, extra: { path?: string; uploadId?: string; onConflict?: 'fail' | 'overwrite' | 'rename' } = {}): FileUpload {
  return new FileUpload({ root: MAIN, path: extra.path ?? 'dir/data.bin', source: src, chunkSize: CHUNK, onConflict: extra.onConflict ?? 'fail', uploadId: extra.uploadId });
}

function stored(link: FakeTransferLink, path = 'dir/data.bin'): Uint8Array {
  const content = link.daemon.get(MAIN, path);
  if (!(content instanceof Uint8Array)) throw new Error(`nothing stored at ${path}`);
  return content;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function chunkIndexes(link: FakeTransferLink, fromLog = 0): number[] {
  return link.log.slice(fromLog).filter((e) => e.type === 'file.upload.chunk').map((e) => (e.payload as { index: number }).index);
}

describe('FileUpload — chunking and hashing', () => {
  it('reads the file one chunk at a time with slice().arrayBuffer() and never holds more than the window (SPEC R7 「不能把整個檔案載入記憶體」)', async () => {
    const link = new FakeTransferLink();
    let maxHeld = 0;
    const size = 9 * CHUNK + 777;
    const src = instrumentSource(createSyntheticSource({ size, seed: 3 }), () => {
      // Bytes this page has read and the daemon has not answered yet = what the client is holding right now.
      maxHeld = Math.max(maxHeld, src.bytesRead - link.answeredChunkBytes);
    });
    const job = new FileUpload({ root: MAIN, path: 'big.bin', source: src, chunkSize: CHUNK, onConflict: 'fail' });
    const budget = new Budget(4 * CHUNK);
    const entry = await job.run({ link, budget, hasher: subtleSha256 });

    expect(entry?.path).toBe('big.bin');
    expect(src.reads).toHaveLength(10); // every chunk read exactly once
    expect(src.largestRead).toBeLessThanOrEqual(CHUNK);
    expect(src.reads.map((r) => r.start)).toEqual(Array.from({ length: 10 }, (_, i) => i * CHUNK));
    expect(maxHeld).toBeLessThanOrEqual(4 * CHUNK);
    expect(budget.peakInUse).toBeLessThanOrEqual(4 * CHUNK);
    expect(sha(stored(link, 'big.bin'))).toBe(sha(syntheticBytes(3, 0, size)));
  });

  it('sends SHA-256 of each chunk and a hash-list root that equals the daemon definition (fixed test vector)', async () => {
    // Vector computed with the daemon's own hashListRoot (packages/daemon/src/files/upload.ts) over the synthetic
    // stream seed 7: size 5 MiB + 12345, chunk 1 MiB. Pinned here so the web engine and the daemon cannot drift.
    const size = 5 * MiB + 12_345;
    const hashes: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) hashes.push(await subtleSha256(syntheticBytes(7, i * MiB, Math.min(size, (i + 1) * MiB))));
    expect(Buffer.from(hashes[0] as Uint8Array).toString('hex')).toBe('3a1e2a5ca861e6a3366fff0cb88b4f2b2c9c682d38c4b0ff297390883fff4494');
    expect(Buffer.from(hashes[5] as Uint8Array).toString('hex')).toBe('0465c23732b055b0e617f7f0935172dc44e8e79383cc04f365a6c30bdfc95303');
    expect(Buffer.from(uploadRootHash(size, MiB, hashes)).toString('hex')).toBe('a547bd5b2e4231e00605b1ca2f04d55ed037e7ac7b89f07b0074c0c15160263b');
    expect(Buffer.from(uploadRootHash(0, 4 * MiB, [])).toString('hex')).toBe('31b6c3a7d509b1fb3640a59f8830570550838182e6bec4ca61445abeb6a7feb9');

    // And the engine sends exactly that: the fake daemon re-computes the root with node:crypto at commit.
    const link = new FakeTransferLink();
    const src = source(size, 7);
    await upload(src).run(deps(link));
    const chunks = link.requestsOf('file.upload.chunk');
    for (const chunk of chunks) expect(Buffer.from(chunk.hash).toString('hex')).toBe(sha(chunk.data));
    const commit = link.requestsOf('file.upload.commit')[0];
    expect(Buffer.from(commit?.rootHash ?? []).toString('hex')).toBe('a547bd5b2e4231e00605b1ca2f04d55ed037e7ac7b89f07b0074c0c15160263b');
  });

  it('uploads an empty file (no chunk, root over zero hashes)', async () => {
    const link = new FakeTransferLink();
    const entry = await upload(source(0)).run(deps(link));
    expect(entry?.size).toBe(0);
    expect(link.requestsOf('file.upload.chunk')).toHaveLength(0);
    expect(stored(link).byteLength).toBe(0);
  });
});

describe('FileUpload — flow control (ack window of 4 chunks + bufferedAmount guard)', () => {
  it('never has more than 4 unacknowledged chunks in flight', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const job = upload(source(10 * CHUNK));
    const running = job.run(deps(link, { budget: new Budget(64 * CHUNK) }));
    await link.waitForHeld(4);
    await tick(60);
    expect(link.heldChunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunkIndexes(link)).toEqual([0, 1, 2, 3]);
    link.releaseChunks(1);
    await link.waitForHeld(4);
    await tick(30);
    expect(chunkIndexes(link)).toEqual([0, 1, 2, 3, 4]);
    link.setAckMode('auto');
    await running;
    expect(link.maxChunksInFlight).toBe(4);
  });

  it('waits while the socket buffer holds more than 8 MiB, then continues', async () => {
    const link = new FakeTransferLink();
    link.bufferedAmountValue = 9 * MiB;
    const running = upload(source(3 * CHUNK)).run(deps(link));
    await tick(80);
    expect(link.requestsOf('file.upload.begin')).toHaveLength(1);
    expect(link.requestsOf('file.upload.chunk')).toHaveLength(0);
    link.bufferedAmountValue = 8 * MiB; // at the limit is allowed
    await running;
    expect(link.requestsOf('file.upload.chunk')).toHaveLength(3);
  });

  it('shares one byte budget between files: the second file waits for the first one\'s chunks to be acknowledged', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const budget = new Budget(4 * CHUNK);
    const a = upload(source(4 * CHUNK, 1), { path: 'a.bin' }).run(deps(link, { budget }));
    await link.waitForHeld(4);
    const b = upload(source(4 * CHUNK, 2), { path: 'b.bin' }).run(deps(link, { budget }));
    await tick(60);
    expect(link.heldChunks).toHaveLength(4); // b is blocked by the budget, not by its own window
    link.setAckMode('auto');
    await Promise.all([a, b]);
    expect(budget.peakInUse).toBe(4 * CHUNK);
    expect(link.maxChunkBytesInFlight).toBeLessThanOrEqual(4 * CHUNK);
  });
});

describe('FileUpload — resume (R7.3 上傳中途斷線，重新連線後從中斷處繼續)', () => {
  it('上傳中途斷線，重新連線後從中斷處繼續 — resumes from the daemon bitmap with the hashes kept in memory', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const size = 8 * CHUNK + 5;
    const src = source(size, 11);
    const job = upload(src);
    const first = job.run(deps(link));
    await link.waitForHeld(4);
    link.releaseChunks(2);
    await link.waitForHeld(4);
    link.goOffline();
    await expect(first).rejects.toBeInstanceOf(TransferInterruptedError);
    const uploadId = job.uploadId as string;
    const daemonHad = [...(link.daemon.uploads.get(uploadId)?.data.keys() ?? [])].sort((x, y) => x - y);
    expect(daemonHad.length).toBeGreaterThan(0);

    link.goOnline();
    link.setAckMode('auto');
    const logFrom = link.log.length;
    const readsFrom = src.reads.length;
    await job.run(deps(link));

    const resumed = link.log.slice(logFrom);
    expect(resumed[0]?.type).toBe('file.upload.begin');
    expect((resumed[0]?.payload as { uploadId?: string }).uploadId).toBe(uploadId);
    expect(resumed.some((e) => e.type === 'file.upload.hashes')).toBe(true);
    const resent = chunkIndexes(link, logFrom);
    for (const index of daemonHad) expect(resent).not.toContain(index);
    // Chunks this page had hashed are verified from memory: not read again.
    const reread = src.reads.slice(readsFrom).map((r) => r.start / CHUNK);
    for (const index of daemonHad) expect(reread).not.toContain(index);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(11, 0, size)));
  });

  it('上傳中途斷線，重新連線後從中斷處繼續 — after a page reload: re-hashes what the daemon already has, locally, and sends only the rest', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const size = 7 * CHUNK + 99;
    const before = upload(source(size, 21));
    const first = before.run(deps(link));
    await link.waitForHeld(4);
    link.releaseChunks(3);
    await link.waitForHeld(4);
    link.goOffline();
    await expect(first).rejects.toBeInstanceOf(TransferInterruptedError);
    const journalledId = before.uploadId as string;
    const daemonHad = [...(link.daemon.uploads.get(journalledId)?.data.keys() ?? [])].sort((x, y) => x - y);

    // "Reload": a new page, a new FileUpload with nothing in memory but the journalled uploadId, the file picked again.
    link.goOnline();
    link.setAckMode('auto');
    const again = source(size, 21);
    const after = upload(again, { uploadId: journalledId });
    const logFrom = link.log.length;
    await after.run(deps(link));

    const sent = chunkIndexes(link, logFrom);
    expect(sent.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !daemonHad.includes(i)));
    // Every chunk was read once: the held ones only to hash them locally (no upload), the rest to send them.
    expect(again.reads.map((r) => r.start / CHUNK).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(21, 0, size)));
  });

  it('after a reload without a journal entry the daemon finds the partial by identity (root, path, size, lastModified, chunk size)', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const size = 6 * CHUNK;
    const first = upload(source(size, 5)).run(deps(link));
    await link.waitForHeld(4);
    link.releaseChunks(4);
    await link.waitForHeld(2);
    link.goOffline();
    await expect(first).rejects.toBeInstanceOf(TransferInterruptedError);
    link.goOnline();
    link.setAckMode('auto');
    const logFrom = link.log.length;
    await upload(source(size, 5)).run(deps(link));
    expect(link.log.slice(logFrom).some((e) => e.type === 'file.upload.hashes')).toBe(true);
    expect(chunkIndexes(link, logFrom).length).toBeLessThan(6);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(5, 0, size)));
  });

  it('a partial of a file that has changed since (same size and date, other bytes) is thrown away and the upload starts fresh', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const size = 5 * CHUNK;
    const old = upload(source(size, 1));
    const first = old.run(deps(link));
    await link.waitForHeld(4);
    link.releaseChunks(4);
    await link.waitForHeld(1);
    link.goOffline();
    await expect(first).rejects.toBeInstanceOf(TransferInterruptedError);
    const staleId = old.uploadId as string;

    link.goOnline();
    link.setAckMode('auto');
    const logFrom = link.log.length;
    await upload(source(size, 99), { uploadId: staleId }).run(deps(link));
    expect(link.log.slice(logFrom).some((e) => e.type === 'file.upload.abort' && (e.payload as { uploadId: string }).uploadId === staleId)).toBe(true);
    expect(chunkIndexes(link, logFrom).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(99, 0, size)));
  });

  it('上傳中途斷線，重新連線後從中斷處繼續 — the commit\'s answer was lost: the next begin learns the file is there (committed), no conflict with its own file', async () => {
    const link = new FakeTransferLink();
    const job = upload(source(2 * CHUNK + 3, 9));
    link.loseNextCommitAnswer = true;
    await expect(job.run(deps(link))).rejects.toBeInstanceOf(TransferInterruptedError);
    expect(link.daemon.committed.size).toBe(1);
    link.goOnline();
    const entry = await job.run(deps(link));
    expect(entry).toMatchObject({ kind: 'file', size: 2 * CHUNK + 3 });
    const begins = link.requestsOf('file.upload.begin');
    expect(begins).toHaveLength(2);
    expect(begins[1]?.uploadId).toBe(job.uploadId);
    // Nothing was sent again and nothing was committed twice.
    expect(link.requestsOf('file.upload.commit')).toHaveLength(1);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(9, 0, 2 * CHUNK + 3)));
  });

  it('a new transfer socket that the upload is not bound to (conflict, reason not-bound) is answered by a begin with the uploadId', async () => {
    const link = new FakeTransferLink();
    const job = upload(source(3 * CHUNK, 4));
    link.failNext('file.upload.chunk', new SmurgError('conflict', '請先重新開始這個上傳（file.upload.begin）', { reason: 'not-bound' }), { when: (p) => p.index === 1 });
    await job.run(deps(link));
    const begins = link.requestsOf('file.upload.begin');
    expect(begins).toHaveLength(2);
    expect(begins[0]?.uploadId).toBeUndefined();
    expect(job.uploadId).toMatch(/^up_/);
    expect(begins[1]?.uploadId).toBe(job.uploadId);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(4, 0, 3 * CHUNK)));
  });

  it('pausing stops after the chunks in flight; resuming sends only what is missing', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    const job = upload(source(8 * CHUNK, 8));
    const pause = new AbortController();
    const first = job.run(deps(link), pause.signal);
    await link.waitForHeld(4);
    pause.abort(new TransferInterruptedError('paused'));
    link.setAckMode('auto');
    await expect(first).rejects.toMatchObject({ why: 'paused' });
    const sentBefore = chunkIndexes(link).length;
    expect(sentBefore).toBe(4);
    const logFrom = link.log.length;
    await job.run(deps(link));
    expect(chunkIndexes(link, logFrom).sort((x, y) => x - y)).toEqual([4, 5, 6, 7]);
  });
});

describe('FileUpload — errors', () => {
  it('retries a chunk that the daemon refused as corrupted in transit (hash-mismatch) or that timed out', async () => {
    const link = new FakeTransferLink();
    link.failNext('file.upload.chunk', new SmurgError('bad_request', '分段的雜湊值不符，請重新傳送', { reason: 'hash-mismatch', index: 2 }), { when: (p) => p.index === 2 });
    link.failNext('file.upload.chunk', new ClientRequestError('timeout'), { when: (p) => p.index === 4 });
    await upload(source(6 * CHUNK, 12)).run(deps(link));
    const indexes = chunkIndexes(link);
    expect(indexes.filter((i) => i === 2)).toHaveLength(2);
    expect(indexes.filter((i) => i === 4)).toHaveLength(2);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(12, 0, 6 * CHUNK)));
  });

  it('gives up on a chunk after 3 attempts and restarts from a clean partial when the hash keeps failing', async () => {
    const link = new FakeTransferLink();
    link.failNext('file.upload.chunk', new SmurgError('bad_request', 'x', { reason: 'hash-mismatch' }), { when: (p) => p.index === 1, times: 3 });
    const job = upload(source(3 * CHUNK, 13));
    await job.run(deps(link));
    expect(link.requestsOf('file.upload.abort')).toHaveLength(1);
    expect(link.requestsOf('file.upload.begin')).toHaveLength(2);
    expect(sha(stored(link))).toBe(sha(syntheticBytes(13, 0, 3 * CHUNK)));
  });

  it('does not retry a refusal a resend cannot fix (forbidden) and reports it', async () => {
    const link = new FakeTransferLink();
    link.failNext('file.upload.chunk', new SmurgError('forbidden', '沒有權限'), { when: (p) => p.index === 0 });
    await expect(upload(source(2 * CHUNK)).run(deps(link))).rejects.toMatchObject({ code: 'forbidden' });
    expect(chunkIndexes(link).filter((i) => i === 0)).toHaveLength(1);
  });

  it('refuses to mix two versions when the local file changes between two reads of a chunk', async () => {
    const link = new FakeTransferLink({ ackChunks: 'manual' });
    let seed = 30;
    const size = 6 * CHUNK;
    const changing = instrumentSource({ size, slice: (a: number, b: number) => ({ arrayBuffer: () => Promise.resolve(syntheticBytes(seed, a, b).buffer) }) });
    const job = new FileUpload({ root: MAIN, path: 'c.bin', source: changing, chunkSize: CHUNK, onConflict: 'fail' });
    const first = job.run(deps(link));
    await link.waitForHeld(4);
    link.goOffline(); // chunks 0–3 reached the daemon but were never acknowledged
    await expect(first).rejects.toBeInstanceOf(TransferInterruptedError);
    // Tamper with the daemon's knowledge so chunk 3 must be sent again, then change the file.
    const partial = link.daemon.uploads.get(job.uploadId as string);
    partial?.data.delete(3);
    if (partial) partial.have[0] = (partial.have[0] ?? 0) & ~(1 << 3);
    seed = 31;
    link.goOnline();
    link.setAckMode('auto');
    await expect(job.run(deps(link))).rejects.toBeInstanceOf(SourceChangedError);
  });

  it('reports the daemon\'s refusal of the name (conflict exists) and succeeds once the policy is changed', async () => {
    const link = new FakeTransferLink();
    link.daemon.put(MAIN, 'dir', 'dir');
    link.daemon.put(MAIN, 'dir/data.bin', new Uint8Array([1, 2, 3]));
    const job = upload(source(CHUNK + 1, 2));
    await expect(job.run(deps(link))).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'exists' } });
    job.spec.onConflict = 'rename';
    const entry = await job.run(deps(link));
    expect(entry?.path).toBe('dir/data (1).bin');
    expect(stored(link, 'dir/data.bin')).toEqual(new Uint8Array([1, 2, 3]));
  });
});
