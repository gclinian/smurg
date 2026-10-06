// `smurg status` and `smurg stop` through their modules (injected io) against a daemon whose state dir is SMURG_HOME,
// so the CLI finds its control socket as in production. Output and exit codes (3 when nothing runs). What the daemon
// reports about agents (DESIGN v0.5.0 §6: Claude Code, the agent sessions by state, topics, the folder's project
// settings, the host's own rules) is shown from a daemon whose agent services are the in-memory fakes, and, for the
// states of Claude Code, from a stand-in control socket that answers a status this test wrote.
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, createDaemon, createLocalControlModule, encodeCtlControl, runPathsFor, silentLogger, type CtlStatus, type Daemon } from '@smurg/daemon';
import { buildAgentSession, buildTopic, fakesModule, fakesOf, type Fakes } from '@smurg/daemon/fakes';
import { waitFor } from '@smurg/daemon/testing';
import { MAIN_ROOT, type AgentStatus } from '@smurg/protocol';
import { runCli } from '../src/cli/run.ts';
import { agentsPausedNotice, claudeState, liveAgentSessions } from '../src/cli/agents-text.ts';
import { renderText } from '../src/i18n/index.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { statePaths } from '../src/state/paths.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)().catch(() => {});
});

async function hostDaemon(dirs: Dirs, workspaceId: string, folder = dirs.project): Promise<Daemon> {
  const daemon = await createDaemon({
    config: { stateDir: dirs.stateDir, shareDir: folder, workspaceId, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
    modules: DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local'),
    log: silentLogger,
    homeDir: dirs.home,
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

async function setup(): Promise<{ dirs: Dirs; env: Record<string, string> }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  return { dirs, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } };
}

/** A daemon whose agent services (sessions, topics, the trust gate, the host's rules) are fakes a test fills. */
async function agentDaemon(dirs: Dirs, workspaceId: string): Promise<{ daemon: Daemon; fakes: Fakes }> {
  const control = createLocalControlModule();
  const daemon = await createDaemon({
    config: { stateDir: dirs.stateDir, shareDir: dirs.project, workspaceId, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
    modules: [fakesModule(), control],
    log: silentLogger,
    homeDir: dirs.home,
  });
  await daemon.start();
  cleanups.push(async () => {
    await daemon.stop();
    await control.whenClosed();
  });
  return { daemon, fakes: fakesOf(daemon.ctx) };
}

/** Agent sessions of the given states, as the sessions module would hold them. */
function adopt(fakes: Fakes, statuses: readonly AgentStatus[]): void {
  statuses.forEach((status, index) => fakes.agents.adopt(buildAgentSession({ id: `ses_status_${index}`, status, createdAt: index + 1 })));
}

const STATUS_BASE: CtlStatus = {
  workspaceId: 'ws_status_standin0001',
  started: true,
  stopped: false,
  relay: { interactive: 'online', transfer: 'online' },
  connections: 2,
  onlineMembers: 1,
  power: { active: false, mechanism: 'none', pid: null, reason: 'disabled' },
  handshakes: { handshakes: 0, accepted: 0, failed: 0, refusedByRateLimit: 0, kickedForFailures: 0, kickedIdle: 0 },
  fingerprint: '0000 1111',
  relayUrl: 'https://app.example',
  switches: { attributeBashEdits: true },
  isGitRepo: true,
};

/**
 * A stand-in for a daemon's control socket in SMURG_HOME's run dir: it answers every request with this status (one
 * control frame, as the daemon's control server does) and closes. Nothing is started and nothing is signalled.
 */
async function controlSocketWith(env: Record<string, string>, status: CtlStatus): Promise<void> {
  const path = runPathsFor(statePaths(env).runDir, status.workspaceId).ctl;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.once('data', () => socket.end(encodeCtlControl({ ok: true, op: 'status', status, webOrigin: 'https://app.example' })));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

describe('smurg status', () => {
  it('says that nothing is shared (exit 3) when no daemon runs', async () => {
    const { env } = await setup();
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(3);
    expect(io.out()).toContain('No workspace is being shared.');
  });

  it('lists every running daemon with its relay, connections, fingerprint, keep-awake, the Bash-attribution switch and log file', async () => {
    const { dirs, env } = await setup();
    const a = await hostDaemon(dirs, 'ws_status_aaaaaaaaaaaa');
    const other = join(dirs.home, 'other');
    await (await import('node:fs/promises')).mkdir(other);
    await hostDaemon(dirs, 'ws_status_bbbbbbbbbbbb', other);
    await rememberSharedFolder(statePaths(env), { folder: dirs.project, relay: 'http://localhost:8787', workspaceId: 'ws_status_aaaaaaaaaaaa', createdAt: 1 });
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(0);
    expect(io.out()).toContain('Workspace ws_status_aaaaaaaaaaaa');
    expect(io.out()).toContain('Workspace ws_status_bbbbbbbbbbbb');
    expect(io.out()).toContain(`  Folder: ${dirs.project}\n`);
    // The same zh-TW words as the host's summary, never the daemon's English reason.
    expect(io.out()).toContain('  Keep-awake: off (turned off with --no-keep-awake)\n');
    expect(io.out()).not.toContain('disabled');
    expect(io.out()).toContain(`  Daemon process: ${process.pid}`);
    // What `smurg host` no longer prints at the start (owner decision 2026-10-01).
    expect(io.out()).toContain(`  Daemon key fingerprint: ${a.fingerprint}\n`);
    expect(io.out()).toContain(`  Log: ${join(dirs.stateDir, 'logs', 'ws_status_aaaaaaaaaaaa.log')}\n`);
    expect(io.out()).toContain('  Relay: interactive connection not used, file transfer not used\n');
    // The one switch left (§11 D-13); there is no guest sandbox, no guest login and no main-workspace switch any more.
    expect(io.out()).toContain("  Notices of agents' shell commands: on\n");
    for (const gone of ['sandbox', 'subscription', 'main workspace', 'runner']) expect(io.out(), gone).not.toContain(gone);
    const one = testIo({ env });
    expect(await runCli(['status', '--workspace', 'ws_status_nothing000'], one)).toBe(3);
    expect(one.out()).toContain('No smurg host is running for workspace');
    // A daemon without the agent modules says nothing about agents; Claude Code is "not checked yet" until a session.
    expect(io.out()).toContain('  Claude Code: not checked yet (smurg checks it when the first agent session starts)\n');
    for (const absent of ['Agent sessions:', 'Topics:', 'project settings', 'allow rules']) expect(io.out(), absent).not.toContain(absent);
  });
});

describe('smurg status: Claude Code and the agents (DESIGN v0.5.0 §6)', () => {
  it('shows the agent sessions by state, the topics and how many are paused, the project settings and the host\'s own rules, between the switch and the log', async () => {
    const { dirs, env } = await setup();
    const { fakes } = await agentDaemon(dirs, 'ws_status_agents00001');
    const fresh = testIo({ env });
    expect(await runCli(['status'], fresh)).toBe(0);
    expect(fresh.out()).toContain(
      [
        "  Notices of agents' shell commands: on",
        '  Claude Code: not checked yet (smurg checks it when the first agent session starts)',
        '  Agent sessions: none',
        '  Topics: none',
        '  Claude Code project settings: none in this folder',
        '  Your own Claude Code allow rules: none apply to agent sessions',
        `  Log: ${join(dirs.stateDir, 'logs', 'ws_status_agents00001.log')}`,
      ].join('\n'),
    );
    // starting counts as running; both kinds of waiting are "waiting for a person"; failed counts with stalled; done
    // is idle; an ended session is not counted.
    adopt(fakes, ['starting', 'running', 'waiting-answer', 'waiting-permission', 'waiting-permission', 'stalled', 'failed', 'idle', 'idle', 'idle', 'done', 'ended']);
    fakes.topics.put(buildTopic({ id: 'tp_a', slug: 'a', name: 'A' }));
    const paused = buildTopic({ id: 'tp_b', slug: 'b', name: 'B' });
    fakes.topics.put({ ...paused, plan: { ...paused.plan, paused: true } });
    fakes.topics.put(buildTopic({ id: 'tp_c', slug: 'c', name: 'C' }));
    fakes.projectTrust.set(MAIN_ROOT, 'used');
    fakes.hostRules.found(['Bash(git status:*)', 'Bash(pnpm test:*)', 'WebFetch(domain:example.com)']);
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(0);
    expect(io.out()).toContain('  Agent sessions: 2 running, 3 waiting for a person, 2 stopped without a report or failed, 4 idle\n');
    expect(io.out()).toContain('  Topics: 3 (1 paused)\n');
    expect(io.out()).toContain('  Claude Code project settings: confirmed (agents use them)\n');
    expect(io.out()).toContain('  Your own Claude Code allow rules: 3 apply to agent sessions (agents run what they allow without asking)\n');
    fakes.projectTrust.set(MAIN_ROOT, 'ignored');
    fakes.hostRules.found(['Bash(git status:*)']);
    const zh = testIo({ env: { ...env, SMURG_LANG: 'zh-TW' } });
    expect(await runCli(['status'], zh)).toBe(0);
    expect(zh.out()).toContain(
      [
        '  Claude Code：尚未檢查（第一個 agent session 啟動時 smurg 會檢查）',
        '  agent session：2 個執行中、3 個在等人回應、2 個沒寫報告就停下或失敗、4 個待命',
        '  主題：3 個（1 個已暫停）',
        '  Claude Code 專案設定：尚未確認（agent 不會載入；請在網頁上確認）',
        '  你自己的 Claude Code 允許規則：1 條套用到 agent session（agent 不經詢問就執行這些規則允許的指令）',
      ].join('\n'),
    );
  });

  it('shows Claude Code as the daemon last found it: the version, whether it is verified or too old for agent sessions, logged in or not', async () => {
    const cases: readonly [NonNullable<CtlStatus['claude']>, string, string][] = [
      [{ version: '2.1.288', verdict: 'verified', login: 'logged-in' }, '2.1.288 (verified with this smurg), logged in', '2.1.288（這個 smurg 驗證過的版本），已登入'],
      [
        { version: '2.2.0', verdict: 'unverified', login: 'logged-in' },
        '2.2.0 (not verified with this smurg yet; agent sessions run with a warning), logged in',
        '2.2.0（這個 smurg 還沒驗證過的版本，agent session 執行時會附上警告），已登入',
      ],
      [
        { version: '2.1.100', verdict: 'too-old', login: 'logged-out' },
        '2.1.100 (too old for agent sessions; update Claude Code), not logged in (run claude in a terminal and log in)',
        '2.1.100（版本太舊，不能執行 agent session，請更新 Claude Code），尚未登入（請在終端機執行 claude 並登入）',
      ],
      [{ version: null, verdict: 'unknown', login: 'unknown' }, 'version unknown (smurg could not read its version), login not checked yet', '版本不明（smurg 讀不到它的版本），尚未確認登入狀態'],
    ];
    for (const [claude, english, chinese] of cases) {
      expect(renderText('en', claudeState(claude))).toBe(english);
      expect(renderText('zh-TW', claudeState(claude))).toBe(chinese);
    }
    expect(renderText('en', claudeState(undefined))).toBe('not checked yet (smurg checks it when the first agent session starts)');
    // The same through the command, from a control socket that answers such a status.
    const { env } = await setup();
    await controlSocketWith(env, {
      ...STATUS_BASE,
      claude: { version: '2.1.288', verdict: 'verified', login: 'logged-in' },
      agents: { running: 1, waiting: 0, stalled: 0, idle: 2 },
      topics: { total: 1, paused: 0 },
      projectSettings: 'used',
      hostRules: { count: 0 },
    });
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(0);
    expect(io.out()).toContain('Workspace ws_status_standin0001\n');
    expect(io.out()).toContain('  Claude Code: 2.1.288 (verified with this smurg), logged in\n  Agent sessions: 1 running, 0 waiting for a person, 0 stopped without a report or failed, 2 idle\n  Topics: 1 (0 paused)\n');
  });

  it('the agent sessions a stop pauses are the ones that have not ended', () => {
    expect(liveAgentSessions(undefined)).toBe(0);
    expect(liveAgentSessions({ running: 1, waiting: 2, stalled: 3, idle: 4 })).toBe(10);
    expect(agentsPausedNotice(undefined)).toBeNull();
    expect(agentsPausedNotice({ running: 0, waiting: 0, stalled: 0, idle: 0 })).toBeNull();
    expect(renderText('en', agentsPausedNotice({ running: 1, waiting: 0, stalled: 1, idle: 1 }) ?? '')).toBe('3 agent sessions are paused. They continue when you share this folder again.');
  });
});

describe('smurg stop', () => {
  it('asks the daemon to stop through the control socket and waits until it is gone', async () => {
    const { dirs, env } = await setup();
    const daemon = await hostDaemon(dirs, 'ws_stop_cccccccccccccc');
    const io = testIo({ env });
    expect(await runCli(['stop'], io)).toBe(0);
    expect(io.out()).toContain('Stopped sharing.');
    expect(daemon.status().stopped).toBe(true);
    const again = testIo({ env });
    expect(await runCli(['stop'], again)).toBe(3);
    expect(again.err()).toContain('No smurg host is running');
  });

  it('picks the workspace of the current folder; with several running and no hint it asks for --workspace (exit 2)', async () => {
    const { dirs, env } = await setup();
    const a = await hostDaemon(dirs, 'ws_stop_dddddddddddddd');
    const other = join(dirs.home, 'other');
    await (await import('node:fs/promises')).mkdir(other);
    const b = await hostDaemon(dirs, 'ws_stop_eeeeeeeeeeeeee', other);
    await rememberSharedFolder(statePaths(env), { folder: other, relay: 'http://localhost:8787', workspaceId: 'ws_stop_eeeeeeeeeeeeee', createdAt: 1 });
    const ambiguous = testIo({ env, cwd: dirs.home });
    expect(await runCli(['stop'], ambiguous)).toBe(2);
    expect(ambiguous.err()).toContain('choose one with --workspace');
    const inFolder = testIo({ env, cwd: other });
    expect(await runCli(['stop'], inFolder)).toBe(0);
    await waitFor(() => b.status().stopped, { what: 'b to stop' });
    expect(a.status().stopped).toBe(false);
    const byFlag = testIo({ env, cwd: dirs.home });
    expect(await runCli(['stop', '--workspace', 'ws_stop_dddddddddddddd'], byFlag)).toBe(0);
    expect(a.status().stopped).toBe(true);
  });

  it('says how many agent sessions are paused (their conversations stay and continue at the next smurg host); nothing when there were none', async () => {
    const { dirs, env } = await setup();
    const { daemon, fakes } = await agentDaemon(dirs, 'ws_stop_agents0000001');
    adopt(fakes, ['running', 'waiting-answer', 'idle', 'ended']);
    const io = testIo({ env });
    expect(await runCli(['stop'], io)).toBe(0);
    expect(io.out()).toBe('Stopping the share of workspace ws_stop_agents0000001...\nStopped sharing.\n3 agent sessions are paused. They continue when you share this folder again.\n');
    expect(daemon.status().stopped).toBe(true);
    const other = await setup();
    const none = await agentDaemon(other.dirs, 'ws_stop_agents0000002');
    adopt(none.fakes, ['ended']);
    const quiet = testIo({ env: other.env });
    expect(await runCli(['stop'], quiet)).toBe(0);
    expect(quiet.out()).toBe('Stopping the share of workspace ws_stop_agents0000002...\nStopped sharing.\n');
    const one = await setup();
    const single = await agentDaemon(one.dirs, 'ws_stop_agents0000003');
    adopt(single.fakes, ['idle']);
    const zh = testIo({ env: { ...one.env, SMURG_LANG: 'zh-TW' } });
    expect(await runCli(['stop'], zh)).toBe(0);
    expect(zh.out().endsWith('已停止分享。\n1 個 agent session 已暫停，下次分享這個資料夾時會繼續。\n')).toBe(true);
  });

  it('--help says what a stop does to each kind of session', async () => {
    const io = testIo({ env: {} });
    expect(await runCli(['stop', '--help'], io)).toBe(0);
    expect(io.out()).toContain('Stop sharing: disconnect everyone and end every terminal session. Agent sessions are paused: their agents stop,\n  their conversations are kept, and they continue when you share the folder again.\n');
    const root = testIo({ env: {} });
    expect(await runCli(['--help'], root)).toBe(0);
    expect(root.out()).toContain('  stop                 Stop sharing (disconnects everyone, ends terminal sessions, pauses agent sessions)\n');
  });

  it('refuses a malformed workspace id (exit 2)', async () => {
    const { env } = await setup();
    const io = testIo({ env });
    expect(await runCli(['stop', '--workspace', '../etc'], io)).toBe(2);
    expect(io.err()).toContain('Not a workspace ID');
  });
});
