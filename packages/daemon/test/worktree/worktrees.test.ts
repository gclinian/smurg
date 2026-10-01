// R9 / D6 / D12: worktrees as shared clones (ARCHITECTURE §5.7, §11 D-2) — creation, shared read-only links, the git
// exclude entry, removal, keep-and-resume, restart, and a share that is not a git repository.
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type WorktreeInfo } from '@smurg/protocol';
import { PathDeniedError } from '../../src/core/errors.ts';
import { createTempDir, isolatedGitEnv, removeTempDir, waitFor } from '../../src/testing/index.ts';
import { restartDaemonWith } from './restart.ts';
import { settleError, startWorktreeStack, utf8, type WorktreeStack } from './support.ts';

const execFileAsync = promisify(execFile);
let stack: WorktreeStack | null = null;

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
}, 60_000);

describe('worktree creation (shared clone, ARCHITECTURE §5.7)', { timeout: 60_000 }, () => {
  it('clones the share with --shared into .smurg/worktrees/<id> on smurg/<owner>/<id> at the main HEAD, and registers the root', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    await s.connect('dev:amy', 'agent');
    const updates: WorktreeInfo[] = [];
    s.host.conn.on('worktree.updated', (payload) => updates.push(payload.worktree));
    const head = (await s.git(['rev-parse', 'HEAD'])).trim();

    const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_one' });
    const dir = s.worktreeDir(handle.worktree.id);
    expect(handle.worktree.id).toMatch(/^wt_[0-9a-f]{24}$/);
    expect(handle.worktree).toMatchObject({ ownerUserId: 'dev:amy', ownerName: 'amy', branch: `smurg/dev-amy/${handle.worktree.id}`, sessionId: 'ses_one', kept: false });
    expect(dir).toBe(join(await realpath(s.t.root), '.smurg', 'worktrees', handle.worktree.id));
    expect(handle.root.realPath).toBe(dir);
    expect(s.t.ctx.roots.get({ kind: 'worktree', worktreeId: handle.worktree.id })?.ownerUserId).toBe('dev:amy');

    // Its own repository whose objects come from the main one through alternates (read-only for guests).
    expect((await lstat(join(dir, '.git'))).isDirectory()).toBe(true);
    const alternates = (await readFile(join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8')).trim();
    expect(await realpath(alternates)).toBe(join(await realpath(s.t.root), '.git', 'objects'));
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(head);
    expect((await s.git(['symbolic-ref', 'HEAD'], dir)).trim()).toBe(`refs/heads/${handle.worktree.branch}`);
    expect(await readFile(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    // No remote pointing back at the host's repository, no sample hooks from a template.
    expect((await s.git(['remote'], dir)).trim()).toBe('');
    expect(await lstat(join(dir, '.git', 'hooks')).catch(() => null)).toBeNull();

    // The main workspace is untouched: nothing new to commit, and the worktrees are invisible to git.
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');

    await waitFor(() => updates.length > 0, { what: 'worktree.updated' });
    expect(updates[0]?.id).toBe(handle.worktree.id);
    const list = await s.host.conn.request('worktree.list', {});
    expect(list.worktrees.map((w) => w.id)).toEqual([handle.worktree.id]);
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.create')).toMatchObject({ outcome: 'ok', target: handle.worktree.id, actor: { kind: 'user', userId: 'dev:amy' } });
  });

  it('.smurg/ is added to .git/info/exclude and the user\'s .gitignore is untouched', async () => {
    stack = await startWorktreeStack({ files: { 'README.md': 'x\n', '.gitignore': 'node_modules/\n*.log\n' } });
    const s = stack;
    await s.connect('dev:amy', 'agent');
    const before = await readFile(join(s.t.root, '.gitignore'), 'utf8');
    await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_x' });
    const exclude = await readFile(join(s.t.root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').map((line) => line.trim())).toContain('/.smurg/');
    expect(await readFile(join(s.t.root, '.gitignore'), 'utf8')).toBe(before);
    expect((await s.git(['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
    expect((await s.git(['check-ignore', '-q', '.smurg/worktrees']).then(() => 0, () => 1))).toBe(0);
  });

  it('D12: shared directories appear in the worktree as read-only links (PathGuard refuses writes through them)', async () => {
    stack = await startWorktreeStack({ settings: { sharedDirs: ['data', 'models/checkpoints'] } });
    const s = stack;
    // The shared dirs are not in git (datasets, checkpoints): they exist only in the main workspace.
    await mkdir(join(s.t.root, 'data'), { recursive: true });
    await writeFile(join(s.t.root, 'data', 'train.csv'), 'a,b\n1,2\n');
    await mkdir(join(s.t.root, 'models', 'checkpoints'), { recursive: true });
    await writeFile(join(s.t.root, 'models', 'checkpoints', 'ckpt.bin'), 'weights');
    const amy = await s.connect('dev:amy', 'agent');
    const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_d12' });
    const dir = s.worktreeDir(handle.worktree.id);
    expect(handle.worktree.sharedDirs).toEqual(['data', 'models/checkpoints']);
    const share = await realpath(s.t.root);
    for (const path of ['data', 'models/checkpoints']) {
      const link = join(dir, ...path.split('/'));
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(join(share, ...path.split('/')));
    }
    // Recorded with the root, so PathGuard treats them as read-only.
    expect(handle.root.sharedLinks.map((link) => link.path).sort()).toEqual(['data', 'models/checkpoints']);
    const ref = (path: string) => ({ root: { kind: 'worktree' as const, worktreeId: handle.worktree.id }, path });
    const read = await s.t.ctx.paths.readFile(ref('data/train.csv'), { principal: s.principal('dev:amy') });
    expect(Buffer.from(read.bytes).toString()).toBe('a,b\n1,2\n');
    const denied = await s.t.ctx.paths.resolve(ref('data/new.csv'), { principal: s.principal('dev:amy'), forWrite: true }).catch((err: unknown) => err);
    expect(denied).toBeInstanceOf(PathDeniedError);
    expect((denied as PathDeniedError).reason).toBe('read-only');
    const deniedExisting = await s.t.ctx.paths
      .writeFileAtomic(ref('models/checkpoints/ckpt.bin'), utf8('overwrite'), { principal: s.principal('dev:amy'), forWrite: true })
      .catch((err: unknown) => err);
    expect((deniedExisting as PathDeniedError).reason).toBe('read-only');
    expect(await readFile(join(s.t.root, 'models', 'checkpoints', 'ckpt.bin'), 'utf8')).toBe('weights');
    // The links are never committed: they are excluded in the clone.
    expect((await s.git(['status', '--porcelain', '--untracked-files=all'], dir)).trim()).toBe('');
    await amy.conn.request('worktree.list', {});
  });

  it('a shared directory that is tracked in git, host-only or missing is not linked', async () => {
    stack = await startWorktreeStack({
      files: { 'README.md': 'x\n', 'assets/logo.txt': 'logo\n' },
      settings: { sharedDirs: ['assets', 'missing', 'datasets'] },
    });
    const s = stack;
    await mkdir(join(s.t.root, 'datasets'));
    await s.connect('dev:amy', 'agent');
    const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_skip' });
    expect(handle.worktree.sharedDirs).toEqual(['datasets']);
    const dir = s.worktreeDir(handle.worktree.id);
    expect((await lstat(join(dir, 'assets'))).isDirectory()).toBe(true);
    expect(await readFile(join(dir, 'assets', 'logo.txt'), 'utf8')).toBe('logo\n');
  });

  it('refuses worktree mode with a clear error when the share is not a git repository', async () => {
    stack = await startWorktreeStack({ git: false });
    const s = stack;
    await s.connect('dev:amy', 'agent');
    const error = await settleError(s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_nogit' }));
    expect(error).toMatchObject({ code: 'conflict', reason: 'not-a-git-repo' });
    expect(error?.message).toContain('不是 git 儲存庫');
    expect(await s.host.conn.request('worktree.list', {})).toEqual({ worktrees: [] });
  });

  it('refuses a worktree when the main workspace has no commit yet', async () => {
    const project = await createTempDir('empty-repo');
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: isolatedGitEnv(join(project, '.home')) });
      stack = await startWorktreeStack({ root: project });
      const s = stack;
      await s.connect('dev:amy', 'agent');
      expect(await settleError(s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_empty' }))).toMatchObject({ code: 'conflict', reason: 'no-commits' });
      expect(s.manager.list()).toEqual([]);
    } finally {
      await stack?.cleanup();
      stack = null;
      await removeTempDir(project);
    }
  });
});

describe('worktree lifecycle', { timeout: 60_000 }, () => {
  it('R9.4 (manager): a kept worktree can be resumed by a later session of its owner, and only by its owner', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    await s.connect('dev:amy', 'agent');
    await s.connect('dev:bob', 'agent');
    const first = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_a' });
    await writeFile(join(s.worktreeDir(first.worktree.id), 'notes.md'), 'work in progress\n');
    await s.manager.releaseFromSession(first.worktree.id, 'ses_a', { keep: true });
    expect(s.manager.get(first.worktree.id)).toMatchObject({ kept: true });
    expect(s.manager.get(first.worktree.id)?.sessionId).toBeUndefined();

    const other = await settleError(s.manager.acquireForSession({ owner: s.principal('dev:bob'), sessionId: 'ses_b', worktreeId: first.worktree.id }));
    expect(other).toMatchObject({ code: 'forbidden', reason: 'not-owner:worktree' });

    const again = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_c', worktreeId: first.worktree.id });
    expect(again.worktree).toMatchObject({ id: first.worktree.id, sessionId: 'ses_c', kept: false });
    expect(await readFile(join(again.root.realPath, 'notes.md'), 'utf8')).toBe('work in progress\n');
    // A stale release of the earlier session changes nothing.
    await s.manager.releaseFromSession(first.worktree.id, 'ses_a', { keep: false });
    expect(s.manager.get(first.worktree.id)).toMatchObject({ sessionId: 'ses_c' });
  });

  it('session end without keeping removes the worktree, its root and its directory', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    await s.connect('dev:amy', 'agent');
    const removed: string[] = [];
    s.host.conn.on('worktree.removed', (payload) => removed.push(payload.worktreeId));
    const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_gone' });
    const dir = s.worktreeDir(handle.worktree.id);
    await s.manager.releaseFromSession(handle.worktree.id, 'ses_gone', { keep: false });
    expect(s.manager.get(handle.worktree.id)).toBeNull();
    expect(s.t.ctx.roots.get({ kind: 'worktree', worktreeId: handle.worktree.id })).toBeNull();
    expect(await lstat(dir).catch(() => null)).toBeNull();
    await waitFor(() => removed.includes(handle.worktree.id), { what: 'worktree.removed' });
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.remove')).toMatchObject({ outcome: 'ok', target: handle.worktree.id });
  });

  it('removal never deletes through a link, and a removal the daemon could not finish is completed at the next start', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const outside = await createTempDir('wt-outside');
    try {
      await writeFile(join(outside, 'precious.txt'), 'keep\n');
      await s.connect('dev:amy', 'agent');
      const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_rm' });
      const dir = s.worktreeDir(handle.worktree.id);
      await symlink(outside, join(dir, 'escape'));
      await mkdir(join(dir, 'deep', 'er'), { recursive: true });
      await symlink(join(outside, 'precious.txt'), join(dir, 'deep', 'er', 'file-link'));
      await s.manager.releaseFromSession(handle.worktree.id, 'ses_rm', { keep: false });
      expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep\n');
      // Nothing is left behind (the tree was renamed out of the worktrees dir first, then deleted).
      expect(await readdir(s.t.ctx.roots.worktreesDir)).toEqual([]);

      // A daemon stopped half-way through a removal leaves `<id>.removing-<hex>`: the next start finishes it.
      const leftover = join(s.t.ctx.roots.worktreesDir, `wt_${'a'.repeat(24)}.removing-${'0'.repeat(16)}`);
      await mkdir(join(leftover, 'sub'), { recursive: true });
      await writeFile(join(leftover, 'sub', 'x'), 'x');
      await symlink(outside, join(leftover, 'link'));
      await s.t.daemon.stop();
      const daemon = await restartDaemonWith(s.t);
      await daemon.stop();
      expect(await lstat(leftover).catch(() => null)).toBeNull();
      expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep\n');
    } finally {
      await removeTempDir(outside);
    }
  });

  it('worktree.remove: owner or host only; refused while a session uses it', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const amy = await s.connect('dev:amy', 'agent');
    const bob = await s.connect('dev:bob', 'editor');
    const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_live' });
    const worktreeId = handle.worktree.id;

    expect(await settleError(bob.conn.request('worktree.remove', { worktreeId }))).toMatchObject({ code: 'forbidden' });
    const denials = (await s.t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'authz.denied' && entry.target === 'worktree.remove');
    expect(denials.length).toBe(1);

    // In use: the harness's sessions stub cannot tell, so the manager is asked with a session it knows is live.
    const live = s.manager as unknown as { sessionLive: (id: string) => boolean };
    const original = live.sessionLive.bind(s.manager);
    live.sessionLive = (id) => id === 'ses_live' || original(id);
    expect(await settleError(amy.conn.request('worktree.remove', { worktreeId }))).toMatchObject({ code: 'conflict', reason: 'worktree-in-use' });
    live.sessionLive = original;

    await amy.conn.request('worktree.remove', { worktreeId });
    expect(s.manager.get(worktreeId)).toBeNull();

    const second = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_two' });
    await s.manager.releaseFromSession(second.worktree.id, 'ses_two', { keep: true });
    await s.host.conn.request('worktree.remove', { worktreeId: second.worktree.id });
    expect(s.manager.get(second.worktree.id)).toBeNull();
    expect(await settleError(s.host.conn.request('worktree.remove', { worktreeId: second.worktree.id }))).toMatchObject({ code: 'not_found' });
  });

  it('survives a daemon restart: kept worktrees, their roots and shared links come back; worktrees in use become kept', async () => {
    stack = await startWorktreeStack({ settings: { sharedDirs: ['data'] } });
    const s = stack;
    await mkdir(join(s.t.root, 'data'));
    await s.connect('dev:amy', 'agent');
    const kept = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_k' });
    await s.manager.releaseFromSession(kept.worktree.id, 'ses_k', { keep: true });
    const busy = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_busy' });
    await s.t.daemon.stop();

    const daemon = await restartDaemonWith(s.t);
    try {
      const manager = daemon.ctx.services.worktrees;
      expect(manager.list().map((w) => w.id).sort()).toEqual([kept.worktree.id, busy.worktree.id].sort());
      expect(manager.get(busy.worktree.id)).toMatchObject({ kept: true });
      expect(manager.get(busy.worktree.id)?.sessionId).toBeUndefined();
      const root = daemon.ctx.roots.get({ kind: 'worktree', worktreeId: kept.worktree.id });
      expect(root?.sharedLinks.map((link) => link.path)).toEqual(['data']);
      const amy = daemon.ctx.members.principalOf('dev:amy');
      if (!amy) throw new Error('amy');
      const resumed = await manager.acquireForSession({ owner: amy, sessionId: 'ses_after', worktreeId: kept.worktree.id });
      expect(resumed.worktree.sessionId).toBe('ses_after');
    } finally {
      await daemon.stop();
    }
  });

  it('limits the number of worktrees per owner', async () => {
    stack = await startWorktreeStack({ module: { limits: { maxWorktreesPerOwner: 2 } } });
    const s = stack;
    await s.connect('dev:amy', 'agent');
    await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_1' });
    await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_2' });
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_3' }))).toMatchObject({ code: 'conflict', reason: 'worktree-limit-owner' });
    expect((await stat(s.t.ctx.roots.worktreesDir)).isDirectory()).toBe(true);
    expect(MAIN_ROOT.kind).toBe('main');
  });
});
