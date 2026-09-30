// Downloads on the transfer channel (SPEC R7; ARCHITECTURE §5.2; transfer.md §1.6): single files by offset with the
// credit window, folders as a streamed zip through our walker. R7.5: a 1,000-file folder is zipped, extracted with the
// system `unzip`, and compared file by file (content hash, type, permission bits, link targets, empty directories).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, readlink, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, TRANSFER_WINDOW_CHUNKS, type FileRef } from '@smurg/protocol';
import type { TransferConnection } from '@smurg/protocol/client';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import type { DownloadServiceImpl } from '../../src/files/download.ts';
import { createZipSource } from '../../src/files/zip.ts';
import { createTempDir, removeTempDir, waitFor, type TestClient } from '../../src/testing/index.ts';
import { MiB, auditEntries, downloadToBuffer, downloadToFile, settleError, sha256Hex, startFilesDaemon, type FilesTest } from './helpers.ts';

const execFileAsync = promisify(execFile);
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

let ft: FilesTest | null = null;
const temps: string[] = [];

afterEach(async () => {
  await ft?.t.cleanup();
  ft = null;
  for (const dir of temps.splice(0)) await removeTempDir(dir).catch(() => {});
});

async function setup(files: Record<string, string | Uint8Array> = {}): Promise<{ ft: FilesTest; host: TestClient; amy: TestClient; xfer: TransferConnection }> {
  ft = await startFilesDaemon({ project: { files }, files: { watch: false }, settings: { uploadChunkSize: MiB } });
  const host = await ft.t.connectHost();
  const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  return { ft, host, amy, xfer: await amy.transfer() };
}

describe('single-file download', { timeout: 60_000 }, () => {
  it('streams a file in chunks with its name, size and etag; a viewer may download', async () => {
    const blob = randomBytes(3 * MiB + 777);
    const { ft: f } = await setup({ 'data/blob.bin': blob });
    const vera = await f.t.connect({ userId: 'dev:vera', role: 'viewer' });
    const veraXfer = await vera.transfer();
    const { info, data, end } = await downloadToBuffer(veraXfer, { file: main('data/blob.bin') });
    expect(info).toMatchObject({ name: 'blob.bin', size: blob.byteLength, zip: false });
    expect(info.etag).toMatch(/^[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+$/);
    expect(sha256Hex(data)).toBe(sha256Hex(blob));
    expect(end).toMatchObject({ totalBytes: blob.byteLength, skipped: [], zip64: false });
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.download');
    expect(audit.at(-1)).toMatchObject({ outcome: 'ok', target: 'main:data/blob.bin', actor: { userId: 'dev:vera' } });
  });

  it('resumes by offset while the etag still matches; a changed file answers conflict', async () => {
    const blob = randomBytes(3 * MiB);
    const { ft: f, xfer } = await setup({ 'blob.bin': blob });
    const first = await downloadToBuffer(xfer, { file: main('blob.bin') });
    const offset = 2 * MiB + 5;
    const rest = await downloadToBuffer(xfer, { file: main('blob.bin'), offset, ifMatch: first.info.etag as string });
    expect(rest.end.totalBytes).toBe(blob.byteLength - offset);
    expect(sha256Hex(rest.data)).toBe(sha256Hex(blob.subarray(offset)));
    await writeFile(join(f.t.root, 'blob.bin'), 'changed');
    expect(await settleError(xfer.request('file.download.begin', { file: main('blob.bin'), offset, ifMatch: first.info.etag as string }))).toMatchObject({ code: 'conflict', reason: 'changed' });
    expect(await settleError(xfer.request('file.download.begin', { file: main('blob.bin'), offset: 100 }))).toMatchObject({ code: 'bad_request', reason: 'offset' });
  });

  it('never has more than the credit window of chunks unacknowledged', async () => {
    const { xfer } = await setup({ 'big.bin': randomBytes(8 * MiB) });
    let arrived = 0;
    const off = xfer.on('file.download.chunk', () => {
      arrived++;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const download = await xfer.download({ file: main('big.bin') }, { onChunk: async (chunk) => (chunk.index === 0 ? gate : undefined) });
    // The client holds the first chunk: the daemon may send exactly the window, then must wait.
    await waitFor(() => arrived >= TRANSFER_WINDOW_CHUNKS, { what: 'the first window of chunks' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(arrived).toBe(TRANSFER_WINDOW_CHUNKS);
    release();
    const end = await download.done;
    expect(arrived).toBe(8);
    expect(end.totalBytes).toBe(8 * MiB);
    off();
  });

  it('a cancelled download stops sending and releases the file', async () => {
    const { ft: f, xfer } = await setup({ 'big.bin': randomBytes(8 * MiB) });
    let arrived = 0;
    const off = xfer.on('file.download.chunk', () => {
      arrived++;
    });
    const download = await xfer.download({ file: main('big.bin') }, { onChunk: () => new Promise(() => {}) });
    await waitFor(() => arrived >= 1, { what: 'a first chunk' });
    download.cancel();
    await expect(download.done).rejects.toMatchObject({ failure: 'cancelled' });
    const downloads = f.t.ctx.services.downloads as DownloadServiceImpl;
    await waitFor(() => downloads.activeCount() === 0, { what: 'the daemon to drop the download' });
    const settled = arrived;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(arrived).toBe(settled);
    expect(arrived).toBeLessThanOrEqual(TRANSFER_WINDOW_CHUNKS);
    off();
  });

  it('a folder is downloaded as a zip, a file is not; the root itself needs zip', async () => {
    const { xfer } = await setup({ 'a/b.txt': 'b' });
    expect(await settleError(xfer.request('file.download.begin', { file: main('a') }))).toMatchObject({ code: 'bad_request', reason: 'not-a-file' });
    expect(await settleError(xfer.request('file.download.begin', { file: main('a/b.txt'), zip: true }))).toMatchObject({ code: 'bad_request', reason: 'not-a-directory' });
    expect(await settleError(xfer.request('file.download.begin', { file: main('') }))).toMatchObject({ code: 'bad_request', reason: 'not-a-file' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R7.5
// ---------------------------------------------------------------------------------------------------------------

interface TreeFacts {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly hash?: string;
  readonly target?: string;
  readonly mode?: number;
}

/** lstat walk: rel path → facts; `.smurg` at the top is left out; FIFOs are reported separately. */
async function describeTree(root: string, skipTop: readonly string[] = []): Promise<Map<string, TreeFacts>> {
  const out = new Map<string, TreeFacts>();
  const walk = async (rel: string): Promise<void> => {
    const abs = rel === '' ? root : join(root, rel);
    for (const name of (await readdir(abs)).sort()) {
      if (rel === '' && skipTop.includes(name)) continue;
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = await lstat(join(abs, name));
      if (st.isDirectory()) {
        const children = await readdir(join(abs, name));
        if (children.length === 0) out.set(childRel, { kind: 'dir' });
        await walk(childRel);
      } else if (st.isSymbolicLink()) {
        out.set(childRel, { kind: 'symlink', target: await readlink(join(abs, name)) });
      } else if (st.isFile()) {
        out.set(childRel, { kind: 'file', hash: sha256Hex(await readFile(join(abs, name))), mode: st.mode & 0o777 });
      }
    }
  };
  await walk('');
  return out;
}

async function buildThousandFileFolder(root: string, outside: string): Promise<{ files: number; emptyDirs: string[]; excluded: string[] }> {
  let files = 0;
  const put = async (rel: string, content: string | Uint8Array, mode?: number): Promise<void> => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content, mode === undefined ? {} : { mode });
    files++;
  };
  // Special names: CJK, NFD (as macOS stores it), emoji, spaces, # and %.
  await put('中文/檔案.md', '# 中文內容\n');
  await put('café-nfd.txt', 'nfd name\n');
  await put('dir-cafe\u0301/inside.txt', 'in a directory with an NFD name\n');
  await put('emoji 😀.txt', 'emoji\n');
  await put('with space/and #hash %pct.txt', 'specials\n');
  await put('bin/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  await put('empty.txt', '');
  await put('big/random.bin', randomBytes(3 * MiB + 1234)); // incompressible, several download chunks
  await put('big/text.log', 'line of compressible text\n'.repeat(80_000)); // ~2 MiB, deflates well
  await put('big/photo.jpg', randomBytes(300_000)); // stored, not deflated
  // The bulk: nested directories of small files with random content and sizes.
  let n = 0;
  while (files < 1_000) {
    const dir = `tree/d${String(Math.floor(n / 50)).padStart(2, '0')}/s${n % 3}`;
    await put(`${dir}/f${String(n).padStart(4, '0')}.txt`, randomBytes(n % 4 === 0 ? 0 : 64 + (n % 97) * 31));
    n++;
  }
  const emptyDirs = ['empty-dir', 'tree/empty-nested/deeper', 'with space/empty too'];
  for (const dir of emptyDirs) await mkdir(join(root, dir), { recursive: true });
  // Links: one that stays inside is kept; the ones that leave are skipped; a FIFO is skipped.
  await mkdir(join(root, 'links'), { recursive: true });
  await symlink('../中文/檔案.md', join(root, 'links/inside'));
  await symlink('../../outside/secret.txt', join(root, 'links/escape'));
  await symlink(join(outside, 'secret.txt'), join(root, 'links/absolute'));
  await execFileAsync('mkfifo', [join(root, 'a-fifo')]);
  return { files, emptyDirs, excluded: ['links/escape', 'links/absolute', 'a-fifo'] };
}

describe('R7.5 下載 1,000 個檔案的資料夾，zip 內容與原始資料夾完全一致', () => {
  it('下載 1,000 個檔案的資料夾，zip 內容與原始資料夾完全一致', { timeout: 120_000 }, async () => {
    const { ft: f, xfer } = await setup({});
    const outside = join(dirname(f.t.root), 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'FAKE-SECRET-R7-5');
    const fixture = await buildThousandFileFolder(f.t.root, outside);
    expect(fixture.files).toBe(1_000);

    const work = await createTempDir('r75');
    temps.push(work);
    const zipPath = join(work, 'workspace.zip');
    const end = await downloadToFile(xfer, { file: main(''), zip: true }, zipPath);
    expect(end.totalBytes).toBe((await stat(zipPath)).size);
    expect(end.zip64).toBe(false);
    expect(end.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['a-fifo', 'special-file'],
      ['links/absolute', 'symlink-outside-folder'],
      ['links/escape', 'symlink-outside-folder'],
    ]);

    const out = join(work, 'extracted');
    await mkdir(out);
    await execFileAsync('unzip', ['-q', zipPath, '-d', out], { maxBuffer: 16 * MiB });
    const source = await describeTree(f.t.root, ['.smurg']);
    for (const excluded of fixture.excluded) source.delete(excluded);
    const extracted = await describeTree(out);
    // Every path, its type, content hash, permission bits and link target: identical.
    expect([...extracted.keys()].sort()).toEqual([...source.keys()].sort());
    for (const [rel, facts] of source) expect(extracted.get(rel), rel).toEqual(facts);
    expect([...extracted.values()].filter((v) => v.kind === 'file')).toHaveLength(1_000);
    for (const dir of fixture.emptyDirs) expect(extracted.get(dir), dir).toEqual({ kind: 'dir' });
    expect(extracted.get('bin/run.sh')?.mode).toBe(0o755);
    expect(extracted.get('links/inside')).toEqual({ kind: 'symlink', target: '../中文/檔案.md' });
    // `.smurg` is never in a workspace zip; nothing from outside the share is either.
    expect([...extracted.keys()].some((k) => k.startsWith('.smurg'))).toBe(false);
    const zipBytes = await readFile(zipPath);
    expect(zipBytes.includes(Buffer.from('FAKE-SECRET-R7-5'))).toBe(false);
  });

  it('a sub-folder zip holds that folder\'s entries; a guest\'s zip leaves hard-linked files out (they could alias files outside), the host\'s keeps them', async () => {
    const { ft: f, host, xfer } = await setup({ 'pkg/a.txt': 'a\n', 'pkg/sub/b.txt': 'b\n' });
    await link(join(f.t.root, 'pkg/a.txt'), join(f.t.root, 'pkg/a-hardlink.txt'));
    const work = await createTempDir('zipsub');
    temps.push(work);
    const guestEnd = await downloadToFile(xfer, { file: main('pkg'), zip: true }, join(work, 'guest.zip'));
    expect(guestEnd.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['a-hardlink.txt', 'hard-link'],
      ['a.txt', 'hard-link'],
    ]);
    const { stdout } = await execFileAsync('unzip', ['-Z1', join(work, 'guest.zip')]);
    expect(stdout.trim().split('\n').sort()).toEqual(['sub/b.txt']);
    const hostXfer = await host.transfer();
    const hostEnd = await downloadToFile(hostXfer, { file: main('pkg'), zip: true }, join(work, 'host.zip'));
    expect(hostEnd.skipped).toEqual([]);
    const listed = await execFileAsync('unzip', ['-Z1', join(work, 'host.zip')]);
    expect(listed.stdout.trim().split('\n').sort()).toEqual(['a-hardlink.txt', 'a.txt', 'sub/b.txt']);
    // A folder reached through a link that stays inside the share zips like the folder itself.
    await symlink('pkg/sub', join(f.t.root, 'sub-link'));
    const viaLink = await downloadToFile(hostXfer, { file: main('sub-link'), zip: true }, join(work, 'link.zip'));
    expect(viaLink.skipped).toEqual([]);
    expect((await execFileAsync('unzip', ['-Z1', join(work, 'link.zip')])).stdout.trim()).toBe('b.txt');
  });
});

describe('the host\'s private data in a zip (review SEC-D-03)', { timeout: 60_000 }, () => {
  it('a guest\'s zip leaves .git, .envrc and the host\'s personal Claude Code files out (reported as skipped); the host\'s keeps them', async () => {
    const { host, xfer } = await setup({
      'app/main.ts': 'x\n',
      'app/.envrc': 'export TOKEN=host-secret\n',
      'app/.git/config': '[remote "origin"]\n\turl = https://user:host-secret@example.com/r.git\n',
      'app/CLAUDE.local.md': 'host notes\n',
      'app/.claude/settings.local.json': '{"env":{"K":"host-secret"}}\n',
      'app/.claude/settings.json': '{}\n',
    });
    const work = await createTempDir('zippriv');
    temps.push(work);
    const guestEnd = await downloadToFile(xfer, { file: main('app'), zip: true }, join(work, 'guest.zip'));
    expect(guestEnd.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['.claude/settings.local.json', 'host-private'],
      ['.envrc', 'host-private'],
      ['.git', 'host-private'],
      ['CLAUDE.local.md', 'host-private'],
    ]);
    const { stdout } = await execFileAsync('unzip', ['-Z1', join(work, 'guest.zip')]);
    expect(stdout.trim().split('\n').sort()).toEqual(['.claude/settings.json', 'main.ts']);
    expect(stdout).not.toContain('.git');
    expect(stdout).not.toContain('.envrc');
    expect((await readFile(join(work, 'guest.zip'))).includes(Buffer.from('host-secret'))).toBe(false);
    const hostEnd = await downloadToFile(await host.transfer(), { file: main('app'), zip: true }, join(work, 'host.zip'));
    expect(hostEnd.skipped).toEqual([]);
    const listed = (await execFileAsync('unzip', ['-Z1', join(work, 'host.zip')])).stdout;
    for (const name of ['.envrc', '.git/config', 'CLAUDE.local.md', '.claude/settings.local.json']) expect(listed).toContain(name);
  });
});

describe('zip walker robustness (transfer.md verification item 4)', () => {
  it('a file that vanishes before its turn stays as a 0-byte entry and is reported; the zip is still valid', async () => {
    const { ft: f } = await setup({ 'v/a-first.bin': randomBytes(2 * MiB), 'v/b.txt': 'b\n', 'v/c.txt': 'c\n' });
    const base = await f.t.ctx.paths.resolve(main('v'), { principal: SYSTEM_PRINCIPAL, mustExist: true });
    const source = createZipSource({ paths: f.t.ctx.paths, principal: SYSTEM_PRINCIPAL, base, excludeTopSmurg: false, privileged: true });
    // Nobody reads yet: yazl is stuck behind the 2 MiB first entry while c.txt disappears.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await unlink(join(f.t.root, 'v/c.txt'));
    const parts: Buffer[] = [];
    for await (const part of source.output) parts.push(part);
    const work = await createTempDir('vanish');
    temps.push(work);
    await writeFile(join(work, 'v.zip'), Buffer.concat(parts));
    const { stdout } = await execFileAsync('unzip', ['-l', join(work, 'v.zip')]);
    expect(stdout).toMatch(/\s0\s.*c\.txt/);
    expect(source.skipped).toEqual([{ path: 'c.txt', reason: 'open:ENOENT' }]);
    await execFileAsync('unzip', ['-tq', join(work, 'v.zip')]);
  });

  it('files of 4 GiB or more go last and flag zip64 (Apple\'s extractor stops at the first ZIP64 descriptor)', async () => {
    const { ft: f } = await setup({ 'z/a-big.bin': randomBytes(2 * MiB), 'z/b.txt': 'b\n', 'z/sub/c.txt': 'c\n' });
    const base = await f.t.ctx.paths.resolve(main('z'), { principal: SYSTEM_PRINCIPAL, mustExist: true });
    // The same rule with a 1 MiB threshold instead of 4 GiB (no multi-gigabyte file in tests).
    const source = createZipSource({ paths: f.t.ctx.paths, principal: SYSTEM_PRINCIPAL, base, excludeTopSmurg: false, privileged: true, largeEntryBytes: MiB });
    const parts: Buffer[] = [];
    for await (const part of source.output) parts.push(part);
    expect(source.zip64).toBe(true);
    const work = await createTempDir('zip64');
    temps.push(work);
    await writeFile(join(work, 'z.zip'), Buffer.concat(parts));
    const { stdout } = await execFileAsync('unzip', ['-Z1', join(work, 'z.zip')]);
    expect(stdout.trim().split('\n')).toEqual(['b.txt', 'sub/c.txt', 'a-big.bin']);
  });

  it.runIf(process.platform === 'linux')('Linux: an NFD twin of an NFC name (two entries on ext4) is reported, never packed as a copy of the other one', async () => {
    const { ft: f, xfer } = await setup({ 'n/keep.txt': 'keep\n' });
    await writeFile(join(f.t.root, 'n', 'café.txt'), 'nfc\n');
    await writeFile(join(f.t.root, 'n', 'cafe\u0301.txt'), 'nfd twin\n');
    await writeFile(join(f.t.root, 'n', 'only-nfd-e\u0301.txt'), 'only nfd\n');
    const work = await createTempDir('nfdtwin');
    temps.push(work);
    const end = await downloadToFile(xfer, { file: main('n'), zip: true }, join(work, 'n.zip'));
    // Reported in the protocol's spelling (NFC, like every path on the wire): a second `café.txt` was left out.
    expect(end.skipped).toEqual([{ path: 'café.txt', reason: 'duplicate-name' }]);
    const out = join(work, 'x');
    await mkdir(out);
    await execFileAsync('unzip', ['-q', join(work, 'n.zip'), '-d', out]);
    expect((await readdir(out)).sort()).toEqual(['café.txt', 'keep.txt', 'only-nfd-e\u0301.txt'].sort());
    expect(await readFile(join(out, 'café.txt'), 'utf8')).toBe('nfc\n');
    expect(await readFile(join(out, 'only-nfd-e\u0301.txt'), 'utf8')).toBe('only nfd\n');
  });
});
