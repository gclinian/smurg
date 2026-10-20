// The agent runtime (ARCHITECTURE §7.6; DESIGN §2) with the stand-in `claude` (src/testing/fake-claude.mjs): the real
// sessions module, a real `claude`-shaped child per live session, the control protocol on its pipes, the conversation
// log on disk. What the conversation, topics and inbox modules would do is done here by hand through the service.
import { existsSync } from 'node:fs';
import { chmod, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AgentSession, type ConversationEvent, type HostState, type PayloadOf } from '@smurg/protocol';
import type { AgentRequest, DaemonEvents, Principal } from '../../src/core/interfaces.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { SYSTEM_ACTOR } from '../../src/core/permissions.ts';
import { PROBE_DIR_NAME, PROBE_SETTINGS } from '../../src/sessions/agent/models.ts';
import { STREAM_ARGS, checkLaunchArgs } from '../../src/sessions/agent/profiles.ts';
import { sessionFilesRoot } from '../../src/hooks/settings-writer.ts';
import { TEST_HOST_USER, createTempDir, createTempRunDir, createTestDaemon, removeTempDir, waitFor, type FakeClaudeScenario, type FakeClaudeStep, type TestClient } from '../../src/testing/index.ts';
import { createFakes, fakeServicesModule } from './helpers.ts';
import { startSessionStack, type SessionStack, type SessionStackOptions } from './setup.ts';

let current: SessionStack | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

const AGENT = { kind: 'agent', workspace: { mode: 'main' } } as const;

interface Rig {
  readonly s: SessionStack;
  readonly host: TestClient;
  readonly agents: AgentSessionsImpl;
  readonly requests: { sessionId: string; request: AgentRequest }[];
  readonly bus: { name: keyof DaemonEvents; event: unknown }[];
  events(sessionId: string): Promise<ConversationEvent[]>;
  kinds(sessionId: string): Promise<string[]>;
  until(sessionId: string, predicate: (session: AgentSession) => boolean, what: string): Promise<AgentSession>;
  hostPrincipal(): Principal;
}

async function rig(turns: readonly { match?: string; once?: boolean; steps: readonly FakeClaudeStep[] }[] = [], options: SessionStackOptions & { scenario?: FakeClaudeScenario } = {}): Promise<Rig> {
  const s = await startSessionStack({ ...options, scenario: { ...options.scenario, turns } });
  current = s;
  const agents = s.t.ctx.services.agents as AgentSessionsImpl;
  const requests: Rig['requests'] = [];
  const bus: Rig['bus'] = [];
  s.t.ctx.bus.on('agent.request', (event) => requests.push(event));
  for (const name of ['agent.process', 'agent.turn.started', 'agent.turn.finished', 'agent.request.withdrawn', 'agent.ready', 'account.changed', 'session.exited'] as const) {
    s.t.ctx.bus.on(name, (event) => bus.push({ name, event }));
  }
  const events = async (sessionId: string): Promise<ConversationEvent[]> => (await agents.history({ sessionId, afterSeq: 0, limit: 500 })).events;
  const host = await s.t.connectHost();
  return {
    s,
    host,
    agents,
    requests,
    bus,
    events,
    kinds: async (sessionId) => (await events(sessionId)).map((event) => (event.kind === 'line' || event.kind === 'notice' ? `${event.kind}:${event.text.id}` : event.kind === 'delivery' ? `delivery:${event.state}` : event.kind)),
    until: async (sessionId, predicate, what) => {
      await waitFor(() => predicate(agents.get(sessionId) as AgentSession), { timeoutMs: 15_000, what });
      return agents.get(sessionId) as AgentSession;
    },
    hostPrincipal: () => s.t.ctx.members.principalOf(TEST_HOST_USER) as Principal,
  };
}

const idle = (session: AgentSession): boolean => session.status === 'idle';

describe('a free agent session, end to end with the stand-in claude', { timeout: 60_000 }, () => {
  it('session.create { kind: "agent", firstMessage }: the opening line, the message under its header, a turn, the answer; audited; the launch profile and the registration of a free session in the main workspace', async () => {
    const r = await rig([{ steps: [{ text: 'Hello Ian.', deltas: ['Hello ', 'Ian.'] }] }]);
    const host = r.host;
    const states: PayloadOf<'session.state'>['session'][] = [];
    host.conn.on('session.state', (payload) => states.push(payload.session));
    const { session } = await host.conn.request('session.create', { ...AGENT, firstMessage: 'Add a test for the empty cart' });
    // 0.6.0: the session follows the workspace (auto, on the wire), launched in Claude Code's auto mode (DESIGN D8).
    expect(session).toMatchObject({ kind: 'agent', purpose: 'free', openedBy: { userId: TEST_HOST_USER }, responsible: null, permissionMode: 'auto', modeChoice: null, model: null, modeFixed: false, title: 'Add a test for the empty cart', root: MAIN_ROOT });
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= 8, 'the first turn to end');
    const events = await r.events(session.id);
    expect(await r.kinds(session.id)).toEqual(['line:conversation.started.free', 'message', 'delivery:queued', 'delivery:started', 'turn.started', 'text', 'turn.finished', 'delivery:completed']);
    expect(events[1]).toMatchObject({ kind: 'message', from: { userId: TEST_HOST_USER, role: 'host' }, text: 'Add a test for the empty cart', origin: 'composer' });
    expect(events[5]).toMatchObject({ kind: 'text', text: 'Hello Ian.', turnId: 't_1' });
    expect(events[6]).toMatchObject({ kind: 'turn.finished', turnId: 't_1', outcome: 'completed' });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // What the agent was told: the header line names who wrote it; no message starts with "/".
    const told = (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'stdin').map((entry) => entry.value as { type: string; message?: { content: { text: string }[] } });
    expect(told.find((line) => line.type === 'user')?.message?.content[0]?.text).toBe('[Host · Host]\nAdd a test for the empty cart');
    // The bus: one process, one turn, with who wrote the message it took.
    expect(r.bus.filter((entry) => entry.name === 'agent.process').map((entry) => (entry.event as DaemonEvents['agent.process']).reason)).toEqual(['started']);
    expect(r.bus.find((entry) => entry.name === 'agent.turn.finished')?.event).toMatchObject({ sessionId: session.id, turnId: 't_1', outcome: 'completed', finalText: 'Hello Ian.', messages: [{ kind: 'person', origin: 'composer', from: { userId: TEST_HOST_USER } }], edited: [] });
    expect(r.bus.find((entry) => entry.name === 'agent.ready')?.event).toMatchObject({ sessionId: session.id, claudeVersion: '2.1.288', login: 'logged-in' });
    // session.state reached the client for the status changes, the last one idle.
    await waitFor(() => states.at(-1)?.kind === 'agent' && states.at(-1)?.status === 'idle', { what: 'session.state idle' });
    expect(states.some((state) => state.kind === 'agent' && state.status === 'running' && state.runningSince !== undefined)).toBe(true);
    // The profile of a free session in the main workspace: auto mode (0.6.0 on purpose: the workspace's default, DESIGN
    // D8), the execution tools, only smurg's MCP server.
    const { profile } = r.s.fakes.hooks.profiles[0] as (typeof r.s.fakes.hooks.profiles)[number];
    expect(profile).toMatchObject({ mode: 'auto', strictMcp: true, settingSources: 'all', ask: [], allow: [] });
    expect(profile.tools).toContain('Bash');
    expect(profile.deny.some((rule) => rule.startsWith('Read(//') && rule.endsWith('/.envrc)'))).toBe(true);
    expect(profile.rolePrompt).toMatch(/^You are an agent in a shared smurg workspace/);
    // The audit log: who opened it, and the full text of the message.
    const audit = await r.s.t.ctx.audit.query({ limit: 50 });
    // The mode it runs with (0.6.0: the workspace's auto) and the model (null: the host's default).
    expect(audit.find((entry) => entry.action === 'session.create')?.detail).toMatchObject({ sessionId: session.id, kind: 'agent', purpose: 'free', mode: 'auto', model: null, root: 'main' });
    expect(audit.find((entry) => entry.action === 'session.message')?.detail).toMatchObject({ sessionId: session.id, origin: 'composer', text: 'Add a test for the empty cart' });
    // The stream flags are the runner's constant; the conversation id is Claude Code's own, not smurg's session id.
    const argv = (await r.s.fakeClaude.echoed()).find((entry) => entry.kind === 'argv')?.value as string[];
    expect(argv.slice(0, 10)).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio']);
    expect(argv[10]).toBe('--session-id');
    expect(argv[11]).not.toBe(session.id);
    expect(argv).not.toContain('--model');
    expect(argv.join(' ')).not.toMatch(/dangerously|bypass/);
  });

  it("an agent session an Agent access member opens is launched exactly like the host's, and is attributed to her: `Claude (Carol)`; her agent's path rights stay a member's", async () => {
    const r = await rig([{ steps: [{ tool: 'Bash', input: { command: 'printf \'%s\\n%s\\n\' "$HOME" "$(pwd -P)" > "agent-env.$SMURG_SESSION_ID"' }, run: true, ask: false }, { text: 'done' }] }]);
    const carol = await r.s.t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const hosts = (await r.host.conn.request('session.create', { ...AGENT, firstMessage: 'hello' })).session;
    const hers = (await carol.conn.request('session.create', { ...AGENT, firstMessage: 'hello' })).session;
    for (const id of [hosts.id, hers.id]) await r.until(id, (now) => now.status === 'idle' && now.lastSeq >= 10, 'the first turn');
    expect(hers).toMatchObject({ kind: 'agent', purpose: 'free', openedBy: { userId: 'dev:carol', displayName: 'Carol' }, permissionMode: 'auto', modeChoice: null, root: MAIN_ROOT });
    // The same process: the host's HOME, the shared folder as its working directory (no guest directory, no sandbox).
    const root = await realpath(r.s.t.root);
    for (const id of [hosts.id, hers.id]) expect((await readFile(join(r.s.t.root, `agent-env.${id}`), 'utf8')).split('\n').slice(0, 2), id).toEqual([r.s.hostHome, root]);
    // The same command line (the conversation id and the launch directory are each session's own) and the same settings file.
    const echoed = await r.s.fakeClaude.echoed();
    const launchOf = (sessionId: string): { flags: string[]; tools: string; mode: string; settings: unknown } => {
      const argv = echoed.find((entry) => entry.kind === 'argv' && entry.session === sessionId)?.value as string[];
      return {
        flags: argv.filter((arg) => arg.startsWith('-')),
        tools: argv[argv.indexOf('--tools') + 1] as string,
        mode: argv[argv.indexOf('--permission-mode') + 1] as string,
        settings: echoed.find((entry) => entry.kind === 'settings' && entry.session === sessionId)?.value,
      };
    };
    expect(launchOf(hers.id)).toEqual(launchOf(hosts.id));
    expect(launchOf(hers.id).flags).toContain('--strict-mcp-config');
    const profileOf = (sessionId: string): Record<string, unknown> => {
      const { rolePrompt: _rolePrompt, ...rest } = r.s.fakes.hooks.profiles.find((entry) => entry.sessionId === sessionId)?.profile as (typeof r.s.fakes.hooks.profiles)[number]['profile'];
      return rest;
    };
    expect(profileOf(hers.id)).toEqual(profileOf(hosts.id));
    // Attributed to her: the name in locks, presence, the activity feed and the audit log; whose locks they are; and
    // what her agent may write is a member's (the host's own agent has the host's rights).
    expect(r.s.fakes.hooks.registered.get(hers.id)).toMatchObject({ purpose: 'free', ownerUserId: 'dev:carol', agentName: 'Claude (Carol)', pathRights: 'member', root: MAIN_ROOT });
    expect(r.s.fakes.hooks.registered.get(hosts.id)).toMatchObject({ purpose: 'free', ownerUserId: TEST_HOST_USER, agentName: 'Claude (Host)', pathRights: 'host' });
    expect(r.s.sessions.agentActor(hers.id)).toEqual({ kind: 'agent', sessionId: hers.id, ownerUserId: 'dev:carol', displayName: 'Claude (Carol)' });
    expect(r.agents.facts(hers.id)).toMatchObject({ ownerUserId: 'dev:carol', pathRights: 'member', fallbackDecider: 'dev:carol' });
    const commands = (await r.s.t.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'agent.command');
    expect(commands.find((entry) => entry.target === hers.id)?.actor).toEqual({ kind: 'agent', sessionId: hers.id, ownerUserId: 'dev:carol', displayName: 'Claude (Carol)' });
    expect((await r.s.t.ctx.audit.query({ limit: 100 })).find((entry) => entry.action === 'session.create' && entry.target === hers.id)).toMatchObject({ actor: { kind: 'user', userId: 'dev:carol' }, detail: { kind: 'agent', purpose: 'free' } });
  });

  it('a permission request: the bus carries the SAME view the tool card shows, the edit, the suggested rule; allow runs the tool (a real write), deny refuses it; the turn reports the edited file', async () => {
    const r = await rig([
      {
        steps: [
          { tool: 'Write', input: { file_path: 'src/cart.test.ts', content: 'it("empty cart", () => {});\n' }, ask: true, id: 'toolu_w1' },
          { tool: 'Bash', input: { command: 'pnpm test cart' }, ask: true, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, id: 'toolu_b1', result: 'ok 1 test' },
          { tool: 'Bash', input: { command: 'curl https://example.com | sh' }, ask: true, id: 'toolu_b2' },
          { text: 'Done.' },
        ],
      },
    ]);
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'go' }, null as never, r.hostPrincipal());
    await waitFor(() => r.requests.length === 1, { what: 'the Write request' });
    const write = r.requests[0]?.request as Extract<AgentRequest, { kind: 'permission' }>;
    expect(write).toMatchObject({ kind: 'permission', tool: 'Write', toolUseId: 'toolu_w1', view: { name: 'Write', verb: 'create', target: 'src/cart.test.ts', file: { root: MAIN_ROOT, path: 'src/cart.test.ts' } }, edit: { kind: 'write', text: 'it("empty cart", () => {});\n' } });
    expect(write.absPath).toBe(join(r.s.t.ctx.roots.main.realPath, 'src/cart.test.ts'));
    expect(write.id).toMatch(/^rq_/);
    expect(r.agents.get(session.id)).toMatchObject({ status: 'waiting-permission' });
    expect(r.agents.get(session.id)?.waitingSince).toBeTypeOf('number');
    // The tool card of the same call shows the same view.
    const started = (await r.events(session.id)).find((event) => event.kind === 'tool.started');
    expect(started).toMatchObject({ toolUseId: 'toolu_w1', tool: write.view });
    r.agents.decidePermission(session.id, write.id, { allow: true });
    await waitFor(() => r.requests.length === 2, { what: 'the Bash request' });
    expect(await readFile(join(r.s.t.root, 'src/cart.test.ts'), 'utf8')).toBe('it("empty cart", () => {});\n');
    const bash = r.requests[1]?.request as Extract<AgentRequest, { kind: 'permission' }>;
    expect(bash).toMatchObject({ tool: 'Bash', view: { verb: 'run', target: 'pnpm test cart' }, suggestedRule: { tool: 'Bash', pattern: 'pnpm test *' }, input: { command: 'pnpm test cart' } });
    expect(bash.edit).toBeUndefined();
    // "Always allow this kind": the rule goes to the running process at destination `session`, never Claude Code's own suggestion.
    r.agents.decidePermission(session.id, bash.id, { allow: true, sessionRule: { tool: 'Bash', pattern: 'pnpm test *' } });
    await waitFor(() => r.requests.length === 3, { what: 'the curl request' });
    const curl = r.requests[2]?.request as Extract<AgentRequest, { kind: 'permission' }>;
    r.agents.decidePermission(session.id, curl.id, { allow: false, message: 'Not that.' });
    // A request answered twice, or one that never existed, is a conflict.
    expect(() => r.agents.decidePermission(session.id, curl.id, { allow: true })).toThrowError(expect.objectContaining({ code: 'conflict' }));
    await r.until(session.id, idle, 'the turn to end');
    const events = await r.events(session.id);
    const finished = events.filter((event) => event.kind === 'tool.finished');
    expect(finished[0]).toMatchObject({ toolUseId: 'toolu_w1', turnId: 't_1', ok: true, result: { additions: 1, deletions: 0, body: { kind: 'diff', text: '+it("empty cart", () => {});\n', truncated: false } } });
    expect(finished[1]).toMatchObject({ toolUseId: 'toolu_b1', ok: true, result: { exitCode: 0, body: { kind: 'output', text: 'ok 1 test' } } });
    expect(finished[2]).toMatchObject({ toolUseId: 'toolu_b2', ok: false });
    const turn = r.bus.find((entry) => entry.name === 'agent.turn.finished')?.event as DaemonEvents['agent.turn.finished'];
    expect(turn.edited).toEqual([{ file: { root: MAIN_ROOT, path: 'src/cart.test.ts' }, seq: started?.seq }]);
    expect(turn.finalText).toBe('Done.');
    const stdin = (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'stdin').map((entry) => entry.value as { type: string; response?: { response?: Record<string, unknown> } });
    const answers = stdin.filter((line) => line.type === 'control_response').map((line) => line.response?.response);
    expect(answers[1]).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test *' }], behavior: 'allow', destination: 'session' }] });
    expect(JSON.stringify(answers)).not.toContain('localSettings');
    expect(answers[2]).toEqual({ behavior: 'deny', message: 'Not that.' });
    // The command a member allowed is audited with that decision.
    const audit = await r.s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'agent.command')).toMatchObject({ actor: { kind: 'agent', sessionId: session.id, displayName: 'Claude (Host)' }, detail: { verb: 'run', why: `decision:${bash.id}`, command: 'pnpm test cart' } });
  });

  it('AskUserQuestion becomes a question request (never a tool card); the answer goes back keyed by the question texts with the notes; a question the wire cannot carry is refused towards the agent with no event', async () => {
    const question = { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] };
    const tooMany = { ...question, options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, description: label })) };
    const r = await rig([
      { steps: [{ tool: 'AskUserQuestion', input: { questions: [tooMany] }, id: 'toolu_q0' }, { tool: 'AskUserQuestion', input: { questions: [question, { ...question, question: 'Which platforms?', header: 'Platforms', multiSelect: true }] }, id: 'toolu_q1' }, { text: 'Thanks.' }] },
    ]);
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'decide' }, null as never, r.hostPrincipal());
    await waitFor(() => r.requests.length === 1, { what: 'the question' });
    const asked = r.requests[0]?.request as Extract<AgentRequest, { kind: 'question' }>;
    expect(asked).toMatchObject({ kind: 'question', toolUseId: 'toolu_q1', parts: [{ header: 'Database', text: 'Which database?', multi: false, options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres', description: 'A server' }] }, { header: 'Platforms', text: 'Which platforms?', multi: true }] });
    expect(r.agents.get(session.id)?.status).toBe('waiting-answer');
    r.agents.answerQuestion(session.id, asked.id, { answers: { 'Which database?': 'SQLite', 'Which platforms?': 'SQLite, Postgres' }, notes: { 'Which database?': '3 of 4 voted SQLite' } });
    await r.until(session.id, idle, 'the turn to end');
    const events = await r.events(session.id);
    expect(events.filter((event) => event.kind === 'tool.started' || event.kind === 'tool.finished')).toEqual([]);
    const stdin = (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'stdin').map((entry) => entry.value as { type: string; response?: { response?: Record<string, unknown> } });
    const answers = stdin.filter((line) => line.type === 'control_response').map((line) => line.response?.response);
    expect(answers[0]).toMatchObject({ behavior: 'deny' });
    expect(String(answers[0]?.['message'])).toMatch(/smurg cannot show this question/);
    expect(answers[1]).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which database?': 'SQLite', 'Which platforms?': 'SQLite, Postgres' }, annotations: { 'Which database?': { notes: '3 of 4 voted SQLite' } } } });
  });

  it('"Stop": the line, the turn ends interrupted with who stopped it, the open request is withdrawn with them; the session stays usable', async () => {
    const r = await rig([{ match: 'long', steps: [{ tool: 'Bash', input: { command: 'make all' }, ask: true }, { wait: 'interrupt' }] }]);
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'a long task' }, null as never, r.hostPrincipal());
    await waitFor(() => r.requests.length === 1, { what: 'the request' });
    const by = { userId: TEST_HOST_USER, displayName: 'Host' };
    await r.agents.interrupt(session.id, { kind: 'user', ...by });
    await r.until(session.id, idle, 'the turn to end');
    expect(r.bus.find((entry) => entry.name === 'agent.request.withdrawn')?.event).toEqual({ sessionId: session.id, requestId: r.requests[0]?.request.id, reason: 'stopped', by });
    expect(r.bus.find((entry) => entry.name === 'agent.turn.finished')?.event).toMatchObject({ outcome: 'interrupted', stoppedBy: by });
    const kinds = await r.kinds(session.id);
    expect(kinds).toContain('line:conversation.stopped');
    const before = r.agents.get(session.id)?.lastSeq ?? 0;
    expect((await r.events(session.id)).find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'interrupted', stoppedBy: by });
    expect(() => r.agents.decidePermission(session.id, r.requests[0]?.request.id as string, { allow: true })).toThrowError(expect.objectContaining({ code: 'conflict' }));
    // The next message is a new turn of the same process.
    await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'thanks', cleaned: false, origin: 'composer' });
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= before + 6, 'the second turn');
    expect((await r.events(session.id)).filter((event) => event.kind === 'turn.finished').map((event) => (event.kind === 'turn.finished' ? event.outcome : ''))).toEqual(['interrupted', 'completed']);
    expect((await r.s.t.ctx.audit.query({ limit: 50 })).some((entry) => entry.action === 'session.interrupt')).toBe(true);
  });
});

describe('processes: parking, resume, failure, retry, the daemon stopping', { timeout: 90_000 }, () => {
  it('an idle session gives up its process after parkAfterMs (it stays idle); the next message starts a new process with --resume and the conversation goes on', async () => {
    const r = await rig([], { daemon: { agents: { parkAfterMs: 1_000, escalationSweepMs: 20 } } });
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'one' }, null as never, r.hostPrincipal());
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= 8, 'the first turn');
    expect(r.agents.facts(session.id)?.hasProcess).toBe(true);
    r.s.t.advanceClock(2_000);
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { timeoutMs: 10_000, what: 'the process to be parked' });
    expect(r.agents.get(session.id)?.status).toBe('idle');
    expect(r.s.fakes.hooks.unregistered).toContain(session.id);
    const sent = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'two', cleaned: false, origin: 'composer' });
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= sent.seq + 6, 'the second turn');
    expect(r.bus.filter((entry) => entry.name === 'agent.process').map((entry) => (entry.event as DaemonEvents['agent.process']).reason)).toEqual(['started', 'parked', 'started']);
    const argvs = (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv').map((entry) => entry.value as string[]);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain('--session-id');
    expect(argvs[1]).toContain('--resume');
    expect(argvs[1]?.[argvs[1].indexOf('--resume') + 1]).toBe(argvs[0]?.[argvs[0].indexOf('--session-id') + 1]);
    const events = await r.events(session.id);
    expect(events.filter((event) => event.kind === 'turn.started').map((event) => (event.kind === 'turn.started' ? event.turnId : ''))).toEqual(['t_1', 't_2']);
    expect(events.filter((event) => event.kind === 'delivery' && event.messageId === sent.messageId).map((event) => (event.kind === 'delivery' ? event.state : ''))).toEqual(['queued', 'started', 'completed']);
  });

  it('a process that dies is a failed session with a notice and withdrawn requests; "Try again" resumes it; after three failed starts only the host may retry', async () => {
    const r = await rig([
      { match: 'crash', once: true, steps: [{ tool: 'Bash', input: { command: 'make' }, ask: true }] },
      { match: 'die', steps: [{ exit: 3, stderr: 'boom' }] },
    ]);
    const mei = await r.s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const { session } = await mei.conn.request('session.create', { ...AGENT, firstMessage: 'crash now' });
    await waitFor(() => r.requests.length === 1, { what: 'the request' });
    // The process is killed from outside while it waits for a permission.
    const pid = r.agents.liveChildren().find((child) => child.id === session.id)?.pid as number;
    process.kill(pid, 'SIGKILL');
    const failed = await r.until(session.id, (now) => now.status === 'failed', 'the failure');
    expect(failed.retryHostOnly).toBeUndefined();
    expect(r.bus.find((entry) => entry.name === 'agent.request.withdrawn')?.event).toEqual({ sessionId: session.id, requestId: r.requests[0]?.request.id, reason: 'failed' });
    expect(r.bus.filter((entry) => entry.name === 'agent.process').map((entry) => (entry.event as DaemonEvents['agent.process']).reason)).toEqual(['started', 'failed']);
    const events = await r.events(session.id);
    expect(events.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: { id: 'notice.processExited' }, action: 'retry' });
    expect(events.find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'error' });
    // Not failed: nothing to retry.
    const other = await mei.conn.request('session.create', AGENT);
    await expect(mei.conn.request('session.retry', { sessionId: other.session.id })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'not-failed' } });
    // "Try again": the line, a new process; the conversation that Claude Code already has is resumed.
    const retried = await mei.conn.request('session.retry', { sessionId: session.id });
    expect(retried.session.status).toBe('starting');
    await r.until(session.id, idle, 'the retry');
    expect(await r.kinds(session.id)).toContain('line:conversation.retry.resumed');
    // Starts that fail before any turn of theirs ended: after three in a row only the host may try again.
    for (let i = 0; i < 3; i++) {
      await r.agents.send(session.id, { kind: 'smurg', purpose: 'continue-item', text: 'die' });
      await r.until(session.id, (now) => now.status === 'failed', `failure ${i + 1}`);
      if (i === 2) break;
      await r.agents.retry(session.id, r.hostPrincipal());
      await r.until(session.id, idle, 'the retry');
    }
    expect(r.agents.get(session.id)).toMatchObject({ status: 'failed', retryHostOnly: true });
    await expect(mei.conn.request('session.retry', { sessionId: session.id })).rejects.toMatchObject({ code: 'forbidden', text: { id: 'session.retry.hostOnly' }, detail: { reason: 'host-only' } });
    await expect(r.host.conn.request('session.retry', { sessionId: session.id })).resolves.toBeDefined();
    await r.until(session.id, idle, "the host's retry");
    expect((await r.s.t.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'session.retry').length).toBeGreaterThanOrEqual(2);
  });

  it('a daemon stop ends every agent process but keeps the session: after a restart it is idle, readable, and the next message resumes it', async () => {
    const stateDir = await createTempRunDir();
    try {
      const r = await rig([{ match: 'wait', steps: [{ text: 'Working.' }, { wait: 'interrupt' }] }], { daemon: { stateDir } });
      const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'wait for me' }, null as never, r.hostPrincipal());
      await r.until(session.id, (now) => now.status === 'running' && now.lastSeq >= 6, 'the turn to run');
      const pid = r.agents.liveChildren()[0]?.pid as number;
      r.host.close();
      await r.s.t.daemon.stop();
      expect(() => process.kill(pid, 0)).toThrow();
      // The same state directory and folder, a new daemon.
      const selfCommand = { file: '/usr/bin/true', args: [] };
      const again = await createTestDaemon({
        root: r.s.t.root,
        stateDir,
        workspaceId: r.s.t.workspaceId,
        modules: [fakeServicesModule(createFakes()), createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', HOME: r.s.hostHome, ...r.s.fakeClaude.env }), hostShell: '/bin/sh', launch: { claudePath: r.s.fakeClaude.path, selfCommand } })],
        sessions: { selfCommand, hostHome: r.s.hostHome },
      });
      try {
        const agents = again.ctx.services.agents as AgentSessionsImpl;
        expect(agents.get(session.id)).toMatchObject({ status: 'idle', purpose: 'free', title: 'wait for me' });
        expect(agents.facts(session.id)?.hasProcess).toBe(false);
        const before = (await agents.history({ sessionId: session.id, afterSeq: 0, limit: 500 })).events;
        expect(before.map((event) => (event.kind === 'line' ? event.text.id : event.kind))).toEqual(expect.arrayContaining(['conversation.started.free', 'turn.finished', 'conversation.interrupted.restart']));
        expect(before.find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'interrupted' });
        const host = await again.connectHost();
        const { messageId } = await host.conn.request('session.list', {}).then(async () => agents.send(session.id, { kind: 'person', from: again.ctx.members.principalOf(TEST_HOST_USER) as Principal, text: 'and now?', cleaned: false, origin: 'composer' }));
        expect(messageId).toMatch(/^m_/);
        await waitFor(() => agents.get(session.id)?.status === 'idle' && (agents.get(session.id)?.lastSeq ?? 0) >= before.length + 7, { timeoutMs: 15_000, what: 'the resumed turn' });
        const after = (await agents.history({ sessionId: session.id, afterSeq: before.length, limit: 500 })).events;
        expect(after.find((event) => event.kind === 'turn.started')).toMatchObject({ turnId: 't_2' });
        expect(after.find((event) => event.kind === 'text')).toMatchObject({ text: 'ok' });
      } finally {
        await again.cleanup();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('R5-06 messages that wait for a process, across a restart of smurg', { timeout: 90_000 }, () => {
  it('a session that cannot start (the host is logged out) keeps the messages people write to it; smurg is stopped and started again: they still wait, and the next start delivers them in order, before the new one', async () => {
    const stateDir = await createTempRunDir();
    try {
      const r = await rig([], { daemon: { stateDir, agents: { loginCheckIntervalMs: 1 } } });
      const mei = await r.s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
      const { session } = await r.host.conn.request('session.create', AGENT);
      await r.until(session.id, idle, 'the start');
      await r.agents.restartProcess(session.id, 'slot');
      await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { what: 'the process to be parked' });
      // The host's Claude Code is logged out by now: every start is refused, and what people write waits.
      await r.s.fakeClaude.setScenario({ loggedIn: false });
      const principal = (userId: string): Principal => r.s.t.ctx.members.principalOf(userId) as Principal;
      const refused = (): number => r.bus.filter((entry) => entry.name === 'agent.process' && (entry.event as DaemonEvents['agent.process']).reason === 'failed').length;
      const first = await r.agents.send(session.id, { kind: 'person', from: principal('dev:mei'), text: 'first, from Mei', cleaned: false, origin: 'composer' });
      await waitFor(() => refused() === 1, { what: 'the refused start' });
      const second = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'second, from the host', cleaned: false, origin: 'composer' });
      await waitFor(() => refused() === 2, { what: 'the second refused start' });
      const own = await r.agents.send(session.id, { kind: 'smurg', purpose: 'continue-item', text: 'third, from smurg itself' });
      await waitFor(() => refused() === 3, { what: 'the third refused start' });
      expect(r.agents.get(session.id)?.status).toBe('failed');
      const deliveries = async (agents: AgentSessionsImpl, messageId: string): Promise<string[]> => (await agents.history({ sessionId: session.id, afterSeq: 0, limit: 500 })).events.flatMap((event) => (event.kind === 'delivery' && event.messageId === messageId ? [event.state] : []));
      expect(await deliveries(r.agents, first.messageId)).toEqual(['queued']);
      mei.close();
      r.host.close();
      await r.s.t.daemon.stop();
      // The host logs in and starts smurg again: the same state directory and folder, a new daemon.
      await r.s.fakeClaude.setScenario({});
      const selfCommand = { file: '/usr/bin/true', args: [] };
      const again = await createTestDaemon({
        root: r.s.t.root,
        stateDir,
        workspaceId: r.s.t.workspaceId,
        modules: [fakeServicesModule(createFakes()), createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', HOME: r.s.hostHome, ...r.s.fakeClaude.env }), hostShell: '/bin/sh', launch: { claudePath: r.s.fakeClaude.path, selfCommand } })],
        sessions: { selfCommand, hostHome: r.s.hostHome },
      });
      try {
        const agents = again.ctx.services.agents as AgentSessionsImpl;
        // Nothing runs by itself after a restart, and nothing was thrown away: the messages read "queued", truthfully.
        expect(agents.get(session.id)).toMatchObject({ status: 'idle' });
        expect(agents.facts(session.id)?.hasProcess).toBe(false);
        for (const id of [first.messageId, second.messageId, own.messageId]) expect((await deliveries(agents, id)).at(-1)).toBe('queued');
        await again.connectHost();
        const fresh = await agents.send(session.id, { kind: 'person', from: again.ctx.members.principalOf(TEST_HOST_USER) as Principal, text: 'fourth, after the restart', cleaned: false, origin: 'composer' });
        await waitFor(async () => (await deliveries(agents, fresh.messageId)).includes('completed'), { timeoutMs: 20_000, what: 'the turn that took the new message' });
        for (const id of [first.messageId, second.messageId, own.messageId, fresh.messageId]) expect((await deliveries(agents, id)).slice(-2)).toEqual(['started', 'completed']);
        // The agent read them in the order they were written, each under its own header.
        const told = (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'stdin' && (entry.value as { type?: string }).type === 'user').map((entry) => (entry.value as { message: { content: { text: string }[] } }).message.content[0]?.text ?? '');
        expect(told.map((text) => text.replace(/^\[smurg [a-z0-9]{4}\]/, '[smurg]'))).toEqual(['[Mei · Agent access]\nfirst, from Mei', '[Host · Host]\nsecond, from the host', '[smurg]\nthird, from smurg itself', '[Host · Host]\nfourth, after the restart']);
        // A member who is removed takes back what still waits, also after a restart (nothing waits here any more).
        expect(agents.cancelQueued('dev:mei')).toEqual([]);
      } finally {
        await again.cleanup();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('refusals before a start, and the limits', { timeout: 60_000 }, () => {
  it('Claude Code older than the floor, a logged-out host, no claude at all, the session limit: refused with their own sentence, nothing is created', async () => {
    const old = await rig([], { claudeVersion: '2.1.200' });
    const host = old.host;
    await expect(host.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.claude.tooOld', params: { found: '2.1.200' } }, detail: { reason: 'claude-too-old' } });
    expect(old.agents.list()).toEqual([]);
    expect(old.s.fakes.activity.notifications.map((n) => n.msg?.id)).toContain('notify.claudeVersionTooOld');
    await old.s.cleanup();
    current = null;

    const out = await rig([], { scenario: { loggedIn: false } });
    const host2 = out.host;
    await expect(host2.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.claude.notLoggedIn' } });
    expect(out.agents.account()).toMatchObject({ state: 'logged-out' });
    expect(out.agents.attention()).toMatchObject([{ subject: 'account', recipients: [TEST_HOST_USER], target: { kind: 'console', section: 'sessions' } }]);
    await out.s.cleanup();
    current = null;

    const none = await rig([], { claudePath: '/nonexistent/claude' });
    const host3 = none.host;
    await expect(host3.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.claudeNotFound' } });
    await none.s.cleanup();
    current = null;

    const few = await rig([], { daemon: { agents: { maxAgentSessions: 1 } } });
    const host4 = few.host;
    const first = await host4.conn.request('session.create', AGENT);
    await expect(host4.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.limit.agents', params: { max: 1 } } });
    // An ended session no longer counts.
    await host4.conn.request('session.end', { sessionId: first.session.id });
    await expect(host4.conn.request('session.create', AGENT)).resolves.toBeDefined();
  });

  it('beyond maxAgentProcesses the longest-idle session is parked first; when none is idle the start is refused', async () => {
    const r = await rig([{ match: 'hold', steps: [{ wait: 'interrupt' }] }], { daemon: { agents: { maxAgentProcesses: 1 } } });
    const host = r.host;
    const a = await host.conn.request('session.create', { ...AGENT, firstMessage: 'quick' });
    await r.until(a.session.id, (now) => now.status === 'idle' && now.lastSeq >= 8, 'a to be idle');
    const b = await host.conn.request('session.create', { ...AGENT, firstMessage: 'hold on' });
    expect(r.agents.facts(a.session.id)?.hasProcess).toBe(false);
    await r.until(b.session.id, (now) => now.status === 'running', 'b to run');
    await expect(host.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.limit.processes', params: { max: 1 } } });
  });

  it('a newer, unverified version starts with one notification to the host; the launch files are derived data, removed with the process', async () => {
    const r = await rig([], { claudeVersion: '2.3.0' });
    const session = await r.s.sessions.create(AGENT, null as never, r.hostPrincipal());
    await r.until(session.id, idle, 'the start');
    expect(r.s.fakes.activity.notifications.filter((n) => n.msg?.id === 'notify.claudeVersionUnverified')).toHaveLength(1);
    expect(r.agents.claude()).toEqual({ version: '2.3.0', verdict: 'unverified', login: 'logged-in' });
    const dir = join(r.s.t.stateDir, 'sessions');
    expect(existsSync(dir)).toBe(true);
    await r.agents.end(session.id, { by: { kind: 'user', userId: TEST_HOST_USER, displayName: 'Host' }, reason: 'ended', keepWorktree: true });
    expect(r.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'ended', endedBy: { userId: TEST_HOST_USER } });
    expect(r.s.fakes.hooks.unregistered).toContain(session.id);
    await expect(r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'x', cleaned: false, origin: 'composer' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'ended' }, text: { id: 'session.ended.noMessages' } });
    expect(await r.kinds(session.id)).toContain('line:conversation.ended');
    expect(r.bus.filter((entry) => entry.name === 'session.exited')).toHaveLength(1);
  });
});

// ── protocol 5 (smurg 0.6.0): what a session runs with (DESIGN 0.6.0 D3, D4). The mode choice is stored; what is
// launched for it is still 0.5.2's (`default` or `acceptEdits`) until DESIGN D8. The model: the describe below.

describe('a session\'s mode choice, stored (protocol 5)', { timeout: 60_000 }, () => {
  const linesOf = async (r: Rig, sessionId: string): Promise<unknown[]> => (await r.events(sessionId)).flatMap((event) => (event.kind === 'line' ? [event.text] : []));
  const audited = async (r: Rig, action: string): Promise<unknown[]> => {
    await r.s.t.ctx.audit.flush();
    return (await r.s.t.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === action).map((entry) => entry.detail).reverse();
  };

  it('session.mode.set: a choice of its own, then null to follow the workspace again; each said in the conversation and audited', async () => {
    const r = await rig();
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, idle, 'the session to be ready');
    const chosen = (await r.host.conn.request('session.mode.set', { sessionId: session.id, mode: 'ask-commands' })).session;
    expect(chosen).toMatchObject({ permissionMode: 'ask-commands', modeChoice: 'ask-commands' });
    const followed = (await r.host.conn.request('session.mode.set', { sessionId: session.id, mode: null })).session;
    expect(followed).toMatchObject({ permissionMode: 'auto', modeChoice: null });
    expect((await linesOf(r, session.id)).slice(-2)).toMatchObject([
      { id: 'conversation.mode.changed', params: { mode: 'ask-commands' } },
      { id: 'conversation.mode.followed', params: { mode: 'auto' } },
    ]);
    expect(await audited(r, 'session.mode')).toEqual([{ sessionId: session.id, mode: 'ask-commands' }, { sessionId: session.id, mode: null }]);
    // `ask-nothing` is the workspace's alone.
    await expect(r.host.conn.request('session.mode.set', { sessionId: session.id, mode: 'ask-nothing' } as never)).rejects.toMatchObject({ code: 'bad_request' });
  });

});

// ── smurg 0.6.0: models (DESIGN 0.6.0 D7) with the stand-in ─────────────────────────────────────────────────────────

/** What the probe ran as and did, one entry per line its `claude` noted (probeWrapper). */
type ProbeNote = Readonly<Record<string, string>>;

interface ProbeWrapper {
  /** The `claude` the sessions module is pointed at. */
  readonly path: string;
  /** Which stand-in it runs (the stack's own; known only once the stack exists). */
  use(standIn: string): Promise<void>;
  /** What the next probe does: `fail` (exit 3), `slow-fail` (exit 3 after a second), `hang` (never answers, a child in its group), '' the stand-in. */
  behave(behaviour: '' | 'fail' | 'slow-fail' | 'hang'): Promise<void>;
  notes(): Promise<ProbeNote[]>;
}

const wrappers: string[] = [];
afterEach(async () => {
  for (const dir of wrappers.splice(0)) await removeTempDir(dir);
});

/**
 * A `claude` in front of the stand-in that recognises THE PROBE (the one process smurg starts with `--tools Read`):
 * it notes what the probe ran as (its pid, its folder, whether that folder was private and empty, HOME, a hook
 * socket) and does what the behaviour file says (read at every run). Every other run (`--version`, a session) is the
 * stand-in's.
 */
async function probeWrapper(): Promise<ProbeWrapper> {
  const dir = await createTempDir('probe-wrapper');
  wrappers.push(dir);
  const path = join(dir, 'claude');
  const notes = join(dir, 'probe-notes.log');
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'probe=no',
      'prev=',
      'for arg in "$@"; do if [ "$prev" = "--tools" ] && [ "$arg" = "Read" ]; then probe=yes; fi; prev=$arg; done',
      'if [ "$probe" = yes ]; then',
      `  behaviour=$(cat ${quote(join(dir, 'behaviour'))} 2>/dev/null)`,
      `  printf 'kind=run pid=%s cwd=%s mode=%s entries=%s home=%s hook=%s\\n' "$$" "$(pwd -P)" "$(ls -ld . | cut -c1-10)" "$(ls -A | wc -l | tr -d ' ')" "$HOME" "\${SMURG_HOOK_SOCKET:-none}" >> ${quote(notes)}`,
      '  case "$behaviour" in',
      '    fail) exit 3 ;;',
      '    slow-fail) sleep 1; exit 3 ;;',
      `    hang) sleep 300 & printf 'kind=child pid=%s\\n' "$!" >> ${quote(notes)}; exec sleep 300 ;;`,
      '  esac',
      'fi',
      `exec "$(cat ${quote(join(dir, 'stand-in'))})" "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  await writeFile(notes, '');
  return {
    path,
    use: (standIn) => writeFile(join(dir, 'stand-in'), standIn),
    behave: (behaviour) => writeFile(join(dir, 'behaviour'), behaviour),
    notes: async () =>
      (await readFile(notes, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S*)/g)].map((match) => [match[1] as string, match[2] as string]))),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('models (DESIGN 0.6.0 D7): the list, --model on every start, the live change, what Claude Code refuses or replaces', { timeout: 90_000 }, () => {
  const linesOf = async (r: Rig, sessionId: string): Promise<{ id: string; params?: Record<string, unknown> }[]> =>
    (await r.events(sessionId)).flatMap((event) => (event.kind === 'line' ? [event.text as { id: string; params?: Record<string, unknown> }] : []));
  const noticesOf = async (r: Rig, sessionId: string): Promise<Extract<ConversationEvent, { kind: 'notice' }>[]> => (await r.events(sessionId)).filter((event): event is Extract<ConversationEvent, { kind: 'notice' }> => event.kind === 'notice');
  const audited = async (r: Rig, action: string): Promise<unknown[]> => {
    await r.s.t.ctx.audit.flush();
    return (await r.s.t.ctx.audit.query({ limit: 200 })).filter((entry) => entry.action === action).map((entry) => entry.detail).reverse();
  };
  const argvsOf = async (r: Rig, sessionId: string): Promise<string[][]> => (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv' && entry.session === sessionId).map((entry) => entry.value as string[]);
  const controlsOf = async (r: Rig, sessionId: string, subtype: string): Promise<Record<string, unknown>[]> =>
    (await r.s.fakeClaude.echoed())
      .filter((entry) => entry.kind === 'stdin' && entry.session === sessionId)
      .map((entry) => entry.value as { type?: string; request?: Record<string, unknown> })
      .filter((line) => line.type === 'control_request' && line.request?.['subtype'] === subtype)
      .map((line) => line.request as Record<string, unknown>);
  /** The host agent's list is known (the probe asked the stand-in). */
  const knownModels = async (r: Rig): Promise<void> => {
    await r.host.conn.request('session.host.get', {});
    await r.agents.modelsSettled();
    expect(r.agents.hostAgentState().modelsKnown).toBe(true);
  };

  it('the probe: the first session.host.get asks the host\'s Claude Code with the flags U1 E7 measured, in a private empty folder, hooks off, no hook socket; the list and the host\'s default reach every member as session.host; it runs once and leaves nothing', async () => {
    const wrapper = await probeWrapper();
    const r = await rig([], { claudePath: wrapper.path });
    await wrapper.use(r.s.fakeClaude.path);
    const leo = await r.s.t.connect({ userId: 'dev:leo', displayName: 'Leo', role: 'viewer' });
    const told: HostState[] = [];
    leo.conn.on('session.host', (payload) => told.push(payload));
    const first = await leo.conn.request('session.host.get', {});
    // Nothing waits for the answer: the first reply says what is known now.
    expect(first.agent).toMatchObject({ models: [], modelsKnown: false, hostDefault: null });
    await waitFor(() => told.some((state) => state.agent.modelsKnown), { timeoutMs: 15_000, what: 'everyone to be told the list' });
    await r.agents.modelsSettled();
    const known = (told.at(-1) as HostState).agent;
    // Claude Code 2.1.288's list without `default` (smurg's null is the host's default); the host's default is what a
    // process that names no model runs on (the stand-in's `claude-fake`).
    expect(known.models.map((entry) => [entry.value, entry.name, entry.resolved, entry.auto, entry.billing ?? null])).toEqual([
      ['opus', 'Opus', 'claude-opus-5-5', true, null],
      ['fable', 'Fable', 'claude-fable-5-1', true, 'usage-credits'],
      ['sonnet', 'Sonnet', 'claude-sonnet-5-5', true, null],
      ['haiku', 'Haiku', 'claude-haiku-4-5-20251001', false, null],
    ]);
    expect(known).toMatchObject({ modelsKnown: true, hostDefault: 'claude-fake' });
    expect((await r.host.conn.request('session.host.get', {})).agent).toEqual(known);
    // What ran: exactly the flags U1 E7 measured, after the runner's stream flags and a fresh conversation id.
    const ran = (await r.s.fakeClaude.echoed()).filter((entry) => typeof entry.session === 'string' && entry.session.startsWith('smurg-probe-'));
    const dir = join(sessionFilesRoot(r.s.t.ctx.config.stateDir, r.s.t.ctx.config.workspaceId), PROBE_DIR_NAME);
    const argv = ran.find((entry) => entry.kind === 'argv')?.value as string[];
    expect(argv.slice(0, 10)).toEqual([...STREAM_ARGS]);
    expect(argv[10]).toBe('--session-id');
    expect(argv[11]).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv.slice(12)).toEqual(['--permission-mode', 'default', '--settings', join(dir, 'settings.json'), '--mcp-config', join(dir, 'mcp.json'), '--tools', 'Read', '--strict-mcp-config', '--setting-sources', 'user']);
    expect(checkLaunchArgs(argv.slice(12))).toBeNull();
    expect(ran.find((entry) => entry.kind === 'settings')?.value).toEqual(PROBE_SETTINGS);
    // Two control requests, no message: no turn, so no conversation either.
    const asked = ran.filter((entry) => entry.kind === 'stdin').map((entry) => entry.value as { type: string; request?: { subtype?: string } });
    expect(asked.map((line) => `${line.type}:${line.request?.subtype ?? ''}`)).toEqual(['control_request:initialize', 'control_request:get_settings']);
    expect(existsSync(join(r.s.hostHome, '.claude', 'fake-claude', `${argv[11] as string}.json`))).toBe(false);
    // As the host, in its own private empty folder, without the gate's socket; nothing of it is left.
    const notes = (await wrapper.notes()).filter((note) => note['kind'] === 'run');
    expect(notes).toHaveLength(1);
    const note = notes[0] as ProbeNote;
    expect(note).toMatchObject({ cwd: await realpath(join(dir, 'cwd')).catch(() => join(dir, 'cwd')), mode: 'drwx------', entries: '0', home: r.s.hostHome, hook: 'none' });
    await waitFor(() => !alive(Number(note['pid'])), { timeoutMs: 5_000, what: 'the probe to be gone' });
    expect(existsSync(dir)).toBe(false);
    // Known: no second probe. Sessions keep the list fresh with their own `initialize`.
    await r.host.conn.request('session.host.get', {});
    await r.agents.modelsSettled();
    expect((await wrapper.notes()).filter((entry) => entry['kind'] === 'run')).toHaveLength(1);
  });

  it('a probe that fails: every model is refused while the list is not known (models-not-known), one probe at a time, not again for a minute; then a model of the list is accepted and one it does not hold is refused', async () => {
    const wrapper = await probeWrapper();
    const r = await rig([{ steps: [{ text: 'ok' }] }], { claudePath: wrapper.path });
    await wrapper.use(r.s.fakeClaude.path);
    await wrapper.behave('slow-fail');
    const runs = async (): Promise<number> => (await wrapper.notes()).filter((note) => note['kind'] === 'run').length;
    // Three pages ask at once: one probe.
    const gets = await Promise.all([0, 1, 2].map(() => r.host.conn.request('session.host.get', {})));
    for (const got of gets) expect(got.agent.modelsKnown).toBe(false);
    await r.agents.modelsSettled();
    expect(await runs()).toBe(1);
    await expect(r.host.conn.request('session.create', { ...AGENT, model: 'sonnet' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'models-not-known' }, text: { id: 'session.model.notKnown' } });
    expect(r.agents.list()).toEqual([]);
    // Within a minute of the failure nothing asks again (neither a page nor a refused model).
    r.s.t.advanceClock(59_000);
    await r.host.conn.request('session.host.get', {});
    await r.agents.modelsSettled();
    expect(await runs()).toBe(1);
    // After it, a request that names a model while the list is not known asks again.
    r.s.t.advanceClock(2_000);
    await expect(r.host.conn.request('session.create', { ...AGENT, model: 'sonnet' })).rejects.toMatchObject({ detail: { reason: 'models-not-known' } });
    await r.agents.modelsSettled();
    expect(await runs()).toBe(2);
    // The host's Claude Code answers now.
    await wrapper.behave('');
    r.s.t.advanceClock(61_000);
    await r.host.conn.request('session.host.get', {});
    await r.agents.modelsSettled();
    expect(await runs()).toBe(3);
    expect(r.agents.hostAgentState()).toMatchObject({ modelsKnown: true, hostDefault: 'claude-fake' });
    await expect(r.host.conn.request('session.create', { ...AGENT, model: 'gpt-5' })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'model-not-offered' }, text: { id: 'session.model.notOffered', params: { model: 'gpt-5' } } });
    // `default` is Claude Code's own name for the host's default, which is smurg's null: not a model of the list.
    await expect(r.host.conn.request('session.create', { ...AGENT, model: 'default' })).rejects.toMatchObject({ detail: { reason: 'model-not-offered' } });
    const { session } = await r.host.conn.request('session.create', { ...AGENT, model: 'sonnet' });
    expect(session).toMatchObject({ model: 'sonnet' });
  });

  it('a daemon stop during a probe that never answers ends it and what it started, and awaits it (no process is left)', async () => {
    const wrapper = await probeWrapper();
    const r = await rig([], { claudePath: wrapper.path });
    await wrapper.use(r.s.fakeClaude.path);
    await wrapper.behave('hang');
    await r.host.conn.request('session.host.get', {});
    await waitFor(async () => (await wrapper.notes()).some((note) => note['kind'] === 'child'), { timeoutMs: 15_000, what: 'the probe and its child to run' });
    const pids = (await wrapper.notes()).map((note) => Number(note['pid']));
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid), String(pid)).toBe(true);
    const started = Date.now();
    await r.s.cleanup();
    current = null;
    // Well within the 30 s an `initialize` may take: the stop does not wait for the answer that never comes.
    expect(Date.now() - started).toBeLessThan(20_000);
    await waitFor(() => pids.every((pid) => !alive(pid)), { timeoutMs: 5_000, what: 'the probe and its child to be gone' });
  });

  it('--model on every start, the resume included, and none for the host\'s default; what runs is the `init`\'s model on the wire; audited and kept in agent-sessions.json; a parked session only stores a change, its next start passes it', async () => {
    const r = await rig([{ steps: [{ text: 'ok' }] }]);
    await knownModels(r);
    const { session } = await r.host.conn.request('session.create', { ...AGENT, model: 'sonnet', firstMessage: 'hello' });
    expect(session).toMatchObject({ model: 'sonnet' });
    const ran = await r.until(session.id, (now) => now.status === 'idle' && now.modelInUse !== undefined && now.lastSeq >= 8, 'the first turn');
    expect(ran.modelInUse).toBe('claude-sonnet-5-5');
    const [first] = await argvsOf(r, session.id);
    expect(first?.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(first?.filter((arg) => arg === '--model')).toHaveLength(1);
    expect((await audited(r, 'session.create')).at(-1)).toMatchObject({ sessionId: session.id, model: 'sonnet' });
    type Stored = { sessions: { id: string; model: string | null; modelChangedBy?: { userId: string } }[] };
    const stored = async (): Promise<Stored['sessions'][number] | undefined> => (JSON.parse(await readFile(join(r.s.t.ctx.state.dir, 'agent-sessions.json'), 'utf8')) as Stored).sessions.find((entry) => entry.id === session.id);
    await waitFor(async () => (await stored())?.model === 'sonnet', { what: 'the model in agent-sessions.json' });
    expect(await stored()).toMatchObject({ model: 'sonnet', modelChangedBy: { userId: TEST_HOST_USER } });

    // A session nobody chose a model for: no `--model`, it runs on the host's own default.
    const plain = (await r.host.conn.request('session.create', { ...AGENT, firstMessage: 'hello' })).session;
    expect(plain).toMatchObject({ model: null });
    expect((await r.until(plain.id, (now) => now.status === 'idle' && now.modelInUse !== undefined, 'the plain turn')).modelInUse).toBe('claude-fake');
    expect((await argvsOf(r, plain.id))[0]).not.toContain('--model');
    expect((await audited(r, 'session.create')).at(-1)).toMatchObject({ sessionId: plain.id, model: null });

    // Parked, then resumed: `--resume` AND `--model` (U1 E6: only that decides the model of a resumed conversation).
    await r.agents.restartProcess(session.id, 'asked');
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { what: 'the process to be parked' });
    const second = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'again', cleaned: false, origin: 'composer' });
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= second.seq + 6, 'the resumed turn');
    const resumed = (await argvsOf(r, session.id))[1] as string[];
    expect(resumed).toContain('--resume');
    expect(resumed.slice(-2)).toEqual(['--model', 'sonnet']);

    // A change while parked: stored, nothing sent (there is no process); the next start passes it.
    await r.agents.restartProcess(session.id, 'asked');
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { what: 'the process to be parked again' });
    const changed = (await r.host.conn.request('session.model.set', { sessionId: session.id, model: 'opus' })).session;
    expect(changed).toMatchObject({ model: 'opus' });
    expect(await controlsOf(r, session.id, 'set_model')).toEqual([]);
    const third = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'and again', cleaned: false, origin: 'composer' });
    const after = await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= third.seq + 6, 'the turn after the change');
    expect((await argvsOf(r, session.id))[2]?.slice(-2)).toEqual(['--model', 'opus']);
    expect(after.modelInUse).toBe('claude-opus-5-5');
  });

  it('session.model.set on a running process: Claude Code\'s set_model, the next turn\'s `init` shows the model; a line and an audit entry each; null goes back to the host\'s default; a model the list does not hold is refused', async () => {
    const r = await rig([{ steps: [{ text: 'ok' }] }]);
    await knownModels(r);
    const { session } = await r.host.conn.request('session.create', { ...AGENT, firstMessage: 'one' });
    expect((await r.until(session.id, (now) => now.status === 'idle' && now.modelInUse !== undefined, 'the first turn')).modelInUse).toBe('claude-fake');
    const set = (await r.host.conn.request('session.model.set', { sessionId: session.id, model: 'haiku' })).session;
    // What runs changes with the next turn.
    expect(set).toMatchObject({ model: 'haiku', modelInUse: 'claude-fake' });
    expect(await controlsOf(r, session.id, 'set_model')).toEqual([{ subtype: 'set_model', model: 'haiku' }]);
    expect((await linesOf(r, session.id)).at(-1)).toMatchObject({ id: 'conversation.model.changed', params: { by: 'Host', model: 'haiku' } });
    expect(await audited(r, 'session.model')).toEqual([{ sessionId: session.id, model: 'haiku' }]);
    expect(r.agents.facts(session.id)?.modelChangedBy).toBe(TEST_HOST_USER);
    const two = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'two', cleaned: false, origin: 'composer' });
    expect((await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= two.seq + 5, 'the second turn')).modelInUse).toBe('claude-haiku-4-5-20251001');
    // The same process all along.
    expect(await argvsOf(r, session.id)).toHaveLength(1);
    // Back to the host's default: `set_model` without a model.
    const back = (await r.host.conn.request('session.model.set', { sessionId: session.id, model: null })).session;
    expect(back).toMatchObject({ model: null });
    expect((await controlsOf(r, session.id, 'set_model')).at(-1)).toEqual({ subtype: 'set_model' });
    expect((await linesOf(r, session.id)).at(-1)).toMatchObject({ id: 'conversation.model.default', params: { by: 'Host' } });
    expect((await audited(r, 'session.model')).at(-1)).toEqual({ sessionId: session.id, model: null });
    expect(r.agents.facts(session.id)?.modelChangedBy).toBeUndefined();
    const three = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'three', cleaned: false, origin: 'composer' });
    expect((await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= three.seq + 5, 'the third turn')).modelInUse).toBe('claude-fake');
    // Not on the list: refused before anything is sent.
    const before = (await r.events(session.id)).length;
    await expect(r.host.conn.request('session.model.set', { sessionId: session.id, model: 'gpt-5' })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'model-not-offered' } });
    expect((await r.events(session.id)).length).toBe(before);
    expect(await controlsOf(r, session.id, 'set_model')).toHaveLength(2);
  });

  it('an organization\'s restriction: a model replaced at the start is said once per process (notice.modelSubstituted); a live switch Claude Code refuses (restricted_by_org, or any other error) changes nothing', async () => {
    const r = await rig([{ steps: [{ text: 'ok' }] }], { scenario: { refuseSwitch: ['fable'] } });
    await knownModels(r);
    const { session } = await r.host.conn.request('session.create', { ...AGENT, model: 'fable', firstMessage: 'one' });
    const ran = await r.until(session.id, (now) => now.status === 'idle' && now.modelInUse !== undefined && now.lastSeq >= 8, 'the first turn');
    expect((await argvsOf(r, session.id))[0]?.slice(-2)).toEqual(['--model', 'fable']);
    // Claude Code runs another model (U4 N): the session says which, naming the model as the list does.
    expect(ran).toMatchObject({ model: 'fable', modelInUse: 'claude-fake' });
    const substituted = (await noticesOf(r, session.id)).filter((notice) => notice.text.id === 'notice.modelSubstituted');
    expect(substituted).toEqual([expect.objectContaining({ level: 'warning', text: { id: 'notice.modelSubstituted', params: { model: 'Fable', inUse: 'claude-fake' } } })]);
    const two = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'two', cleaned: false, origin: 'composer' });
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= two.seq + 5, 'the second turn');
    expect((await noticesOf(r, session.id)).filter((notice) => notice.text.id === 'notice.modelSubstituted')).toHaveLength(1);

    // The live switch back to it: Claude Code refuses with `restricted_by_org`; nothing changes, nothing is said.
    const plain = (await r.host.conn.request('session.create', { ...AGENT, firstMessage: 'one' })).session;
    await r.until(plain.id, (now) => now.status === 'idle' && now.modelInUse !== undefined, 'the plain turn');
    const before = (await r.events(plain.id)).length;
    await expect(r.host.conn.request('session.model.set', { sessionId: plain.id, model: 'fable' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'model-restricted' }, text: { id: 'session.model.refused', params: { model: 'Fable' } } });
    expect(await controlsOf(r, plain.id, 'set_model')).toEqual([{ subtype: 'set_model', model: 'fable' }]);
    expect(r.agents.get(plain.id)).toMatchObject({ model: null });
    expect((await r.events(plain.id)).length).toBe(before);
    expect(await audited(r, 'session.model')).toEqual([]);
    // A model it does allow: switched live.
    await r.host.conn.request('session.model.set', { sessionId: plain.id, model: 'sonnet' });
    expect(r.agents.get(plain.id)).toMatchObject({ model: 'sonnet' });
    // Any other refusal (no error code at all): the same words, the generic branch; nothing changes.
    await r.s.fakeClaude.setScenario({ refuseSwitch: ['fable'], turns: [{ steps: [{ text: 'ok' }] }], controlErrors: { set_model: { error: 'Something else went wrong' } } });
    await expect(r.host.conn.request('session.model.set', { sessionId: plain.id, model: 'opus' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'model-refused' }, text: { id: 'session.model.refused', params: { model: 'Opus' } } });
    expect(r.agents.get(plain.id)).toMatchObject({ model: 'sonnet' });
    expect(await audited(r, 'session.model')).toEqual([{ sessionId: plain.id, model: 'sonnet' }]);
    // smurg itself puts the model back (DESIGN D12: who chose it went) and the process refuses the switch: the record
    // changes all the same, the line names who had chosen it, and the process starts again (without `--model`).
    await r.agents.setModel(plain.id, null, SYSTEM_ACTOR);
    expect(r.agents.get(plain.id)).toMatchObject({ model: null });
    expect((await linesOf(r, plain.id)).at(-1)).toMatchObject({ id: 'conversation.model.reset', params: { name: 'Host' } });
    await waitFor(() => r.agents.facts(plain.id)?.hasProcess === false, { what: 'the process to start again' });
    const again = await r.agents.send(plain.id, { kind: 'person', from: r.hostPrincipal(), text: 'again', cleaned: false, origin: 'composer' });
    const after = await r.until(plain.id, (now) => now.status === 'idle' && now.lastSeq >= again.seq + 6, 'the turn after the reset');
    expect(after.modelInUse).toBe('claude-fake');
    expect((await argvsOf(r, plain.id)).at(-1)).not.toContain('--model');
  });

  it('a model the API refuses: Claude Code\'s own sentence is not shown as the agent\'s words; the session says which model, once, with "Choose a model" and no second error notice; the process stays and a model change rescues it', async () => {
    const r = await rig([{ steps: [{ text: 'ok' }] }], { scenario: { refuseModels: ['claude-sonnet-5-5'] } });
    await knownModels(r);
    const { session } = await r.host.conn.request('session.create', { ...AGENT, model: 'sonnet', firstMessage: 'one' });
    await waitFor(async () => (await r.events(session.id)).some((event) => event.kind === 'turn.finished'), { timeoutMs: 15_000, what: 'the refused turn' });
    await r.until(session.id, (now) => now.status === 'idle', 'the session to be idle');
    const events = await r.events(session.id);
    expect(events.filter((event) => event.kind === 'text')).toEqual([]);
    expect(events.find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'error' });
    const notices = await noticesOf(r, session.id);
    expect(notices.map((notice) => notice.text.id)).toEqual(['notice.modelRefused']);
    expect(notices[0]).toMatchObject({ level: 'error', action: 'choose-model', text: { params: { model: 'Sonnet' } } });
    expect(r.agents.facts(session.id)?.hasProcess).toBe(true);
    // Another model: the same process takes it, and the next turn goes through.
    await r.host.conn.request('session.model.set', { sessionId: session.id, model: 'opus' });
    const two = await r.agents.send(session.id, { kind: 'person', from: r.hostPrincipal(), text: 'two', cleaned: false, origin: 'composer' });
    const after = await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= two.seq + 5, 'the rescued turn');
    expect(after.modelInUse).toBe('claude-opus-5-5');
    expect((await r.events(session.id)).filter((event) => event.kind === 'text').map((event) => (event.kind === 'text' ? event.text : ''))).toEqual(['ok']);
    expect((await noticesOf(r, session.id)).map((notice) => notice.text.id)).toEqual(['notice.modelRefused']);
    expect(await argvsOf(r, session.id)).toHaveLength(1);
  });
});
