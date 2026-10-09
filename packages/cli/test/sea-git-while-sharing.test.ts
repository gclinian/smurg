// A folder that becomes a git repository WHILE it is shared, with the PACKAGED executable (0.5.2). With 0.5.1 the
// owner shared a folder that was no git repository, pressed Start, read "run `git init` and commit once", did so
// while `smurg host` kept running, and read the same sentence again: the share had to be started again. The daemon's
// own tests hold the rules; here the real `smurg host` is asked what the Start dialog asks. Opt-in, beside
// sea.test.ts, sea-update.test.ts and sea-upgrade.test.ts. From the repository's root:
//
//   SMURG_SEA_BINARY=packages/cli/dist/smurg-darwin-arm64 \
//     pnpm --filter @smurg/cli exec vitest run test/sea-git-while-sharing.test.ts
//
//   SMURG_SEA_BINARY  the executable of this tree (scripts/build-sea.sh). A path that is not absolute is read from the
//                     repository's root, whatever folder the runner is in (./sea-binaries.ts).
// A run must not read as "covered" because this did not run:
//   - without SMURG_SEA_BINARY it is SKIPPED, and one line on stderr says so (written when this file is loaded, outside
//     any test body, so that every reporter shows it); with SMURG_RELEASE_GATE=1 that is a FAILURE, the rule
//     ./sea-binaries.ts has for the upgrade test: a release's gate needs the executable, so it does not pass without
//     this test having run wherever sea.test.ts and sea-update.test.ts run;
//   - a named file that is not an executable FAILS with one plain sentence, before anything is started.
//
// Each test has ONE `smurg host` (the executable, every production module, the file watcher on) over a scratch folder
// that is NOT a git repository, with a scratch HOME / SMURG_HOME / cache (never the real ~/.smurg or ~/.claude), the
// fake relay of these tests with the host's relay links tunnelled to an in-memory relay, and the stand-in `claude`
// first on the host's PATH (never the real one: nothing is billed, nothing leaves the machine). The test is the host:
// it asks through the host's own link, as the web app does, and types git "in a terminal" (a scratch git identity).
//   1. The owner's flow: a topic with a SPEC.md and a one-item PLAN.md; Start is asked three times, the same share
//      all along: not a repository; after `git init`, no commit yet; after a first commit, nothing in the way, and
//      nothing of smurg's own .smurg folder was committed. Start gives the item a worktree of that commit.
//   2. `.git` moved away while an item has its worktree: Start says to put it back (never `git init`) and nothing is
//      removed; put back, Start's checks pass and the next item gets its worktree.
// Both end with `smurg stop`: the host's exit code is 0, it said nothing on stderr, and no process of the share is
// left. Only processes this test started are ever signalled, by their recorded pid.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, installFakeClaude, isolatedGitEnv, registerTestProcess, waitFor, type FakeClaude } from '@smurg/daemon/testing';
import { parseInviteUrl, topicPlanPath, topicSpecPath, type StartPreflight } from '@smurg/protocol';
import { RelayWorkspaceChannel } from '../src/channel/relay-channel.ts';
import { statePaths } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { startFakeRelay } from './fake-relay.ts';
import { isolatedEnv, makeDirs } from './helpers.ts';
import { RELEASE_GATE_ENV, SEA_BINARY_ENV, requireSeaBinary, seaBinary } from './sea-binaries.ts';

const BINARY = seaBinary();
const GATE = process.env[RELEASE_GATE_ENV] === '1';

const SKIPPED =
  `[sea-git-while-sharing] SKIPPED: a folder that becomes a git repository while it is shared was NOT tested with the packaged executable. ` +
  `It needs ${SEA_BINARY_ENV} (the build of this tree). See the top of packages/cli/test/sea-git-while-sharing.test.ts.`;
const GATE_FAILURE =
  `${RELEASE_GATE_ENV}=1 and a folder that becomes a git repository while it is shared was NOT tested with the packaged executable: ` +
  `a release's gate needs ${SEA_BINARY_ENV} (the build of this tree).`;

// Loud on purpose, and OUTSIDE any test body: the default reporter shows nothing of a skipped test (a file that is
// silently skipped reads as "covered"), so the line goes to stderr when the file is loaded.
if (BINARY === null) process.stderr.write(`\n${GATE ? `[sea-git-while-sharing] ${GATE_FAILURE}` : SKIPPED}\n\n`);

// Only what this run is gets registered: a run that tested reports its tests as passed and NOTHING as skipped, so
// "skipped" in a run's last lines always means "not tested".
if (BINARY === null && !GATE) {
  describe('a folder that becomes a git repository while it is shared, with the packaged executable', () => {
    it('NOT TESTED without SMURG_SEA_BINARY', (context) => {
      context.skip(SKIPPED);
    });
  });
}

// A release's gate: not running is a failure with the reason as a plain sentence, never a skip.
if (BINARY === null && GATE) {
  describe('a folder that becomes a git repository while it is shared: asked for by a release\'s gate and cannot run', () => {
    it('the packaged executable is tested with what SMURG_SEA_BINARY names', () => {
      throw new Error(GATE_FAILURE);
    });
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

/** The PATH of the host's terminal; the stand-in's folder is put in front of it for `smurg host`. */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): Promise<Outcome> {
  return new Promise((done) => {
    execFile(file, args, { env, cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

interface Host {
  readonly pid: number;
  readonly out: () => string;
  readonly err: () => string;
  readonly alive: () => boolean;
  readonly exited: Promise<number | null>;
}

/** `smurg host <folder>` in the foreground of a child process; ended at the test's end if it is still there. */
function startHost(bin: string, folder: string, relay: string, env: Record<string, string>): Host {
  const child: ChildProcess = spawn(bin, ['host', folder, '--relay', relay, '--no-keep-awake'], { env, cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('smurg host did not start');
  // Its command line names the scratch folder: ended after the run if this worker dies before the cleanup below.
  registerTestProcess(pid as number, folder);
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  let alive = true;
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  void exited.then(() => {
    alive = false;
  });
  cleanups.push(async () => {
    // Only the process this test spawned, by its recorded pid.
    if (alive) process.kill(pid as number, 'SIGTERM');
    await Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))]);
    if (alive) process.kill(pid as number, 'SIGKILL');
  });
  return { pid: pid as number, out: () => out, err: () => err, alive: () => alive, exited };
}

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

/** The process table (read only: nothing found in it is ever signalled). */
async function processTable(): Promise<Proc[]> {
  const { stdout } = await run('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { PATH: SYSTEM_PATH }, '/');
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] as string }));
}

function descendantsOf(table: readonly Proc[], root: number): Proc[] {
  const found: Proc[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const proc of table) {
      if (proc.ppid !== parent || found.some((one) => one.pid === proc.pid)) continue;
      found.push(proc);
      queue.push(proc.pid);
    }
  }
  return found;
}

interface PlanItem {
  readonly id: string;
  readonly title: string;
}

const SPEC_TEXT = '# Spec\n\n## Goal\nA script that prints the sum of 1 to 100.\n\n## Open questions\nNone.\n';
/** A PLAN.md as a person or the topic's agent writes it: the work items between the two marker lines. */
function planText(items: readonly PlanItem[]): string {
  const body = items.map((item, index) => `### ${index + 1}. ${item.title}\n- id: ${item.id}\n\nDo ${item.id}.`).join('\n\n');
  return `# Plan\n\nThe plan.\n\n<!-- smurg:plan v1 -->\n\n${body}\n\n<!-- smurg:plan end -->\n`;
}

/** One share: the folder, the running `smurg host`, the host's console, and git as the host types it. */
interface Share {
  readonly bin: string;
  readonly env: Record<string, string>;
  /** The shared folder: at the start one file, no `.git`, no `.smurg`. */
  readonly folder: string;
  readonly home: string;
  readonly host: Host;
  readonly channel: RelayWorkspaceChannel;
  readonly claude: FakeClaude;
  /** Scratch folders of this share: no process whose command line names one may be left. */
  readonly scratch: readonly string[];
  /** `git <args>` in `cwd` (default: the shared folder), as the host types it in a terminal. */
  git(args: readonly string[], cwd?: string): Promise<Outcome>;
}

/** Login, `smurg host` on a scratch folder that is not a git repository, and the host's console. */
async function share(bin: string): Promise<Share> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const folder = await realpath(dirs.project);
  const home = await realpath(dirs.home);
  // The stand-in claude, FIRST on the host's PATH (the daemon runs the first `claude` on the PATH of `smurg host`).
  const standIn = join(home, 'stand-in-claude');
  await mkdir(standIn);
  const claude = await installFakeClaude(standIn);
  const env = isolatedEnv(dirs, { SMURG_CACHE_DIR: join(home, 'cache'), PATH: `${standIn}:${SYSTEM_PATH}` });
  // git as the host types it: the git the host's PATH has, a scratch HOME, no global or system configuration, the
  // identity through the environment.
  const gitHome = join(home, 'git-home');
  await mkdir(gitHome);
  const gitEnv = { ...isolatedGitEnv(gitHome), PATH: SYSTEM_PATH };

  await writeFile(join(folder, 'notes.txt'), 'hello\n');
  const relay = await startFakeRelay();
  cleanups.push(() => relay.close());
  const login = await run(bin, ['login', '--relay', relay.origin, '--dev-user', 'host'], env, home);
  expect(`${login.stdout}${login.stderr}`).toContain('dev:host');
  expect(login.code).toBe(0);
  // The folder's workspace id, as an earlier `smurg host` would have remembered it (sea.test.ts's way): the in-memory
  // relay the host's sockets are tunnelled to serves one workspace, and knows its id before the host connects. Always
  // 23 characters: an id shorter than 16 is none, and `smurg host` refuses a workspace list that holds one.
  const workspaceId = `ws_git_${randomBytes(8).toString('hex')}`;
  await rememberSharedFolder(statePaths(env), { folder, relay: relay.origin, workspaceId, createdAt: 1 });
  const memory = new MemoryRelay(workspaceId);
  const issuer = new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock);
  relay.tunnel(memory, issuer);

  const host = startHost(bin, folder, relay.origin, env);
  await waitFor(() => (host.out().match(/\/join\//g) ?? []).length >= 2 || !host.alive(), { timeoutMs: 120_000, what: 'the start summary of smurg host' });
  if (!host.alive()) throw new Error(`smurg host ended (exit code ${await host.exited}) instead of sharing.\n--- stderr ---\n${host.err()}\n--- stdout ---\n${host.out()}`);
  const hostLink = (host.out().match(/https?:\/\/\S+\/join\/\S+/g) ?? [])[0] as string;
  expect((/\/join\/(ws_[A-Za-z0-9_-]+)#/.exec(hostLink) as RegExpExecArray)[1]).toBe(workspaceId);

  // The host's console: through the host's own relay link, as the web app reaches the daemon.
  await waitFor(() => memory.hostOnline('ws'), { timeoutMs: 30_000, what: 'the daemon at the (tunnelled) relay' });
  const device = await makeDirs();
  cleanups.push(() => device.cleanup());
  const invite = parseInviteUrl(hostLink);
  const channel = await RelayWorkspaceChannel.open({
    relay: memory.apiFor({ userId: 'dev:host', displayName: 'host' }, issuer),
    workspaceId,
    stateDir: device.stateDir,
    invite: { fingerprint: invite.fingerprint, secret: invite.secret },
    deviceName: 'sea git while sharing',
  });
  cleanups.push(() => channel.close());
  expect(channel.welcome.member.role).toBe('host');
  // What is shared is not a git repository, and the daemon says so.
  await expect(lstat(join(folder, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(channel.welcome.workspace.isGitRepo).toBe(false);
  return { bin, env, folder, home, host, channel, claude, scratch: [home, dirs.stateDir, device.home, device.stateDir], git: (args, cwd = folder) => run('git', args, gitEnv, cwd) };
}

interface TopicWithPlan {
  readonly topicId: string;
  /** The topic's own agent session (the discussion), started with the topic. */
  readonly sessionId: string;
  readonly specPath: string;
  readonly planPath: string;
}

/** A topic whose SPEC.md and PLAN.md are on disk, as its agent or a person writes them, and were read by the daemon. */
async function topicWithPlan(s: Share, items: readonly PlanItem[]): Promise<TopicWithPlan> {
  const created = await s.channel.request('topic.create', { name: 'Sum' });
  const topicId = created.topic.id;
  const specPath = topicSpecPath(created.topic.slug);
  const planPath = topicPlanPath(created.topic.slug);
  await mkdir(dirname(join(s.folder, specPath)), { recursive: true });
  await writeFile(join(s.folder, specPath), SPEC_TEXT);
  await writeFile(join(s.folder, planPath), planText(items));
  await waitFor(async () => (await s.channel.request('plan.get', { topicId })).plan?.items.length === items.length, { timeoutMs: 60_000, what: 'the plan to be read from disk' });
  return { topicId, sessionId: created.session.id, specPath, planPath };
}

/**
 * What the Start dialog asks before it shows itself. `itemIds`: the items the dialog was opened for (none: the plan's
 * own Start, every item that is not started).
 */
async function preflight(s: Share, topic: TopicWithPlan, itemIds?: readonly string[]): Promise<StartPreflight> {
  return (await s.channel.request('plan.preflight', { topicId: topic.topicId, ...(itemIds === undefined ? {} : { itemIds: [...itemIds] }) })).preflight;
}

const blockerIds = (asked: StartPreflight): string[] => asked.blockers.map((blocker) => blocker.text.id);

/** `git init`, typed in the shared folder while `smurg host` keeps running. */
async function gitInit(s: Share): Promise<void> {
  const init = await s.git(['init']);
  expect(init.code, init.stderr).toBe(0);
  expect(s.host.alive()).toBe(true);
}

/** `git add -A && git commit -m first`, typed in the shared folder while `smurg host` keeps running. */
async function firstCommit(s: Share): Promise<void> {
  const add = await s.git(['add', '-A']);
  expect(add.code, add.stderr).toBe(0);
  const commit = await s.git(['commit', '-m', 'first']);
  expect(commit.code, `${commit.stdout}${commit.stderr}`).toBe(0);
  expect(s.host.alive()).toBe(true);
}

async function tracked(s: Share): Promise<string[]> {
  const listed = await s.git(['ls-files']);
  expect(listed.code, listed.stderr).toBe(0);
  return listed.stdout.split('\n').filter((path) => path !== '');
}

const underSmurg = (paths: readonly string[]): string[] => paths.filter((path) => path === '.smurg' || path.startsWith('.smurg/'));

interface ItemWorktree {
  readonly worktreeId: string;
  /** The item's own agent session. */
  readonly sessionId: string;
  /** `<shared folder>/.smurg/worktrees/<worktree id>`. */
  readonly dir: string;
}

/**
 * The dialog's Start button, with the pins of what the dialog was shown (`asked`, and the same `itemIds`); then the
 * item `itemId` has a session and a worktree, which is a checkout of the commit the shared folder is at.
 */
async function start(s: Share, topic: TopicWithPlan, asked: StartPreflight, itemId: string, itemIds?: readonly string[]): Promise<ItemWorktree> {
  await s.channel.request('plan.start', { topicId: topic.topicId, ...(itemIds === undefined ? {} : { itemIds: [...itemIds] }), planRevision: asked.planRevision, specHash: asked.specHash, planHash: asked.planHash });
  const item = async () => (await s.channel.request('plan.get', { topicId: topic.topicId })).plan?.items.find((one) => one.id === itemId);
  let started = await item();
  const running = async (): Promise<boolean> => {
    started = await item();
    return started?.worktreeId !== undefined && started.sessionId !== undefined;
  };
  await waitFor(running, { timeoutMs: 60_000, what: `the item ${itemId} to get its worktree and its session` }).catch(() => {});
  expect(started, `the item ${itemId} after Start`).toMatchObject({ worktreeId: expect.any(String), sessionId: expect.any(String) });
  expect(started?.startError).toBeUndefined();
  const worktreeId = started?.worktreeId as string;
  const dir = join(s.folder, '.smurg', 'worktrees', worktreeId);
  expect((await lstat(dir)).isDirectory()).toBe(true);
  const { worktrees } = await s.channel.request('worktree.list', {});
  expect(worktrees.find((one) => one.id === worktreeId)).toMatchObject({ topicId: topic.topicId, itemId });
  const head = await s.git(['rev-parse', 'HEAD']);
  expect(head.code, head.stderr).toBe(0);
  expect((await s.git(['rev-parse', 'HEAD'], dir)).stdout).toBe(head.stdout);
  expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('hello\n');
  return { worktreeId, sessionId: started?.sessionId as string, dir };
}

/** The agent sessions were started through the stand-in `claude` (the first on the host's PATH), never another one. */
async function startedByTheStandIn(s: Share, sessionIds: readonly string[]): Promise<void> {
  const launched = async (): Promise<(string | null)[]> => (await s.claude.echoed()).filter((entry) => entry.kind === 'argv').map((entry) => entry.session);
  let sessions: (string | null)[] = [];
  const all = async (): Promise<boolean> => {
    sessions = await launched();
    return sessionIds.every((id) => sessions.includes(id));
  };
  await waitFor(all, { timeoutMs: 60_000, what: 'the stand-in claude to be started for every agent session' }).catch(() => {});
  expect(sessions, 'the agent sessions the stand-in claude was started for').toEqual(expect.arrayContaining([...sessionIds]));
}

/** `smurg stop`, typed in the shared folder: the host's exit code is 0, its stderr is empty, and no process is left. */
async function stopAndNothingLeft(s: Share): Promise<void> {
  const children = descendantsOf(await processTable(), s.host.pid);
  s.channel.close();
  const stop = await run(s.bin, ['stop'], s.env, s.folder);
  expect(stop.stdout).toContain('Stopped sharing.');
  expect(stop.stderr).toBe('');
  expect(stop.code).toBe(0);
  expect(await s.host.exited).toBe(0);
  expect(s.host.err(), 'smurg host said nothing on stderr').toBe('');
  expect(s.host.out()).toContain('Stopped sharing.');
  // The host itself has ended. Left would be: what was a process of the host just before the stop (the stand-ins of
  // the agent sessions, their helpers) and is still there with the SAME command line (a pid that was given to another
  // process has another one), or anything whose command line names a scratch folder of this share.
  const mine = new Map<number, string>(children.map((proc): [number, string] => [proc.pid, proc.command]));
  let left: Proc[] = [];
  const none = async (): Promise<boolean> => {
    left = (await processTable()).filter((proc) => proc.pid !== process.pid && (mine.get(proc.pid) === proc.command || s.scratch.some((dir) => proc.command.includes(dir))));
    return left.length === 0;
  };
  await waitFor(none, { timeoutMs: 30_000, what: 'the processes of the share to end' }).catch(() => {});
  expect(left, 'processes of this share that are left after smurg stop').toEqual([]);
}

if (BINARY !== null) {
  const bin = BINARY;

  describe('a folder that becomes a git repository while it is shared, with the packaged executable (SMURG_SEA_BINARY)', () => {
    // A named executable that is not there: one plain sentence, before anything is started.
    beforeAll(() => requireSeaBinary());

    it('not a repository, `git init`, a first commit: Start names each reason in turn, then gives the item a worktree, in ONE share; smurg stop leaves nothing', async () => {
      const item = { id: 'sum-1-to-100', title: 'Add sum_1_to_100.py' };
      const s = await share(bin);
      const topic = await topicWithPlan(s, [item]);

      // ---- not a git repository: the one thing in the way, and no commit to speak of
      const notARepository = await preflight(s, topic);
      expect(blockerIds(notARepository)).toEqual(['worktree.unavailable.notAGitRepo']);
      expect(notARepository.commit).toBeNull();
      expect(notARepository.startsNow).toEqual([item.id]);
      // smurg made no repository itself, and its own folder ignores itself before there is one: a host who now runs
      // `git init && git add -A && git commit` commits nothing of it (the share lock, trash, uploads, worktrees).
      await expect(lstat(join(s.folder, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(join(s.folder, '.smurg', '.gitignore'), 'utf8')).split('\n')).toContain('*');

      // ---- `git init` while the folder stays shared: now it is the commit that is missing
      await gitInit(s);
      const noCommit = await preflight(s, topic);
      expect(blockerIds(noCommit)).toEqual(['worktree.unavailable.noCommit']);
      expect(noCommit.commit).toBeNull();
      expect(noCommit.startsNow).toEqual([item.id]);

      // ---- a first commit of everything: nothing of .smurg is in it, and nothing is in the way of Start
      await firstCommit(s);
      const committed = await tracked(s);
      expect(committed).toEqual(expect.arrayContaining(['notes.txt', topic.specPath, topic.planPath]));
      expect(underSmurg(committed)).toEqual([]);
      const ready = await preflight(s, topic);
      expect(blockerIds(ready)).toEqual([]);
      const branch = (await s.git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
      expect(ready.commit).toMatchObject({ needed: false, branch, files: [topic.specPath, topic.planPath] });
      expect(ready.startsNow).toEqual([item.id]);

      // ---- Start: the item runs in a worktree of that commit; what git tracks is what it tracked, nothing of .smurg
      const worktree = await start(s, topic, ready, item.id);
      const trackedAfterStart = await tracked(s);
      expect(underSmurg(trackedAfterStart)).toEqual([]);
      expect(trackedAfterStart).toEqual(committed);
      await startedByTheStandIn(s, [topic.sessionId, worktree.sessionId]);
      expect(s.host.alive()).toBe(true);

      await stopAndNothingLeft(s);
      // The item's worktree is kept for the next share.
      expect((await lstat(worktree.dir)).isDirectory()).toBe(true);
    }, 600_000);

    it('`.git` moved away while an item has its worktree: Start says to put it back and nothing is removed; put back, the next item gets its worktree', async () => {
      const first = { id: 'sum-1-to-100', title: 'Add sum_1_to_100.py' };
      const second = { id: 'sum-tests', title: 'Add a test of the sum' };
      const s = await share(bin);
      const topic = await topicWithPlan(s, [first, second]);
      // The folder became a repository while it was shared (as in the test above), and the first item was started.
      await gitInit(s);
      await firstCommit(s);
      const ready = await preflight(s, topic, [first.id]);
      expect(blockerIds(ready)).toEqual([]);
      const worktree = await start(s, topic, ready, first.id, [first.id]);

      // ---- `.git` goes (moved out of the shared folder) while the first item has its worktree
      const away = join(s.home, 'git-moved-away');
      await rename(join(s.folder, '.git'), away);
      const gone = await preflight(s, topic);
      expect(blockerIds(gone)).toEqual(['worktree.unavailable.gitDirGone']);
      expect(gone.commit).toBeNull();
      expect(gone.startsNow).toEqual([second.id]);
      expect(gone.alreadyStarted).toEqual([first.id]);
      // smurg made no repository of its own in its place, and removed nothing: the worktree, its record, the item's.
      await expect(lstat(join(s.folder, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(worktree.dir, 'notes.txt'), 'utf8')).toBe('hello\n');
      expect((await s.channel.request('worktree.list', {})).worktrees.map((one) => one.id)).toEqual([worktree.worktreeId]);
      expect((await s.channel.request('plan.get', { topicId: topic.topicId })).plan?.items.find((one) => one.id === first.id)).toMatchObject({ worktreeId: worktree.worktreeId, sessionId: worktree.sessionId });
      expect(await readFile(join(s.folder, 'notes.txt'), 'utf8')).toBe('hello\n');

      // ---- put back: Start's checks pass again in the same share, and the next item starts
      await rename(away, join(s.folder, '.git'));
      const back = await preflight(s, topic);
      expect(blockerIds(back)).toEqual([]);
      expect(back.commit).not.toBeNull();
      expect(back.startsNow).toEqual([second.id]);
      const next = await start(s, topic, back, second.id);
      expect(next.worktreeId).not.toBe(worktree.worktreeId);
      expect((await s.channel.request('worktree.list', {})).worktrees.map((one) => one.id).sort()).toEqual([worktree.worktreeId, next.worktreeId].sort());
      expect(underSmurg(await tracked(s))).toEqual([]);
      await startedByTheStandIn(s, [topic.sessionId, worktree.sessionId, next.sessionId]);

      await stopAndNothingLeft(s);
    }, 600_000);
  });
}
