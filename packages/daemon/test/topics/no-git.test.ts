// Topics without git (DESIGN 0.6.0 D14, D15), in the release composition with the stand-in `claude` (the worktree module
// given its git program, so a test can make git missing or too old); every other module is the one `smurg host` runs.
//  - A folder without `.git` (the real git on PATH): Start offers smurg's own history (`history: 'smurg'`), records the
//    whole folder, and an item runs in a worktree of that history: what its agent installs (node_modules) is never in
//    its diff, its change merges into the folder, and the folder's own node_modules stays untouched.
//  - Without a usable git program: Start says so (`history: 'direct'`, the reason, `hostOnly` for anyone but the host);
//    only the host starts, and only after confirming; the items run in the shared folder itself, one at a time, with
//    the direct role prompt; the report has no diff (`no-history`) and counts as merged at registration; a follow-up
//    to an earlier item waits for the folder while another item works (`conversation.direct.waits`) and runs before
//    the next item starts; the review ends the session (`reviewed`).
//  - An item starts only in the history its Start used: a retry of a worktree item after git went missing, or an armed
//    item of smurg's history after `.smurg/git` was tampered with, is disarmed with `plan.start.historyChanged`, and
//    nothing runs in the folder.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, topicPlanPath, topicReportPath, topicSpecPath, type ConversationEvent, type HostSettings, type PlanInfo } from '@smurg/protocol';
import { DEFAULT_FEATURE_MODULES } from '../../src/daemon.ts';
import type { PlanServiceImpl } from '../../src/topics/plan-service.ts';
import {
  TEST_HOST_USER,
  createTempDir,
  createTempProject,
  createTempRunDir,
  createTestDaemon,
  installFakeClaude,
  isolatedGitEnv,
  removeTempDir,
  removeTempRunDir,
  waitFor,
  type FakeClaude,
  type FakeClaudeStep,
  type TestClient,
  type TestDaemon,
} from '../../src/testing/index.ts';
import { GIT_MIN_VERSION, findGit, gitVersionAtLeast, parseGitVersion } from '../../src/worktree/git.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import { CLI_MAIN } from '../integration/support.ts';
import { SPEC_TEXT, planText, reportText } from './support.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function realGit(): Promise<string | null> {
  const path = await findGit(process.env['PATH']);
  if (path === null) return null;
  const version = parseGitVersion(await run(path, ['version']).then((result) => result.stdout, () => ''));
  return version !== null && gitVersionAtLeast(version, GIT_MIN_VERSION) ? path : null;
}
const GIT = await realGit();
if (GIT === null) console.warn(`[no-git] SKIPPED: these tests need git ${GIT_MIN_VERSION.join('.')} or later on PATH`);
const withGit = GIT === null ? describe.skip : describe;

const SLUG = 'checkout';
const MEI = 'dev:mei';

interface Stack {
  readonly d: TestDaemon;
  readonly claude: FakeClaude;
  readonly root: string;
  readonly ian: TestClient;
  readonly mei: TestClient;
  /** Stops the daemon and starts it again on the same folder and state (`gitPath`: the git program of the new run). */
  restart(gitPath?: string): Promise<void>;
  git(args: readonly string[], cwd?: string): Promise<string>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
}, 120_000);

async function startStack(options: { readonly git: boolean; readonly gitPath?: string; readonly files?: Readonly<Record<string, string>>; readonly settings?: Partial<HostSettings> }): Promise<Stack> {
  const base = await createTempDir('no-git-topics');
  const stateDir = await createTempRunDir();
  cleanups.push(async () => {
    await removeTempDir(base);
    await removeTempRunDir(stateDir);
  });
  const root = await createTempProject(base, 'project', { files: { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const app = 1;\n', ...options.files }, git: options.git });
  const hostHome = join(base, 'home');
  await mkdir(hostHome, { recursive: true });
  const claude = await installFakeClaude(base);
  const workspaceId = `ws_test_nogit_${Math.random().toString(36).slice(2, 10)}`;
  const gitEnv = isolatedGitEnv(join(base, '.git-home'));
  let d: TestDaemon | null = null;
  let people: { ian: TestClient; mei: TestClient } | null = null;
  const boot = async (gitPath: string | undefined): Promise<void> => {
    const modules = DEFAULT_FEATURE_MODULES.map((module) => (module.name === 'worktree' ? createWorktreeModule({ ...(gitPath === undefined ? {} : { gitPath }), limits: { treeCheckDelayMs: 100 } }) : module));
    d = await createTestDaemon({
      root,
      stateDir,
      workspaceId,
      modules,
      agents: { escalationSweepMs: 15 },
      settings: { maxLiveAgents: 8, ...options.settings },
      sessions: { claudePath: claude.path, hostHome, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
    });
    people = {
      ian: await d.connect({ userId: TEST_HOST_USER, displayName: 'Ian', role: 'host' }),
      mei: await d.connect({ userId: MEI, displayName: 'Mei', role: 'agent' }),
    };
  };
  const stop = async (): Promise<void> => {
    const running = d;
    d = null;
    people = null;
    await running?.cleanup();
  };
  cleanups.push(stop);
  await boot(options.gitPath);
  return {
    get d() {
      if (d === null) throw new Error('stopped');
      return d;
    },
    claude,
    root,
    get ian() {
      if (people === null) throw new Error('stopped');
      return people.ian;
    },
    get mei() {
      if (people === null) throw new Error('stopped');
      return people.mei;
    },
    restart: async (gitPath) => {
      await stop();
      await boot(gitPath);
    },
    git: async (args, cwd = root) => (await run('git', [...args], { cwd, env: gitEnv, maxBuffer: 16 * 1024 * 1024 })).stdout,
  };
}

/** A topic whose spec and plan are in the folder (the stand-in's discussion is not asked for them). */
async function topicWithPlan(s: Stack, items: readonly { id: string; title?: string; dependsOn?: string[] }[]): Promise<string> {
  const { topic } = await s.ian.conn.request('topic.create', { name: 'Checkout' });
  await mkdir(join(s.root, 'specs', SLUG), { recursive: true });
  await writeFile(join(s.root, topicSpecPath(SLUG)), SPEC_TEXT);
  await writeFile(join(s.root, topicPlanPath(SLUG)), planText(items));
  s.d.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: topicPlanPath(SLUG), change: 'add' }] });
  await waitFor(() => s.d.ctx.services.plans.get(topic.id)?.items.length === items.length, { timeoutMs: 20_000, what: 'the plan to be read' });
  return topic.id;
}

const handIn = (itemId: string, done?: string): FakeClaudeStep[] => [
  { tool: 'Write', input: { file_path: topicReportPath(SLUG, itemId), content: reportText(itemId, done === undefined ? {} : { done }) } },
  { tool: 'mcp__smurg__check_report', input: {} },
  { text: 'Done.' },
];

const planOf = (s: Stack, topicId: string): PlanInfo => s.d.ctx.services.plans.get(topicId) as PlanInfo;
const itemOf = (s: Stack, topicId: string, itemId: string) => planOf(s, topicId).items.find((item) => item.id === itemId);
async function planIs(s: Stack, topicId: string, fits: (plan: PlanInfo) => boolean, what: string): Promise<PlanInfo> {
  await waitFor(() => fits(planOf(s, topicId)), { timeoutMs: 30_000, what });
  return planOf(s, topicId);
}
async function eventsOf(s: Stack, sessionId: string): Promise<ConversationEvent[]> {
  return (await s.ian.conn.request('session.watch', { sessionId })).events;
}
const lineIds = (events: readonly ConversationEvent[]): string[] => events.flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));
async function refusal(promise: Promise<unknown>): Promise<{ code?: string; reason?: string; id?: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const e = err as { code?: string; detail?: Record<string, unknown>; text?: { id: string } };
    return { ...(e.code === undefined ? {} : { code: e.code }), ...(typeof e.detail?.['reason'] === 'string' ? { reason: e.detail['reason'] } : {}), ...(e.text === undefined ? {} : { id: e.text.id }) };
  }
}
async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

// ---------------------------------------------------------------------------------------------------------------------

withGit('a folder without .git: smurg\'s own history (DESIGN 0.6.0 D14)', { timeout: 240_000 }, () => {
  it('Start records the folder in smurg\'s history; an item that installs dependencies merges only its change, and the folder\'s own node_modules stays', async () => {
    const s = await startStack({ git: false, files: { 'node_modules/existing/index.js': 'module.exports = "mine";\n' } });
    await s.claude.setScenario({
      turns: [
        {
          match: 'Start work item 1 ',
          steps: [
            { tool: 'Bash', input: { command: 'mkdir -p node_modules/left-pad && echo "module.exports = 1;" > node_modules/left-pad/index.js' }, run: true },
            { tool: 'Write', input: { file_path: 'src/cart.ts', content: 'export const cart: string[] = [];\n' } },
            ...handIn('cart-api'),
          ],
        },
        { match: 'Start work item 2 ', steps: [{ tool: 'Write', input: { file_path: 'src/page.ts', content: 'export {};\n' } }, ...handIn('checkout-page')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await topicWithPlan(s, [{ id: 'cart-api', title: 'Cart API' }, { id: 'checkout-page', title: 'Checkout page', dependsOn: ['cart-api'] }]);
    await s.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
    const { preflight } = await s.mei.conn.request('plan.preflight', { topicId });
    // (0.5.2 refused this Start: "not a git repository")
    expect(preflight).toMatchObject({ history: 'smurg', direct: null, commit: null, blockers: [], nestedRepos: [], cloudSynced: false });
    expect(s.d.ctx.services.worktrees.workState()).toEqual({ history: 'smurg' });
    await s.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
    expect(await exists(join(s.root, '.git'))).toBe(false);
    const hidden = join(s.root, '.smurg', 'git');
    const log = (await s.git(['--git-dir', hidden, 'log', '--format=%s'])).split('\n').filter(Boolean);
    expect(log).toContain('smurg: spec and plan of checkout');
    const recorded = (await s.git(['--git-dir', hidden, 'ls-tree', '-r', '--name-only', 'HEAD'])).split('\n').filter(Boolean);
    expect(recorded).toEqual(expect.arrayContaining(['README.md', 'src/app.ts', topicSpecPath(SLUG), topicPlanPath(SLUG)]));
    expect(recorded.some((path) => path.startsWith('node_modules/') || path.startsWith('.smurg/'))).toBe(false);

    const done = await planIs(s, topicId, (plan) => plan.items[0]?.state === 'done' && plan.items[0]?.merge?.status === 'draft', 'the first report with its draft');
    const requestId = done.items[0]?.merge?.requestId as string;
    const diff = await s.ian.conn.request('worktree.merge.diff', { requestId });
    expect(diff.files.map((file) => file.path).sort()).toEqual(['src/cart.ts', topicReportPath(SLUG, 'cart-api')].sort());
    expect((await s.ian.conn.request('worktree.merge.approve', { requestId })).request.status).toBe('merged');
    expect(await readFile(join(s.root, 'src', 'cart.ts'), 'utf8')).toBe('export const cart: string[] = [];\n');
    expect(await readFile(join(s.root, 'node_modules', 'existing', 'index.js'), 'utf8')).toBe('module.exports = "mine";\n');
    expect(await exists(join(s.root, 'node_modules', 'left-pad'))).toBe(false);
    // What depended on it starts, in a worktree of smurg's history that already has the merged change.
    const next = await planIs(s, topicId, (plan) => plan.items[1]?.state === 'running' || plan.items[1]?.state === 'done', 'the dependent item to start');
    const page = s.d.ctx.roots.get({ kind: 'worktree', worktreeId: next.items[1]?.worktreeId as string });
    expect(await readFile(join(page?.realPath as string, 'src', 'cart.ts'), 'utf8')).toContain('cart');
  });

  it('an armed item of smurg\'s history whose .smurg/git was tampered with is disarmed with "historyChanged", and nothing runs', async () => {
    const s = await startStack({ git: false });
    await s.claude.setScenario({ turns: [{ match: 'Start work item 1 ', steps: [{ text: 'thinking' }] }, { steps: [{ text: 'ok' }] }] });
    const topicId = await topicWithPlan(s, [{ id: 'cart-api' }, { id: 'checkout-page', dependsOn: ['cart-api'] }]);
    const { preflight } = await s.mei.conn.request('plan.preflight', { topicId });
    await s.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
    await planIs(s, topicId, (plan) => plan.items[1]?.state === 'waiting', 'the second item to wait');
    const sessionsBefore = (await s.ian.conn.request('session.list', { topicId })).sessions.length;
    const config = join(s.root, '.smurg', 'git', 'config');
    await writeFile(config, `${await readFile(config, 'utf8')}[core]\n\tfsmonitor = /tmp/x\n`);
    await (s.d.ctx.services.plans as PlanServiceImpl).settle();
    const disarmed = await planIs(s, topicId, (plan) => plan.items[1]?.disarmed !== undefined, 'the waiting item to be disarmed');
    expect(disarmed.items[1]).toMatchObject({ armed: false, disarmed: 'start-failed', startError: { text: { id: 'plan.start.historyChanged' } } });
    expect((await s.ian.conn.request('session.list', { topicId })).sessions.length).toBe(sessionsBefore);
  });
});

withGit('how work items run here is every member\'s to know (HostState.work, DESIGN 0.6.0 D5)', { timeout: 120_000 }, () => {
  it('a folder without .git has smurg\'s own history; `git init` while sharing makes it the folder\'s, and everyone is told', async () => {
    const s = await startStack({ git: false });
    expect((await s.mei.conn.request('session.host.get', {})).work).toEqual({ history: 'smurg' });
    const told: string[] = [];
    s.mei.conn.on('session.host', (payload) => told.push(payload.work.history));
    await s.git(['init', '-q', '-b', 'main']);
    await s.d.ctx.services.worktrees.refreshGitState();
    await waitFor(() => told.includes('folder'), { timeoutMs: 10_000, what: 'session.host with the folder\'s own history' });
    expect((await s.mei.conn.request('session.host.get', {})).work).toEqual({ history: 'folder' });
  });

  it('without a usable git program: `direct`, with the reason', async () => {
    const s = await startStack({ git: false, gitPath: '/nonexistent/smurg-test/git' });
    expect((await s.ian.conn.request('session.host.get', {})).work).toMatchObject({ history: 'direct', reason: { text: { id: 'worktree.unavailable.gitCannotRun' } } });
  });
});

withGit('an item starts only in the history its Start used (DESIGN 0.6.0 D15)', { timeout: 240_000 }, () => {
  it('"Try again" of a worktree item after git went missing is disarmed with "historyChanged": no session, nothing in the folder', async () => {
    const s = await startStack({ git: true });
    await s.claude.setScenario({ turns: [{ match: 'Start work item 1 ', steps: [{ text: 'thinking' }] }, { steps: [{ text: 'ok' }] }] });
    const topicId = await topicWithPlan(s, [{ id: 'cart-api' }]);
    const { preflight } = await s.mei.conn.request('plan.preflight', { topicId });
    expect(preflight.history).toBe('folder');
    await s.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
    const running = await planIs(s, topicId, (plan) => plan.items[0]?.sessionId !== undefined, 'the item to start');
    const sessionId = running.items[0]?.sessionId as string;
    await s.d.ctx.services.agents.end(sessionId, { by: { kind: 'system' }, reason: 'ended', keepWorktree: true });
    await planIs(s, topicId, (plan) => plan.items[0]?.state === 'stopped', 'the item to be stopped');
    const head = await s.git(['rev-parse', 'HEAD']);

    // The next run of smurg finds no git program.
    await s.restart(join(s.root, '..', 'no-such-git'));
    expect(s.d.ctx.services.worktrees.workState()).toMatchObject({ history: 'direct' });
    await s.mei.conn.request('plan.item.retry', { topicId, itemId: 'cart-api' });
    const disarmed = await planIs(s, topicId, (plan) => plan.items[0]?.disarmed !== undefined, 'the retried item to be disarmed');
    expect(disarmed.items[0]).toMatchObject({ armed: false, disarmed: 'start-failed', startError: { text: { id: 'plan.start.historyChanged' } }, sessionId });
    expect((await s.ian.conn.request('session.list', { topicId })).sessions.filter((session) => session.kind === 'agent' && session.purpose === 'item')).toHaveLength(1);
    expect(await s.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(await s.git(['status', '--porcelain', '--', 'src'])).toBe('');
  });
});

describe('without a usable git program: work items run directly in the shared folder (DESIGN 0.6.0 D15)', { timeout: 240_000 }, () => {
  it('the host alone starts them after confirming; one at a time in the folder itself; no diff; a follow-up waits for the folder and runs before the next item; the review ends the session', async () => {
    const bin = await createTempDir('no-git-old');
    cleanups.push(() => removeTempDir(bin));
    const oldGit = join(bin, 'git');
    await writeFile(oldGit, '#!/bin/sh\nif [ "$1" = version ]; then echo "git version 2.39.5"; exit 0; fi\nexit 1\n', { mode: 0o755 });
    const s = await startStack({ git: false, gitPath: oldGit });
    await s.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [{ tool: 'Write', input: { file_path: 'src/cart.ts', content: 'export const cart = 1;\n' } }, ...handIn('cart-api', 'Created src/cart.ts.')] },
        { match: 'Start work item 2 ', steps: [{ sleep: 2_500 }, { tool: 'Write', input: { file_path: 'src/pay.ts', content: 'export const pay = 1;\n' } }, ...handIn('payment-form', 'Created src/pay.ts.')] },
        { match: 'Start work item 3 ', steps: [{ tool: 'Write', input: { file_path: 'src/page.ts', content: 'export const page = 1;\n' } }, ...handIn('checkout-page', 'Created src/page.ts.')] },
        { match: 'also handle empty carts', steps: [{ tool: 'Write', input: { file_path: 'src/empty.ts', content: 'export const empty = true;\n' } }, { text: 'Added.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const order: string[] = [];
    s.d.ctx.bus.on('agent.turn.started', (event) => order.push(`started:${event.sessionId}`));
    s.d.ctx.bus.on('agent.turn.finished', (event) => order.push(`finished:${event.sessionId}`));
    s.d.ctx.bus.on('session.created', (event) => {
      if (event.session.kind === 'agent' && event.session.purpose === 'item') order.push(`created:${event.session.itemId ?? ''}`);
    });
    const topicId = await topicWithPlan(s, [{ id: 'cart-api' }, { id: 'payment-form' }, { id: 'checkout-page', dependsOn: ['cart-api'] }]);
    await s.ian.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: TEST_HOST_USER });

    // ---- the Start dialog: no blocker, the reason, and who may start ----
    const forMei = (await s.mei.conn.request('plan.preflight', { topicId })).preflight;
    expect(forMei).toMatchObject({ history: 'direct', blockers: [], commit: null, direct: { hostOnly: true, reason: { text: { id: 'worktree.unavailable.gitTooOld' } } } });
    const forIan = (await s.ian.conn.request('plan.preflight', { topicId })).preflight;
    expect(forIan).toMatchObject({ history: 'direct', direct: { hostOnly: false } });
    const pins = { topicId, planRevision: forIan.planRevision, specHash: forIan.specHash, planHash: forIan.planHash };
    expect(await refusal(s.mei.conn.request('plan.start', { ...pins, direct: true }))).toMatchObject({ code: 'forbidden', reason: 'direct-host-only', id: 'plan.start.directHostOnly' });
    expect(await refusal(s.ian.conn.request('plan.start', pins))).toMatchObject({ code: 'conflict', reason: 'direct-unconfirmed', id: 'plan.start.directUnconfirmed' });
    expect(planOf(s, topicId).items.every((item) => !item.armed)).toBe(true);

    // ---- the host confirms: the first item runs in the folder itself, the others wait their turn ----
    const started = (await s.ian.conn.request('plan.start', { ...pins, direct: true })).plan;
    expect(started.items.map((item) => item.state)).toEqual(['running', 'queued', 'waiting']);
    const one = started.items[0];
    expect(one?.worktreeId).toBeUndefined();
    const sessionOne = one?.sessionId as string;
    const listed = (await s.ian.conn.request('session.list', { topicId })).sessions.find((session) => session.id === sessionOne);
    expect(listed).toMatchObject({ purpose: 'item', root: { kind: 'main' } });
    const rolesOf = async (): Promise<string[]> => (await s.claude.echoed()).filter((entry) => entry.kind === 'role-prompt' && entry.session === sessionOne).map((entry) => String(entry.value));
    await waitFor(async () => (await rolesOf()).length > 0, { timeoutMs: 10_000, what: 'the first item\'s process to start' });
    const roles = await rolesOf();
    expect(roles.at(-1)).toContain('Your working directory is the shared folder itself');
    expect(roles.at(-1)).toContain('Do not use git in this folder.');
    expect(roles.at(-1)).not.toContain('This checkout is fresh');
    expect(lineIds(await eventsOf(s, sessionOne))).toContain('conversation.started.itemDirect');
    expect(await refusal(s.mei.conn.request('plan.item.retry', { topicId, itemId: 'cart-api' }))).toMatchObject({ code: 'forbidden', reason: 'direct-host-only' });

    // ---- its report: no diff, merged at registration; the next item takes the folder ----
    await planIs(s, topicId, (plan) => plan.items[0]?.state === 'done', 'the first report');
    expect(await readFile(join(s.root, 'src', 'cart.ts'), 'utf8')).toBe('export const cart = 1;\n');
    const report = (await s.ian.conn.request('report.get', { topicId, itemId: 'cart-api' })).report;
    expect(report).toMatchObject({ version: 1, noChanges: 'no-history', file: { root: { kind: 'main' } } });
    expect(report.changes).toBeUndefined();
    expect(s.d.ctx.services.topics.get(topicId)?.plan.merged).toBe(1);
    const second = await planIs(s, topicId, (plan) => plan.items[1]?.state === 'running', 'the second item to start');
    // One at a time: the third (its dependency is merged) waits for the folder.
    expect(second.items[2]?.state).toBe('queued');

    // ---- a follow-up to the first item while the second works: it waits for the folder ----
    const followUp = await s.ian.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Please also handle empty carts.' });
    expect('messageId' in followUp).toBe(true);
    await waitFor(async () => lineIds(await eventsOf(s, sessionOne)).includes('conversation.direct.waits'), { timeoutMs: 10_000, what: 'the line that the message waits' });
    expect(itemOf(s, topicId, 'payment-form')?.state).toBe('running');
    expect(await exists(join(s.root, 'src', 'empty.ts'))).toBe(false);

    // ---- the second item finishes; the follow-up runs; only then the third item starts ----
    await waitFor(() => itemOf(s, topicId, 'checkout-page')?.state === 'done', { timeoutMs: 60_000, what: 'the third item to finish' });
    expect(await readFile(join(s.root, 'src', 'empty.ts'), 'utf8')).toBe('export const empty = true;\n');
    const sessionTwo = itemOf(s, topicId, 'payment-form')?.sessionId as string;
    const lastOfOne = order.lastIndexOf(`finished:${sessionOne}`);
    const finishedTwo = order.indexOf(`finished:${sessionTwo}`);
    const createdThree = order.indexOf('created:checkout-page');
    expect(finishedTwo).toBeGreaterThan(-1);
    expect(lastOfOne).toBeGreaterThan(finishedTwo);
    expect(createdThree).toBeGreaterThan(lastOfOne);
    // No turn of one direct item ran while another one's did.
    let open: string | null = null;
    for (const entry of order) {
      const [what, sessionId] = entry.split(':') as [string, string];
      if (what === 'started') {
        expect(open === null || open === sessionId, `${entry} while ${open} runs`).toBe(true);
        open = sessionId;
      } else if (what === 'finished' && open === sessionId) open = null;
    }

    // ---- reviewed: the item is complete and its session ends ----
    await s.ian.conn.request('report.review', { topicId, itemId: 'cart-api', version: (await s.ian.conn.request('report.get', { topicId, itemId: 'cart-api' })).report.version });
    await waitFor(async () => (await s.ian.conn.request('session.list', { topicId })).sessions.find((session) => session.id === sessionOne)?.status === 'ended', { timeoutMs: 20_000, what: 'the reviewed item\'s session to end' });
    expect((await s.ian.conn.request('session.list', { topicId })).sessions.find((session) => session.id === sessionOne)?.endReason).toBe('reviewed');
    expect(lineIds(await eventsOf(s, sessionOne))).toContain('conversation.ended.reviewed');
    expect(itemOf(s, topicId, 'cart-api')?.state).toBe('reviewed');
    // Nothing of git was made: no history of smurg's, no `.git`.
    expect(await exists(join(s.root, '.smurg', 'git'))).toBe(false);
    expect(await exists(join(s.root, '.git'))).toBe(false);
  });
});
