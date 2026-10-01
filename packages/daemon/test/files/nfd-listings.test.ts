// review RCR-2: on a normalisation-sensitive file system (Linux) every NFC request that misses is mapped onto the one
// entry of its directory that spells it differently (ARCHITECTURE §7.4), which lists the directory. Without an index
// per operation, a zip or a watcher batch over a folder of n Mac-made (NFD) names listed that folder about 2n times
// (O(n²): measured on ext4, a 20,000-file zip took 374 s instead of 26 s and the watcher reported 20,000 new files
// after 54 s instead of 3.5 s). These tests count the listings instead of timing them (a wall-clock bound would
// measure the machine): one per directory per operation.
import { execFile } from 'node:child_process';
import fsp, { mkdir, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT } from '@smurg/protocol';
import { SpellingIndex } from '../../src/workspace/fs-util.ts';
import { createTempDir, removeTempDir, waitFor } from '../../src/testing/index.ts';
import { downloadToFile, startFilesDaemon, type FilesTest } from './helpers.ts';

const N = 300;
const execFileAsync = promisify(execFile);

let ft: FilesTest | null = null;
const temps: string[] = [];
afterEach(async () => {
  unpatch();
  await ft?.t.cleanup();
  ft = null;
  for (const dir of temps.splice(0)) await removeTempDir(dir);
});

// Counts readdir() of one directory through node:fs/promises: the daemon imports the named binding, which
// syncBuiltinESMExports keeps in step with the module object.
const realReaddir = fsp.readdir;
let watched: string | null = null;
let listings = 0;
function countListingsOf(dir: string): void {
  watched = dir;
  listings = 0;
  (fsp as unknown as { readdir: unknown }).readdir = ((...args: Parameters<typeof realReaddir>) => {
    if (args[0] === watched) listings++;
    return realReaddir(...args);
  }) as typeof realReaddir;
  syncBuiltinESMExports();
}
function unpatch(): void {
  if (watched === null) return;
  watched = null;
  (fsp as unknown as { readdir: unknown }).readdir = realReaddir;
  syncBuiltinESMExports();
}

/** `n` distinct Hangul names; `nfd`: spelled as macOS tools write them (conjoining Jamo). */
function hangul(n: number, nfd: boolean, prefix = ''): string[] {
  return Array.from({ length: n }, (_, i) => {
    const s = `${prefix}${String.fromCodePoint(0xac00 + (i % 11172))}${String.fromCodePoint(0xac00 + ((i * 7) % 11172))}-${i}.txt`;
    return nfd ? s.normalize('NFD') : s;
  });
}

describe('SpellingIndex (one listing per directory per operation)', () => {
  it('answers like otherSpellings from one listing; a later entry is seen by the next operation’s index, not by this one', async () => {
    const dir = await createTempDir('spellings');
    temps.push(dir);
    await writeFile(join(dir, 'café.txt'), 'x');
    await writeFile(join(dir, 'plain.txt'), 'x');
    countListingsOf(dir);
    const index = new SpellingIndex();
    expect(await index.otherSpellings(dir, 'café.txt')).toEqual(['café.txt']);
    expect(await index.otherSpellings(dir, 'plain.txt')).toEqual([]);
    expect(await index.otherSpellings(dir, 'missing.txt')).toEqual([]); // an ASCII name cannot have another spelling
    expect(await index.otherSpellings(dir, '한글.txt')).toEqual([]);
    expect(listings).toBe(1);
    await writeFile(join(dir, 'näme.txt'), 'x'); // after this index listed the directory
    expect(await index.otherSpellings(dir, 'näme.txt')).toEqual([]);
    expect(await new SpellingIndex().otherSpellings(dir, 'näme.txt')).toEqual(['näme.txt']);
    expect(await index.otherSpellings(join(dir, 'nope'), 'café.txt')).toEqual([]); // a directory that is not there
  });
});

describe.runIf(process.platform === 'linux')('Linux: NFD names cost one listing per directory per operation (review RCR-2)', () => {
  it(`a zip of a folder of ${N} Mac-made (NFD) names lists that folder a constant number of times, and packs every file`, async () => {
    ft = await startFilesDaemon({ project: { files: { 'README.md': 'x\n' } }, files: { watch: false } });
    const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const xfer = await amy.transfer();
    const dir = join(ft.t.root, 'kr');
    await mkdir(dir);
    for (const name of hangul(N, true)) await writeFile(join(dir, name), 'x');
    const work = await createTempDir('nfd-zip');
    temps.push(work);
    countListingsOf(dir);
    const end = await downloadToFile(xfer, { file: { root: MAIN_ROOT, path: 'kr' }, zip: true }, join(work, 'kr.zip'));
    const count = listings;
    unpatch();
    expect(end.skipped).toEqual([]);
    const { stdout } = await execFileAsync('unzip', ['-Z1', join(work, 'kr.zip')], { maxBuffer: 16 * 1024 * 1024 });
    expect(stdout.trim().split('\n')).toHaveLength(N);
    // the walker's own listing and one for the NFC → NFD mapping of every file (it was about 2 per file)
    expect(count).toBeLessThanOrEqual(3);
  }, 120_000);

  it(`the watcher reports ${N} new NFD-named files with at most one listing of their folder per batch, and ${N} deleted Han-named files likewise`, async () => {
    ft = await startFilesDaemon({ project: { files: { 'README.md': 'x\n' } }, files: { watch: true } });
    const f = ft;
    const dir = join(f.t.root, 'kr');
    await mkdir(dir);
    let batches = 0;
    let adds = 0;
    let unlinks = 0;
    f.t.ctx.bus.on('file.changed', ({ changes }) => {
      if (!changes.some((c) => c.path.startsWith('kr/'))) return;
      batches++;
      for (const c of changes) {
        if (c.change === 'add' && c.path.startsWith('kr/')) adds++;
        if (c.change === 'unlink' && c.path.startsWith('kr/')) unlinks++;
      }
    });
    // The native stream delivers a moment after subscribe(): make sure it is live before counting.
    let warm = false;
    f.t.ctx.bus.on('file.changed', ({ changes }) => {
      if (changes.some((c) => c.path === 'warmup.txt')) warm = true;
    });
    await writeFile(join(f.t.root, 'warmup.txt'), 'w');
    await waitFor(() => warm, { timeoutMs: 10_000, what: 'the watcher to deliver a first event' });
    countListingsOf(dir);
    const names = hangul(N, true);
    for (const name of names) await writeFile(join(dir, name), 'x');
    await waitFor(() => adds >= N, { timeoutMs: 60_000, what: `the watcher to report ${N} new files` });
    expect(listings, `${listings} listings for ${batches} batches`).toBeLessThanOrEqual(batches);
    expect(adds).toBe(N);

    // Han names have no NFD form, but a missing non-ASCII name may still have another spelling: each deleted one is
    // looked up (once per batch now).
    const han = Array.from({ length: N }, (_, i) => `${String.fromCodePoint(0x4e00 + i)}${String.fromCodePoint(0x4e00 + ((i * 7) % 20000))}-${i}.txt`);
    for (const name of han) await writeFile(join(dir, name), 'x');
    await waitFor(() => adds >= 2 * N, { timeoutMs: 60_000, what: 'the Han-named files to be reported' });
    batches = 0;
    countListingsOf(dir);
    for (const name of han) await unlink(join(dir, name));
    await waitFor(() => unlinks >= N, { timeoutMs: 60_000, what: `the watcher to report ${N} deletions` });
    expect(listings, `${listings} listings for ${batches} batches`).toBeLessThanOrEqual(batches);
  }, 180_000);

  it(`file.tree of depth 2 over a folder of ${N} Mac-made (NFD) sub-directories lists that folder a constant number of times, and lists every one (review RV-7)`, async () => {
    ft = await startFilesDaemon({ project: { files: { 'README.md': 'x\n' } }, files: { watch: false } });
    const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const dir = join(ft.t.root, 'kr');
    await mkdir(dir);
    const names = hangul(N, true).map((name) => name.replace(/\.txt$/, ''));
    for (const name of names) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'inner.txt'), 'x');
    }
    countListingsOf(dir);
    const tree = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: 'kr', depth: 2 });
    const count = listings;
    unpatch();
    expect(tree.truncated).toBe(false);
    expect(tree.entries.filter((entry) => entry.kind === 'dir')).toHaveLength(N);
    expect(tree.entries.filter((entry) => entry.name === 'inner.txt')).toHaveLength(N);
    // the folder's own listing and one for the NFC → NFD mapping of every sub-directory (it was one per sub-directory)
    expect(count).toBeLessThanOrEqual(3);
  }, 120_000);

  it(`an upload plan of ${N} new non-ASCII names lists their folder once`, async () => {
    ft = await startFilesDaemon({ project: { files: { 'README.md': 'x\n', 'up/keep.txt': 'k\n' } }, files: { watch: false } });
    const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const xfer = await amy.transfer();
    const dir = join(ft.t.root, 'up');
    for (const name of hangul(N, true, 'old-')) await writeFile(join(dir, name), 'x');
    countListingsOf(dir);
    const plan = await xfer.request('file.upload.plan', { root: MAIN_ROOT, entries: hangul(N, false).map((name) => ({ path: `up/${name}`, kind: 'file' as const, size: 1 })), onConflict: 'rename' });
    expect(plan.renamed).toEqual([]);
    expect(listings).toBeLessThanOrEqual(1);
  }, 120_000);
});
