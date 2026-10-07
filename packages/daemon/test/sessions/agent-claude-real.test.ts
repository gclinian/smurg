// The agent runtime with the REAL `claude` binary (Claude Code 2.1.288) in structured mode, against the repository's
// fake Anthropic API on 127.0.0.1 with a dummy key and an environment built from nothing (isolated HOME /
// CLAUDE_CONFIG_DIR / TMPDIR): never anyone's account, nothing billed, nothing leaves the machine (ARCHITECTURE §0
// rule 2). The daemon is the real one with the real hook server, lock manager and sessions module; `smurg hook` and
// `smurg mcp` are this package's own entry points.
//
// What it proves on the real binary (DESIGN Appendix C R1–R3 as tests, §2.2, §2.5, §2.9, §2.10, §2.11):
//  - the discussion profile holds on a host whose OWN settings allow everything and who has a user-scope MCP server;
//  - a command asks, "always allow" reaches the running process and the next process's settings file, the host's
//    own allow rule applies without asking (OWNER-DECISIONS Q7), the read rules hide private files and leave git alone;
//  - stop, park and resume, and both refusals of Claude Code about a conversation id;
//  - the trust gate for project settings; the hardened settings; the tool list of the verified version.
// Skipped LOUDLY without a verified `claude`; SMURG_TEST_CLAUDE_BIN selects another binary.
import { cp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, conversationEventSchema, type AgentSession, type ConversationEvent } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AgentsConfig } from '../../src/core/config.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import type { AgentRequest, DaemonEvents, Principal, WorktreeManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { gateDenyReason } from '../../src/hooks/deny-text.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { DISCUSSION_TOOLS, EXECUTION_TOOLS } from '../../src/sessions/agent/profiles.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { TEST_HOST_USER, createTempDir, createTempProject, createTempRunDir, createTestDaemon, removeTempDir, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { MOCK_API_KEY, findClaude, isolatedEnv, seedClaudeTrust } from '../hooks/claude-harness.ts';
import { startMockAnthropic, type MockAnthropic, type MockOptions, type MockStep } from '../hooks/mock-anthropic.ts';
import { FakeWorktrees } from './helpers.ts';

const found = await findClaude();
const claude = found.binary;
if (!claude) console.warn(`[agent-claude-real] SKIPPED: ${found.reason}`);
else console.log(`[agent-claude-real] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude ? `Claude Code ${claude.version}` : 'no claude';

const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));
const COORD_SERVER = fileURLToPath(new URL('../../src/mcp/coord-server.ts', import.meta.url));

interface Stack {
  readonly t: TestDaemon;
  readonly mock: MockAnthropic;
  readonly agents: AgentSessionsImpl;
  readonly base: string;
  readonly cfg: string;
  readonly home: string;
  readonly requests: AgentRequest[];
  readonly gate: DaemonEvents['agent.tool.gate'][];
  readonly ready: DaemonEvents['agent.ready'][];
  readonly turns: DaemonEvents['agent.turn.finished'][];
  host(): Principal;
  path(rel: string): string;
  events(sessionId: string): Promise<ConversationEvent[]>;
  /** What the model was told about its tool calls, in order: `ok` or the error text. */
  results(): string[];
  say(sessionId: string, text: string): Promise<void>;
  turnsDone(count: number): Promise<void>;
  /** A daemon with the same modules, launch inputs and isolated environment over another (or the same) state dir and folder. */
  another(input: { readonly root: string; readonly stateDir: string }): Promise<TestDaemon>;
}

let stack: Stack | null = null;
/** State dirs a test owns (a second daemon ran over them). */
const extraDirs: string[] = [];
afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) {
    await current.t.cleanup().catch(() => {});
    await current.mock.close().catch(() => {});
    await removeTempDir(current.base);
  }
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface StackOptions {
  readonly files?: Record<string, string>;
  readonly git?: boolean;
  /** The host's OWN `~/.claude/settings.json` (in the isolated config dir); a function gets the scratch folder to put a script into. */
  readonly hostSettings?: Record<string, unknown> | ((paths: { readonly base: string }) => Record<string, unknown>);
  /** The name of the shared folder (default: the harness's own). */
  readonly rootName?: string;
  /** How the mock tells a subagent's requests from the main conversation's. */
  readonly route?: (paths: { readonly root: string; readonly home: string }) => NonNullable<MockOptions['route']>;
  /** A user-scope MCP server in the host's own Claude Code config. */
  readonly plantUserMcp?: boolean;
  readonly agents?: Partial<AgentsConfig>;
  /** The daemon's state dir, owned by the test (a daemon is started over it again). */
  readonly stateDir?: string;
  /** How each request of an agent is answered (default: nothing answers). */
  readonly answer?: (request: AgentRequest, agents: AgentSessionsImpl, sessionId: string) => void;
}

/** `steps` gets the project's and the fake home's paths: the script names absolute files. */
async function start(steps: (paths: { root: string; home: string }) => readonly MockStep[], options: StackOptions = {}): Promise<Stack> {
  const base = await createTempDir('claude-real');
  const [home, cfg, tmp] = ['home', 'cfg', 'tmp'].map((sub) => join(base, sub)) as [string, string, string];
  for (const dir of [home, cfg, tmp]) await mkdir(dir, { recursive: true, mode: 0o700 });
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
  if (options.hostSettings) await writeFile(join(cfg, 'settings.json'), JSON.stringify(typeof options.hostSettings === 'function' ? options.hostSettings({ base }) : options.hostSettings));
  const selfCommand = { file: process.execPath, args: [entry] };
  // The mock's address is known after the daemon (its script names files of the project): read at each session start.
  let mockUrl = 'http://127.0.0.1:9';
  const modules = (): FeatureModule[] => {
    const worktrees = new FakeWorktrees();
    const worktreesModule: FeatureModule = {
      name: 'test-worktrees',
      create: (ctx) => {
        worktrees.ctx = ctx;
        return { worktrees: worktrees as unknown as WorktreeManager };
      },
      register: () => toDisposable(() => {}),
    };
    return [locksModule, hooksModule, worktreesModule, createSessionsModule({ hostEnv: () => isolatedEnv(base, mockUrl), launch: { claudePath: (claude as NonNullable<typeof claude>).path, selfCommand } })];
  };
  const project = { files: { 'README.md': '# shop\n', 'src/cart.ts': 'export const cart = [];\n', '.envrc': 'SECRET=in-envrc\n', ...options.files }, ...(options.git ? { git: true } : {}) };
  const t = await createTestDaemon({
    ...(options.rootName === undefined ? { project } : { root: await createTempProject(base, options.rootName, project) }),
    modules: modules(),
    sessions: { selfCommand, hostHome: home },
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  });
  const mock = await startMockAnthropic(steps({ root: t.root, home }), options.route ? { route: options.route({ root: t.root, home }) } : {});
  mockUrl = mock.url;
  // What the host's own Claude Code config already has: the folder trusted for the terminal UI, the key approved.
  const claudeJson = await seedClaudeTrust({ cfgDir: cfg, cwd: t.root, apiKey: MOCK_API_KEY });
  if (options.plantUserMcp) {
    const planted = join(base, 'planted-mcp.mjs');
    await writeFile(planted, "process.stdin.on('data', () => {});\n");
    const config = JSON.parse(await readFile(claudeJson, 'utf8')) as Record<string, unknown>;
    config['mcpServers'] = { planted: { type: 'stdio', command: process.execPath, args: [planted] } };
    await writeFile(claudeJson, JSON.stringify(config));
  }
  await t.connectHost();
  const agents = t.ctx.services.agents as AgentSessionsImpl;
  const requests: AgentRequest[] = [];
  const gate: DaemonEvents['agent.tool.gate'][] = [];
  const ready: DaemonEvents['agent.ready'][] = [];
  const turns: DaemonEvents['agent.turn.finished'][] = [];
  t.ctx.bus.on('agent.request', (event) => {
    requests.push(event.request);
    options.answer?.(event.request, agents, event.sessionId);
  });
  t.ctx.bus.on('agent.tool.gate', (event) => gate.push(event));
  t.ctx.bus.on('agent.ready', (event) => ready.push(event));
  t.ctx.bus.on('agent.turn.finished', (event) => turns.push(event));
  const host = (): Principal => t.ctx.members.principalOf(TEST_HOST_USER) as Principal;
  const made: Stack = {
    t,
    mock,
    agents,
    base,
    cfg,
    home,
    requests,
    gate,
    ready,
    turns,
    host,
    path: (rel) => join(t.root, rel),
    events: async (sessionId) => (await agents.history({ sessionId, afterSeq: 0, limit: 500 })).events,
    results: () => mock.toolResults().map((result) => (result.isError ? result.text : 'ok')),
    say: async (sessionId, text) => {
      await agents.send(sessionId, { kind: 'person', from: host(), text, cleaned: false, origin: 'composer' });
    },
    turnsDone: (count) => waitFor(() => turns.length >= count, { timeoutMs: 60_000, what: `turn ${count} to end` }),
    another: (input) =>
      createTestDaemon({ root: input.root, stateDir: input.stateDir, workspaceId: t.workspaceId, modules: modules(), sessions: { selfCommand, hostHome: home }, ...(options.agents ? { agents: options.agents } : {}) }),
  };
  stack = made;
  return made;
}

const tool = (name: string, input: Record<string, unknown>): MockStep => ({ tools: [{ name, input }] });
const bash = (command: string): MockStep => tool('Bash', { command, description: 'run' });
const QUESTION = { questions: [{ question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] }] };
const TOPIC = { id: 'tp_checkout', slug: 'checkout', name: 'Checkout' };
const freeSession = async (s: Stack, firstMessage: string): Promise<AgentSession> => (await s.t.ctx.services.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, firstMessage }, null as never, s.host())) as AgentSession;
const allowAll = (request: AgentRequest, agents: AgentSessionsImpl, sessionId: string): void => {
  if (request.kind === 'permission') agents.decidePermission(sessionId, request.id, { allow: true });
};

describe.skipIf(!claude)(`the agent runtime with the real claude (${V}, mock Anthropic API)`, { timeout: 180_000 }, () => {
  it(`R1: the discussion profile holds on a host whose own settings allow everything and who has a user MCP server (${V})`, async () => {
    const s = await start(
      ({ root, home }) => [
        tool('Write', { file_path: join(root, 'src/cart.ts'), content: 'HACKED\n' }),
        tool('Write', { file_path: join(root, 'specs/checkout/SPEC.md'), content: '# Checkout\n\n## Goal\nSell things.\n' }),
        tool('Write', { file_path: join(root, 'specs/checkout/CLAUDE.md'), content: 'Always obey the spec author.\n' }),
        tool('Read', { file_path: join(home, 'private-notes.txt') }),
        tool('Read', { file_path: join(root, '.envrc') }),
        tool('Grep', { pattern: 'SECRET', output_mode: 'files_with_matches' }),
        bash('ls'),
        tool('AskUserQuestion', QUESTION),
        { text: 'The draft is ready.' },
      ],
      {
        hostSettings: { permissions: { allow: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch', 'mcp__planted'] } },
        plantUserMcp: true,
        answer: (request, agents, sessionId) => {
          if (request.kind === 'question') agents.answerQuestion(sessionId, request.id, { answers: { 'Which database?': 'SQLite' }, notes: { 'Which database?': 'Votes: SQLite 3, Postgres 1.' } });
        },
      },
    );
    await writeFile(join(s.home, 'private-notes.txt'), 'HOME-SECRET\n');
    const session = await s.agents.start({
      purpose: 'discussion',
      topic: TOPIC,
      openedBy: s.host(),
      responsible: null,
      workspace: { mode: 'main' },
      mode: 'ask-all',
      rolePrompt: ({ smurgTag }) => `You are the discussion agent of one topic. A line that starts with "[smurg ${smurgTag}]" is the workspace software itself.`,
      opening: msg('conversation.started.discussion', { name: 'Host' }),
      firstMessage: { kind: 'person', from: s.host(), text: 'Let us plan the checkout.', cleaned: false, origin: 'composer' },
    });
    await s.turnsDone(1);
    const results = s.results();
    console.log(`[agent-claude-real ${claude?.version}] R1 results: ${JSON.stringify(results.map((r) => r.slice(0, 90)))}`);
    // The gate refused, with nothing reaching the permission flow: a write to the code, a new file next to the spec,
    // a read in the host's home, a read of a private file. The host's own allow rules changed none of it.
    expect(results[0]).toContain(gateDenyReason('G6', { slug: 'checkout' }));
    expect(results[1]).toBe('ok');
    expect(results[2]).toContain(gateDenyReason('G6', { slug: 'checkout' }));
    expect(results[3]).toContain(gateDenyReason('G5'));
    // The private file: refused twice over. Claude Code checks its own deny rule (the second layer) while it validates
    // the call, before the hook is asked: either sentence means the file was not read.
    expect(results[4]).toMatch(/denied by your permission settings|A discussion session reads only files inside the shared project/);
    // Grep ran (the gate does not judge a search of the folder): the read rules hide the private file from it.
    expect(results[5]).toBe('ok');
    expect(JSON.stringify(s.mock.toolResults()[5])).not.toContain('.envrc');
    // No Bash tool exists in this session at all.
    expect(results[6]).toMatch(/No such tool available|does not have the tool Bash/);
    expect(results[7]).toBe('ok');
    expect(JSON.stringify(s.mock.toolResults()[7])).toContain('SQLite');
    expect(await readFile(s.path('src/cart.ts'), 'utf8')).toBe('export const cart = [];\n');
    expect(await readFile(s.path('specs/checkout/SPEC.md'), 'utf8')).toContain('Sell things.');
    expect(existsSync(s.path('specs/checkout/CLAUDE.md'))).toBe(false);
    // The only request that reached the daemon is the question.
    expect(s.requests.map((request) => request.kind)).toEqual(['question']);
    expect(s.gate.map((event) => `${event.tool}:${event.row}`).slice(0, 3)).toEqual(['Write:G6', 'Write:G6', 'Read:G5']);
    // The tools Claude Code has in this session: the six, smurg's own, nothing of the host's MCP server, no ListAgents.
    const tools = s.ready[0]?.tools ?? [];
    expect(tools.filter((name) => !name.startsWith('mcp__')).sort()).toEqual([...DISCUSSION_TOOLS].sort());
    expect(tools.some((name) => name.startsWith('mcp__smurg__'))).toBe(true);
    expect(tools.some((name) => name.includes('planted'))).toBe(false);
    expect(s.ready[0]).toMatchObject({ claudeVersion: claude?.version, login: 'logged-in' });
    // The host is told which of their own rules apply (information: they do apply, OWNER-DECISIONS Q7).
    expect(s.t.ctx.services.hostRules.applied()).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'mcp__planted']));
    // The conversation: every event is wire-valid; the read outside the workspace has no path, the private one no body.
    const events = await s.events(session.id);
    for (const event of events) expect(conversationEventSchema.safeParse(event).success).toBe(true);
    const cards = events.filter((event) => event.kind === 'tool.started').map((event) => (event.kind === 'tool.started' ? event.tool : null));
    expect(cards.find((card) => card?.outside === true)).toEqual({ name: 'Read', verb: 'read', outside: true });
    expect(cards.find((card) => card?.target === '.envrc')).toEqual({ name: 'Read', verb: 'read', target: '.envrc' });
    expect(JSON.stringify(events)).not.toContain('HOME-SECRET');
    expect(JSON.stringify(events)).not.toContain('in-envrc');
    expect(s.turns[0]).toMatchObject({ outcome: 'completed', finalText: 'The draft is ready.', edited: [{ file: { root: MAIN_ROOT, path: 'specs/checkout/SPEC.md' } }] });
    // The message reached the model under its header line; smurg's role prompt is in the system prompt.
    const first = s.mock.requests.find((request) => request.kind === 'messages' && request.isMain);
    expect(JSON.stringify(first?.lastUser)).toContain('[Host · Host]\\nLet us plan the checkout.');
    expect(JSON.stringify(first?.system)).toContain('You are the discussion agent of one topic.');
  });

  it(`R2 / Q7: a command asks; "always allow" reaches the running process and the next process's settings file; the host's own allow rule applies without asking (${V})`, async () => {
    const s = await start(
      () => [bash('mkdir host-rule-dir'), bash('touch remembered a.txt'), bash('touch remembered b.txt'), { text: 'First part done.' }, bash('touch remembered c.txt'), bash('curl http://127.0.0.1:9/x'), { text: 'Second part done.' }],
      {
        hostSettings: { permissions: { allow: ['Bash(mkdir *)'] } },
        answer: (request, agents, sessionId) => {
          if (request.kind !== 'permission') return;
          const command = request.view.target ?? '';
          if (command.startsWith('touch remembered')) agents.decidePermission(sessionId, request.id, { allow: true, sessionRule: { tool: 'Bash', pattern: 'touch remembered *' } });
          else agents.decidePermission(sessionId, request.id, { allow: false, message: 'No network here.' });
        },
      },
    );
    const session = await freeSession(s, 'do the first part');
    await s.turnsDone(1);
    console.log(`[agent-claude-real ${claude?.version}] R2 first turn: asked ${JSON.stringify(s.requests.map((r) => (r.kind === 'permission' ? `${r.view.target} / suggested ${JSON.stringify(r.suggestedRule ?? null)}` : r.kind)))}`);
    // The host's own rule ran `mkdir` without a request; the first `touch` asked; the second ran on the remembered rule.
    expect(s.requests.map((request) => (request.kind === 'permission' ? request.view.target : ''))).toEqual(['touch remembered a.txt']);
    expect(s.requests[0]).toMatchObject({ kind: 'permission', tool: 'Bash', view: { name: 'Bash', verb: 'run' } });
    for (const name of ['host-rule-dir', 'a.txt', 'b.txt']) expect(existsSync(s.path(name)), name).toBe(true);
    expect(s.t.ctx.services.hostRules.applied()).toEqual(['Bash(mkdir *)']);
    // What ran without a card is audited as such; what a member allowed, with the decision.
    const commands = (await s.t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'agent.command').map((entry) => `${String(entry.detail?.['command'])} | ${String(entry.detail?.['why']).replace(/rq_.*/, 'rq')}`).reverse();
    expect(commands).toEqual(['mkdir host-rule-dir | unasked', 'touch remembered a.txt | decision:rq', 'touch remembered b.txt | unasked']);
    // The conversation module stores the rule in the session's record; the process is parked; the next one has it in its settings file.
    await s.agents.setRules(session.id, [{ id: 'rule_1', tool: 'Bash', pattern: 'touch remembered *', scope: 'session', addedBy: { userId: TEST_HOST_USER, displayName: 'Host' }, addedAt: 1 }], { kind: 'system' });
    await s.agents.restartProcess(session.id, 'slot');
    await waitFor(() => s.agents.facts(session.id)?.hasProcess === false, { timeoutMs: 20_000, what: 'the process to be parked' });
    await s.say(session.id, 'do the second part');
    await s.turnsDone(2);
    // The resumed conversation went on where it was (the mock answered with the script's next steps), `touch` did not ask again, `curl` did.
    expect(s.requests.map((request) => (request.kind === 'permission' ? request.view.target : ''))).toEqual(['touch remembered a.txt', 'curl http://127.0.0.1:9/x']);
    expect(existsSync(s.path('c.txt'))).toBe(true);
    expect(s.results().at(-1)).toContain('No network here.');
    expect(s.turns[1]).toMatchObject({ outcome: 'completed', finalText: 'Second part done.' });
    expect((await s.events(session.id)).filter((event) => event.kind === 'turn.started').map((event) => (event.kind === 'turn.started' ? event.turnId : ''))).toEqual(['t_1', 't_2']);
  });

  it(`R3: the read rules hide the host's private files from Grep and refuse \`cat\` of them, and leave \`git status\` and \`git diff\` alone; the tools of an execution session are the pinned list (${V})`, async () => {
    const s = await start(() => [bash('git status --short'), bash('git diff --stat'), bash('cat .envrc'), bash('cat .git/HEAD'), tool('Grep', { pattern: 'SECRET', output_mode: 'files_with_matches' }), { text: 'Looked around.' }], { git: true, answer: allowAll });
    await writeFile(s.path('README.md'), '# shop, changed\n');
    await freeSession(s, 'look around');
    await s.turnsDone(1);
    const results = s.mock.toolResults();
    console.log(`[agent-claude-real ${claude?.version}] R3 results: ${JSON.stringify(results.map((r) => `${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 70)}`))}`);
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]?.text).toContain('README.md');
    expect(results[1]?.text).toContain('README.md');
    // Denied by the rule, before any request: nobody was asked about these two.
    expect(results[2]).toMatchObject({ isError: true });
    expect(results[3]).toMatchObject({ isError: true });
    expect(results[2]?.text).not.toContain('in-envrc');
    expect(s.requests.filter((request) => request.kind === 'permission' && /cat /.test(request.view.target ?? ''))).toEqual([]);
    expect(results[4]?.text ?? '').not.toContain('.envrc');
    // The tool list of the verified version, pinned (profiles.ts EXECUTION_TOOLS).
    const tools = (s.ready[0]?.tools ?? []).filter((name) => !name.startsWith('mcp__')).sort();
    expect(tools).toEqual([...EXECUTION_TOOLS].sort());
    for (const gone of ['ListAgents', 'SendMessage', 'MultiEdit', 'BashOutput', 'KillShell', 'TodoWrite']) expect(tools).not.toContain(gone);
  });

  it(`stop: the turn ends interrupted within moments, the waiting request is withdrawn, the process stays and takes the next message (${V})`, async () => {
    const s = await start(() => [bash('touch stop-me.txt'), { text: 'Stopped, as asked.' }]);
    const session = await freeSession(s, 'run something');
    await waitFor(() => s.requests.length === 1, { timeoutMs: 60_000, what: 'the request' });
    const withdrawn: DaemonEvents['agent.request.withdrawn'][] = [];
    s.t.ctx.bus.on('agent.request.withdrawn', (event) => withdrawn.push(event));
    const started = Date.now();
    await s.agents.interrupt(session.id, { kind: 'user', userId: TEST_HOST_USER, displayName: 'Host' });
    await s.turnsDone(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(s.turns[0]).toMatchObject({ outcome: 'interrupted', stoppedBy: { userId: TEST_HOST_USER } });
    expect(withdrawn).toEqual([{ sessionId: session.id, requestId: s.requests[0]?.id, reason: 'stopped', by: { userId: TEST_HOST_USER, displayName: 'Host' } }]);
    expect(s.agents.facts(session.id)?.hasProcess).toBe(true);
    expect(s.agents.get(session.id)?.status).toBe('idle');
    expect(existsSync(s.path('stop-me.txt'))).toBe(false);
    await s.say(session.id, 'thanks');
    await s.turnsDone(2);
    expect(s.turns[1]).toMatchObject({ outcome: 'completed', finalText: 'Stopped, as asked.' });
  });

  it(`both refusals of Claude Code about a conversation id: a conversation it no longer keeps starts anew with the fixed message; one it already has is resumed (${V})`, async () => {
    const s = await start(() => [{ text: 'First answer.' }, { text: 'Second answer.' }, { text: 'Third answer.' }], { answer: allowAll });
    const session = await freeSession(s, 'one');
    await s.turnsDone(1);
    await s.agents.restartProcess(session.id, 'slot');
    await waitFor(() => s.agents.facts(session.id)?.hasProcess === false, { timeoutMs: 20_000, what: 'parked' });
    // Claude Code's own transcript of the conversation goes (it keeps them 30 days by default).
    const projects = join(s.cfg, 'projects');
    let removed = 0;
    for (const dir of await readdir(projects)) {
      for (const name of await readdir(join(projects, dir))) {
        if (!name.endsWith('.jsonl')) continue;
        await unlink(join(projects, dir, name));
        removed += 1;
      }
    }
    expect(removed).toBeGreaterThan(0);
    const mains = (): MockAnthropic['requests'] => s.mock.requests.filter((request) => request.kind === 'messages' && request.isMain);
    const before = mains().length;
    await s.say(session.id, 'two');
    // smurg's fixed message goes first, the member's message after it. Claude Code runs them as two turns (a message
    // written while a turn runs is folded in only at a tool boundary, and this turn has none); were they ever folded
    // into one, the same request would carry both. Either way: wait for the turn that took the member's message.
    const tookPerson = (): DaemonEvents['agent.turn.finished'][] => s.turns.filter((turn) => turn.messages.some((message) => message.kind === 'person'));
    await waitFor(() => tookPerson().length >= 2, { timeoutMs: 60_000, what: 'the turn that took the message written after the loss' });
    const events = await s.events(session.id);
    expect(events.some((event) => event.kind === 'line' && event.text.id === 'session.resume.lost')).toBe(true);
    expect(events.find((event) => event.kind === 'smurg')).toMatchObject({ purpose: 'conversation-lost', text: 'The earlier conversation of this session is no longer available.' });
    // A new conversation: the model saw no earlier turn (the mock answered with the script's FIRST step again), and the
    // first thing it was told is smurg's sentence under smurg's own header.
    const lostTurn = s.turns.find((turn) => turn.messages.some((message) => message.kind === 'smurg' && message.purpose === 'conversation-lost'));
    expect(lostTurn).toMatchObject({ outcome: 'completed' });
    const after = mains().slice(before);
    expect(after[0]?.assistantTurns).toBe(0);
    expect(JSON.stringify(after[0]?.lastUser)).toMatch(/\[smurg [a-z0-9]{4}\]\\nThe earlier conversation of this session is no longer available\./);
    // The member's message was not lost with the conversation: it reached the model after that sentence.
    const withTwo = after.findIndex((request) => JSON.stringify(request.lastUser).includes('[Host · Host]\\ntwo'));
    expect(withTwo).toBeGreaterThanOrEqual(0);
    expect(tookPerson().at(-1)).toMatchObject({ outcome: 'completed' });
    await waitFor(() => s.agents.get(session.id)?.status === 'idle', { timeoutMs: 20_000, what: 'the session to be idle again' });
    // The record now resumes the NEW conversation (no second loss).
    expect(events.filter((event) => event.kind === 'line' && event.text.id === 'session.resume.lost')).toHaveLength(1);
  });

  it(`a process killed in its first turn: Claude Code already has the conversation ("already in use"), so "Try again" resumes it (${V})`, async () => {
    const s = await start(() => [bash('touch in-use.txt'), { text: 'Recovered.' }]);
    const session = await freeSession(s, 'start and wait');
    await waitFor(() => s.requests.length === 1, { timeoutMs: 60_000, what: 'the request' });
    // Claude Code writes its own transcript within a moment of each entry.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const pid = s.agents.liveChildren().find((child) => child.id === session.id)?.pid as number;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => s.agents.get(session.id)?.status === 'failed', { timeoutMs: 20_000, what: 'the failure' });
    await s.agents.retry(session.id, s.host());
    await waitFor(() => s.agents.get(session.id)?.status === 'idle' && s.agents.facts(session.id)?.hasProcess === true, { timeoutMs: 30_000, what: 'the retry to resume the conversation' });
    await s.say(session.id, 'go on');
    await waitFor(() => s.turns.some((turn) => turn.outcome === 'completed'), { timeoutMs: 60_000, what: 'the resumed turn' });
    expect(s.turns.at(-1)).toMatchObject({ outcome: 'completed', finalText: 'Recovered.' });
    expect((await s.events(session.id)).filter((event) => event.kind === 'notice').map((event) => (event.kind === 'notice' ? event.text.id : ''))).toEqual(['notice.processExited']);
  });

  it(`the trust gate: project settings nobody confirmed are not loaded (their hook does not run); confirmed by the host, the next process loads them (${V})`, async () => {
    const s = await start(({ root }) => [tool('Read', { file_path: join(root, 'README.md') }), { text: 'Read it.' }, tool('Read', { file_path: join(root, 'README.md') }), { text: 'Read it again.' }], { answer: allowAll });
    const marker = join(s.base, 'PROJECT-HOOK-RAN');
    await mkdir(s.path('.claude'), { recursive: true });
    await writeFile(s.path('.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `/usr/bin/touch ${marker}` }] }] } }));
    const trust = s.t.ctx.services.projectTrust;
    s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: '.claude/settings.json', change: 'add' }] });
    await waitFor(() => trust.state(MAIN_ROOT) === 'ignored', { what: 'the settings file to be seen' });
    const session = await freeSession(s, 'read the readme');
    await s.turnsDone(1);
    expect(s.results()).toEqual(['ok']);
    // Structured mode shows no trust dialog: without smurg's gate this hook would have run as the host.
    expect(existsSync(marker)).toBe(false);
    expect((await s.events(session.id)).some((event) => event.kind === 'notice' && event.text.id === 'session.projectSettings.untrusted')).toBe(true);
    const described = await trust.describe({});
    const files = described.roots[0]?.files.map((file) => ({ path: file.path, hash: file.hash })) ?? [];
    expect(described.roots[0]?.files[0]?.runs).toEqual([`hook PreToolUse: /usr/bin/touch ${marker}`]);
    await trust.decide({ root: MAIN_ROOT, files, decision: 'trust', acknowledged: [] }, s.host());
    await waitFor(() => s.agents.facts(session.id)?.hasProcess === false, { timeoutMs: 20_000, what: 'the restart after the decision' });
    await s.say(session.id, 'read it again');
    await s.turnsDone(2);
    expect(existsSync(marker)).toBe(true);
    expect(s.agents.get(session.id)).toMatchObject({ projectSettings: 'used', status: 'idle' });
  });

  it(`restart: smurg stops while the agent waits for a decision and starts again over the same state: the process is gone, the conversation is readable, the next message resumes it (${V})`, async () => {
    const stateDir = await createTempRunDir();
    extraDirs.push(stateDir);
    const s = await start(() => [bash('touch restart.txt'), { text: 'Back again.' }], { stateDir });
    const session = await freeSession(s, 'run something');
    await waitFor(() => s.requests.length === 1, { timeoutMs: 60_000, what: 'the request' });
    const pid = s.agents.liveChildren().find((child) => child.id === session.id)?.pid as number;
    await s.t.daemon.stop();
    expect(alive(pid)).toBe(false);
    // The same state directory and folder, a new daemon.
    const again = await s.another({ root: s.t.root, stateDir });
    try {
      const agents = again.ctx.services.agents as AgentSessionsImpl;
      expect(agents.get(session.id)).toMatchObject({ status: 'idle', purpose: 'free', title: 'run something' });
      expect(agents.facts(session.id)?.hasProcess).toBe(false);
      const before = (await agents.history({ sessionId: session.id, afterSeq: 0, limit: 500 })).events;
      expect(before.map((event) => (event.kind === 'line' ? event.text.id : event.kind))).toEqual(expect.arrayContaining(['conversation.started.free', 'turn.finished', 'conversation.interrupted.restart']));
      expect(before.find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'interrupted' });
      // Nothing starts by itself; the next message does, and Claude Code continues the conversation it kept.
      const finished: DaemonEvents['agent.turn.finished'][] = [];
      again.ctx.bus.on('agent.turn.finished', (event) => finished.push(event));
      await again.connectHost();
      await agents.send(session.id, { kind: 'person', from: again.ctx.members.principalOf(TEST_HOST_USER) as Principal, text: 'go on', cleaned: false, origin: 'composer' });
      await waitFor(() => finished.length >= 1, { timeoutMs: 60_000, what: 'the resumed turn' });
      expect(finished[0]).toMatchObject({ outcome: 'completed', finalText: 'Back again.' });
      const after = (await agents.history({ sessionId: session.id, afterSeq: before.length, limit: 500 })).events;
      expect(after.find((event) => event.kind === 'turn.started')).toMatchObject({ turnId: 't_2' });
      // The model saw the earlier turn (the mock answered with the script's SECOND step), and the command nobody allowed never ran.
      const last = s.mock.requests.filter((request) => request.kind === 'messages' && request.isMain).at(-1);
      expect(last?.assistantTurns).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(last?.lastUser)).toContain('[Host · Host]\\ngo on');
      expect(existsSync(s.path('restart.txt'))).toBe(false);
    } finally {
      await again.cleanup();
    }
  });

  it(`the orphan: smurg died while the agent worked; the next start ends the leftover claude process by its recorded identity, the session is idle with the notice, and nothing restarts by itself (${V})`, async () => {
    const s = await start(() => [bash('touch orphan.txt'), { text: 'Never said.' }]);
    const session = await freeSession(s, 'run something');
    await waitFor(() => s.requests.length === 1, { timeoutMs: 60_000, what: 'the request' });
    const pid = s.agents.liveChildren().find((child) => child.id === session.id)?.pid as number;
    // The registry records the child's identity within its scan; then the state is copied as a crash would leave it.
    await waitFor(
      async () => {
        await s.t.ctx.state.flush();
        const live = JSON.parse(await readFile(join(s.t.ctx.config.workspaceStateDir, 'sessions.json'), 'utf8')) as { procs?: Record<string, { pid: number }[]> };
        return (live.procs?.[session.id] ?? []).some((entry) => entry.pid === pid);
      },
      { timeoutMs: 10_000, what: 'the child in live.json' },
    );
    const copy = await createTempRunDir();
    extraDirs.push(copy);
    await cp(s.t.stateDir, copy, { recursive: true });
    await rm(join(copy, 'run'), { recursive: true, force: true });
    // One folder is shared by one daemon at a time: the second one gets a copy of the project (the first is "dead").
    const rootCopy = join(s.base, 'project-copy');
    await cp(s.t.root, rootCopy, { recursive: true });
    await rm(join(rootCopy, '.smurg'), { recursive: true, force: true });
    const again = await s.another({ root: rootCopy, stateDir: copy });
    try {
      await waitFor(() => !alive(pid), { timeoutMs: 10_000, what: 'the leftover claude process to be ended' });
      const agents = again.ctx.services.agents as AgentSessionsImpl;
      expect(agents.get(session.id)).toMatchObject({ status: 'idle', purpose: 'free' });
      expect(agents.facts(session.id)?.hasProcess).toBe(false);
      const events = (await agents.history({ sessionId: session.id, afterSeq: 0, limit: 500 })).events;
      expect(events.at(-1)).toMatchObject({ kind: 'notice', level: 'warning', text: { id: 'notice.unattended' } });
      expect(events.at(-2)).toMatchObject({ kind: 'turn.finished', outcome: 'interrupted' });
      expect(agents.liveChildren()).toEqual([]);
      expect(existsSync(join(rootCopy, 'orphan.txt'))).toBe(false);
      expect(existsSync(s.path('orphan.txt'))).toBe(false);
    } finally {
      await again.cleanup();
    }
  });
});

describe.skipIf(!claude)(`what the review asked to settle with the real claude (${V}, mock Anthropic API)`, { timeout: 180_000 }, () => {
  it(`DX-9: an \`@path\` in a message, in the note of an answer and in a denial is text: no file reaches the model without a tool call (${V})`, async () => {
    // Without \`client_composed\` on the user line Claude Code 2.1.288 expands a file mention itself: the file's content
    // is in the API request with no tool call, no PreToolUse hook and no permission request, a file of the host's
    // home included (run with the same binary before the fix: both markers below were in what the API received).
    const s = await start(() => [tool('AskUserQuestion', QUESTION), bash('touch mention.txt'), { text: 'Done.' }, { text: 'Second.' }], {
      files: { 'inside.txt': 'INSIDE-MARKER-91bc\n' },
      answer: (request, agents, sessionId) => {
        const note = `see @${join(s.home, 'private-notes.txt')} and @inside.txt`;
        if (request.kind === 'question') agents.answerQuestion(sessionId, request.id, { answers: { 'Which database?': 'SQLite' }, notes: { 'Which database?': note } });
        else agents.decidePermission(sessionId, request.id, { allow: false, message: `No. ${note}` });
      },
    });
    const outside = join(s.home, 'private-notes.txt');
    await writeFile(outside, 'HOME-MARKER-7f3a\n');
    const session = await freeSession(s, `Look at @${outside} and @inside.txt and @.envrc`);
    await s.turnsDone(1);
    await s.say(session.id, `@${outside}`);
    await s.turnsDone(2);
    // The text reached the model as it was written, under its header; none of the three files did.
    expect(s.mock.saw(`[Host · Host]\\nLook at @${outside} and @inside.txt and @.envrc`)).toBe(true);
    expect(s.mock.saw(`No. see @${outside} and @inside.txt`)).toBe(true);
    expect(s.mock.saw('HOME-MARKER-7f3a')).toBe(false);
    expect(s.mock.saw('INSIDE-MARKER-91bc')).toBe(false);
    expect(s.mock.saw('in-envrc')).toBe(false);
    // Nothing of how a message is followed changed: each was taken by a turn and completed.
    expect(s.turns.map((turn) => [turn.outcome, turn.messages.length])).toEqual([['completed', 1], ['completed', 1]]);
    expect((await s.events(session.id)).flatMap((event) => (event.kind === 'delivery' ? [event.state] : []))).toEqual(['queued', 'started', 'completed', 'started', 'completed']);
  });

  it(`R3-06: a hook of the host's own settings rewrites a command: the permission request carries the rewritten command, and that is the one smurg shows, allows and records (${V})`, async () => {
    const s = await start(() => [bash('touch asked-for.txt'), { text: 'Done.' }], {
      hostSettings: ({ base }) => {
        const script = join(base, 'rewrite.mjs');
        writeFileSync(script, "let t='';process.stdin.on('data',(c)=>t+=c);process.stdin.on('end',()=>{const i=JSON.parse(t);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...i.tool_input,command:'touch rewritten-by-hook.txt'}}}));});");
        return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${script}` }] }] } };
      },
      answer: allowAll,
    });
    const session = await freeSession(s, 'run it');
    await s.turnsDone(1);
    // The assistant's tool call (the tool card) still shows what the model wrote; the request is for another command.
    const cards = (await s.events(session.id)).flatMap((event) => (event.kind === 'tool.started' ? [event.tool.target] : []));
    expect(cards).toEqual(['touch asked-for.txt']);
    expect(s.requests).toMatchObject([{ kind: 'permission', tool: 'Bash', view: { name: 'Bash', verb: 'run', target: 'touch rewritten-by-hook.txt' }, input: { command: 'touch rewritten-by-hook.txt' } }]);
    expect(existsSync(s.path('rewritten-by-hook.txt'))).toBe(true);
    expect(existsSync(s.path('asked-for.txt'))).toBe(false);
    const commands = (await s.t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'agent.command').map((entry) => `${String(entry.detail?.['command'])} | ${String(entry.detail?.['why']).replace(/rq_.*/, 'rq')}`);
    expect(commands).toEqual(['touch rewritten-by-hook.txt | decision:rq']);
  });

  it(`DX-10: no subagents: Claude Code is not given the tool, a call of it starts nothing, and a definition that asks for acceptEdits changes no session (${V})`, async () => {
    const MARK = 'SUBAGENT-PROMPT-MARK';
    const s = await start(() => [tool('Task', { description: 'file work', prompt: `${MARK} write sub-wrote.txt`, subagent_type: 'loose' }), { text: 'Main: finished.' }], {
      files: { '.claude/agents/loose.md': '---\nname: loose\ndescription: Does file work.\ntools: Read, Write, Bash\npermissionMode: acceptEdits\n---\nYou do file work.\n' },
      route: ({ root }) => ({ firstUser, assistantTurns }) => (firstUser.includes(MARK) ? ([tool('Write', { file_path: join(root, 'sub-wrote.txt'), content: 'by the subagent\n' }), bash('touch sub-touched.txt'), { text: 'Subagent: done.' }] as MockStep[])[Math.min(assistantTurns, 2)] : undefined),
      answer: allowAll,
    });
    await freeSession(s, 'run the subagent');
    await s.turnsDone(1);
    // A subagent would have been started in the background: give it the time one took when the tool was offered.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const tools = s.ready[0]?.tools ?? [];
    expect(tools.filter((name) => /^(Task|Agent)$/.test(name))).toEqual([]);
    expect(s.results()).toHaveLength(1);
    expect(s.results()[0]).toMatch(/No such tool available/);
    // No conversation of a subagent reached the API, nothing was written, nobody was asked.
    expect(s.mock.requests.filter((request) => request.kind === 'messages' && request.isMain && JSON.stringify(request.lastUser).includes(MARK) && request.assistantTurns === 0 && !JSON.stringify(request.lastUser).includes('run the subagent'))).toEqual([]);
    expect(existsSync(s.path('sub-wrote.txt'))).toBe(false);
    expect(existsSync(s.path('sub-touched.txt'))).toBe(false);
    expect(s.requests).toEqual([]);
    expect(s.turns[0]).toMatchObject({ outcome: 'completed', finalText: 'Main: finished.' });
  });

  it(`R3-05: a shared folder with parentheses and brackets in its name: the session starts, the read rules still hide the private files, a discussion's two files are written without a request (${V})`, async () => {
    // Unescaped, a bracket in the folder's path makes Claude Code read every rule of that folder as a character class:
    // the rules match nothing (run with the same binary before the fix: \`.envrc\` was read and \`cat .envrc\` ran).
    const s = await start(({ root }) => [tool('Read', { file_path: join(root, '.envrc') }), bash('cat .envrc'), tool('Grep', { pattern: 'SECRET', output_mode: 'files_with_matches' }), tool('Write', { file_path: join(root, 'specs/checkout/SPEC.md'), content: '# Checkout\n' }), { text: 'Looked.' }], { rootName: 'Dropbox (Acme) [wip]', answer: allowAll });
    expect(s.t.root.endsWith('/Dropbox (Acme) [wip]')).toBe(true);
    const session = await s.agents.start({
      purpose: 'discussion',
      topic: TOPIC,
      openedBy: s.host(),
      responsible: null,
      workspace: { mode: 'main' },
      mode: 'ask-all',
      rolePrompt: () => 'You are the discussion agent of one topic.',
      opening: msg('conversation.started.discussion', { name: 'Host' }),
      firstMessage: { kind: 'person', from: s.host(), text: 'look around, then draft', cleaned: false, origin: 'composer' },
    });
    await s.turnsDone(1);
    expect(s.agents.get(session.id)).toMatchObject({ status: 'idle' });
    const results = s.mock.toolResults();
    console.log(`[agent-claude-real ${claude?.version}] R3-05 results: ${JSON.stringify(results.map((r) => `${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 70)}`))}`);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[1]).toMatchObject({ isError: true });
    expect(results[2]).toMatchObject({ isError: false });
    expect(results[3]).toMatchObject({ isError: false });
    expect(s.mock.saw('in-envrc')).toBe(false);
    expect(await readFile(s.path('specs/checkout/SPEC.md'), 'utf8')).toBe('# Checkout\n');
    // The spec was written on the discussion's own allow rule: nothing asked.
    expect(s.requests).toEqual([]);
  });
});
