// Models with the REAL `claude` (Claude Code 2.1.288; DESIGN 0.6.0 D7, D21 rows R1 and R7), against the repository's
// fake Anthropic API on 127.0.0.1 with a dummy key, in an environment built from nothing (isolated HOME /
// CLAUDE_CONFIG_DIR / TMPDIR from claude-harness.ts): never anyone's account, nothing billed, nothing leaves the machine
// (ARCHITECTURE §0 rule 2). The daemon is the real one with the real hook server, lock manager and sessions module.
//
//  R7  The probe smurg runs to learn the host's models (agent-sessions.ts → models.ts), exactly as it ships, with a
//      SessionStart and a SessionEnd hook in the host's OWN user settings: the hooks did not run (`disableAllHooks` in
//      its `--settings` file), it sent no model request, it wrote no transcript and no project entry, nothing of its
//      process group is left. And the control: the same flags with a settings file WITHOUT `disableAllHooks` run the
//      host's hooks, so the first check can fail. (Measured first, before the probe was built: W/build/S3/r7-*.txt.)
//  R1  `--model sonnet` at the start and at the resume (what the API is asked for, what `init` reports), a live
//      `set_model` to haiku that the next turn runs on, and a model the API refuses: the session says which, with
//      "Choose a model", and no text of Claude Code's own as the agent's words.
//
// The daemon is pointed at a wrapper of the verified binary that notes every launch (its pid, which leads its process
// group, and its argv) and then `exec`s the binary: the process IS the real claude. Skipped LOUDLY without a verified
// `claude`; SMURG_TEST_CLAUDE_BIN selects the binary.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession, ConversationEvent, HostState } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { Principal, WorktreeManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { sessionFilesRoot } from '../../src/hooks/settings-writer.ts';
import { locksModule } from '../../src/locks/module.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { PROBE_DIR_NAME, PROBE_SETTINGS, probeFlags } from '../../src/sessions/agent/models.ts';
import { STREAM_ARGS, checkLaunchArgs } from '../../src/sessions/agent/profiles.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { TEST_HOST_USER, createTempDir, createTestDaemon, removeTempDir, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { MOCK_API_KEY, findClaude, isolatedEnv, killSpawnedGroup, ownProcessGroup, seedClaudeTrust } from '../hooks/claude-harness.ts';
import { startMockAnthropic, type MockAnthropic, type MockOptions } from '../hooks/mock-anthropic.ts';
import { FakeWorktrees } from './helpers.ts';

const execFileAsync = promisify(execFile);
const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[models-claude-real] SKIPPED: ${found.reason}\n`);
else console.log(`[models-claude-real] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude ? `Claude Code ${claude.version}` : 'no claude';

const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));
const COORD_SERVER = fileURLToPath(new URL('../../src/mcp/coord-server.ts', import.meta.url));

/** One start of the binary, as the wrapper noted it. */
interface Launch {
  readonly pid: number;
  readonly args: readonly string[];
}

interface Stack {
  readonly t: TestDaemon;
  readonly mock: MockAnthropic;
  readonly agents: AgentSessionsImpl;
  readonly host: TestClient;
  readonly base: string;
  readonly cfg: string;
  readonly home: string;
  /** The file the host's own SessionStart / SessionEnd hooks append to when they run. */
  readonly hookMarker: string;
  launches(): Promise<Launch[]>;
  principal(): Principal;
  events(sessionId: string): Promise<ConversationEvent[]>;
}

let stack: Stack | null = null;
let scratch: string | null = null;
afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) {
    await current.t.cleanup().catch(() => {});
    await current.mock.close().catch(() => {});
    await removeTempDir(current.base);
  }
  if (scratch !== null) await removeTempDir(scratch);
  scratch = null;
});

/** The members of a process group (by `ps`), each as `pid command`. */
async function groupMembers(pgid: number): Promise<string[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pid=,pgid=,command=']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/)[1] === String(pgid));
}

/** The host's own user settings with a SessionStart and a SessionEnd hook that note that they ran. */
function hookingSettings(marker: string): Record<string, unknown> {
  return { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo start >> ${marker}` }] }], SessionEnd: [{ hooks: [{ type: 'command', command: `echo end >> ${marker}` }] }] } };
}

async function start(options: { readonly mock?: MockOptions } = {}): Promise<Stack> {
  const binary = claude as NonNullable<typeof claude>;
  const base = await createTempDir('models-real');
  const [home, cfg, tmp, launches] = ['home', 'cfg', 'tmp', 'launches'].map((sub) => join(base, sub)) as [string, string, string, string];
  for (const dir of [home, cfg, tmp, launches]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const hookMarker = join(base, 'host-hooks-ran');
  // The host's OWN user settings (CLAUDE_CONFIG_DIR/settings.json of the isolated environment).
  await writeFile(join(cfg, 'settings.json'), JSON.stringify(hookingSettings(hookMarker)));
  const entry = join(base, 'smurg-entry.mjs');
  await writeFile(
    entry,
    [
      'const command = process.argv[2];',
      `if (command === 'hook') { const { runHookCli } = await import(${JSON.stringify(HOOK_CLI)}); process.exitCode = await runHookCli(); }`,
      `else if (command === 'mcp') { const { runMcpServer } = await import(${JSON.stringify(COORD_SERVER)}); process.exitCode = await runMcpServer(); }`,
      'else { process.exitCode = 2; }',
      '',
    ].join('\n'),
  );
  // The wrapper: one file per launch (its pid, then its argv, one per line), then the real binary in its place.
  const wrapper = join(base, 'claude');
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, ['#!/bin/sh', `printf '%s\\n' "$$" "$@" > ${quote(launches)}/"launch-$$"`, `exec ${quote(binary.path)} "$@"`, ''].join('\n'));
  await chmod(wrapper, 0o755);
  const selfCommand = { file: process.execPath, args: [entry] };
  let mockUrl = 'http://127.0.0.1:9';
  const worktrees = new FakeWorktrees();
  const worktreesModule: FeatureModule = {
    name: 'test-worktrees',
    create: (ctx) => {
      worktrees.ctx = ctx;
      return { worktrees: worktrees as unknown as WorktreeManager };
    },
    register: () => toDisposable(() => {}),
  };
  const t = await createTestDaemon({
    project: { files: { 'README.md': '# shop\n' } },
    modules: [locksModule, hooksModule, worktreesModule, createSessionsModule({ hostEnv: () => isolatedEnv(base, mockUrl), launch: { claudePath: wrapper, selfCommand } })],
    sessions: { selfCommand, hostHome: home },
  });
  const mock = await startMockAnthropic([{ text: 'ok' }], options.mock ?? {});
  mockUrl = mock.url;
  // What the host's own Claude Code config already has: the shared folder trusted, the key approved (not the probe's folder).
  await seedClaudeTrust({ cfgDir: cfg, cwd: t.root, apiKey: MOCK_API_KEY });
  const host = await t.connectHost();
  const agents = t.ctx.services.agents as AgentSessionsImpl;
  const made: Stack = {
    t,
    mock,
    agents,
    host,
    base,
    cfg,
    home,
    hookMarker,
    launches: async () => {
      const out: (Launch & { at: number })[] = [];
      for (const name of await readdir(launches)) {
        const [pid, ...args] = (await readFile(join(launches, name), 'utf8')).split('\n').slice(0, -1);
        out.push({ pid: Number(pid), args, at: (await stat(join(launches, name))).mtimeMs });
      }
      // In the order they started (each launch writes its own file once).
      return out.sort((a, b) => a.at - b.at).map(({ pid, args }) => ({ pid, args }));
    },
    principal: () => t.ctx.members.principalOf(TEST_HOST_USER) as Principal,
    events: async (sessionId) => (await agents.history({ sessionId, afterSeq: 0, limit: 500 })).events,
  };
  stack = made;
  return made;
}

describe.skipIf(!claude)(`R7: the probe of the host's models with the real claude (${V}, fake Anthropic API)`, { timeout: 180_000 }, () => {
  it(`R7: the probe as it ships, with the host's own SessionStart and SessionEnd hooks in their user settings: the hooks did not run, no model request, no transcript, no project entry, nothing of its process group left; the list and the host's default reach everyone (${V})`, async () => {
    const s = await start();
    const told: HostState[] = [];
    s.host.conn.on('session.host', (payload) => told.push(payload));
    const claudeJsonBefore = JSON.parse(await readFile(join(s.cfg, '.claude.json'), 'utf8')) as { projects?: Record<string, unknown> };
    const first = await s.host.conn.request('session.host.get', {});
    expect(first.agent.modelsKnown).toBe(false);
    await waitFor(() => told.some((state) => state.agent.modelsKnown), { timeoutMs: 60_000, what: 'the probe to answer' });
    await s.agents.modelsSettled();
    const agent = (told.at(-1) as HostState).agent;
    console.log(`[models-claude-real ${claude?.version}] R7 list: ${JSON.stringify(agent.models.map((entry) => [entry.value, entry.resolved, entry.auto, entry.billing ?? null]))} hostDefault ${agent.hostDefault}`);
    // 2.1.288 on the API with a key (U1 E3): opus, fable, sonnet, haiku besides `default`; the host's default is Opus 5.5.
    expect(agent.models.map((entry) => entry.value)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    expect(agent.models.find((entry) => entry.value === 'fable')).toMatchObject({ resolved: 'claude-fable-5-1', billing: 'usage-credits' });
    expect(agent.models.find((entry) => entry.value === 'haiku')).toMatchObject({ auto: false });
    expect(agent.hostDefault).toBe('claude-opus-5-5');
    // What ran: the probe's exact flags, through the ordinary launch check.
    const launches = await s.launches();
    const probes = launches.filter((launch) => launch.args.includes('--tools') && launch.args[launch.args.indexOf('--tools') + 1] === 'Read');
    expect(probes).toHaveLength(1);
    const probe = probes[0] as Launch;
    const dir = join(sessionFilesRoot(s.t.ctx.config.stateDir, s.t.ctx.config.workspaceId), PROBE_DIR_NAME);
    expect(probe.args.slice(0, 10)).toEqual([...STREAM_ARGS]);
    expect(probe.args[10]).toBe('--session-id');
    expect(probe.args.slice(12)).toEqual(probeFlags({ settingsPath: join(dir, 'settings.json'), mcpConfigPath: join(dir, 'mcp.json') }));
    expect(checkLaunchArgs(probe.args.slice(12))).toBeNull();
    expect(probe.args).not.toContain('--model');
    // The host's own hooks did not run.
    expect(existsSync(s.hookMarker)).toBe(false);
    // No model request at all (measured with 2.1.288: only `HEAD /api/hello`).
    console.log(`[models-claude-real ${claude?.version}] R7 requests: ${JSON.stringify(s.mock.requests.map((request) => `${request.method} ${request.url}`))}`);
    expect(s.mock.requests.filter((request) => request.kind === 'messages' || request.kind === 'count_tokens')).toEqual([]);
    // No transcript (no session has run yet: Claude Code's `projects` folder does not even exist) and no project entry.
    expect(existsSync(join(s.cfg, 'projects'))).toBe(false);
    const claudeJson = JSON.parse(await readFile(join(s.cfg, '.claude.json'), 'utf8')) as { projects?: Record<string, unknown> };
    expect(Object.keys(claudeJson.projects ?? {})).toEqual(Object.keys(claudeJsonBefore.projects ?? {}));
    expect(await readdir(s.home)).toEqual([]);
    // Nothing of its process group is left, and its folder is gone.
    await waitFor(async () => (await groupMembers(probe.pid)).length === 0, { timeoutMs: 10_000, what: 'the probe\'s process group to be empty' });
    expect(existsSync(dir)).toBe(false);
  });

  it(`R7, the control: the same flags with a settings file without disableAllHooks DO run the host's own hooks, so the check above can fail (${V})`, async () => {
    const binary = claude as NonNullable<typeof claude>;
    const mock = await startMockAnthropic([{ text: 'never' }]);
    try {
      scratch = await createTempDir('models-real-control');
      const dir = scratch;
      for (const sub of ['home', 'cfg', 'tmp', 'probe', 'probe/cwd']) await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
      const cwd = await realpath(join(dir, 'probe', 'cwd'));
      const marker = join(dir, 'host-hooks-ran');
      await writeFile(join(dir, 'cfg', 'settings.json'), JSON.stringify(hookingSettings(marker)));
      const settingsPath = join(dir, 'probe', 'settings.json');
      const mcpConfigPath = join(dir, 'probe', 'mcp.json');
      const { disableAllHooks: _off, ...withHooks } = PROBE_SETTINGS;
      await writeFile(settingsPath, JSON.stringify(withHooks));
      await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
      const own = await ownProcessGroup();
      const child = spawn(binary.path, [...STREAM_ARGS, '--session-id', randomUUID(), ...probeFlags({ settingsPath, mcpConfigPath })], { cwd, env: isolatedEnv(dir, mock.url), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const pgid = child.pid as number;
      child.stderr.resume();
      const answered = new Promise<void>((resolve) => {
        createInterface({ input: child.stdout }).on('line', (text) => {
          if (text.includes('"control_response"')) resolve();
        });
      });
      const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      try {
        child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'smurg_control_1', request: { subtype: 'initialize' } })}\n`);
        await Promise.race([answered, closed]);
        child.stdin.end();
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      } finally {
        if ((await groupMembers(pgid)).length > 0) killSpawnedGroup(pgid, own);
      }
      const ran = existsSync(marker) ? await readFile(marker, 'utf8') : '';
      console.log(`[models-claude-real ${claude?.version}] R7 control: the host's hooks wrote ${JSON.stringify(ran)}`);
      expect(ran).toContain('start');
    } finally {
      await mock.close();
    }
  });
});

describe.skipIf(!claude)(`R1: models of a session with the real claude (${V}, fake Anthropic API)`, { timeout: 240_000 }, () => {
  it(`R1: --model sonnet at the start and at the resume; set_model haiku reaches the next turn; a model the API refuses is said in the session (${V})`, async () => {
    const s = await start({ mock: { refuseModels: ['claude-fable-5-1'] } });
    // The list is known once the probe answered (the model check of session.create needs it).
    await s.host.conn.request('session.host.get', {});
    await waitFor(() => s.agents.hostAgentState().modelsKnown, { timeoutMs: 60_000, what: 'the list' });
    const mainModels = (): (string | null)[] => s.mock.requests.filter((request) => request.kind === 'messages' && request.isMain).map((request) => request.model);
    const until = async (sessionId: string, predicate: (session: AgentSession) => boolean, what: string): Promise<AgentSession> => {
      await waitFor(() => predicate(s.agents.get(sessionId) as AgentSession), { timeoutMs: 90_000, what });
      return s.agents.get(sessionId) as AgentSession;
    };
    const turns = async (sessionId: string): Promise<number> => (await s.events(sessionId)).filter((event) => event.kind === 'turn.finished').length;
    const say = async (sessionId: string, text: string): Promise<void> => {
      await s.agents.send(sessionId, { kind: 'person', from: s.principal(), text, cleaned: false, origin: 'composer' });
    };

    // At the start: `--model sonnet`; the API is asked for Sonnet 5.5, and `init` says so.
    const { session } = await s.host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, model: 'sonnet', firstMessage: 'Say ok.' });
    await waitFor(async () => (await turns(session.id)) >= 1, { timeoutMs: 90_000, what: 'the first turn' });
    const first = await until(session.id, (now) => now.status === 'idle' && now.modelInUse !== undefined, 'the session to be idle');
    expect(first).toMatchObject({ model: 'sonnet', modelInUse: 'claude-sonnet-5-5' });
    expect(mainModels().length).toBeGreaterThan(0);
    expect(new Set(mainModels())).toEqual(new Set(['claude-sonnet-5-5']));
    // The launches of agent processes (the stream flags first), not the probe (`--tools Read`).
    const ofSession = async (): Promise<Launch[]> => (await s.launches()).filter((launch) => launch.args[0] === '-p' && launch.args[launch.args.indexOf('--tools') + 1] !== 'Read');
    expect((await ofSession())[0]?.args.slice(-2)).toEqual(['--model', 'sonnet']);

    // Parked, then resumed: `--resume` with `--model sonnet`; the resumed conversation still runs on Sonnet.
    await s.agents.restartProcess(session.id, 'asked');
    await waitFor(() => s.agents.facts(session.id)?.hasProcess === false, { timeoutMs: 30_000, what: 'the process to be parked' });
    const before = mainModels().length;
    await say(session.id, 'Say ok again.');
    await waitFor(async () => (await turns(session.id)) >= 2, { timeoutMs: 90_000, what: 'the resumed turn' });
    const resumed = (await ofSession()).at(-1) as Launch;
    expect(resumed.args).toContain('--resume');
    expect(resumed.args.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(new Set(mainModels().slice(before))).toEqual(new Set(['claude-sonnet-5-5']));
    expect((await until(session.id, (now) => now.status === 'idle', 'idle after the resume')).modelInUse).toBe('claude-sonnet-5-5');

    // Live: set_model haiku; the next turn runs on Haiku 4.5 in the same process.
    await until(session.id, (now) => now.status === 'idle' && s.agents.facts(session.id)?.hasProcess === true, 'a ready process');
    const launchesBefore = (await ofSession()).length;
    await s.host.conn.request('session.model.set', { sessionId: session.id, model: 'haiku' });
    const beforeHaiku = mainModels().length;
    await say(session.id, 'Say ok once more.');
    await waitFor(async () => (await turns(session.id)) >= 3, { timeoutMs: 90_000, what: 'the turn on haiku' });
    expect(new Set(mainModels().slice(beforeHaiku))).toEqual(new Set(['claude-haiku-4-5-20251001']));
    expect((await until(session.id, (now) => now.status === 'idle', 'idle on haiku')).modelInUse).toBe('claude-haiku-4-5-20251001');
    expect((await ofSession()).length).toBe(launchesBefore);

    // A model the API does not have (404): Claude Code's own sentence is not the agent's words; the session names the
    // model and offers to choose another; no second, generic error notice.
    await s.host.conn.request('session.model.set', { sessionId: session.id, model: 'fable' });
    const textsBefore = (await s.events(session.id)).filter((event) => event.kind === 'text').length;
    await say(session.id, 'And now?');
    await waitFor(async () => (await turns(session.id)) >= 4, { timeoutMs: 90_000, what: 'the refused turn' });
    await until(session.id, (now) => now.status === 'idle', 'idle after the refusal');
    const events = await s.events(session.id);
    const notices = events.filter((event): event is Extract<ConversationEvent, { kind: 'notice' }> => event.kind === 'notice');
    console.log(`[models-claude-real ${claude?.version}] R1 notices: ${JSON.stringify(notices.map((notice) => [notice.text.id, notice.text.params ?? null, notice.action ?? null]))}`);
    expect(notices.filter((notice) => notice.text.id === 'notice.modelRefused')).toEqual([expect.objectContaining({ level: 'error', action: 'choose-model', text: { id: 'notice.modelRefused', params: { model: 'Fable' } } })]);
    expect(notices.filter((notice) => notice.text.id === 'notice.turnError')).toEqual([]);
    expect(events.filter((event) => event.kind === 'text').length).toBe(textsBefore);
    expect(JSON.stringify(events)).not.toContain("There's an issue with the selected model");
    expect(s.mock.requests.some((request) => request.isMain && request.model === 'claude-fable-5-1')).toBe(true);
  });
});
