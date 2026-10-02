// Unit tests of the files module's pure parts: the disk rule (transfer.md §1.5, F13–F14), attribution, the staging
// store's journal replay / memoized open / stray cleanup (transfer.md verification items 1–2), naming helpers.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT } from '@smurg/protocol';
import { formatBytes, render } from '@smurg/protocol/i18n';
import { uploadRootHash } from '@smurg/protocol/client';
import { ManualClock } from '../../src/core/lifecycle.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { ChangeAttribution } from '../../src/files/attribution.ts';
import { diskReport, insufficientDiskMessage } from '../../src/files/disk.ts';
import { rechunk } from '../../src/files/download.ts';
import { isDaemonOwnedPath, numberedName } from '../../src/files/fs-ops.ts';
import { hashListRoot } from '../../src/files/upload.ts';
import { UploadStore, type StagingArea, type UploadManifest } from '../../src/files/upload-store.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

describe('disk rule: reserve = max(bytes, percent × total); accept ⇔ available − pending − requested ≥ reserve', () => {
  const settings = { diskReserveBytes: 5 * GiB, diskReservePercent: 5 };
  // The machine of transfer.md F14: blocks 120,699,413 × 4096 = 460.43 GiB, bavail 7,607,202 × 4096 = 29.02 GiB.
  const laptop = { bsize: 4096n, blocks: 120_699_413n, bavail: 7_607_202n };
  const total = 120_699_413 * 4096;
  const available = 7_607_202 * 4096;
  const reserve = Number((BigInt(total) * 500n) / 10_000n);

  it('the percentage dominates on a big disk: 23.02 GiB reserved, at most ~6 GiB accepted; exactly the maximum passes, one byte more does not', () => {
    const max = available - reserve;
    expect(reserve / GiB).toBeCloseTo(23.02, 2);
    expect(max / GiB).toBeCloseTo(6.0, 1);
    expect(diskReport(laptop, settings, 0, max)).toEqual({ totalBytes: total, availableBytes: available, reserveBytes: reserve, pendingBytes: 0, requestedBytes: max, freeAfterBytes: reserve, ok: true });
    expect(diskReport(laptop, settings, 0, max + 1).ok).toBe(false);
    expect(diskReport(laptop, settings, 0, 10 * GiB).ok).toBe(false);
  });

  it('pending bytes of other uploads count; the fixed reserve dominates on a small disk; fractions of a percent work', () => {
    const small = { bsize: 4096, blocks: (50 * GiB) / 4096, bavail: (8 * GiB) / 4096 };
    expect(diskReport(small, settings, 0, 3 * GiB)).toMatchObject({ reserveBytes: 5 * GiB, ok: true, freeAfterBytes: 5 * GiB });
    expect(diskReport(small, settings, MiB, 3 * GiB)).toMatchObject({ ok: false, pendingBytes: MiB, freeAfterBytes: 5 * GiB - MiB });
    expect(diskReport(small, { diskReserveBytes: 0, diskReservePercent: 2.5 }, 0, 0).reserveBytes).toBe(Math.round(50 * GiB * 0.025));
    // Free space after the upload may be negative; it is reported as such.
    expect(diskReport(small, settings, 0, 20 * GiB)).toMatchObject({ ok: false, freeAfterBytes: -12 * GiB });
  });

  it('the refusal carries the numbers as parameters; each language explains them and points to the setting', () => {
    const report = diskReport(laptop, settings, 0, 10 * GiB);
    const ref = insufficientDiskMessage(report);
    expect(ref).toEqual({
      id: 'upload.insufficientDisk',
      params: {
        requestedBytes: report.requestedBytes,
        freeAfterBytes: report.freeAfterBytes,
        reserveBytes: report.reserveBytes,
        availableBytes: report.availableBytes,
        pendingBytes: report.pendingBytes,
      },
    });
    const english = render('en', ref) ?? '';
    expect(english).toContain('10.00 GiB');
    expect(english).toContain(formatBytes(reserve));
    expect(english).toContain('settings');
    expect(render('zh-TW', ref)).toContain(formatBytes(reserve));
  });
});

describe('ChangeAttribution', () => {
  const amy = { kind: 'user' as const, userId: 'dev:amy', displayName: 'Amy' };
  const agent = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: 'dev:ian', displayName: 'Claude (Ian)' };

  it('attributes a change inside the window, to the path or (subtree) to everything below it, under any case spelling', () => {
    const clock = new ManualClock();
    const attribution = new ChangeAttribution({ clock });
    attribution.expect(MAIN_ROOT, 'src/App.ts', amy, 5_000);
    attribution.expect(MAIN_ROOT, 'build', agent, 5_000, true);
    expect(attribution.attribute(MAIN_ROOT, 'src/App.ts')).toEqual(amy);
    expect(attribution.attribute(MAIN_ROOT, 'src/app.ts')).toEqual(amy); // one entry on a case-insensitive disk
    expect(attribution.attribute(MAIN_ROOT, 'build/out/x.js')).toEqual(agent);
    expect(attribution.attribute(MAIN_ROOT, 'src/other.ts')).toBeUndefined();
    expect(attribution.attribute({ kind: 'worktree', worktreeId: 'wt_1' }, 'src/App.ts')).toBeUndefined();
    clock.advance(5_001);
    expect(attribution.attribute(MAIN_ROOT, 'src/App.ts')).toBeUndefined();
    expect(attribution.attribute(MAIN_ROOT, 'build/out/x.js')).toBeUndefined();
  });

  it('a shorter announcement by the same actor does not cut a longer one short; the last-modified memory is bounded', () => {
    const clock = new ManualClock();
    const attribution = new ChangeAttribution({ clock, maxModified: 3 });
    attribution.expect(MAIN_ROOT, 'a', agent, 60_000);
    attribution.expect(MAIN_ROOT, 'a', agent, 1_000);
    clock.advance(30_000);
    expect(attribution.attribute(MAIN_ROOT, 'a')).toEqual(agent);
    for (const path of ['p1', 'p2', 'p3', 'p4']) attribution.recordModified(MAIN_ROOT, path, amy);
    expect(attribution.lastModifiedBy(MAIN_ROOT, 'p1')).toBeNull();
    expect(attribution.lastModifiedBy(MAIN_ROOT, 'p4')).toEqual(amy);
    attribution.recordModified(MAIN_ROOT, 'dir/x', amy);
    attribution.forget(MAIN_ROOT, 'dir', true);
    expect(attribution.lastModifiedBy(MAIN_ROOT, 'dir/x')).toBeNull();
  });
});

describe('UploadStore', () => {
  let dir: string;
  let area: StagingArea;

  beforeEach(async () => {
    dir = await createTempDir('upstore');
    await mkdir(join(dir, 'uploads'), { mode: 0o700 });
    area = { kind: 'state', dir: join(dir, 'uploads'), dev: 0 };
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const manifest = (id: string, size = 3 * MiB): UploadManifest => ({
    v: 1,
    uploadId: id,
    userId: 'dev:amy',
    root: MAIN_ROOT,
    path: 'a.bin',
    size,
    chunkSize: MiB,
    chunkCount: Math.ceil(size / MiB),
    lastModified: 1,
    onConflict: 'fail',
    createdAt: 1,
    targetDev: 0,
  });
  const ID = 'up_AAAAAAAAAAAAAAAAAAAAAA';
  const digest = (data: Uint8Array) => createHash('sha256').update(data).digest();

  it('replays the journal on load: a torn last line, a duplicate and an index out of range are ignored', async () => {
    const store = new UploadStore({ log: silentLogger });
    const upload = await store.create(manifest(ID), area);
    const chunk = randomBytes(MiB);
    await store.writeChunk(upload, 1, digest(chunk), chunk);
    await store.closeHandles(upload);
    const h = digest(chunk).toString('hex');
    await writeFile(join(area.dir, `${ID}.log`), `1 ${h}\n1 ${h}\n7 ${h}\n0 ${h.slice(0, 20)}`, { flag: 'w' });
    const reloaded = new UploadStore({ log: silentLogger });
    await reloaded.loadArea(area);
    const again = reloaded.get(ID);
    expect(again?.receivedChunks).toBe(1);
    expect(again?.hasChunk(1)).toBe(true);
    expect(again?.hasChunk(0)).toBe(false);
    expect(again?.remainingBytes).toBe(2 * MiB);
  });

  it('opens the files once even when chunks race in before the first open finished (memoized load)', async () => {
    const store = new UploadStore({ log: silentLogger });
    const created = await store.create(manifest(ID, 8 * MiB), area);
    await store.closeHandles(created);
    const reloaded = new UploadStore({ log: silentLogger });
    await reloaded.loadArea(area);
    const upload = reloaded.get(ID);
    if (!upload) throw new Error('not loaded');
    const first = reloaded.handlesOf(upload);
    expect(reloaded.handlesOf(upload)).toBe(first);
    const chunks = Array.from({ length: 8 }, () => randomBytes(MiB));
    await Promise.all(chunks.map((data, index) => reloaded.writeChunk(upload, index, digest(data), data)));
    expect(upload.complete).toBe(true);
    expect(hashListRoot(8 * MiB, MiB, upload.hashes).equals(Buffer.from(uploadRootHash(8 * MiB, MiB, chunks.map(digest))))).toBe(true);
    await reloaded.closeAll();
  });

  it('removes strays (a part without manifest, a manifest temp file, a manifest that names another id) and nothing else', async () => {
    await writeFile(join(area.dir, 'up_BBBBBBBBBBBBBBBBBBBBBB.part'), 'orphan');
    await writeFile(join(area.dir, '.up_CCCCCCCCCCCCCCCCCCCCCC.json.0123456789ab.tmp'), '{}');
    // A manifest whose file name is a case variant of the id inside it (APFS would open one for the other).
    await writeFile(join(area.dir, 'up_dddddddddddddddddddddd.json'), JSON.stringify(manifest('up_DDDDDDDDDDDDDDDDDDDDDD')));
    await writeFile(join(area.dir, 'up_dddddddddddddddddddddd.part'), '');
    await writeFile(join(area.dir, 'keep-me.txt'), 'not ours');
    const store = new UploadStore({ log: silentLogger });
    await store.loadArea(area);
    expect(store.list()).toEqual([]);
    expect(await readdir(area.dir)).toEqual(['keep-me.txt']);
  });
});

describe('helpers', () => {
  it('numbered names keep the extension', () => {
    expect(numberedName('a.txt', 1)).toBe('a (1).txt');
    expect(numberedName('archive.tar.gz', 2)).toBe('archive.tar (2).gz');
    expect(numberedName('.env', 1)).toBe('.env (1)');
    expect(numberedName('Makefile', 3)).toBe('Makefile (3)');
  });

  it('daemon-owned paths: .smurg itself, its daemon directories, worktree roots, staging and trash contents', () => {
    const owned = ['.smurg', '.SMURG', '.smurg/worktrees', '.smurg/worktrees/wt_1', '.smurg/uploads', '.smurg/uploads/up_x.part', '.smurg/trash/del_x/a'];
    const free = ['smurg', 'src/.smurg', '.smurg/worktrees/wt_1/src/app.ts', '.smurg/notes.txt'];
    for (const path of owned) expect(isDaemonOwnedPath(MAIN_ROOT, path), path).toBe(true);
    for (const path of free) expect(isDaemonOwnedPath(MAIN_ROOT, path), path).toBe(false);
    expect(isDaemonOwnedPath({ kind: 'worktree', worktreeId: 'wt_1' }, '.smurg')).toBe(false);
  });

  it('rechunk cuts a stream into exact messages without losing a byte', async () => {
    const input = randomBytes(10 * KiB + 17);
    const pieces = [input.subarray(0, 1), input.subarray(1, 5_000), input.subarray(5_000, 5_001), input.subarray(5_001)];
    const out: Buffer[] = [];
    for await (const part of rechunk(Readable.from(pieces), 4 * KiB)) out.push(Buffer.from(part));
    expect(out.map((b) => b.byteLength)).toEqual([4 * KiB, 4 * KiB, 2 * KiB + 17]);
    expect(Buffer.concat(out).equals(input)).toBe(true);
  });
});
