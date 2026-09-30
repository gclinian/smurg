// file.* on the interactive channel through the real router + handlers + FileService (ARCHITECTURE §5.2): tree, stat,
// create, rename, delete, read, write — permissions per role, host-only paths, locks, temp-file hiding, audit.
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import type { TestClient } from '../../src/testing/index.ts';
import { ScriptedLocks, agentLock, auditEntries, humanLock, settleError, sha256Hex, startFilesDaemon, type FilesTest } from './helpers.ts';

const execFileAsync = promisify(execFile);
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

let ft: FilesTest | null = null;

afterEach(async () => {
  await ft?.t.cleanup();
  ft = null;
});

const PROJECT = {
  'README.md': '# hello\n',
  'src/app.ts': 'export const x = 1;\n',
  'src/lib/util.ts': 'export {};\n',
  'docs/guide.md': 'guide\n',
  '.claude/settings.json': '{}\n',
  'nested/.vscode/settings.json': '{}\n',
  '.a.txt.smurg-0123456789ab.tmp': 'smurg temp\n',
  'src/app.ts.tmp.4242.0123456789ab': 'claude temp\n',
};

async function setup(options: Parameters<typeof startFilesDaemon>[0] = {}): Promise<{ ft: FilesTest; host: TestClient; amy: TestClient; vera: TestClient }> {
  ft = await startFilesDaemon({ project: { files: PROJECT }, files: { watch: false }, ...options });
  const host = await ft.t.connectHost();
  const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  const vera = await ft.t.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
  return { ft, host, amy, vera };
}

describe('file.tree / file.stat', () => {
  it('lists a directory, hides editor/agent temp files, and hides <share>/.smurg from everyone but the host', async () => {
    const { host, amy } = await setup();
    const guest = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '' });
    const names = guest.entries.map((e) => e.name);
    expect(names).toEqual(['.claude', 'docs', 'nested', 'src', 'README.md']);
    expect(guest.truncated).toBe(false);
    expect(guest.entries.find((e) => e.name === 'src')).toMatchObject({ kind: 'dir', path: 'src', size: 0 });
    expect(guest.entries.find((e) => e.name === 'README.md')).toMatchObject({ kind: 'file', path: 'README.md', size: 8 });
    // Host-only paths are marked read-only for guests (they cannot write them), not for the host.
    expect(guest.entries.find((e) => e.name === '.claude')?.readOnly).toBe(true);
    const hostTree = await host.conn.request('file.tree', { root: MAIN_ROOT, path: '' });
    expect(hostTree.entries.map((e) => e.name)).toContain('.smurg');
    expect(hostTree.entries.find((e) => e.name === '.claude')?.readOnly).toBeUndefined();
    const src = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: 'src' });
    expect(src.entries.map((e) => e.path)).toEqual(['src/lib', 'src/app.ts']);
  });

  it('does not list the host\'s private data (.git, .envrc, personal Claude Code files) to non-hosts, at any depth (review SEC-D-03)', async () => {
    const { ft: f, host, amy, vera } = await setup();
    const root = f.t.root;
    for (const rel of ['.git/config', 'sub/.git/HEAD', '.envrc', 'src/.envrc', 'CLAUDE.local.md', 'nested/CLAUDE.local.md', '.claude/settings.local.json']) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), 'host secret\n');
    }
    for (const guest of [amy, vera]) {
      const top = (await guest.conn.request('file.tree', { root: MAIN_ROOT, path: '', depth: 3 })).entries;
      const paths = top.map((e) => e.path);
      for (const hidden of ['.git', 'sub/.git', '.envrc', 'src/.envrc', 'CLAUDE.local.md', 'nested/CLAUDE.local.md', '.claude/settings.local.json']) expect(paths).not.toContain(hidden);
      expect(paths).toEqual(expect.arrayContaining(['sub', 'src/app.ts', '.claude/settings.json', 'README.md']));
      const claudeDir = (await guest.conn.request('file.tree', { root: MAIN_ROOT, path: '.claude' })).entries.map((e) => e.name);
      expect(claudeDir).toEqual(['settings.json']);
    }
    const hostTop = (await host.conn.request('file.tree', { root: MAIN_ROOT, path: '', depth: 3 })).entries.map((e) => e.path);
    expect(hostTop).toEqual(expect.arrayContaining(['.git', 'sub/.git', '.envrc', 'src/.envrc', 'CLAUDE.local.md', '.claude/settings.local.json']));
  });

  it('descends `depth` levels and sets `truncated` when the listing is cut', async () => {
    const { amy } = await setup({ files: { watch: false, treeMaxEntries: 4 } });
    const deep = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: 'src', depth: 2 });
    expect(deep.entries.map((e) => e.path)).toEqual(['src/lib', 'src/app.ts', 'src/lib/util.ts']);
    const cut = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '', depth: 3 });
    expect(cut.entries).toHaveLength(4);
    expect(cut.truncated).toBe(true);
  });

  it('reports symlinks as links (never following them) and leaves special files out', async () => {
    const { ft: f, amy } = await setup();
    await symlink('README.md', join(f.t.root, 'readme-link'));
    await execFileAsync('mkfifo', [join(f.t.root, 'a-fifo')]);
    const tree = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '' });
    expect(tree.entries.find((e) => e.name === 'readme-link')).toMatchObject({ kind: 'symlink' });
    expect(tree.entries.map((e) => e.name)).not.toContain('a-fifo');
    const entry = await amy.conn.request('file.stat', main('readme-link'));
    expect(entry.entry.kind).toBe('symlink');
    const error = await settleError(amy.conn.request('file.tree', { root: MAIN_ROOT, path: 'README.md' }));
    expect(error).toMatchObject({ code: 'bad_request', reason: 'not-a-directory' });
  });

  it('stat of the root, a file and a missing path', async () => {
    const { amy } = await setup();
    expect((await amy.conn.request('file.stat', main(''))).entry).toMatchObject({ name: '', path: '', kind: 'dir' });
    const readme = (await amy.conn.request('file.stat', main('README.md'))).entry;
    expect(readme).toMatchObject({ name: 'README.md', path: 'README.md', kind: 'file', size: 8 });
    expect(Number.isInteger(readme.mtime)).toBe(true);
    expect(await settleError(amy.conn.request('file.stat', main('nope.txt')))).toMatchObject({ code: 'not_found' });
  });

  it('FileEntry carries the lock and the last modifier when there are any', async () => {
    const locks = new ScriptedLocks();
    const { amy } = await setup({ locks });
    locks.set(humanLock(main('README.md'), 'Bob'));
    await amy.conn.request('file.write', { file: main('docs/guide.md'), content: utf8('updated by Amy\n') });
    const tree = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '', depth: 2 });
    expect(tree.entries.find((e) => e.path === 'README.md')?.lock).toMatchObject({ kind: 'human', holders: [{ displayName: 'Bob' }] });
    expect(tree.entries.find((e) => e.path === 'docs/guide.md')?.lastModifiedBy).toEqual({ kind: 'user', userId: 'dev:amy', displayName: 'Amy' });
    expect((await amy.conn.request('file.stat', main('docs/guide.md'))).entry.lastModifiedBy).toMatchObject({ userId: 'dev:amy' });
  });
});

describe('file.tree over a tree deeper than PATH_MAX (review REL-13)', () => {
  it('lists what it can: an entry or a sub-directory the OS cannot look at is left out, never the whole listing', async () => {
    const { ft: f, amy } = await setup();
    const seg = 'd'.repeat(100);
    // 12 levels of 100-byte names (> 1,200 bytes), built with relative mkdir as a shell does.
    await execFileAsync('/bin/sh', ['-c', `mkdir -p "$1" && cd "$1" && for i in 1 2 3 4 5 6 7 8 9 10 11 12; do mkdir ${seg} && cd ${seg}; done && echo deep > leaf.txt`, 'sh', join(f.t.root, 'deep')]);
    try {
      await deepTreeChecks(f, amy, seg);
    } finally {
      // Node's recursive rm cannot remove paths beyond PATH_MAX; rm(1) walks relative to each directory.
      await execFileAsync('/bin/rm', ['-rf', join(f.t.root, 'deep')]);
    }
  });
});

async function deepTreeChecks(f: FilesTest, amy: TestClient, seg: string): Promise<void> {
  {
    // The root, 20 levels deep: everything up to the limit, and the rest of the share.
    const whole = await amy.conn.request('file.tree', { root: MAIN_ROOT, path: '', depth: 20 });
    expect(whole.entries.map((e) => e.path)).toEqual(expect.arrayContaining(['README.md', 'deep', `deep/${seg}`]));
    // Folder by folder, as the explorer opens it: every level that the OS can open lists (the too-long entry is out).
    let path = 'deep';
    let listed = 0;
    for (let level = 1; level <= 12; level++) {
      const absolute = Buffer.byteLength(join(f.t.root, path));
      const result = await settleError(amy.conn.request('file.tree', { root: MAIN_ROOT, path, depth: 1 }));
      if (absolute < 1024) {
        expect(result, `level ${level}`).toBeNull();
        listed++;
      } else {
        // The folder itself is out of reach: a clear refusal, not 主人端發生內部錯誤.
        expect(result?.code, `level ${level}`).not.toBe('internal');
        break;
      }
      path = `${path}/${seg}`;
    }
    expect(listed).toBeGreaterThanOrEqual(8);
  }
}

describe('file.read / file.write', () => {
  it('reads content with its SHA-256; maxBytes truncates; a directory is not a file', async () => {
    const { amy, vera } = await setup();
    const read = await vera.conn.request('file.read', { file: main('README.md') });
    expect(new TextDecoder().decode(read.content)).toBe('# hello\n');
    expect(read.hash).toBe(sha256Hex(utf8('# hello\n')));
    expect(read.truncated).toBe(false);
    const part = await amy.conn.request('file.read', { file: main('README.md'), maxBytes: 3 });
    expect(new TextDecoder().decode(part.content)).toBe('# h');
    expect(part.truncated).toBe(true);
    expect(await settleError(amy.conn.request('file.read', { file: main('src') }))).toMatchObject({ code: 'bad_request', reason: 'not-a-file' });
  });

  it('writes atomically, keeps the mode of the file it replaces, and audits the writer', async () => {
    const { ft: f, amy } = await setup();
    await chmod(join(f.t.root, 'src/app.ts'), 0o755);
    const result = await amy.conn.request('file.write', { file: main('src/app.ts'), content: utf8('export const x = 2;\n') });
    expect(result.hash).toBe(sha256Hex(utf8('export const x = 2;\n')));
    expect(result.entry).toMatchObject({ path: 'src/app.ts', kind: 'file', size: 20, lastModifiedBy: { userId: 'dev:amy' } });
    expect(await readFile(join(f.t.root, 'src/app.ts'), 'utf8')).toBe('export const x = 2;\n');
    expect((await stat(join(f.t.root, 'src/app.ts'))).mode & 0o777).toBe(0o755);
    // No temp file left behind.
    expect((await readdir(join(f.t.root, 'src'))).filter((n) => n.includes('smurg-'))).toEqual([]);
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.write');
    expect(audit.at(-1)).toMatchObject({ outcome: 'ok', target: 'main:src/app.ts', actor: { kind: 'user', userId: 'dev:amy' } });
  });

  it('ifMatchHash: a write based on a stale read is refused with conflict', async () => {
    const { ft: f, amy } = await setup();
    const read = await amy.conn.request('file.read', { file: main('README.md') });
    await writeFile(join(f.t.root, 'README.md'), 'changed on disk\n');
    const stale = await settleError(amy.conn.request('file.write', { file: main('README.md'), content: utf8('mine\n'), ifMatchHash: read.hash }));
    expect(stale).toMatchObject({ code: 'conflict', reason: 'changed-since-read' });
    expect(await readFile(join(f.t.root, 'README.md'), 'utf8')).toBe('changed on disk\n');
    const fresh = await amy.conn.request('file.read', { file: main('README.md') });
    await amy.conn.request('file.write', { file: main('README.md'), content: utf8('mine\n'), ifMatchHash: fresh.hash });
    expect(await readFile(join(f.t.root, 'README.md'), 'utf8')).toBe('mine\n');
  });

  it('writes are refused with `locked` while the file has any lock (human or agent), naming the holder', async () => {
    const locks = new ScriptedLocks();
    const { ft: f, amy, host } = await setup({ locks });
    locks.set(humanLock(main('README.md'), 'Bob'));
    locks.set(agentLock(main('src/app.ts'), 'Ian'));
    const human = await settleError(amy.conn.request('file.write', { file: main('README.md'), content: utf8('x') }));
    expect(human?.code).toBe('locked');
    expect(human?.detail?.['lock']).toMatchObject({ kind: 'human', holders: [{ displayName: 'Bob' }] });
    const agent = await settleError(host.conn.request('file.write', { file: main('src/app.ts'), content: utf8('x') }));
    expect(agent?.code).toBe('locked');
    expect(agent?.message).toContain('Claude（Ian）');
    // A different spelling of the same file on a case-insensitive disk is the same locked file.
    const probe = await lstat(join(f.t.root, 'readme.md')).catch(() => null);
    if (probe !== null) expect((await settleError(amy.conn.request('file.write', { file: main('readme.md'), content: utf8('x') })))?.code).toBe('locked');
    // Deleting or renaming a directory that contains a locked file is refused too.
    expect((await settleError(amy.conn.request('file.delete', { file: main('src') })))?.code).toBe('locked');
    expect((await settleError(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'src', to: 'source' })))?.code).toBe('locked');
    expect(await readFile(join(f.t.root, 'README.md'), 'utf8')).toBe('# hello\n');
  });

  it('a viewer cannot write, create, rename or delete (forbidden, audited as authz.denied)', async () => {
    const { ft: f, vera } = await setup();
    for (const [type, payload] of [
      ['file.write', { file: main('README.md'), content: utf8('defaced') }],
      ['file.create', { file: main('new.txt'), kind: 'file' }],
      ['file.rename', { root: MAIN_ROOT, from: 'README.md', to: 'x.md' }],
      ['file.delete', { file: main('README.md') }],
    ] as const) {
      const error = await settleError(vera.conn.request(type as 'file.write', payload as never));
      expect(error?.code, type).toBe('forbidden');
    }
    expect(await readFile(join(f.t.root, 'README.md'), 'utf8')).toBe('# hello\n');
    const denied = await auditEntries(f.t.ctx, (e) => e.action === 'authz.denied' && e.actor.kind === 'user' && e.actor.userId === 'dev:vera');
    expect(denied.map((e) => e.target)).toEqual(['file.write', 'file.create', 'file.rename', 'file.delete']);
  });

  it('an editor cannot write host-only paths (at any depth, any spelling); the host can', async () => {
    const { ft: f, amy, host } = await setup();
    for (const path of ['.claude/settings.json', '.CLAUDE/settings.local.json', 'nested/.vscode/settings.json', '.mcp.json', 'sub/.envrc', '.git/config']) {
      const error = await settleError(amy.conn.request('file.write', { file: main(path), content: utf8('{"hooks":{}}') }));
      expect(error?.code, path).toBe('host_only');
    }
    expect((await settleError(amy.conn.request('file.create', { file: main('.claude/agents'), kind: 'dir' })))?.code).toBe('host_only');
    expect((await settleError(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'README.md', to: '.claude/README.md' })))?.code).toBe('host_only');
    expect((await settleError(amy.conn.request('file.delete', { file: main('.claude/settings.json') })))?.code).toBe('host_only');
    expect(await readFile(join(f.t.root, '.claude/settings.json'), 'utf8')).toBe('{}\n');
    const denials = await auditEntries(f.t.ctx, (e) => e.action === 'path.denied' && e.actor.kind === 'user' && e.actor.userId === 'dev:amy');
    expect(denials.length).toBeGreaterThanOrEqual(9);
    expect(denials.every((e) => e.detail?.['reason'] === 'host-only')).toBe(true);
    await host.conn.request('file.write', { file: main('.claude/settings.json'), content: utf8('{"host":true}\n') });
    expect(await readFile(join(f.t.root, '.claude/settings.json'), 'utf8')).toBe('{"host":true}\n');
  });

  it('a write into a missing directory is refused (the parent must exist)', async () => {
    const { amy } = await setup();
    expect(await settleError(amy.conn.request('file.write', { file: main('no/such/dir.txt'), content: utf8('x') }))).toMatchObject({ code: 'not_found' });
  });
});

describe('file.create / file.rename / file.delete', () => {
  it('creates files and directories without replacing anything', async () => {
    const { ft: f, amy } = await setup();
    const file = await amy.conn.request('file.create', { file: main('src/new.ts'), kind: 'file' });
    expect(file.entry).toMatchObject({ path: 'src/new.ts', kind: 'file', size: 0 });
    const dir = await amy.conn.request('file.create', { file: main('assets'), kind: 'dir' });
    expect(dir.entry).toMatchObject({ path: 'assets', kind: 'dir' });
    expect((await lstat(join(f.t.root, 'assets'))).isDirectory()).toBe(true);
    expect(await settleError(amy.conn.request('file.create', { file: main('README.md'), kind: 'file' }))).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect(await settleError(amy.conn.request('file.create', { file: main('src'), kind: 'dir' }))).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect(await readFile(join(f.t.root, 'README.md'), 'utf8')).toBe('# hello\n');
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.create');
    expect(audit.map((e) => [e.target, e.detail?.['kind']])).toEqual([
      ['main:src/new.ts', 'file'],
      ['main:assets', 'dir'],
    ]);
  });

  it('renames files and directories, never over an existing entry, never a directory into itself', async () => {
    const { ft: f, amy } = await setup();
    const renamed = await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'docs/guide.md', to: 'docs/manual.md' });
    expect(renamed.entry).toMatchObject({ path: 'docs/manual.md', kind: 'file' });
    expect(await readFile(join(f.t.root, 'docs/manual.md'), 'utf8')).toBe('guide\n');
    await expect(lstat(join(f.t.root, 'docs/guide.md'))).rejects.toThrow();
    // The renamed file has one link again (the no-clobber move uses link + unlink).
    expect((await lstat(join(f.t.root, 'docs/manual.md'))).nlink).toBe(1);
    await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'src', to: 'source' });
    expect(await readFile(join(f.t.root, 'source/lib/util.ts'), 'utf8')).toBe('export {};\n');
    expect(await settleError(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'README.md', to: 'docs/manual.md' }))).toMatchObject({ code: 'conflict', reason: 'exists' });
    expect(await settleError(amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'source', to: 'source/lib/inner' }))).toMatchObject({ code: 'bad_request', reason: 'into-itself' });
    expect(await readFile(join(f.t.root, 'docs/manual.md'), 'utf8')).toBe('guide\n');
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.rename');
    expect(audit.map((e) => [e.detail?.['from'], e.detail?.['to']])).toEqual([
      ['docs/guide.md', 'docs/manual.md'],
      ['src', 'source'],
    ]);
    // WEB-16: an ordinary rename records no security refusal (the move's own second link is not a 'hard-link' denial).
    expect(await auditEntries(f.t.ctx, (e) => e.action === 'path.denied')).toEqual([]);
  });

  it('a case-only rename works on a case-insensitive disk', async (ctx) => {
    const { ft: f, amy } = await setup();
    ctx.skip((await lstat(join(f.t.root, 'readme.md')).catch(() => null)) === null, 'the temp dir is on a case-sensitive file system');
    await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'README.md', to: 'readme.md' });
    expect(await readdir(f.t.root)).toContain('readme.md');
  });

  it('deletes files and whole trees; a link inside a deleted tree is removed, never followed', async () => {
    const { ft: f, amy } = await setup();
    const outside = join(dirname(f.t.root), 'outside-keep');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'precious.txt'), 'do not delete\n');
    await symlink(outside, join(f.t.root, 'src/lib/escape'));
    await amy.conn.request('file.delete', { file: main('README.md') });
    await expect(lstat(join(f.t.root, 'README.md'))).rejects.toThrow();
    await amy.conn.request('file.delete', { file: main('src') });
    await expect(lstat(join(f.t.root, 'src'))).rejects.toThrow();
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('do not delete\n');
    // The trash holds nothing afterwards.
    expect(await readdir(join(f.t.root, '.smurg/trash'))).toEqual([]);
    expect(await settleError(amy.conn.request('file.delete', { file: main('README.md') }))).toMatchObject({ code: 'not_found' });
    const audit = await auditEntries(f.t.ctx, (e) => e.action === 'file.delete');
    expect(audit.map((e) => [e.target, e.detail?.['kind']])).toEqual([
      ['main:README.md', 'file'],
      ['main:src', 'dir'],
    ]);
  });

  it('the daemon-owned .smurg directories cannot be moved or deleted, not even by the host', async () => {
    const { ft: f, host } = await setup();
    for (const path of ['.smurg', '.smurg/trash', '.smurg/uploads/x.part', '.smurg/worktrees']) {
      const error = await settleError(host.conn.request('file.delete', { file: main(path) }));
      expect(error, path).toMatchObject({ code: 'forbidden', reason: 'daemon-owned' });
    }
    expect((await lstat(join(f.t.root, '.smurg'))).isDirectory()).toBe(true);
  });

  it('entryFor() describes an existing entry for other modules, null otherwise', async () => {
    const { ft: f } = await setup();
    const files = f.t.ctx.services.files;
    expect(await files.entryFor(main('README.md'))).toMatchObject({ kind: 'file', size: 8 });
    expect(await files.entryFor(main('missing'))).toBeNull();
    files.expectChange(main('README.md'), SYSTEM_PRINCIPAL.actor);
    expect(files.lastModifiedBy(main('README.md'))).toBeNull();
  });
});

describe('worktree roots and shared read-only directories (D12)', () => {
  it('a shared directory linked into a worktree can be read there but never written, created in, renamed or deleted', async () => {
    const { ft: f, amy } = await setup();
    await mkdir(join(f.t.root, 'data'), { recursive: true });
    await writeFile(join(f.t.root, 'data/table.csv'), 'a,b\n');
    const id = 'wt_files_readonly';
    const dir = join(f.t.root, '.smurg/worktrees', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'own.txt'), 'mine\n');
    await symlink(join(f.t.root, 'data'), join(dir, 'data'));
    await f.t.ctx.roots.registerWorktree({ worktreeId: id, dir, ownerUserId: 'dev:amy', sharedLinks: [{ path: 'data', mainPath: 'data' }] });
    const wt = { kind: 'worktree' as const, worktreeId: id };
    const tree = await amy.conn.request('file.tree', { root: wt, path: '' });
    expect(tree.entries.find((e) => e.name === 'data')).toMatchObject({ kind: 'symlink', readOnly: true });
    const inside = await amy.conn.request('file.tree', { root: wt, path: 'data' });
    expect(inside.entries.map((e) => [e.path, e.readOnly])).toEqual([['data/table.csv', true]]);
    expect(new TextDecoder().decode((await amy.conn.request('file.read', { file: { root: wt, path: 'data/table.csv' } })).content)).toBe('a,b\n');
    for (const attempt of [
      () => amy.conn.request('file.write', { file: { root: wt, path: 'data/table.csv' }, content: utf8('x') }),
      () => amy.conn.request('file.create', { file: { root: wt, path: 'data/new.csv' }, kind: 'file' }),
      () => amy.conn.request('file.rename', { root: wt, from: 'data/table.csv', to: 'data/t.csv' }),
      () => amy.conn.request('file.delete', { file: { root: wt, path: 'data/table.csv' } }),
    ]) {
      expect(await settleError(attempt())).toMatchObject({ code: 'path_denied', reason: 'read-only' });
    }
    // The worktree's own files are writable.
    await amy.conn.request('file.write', { file: { root: wt, path: 'own.txt' }, content: utf8('changed\n') });
    expect(await readFile(join(dir, 'own.txt'), 'utf8')).toBe('changed\n');
    expect(await readFile(join(f.t.root, 'data/table.csv'), 'utf8')).toBe('a,b\n');
  });
});

