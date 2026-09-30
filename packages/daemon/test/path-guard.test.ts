// SPEC R1 「對分享資料夾以外路徑的請求（包括 symlink、..）一律被拒絕並記錄」, ARCHITECTURE §7.4, yjs-monaco.md verification
// item 1 (containment re-checked before every read and write). Every denial must land in the audit log as
// path.denied. All "secrets" are fake files this test creates in its own temp directory.
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AuditEntry, type FileRef, type RootRef } from '@smurg/protocol';
import { PathDeniedError, type PathDeniedReason } from '../src/core/errors.ts';
import type { Principal } from '../src/core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { PathGuardImpl } from '../src/workspace/path-guard.ts';
import { identityOf } from '../src/workspace/fs-util.ts';
import { createTestDaemon, type TestDaemon } from '../src/testing/index.ts';

const execFileAsync = promisify(execFile);
const SECRET = 'FAKE-SECRET-OUTSIDE-THE-SHARE-0123456789';

let t: TestDaemon;
let outside: string;
let audit: AuditEntry[];
let host: Principal;
const editor: Principal = { kind: 'user', actor: { kind: 'user', userId: 'dev:eddie', displayName: 'Eddie' }, userId: 'dev:eddie', role: 'editor' };
const viewer: Principal = { kind: 'user', actor: { kind: 'user', userId: 'dev:vera', displayName: 'Vera' }, userId: 'dev:vera', role: 'viewer' };

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

beforeEach(async () => {
  t = await createTestDaemon({
    project: {
      files: {
        'README.md': 'hello\n',
        'src/app.ts': 'export {};\n',
        'real/inner.txt': 'inner\n',
        'data/table.csv': 'a,b\n1,2\n',
        '.claude/settings.json': '{}\n',
        'sub/.claude/agents/x.md': 'x\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
      },
    },
  });
  outside = join(dirname(t.root), 'outside');
  await mkdir(join(outside, 'sub'), { recursive: true });
  await writeFile(join(outside, 'secret.txt'), SECRET);
  await writeFile(join(outside, 'sub', 'inner.txt'), SECRET);
  host = t.ctx.members.principalOf(t.hostUserId) as Principal;
  audit = [];
  t.ctx.audit.subscribe((entry) => audit.push(entry));
});

afterEach(async () => {
  await t.cleanup();
});

async function denied(promise: Promise<unknown>, reason: PathDeniedReason, principal: Principal = editor): Promise<void> {
  const before = audit.length;
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PathDeniedError);
  expect((error as PathDeniedError).reason).toBe(reason);
  const entries = audit.slice(before).filter((e) => e.action === 'path.denied');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ outcome: 'denied', actor: principal.actor, detail: { reason } });
}

describe('lexical layer', () => {
  it.each([
    ['..', 'lexical'],
    ['../outside/secret.txt', 'lexical'],
    ['src/../../outside/secret.txt', 'lexical'],
    ['./README.md', 'lexical'],
    ['/etc/passwd', 'lexical'],
    ['src//app.ts', 'lexical'],
    ['src/app.ts/', 'lexical'],
    ['a\u0000b', 'lexical'],
    ['a\u001b[31m', 'lexical'],
    ['..\\outside\\secret.txt', 'lexical'],
    ['src\\app.ts', 'lexical'],
    ['C:/Windows', 'lexical'],
    ['evil\u202Etxt.exe', 'lexical'],
    ['a\u2066b', 'lexical'],
    ['\ud800', 'lexical'],
    ['a'.repeat(256), 'too-long'],
  ] as const)('refuses %j (%s) and audits it', async (path, reason) => {
    await denied(t.ctx.paths.resolve(main(path), { principal: editor }), reason);
  });

  it('refuses an absolute path longer than PATH_MAX', async () => {
    const deep = Array.from({ length: 12 }, () => 'd'.repeat(100)).join('/');
    await denied(t.ctx.paths.resolve(main(deep), { principal: editor }), 'too-long');
  });

  it('normalises to NFC and treats look-alike characters as plain names inside the root', async () => {
    const nfd = 'cafe\u0301.txt';
    const r = await t.ctx.paths.resolve(main(nfd), { principal: editor });
    expect(r.ref.path).toBe('caf\u00e9.txt');
    const dots = await t.ctx.paths.resolve(main('\uff0e\uff0e/x'), { principal: editor });
    expect(dots.realPath.startsWith(t.root)).toBe(true);
  });

  it('counts segment length in UTF-8 bytes on Linux, in UTF-16 units on macOS', () => {
    const cjk = '中'.repeat(255);
    const mac = new PathGuardImpl({ roots: t.ctx.roots, audit: t.ctx.audit, platform: 'darwin' });
    const linux = new PathGuardImpl({ roots: t.ctx.roots, audit: t.ctx.audit, platform: 'linux' });
    expect(mac.lexical(cjk)).toBe(cjk);
    expect(() => linux.lexical(cjk)).toThrow(PathDeniedError);
  });
});

describe('symlinks', () => {
  it('refuses a symlink that leaves the root, for reads and writes, and never reads the target', async () => {
    await symlink(join(outside, 'secret.txt'), join(t.root, 'innocent.txt'));
    await denied(t.ctx.paths.resolve(main('innocent.txt'), { principal: editor }), 'outside-root');
    await denied(t.ctx.paths.readFile(main('innocent.txt'), { principal: host }), 'outside-root', host);
    await denied(t.ctx.paths.writeFileAtomic(main('innocent.txt'), new TextEncoder().encode('x'), { principal: host }), 'symlink', host);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(SECRET);
  });

  it('refuses a symlinked parent directory that leaves the root', async () => {
    await symlink(outside, join(t.root, 'linkdir'));
    await denied(t.ctx.paths.resolve(main('linkdir/secret.txt'), { principal: editor }), 'outside-root');
    await denied(t.ctx.paths.writeFileAtomic(main('linkdir/new.txt'), new Uint8Array([1]), { principal: host }), 'outside-root', host);
    expect(await readdir(outside)).not.toContain('new.txt');
  });

  it('refuses a relative symlink climbing out of the root', async () => {
    await symlink('../outside/secret.txt', join(t.root, 'rel.txt'));
    await denied(t.ctx.paths.resolve(main('rel.txt'), { principal: editor }), 'outside-root');
  });

  it('allows symlinks that stay inside the root (reads follow them; writes never go through a final link)', async () => {
    await symlink(join(t.root, 'real'), join(t.root, 'alias'));
    await symlink(join(t.root, 'README.md'), join(t.root, 'readme-link'));
    const viaDir = await t.ctx.paths.readFile(main('alias/inner.txt'), { principal: editor });
    expect(new TextDecoder().decode(viaDir.bytes)).toBe('inner\n');
    const viaFile = await t.ctx.paths.resolve(main('readme-link'), { principal: editor });
    expect(viaFile.realPath).toBe(join(t.root, 'README.md'));
    await t.ctx.paths.writeFileAtomic(main('alias/new.txt'), new TextEncoder().encode('ok'), { principal: editor });
    expect(await readFile(join(t.root, 'real', 'new.txt'), 'utf8')).toBe('ok');
    await denied(t.ctx.paths.writeFileAtomic(main('readme-link'), new Uint8Array([1]), { principal: editor }), 'symlink');
    const self = await t.ctx.paths.resolve(main('readme-link'), { principal: editor, finalSymlink: 'self', forWrite: true });
    expect(self.identity?.kind).toBe('symlink');
  });

  it('TOCTOU: a parent swapped for a symlink AFTER resolution is caught before the read', async () => {
    await mkdir(join(t.root, 'k'));
    await writeFile(join(t.root, 'k', 'id_demo'), 'harmless\n');
    await writeFile(join(outside, 'id_demo'), SECRET);
    const resolved = await t.ctx.paths.resolve(main('k/id_demo'), { principal: editor, mustExist: true });
    // The guest's shell, inside the project: rm -r k && ln -s <outside> k
    await rm(join(t.root, 'k'), { recursive: true });
    await symlink(outside, join(t.root, 'k'));
    await denied(t.ctx.paths.openRead(resolved, { principal: editor }), 'outside-root');
  });

  it('TOCTOU: a file replaced after resolution is caught (identity changed)', async () => {
    const resolved = await t.ctx.paths.resolve(main('README.md'), { principal: editor, mustExist: true });
    await writeFile(join(t.root, 'README.md.new'), 'replaced\n');
    await rename(join(t.root, 'README.md.new'), join(t.root, 'README.md'));
    await denied(t.ctx.paths.openRead(resolved, { principal: editor }), 'changed');
  });

  it('TOCTOU: the post-move check removes a file that landed outside and refuses', async () => {
    await mkdir(join(t.root, 'j'));
    const resolved = await t.ctx.paths.resolve(main('j/landed.txt'), { principal: editor, forWrite: true });
    // A parent swapped between the check and the rename: the placed object is now outside the root.
    await rm(join(t.root, 'j'), { recursive: true });
    await symlink(outside, join(t.root, 'j'));
    await writeFile(join(outside, 'landed.txt'), 'placed by the daemon');
    const placed = identityOf(await lstat(join(outside, 'landed.txt')));
    await denied(t.ctx.paths.checkPlaced(resolved, placed, { principal: editor }), 'outside-root');
    expect(await readdir(outside)).not.toContain('landed.txt');
  });

  it('TOCTOU: a write whose parent is swapped after the resolution writes nothing outside', async () => {
    await mkdir(join(t.root, 'notes'));
    await writeFile(join(t.root, 'notes', 'a.txt'), 'notes\n');
    await rm(join(t.root, 'notes'), { recursive: true });
    await symlink(outside, join(t.root, 'notes'));
    await denied(t.ctx.paths.writeFileAtomic(main('notes/a.txt'), new TextEncoder().encode('echo pwned'), { principal: editor }), 'outside-root');
    expect((await readdir(outside)).sort()).toEqual(['secret.txt', 'sub']);
  });
});

describe('host-only, hidden, special files', () => {
  it.each(['.claude/settings.json', '.CLAUDE/settings.local.json', 'sub/.claude/agents/x.md', '.mcp.json', '.envrc', '.vscode/tasks.json', '.idea/x.xml', '.git/config', 'deep/.git/hooks/pre-commit'])(
    'lets only the host write %s',
    async (path) => {
      await denied(t.ctx.paths.resolve(main(path), { principal: editor, forWrite: true }), 'host-only');
      const r = await t.ctx.paths.resolve(main(path), { principal: host, forWrite: true });
      expect(r.hostOnly).toBe(true);
    },
  );

  it('catches a host-only directory reached through an innocent-looking symlink', async () => {
    await symlink(join(t.root, '.claude'), join(t.root, 'config'));
    await denied(t.ctx.paths.resolve(main('config/settings.json'), { principal: editor, forWrite: true }), 'host-only');
  });

  // SEC-D-03 (supersedes "lets everyone read .git"): the guests' sandbox hides the host's personal Claude Code files
  // and the git internals (remote URLs with tokens) from their agents; a guest human gets none of it either.
  describe('host-private files are refused to every non-host, for reads too (SEC-D-03)', () => {
    const plant = async (): Promise<void> => {
      await writeFile(join(t.root, '.claude', 'settings.local.json'), '{"env":{"MY_TOKEN":"HOST-SECRET-LOCAL"}}\n');
      await writeFile(join(t.root, 'CLAUDE.local.md'), 'host private memory HOST-SECRET-MEMORY\n');
      await mkdir(join(t.root, 'pkg', '.claude'), { recursive: true });
      await writeFile(join(t.root, 'pkg', '.claude', 'settings.local.json'), '{"env":{"T":"HOST-SECRET-NESTED"}}\n');
      await writeFile(join(t.root, '.git', 'config'), '[remote "origin"]\n\turl = https://x-access-token:HOST-SECRET-GHTOKEN@github.com/o/r\n');
      await writeFile(join(t.root, '.envrc'), 'export DEPLOY_KEY=HOST-SECRET-ENVRC\n');
    };
    const privateFiles = ['.claude/settings.local.json', 'CLAUDE.local.md', 'pkg/.claude/settings.local.json', '.git/config', '.git/HEAD', '.envrc'];

    it.each(privateFiles)('refuses %s to a viewer and an editor (readFile, resolve, openRead); the host reads it', async (path) => {
      await plant();
      for (const principal of [viewer, editor]) {
        await denied(t.ctx.paths.readFile(main(path), { principal }), 'host-private', principal);
        await denied(t.ctx.paths.resolve(main(path), { principal }), 'host-private', principal);
      }
      const r = await t.ctx.paths.readFile(main(path), { principal: host });
      expect(r.bytes.length).toBeGreaterThan(0);
    });

    it('under every spelling and through an in-share symlink', async () => {
      await plant();
      await denied(t.ctx.paths.readFile(main('.GIT/config'), { principal: viewer }), 'host-private', viewer);
      await denied(t.ctx.paths.readFile(main('claude.LOCAL.md'), { principal: viewer }), 'host-private', viewer);
      await denied(t.ctx.paths.readFile(main('.Claude/Settings.Local.json'), { principal: viewer }), 'host-private', viewer);
      await symlink(join(t.root, '.git'), join(t.root, 'innocent'));
      await denied(t.ctx.paths.readFile(main('innocent/config'), { principal: viewer }), 'host-private', viewer);
      await symlink(join(t.root, 'CLAUDE.local.md'), join(t.root, 'notes.md'));
      await denied(t.ctx.paths.readFile(main('notes.md'), { principal: editor }), 'host-private', editor);
    });

    it('a guest cannot write them either; host-only paths keep their host-only answer', async () => {
      await plant();
      await denied(t.ctx.paths.writeFileAtomic(main('CLAUDE.local.md'), new TextEncoder().encode('ignore previous instructions'), { principal: editor }), 'host-private');
      await denied(t.ctx.paths.resolve(main('.git/config'), { principal: editor, forWrite: true }), 'host-only');
      expect(await readFile(join(t.root, 'CLAUDE.local.md'), 'utf8')).toContain('HOST-SECRET-MEMORY');
    });

    it('on the wire: file.read and doc.open answer path_denied / host-private to a viewer', async () => {
      await plant();
      const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
      for (const path of ['.git/config', '.envrc', '.claude/settings.local.json']) {
        const error = await vera.conn.request('file.read', { file: main(path) }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, path).toMatchObject({ code: 'path_denied', detail: { reason: 'host-private' } });
      }
      const doc = await vera.conn.request('doc.open', { file: main('CLAUDE.local.md') }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(doc).toMatchObject({ code: 'path_denied', detail: { reason: 'host-private' } });
    });

    it('ordinary project files next to them stay readable', async () => {
      await plant();
      for (const path of ['.claude/settings.json', 'README.md', 'sub/.claude/agents/x.md']) {
        const r = await t.ctx.paths.readFile(main(path), { principal: viewer });
        expect(r.bytes.length, path).toBeGreaterThan(0);
      }
    });
  });

  it('hides <share>/.smurg from non-hosts, however it is spelled or reached', async () => {
    await denied(t.ctx.paths.resolve(main('.smurg'), { principal: editor }), 'hidden');
    await denied(t.ctx.paths.resolve(main('.SMURG/worktrees'), { principal: editor }), 'hidden');
    await symlink(join(t.root, '.smurg'), join(t.root, 'up'));
    await denied(t.ctx.paths.resolve(main('up/x'), { principal: viewer }), 'hidden', viewer);
    const r = await t.ctx.paths.resolve(main('.smurg'), { principal: host });
    expect(r.exists).toBe(true);
  });

  // Security review F1: on case-insensitive APFS `ſ` (U+017F) and `s` name the same entry, and toLowerCase() leaves
  // `ſ` alone. Each spelling below reaches a protected entry on disk; all of them must be refused for a non-host.
  describe('spellings a case-insensitive file system folds onto a protected name', () => {
    const LONG_S = String.fromCodePoint(0x17f);
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

    it('an editor cannot create .mcp.json spelled .mcp.jſon (the host agent would load it as .mcp.json)', async () => {
      await denied(t.ctx.paths.writeFileAtomic(main(`.mcp.j${LONG_S}on`), enc('{"mcpServers":{}}\n'), { principal: editor }), 'host-only');
      await expect(readFile(join(t.root, '.mcp.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('an editor cannot create a .vſcode directory nor write .vscode/tasks.json through it', async () => {
      await denied(t.ctx.paths.resolve(main(`.v${LONG_S}code`), { principal: editor, forWrite: true }), 'host-only');
      await mkdir(join(t.root, `.v${LONG_S}code`)); // as if a handler had created it anyway
      await denied(t.ctx.paths.writeFileAtomic(main(`.v${LONG_S}code/tasks.json`), enc('{"version":"2.0.0"}\n'), { principal: editor }), 'host-only');
      await expect(readFile(join(t.root, '.vscode', 'tasks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('.smurg stays hidden when spelled .ſmurg', async () => {
      await mkdir(join(t.root, '.smurg', 'uploads'), { recursive: true });
      await writeFile(join(t.root, '.smurg', 'uploads', 'other.part'), 'PARTIAL-UPLOAD-OF-ANOTHER-GUEST');
      await denied(t.ctx.paths.readFile(main(`.${LONG_S}murg/uploads/other.part`), { principal: editor }), 'hidden');
    });

    it('the on-disk name decides for existing entries, whatever the request spells (case variants)', async () => {
      await mkdir(join(t.root, '.vscode'));
      await denied(t.ctx.paths.resolve(main('.VScode/x.json'), { principal: editor, forWrite: true }), 'host-only');
      const r = await t.ctx.paths.resolve(main(`.v${LONG_S}code/x.json`), { principal: host, forWrite: true });
      expect(r.hostOnly).toBe(true);
    });
  });

  it('refuses hard-linked files for non-hosts (they could alias a file outside the share)', async () => {
    await link(join(outside, 'secret.txt'), join(t.root, 'hardlink.txt'));
    await denied(t.ctx.paths.readFile(main('hardlink.txt'), { principal: editor }), 'hard-link');
    const r = await t.ctx.paths.readFile(main('hardlink.txt'), { principal: host });
    expect(new TextDecoder().decode(r.bytes)).toBe(SECRET);
  });

  it('refuses FIFOs and other special files', async () => {
    await execFileAsync('mkfifo', [join(t.root, 'pipe')]);
    await denied(t.ctx.paths.resolve(main('pipe'), { principal: host }), 'special-file', host);
  });

  it('refuses a file used as a directory', async () => {
    await denied(t.ctx.paths.resolve(main('README.md/x'), { principal: editor }), 'not-directory');
  });
});

describe('roots', () => {
  async function makeWorktree(id: string, links: { path: string; mainPath: string }[] = []): Promise<string> {
    const dir = join(t.root, '.smurg', 'worktrees', id);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'app.ts'), 'wt\n');
    for (const l of links) await symlink(join(t.root, l.mainPath), join(dir, l.path));
    await t.ctx.roots.registerWorktree({ worktreeId: id, dir, ownerUserId: 'dev:rita', sharedLinks: links });
    return dir;
  }
  const wt = (id: string, path: string): FileRef => ({ root: { kind: 'worktree', worktreeId: id } as RootRef, path });

  it('resolves inside a registered worktree and refuses unknown ones', async () => {
    await makeWorktree('wt1');
    const r = await t.ctx.paths.readFile(wt('wt1', 'src/app.ts'), { principal: editor });
    expect(new TextDecoder().decode(r.bytes)).toBe('wt\n');
    await denied(t.ctx.paths.resolve(wt('nope', 'x'), { principal: editor }), 'unknown-root');
  });

  it('shared directories are readable through their link but never writable', async () => {
    await makeWorktree('wt2', [{ path: 'data', mainPath: 'data' }]);
    const r = await t.ctx.paths.resolve(wt('wt2', 'data/table.csv'), { principal: editor });
    expect(r.readOnly).toBe(true);
    expect(r.mainRef).toEqual(main('data/table.csv'));
    await denied(t.ctx.paths.resolve(wt('wt2', 'data/table.csv'), { principal: editor, forWrite: true }), 'read-only');
    await denied(t.ctx.paths.writeFileAtomic(wt('wt2', 'data/new.csv'), new Uint8Array([1]), { principal: host }), 'read-only', host);
  });

  it('a shared link re-pointed by a guest is refused', async () => {
    const dir = await makeWorktree('wt3', [{ path: 'data', mainPath: 'data' }]);
    await rm(join(dir, 'data'));
    await symlink(outside, join(dir, 'data'));
    await denied(t.ctx.paths.resolve(wt('wt3', 'data/secret.txt'), { principal: editor }), 'shared-link-tampered');
  });

  it('an unregistered symlink from a worktree into the main workspace is refused (R9 isolation)', async () => {
    const dir = await makeWorktree('wt4');
    await symlink(join(t.root, 'src'), join(dir, 'main-src'));
    await denied(t.ctx.paths.resolve(wt('wt4', 'main-src/app.ts'), { principal: editor }), 'outside-root');
  });

  it('a worktree root swapped for a symlink is refused (root-changed)', async () => {
    const dir = await makeWorktree('wt5');
    await rename(dir, `${dir}-moved`);
    await symlink(outside, dir);
    await denied(t.ctx.paths.resolve(wt('wt5', 'secret.txt'), { principal: editor }), 'root-changed');
  });

  it('registration refuses dirs outside .smurg/worktrees and links to host-only or outside dirs', async () => {
    await mkdir(join(t.root, 'elsewhere'));
    await expect(t.ctx.roots.registerWorktree({ worktreeId: 'bad1', dir: join(t.root, 'elsewhere'), ownerUserId: 'dev:rita', sharedLinks: [] })).rejects.toThrow();
    const dir = join(t.root, '.smurg', 'worktrees', 'bad2');
    await mkdir(dir, { recursive: true });
    await symlink(join(t.root, '.claude'), join(dir, 'cfg'));
    await expect(t.ctx.roots.registerWorktree({ worktreeId: 'bad2', dir, ownerUserId: 'dev:rita', sharedLinks: [{ path: 'cfg', mainPath: '.claude' }] })).rejects.toThrow();
    await symlink(outside, join(dir, 'out'));
    await expect(t.ctx.roots.registerWorktree({ worktreeId: 'bad2', dir, ownerUserId: 'dev:rita', sharedLinks: [{ path: 'out', mainPath: 'data' }] })).rejects.toThrow();
    expect(t.ctx.roots.get({ kind: 'worktree', worktreeId: 'bad2' })).toBeNull();
  });

  it('toFileRef maps absolute paths to the most specific root, or null outside every root', async () => {
    await makeWorktree('wt6', [{ path: 'data', mainPath: 'data' }]);
    expect(await t.ctx.paths.toFileRef(join(t.root, 'src', 'app.ts'))).toEqual(main('src/app.ts'));
    expect(await t.ctx.paths.toFileRef(join(t.root, 'src', 'new-file.ts'))).toEqual(main('src/new-file.ts'));
    expect(await t.ctx.paths.toFileRef(join(t.root, '.smurg', 'worktrees', 'wt6', 'src', 'app.ts'))).toEqual(wt('wt6', 'src/app.ts'));
    expect(await t.ctx.paths.toFileRef(join(t.root, '.smurg', 'worktrees', 'wt6', 'data', 'table.csv'))).toEqual(main('data/table.csv'));
    expect(await t.ctx.paths.toFileRef(join(t.root, '..', 'outside', 'secret.txt'))).toBeNull();
    expect(await t.ctx.paths.toFileRef(join(outside, 'secret.txt'))).toBeNull();
    expect(await t.ctx.paths.toFileRef('relative/path')).toBeNull();
    expect(await t.ctx.paths.toFileRef('/tmp/\u0000x')).toBeNull();
  });
});

describe('guarded reads and writes', () => {
  it('writes atomically, keeps the mode of the file it replaces, and supports no-clobber and expect', async () => {
    const guard = t.ctx.paths;
    const first = await guard.writeFileAtomic(main('notes.txt'), new TextEncoder().encode('one'), { principal: editor, noClobber: true });
    expect(await readFile(join(t.root, 'notes.txt'), 'utf8')).toBe('one');
    await expect(guard.writeFileAtomic(main('notes.txt'), new Uint8Array([1]), { principal: editor, noClobber: true })).rejects.toMatchObject({ code: 'conflict' });
    const { chmod } = await import('node:fs/promises');
    await chmod(join(t.root, 'notes.txt'), 0o640);
    const current = await guard.resolve(main('notes.txt'), { principal: editor });
    await guard.writeFileAtomic(main('notes.txt'), new TextEncoder().encode('two'), { principal: editor, expect: current.identity });
    expect(((await stat(join(t.root, 'notes.txt'))).mode & 0o777).toString(8)).toBe('640');
    await expect(guard.writeFileAtomic(main('notes.txt'), new TextEncoder().encode('three'), { principal: editor, expect: first })).rejects.toMatchObject({ code: 'conflict' });
    await expect(guard.writeFileAtomic(main('missing-dir/x.txt'), new Uint8Array([1]), { principal: editor })).rejects.toMatchObject({ code: 'not_found' });
    expect((await readdir(t.root)).filter((n) => n.includes('.smurg-'))).toEqual([]);
  });

  it('reads with a byte limit and reports truncation', async () => {
    const r = await t.ctx.paths.readFile(main('README.md'), { principal: viewer, maxBytes: 3 });
    expect(new TextDecoder().decode(r.bytes)).toBe('hel');
    expect(r.truncated).toBe(true);
    const whole = await t.ctx.paths.readFile(main('README.md'), { principal: viewer });
    expect(whole.truncated).toBe(false);
  });

  it('the daemon itself (system principal) may see .smurg', async () => {
    const r = await t.ctx.paths.resolve(main('.smurg'), { principal: SYSTEM_PRINCIPAL });
    expect(r.exists).toBe(true);
  });
});
