// The shared folder's git state, looked at again while it is shared (0.5.2, DESIGN D2): WorktreeManagerImpl's
// refreshGitState. The real worktree module over a scratch folder; the daemon's git is a small wrapper that writes
// down every command before it runs the real git, so the tests count the git processes a look makes.
//  - `.git` that goes while an item worktree, a kept worktree and a merge request exist: worktree mode is off, nothing
//    is deleted, the records stay, and every refusal says the `.git` is gone and to put it back (never "run git
//    init": a new repository cannot merge those requests); `.git` back: worktree mode is on again and the request can
//    be merged;
//  - callers at the same time share one look; a look that finds nothing changed runs no git at all; the git
//    executable of a folder that is no repository is looked for once, never on the sweep;
//  - stop() waits for a look under way, and that look assigns nothing after the stop;
//  - a look whose detection throws keeps "available", and otherwise says to try again (R8) rather than a reason found
//    for the `.git` that was there before; the sweep does not try it again, a request does: Start, a worktree asked
//    for, and also a merge request made, shown or decided, a snapshot, an update from the main workspace, a commit or
//    a diff of the main workspace's files; the start's own look that failed is tried again the same way;
//  - a request that finds the SWEEP's look running after a look that failed waits for it and then looks itself (it is
//    not refused with "try again in a moment" for a folder that is fine); the sweep itself still runs no git;
//  - Reject looks first too, so the review ref goes with the request when the repository is there; it needs no
//    repository, and still rejects while `.git` is away;
//  - "the .git is gone, put it back" counts only what a new repository would strand: a worktree, or a merge request
//    that is still open (draft, pending, conflict). Requests that were decided (merged, rejected) are history: a
//    folder with only those is simply not a repository, and `git init` cures it;
//  - whether the folder "is a repository" for people (`isGitRepo`) is false only where the reason is "not a git
//    repository": a `.git` that is a link, a gitfile or any other entry counts as one;
//  - a session that asks for a worktree is refused with the reason Start names: git itself first, once it is known;
//  - `.git` that changes while git runs (replaced by a link, moved away during the start) is looked at again: the
//    answer is about the `.git` that is there; the start's look is the one a refresh at the same time shares.
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../src/core/context.ts';
import { fakesModule } from '../../src/core/fakes/index.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
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

/**
 * `.git` moved away and put back, and the one look at it that follows fails (.smurg cannot be searched for that
 * moment): worktree mode is off with "try again in a moment", in a folder that is fine from here on.
 */
async function lookThatFails(s: WorktreeStack): Promise<void> {
  const smurg = join(s.t.root, '.smurg');
  await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
  await s.manager.refreshGitState({ timer: true });
  await rename(join(s.t.root, '.git-away'), join(s.t.root, '.git'));
  await chmod(smurg, 0o000);
  try {
    await s.manager.refreshGitState({ timer: true });
  } finally {
    await chmod(smurg, 0o700);
  }
  expect(reasonOf(s)).toBe('check-failed');
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

    // The host moves .git away (or deletes it) while sharing. With worktrees and a merge request on record the
    // reason is "the .git is gone, put it back", wherever it is said: `git init` would make another repository.
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBe('git-dir-gone');
    expect(s.manager.unavailableReason()?.message).toBe("The shared folder's .git is gone, so worktrees cannot be used. The host can put it back: the worktrees and merge requests here belong to that repository.");
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(false);
    expect(await s.manager.mainState()).toMatchObject({ isRepo: false, hasCommit: false, unavailable: { id: 'worktree.unavailable.gitDirGone' } });
    // Nothing deleted or moved: the worktrees, their files, the kept one, the request.
    expect(s.manager.list()).toEqual(worktreesBefore);
    expect(s.manager.listMerges(s.principal(s.host.userId))).toEqual(mergesBefore);
    expect(await readFile(join(itemDir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect((await lstat(s.worktreeDir(session.worktree.id))).isDirectory()).toBe(true);
    expect(s.t.ctx.roots.get({ kind: 'worktree', worktreeId: item.worktree.id })).not.toBeNull();
    // What needs the repository says why: a new worktree, the kept one, Merge, the diff, a snapshot.
    const gone = { code: 'conflict', reason: 'git-dir-gone', text: { id: 'worktree.unavailable.gitDirGone' } };
    expect(await settleError(s.manager.acquireForItem({ topic: TOPIC, itemId: 'payment-form', owner: s.principal('dev:mei') }))).toMatchObject(gone);
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_again', worktreeId: session.worktree.id }))).toMatchObject(gone);
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: snapshot.request.id }))).toMatchObject(gone);
    expect(await settleError(s.host.conn.request('worktree.merge.diff', { requestId: snapshot.request.id }))).toMatchObject(gone);
    expect(await settleError(s.manager.snapshot({ worktreeId: item.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' }))).toMatchObject(gone);
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

  it('after a look that failed, a merge request made, shown or decided, a snapshot, an update from the main workspace and the main workspace\'s files each look again; the sweep never does', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    const mei = await s.connect('dev:mei', 'agent');
    const item = await s.manager.acquireForItem({ topic: TOPIC, itemId: 'cart-api', owner: s.principal('dev:mei') });
    await writeFile(join(s.worktreeDir(item.worktree.id), 'src', 'app.ts'), 'export const answer = 43;\n');
    const take = { worktreeId: item.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' };
    const snapshot = await s.manager.snapshot(take);
    if (!snapshot.ok) throw new Error('snapshot refused');
    const requestId = snapshot.request.id;
    const smurg = join(s.t.root, '.smurg');

    /** `.git` moved away and put back, and the one look at it that follows fails (.smurg cannot be searched for that moment). */
    const failOneLook = async (): Promise<void> => {
      await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
      await s.manager.refreshGitState({ timer: true });
      expect(reasonOf(s)).toBe('git-dir-gone');
      await rename(join(s.t.root, '.git-away'), join(s.t.root, '.git'));
      await chmod(smurg, 0o000);
      try {
        await s.manager.refreshGitState({ timer: true });
      } finally {
        await chmod(smurg, 0o700);
      }
      expect(reasonOf(s)).toBe('check-failed');
      expect(s.t.ctx.workspace.info.isGitRepo).toBe(true);
      // The folder is fine from here on, and the sweep does not look again (it would run git every few seconds).
      const versions = await counting.versions();
      for (let i = 0; i < 3; i++) await s.manager.refreshGitState({ timer: true });
      expect(reasonOf(s)).toBe('check-failed');
      expect(await counting.versions()).toBe(versions);
    };

    const requests: Record<string, () => Promise<unknown>> = {
      'the diff': () => s.host.conn.request('worktree.merge.diff', { requestId }),
      'one file of the diff': () => s.host.conn.request('worktree.merge.fileDiff', { requestId, path: 'src/app.ts' }),
      'a snapshot': () => s.manager.snapshot(take),
      'an update from the main workspace': () => s.manager.updateFromMain(item.worktree.id),
      'a commit of main files': () => s.manager.commitMainPaths({ paths: ['README.md'], message: 'x', trailers: [], as: s.principal(s.host.userId) }),
      'a diff of main files': async () => {
        await writeFile(join(s.t.root, 'README.md'), '# demo, changed\n');
        const diffs = await s.manager.diffMainPaths({ paths: ['README.md'], against: 'head', maxBytes: 10_000 });
        await writeFile(join(s.t.root, 'README.md'), '# demo\n');
        // Not the empty answer of a folder that is no repository.
        expect(diffs.map((entry) => entry.path)).toEqual(['README.md']);
      },
      'a merge request': () => mei.conn.request('worktree.merge.request', { worktreeId: item.worktree.id }),
      'Merge': () => s.host.conn.request('worktree.merge.approve', { requestId }),
    };
    for (const [what, request] of Object.entries(requests)) {
      await failOneLook();
      const versions = await counting.versions();
      expect(await settleError(request()), what).toBeNull();
      expect(reasonOf(s), what).toBeNull();
      expect(await counting.versions(), what).toBe(versions + 1); // one look, by the request itself
      await s.manager.inspected();
    }
    expect(s.manager.listMerges(s.principal(s.host.userId)).find((merge) => merge.id === requestId)?.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
  });

  it('the start\'s own look that failed is tried again by the next request: "try again in a moment", not "git does not run" for the rest of the run', async () => {
    const counting = await countingGit();
    // While the worktree module starts, .smurg cannot be searched: its look at .smurg/worktrees throws.
    const smurgOf = (root: string): string => join(root, '.smurg');
    const before: FeatureModule = { name: 'test-smurg-closed', register: () => toDisposable(() => {}), start: (ctx) => chmod(smurgOf(ctx.roots.main.realPath), 0o000) };
    const after: FeatureModule = { name: 'test-smurg-open', register: () => toDisposable(() => {}), start: (ctx) => chmod(smurgOf(ctx.roots.main.realPath), 0o700) };
    stack = await startWorktreeStack({ files: FILES, module: { gitPath: counting.path }, extraModules: [before], laterModules: [after] });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    expect(reasonOf(s)).toBe('check-failed');
    expect(s.manager.unavailableReason()?.text).toEqual({ id: 'worktree.unavailable.checkFailed' });
    expect(s.t.ctx.workspace.info.isGitRepo).toBe(true);
    expect(await counting.versions()).toBe(1);
    // The sweep does not repeat it; a request does, and the folder was fine all along.
    for (let i = 0; i < 3; i++) await s.manager.refreshGitState({ timer: true });
    expect(reasonOf(s)).toBe('check-failed');
    expect(await counting.versions()).toBe(1);
    expect(await s.manager.mainState()).toMatchObject({ isRepo: true, hasCommit: true, gitOk: true, unavailable: null, branch: 'main' });
    expect(reasonOf(s)).toBeNull();
    expect(await counting.versions()).toBe(2);
    const session = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_after' });
    expect((await lstat(s.worktreeDir(session.worktree.id))).isDirectory()).toBe(true);
  });

  it('a .git that is a link, or a file that is no gitfile, is no ordinary folder and the folder counts as a repository; only what `git init` cures is "not a repository"', async () => {
    stack = await startWorktreeStack({ git: false, files: FILES });
    const s = stack;
    const gitPath = join(s.t.root, '.git');
    const state = async (): Promise<{ reason: unknown; isGitRepo: boolean; isRepo: boolean; unavailable: string | undefined }> => {
      await s.manager.refreshGitState();
      const main = await s.manager.mainState();
      return { reason: reasonOf(s), isGitRepo: s.t.ctx.workspace.info.isGitRepo, isRepo: main.isRepo, unavailable: main.unavailable?.id };
    };
    const notRepo = { reason: 'not-a-git-repo', isGitRepo: false, isRepo: false, unavailable: 'worktree.unavailable.notAGitRepo' };
    const notOrdinary = { reason: 'git-dir-not-directory', isGitRepo: true, isRepo: true, unavailable: 'worktree.unavailable.gitDirNotDirectory' };
    expect(await state()).toEqual(notRepo);
    // A directory git does not take for a repository (it has no HEAD): `git init` makes it one.
    await mkdir(gitPath);
    expect(await state()).toEqual(notRepo);
    await rm(gitPath, { recursive: true });

    // A link to a git directory (git works through it), a dangling link, a link to a file.
    const real = join(s.t.root, 'elsewhere.git');
    await s.git(['init', '-q', '-b', 'main']);
    await rename(gitPath, real);
    await symlink(real, gitPath);
    expect(await state()).toEqual(notOrdinary);
    await rm(gitPath);
    await symlink(join(s.t.root, 'nowhere'), gitPath);
    expect(await state()).toEqual(notOrdinary);
    await rm(gitPath);
    await symlink(join(s.t.root, 'README.md'), gitPath);
    expect(await state()).toEqual(notOrdinary);
    await rm(gitPath);

    // A file that is no gitfile, an empty file, a gitfile.
    await writeFile(gitPath, 'hello\n');
    expect(await state()).toEqual(notOrdinary);
    await writeFile(gitPath, '');
    expect(await state()).toEqual(notOrdinary);
    await writeFile(gitPath, 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(await state()).toEqual(notOrdinary);
    await rm(gitPath);
    expect(await state()).toEqual(notRepo);
  });

  it('"the .git is gone" follows the records: with the last worktree removed and no merge request, the folder is simply not a repository', async () => {
    stack = await startWorktreeStack({ files: FILES });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    const session = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_kept' });
    await s.manager.releaseFromSession(session.worktree.id, 'ses_kept', { keep: true });
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBe('git-dir-gone');
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.unavailable.gitDirGone' });
    await s.manager.remove(session.worktree.id, s.principal(s.host.userId));
    expect(s.manager.list()).toEqual([]);
    expect(reasonOf(s)).toBe('not-a-git-repo');
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.unavailable.notAGitRepo' });
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_new' }))).toMatchObject({ reason: 'not-a-git-repo', text: { id: 'worktree.unavailable.notAGitRepo' } });
  });

  // 0.5.2 (the closing fixes): decided requests are history. Before, ANY request on record made a folder whose `.git`
  // went say "put it back", also one with nothing but a merged request and no worktree, where `git init` is the cure.
  it('"the .git is gone" counts only what a new repository would strand: a worktree, or a merge request still open; decided requests are history', async () => {
    stack = await startWorktreeStack({ files: FILES });
    const s = stack;
    const mei = await s.connect('dev:mei', 'agent');
    const statuses = (): string[] => s.manager.listMerges(s.principal(s.host.userId)).map((merge) => merge.status).sort();
    let asked = 0;
    const askForWorktree = (): ReturnType<typeof settleError> => settleError(s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: `ses_new${++asked}` }));

    // One request merged, one that waits for the host; then their worktree is removed. No worktree is left.
    const session = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_a' });
    const dir = s.worktreeDir(session.worktree.id);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const first = await mei.conn.request('worktree.merge.request', { worktreeId: session.worktree.id });
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: first.request.id })).request.status).toBe('merged');
    await writeFile(join(dir, 'README.md'), '# demo, more\n');
    const waiting = await mei.conn.request('worktree.merge.request', { worktreeId: session.worktree.id });
    await s.manager.releaseFromSession(session.worktree.id, 'ses_a', { keep: false });
    expect(s.manager.list()).toEqual([]);
    expect(statuses()).toEqual(['merged', 'pending']);

    // `.git` goes. The request that waits can only be merged in that repository: "put it back".
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
    await s.manager.refreshGitState();
    expect(reasonOf(s)).toBe('git-dir-gone');
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.unavailable.gitDirGone' });
    expect(await askForWorktree()).toMatchObject({ reason: 'git-dir-gone', text: { id: 'worktree.unavailable.gitDirGone' } });

    // The host rejects it (that needs no repository). Every request is decided now and no worktree is left: a new
    // repository would strand nothing, so the folder is simply not a repository, from that moment on.
    expect((await s.host.conn.request('worktree.merge.reject', { requestId: waiting.request.id })).request.status).toBe('rejected');
    expect(statuses()).toEqual(['merged', 'rejected']);
    expect(reasonOf(s)).toBe('not-a-git-repo');
    expect(s.manager.unavailableReason()?.message).toBe('The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.');
    expect(await s.manager.mainState()).toMatchObject({ isRepo: false, unavailable: { id: 'worktree.unavailable.notAGitRepo' } });
    expect(await askForWorktree()).toMatchObject({ reason: 'not-a-git-repo', text: { id: 'worktree.unavailable.notAGitRepo' } });

    // What that sentence offers is the cure: `git init` and a commit, and a session gets its worktree.
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', 'README.md']);
    await s.git(['commit', '-q', '-m', 'again']);
    expect(await askForWorktree()).toBeNull();
    expect(reasonOf(s)).toBeNull();
    expect(statuses()).toEqual(['merged', 'rejected']);
  });

  // 0.5.2 (the closing fixes): Reject did not look, so after a look that failed it answered "rejected" and left
  // refs/smurg/merge/<id> in the host's repository for good (the stored request names it: no sweep takes it).
  it('Reject looks at .git first: after a look that failed, the review ref goes with the request; with .git away it still rejects, and runs no git', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ files: FILES, module: { gitPath: counting.path } });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    const item = await s.manager.acquireForItem({ topic: TOPIC, itemId: 'cart-api', owner: s.principal('dev:mei') });
    const snapshotOf = async (answer: number): Promise<string> => {
      await writeFile(join(s.worktreeDir(item.worktree.id), 'src', 'app.ts'), `export const answer = ${answer};\n`);
      const snapshot = await s.manager.snapshot({ worktreeId: item.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
      if (!snapshot.ok) throw new Error('snapshot refused');
      return snapshot.request.id;
    };
    const refs = async (): Promise<string[]> => (await s.git(['for-each-ref', '--format=%(refname)', 'refs/smurg/merge/'])).split('\n').filter(Boolean);

    const first = await snapshotOf(43);
    expect(await refs()).toEqual([`refs/smurg/merge/${first}`]);
    await lookThatFails(s);
    const versions = await counting.versions();
    const rejected = await s.host.conn.request('worktree.merge.reject', { requestId: first });
    expect(rejected.request.status).toBe('rejected');
    expect(await counting.versions()).toBe(versions + 1); // Reject looked itself
    expect(reasonOf(s)).toBeNull();
    expect(await refs()).toEqual([]);

    // `.git` is really away: rejecting needs no repository. It answers, and no git process runs.
    const second = await snapshotOf(44);
    expect(await refs()).toEqual([`refs/smurg/merge/${second}`]);
    await rename(join(s.t.root, '.git'), join(s.t.root, '.git-away'));
    const calls = (await counting.calls()).length;
    const away = await s.host.conn.request('worktree.merge.reject', { requestId: second, reason: 'not this way' });
    expect(away.request).toMatchObject({ status: 'rejected', rejectReason: 'not this way' });
    expect(reasonOf(s)).toBe('git-dir-gone'); // the item's worktree is on record
    expect((await counting.calls()).length).toBe(calls);
    // Someone who may not decide is refused before anything is looked at (`.git` is back, and nobody has seen it yet).
    await rename(join(s.t.root, '.git-away'), join(s.t.root, '.git'));
    expect(await settleError(s.manager.reject({ requestId: second }, s.principal('dev:mei')))).toMatchObject({ code: 'forbidden' });
    expect(reasonOf(s)).toBe('git-dir-gone');
    expect((await counting.calls()).length).toBe(calls);
  });

  // 0.5.2 (the closing fixes): callers at the same time share one look. The sweep's look never repeats a look that
  // failed, so a request that happened to arrive while the sweep looked shared a look that did nothing, and was
  // refused with "try again in a moment" in a folder that was fine.
  it('a request that arrives while the sweep looks, after a look that failed, waits for the sweep and then looks itself; the sweep runs no git', async () => {
    const counting = await countingGit();
    stack = await startWorktreeStack({ files: FILES, module: { gitPath: counting.path } });
    const s = stack;

    // The sweep ticks, and in the same moment Start asks.
    await lookThatFails(s);
    let versions = await counting.versions();
    const tick = s.manager.refreshGitState({ timer: true });
    const main = await s.manager.mainState();
    await tick;
    expect(main).toMatchObject({ isRepo: true, hasCommit: true, gitOk: true, unavailable: null, branch: 'main' });
    expect(reasonOf(s)).toBeNull();
    expect(await counting.versions()).toBe(versions + 1); // one look with git: the request's own, after the sweep's

    // Two requests in that moment (a commit of the main workspace's files, Start): they share the one look that follows.
    await lookThatFails(s);
    versions = await counting.versions();
    const tick2 = s.manager.refreshGitState({ timer: true });
    const [commit, state] = await Promise.all([settleError(s.manager.commitMainPaths({ paths: ['README.md'], message: 'x', trailers: [], as: s.principal(s.host.userId) })), s.manager.mainState()]);
    await tick2;
    expect(commit).toBeNull();
    expect(state.unavailable).toBeNull();
    expect(await counting.versions()).toBe(versions + 1);

    // The sweep by itself, also two ticks at once: no git process, and the failure stays for the next request.
    await lookThatFails(s);
    versions = await counting.versions();
    await Promise.all([s.manager.refreshGitState({ timer: true }), s.manager.refreshGitState({ timer: true })]);
    for (let i = 0; i < 3; i++) await s.manager.refreshGitState({ timer: true });
    expect(await counting.versions()).toBe(versions);
    expect(reasonOf(s)).toBe('check-failed');
    // And a request while NO look runs is as before: one look.
    expect((await s.manager.mainState()).unavailable).toBeNull();
    expect(await counting.versions()).toBe(versions + 1);
  });

  it('a session that asks for a worktree is refused with the reason Start names: git itself first, once it is known', async () => {
    const bin = await createTempDir('old-git');
    dirs.push(bin);
    const old = join(bin, 'git');
    await writeFile(old, '#!/bin/sh\nif [ "$1" = version ]; then echo "git version 2.39.5"; exit 0; fi\nexit 1\n', { mode: 0o755 });
    stack = await startWorktreeStack({ git: false, files: FILES, module: { gitPath: old } });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    const ask = (): ReturnType<typeof settleError> => settleError(s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_a' }));
    // Nobody asked Start yet (the topics module does when it starts; it is not composed here): git was not looked
    // for, and a teammate's request never runs git in a folder that is no repository.
    expect(await ask()).toMatchObject({ reason: 'not-a-git-repo', text: { id: 'worktree.unavailable.notAGitRepo' } });
    const tooOld = { id: 'worktree.unavailable.gitTooOld', params: { version: '2.39.5', minVersion: '2.42.0' } };
    expect(await s.manager.mainState()).toMatchObject({ isRepo: false, gitOk: false, unavailable: tooOld });
    expect(await ask()).toMatchObject({ code: 'conflict', reason: 'git-too-old', text: tooOld });
    // What does not ask for a worktree keeps the folder's own reason.
    expect(await settleError(s.manager.commitMainPaths({ paths: ['README.md'], message: 'x', trailers: [], as: s.principal(s.host.userId) }))).toMatchObject({ reason: 'not-a-git-repo' });
  });
});
