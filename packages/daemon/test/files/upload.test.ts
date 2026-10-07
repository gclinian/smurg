// Uploads on the transfer channel (SPEC R7 / D15; ARCHITECTURE §5.2; transfer.md §1.3–§1.5, §1.8): begin / chunk /
// commit through the real handlers and the client SDK's TransferConnection, resume (socket drop, daemon restart), the
// disk rule before anything is written, conflict policies, permissions, abort, kick and the sweep.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, diskReportOfError, isSmurgError, type DiskReport, type FileRef } from '@smurg/protocol';
import { bitmapHas, uploadRootHash, type TransferConnection } from '@smurg/protocol/client';
import type { Daemon } from '../../src/daemon.ts';
import type { UploadServiceImpl } from '../../src/files/upload.ts';
import { waitFor, type TestClient } from '../../src/testing/index.ts';
import {
  GiB,
  MiB,
  ScriptedLocks,
  auditEntries,
  bytesSource,
  humanLock,
  patternSource,
  restartDaemon,
  settleError,
  sha256Hex,
  simulatedDisk,
  sourceHash,
  startFilesDaemon,
  upload,
  type FilesTest,
  type SimulatedDisk,
} from './helpers.ts';

const execFileAsync = promisify(execFile);
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const digest = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());

let ft: FilesTest | null = null;
let restarted: Daemon | null = null;

afterEach(async () => {
  await restarted?.stop();
  restarted = null;
  await ft?.t.cleanup();
  ft = null;
});

interface Setup {
  readonly ft: FilesTest;
  readonly host: TestClient;
  readonly amy: TestClient;
  readonly xfer: TransferConnection;
}

async function setup(options: Parameters<typeof startFilesDaemon>[0] = {}): Promise<Setup> {
  ft = await startFilesDaemon({ project: { files: { 'README.md': '# hi\n', 'docs/a.txt': 'a\n' } }, files: { watch: false }, ...options });
  const host = await ft.t.connectHost();
  const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  const xfer = await amy.transfer();
  return { ft, host, amy, xfer };
}

function stagingDir(f: FilesTest): string {
  return join(f.t.ctx.config.workspaceStateDir, 'uploads');
}

function uploadsOf(f: FilesTest): UploadServiceImpl {
  return f.t.ctx.services.uploads as UploadServiceImpl;
}

describe('upload: begin → chunks → commit', () => {
  it('uploads in hashed chunks and commits the exact bytes, with the permissions of a new shared file', async () => {
    const { ft: f, xfer } = await setup();
    const source = patternSource('basic');
    const size = 3 * MiB + 12_345;
    const run = await upload(xfer, { path: 'docs/data.bin', size, source });
    expect(run.begin).toMatchObject({ chunkCount: 4, received: 0, resumed: false });
    expect(run.begin.disk.ok).toBe(true);
    expect(run.entry).toMatchObject({ path: 'docs/data.bin', kind: 'file', size });
    const onDisk = await readFile(join(f.t.root, 'docs/data.bin'));
    expect(sha256Hex(onDisk)).toBe(sourceHash(source, size, MiB));
    // Never the 0600 staging mode on a shared file (transfer.md gotcha 11).
    expect((await stat(join(f.t.root, 'docs/data.bin'))).mode & 0o777).toBe(0o666 & ~process.umask());
    expect(await readdir(stagingDir(f))).toEqual([]);
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.upload');
    expect(audit.at(-1)).toMatchObject({ outcome: 'ok', target: 'main:docs/data.bin', actor: { userId: 'dev:amy' }, detail: { size, chunks: 4 } });
  });

  it('an empty file is an upload of zero chunks', async () => {
    const { ft: f, xfer } = await setup();
    const run = await upload(xfer, { path: 'empty.txt', size: 0, source: bytesSource(new Uint8Array(0)) });
    expect(run.begin.chunkCount).toBe(0);
    expect((await stat(join(f.t.root, 'empty.txt'))).size).toBe(0);
  });

  it('file.upload.hashes returns the stored chunk hashes, paged', async () => {
    const { xfer } = await setup();
    const source = patternSource('hashes');
    const run = await upload(xfer, { path: 'h.bin', size: 5 * MiB, source, stopAfter: 3 });
    const page = await xfer.request('file.upload.hashes', { uploadId: run.begin.uploadId, from: 1, count: 3 });
    expect(page.hashes.byteLength).toBe(96);
    const expected = (i: number) => sha256Hex(source(i, i * MiB, MiB));
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(page.hashes.subarray(0, 32))).toBe(expected(1));
    expect(hex(page.hashes.subarray(32, 64))).toBe(expected(2));
    expect(page.hashes.subarray(64, 96).every((b) => b === 0)).toBe(true); // chunk 3 not stored yet
    const beyond = await xfer.request('file.upload.hashes', { uploadId: run.begin.uploadId, from: 10, count: 5 });
    expect(beyond.hashes.byteLength).toBe(0);
  });

  it('refuses a wrong hash, a wrong length, an index out of range, different content for a stored chunk, an incomplete commit and a wrong root hash', async () => {
    const { ft: f, xfer } = await setup();
    const source = patternSource('bad');
    const size = 2 * MiB + 10;
    const run = await upload(xfer, { path: 'bad.bin', size, source, stopAfter: 1 });
    const id = run.begin.uploadId;
    const data1 = source(1, MiB, MiB);
    const hash1 = digest(data1);
    expect(await settleError(xfer.request('file.upload.chunk', { uploadId: id, index: 1, hash: new Uint8Array(32), data: data1 }))).toMatchObject({ code: 'bad_request', reason: 'hash-mismatch' });
    expect(await settleError(xfer.request('file.upload.chunk', { uploadId: id, index: 1, hash: hash1, data: data1.subarray(1) }))).toMatchObject({ code: 'bad_request', reason: 'chunk-length' });
    expect(await settleError(xfer.request('file.upload.chunk', { uploadId: id, index: 3, hash: hash1, data: data1 }))).toMatchObject({ code: 'bad_request', reason: 'index' });
    const other = new Uint8Array(MiB).fill(7);
    const otherHash = digest(other);
    expect(await settleError(xfer.request('file.upload.chunk', { uploadId: id, index: 0, hash: otherHash, data: other }))).toMatchObject({ code: 'conflict', reason: 'chunk-differs' });
    // Re-sending a stored chunk unchanged is harmless (a retransmission after a reconnect).
    const data0 = source(0, 0, MiB);
    await xfer.request('file.upload.chunk', { uploadId: id, index: 0, hash: digest(data0), data: data0 });
    const incomplete = await settleError(xfer.request('file.upload.commit', { uploadId: id, rootHash: new Uint8Array(32) }));
    expect(incomplete).toMatchObject({ code: 'bad_request', reason: 'incomplete' });
    expect(incomplete?.detail).toMatchObject({ missing: 2, first: 1 });
    await xfer.request('file.upload.chunk', { uploadId: id, index: 1, hash: hash1, data: data1 });
    const data2 = source(2, 2 * MiB, 10);
    await xfer.request('file.upload.chunk', { uploadId: id, index: 2, hash: digest(data2), data: data2 });
    expect(await settleError(xfer.request('file.upload.commit', { uploadId: id, rootHash: new Uint8Array(32) }))).toMatchObject({ code: 'bad_request', reason: 'hash-mismatch' });
    await expect(lstat(join(f.t.root, 'bad.bin'))).rejects.toThrow();
    const hashes = [0, 1, 2].map((i) => new Uint8Array(Buffer.from(sha256Hex(source(i, i * MiB, i === 2 ? 10 : MiB)), 'hex')));
    await xfer.request('file.upload.commit', { uploadId: id, rootHash: uploadRootHash(size, MiB, hashes) });
    expect(sha256Hex(await readFile(join(f.t.root, 'bad.bin')))).toBe(sourceHash(source, size, MiB));
  });
});

describe('R7.3 an upload that loses its connection continues where it stopped after reconnecting', () => {
  it('an interrupted upload continues where it stopped — the transfer socket drops half-way; the new socket resumes from the daemon bitmap', async () => {
    const { ft: f, amy, xfer } = await setup();
    const source = patternSource('drop');
    const size = 8 * MiB;
    const first = await upload(xfer, { path: 'big/video.bin', size, source, stopAfter: 4 });
    expect(first.sent.sort()).toEqual([0, 1, 2, 3]);
    // The relay drops the transfer socket (heartbeat timeout); the client reconnects on its own.
    const [socket] = f.t.relay.clientsOf('dev:amy', 'xfer');
    expect(socket).toBeDefined();
    if (socket) f.t.relay.byeClient(socket, 4000, 'heartbeat timeout');
    await waitFor(() => xfer.getState().kind !== 'online', { timeoutMs: 5_000, what: 'the transfer socket to drop' });
    await xfer.whenOnline({ timeoutMs: 10_000 });
    // The upload is not bound to the new socket until it begins again.
    const early = await settleError(xfer.request('file.upload.chunk', { uploadId: first.begin.uploadId, index: 4, hash: new Uint8Array(32), data: new Uint8Array(1) }));
    expect(early).toMatchObject({ code: 'conflict', reason: 'not-bound' });
    const second = await upload(xfer, { path: 'big/video.bin', size, source, uploadId: first.begin.uploadId });
    expect(second.begin).toMatchObject({ uploadId: first.begin.uploadId, resumed: true, received: 4, chunkCount: 8 });
    expect([0, 1, 2, 3].every((i) => bitmapHas(second.begin.have, i))).toBe(true);
    expect(second.sent.sort()).toEqual([4, 5, 6, 7]); // only the missing half was sent again
    expect(sha256Hex(await readFile(join(f.t.root, 'big/video.bin')))).toBe(sourceHash(source, size, MiB));
    expect(await readdir(stagingDir(f))).toEqual([]);
    void amy;
  });

  it('an interrupted upload continues where it stopped — the commit\'s answer was lost: beginning again with that id answers \'committed\' with the file, never a conflict with it', async () => {
    const { ft: f, xfer } = await setup();
    const bob = await f.t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
    const bobXfer = await bob.transfer();
    const source = patternSource('lost-answer');
    const size = MiB + 7;
    const done = await upload(xfer, { path: 'docs/report.bin', size, source });
    expect(done.entry).toMatchObject({ path: 'docs/report.bin', size });
    // The client never saw that `.ok`: it begins again with the same id and the same policy ('fail').
    const again = await settleError(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'docs/report.bin', size, chunkSize: MiB, lastModified: 1_760_000_000_000, uploadId: done.begin.uploadId }));
    expect(again).toMatchObject({ code: 'conflict', reason: 'committed' });
    expect(again?.detail?.['entry']).toMatchObject({ path: 'docs/report.bin', kind: 'file', size });
    // Only the member who committed it learns that: another member's begin with the id is a new upload (here the name
    // exists and the policy is 'fail', so it is refused as an existing file, like any other upload).
    const other = await settleError(bobXfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'docs/report.bin', size, chunkSize: MiB, lastModified: 1, uploadId: done.begin.uploadId }));
    expect(other).toMatchObject({ code: 'conflict', reason: 'exists' });
    // The memory is short: after it, the id is unknown and a begin is an ordinary new upload.
    f.t.advanceClock(11 * 60 * 1000);
    const later = await settleError(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'docs/report.bin', size, chunkSize: MiB, lastModified: 1_760_000_000_000, uploadId: done.begin.uploadId }));
    expect(later).toMatchObject({ code: 'conflict', reason: 'exists' });
  });

  it('an interrupted upload continues where it stopped — also across a daemon restart (resume by uploadId and by identity)', async () => {
    const { ft: f, amy, xfer } = await setup();
    const source = patternSource('restart');
    const size = 6 * MiB + 1;
    const lastModified = 1_760_000_123_456;
    const first = await upload(xfer, { path: 'restart.bin', size, source, lastModified, stopAfter: 3 });
    const otherFirst = await upload(xfer, { path: 'restart-2.bin', size: 3 * MiB, source, lastModified, stopAfter: 1 });
    // The host's daemon stops (smurg stop, a crash, a reboot) and starts again on the same state dir.
    await f.t.daemon.stop();
    restarted = await restartDaemon(f.t, f.modules);
    const xfer2 = await amy.transfer();
    // Right after the restart nothing is bound: a pipelined chunk is refused until the client begins again.
    const refused = await settleError(xfer2.request('file.upload.chunk', { uploadId: first.begin.uploadId, index: 3, hash: new Uint8Array(32), data: new Uint8Array(1) }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'not-bound' });
    const resumed = await upload(xfer2, { path: 'restart.bin', size, source, lastModified, uploadId: first.begin.uploadId });
    expect(resumed.begin).toMatchObject({ resumed: true, received: 3, chunkCount: 7 });
    expect(resumed.sent.sort()).toEqual([3, 4, 5, 6]);
    expect(sha256Hex(await readFile(join(f.t.root, 'restart.bin')))).toBe(sourceHash(source, size, MiB));
    // A new client process that lost the uploadId finds its partial upload by identity.
    const byIdentity = await upload(xfer2, { path: 'restart-2.bin', size: 3 * MiB, source, lastModified });
    expect(byIdentity.begin).toMatchObject({ uploadId: otherFirst.begin.uploadId, resumed: true, received: 1 });
    expect(byIdentity.sent.sort()).toEqual([1, 2]);
    // A changed lastModified is a different file: a new upload, never a resume.
    const changed = await upload(xfer2, { path: 'restart-3.bin', size: MiB, source, lastModified: lastModified + 1 });
    expect(changed.begin.resumed).toBe(false);
  });

  it('chunks that race in right after a restart share one bitmap (memoized load): the commit sees them all', async () => {
    const { ft: f, amy, xfer } = await setup();
    const source = patternSource('race');
    const size = 8 * MiB;
    const first = await upload(xfer, { path: 'race.bin', size, source, stopAfter: 2 });
    await f.t.daemon.stop();
    restarted = await restartDaemon(f.t, f.modules);
    const xfer2 = await amy.transfer();
    const begin = await xfer2.request('file.upload.begin', { root: MAIN_ROOT, path: 'race.bin', size, chunkSize: MiB, lastModified: 1_760_000_000_000, uploadId: first.begin.uploadId });
    expect(begin.received).toBe(2);
    const hashes: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) hashes.push(new Uint8Array(Buffer.from(sha256Hex(source(i, i * MiB, MiB)), 'hex')));
    // All six missing chunks at once, no window: the handles are opened once and every bit lands in one bitmap.
    await Promise.all([2, 3, 4, 5, 6, 7].map((i) => xfer2.request('file.upload.chunk', { uploadId: begin.uploadId, index: i, hash: hashes[i] as Uint8Array, data: source(i, i * MiB, MiB) })));
    await xfer2.request('file.upload.commit', { uploadId: begin.uploadId, rootHash: uploadRootHash(size, MiB, hashes) });
    expect(sha256Hex(await readFile(join(f.t.root, 'race.bin')))).toBe(sourceHash(source, size, MiB));
  });
});

describe('R7.4 without enough disk space an upload is refused before it starts, not half-way', () => {
  // 100 GiB volume, 6 GiB free; defaults reserve max(5 GiB, 5 % = 5 GiB) → at most 1 GiB may be uploaded now.
  const nearlyFull = (): SimulatedDisk => simulatedDisk(100 * GiB, 6 * GiB);

  function expectReport(report: DiskReport | null, requested: number, pending = 0): void {
    expect(report).toEqual({
      totalBytes: 100 * GiB,
      availableBytes: 6 * GiB,
      reserveBytes: 5 * GiB,
      pendingBytes: pending,
      requestedBytes: requested,
      freeAfterBytes: 6 * GiB - pending - requested,
      ok: false,
    });
  }

  async function refusal(promise: Promise<unknown>): Promise<{ code: string; disk: DiskReport | null; message: string }> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    if (!isSmurgError(error)) throw new Error(`expected a refusal, got ${String(error)}`);
    return { code: error.code, disk: diskReportOfError(error), message: error.message };
  }

  it('without enough disk space an upload is refused before it starts — plan and begin are refused with the numbers, before anything is written', async () => {
    const { ft: f, xfer } = await setup({ disk: nearlyFull() });
    const planned = await refusal(
      xfer.request('file.upload.plan', {
        root: MAIN_ROOT,
        entries: [
          { path: 'drop', kind: 'dir' },
          { path: 'drop/empty', kind: 'dir' },
          { path: 'drop/a.bin', kind: 'file', size: GiB },
          { path: 'drop/b.bin', kind: 'file', size: GiB },
        ],
        onConflict: 'fail',
      }),
    );
    expect(planned.code).toBe('insufficient_disk');
    expectReport(planned.disk, 2 * GiB);
    expect(planned.message).toContain('5.00 GiB'); // the reserve, shown to people
    await expect(lstat(join(f.t.root, 'drop'))).rejects.toThrow(); // the refused plan created nothing
    const begun = await refusal(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'huge.bin', size: 2 * GiB, chunkSize: 4 * MiB, lastModified: 1 }));
    expect(begun.code).toBe('insufficient_disk');
    expectReport(begun.disk, 2 * GiB);
    expect(await readdir(stagingDir(f))).toEqual([]); // nothing staged, no byte accepted
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.upload' && e.outcome === 'denied');
    expect(audit.map((e) => [e.detail?.['stage'], e.detail?.['reason']])).toEqual([
      ['plan', 'insufficient-disk'],
      ['begin', 'insufficient-disk'],
    ]);
    // Within the reserve it is accepted.
    const ok = await xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'fits.bin', size: 512 * MiB, chunkSize: 4 * MiB, lastModified: 1 });
    expect(ok.disk).toMatchObject({ ok: true, requestedBytes: 512 * MiB, reserveBytes: 5 * GiB });
  });

  it('without enough disk space an upload is refused before it starts — the reserve comes from the host settings and the host can change it', async () => {
    const { xfer, host } = await setup({ disk: nearlyFull() });
    const request = () => xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'x.bin', size: 2 * GiB, chunkSize: 4 * MiB, lastModified: 1 });
    expect((await refusal(request())).code).toBe('insufficient_disk');
    await host.conn.request('admin.settings.set', { diskReserveBytes: GiB, diskReservePercent: 1 });
    const accepted = await request();
    expect(accepted.disk).toMatchObject({ ok: true, reserveBytes: GiB, requestedBytes: 2 * GiB });
    await xfer.request('file.upload.abort', { uploadId: accepted.uploadId });
    // The percentage rule: 10 % of 100 GiB = 10 GiB > 6 GiB free, so not even a small upload fits.
    await host.conn.request('admin.settings.set', { diskReservePercent: 10 });
    const small = await refusal(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'y.bin', size: MiB, chunkSize: MiB, lastModified: 1 }));
    expect(small.code).toBe('insufficient_disk');
    expect(small.disk).toMatchObject({ reserveBytes: 10 * GiB, ok: false });
  });

  it('without enough disk space an upload is refused before it starts — a resume is checked again for its missing bytes only, never charged twice; other uploads count as pending', async () => {
    const { ft: f, xfer } = await setup({ disk: nearlyFull() });
    const first = await xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'one.bin', size: 800 * MiB, chunkSize: 4 * MiB, lastModified: 1 });
    expect(uploadsOf(f).pendingBytes()).toBe(800 * MiB);
    // Resuming the same upload: 800 MiB requested, the upload itself is not also "pending" (the spike's bug).
    const again = await xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'one.bin', size: 800 * MiB, chunkSize: 4 * MiB, lastModified: 1, uploadId: first.uploadId });
    expect(again).toMatchObject({ resumed: true });
    expect(again.disk).toMatchObject({ ok: true, pendingBytes: 0, requestedBytes: 800 * MiB });
    // Another upload must fit next to the 800 MiB still to come.
    const second = await refusal(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'two.bin', size: 400 * MiB, chunkSize: 4 * MiB, lastModified: 1 }));
    expect(second.code).toBe('insufficient_disk');
    expectReport(second.disk, 400 * MiB, 800 * MiB);
    // The disk fills up while an upload is paused: its resume is refused before more bytes flow.
    f.disk.availableBytes = 5 * GiB + 100 * MiB;
    expect((await refusal(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'one.bin', size: 800 * MiB, chunkSize: 4 * MiB, lastModified: 1, uploadId: first.uploadId }))).code).toBe('insufficient_disk');
    f.disk.availableBytes = 6 * GiB;
    await xfer.request('file.upload.abort', { uploadId: first.uploadId });
    expect(uploadsOf(f).pendingBytes()).toBe(0);
    await xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'two.bin', size: 400 * MiB, chunkSize: 4 * MiB, lastModified: 1 });
  });

  it('without enough disk space an upload is refused before it starts — planned bytes stay reserved until their uploads begin', async () => {
    const { ft: f, xfer } = await setup({ disk: nearlyFull() });
    const bob = await f.t.connect({ userId: 'dev:bob', role: 'editor' });
    const bobXfer = await bob.transfer();
    await xfer.request('file.upload.plan', {
      root: MAIN_ROOT,
      entries: [0, 1, 2].map((i) => ({ path: `batch/f${i}.bin`, kind: 'file' as const, size: 300 * MiB })),
      onConflict: 'fail',
    });
    expect(uploadsOf(f).pendingBytes()).toBe(900 * MiB);
    // Bob's upload does not fit next to Amy's plan…
    expect((await refusal(bobXfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'bob.bin', size: 200 * MiB, chunkSize: 4 * MiB, lastModified: 1 }))).code).toBe('insufficient_disk');
    // …but Amy's planned uploads begin against their own reservation.
    const planned = await xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'batch/f0.bin', size: 300 * MiB, chunkSize: 4 * MiB, lastModified: 1 });
    expect(planned.disk).toMatchObject({ ok: true, pendingBytes: 600 * MiB, requestedBytes: 300 * MiB });
    expect(uploadsOf(f).pendingBytes()).toBe(900 * MiB);
    // Closing the planning connection releases what was never begun.
    xfer.close();
    await waitFor(() => uploadsOf(f).pendingBytes() === 300 * MiB, { what: 'the plan reservation to be released' });
  });
});

describe('upload plan (folder drops)', () => {
  it('creates every directory, also empty ones, and renames conflicting files when asked', async () => {
    const { ft: f, xfer } = await setup();
    const plan = await xfer.request('file.upload.plan', {
      root: MAIN_ROOT,
      entries: [
        { path: 'drop', kind: 'dir' },
        { path: 'drop/empty/deeper', kind: 'dir' },
        { path: 'drop/sub/a.txt', kind: 'file', size: 5 },
        { path: 'README.md', kind: 'file', size: 3 },
      ],
      onConflict: 'rename',
    });
    expect(plan.renamed).toEqual([{ from: 'README.md', to: 'README (1).md' }]);
    expect(plan.disk.requestedBytes).toBe(8);
    for (const dir of ['drop', 'drop/empty', 'drop/empty/deeper', 'drop/sub']) expect((await lstat(join(f.t.root, dir))).isDirectory(), dir).toBe(true);
    await expect(lstat(join(f.t.root, 'drop/sub/a.txt'))).rejects.toThrow(); // files arrive with their uploads
    const run = await upload(xfer, { path: plan.renamed[0]?.to as string, size: 3, source: bytesSource(new TextEncoder().encode('new')) });
    expect(run.entry?.path).toBe('README (1).md');
    expect(await readFile(join(f.t.root, 'README.md'), 'utf8')).toBe('# hi\n');
  });

  it('a plan of files in one deep folder makes that folder once, and a plan with more folders than it may have entries is refused before anything is made (review, last round, N1)', async () => {
    const { ft: f, xfer } = await setup();
    // (What such a plan costs is measured on the two pure functions: test/text-cost.test.ts.)
    const deep = `deep/${Array.from({ length: 199 }, () => 'd').join('/')}`;
    const entries = Array.from({ length: 300 }, (_, index) => ({ path: `${deep}/f${index}.txt`, kind: 'file' as const, size: 1 }));
    await xfer.request('file.upload.plan', { root: MAIN_ROOT, entries, onConflict: 'fail' });
    expect((await stat(join(f.t.root, deep))).isDirectory()).toBe(true);
    // Sixty files, each two hundred folders deep in a folder of its own: 12,000 folders, more than a plan has entries.
    const many = Array.from({ length: 60 }, (_, index) => ({ path: `many${index}/${'d/'.repeat(199)}f.txt`, kind: 'file' as const, size: 1 }));
    const refused = await settleError(xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: many, onConflict: 'fail' }));
    expect(refused).toMatchObject({ code: 'too_large', reason: 'too-many-folders' });
    await expect(lstat(join(f.t.root, 'many0'))).rejects.toThrow();
    // As many as a plan may have are made, parents first, each once.
    const wide = Array.from({ length: 50 }, (_, index) => ({ path: `wide${index}/${'d/'.repeat(99)}f.txt`, kind: 'file' as const, size: 1 }));
    await xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: wide, onConflict: 'fail' });
    expect((await stat(join(f.t.root, `wide49/${'d/'.repeat(99)}`))).isDirectory()).toBe(true);
  }, 120_000);

  it('refuses a batch with colliding names (case, file-vs-directory) or existing files, before creating anything', async () => {
    const { ft: f, xfer } = await setup();
    const caseInsensitive = (await lstat(join(f.t.root, 'readme.md')).catch(() => null)) !== null;
    if (caseInsensitive) {
      const dup = await settleError(xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: [{ path: 'new/X.txt', kind: 'file', size: 1 }, { path: 'new/x.txt', kind: 'file', size: 1 }], onConflict: 'fail' }));
      expect(dup).toMatchObject({ code: 'conflict', reason: 'batch-collision' });
    }
    const mixed = await settleError(xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: [{ path: 'new/a', kind: 'file', size: 1 }, { path: 'new/a/b.txt', kind: 'file', size: 1 }], onConflict: 'fail' }));
    expect(mixed).toMatchObject({ code: 'conflict', reason: 'batch-collision' });
    const exists = await settleError(xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: [{ path: 'new/c.txt', kind: 'file', size: 1 }, { path: 'docs/a.txt', kind: 'file', size: 1 }], onConflict: 'fail' }));
    expect(exists).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect(exists?.detail?.['paths']).toEqual([{ path: 'docs/a.txt', reason: 'exists' }]);
    await expect(lstat(join(f.t.root, 'new'))).rejects.toThrow();
  });

  // review RCR-3: the numbered name comes from the upload's own (NFC) spelling, as the single-file path numbers it, and
  // a candidate counts as taken under either spelling (Linux maps an NFC name onto its one NFD twin).
  const pair = (a: string, b: string): { path: string; kind: 'file'; size: number }[] => [
    { path: a, kind: 'file', size: 1 },
    { path: b, kind: 'file', size: 1 },
  ];
  const NFD = (s: string): string => s.normalize('NFD');

  it('renames after the upload’s own spelling: readme.md next to README.md becomes readme (1).md, like a single upload (case-insensitive file systems)', async (context) => {
    const { ft: f, xfer } = await setup();
    context.skip((await lstat(join(f.t.root, 'readme.md')).catch(() => null)) === null, 'case-sensitive file system: readme.md does not collide');
    const plan = await xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: pair('readme.md', 'other.txt'), onConflict: 'rename' });
    expect(plan.renamed).toEqual([{ from: 'readme.md', to: 'readme (1).md' }]);
  });

  it.runIf(process.platform === 'linux')('Linux: next to an NFD café.txt the numbered name is NFC and misses neither the batch nor an existing name of either spelling', async () => {
    const { ft: f, xfer } = await setup();
    const cases: { readonly disk: readonly [string, string][]; readonly batch: readonly [string, string] }[] = [
      { disk: [[NFD('café.txt'), 'x']], batch: ['café.txt', 'café (1).txt'] }, // the batch's own café (1).txt
      { disk: [[NFD('café.txt'), 'x'], ['café (1).txt', 'y']], batch: ['café.txt', 'other.txt'] }, // an NFC one on disk
      { disk: [[NFD('café.txt'), 'x'], [NFD('café (1).txt'), 'y']], batch: ['café.txt', 'other.txt'] }, // an NFD one on disk
      { disk: [['café.txt', 'x'], [NFD('café (1).txt'), 'y']], batch: ['café.txt', 'other.txt'] }, // NFC original, NFD numbered
    ];
    for (const [i, c] of cases.entries()) {
      const dir = `rcr3-${i}`;
      for (const [name, content] of c.disk) {
        await mkdir(join(f.t.root, dir), { recursive: true });
        await writeFile(join(f.t.root, dir, name), content);
      }
      const plan = await xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: pair(`${dir}/${c.batch[0]}`, `${dir}/${c.batch[1]}`), onConflict: 'rename' });
      expect(plan.renamed, `case ${i}`).toEqual([{ from: `${dir}/café.txt`, to: `${dir}/café (2).txt` }]);
      expect(plan.renamed[0]?.to.normalize('NFC')).toBe(plan.renamed[0]?.to);
    }
    // and the upload lands where the plan said, next to the untouched originals
    const run = await upload(xfer, { path: 'rcr3-0/café (2).txt', size: 3, source: bytesSource(new TextEncoder().encode('new')) });
    expect(run.entry?.path).toBe('rcr3-0/café (2).txt');
    expect(await readFile(join(f.t.root, 'rcr3-0', NFD('café.txt')), 'utf8')).toBe('x');
  });
});

describe('commit policies and locks', () => {
  it('never replaces a file that appeared meanwhile (EEXIST decides); overwrites or renames when asked', async () => {
    const locks = new ScriptedLocks();
    const { ft: f, xfer } = await setup({ locks });
    const payload = new TextEncoder().encode('uploaded content\n');
    // 'fail' (default): a file created after begin wins, the upload is refused, the other file is intact.
    const pending = await upload(xfer, { path: 'race.txt', size: payload.byteLength, source: bytesSource(payload), stopAfter: 1 });
    await writeFile(join(f.t.root, 'race.txt'), 'written by an agent meanwhile\n');
    const hash = new Uint8Array(Buffer.from(sha256Hex(payload), 'hex'));
    const refused = await settleError(xfer.request('file.upload.commit', { uploadId: pending.begin.uploadId, rootHash: uploadRootHash(payload.byteLength, MiB, [hash]) }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect(await readFile(join(f.t.root, 'race.txt'), 'utf8')).toBe('written by an agent meanwhile\n');
    // 'overwrite': replaces, and the file keeps its permissions.
    await chmod(join(f.t.root, 'race.txt'), 0o750);
    const over = await upload(xfer, { path: 'race.txt', size: payload.byteLength, source: bytesSource(payload), onConflict: 'overwrite' });
    expect(over.entry?.path).toBe('race.txt');
    expect(await readFile(join(f.t.root, 'race.txt'), 'utf8')).toBe('uploaded content\n');
    expect((await stat(join(f.t.root, 'race.txt'))).mode & 0o777).toBe(0o750);
    // 'rename': a free name next to it.
    const renamed = await upload(xfer, { path: 'race.txt', size: payload.byteLength, source: bytesSource(payload), onConflict: 'rename', lastModified: 2 });
    expect(renamed.entry?.path).toBe('race (1).txt');
    // A lock on the target refuses the overwrite at begin, and at commit when it appears after begin.
    locks.set(humanLock(main('race.txt'), 'Bob'));
    expect(await settleError(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'race.txt', size: 1, chunkSize: MiB, lastModified: 3, onConflict: 'overwrite' }))).toMatchObject({ code: 'locked' });
    locks.clear();
    const late = await upload(xfer, { path: 'race.txt', size: payload.byteLength, source: bytesSource(payload), onConflict: 'overwrite', lastModified: 4, stopAfter: 1 });
    locks.set(humanLock(main('race.txt'), 'Bob'));
    expect(await settleError(xfer.request('file.upload.commit', { uploadId: late.begin.uploadId, rootHash: uploadRootHash(payload.byteLength, MiB, [hash]) }))).toMatchObject({ code: 'locked' });
  });
});

describe('who may upload', () => {
  it('a viewer cannot upload; an editor cannot upload into host-only paths', async () => {
    const { ft: f, xfer } = await setup();
    const vera = await f.t.connect({ userId: 'dev:vera', role: 'viewer' });
    const veraXfer = await vera.transfer();
    const begin = { root: MAIN_ROOT, path: 'v.bin', size: 1, chunkSize: MiB, lastModified: 1 };
    expect((await settleError(veraXfer.request('file.upload.begin', begin)))?.code).toBe('forbidden');
    expect((await settleError(veraXfer.request('file.upload.plan', { root: MAIN_ROOT, entries: [{ path: 'v', kind: 'dir' }], onConflict: 'fail' })))?.code).toBe('forbidden');
    for (const path of ['.claude/settings.json', '.mcp.json', 'pkg/.vscode/tasks.json', '.git/hooks/post-checkout']) {
      expect((await settleError(xfer.request('file.upload.begin', { ...begin, path })))?.code, path).toBe('host_only');
    }
    const denied = await auditEntries(f.t.ctx, (e) => e.outcome === 'denied' && (e.action === 'authz.denied' || e.action === 'path.denied'));
    expect(denied.filter((e) => e.actor.kind === 'user' && e.actor.userId === 'dev:vera').map((e) => e.target)).toEqual(['file.upload.begin', 'file.upload.plan']);
  });

  it('only the connection that began (or resumed) an upload may continue it', async () => {
    const { ft: f, amy, xfer } = await setup();
    const source = patternSource('bound');
    const run = await upload(xfer, { path: 'bound.bin', size: 3 * MiB, source, stopAfter: 1 });
    const data = source(1, MiB, MiB);
    const hash = new Uint8Array(Buffer.from(sha256Hex(data), 'hex'));
    const chunk = { uploadId: run.begin.uploadId, index: 1, hash, data };
    // Amy's second transfer socket (another tab) must begin first.
    const other = await amy.transfer();
    expect(await settleError(other.request('file.upload.chunk', chunk))).toMatchObject({ code: 'conflict', reason: 'not-bound' });
    // Someone else cannot touch Amy's upload at all (audited).
    const bob = await f.t.connect({ userId: 'dev:bob', role: 'editor' });
    const bobXfer = await bob.transfer();
    expect(await settleError(bobXfer.request('file.upload.chunk', chunk))).toMatchObject({ code: 'forbidden' });
    expect(await settleError(bobXfer.request('file.upload.commit', { uploadId: run.begin.uploadId, rootHash: new Uint8Array(32) }))).toMatchObject({ code: 'forbidden' });
    expect(await settleError(bobXfer.request('file.upload.abort', { uploadId: run.begin.uploadId }))).toMatchObject({ code: 'forbidden' });
    // Bob's begin with Amy's id does not resume Amy's upload: it starts his own.
    const bobs = await bobXfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'bound.bin', size: 3 * MiB, chunkSize: MiB, lastModified: 1_760_000_000_000, uploadId: run.begin.uploadId });
    expect(bobs.uploadId).not.toBe(run.begin.uploadId);
    expect(bobs.resumed).toBe(false);
    // The other tab resumes; from then on the first socket is the one refused.
    const resumed = await other.request('file.upload.begin', { root: MAIN_ROOT, path: 'bound.bin', size: 3 * MiB, chunkSize: MiB, lastModified: 1_760_000_000_000, uploadId: run.begin.uploadId });
    expect(resumed.resumed).toBe(true);
    await other.request('file.upload.chunk', chunk);
    expect(await settleError(xfer.request('file.upload.chunk', { ...chunk, index: 1 }))).toMatchObject({ code: 'conflict', reason: 'not-bound' });
  });
});

describe('abort, kick, sweep', () => {
  it('abort removes the partial upload; kicking a member aborts every upload of theirs', async () => {
    const { ft: f, host, xfer } = await setup();
    const source = patternSource('abort');
    const a = await upload(xfer, { path: 'a.bin', size: 2 * MiB, source, stopAfter: 1 });
    expect((await readdir(stagingDir(f))).sort()).toEqual([`${a.begin.uploadId}.json`, `${a.begin.uploadId}.log`, `${a.begin.uploadId}.part`]);
    await xfer.request('file.upload.abort', { uploadId: a.begin.uploadId });
    expect(await readdir(stagingDir(f))).toEqual([]);
    await xfer.request('file.upload.abort', { uploadId: a.begin.uploadId }); // twice is fine
    await upload(xfer, { path: 'b.bin', size: 2 * MiB, source, stopAfter: 1 });
    await upload(xfer, { path: 'c.bin', size: 2 * MiB, source, stopAfter: 1 });
    expect((await readdir(stagingDir(f))).length).toBe(6);
    await host.conn.request('admin.member.kick', { userId: 'dev:amy' });
    await waitFor(async () => (await readdir(stagingDir(f))).length === 0, { what: 'the kicked member uploads to be aborted' });
    expect(uploadsOf(f).pendingBytes()).toBe(0);
  });

  it('the sweep removes partial uploads untouched for the TTL and stray staging files, not live ones', async () => {
    const { ft: f, amy, xfer } = await setup();
    const source = patternSource('sweep');
    const abandoned = await upload(xfer, { path: 'abandoned.bin', size: 2 * MiB, source, stopAfter: 1 });
    const other = await amy.transfer();
    const live = await upload(other, { path: 'live.bin', size: 2 * MiB, source, stopAfter: 1 });
    xfer.close();
    await waitFor(() => uploadsOf(f).boundConnection(abandoned.begin.uploadId) === null, { what: 'the closed socket to release its upload' });
    const dir = stagingDir(f);
    await writeFile(join(dir, 'up_AAAAAAAAAAAAAAAAAAAAAA.part'), 'orphan'); // a part without manifest (crash)
    await writeFile(join(dir, 'notes.txt'), 'not ours'); // never touched
    f.t.advanceClock(49 * 60 * 60 * 1000);
    const removed = await uploadsOf(f).sweep();
    expect(removed).toEqual([abandoned.begin.uploadId]);
    expect((await readdir(dir)).sort()).toEqual([`${live.begin.uploadId}.json`, `${live.begin.uploadId}.log`, `${live.begin.uploadId}.part`, 'notes.txt'].sort());
    expect(await settleError(other.request('file.upload.begin', { root: MAIN_ROOT, path: 'abandoned.bin', size: 2 * MiB, chunkSize: MiB, lastModified: 1_760_000_000_000, uploadId: abandoned.begin.uploadId }))).toBeNull();
  });
});

describe('staging hygiene', () => {
  it('staging files are private (0600 in a 0700 directory) and never inside the shared folder when the state dir is on the same volume', async () => {
    const { ft: f, xfer } = await setup();
    const run = await upload(xfer, { path: 'p.bin', size: 2 * MiB, source: patternSource('mode'), stopAfter: 1 });
    const dir = stagingDir(f);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const ext of ['json', 'log', 'part']) expect((await stat(join(dir, `${run.begin.uploadId}.${ext}`))).mode & 0o777, ext).toBe(0o600);
    await expect(lstat(join(f.t.root, '.smurg/uploads'))).rejects.toThrow();
    const { stdout } = await execFileAsync('ls', ['-a', join(f.t.root, '.smurg')]);
    expect(stdout.split('\n')).not.toContain('uploads');
  });
});

describe('staging on another volume (transfer.md §1.4)', () => {
  it('stages in <share>/.smurg/uploads (0700) when the state dir is on another volume, and commits from there', async () => {
    const { ft: f, xfer } = await setup();
    // Pretend the state dir lives on another device: the service must stage next to the target instead.
    const internals = uploadsOf(f) as unknown as { stateArea: { kind: string; dir: string; dev: number } };
    internals.stateArea = { ...internals.stateArea, dev: -1 };
    const source = patternSource('share-staging');
    const partial = await upload(xfer, { path: 'far.bin', size: 2 * MiB, source, stopAfter: 1 });
    const shareStaging = join(f.t.root, '.smurg/uploads');
    expect((await stat(shareStaging)).mode & 0o777).toBe(0o700);
    expect((await readdir(shareStaging)).sort()).toEqual([`${partial.begin.uploadId}.json`, `${partial.begin.uploadId}.log`, `${partial.begin.uploadId}.part`]);
    expect(await readdir(stagingDir(f))).toEqual([]);
    // Guests never see it: it is below .smurg.
    const bob = await f.t.connect({ userId: 'dev:bob', role: 'editor' });
    expect((await settleError(bob.conn.request('file.tree', { root: MAIN_ROOT, path: '.smurg/uploads' })))?.code).toBe('path_denied');
    const done = await upload(xfer, { path: 'far.bin', size: 2 * MiB, source, uploadId: partial.begin.uploadId });
    expect(done.begin.resumed).toBe(true);
    expect(sha256Hex(await readFile(join(f.t.root, 'far.bin')))).toBe(sourceHash(source, 2 * MiB, MiB));
    expect(await readdir(shareStaging)).toEqual([]);
  });
});

