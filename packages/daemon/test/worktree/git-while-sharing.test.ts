// A shared folder that becomes a git repository while it is shared (0.5.2; the owner's report of 2026-10-08, reproduced
// by the v0.5.2 experiment U3 with the released 0.5.1). The REAL daemon with the real files, worktree and topics modules
// (fakes for the agent runtime only), over scratch folders: git runs with a scratch HOME and identity, as the host would
// run it in a terminal. What it holds:
//  - a folder that is no repository: Start names that reason; after `git init` (same daemon) the reason is "no commit
//    yet"; after a first commit Start starts and the item runs in a worktree. No restart, and no commit line before
//    there is a branch to name;
//  - `.smurg/` (the share lock marker, a delete cut short in trash/, an upload staged in the share) is never part of
//    what the host commits, in whatever order `git init`, `git add -A` and `git commit` come;
//  - a share whose .git is a gitfile (a linked worktree) is told why, not "run git init", and has no commit line;
//  - a repository that already tracks `.smurg/` (a `git add -A` while sharing with 0.5.1): Start, the item's worktree,
//    its snapshot, the merge and an update from the main workspace still work; the host is told once.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, topicPlanPath, topicSpecPath } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { DaemonEvents } from '../../src/core/interfaces.ts';
import { fakesModule } from '../../src/core/fakes/index.ts';
import { createFilesModule } from '../../src/files/module.ts';
import type { UploadServiceImpl } from '../../src/files/upload.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTempDir, createTempRunDir, createTestDaemon, isolatedGitEnv, removeTempDir, removeTempRunDir, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { createTopicsModule } from '../../src/topics/module.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { MiB, bytesSource, patternSource, upload } from '../files/helpers.ts';
import { SPEC_TEXT, planText } from '../topics/support.ts';
import { settleError } from './support.ts';

const run = promisify(execFile);

const daemons: TestDaemon[] = [];
const dirs: string[] = [];
const runDirs: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.cleanup().catch(() => {});
  for (const dir of dirs.splice(0)) await removeTempDir(dir).catch(() => {});
  for (const dir of runDirs.splice(0)) await removeTempRunDir(dir).catch(() => {});
}, 60_000);

async function tempDir(label: string): Promise<string> {
  const dir = await createTempDir(label);
  dirs.push(dir);
  return dir;
}

async function stateDirFor(): Promise<string> {
  const dir = await createTempRunDir();
  runDirs.push(dir);
  return dir;
}

/** A module that only listens (registered before any module starts, so it hears what a start says). */
function listener(seen: DaemonEvents['worktree.smurg-tracked'][]): FeatureModule {
  return { name: 'test-listener', register: (_router, ctx) => ctx.bus.on('worktree.smurg-tracked', (event) => seen.push(event)) };
}

async function startDaemon(root: string, stateDir: string, extra: readonly FeatureModule[] = []): Promise<TestDaemon> {
  const t = await createTestDaemon({
    root,
    stateDir,
    modules: [
      ...extra,
      locksModule,
      createFilesModule({ watch: false }),
      createWorktreeModule({ limits: { treeCheckDelayMs: 100 } }),
      fakesModule({ except: ['topics', 'plans', 'reports', 'worktrees'], handlers: true }),
      createTopicsModule({ fileDebounceMs: 20 }),
    ],
  });
  daemons.push(t);
  return t;
}

type Git = (cwd: string, ...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** git as the host runs it in a terminal (a scratch HOME, no global config, a scratch identity). */
function gitIn(home: string): Git {
  return async (cwd, ...args) => {
    try {
      const { stdout, stderr } = await run('git', args, { cwd, env: isolatedGitEnv(home) });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
}

async function lines(git: Git, cwd: string, ...args: string[]): Promise<string[]> {
  const result = await git(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean);
}

const ITEM = { id: 'sum-1-to-100', title: 'Add sum_1_to_100.py' };

/** A topic with a spec and a valid one-item plan, as the owner had it. */
async function topicWithPlan(t: TestDaemon, client: TestClient): Promise<string> {
  const { topic } = await client.conn.request('topic.create', { name: 'Sum' });
  await mkdir(join(t.root, 'specs', topic.slug), { recursive: true });
  await writeFile(join(t.root, topicSpecPath(topic.slug)), SPEC_TEXT);
  await writeFile(join(t.root, topicPlanPath(topic.slug)), planText([ITEM]));
  t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: topicPlanPath(topic.slug), change: 'add' }] });
  await waitFor(() => t.ctx.services.plans.get(topic.id)?.items.length === 1, { what: 'the plan to be read' });
  return topic.id;
}

/** What the Start dialog shows, and the facts behind it. */
async function look(t: TestDaemon, client: TestClient, topicId: string) {
  const { preflight } = await client.conn.request('plan.preflight', { topicId });
  return {
    blockers: preflight.blockers.map((blocker) => blocker.text.id),
    fallbacks: preflight.blockers.map((blocker) => blocker.fallback),
    commit: preflight.commit,
    versioned: t.ctx.services.topics.get(topicId)?.versioned,
    isGitRepo: t.ctx.workspace.info.isGitRepo,
    pins: { planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash },
  };
}

async function listTree(dir: string): Promise<string[] | null> {
  try {
    return (await readdir(dir, { recursive: true })).map(String).sort();
  } catch {
    return null;
  }
}

describe('a shared folder that becomes a git repository while it is shared (0.5.2)', { timeout: 120_000 }, () => {
  it('git init, then a first commit, while sharing: Start names each reason, then starts without a restart; .smurg/ is never committed', async () => {
    const root = await tempDir('gws-share');
    const git = gitIn(await tempDir('gws-githome'));
    await writeFile(join(root, 'README.md'), '# sums\n');
    const t = await startDaemon(root, await stateDirFor());
    const host = await t.connectHost();
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const topicId = await topicWithPlan(t, host);

    // 1. No repository: that reason, what the host can do, and no commit line (there is no branch to name).
    const notRepo = await look(t, host, topicId);
    expect(notRepo).toMatchObject({ blockers: ['worktree.unavailable.notAGitRepo'], commit: null, versioned: false, isGitRepo: false });
    expect(notRepo.fallbacks).toEqual(['The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.']);

    // What a running share keeps in .smurg/: the lock marker, a delete cut short in trash/, a partial upload staged in
    // the share (the state dir on another volume, simulated as the upload tests do).
    await mkdir(join(root, '.smurg', 'trash', 'cut-short'), { recursive: true });
    await writeFile(join(root, '.smurg', 'trash', 'cut-short', 'notes.txt'), 'deleted, not yet removed\n');
    const internals = t.ctx.services.uploads as UploadServiceImpl as unknown as { stateArea: { kind: string; dir: string; dev: number } };
    internals.stateArea = { ...internals.stateArea, dev: -1 };
    const xfer = await amy.transfer();
    await upload(xfer, { path: 'far.bin', size: 2 * MiB, source: patternSource('gws-far'), stopAfter: 1 });
    const bytes = new TextEncoder().encode('print(sum(range(1, 101)))\n');
    await upload(xfer, { path: 'uploaded.py', size: bytes.length, source: bytesSource(bytes) });
    const smurg = await listTree(join(root, '.smurg'));
    expect(smurg).toEqual(expect.arrayContaining(['.gitignore', 'daemon-lock.json', 'trash/cut-short/notes.txt']));
    expect(smurg?.some((path) => path.startsWith('uploads/up_') && path.endsWith('.part'))).toBe(true);

    // 2. `git init` while sharing: the same daemon sees a repository without a commit.
    expect((await git(root, 'init')).code).toBe(0);
    const branch = (await git(root, 'symbolic-ref', '--short', 'HEAD')).stdout.trim();
    const noCommit = await look(t, host, topicId);
    expect(noCommit).toMatchObject({ blockers: ['worktree.unavailable.noCommit'], commit: null, versioned: true, isGitRepo: true });
    expect(noCommit.fallbacks).toEqual(["The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again."]);
    // It saw the repository: smurg's folder is in its exclude file too, and git sees nothing of it.
    expect((await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).split('\n')).toContain('/.smurg/');
    expect((await lines(git, root, 'status', '--porcelain=v1', '--untracked-files=all')).filter((line) => line.includes('.smurg'))).toEqual([]);

    // 3. `git add -A` and a first commit: nothing of .smurg/ goes in.
    expect((await git(root, 'add', '-A')).code).toBe(0);
    expect((await git(root, 'commit', '-q', '-m', 'first')).code).toBe(0);
    const committed = await lines(git, root, 'show', '--name-only', '--format=', 'HEAD');
    expect(committed.filter((path) => path.startsWith('.smurg'))).toEqual([]);
    expect(committed).toEqual(expect.arrayContaining(['README.md', 'uploaded.py', topicSpecPath('sum'), topicPlanPath('sum')]));

    // 4. Start, same daemon: nothing in the way, the commit line names the branch, the item runs in a worktree.
    const ready = await look(t, host, topicId);
    expect(ready).toMatchObject({ blockers: [], versioned: true, isGitRepo: true, commit: { needed: false, branch } });
    expect(await settleError(host.conn.request('plan.start', { topicId, ...ready.pins }))).toBeNull();
    await waitFor(() => t.ctx.services.plans.get(topicId)?.items[0]?.worktreeId !== undefined, { timeoutMs: 30_000, what: 'the item to get a worktree' });
    const item = t.ctx.services.plans.get(topicId)?.items[0];
    expect(item?.state).toBe('running');
    const worktree = t.ctx.roots.get({ kind: 'worktree', worktreeId: item?.worktreeId as string });
    expect(worktree).not.toBeNull();
    // Nothing of .smurg/ is in the item's checkout, nor anywhere in the main repository's status.
    expect(await listTree(join(worktree?.realPath as string, '.smurg'))).toBeNull();
    expect((await lines(git, root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no')).filter((line) => line.includes('.smurg'))).toEqual([]);
    expect((await lines(git, root, 'log', '--name-only', '--format=')).filter((path) => path.startsWith('.smurg'))).toEqual([]);
  });

  it('git init, git add -A and git commit at once, before smurg looks: nothing of .smurg/ is committed (it ignores itself)', async () => {
    const root = await tempDir('gws-at-once');
    const git = gitIn(await tempDir('gws-githome-b'));
    await writeFile(join(root, 'README.md'), '# sums\n');
    // A root .gitignore that un-ignores the folder does not take it either (the folder's own .gitignore wins).
    await writeFile(join(root, '.gitignore'), '!.smurg/\n!.smurg/**\n');
    const t = await startDaemon(root, await stateDirFor());
    await mkdir(join(root, '.smurg', 'trash', 'cut-short'), { recursive: true });
    await writeFile(join(root, '.smurg', 'trash', 'cut-short', 'notes.txt'), 'deleted, not yet removed\n');
    expect((await git(root, 'init')).code).toBe(0);
    expect((await git(root, 'add', '-A')).code).toBe(0);
    expect((await git(root, 'commit', '-q', '-m', 'first')).code).toBe(0);
    expect(await lines(git, root, 'show', '--name-only', '--format=', 'HEAD')).toEqual(['.gitignore', 'README.md']);
    // The daemon sees it at the next look; its exclude line comes then (the .gitignore did the work already).
    const host = await t.connectHost();
    const topicId = await topicWithPlan(t, host);
    expect(await look(t, host, topicId)).toMatchObject({ blockers: [], isGitRepo: true, commit: { needed: true } });
  });

  it('what follows the folder without a restart: every topic (topic.updated), the next welcome, the status', async () => {
    const root = await tempDir('gws-follows');
    const git = gitIn(await tempDir('gws-githome-f'));
    await writeFile(join(root, 'README.md'), '# sums\n');
    const t = await startDaemon(root, await stateDirFor());
    const host = await t.connectHost();
    const topicId = await topicWithPlan(t, host);
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    expect(amy.welcome?.workspace.isGitRepo).toBe(false);
    expect(t.daemon.status().isGitRepo).toBe(false);
    const versioned: boolean[] = [];
    amy.conn.on('topic.updated', (payload) => {
      if (payload.topic.id === topicId) versioned.push(payload.topic.versioned);
    });
    const manager = t.ctx.services.worktrees as WorktreeManagerImpl;

    // The host runs `git init`; nobody opens Start: the topics module's sweep looks (here: the look it makes).
    await git(root, 'init');
    await manager.refreshGitState({ timer: true });
    await waitFor(() => versioned.includes(true), { what: 'topic.updated with versioned' });
    expect(t.ctx.services.topics.get(topicId)?.versioned).toBe(true);
    expect(t.daemon.status().isGitRepo).toBe(true);
    expect((await amy.reconnect()).welcome?.workspace.isGitRepo).toBe(true);

    // And back: `.git` removed.
    await rm(join(root, '.git'), { recursive: true });
    await manager.refreshGitState({ timer: true });
    await waitFor(() => versioned.at(-1) === false, { what: 'topic.updated without versioned' });
    expect(t.daemon.status().isGitRepo).toBe(false);
    expect((await amy.reconnect()).welcome?.workspace.isGitRepo).toBe(false);
  });

  it('a look at .git that races Start: Start waits for the same look, then starts', async () => {
    const root = await tempDir('gws-race');
    const git = gitIn(await tempDir('gws-githome-c'));
    await writeFile(join(root, 'README.md'), '# sums\n');
    const t = await startDaemon(root, await stateDirFor());
    const host = await t.connectHost();
    const topicId = await topicWithPlan(t, host);
    const before = await look(t, host, topicId);
    expect(before.blockers).toEqual(['worktree.unavailable.notAGitRepo']);
    await git(root, 'init');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'first');
    const manager = t.ctx.services.worktrees as WorktreeManagerImpl;
    const [, started] = await Promise.all([manager.refreshGitState(), settleError(host.conn.request('plan.start', { topicId, ...before.pins })), manager.refreshGitState()]);
    expect(started).toBeNull();
    expect(manager.unavailableReason()).toBeNull();
    await waitFor(() => t.ctx.services.plans.get(topicId)?.items[0]?.worktreeId !== undefined, { timeoutMs: 30_000, what: 'the item to get a worktree' });
  });

  it('a share whose .git is a gitfile (a linked worktree): the reason is the .git, no commit line, and .smurg/ stays out of git', async () => {
    const mainRepo = await tempDir('gws-mainrepo');
    const parent = await tempDir('gws-linked');
    const git = gitIn(await tempDir('gws-githome-d'));
    await writeFile(join(mainRepo, 'README.md'), '# main\n');
    await git(mainRepo, 'init', '-q', '-b', 'main');
    await git(mainRepo, 'add', '-A');
    await git(mainRepo, 'commit', '-q', '-m', 'initial');
    const linked = join(parent, 'wt');
    expect((await git(mainRepo, 'worktree', 'add', '-q', '-b', 'feature', linked)).code).toBe(0);
    const t = await startDaemon(linked, await stateDirFor());
    const host = await t.connectHost();
    const topicId = await topicWithPlan(t, host);
    const seen = await look(t, host, topicId);
    expect(seen).toMatchObject({ blockers: ['worktree.unavailable.gitDirNotDirectory'], commit: null, isGitRepo: true });
    expect(seen.fallbacks).toEqual([
      "The shared folder's .git is not an ordinary folder (the folder is a git worktree or a submodule, for example), so worktrees cannot be used. The host can share the repository's main folder instead.",
    ]);
    expect(await settleError(host.conn.request('plan.start', { topicId, ...seen.pins }))).toMatchObject({ code: 'conflict', text: { id: 'worktree.unavailable.gitDirNotDirectory' } });
    expect(await lines(git, linked, 'status', '--porcelain=v1', '--untracked-files=all')).toEqual([`?? ${topicPlanPath('sum')}`, `?? ${topicSpecPath('sum')}`]);
    await t.cleanup();
    daemons.splice(daemons.indexOf(t), 1);
    await git(mainRepo, 'worktree', 'remove', '--force', linked);
  });

  it('a repository that already tracks .smurg/ (git add -A while sharing with 0.5.1): Start, the item worktree, its merge and an update from the main workspace work; the host is told once', async () => {
    const root = await tempDir('gws-tracked');
    const git = gitIn(await tempDir('gws-githome-e'));
    await writeFile(join(root, 'README.md'), '# sums\n');
    // What 0.5.1 left: the marker of a share that ran while the host made the first commit, committed; then that
    // share stopped (its marker went: ` D`), and this smurg shares the folder again (a new marker: ` M`).
    await mkdir(join(root, '.smurg'), { recursive: true });
    await writeFile(join(root, '.smurg', 'daemon-lock.json'), '{"v":1,"socket":"/nowhere/run/old.lk","workspaceId":"ws_old","pid":1,"startedAt":1}\n');
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'first');
    expect(await lines(git, root, 'ls-files', '.smurg')).toEqual(['.smurg/daemon-lock.json']);
    await rm(join(root, '.smurg'), { recursive: true });

    const told: DaemonEvents['worktree.smurg-tracked'][] = [];
    const t = await startDaemon(root, await stateDirFor(), [listener(told)]);
    const manager = t.ctx.services.worktrees as WorktreeManagerImpl;
    await manager.inspected();
    expect(told).toEqual([{ count: 1 }]);
    expect(await lines(git, root, 'status', '--porcelain=v1', '--untracked-files=all')).toEqual([' M .smurg/daemon-lock.json']);

    // Start: the checkpoint commit takes the spec and the plan only; the dirty marker stays as it is.
    const host = await t.connectHost();
    await t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const topicId = await topicWithPlan(t, host);
    const ready = await look(t, host, topicId);
    expect(ready).toMatchObject({ blockers: [], commit: { needed: true, branch: 'main' } });
    expect(await settleError(host.conn.request('plan.start', { topicId, ...ready.pins }))).toBeNull();
    expect(await lines(git, root, 'show', '--name-only', '--format=', 'HEAD')).toEqual([topicPlanPath('sum'), topicSpecPath('sum')]);
    expect(await lines(git, root, 'status', '--porcelain=v1', '--untracked-files=all')).toEqual([' M .smurg/daemon-lock.json']);
    await waitFor(() => t.ctx.services.plans.get(topicId)?.items[0]?.worktreeId !== undefined, { timeoutMs: 30_000, what: 'the item to get a worktree' });
    const worktreeId = t.ctx.services.plans.get(topicId)?.items[0]?.worktreeId as string;
    const dir = join(t.ctx.roots.worktreesDir, worktreeId);
    // The item's checkout has the committed marker (what the host is told to untrack), and nothing else of it.
    expect(await listTree(join(dir, '.smurg'))).toEqual(['daemon-lock.json']);

    // The item's change: a snapshot, the host's approval (the main workspace's dirty marker is not in the way).
    await writeFile(join(dir, 'sum_1_to_100.py'), 'print(sum(range(1, 101)))\n');
    const snapshot = await manager.snapshot({ worktreeId, message: 'smurg: work item 1 (sum-1-to-100)', topicSlug: 'sum' });
    expect(snapshot).toMatchObject({ ok: true, files: 1 });
    if (!snapshot.ok) throw new Error('snapshot refused');
    const { request } = await host.conn.request('worktree.merge.approve', { requestId: snapshot.request.id });
    expect(request.status).toBe('merged');
    expect(await readFile(join(root, 'sum_1_to_100.py'), 'utf8')).toBe('print(sum(range(1, 101)))\n');
    expect(await lines(git, root, 'status', '--porcelain=v1', '--untracked-files=all')).toEqual([' M .smurg/daemon-lock.json']);

    // An update of the item's worktree from the main workspace after the host committed more.
    await writeFile(join(root, 'README.md'), '# sums, and more\n');
    expect((await git(root, 'commit', '-q', '-m', 'more', '--', 'README.md')).code).toBe(0);
    expect(await manager.updateFromMain(worktreeId)).toMatchObject({ conflicted: [] });
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# sums, and more\n');

    // Once a run: worktree mode that goes and comes back (`.git` moved away and back) does not tell it again.
    await rename(join(root, '.git'), join(root, '.git-away'));
    await manager.refreshGitState();
    expect(manager.unavailableReason()?.detail).toMatchObject({ reason: 'not-a-git-repo' });
    await rename(join(root, '.git-away'), join(root, '.git'));
    await manager.refreshGitState();
    expect(manager.unavailableReason()).toBeNull();
    await manager.inspected();
    expect(told).toHaveLength(1);
  });
});
