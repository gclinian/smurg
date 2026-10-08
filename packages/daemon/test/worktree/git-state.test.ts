// The shared folder's git state, looked at again while it is shared (0.5.2, DESIGN D2): WorktreeManagerImpl's
// refreshGitState. The real worktree module over a scratch folder; the daemon's git is a small wrapper that writes
// down every command before it runs the real git, so the tests count the git processes a look makes.
//  - `.git` that goes while an item worktree, a kept worktree and a merge request exist: worktree mode is off, nothing
//    is deleted, the records stay; `.git` back: worktree mode is on again and the request can be merged;
//  - callers at the same time share one look; a look that finds nothing changed runs no git at all; the git
//    executable of a folder that is no repository is looked for once, never on the sweep;
//  - stop() waits for a look under way, and that look assigns nothing after the stop;
//  - a look whose detection throws keeps "available", and otherwise says to try again (R8) rather than a reason found
//    for the `.git` that was there before; the sweep does not try it again, a request does;
//  - `.git` that changes while git runs (replaced by a link, moved away during the start) is looked at again: the
//    answer is about the `.git` that is there; the start's look is the one a refresh at the same time shares.
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { fakesModule } from '../../src/core/fakes/index.ts';
import { createFilesModule } from '../../src/files/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTempDir, createTestDaemon, isolatedGitEnv, removeTempDir, waitFor } from '../../src/testing/index.ts';
import { createTopicsModule } from '../../src/topics/module.ts';
import { findGit } from '../../src/worktree/git.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

const execFileAsync = promisify(execFile);

let stack: WorktreeStack | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
  for (const dir of dirs.splice(0)) await removeTempDir(dir).catch(() => {});
}, 60_000);

const TOPIC = { id: 'tp_checkout', slug: 'checkout' };
const FILES = {
  'README.md': '# demo\n',
  'src/app.ts': 'export const answer = 42;\n',
  'specs/checkout/SPEC.md': '# Checkout\n',
  'specs/checkout/PLAN.md': '# Plan\n',
};

interface CountingGit {
  readonly path: string;
  /** Every command the daemon ran, as its arguments joined by spaces, in order. */
  calls(): Promise<string[]>;
  /** How many `git version` (the look for the executable) are among them. */
  versions(): Promise<number>;
  /** While on, `git version` takes two seconds. */
  slow(on: boolean): Promise<void>;
}

async function countingGit(): Promise<CountingGit> {
  const real = await findGit(process.env['PATH']);
  if (real === null) throw new Error('these tests need git');
  const dir = await createTempDir('counting-git');
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  const slowFlag = join(dir, 'slow');
  const path = join(dir, 'bin', 'git');
  await mkdir(join(dir, 'bin'));
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = version ] && [ -f '${slowFlag}' ]; then sleep 2; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const calls = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return {
    path,
    calls,
    versions: async () => (await calls()).filter((line) => line === 'version').length,
    slow: async (on) => (on ? writeFile(slowFlag, '') : rm(slowFlag, { force: true })),
  };
}

function reasonOf(s: WorktreeStack): unknown {
  return s.manager.unavailableReason()?.detail?.['reason'] ?? null;
}

describe('the shared folder\'s git state, looked at again while sharing', { timeout: 60_000 }, () => {
  it('.git that goes while worktrees and a merge request exist: worktree mode is off, nothing is deleted; .git back: on again', async () => {
    stack = await startWorktreeStack({ files: FILES });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    const item = await s.manager.acquireForItem({ topic: TOPIC, itemId: 'cart-api', owner: s.principal('dev:mei') });
    const itemDir = s.worktreeDir(item.worktree.id);
    await writeFile(join(itemDir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const snapshot = await s.manager.snapshot({ worktreeId: item.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
    if (!snapshot.ok) throw new Error('snapshot refused');
    const session = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_kept' });
    await s.manager.releaseFromSession(session.worktree.id, 'ses_kept', { keep: true });
    const worktreesBefore = s.manager.list();
    const mergesBefore = s.manager.listMerges(s.principal(s.host.userId));
    expect(mergesBefore).toHaveLength(1);
    expect(reasonOf(s)).toBeNull();

    // The host moves .git away (or deletes it) while sharing.
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBe('not-a-git-repo');
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(false);
    expect(await s.manager.mainState()).toMatchObject({ isRepo: false, hasCommit: false, unavailable: { id: 'worktree.unavailable.notAGitRepo' } });
    // Nothing deleted or moved: the worktrees, their files, the kept one, the request.
    expect(s.manager.list()).toEqual(worktreesBefore);
    expect(s.manager.listMerges(s.principal(s.host.userId))).toEqual(mergesBefore);
    expect(await readFile(join(itemDir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect((await lstat(s.worktreeDir(session.worktree.id))).isDirectory()).toBe(true);
    expect(s.t.ctx.roots.get({ kind: 'worktree', worktreeId: item.worktree.id })).not.toBeNull();
    // What needs the repository says why.
    expect(await settleError(s.manager.acquireForItem({ topic: TOPIC, itemId: 'payment-form', owner: s.principal('dev:mei') }))).toMatchObject({ code: 'conflict', reason: 'not-a-git-repo', text: { id: 'worktree.unavailable.notAGitRepo' } });
    expect(await s.manager.headBlobs(['specs/checkout/SPEC.md'])).toEqual({ 'specs/checkout/SPEC.md': null });

    // A gitfile where the directory was: not an ordinary folder.
    await writeFile(join(s.t.root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBe('git-dir-not-directory');
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(true);
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.unavailable.gitDirNotDirectory' });
    await rm(join(s.t.root, '.git'));

    // .git back: worktree mode is available again, and the request is merged as it was.
    await rename(join(s.t.root, '.git-away'), join(s.t.root, '.git'));
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBeNull();
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(true);
    expect(await s.manager.mainState()).toMatchObject({ isRepo: true, hasCommit: true, unavailable: null, branch: 'main' });
    const { request } = await s.host.conn.request('worktree.merge.approve', { requestId: snapshot.request.id });
    expect(request.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
  });

  it('callers at the same time share one look; a look that finds nothing changed runs no git; git is looked for once', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ git: false, files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    // A folder that is no repository: no git at the start; the executable is looked for once, when first asked.
    expect(await counting.calls()).toEqual([]);
    const [first, second] = await Promise.all([s.manager.mainState(), s.manager.mainState()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ isRepo: false, gitOk: true, unavailable: { id: 'worktree.unavailable.notAGitRepo' } });
    expect(await counting.calls()).toEqual(['version']);
    await s.manager.mainState();
    for (let i = 0; i < 3; i++) await s.manager.refreshGitState({ timer: true });
    await s.manager.refreshGitState();
    expect(await counting.calls()).toEqual(['version']);

    // `git init` and a commit: three callers at once, one look, one `git version`.
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', '-A']);
    await s.git(['commit', '-q', '-m', 'first']);
    await Promise.all([s.manager.refreshGitState({ timer: true }), s.manager.mainState(), s.manager.mainState()]);
    expect(await counting.versions()).toBe(2);
    expect(reasonOf(s)).toBeNull();
    await s.manager.inspected();

    // Nothing changed since: no git process, whoever asks.
    const settled = (await counting.calls()).length;
    for (let i = 0; i < 5; i++) await s.manager.refreshGitState({ timer: true });
    await Promise.all([s.manager.refreshGitState(), s.manager.refreshGitState()]);
    expect((await counting.calls()).length).toBe(settled);
  });

  it('stop() waits for a look that is under way, and that look assigns nothing after the stop', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ git: false, files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', '-A']);
    await s.git(['commit', '-q', '-m', 'first']);
    await counting.slow(true);
    let looked = false;
    const look = s.manager.refreshGitState().then(() => {
      looked = true;
    });
    await waitFor(async () => (await counting.versions()) === 1, { what: 'the look to run git version' });
    await s.manager.stop();
    expect(looked).toBe(true);
    await look;
    expect(reasonOf(s)).toBe('not-a-git-repo');
    // A stopped module looks no more.
    await s.manager.refreshGitState();
    expect(await counting.versions()).toBe(1);
  });

  it('a look whose detection fails: Start says to try again (not "no repository" in a folder that is one); the sweep does not try it again, a request does', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ git: false, files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    const smurg = join(s.t.root, '.smurg');
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', '-A']);
    await s.git(['commit', '-q', '-m', 'first']);
    // .smurg/worktrees cannot be looked at (the folder above it cannot be searched): the detection throws.
    await chmod(smurg, 0o000);
    try {
      await s.manager.refreshGitState();
      expect(reasonOf(s)).toBe('check-failed');
      expect(await counting.versions()).toBe(1);
      expect(s.t.ctx.workspace.info.isGitRepo).toBe(true);
      expect(await s.manager.mainState()).toMatchObject({ isRepo: true, gitOk: true, unavailable: { id: 'worktree.unavailable.checkFailed' } });
      expect(await counting.versions()).toBe(2); // mainState is a request: it tried again
      await s.manager.refreshGitState({ timer: true });
      expect(await counting.versions()).toBe(2);
      await s.manager.refreshGitState();
      expect(await counting.versions()).toBe(3);
      expect(reasonOf(s)).toBe('check-failed');
    } finally {
      await chmod(smurg, 0o700);
    }
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBeNull();
  });

  it('a look that fails keeps "available": worktree mode stays on, and a request tries again', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ git: false, files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', '-A']);
    await s.git(['commit', '-q', '-m', 'first']);
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBeNull();
    // Another repository in its place, and .smurg cannot be searched: the look at it throws.
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-first'));
    await s.git(['init', '-q', '-b', 'main']);
    const smurg = join(s.t.root, '.smurg');
    await chmod(smurg, 0o000);
    try {
      await s.manager.refreshGitState();
      expect(reasonOf(s)).toBeNull();
    } finally {
      await chmod(smurg, 0o700);
    }
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBeNull();
    expect(await s.manager.mainState()).toMatchObject({ isRepo: true, hasCommit: false, unavailable: { id: 'worktree.unavailable.noCommit' } });
  });

  it('.git replaced by a link while git runs: the look sees the link, not the .git it started with', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ git: false, files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', '-A']);
    await s.git(['commit', '-q', '-m', 'first']);
    await counting.slow(true);
    const look = s.manager.refreshGitState();
    await waitFor(async () => (await counting.versions()) === 1, { what: 'the look to run git version' });
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-real'));
    await symlink(join(s.t.root, '.git-real'), join(s.t.root, '.git'));
    await look;
    await counting.slow(false);
    expect(reasonOf(s)).toBe('git-dir-not-directory');
    expect(await counting.versions()).toBe(1); // the link needs no git to be refused
    expect(await settleError(s.manager.commitMainPaths({ paths: ['README.md'], message: 'x', trailers: [], as: s.principal(s.host.userId) }))).toMatchObject({ reason: 'git-dir-not-directory' });
    // The real directory back: available.
    await rm(join(s.t.root, '.git'));
    await rename(join(s.t.root, '.git-real'), join(s.t.root, '.git'));
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBeNull();
  });

  it('.git moved away while the worktree module starts, with the topics sweep ticking: the start\'s look is the shared one, and it ends on what is there', async () => {
    const counting = await countingGit();
    const root = await createTempDir('git-state-start');
    dirs.push(root);
    const gitHome = await createTempDir('git-state-start-home');
    dirs.push(gitHome);
    await writeFile(join(root, 'README.md'), '# demo\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'first']]) await execFileAsync('git', args, { cwd: root, env: isolatedGitEnv(gitHome) });
    await counting.slow(true);
    const starting = createTestDaemon({
      root,
      agents: { escalationSweepMs: 50 },
      modules: [locksModule, createFilesModule({ watch: false }), createWorktreeModule({ gitPath: counting.path }), fakesModule({ except: ['topics', 'plans', 'reports', 'worktrees'], handlers: true }), createTopicsModule({ fileDebounceMs: 20 })],
    });
    // The start is in its `git version` (slow) while the sweep ticks: the host moves .git away now.
    await waitFor(async () => (await counting.versions()) === 1, { what: 'the start to run git version' });
    await rename(join(root, '.git'), join(root, '.git-away'));
    const t = await starting;
    await counting.slow(false);
    try {
      const manager = t.ctx.services.worktrees as WorktreeManagerImpl;
      expect(manager.unavailableReason()?.detail?.['reason']).toBe('not-a-git-repo');
      for (let i = 0; i < 3; i++) await manager.refreshGitState({ timer: true });
      await manager.refreshGitState();
      expect(manager.unavailableReason()?.detail?.['reason']).toBe('not-a-git-repo');
      expect(t.ctx.workspace.info.isGitRepo).toBe(false);
      expect(await manager.mainState()).toMatchObject({ isRepo: false, unavailable: { id: 'worktree.unavailable.notAGitRepo' } });
      expect(await counting.versions()).toBe(1);
      // .git back: available, without a restart.
      await rename(join(root, '.git-away'), join(root, '.git'));
      await manager.refreshGitState();
      expect(manager.unavailableReason()).toBeNull();
      expect(t.ctx.workspace.info.isGitRepo).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});
