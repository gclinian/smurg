// More of the agent runtime's contract, with the stand-in `claude` (DESIGN §2.2, §2.4, §2.5, §2.7, §2.8): messages
// that wait and are taken back, a turn that ends with an error, the memory mark, a tool outside the session's list, the
// notice about a personal subscription, a root that is gone, the launch check at a start, the copy of a card for the
// host among the watchers, and what is kept of the conversation logs.
import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AgentSession, type ConversationEvent, type PayloadOf } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildPermission } from '../../src/core/fakes/build.ts';
import type { DaemonEvents, Principal } from '../../src/core/interfaces.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { loginOfAccount } from '../../src/sessions/agent/agent-runner.ts';
import { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import type { HostRulesImpl } from '../../src/sessions/agent/host-rules.ts';
import type { ProjectTrustImpl } from '../../src/sessions/agent/project-settings.ts';
import { CLAUDE_ACCOUNTS, TEST_HOST_USER, createTempDir, createTempRunDir, createTestDaemon, removeTempDir, removeTempRunDir, waitFor, type FakeClaudeScenario, type FakeClaudeStep, type TestClient } from '../../src/testing/index.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { createFakes, fakeServicesModule } from './helpers.ts';
import { startSessionStack, type SessionStack, type SessionStackOptions } from './setup.ts';

let current: SessionStack | null = null;
const dirs: string[] = [];
/** State directories a test owns (a second daemon ran over them). */
const runDirs: string[] = [];
afterEach(async () => {
  await current?.cleanup();
  current = null;
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
  for (const dir of runDirs.splice(0)) await removeTempRunDir(dir);
});

const AGENT = { kind: 'agent', workspace: { mode: 'main' } } as const;

interface Rig {
  readonly s: SessionStack;
  readonly host: TestClient;
  readonly agents: AgentSessionsImpl;
  readonly bus: { name: keyof DaemonEvents; event: unknown }[];
  events(sessionId: string): Promise<ConversationEvent[]>;
  ids(sessionId: string): Promise<string[]>;
  until(sessionId: string, predicate: (session: AgentSession) => boolean, what: string): Promise<AgentSession>;
  principal(userId: string): Principal;
  say(sessionId: string, from: string, text: string): Promise<{ readonly messageId: string; readonly seq: number }>;
  /** What the stand-in processes were told as user messages, in order. */
  told(): Promise<string[]>;
  deliveries(sessionId: string, messageId: string): Promise<string[]>;
}

async function rig(turns: readonly { match?: string; once?: boolean; steps: readonly FakeClaudeStep[] }[] = [], options: SessionStackOptions & { scenario?: FakeClaudeScenario } = {}): Promise<Rig> {
  const s = await startSessionStack({ ...options, scenario: { ...options.scenario, turns } });
  current = s;
  const agents = s.t.ctx.services.agents as AgentSessionsImpl;
  const bus: Rig['bus'] = [];
  for (const name of ['agent.process', 'agent.turn.finished', 'attention.changed', 'session.exited'] as const) s.t.ctx.bus.on(name, (event) => bus.push({ name, event }));
  const events = async (sessionId: string): Promise<ConversationEvent[]> => (await agents.history({ sessionId, afterSeq: 0, limit: 500 })).events;
  const host = await s.t.connectHost();
  const principal = (userId: string): Principal => s.t.ctx.members.principalOf(userId) as Principal;
  return {
    s,
    host,
    agents,
    bus,
    events,
    ids: async (sessionId) => (await events(sessionId)).map((event) => (event.kind === 'line' || event.kind === 'notice' ? event.text.id : event.kind === 'delivery' ? `delivery:${event.state}` : event.kind)),
    until: async (sessionId, predicate, what) => {
      await waitFor(() => predicate(agents.get(sessionId) as AgentSession), { timeoutMs: 15_000, what });
      return agents.get(sessionId) as AgentSession;
    },
    principal,
    say: (sessionId, from, text) => agents.send(sessionId, { kind: 'person', from: principal(from), text, cleaned: false, origin: 'composer' }),
    told: async () =>
      (await s.fakeClaude.echoed())
        .filter((entry) => entry.kind === 'stdin' && (entry.value as { type?: string }).type === 'user')
        .map((entry) => (entry.value as { message: { content: { text: string }[] } }).message.content[0]?.text ?? ''),
    deliveries: async (sessionId, messageId) => (await events(sessionId)).filter((event) => event.kind === 'delivery' && event.messageId === messageId).map((event) => (event.kind === 'delivery' ? event.state : '')),
  };
}

const idle = (session: AgentSession): boolean => session.status === 'idle';
const reasons = (r: Rig): string[] => r.bus.filter((entry) => entry.name === 'agent.process').map((entry) => (entry.event as DaemonEvents['agent.process']).reason);

describe('messages that wait', { timeout: 60_000 }, () => {
  it('a message for a session without a process waits and can be taken back; one written while a turn runs is held by Claude Code until a turn takes it; text that is nothing once cleaned is refused', async () => {
    const r = await rig([{ match: 'long', steps: [{ wait: 'interrupt' }] }]);
    await r.s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, idle, 'the start');
    await r.agents.restartProcess(session.id, 'slot');
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { what: 'the process to be parked' });
    // Two people write to the parked session: both messages wait for the process that starts now.
    const meis = await r.say(session.id, 'dev:mei', 'mine, taken back');
    const hosts = await r.say(session.id, TEST_HOST_USER, 'the one that stays');
    expect(r.agents.cancelQueued('dev:mei')).toEqual([{ sessionId: session.id, messageIds: [meis.messageId] }]);
    expect(r.agents.cancelQueued('dev:mei')).toEqual([]);
    await waitFor(async () => (await r.deliveries(session.id, hosts.messageId)).includes('completed'), { timeoutMs: 15_000, what: 'the turn of the message that stayed' });
    expect(await r.deliveries(session.id, meis.messageId)).toEqual(['queued', 'cancelled']);
    expect(await r.deliveries(session.id, hosts.messageId)).toEqual(['queued', 'started', 'completed']);
    // The agent never saw what was taken back; the message itself stays in the conversation for people.
    expect(await r.told()).toEqual(['[Host · Host]\nthe one that stays']);
    expect((await r.events(session.id)).filter((event) => event.kind === 'message').map((event) => (event.kind === 'message' ? event.text : ''))).toEqual(['mine, taken back', 'the one that stays']);
    expect(r.bus.filter((entry) => entry.name === 'agent.turn.finished').map((entry) => (entry.event as DaemonEvents['agent.turn.finished']).messages.map((message) => message.messageId))).toEqual([[hosts.messageId]]);

    // While a turn runs a message is written to the process at once; Claude Code holds it for its next tool boundary.
    await r.say(session.id, TEST_HOST_USER, 'a long task');
    await r.until(session.id, (now) => now.status === 'running', 'the long turn');
    const held = await r.say(session.id, 'dev:mei', 'while you work');
    await waitFor(async () => (await r.deliveries(session.id, held.messageId)).includes('queued'), { what: 'Claude Code holding the message' });
    expect(r.agents.holdingUndelivered('dev:mei')).toEqual([session.id]);
    expect(r.agents.holdingUndelivered(TEST_HOST_USER)).toEqual([]);
    // A process has it: it cannot be taken back any more (a kicked member's is stopped instead, ARCHITECTURE §3).
    expect(r.agents.cancelQueued('dev:mei')).toEqual([]);
    await r.agents.interrupt(session.id, { kind: 'system' });
    await waitFor(async () => (await r.deliveries(session.id, held.messageId)).includes('completed'), { timeoutMs: 15_000, what: 'the turn that took the held message' });
    expect(r.agents.holdingUndelivered('dev:mei')).toEqual([]);
    expect(await r.deliveries(session.id, held.messageId)).toEqual(['queued', 'started', 'completed']);
    const outcomes = r.bus.filter((entry) => entry.name === 'agent.turn.finished').map((entry) => (entry.event as DaemonEvents['agent.turn.finished']).outcome);
    expect(outcomes).toEqual(['completed', 'interrupted', 'completed']);
    // Stopped by the system: no "stopped" line, nobody named.
    expect(await r.ids(session.id)).not.toContain('conversation.stopped');

    // A text that is nothing once it is cleaned for the agent (only invisible characters) is no message.
    const before = r.agents.get(session.id)?.lastSeq;
    await expect(r.say(session.id, TEST_HOST_USER, '​‍ ⁠')).rejects.toMatchObject({ code: 'bad_request', text: { id: 'session.text.invalid' }, detail: { reason: 'invalid-text' } });
    expect(r.agents.get(session.id)?.lastSeq).toBe(before);
  });
});

describe('what a message can pull in', { timeout: 60_000 }, () => {
  it("DX-9 an `@path` in a message is text: every message is written as composed by smurg, so Claude Code expands no file mention (a first message, a later one, one of smurg's own, a suggestion's text)", async () => {
    const r = await rig();
    // A file of the host outside the project, and one inside it.
    const outside = join(r.s.hostHome, 'notes.txt');
    await writeFile(outside, 'OUTSIDE-MARKER\n');
    await writeFile(join(r.s.t.root, 'inside.txt'), 'INSIDE-MARKER\n');
    const text = `look at @${outside} and @inside.txt and @"${outside}"`;
    const { session } = await r.host.conn.request('session.create', { ...AGENT, firstMessage: text });
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= 7, 'the first turn');
    await r.say(session.id, TEST_HOST_USER, `@${outside}`);
    await r.agents.send(session.id, { kind: 'smurg', purpose: 'start-item', text: `Read @${outside} first.` });
    await r.agents.send(session.id, { kind: 'person', from: r.principal(TEST_HOST_USER), text: `@inside.txt please`, cleaned: false, origin: 'composer', suggestion: { id: 'sg_1', acceptedBy: { userId: TEST_HOST_USER, displayName: 'Host' }, modified: false } });
    await waitFor(async () => (await r.told()).length === 4, { timeoutMs: 15_000, what: 'four messages to reach the agent' });
    const echoed = await r.s.fakeClaude.echoed();
    const lines = echoed.filter((entry) => entry.kind === 'stdin' && (entry.value as { type?: string }).type === 'user').map((entry) => entry.value as { client_composed?: unknown });
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.client_composed)).toEqual([true, true, true, true]);
    // The stand-in expands a mention like the real CLI when a message is not marked: nothing was expanded.
    expect(await r.s.fakeClaude.mentions()).toEqual([]);
    // The text itself is untouched: people and the agent read the same characters.
    expect((await r.told())[0]).toBe(`[Host · Host]\n${text}`);
  });
});

describe('what an agent writes, as everyone reads it', { timeout: 60_000 }, () => {
  it('R4-07 agent text loses bidirectional, zero-width and control characters before it is stored or streamed; a credential cannot hide from the mask behind one', async () => {
    const cp = (...points: number[]): string => String.fromCodePoint(...points);
    const text = `Run \`rm -rf ${cp(0x202e)}tmp/ # dliub\` and use sk-ant-${cp(0x200b)}abcdefgh12345678${cp(0x1b)}[0m. Done ${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}.`;
    const r = await rig([{ steps: [{ text, deltas: [text.slice(0, 20), text.slice(20)], deltaMs: 60 }] }], { daemon: { agents: { deltaCoalesceMs: 20 } } });
    const deltas: PayloadOf<'session.delta'>[] = [];
    r.host.conn.on('session.delta', (payload) => deltas.push(payload));
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, idle, 'the start');
    await r.host.conn.request('session.watch', { sessionId: session.id });
    await r.say(session.id, TEST_HOST_USER, 'go');
    await waitFor(async () => (await r.events(session.id)).some((event) => event.kind === 'text'), { timeoutMs: 15_000, what: 'the text' });
    const stored = (await r.events(session.id)).find((event) => event.kind === 'text');
    expect(stored).toMatchObject({ text: `Run \`rm -rf tmp/ # dliub\` and use [masked][0m. Done ${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}.` });
    const streamed = deltas.map((delta) => delta.text).join('');
    expect(streamed.length).toBeGreaterThan(0);
    for (const unseen of [0x202e, 0x200b, 0x1b]) expect(streamed.includes(cp(unseen)), unseen.toString(16)).toBe(false);
    expect(streamed).not.toContain('abcdefgh12345678');
  });
});

describe('what a turn and a start can run into', { timeout: 60_000 }, () => {
  it('a turn that ends with an error: turn.finished{error} and the notice; the session stays usable', async () => {
    const r = await rig([{ match: 'break', steps: [{ text: 'Trying.' }, { result: { subtype: 'error_during_execution', is_error: true } }] }]);
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'break something' }, null as never, r.principal(TEST_HOST_USER));
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= 8, 'the turn to end');
    const events = await r.events(session.id);
    expect(events.find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'error' });
    expect(events.find((event) => event.kind === 'notice')).toMatchObject({ level: 'error', text: { id: 'notice.turnError' } });
    expect(r.bus.find((entry) => entry.name === 'agent.turn.finished')?.event).toMatchObject({ outcome: 'error', finalText: 'Trying.' });
    expect(r.agents.facts(session.id)?.hasProcess).toBe(true);
    const next = await r.say(session.id, TEST_HOST_USER, 'and now?');
    await waitFor(async () => (await r.deliveries(session.id, next.messageId)).includes('completed'), { timeoutMs: 15_000, what: 'the next turn' });
    expect((await r.events(session.id)).filter((event) => event.kind === 'turn.finished').map((event) => (event.kind === 'turn.finished' ? event.outcome : ''))).toEqual(['error', 'completed']);
    expect(reasons(r)).toEqual(['started']);
  });

  it('two reasons to start again while a turn runs are ONE restart and one line (a member removed with a session rule and a topic rule)', async () => {
    const r = await rig([{ match: 'wait', steps: [{ text: 'Working.' }, { wait: 'interrupt' }] }]);
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'wait for me' }, null as never, r.principal(TEST_HOST_USER));
    await r.until(session.id, (now) => now.status === 'running' && now.lastSeq >= 5, 'the turn to run');
    await r.agents.restartProcess(session.id, 'rules');
    await r.agents.restartProcess(session.id, 'rules');
    await r.agents.restartProcess(session.id, 'host');
    expect((await r.ids(session.id)).filter((id) => id === 'conversation.agent.restarting')).toHaveLength(1);
    // The turn ends: the process is given up once, and the next restart is announced again.
    await r.agents.interrupt(session.id, { kind: 'system' });
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { timeoutMs: 15_000, what: 'the restart at the end of the turn' });
    expect(reasons(r)).toEqual(['started', 'parked']);
    const next = await r.say(session.id, TEST_HOST_USER, 'and now?');
    await waitFor(async () => (await r.deliveries(session.id, next.messageId)).includes('completed'), { timeoutMs: 15_000, what: 'the next turn' });
    await r.agents.restartProcess(session.id, 'rules');
    expect((await r.ids(session.id)).filter((id) => id === 'conversation.agent.restarting')).toHaveLength(2);
  });

  it('the memory mark: a process above parkAboveRssBytes after a turn is parked at once, without a line; the next message resumes the conversation', async () => {
    const r = await rig([], { daemon: { agents: { parkAboveRssBytes: 1 } } });
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'one' }, null as never, r.principal(TEST_HOST_USER));
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false && r.agents.get(session.id)?.status === 'idle', { timeoutMs: 15_000, what: 'the process to be parked after its turn' });
    expect(reasons(r)).toEqual(['started', 'parked']);
    expect(await r.ids(session.id)).not.toContain('conversation.agent.restarting');
    expect((await r.events(session.id)).some((event) => event.kind === 'notice')).toBe(false);
    const next = await r.say(session.id, TEST_HOST_USER, 'two');
    await waitFor(async () => (await r.deliveries(session.id, next.messageId)).includes('completed'), { timeoutMs: 15_000, what: 'the resumed turn' });
    const argvs = (await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv').map((entry) => entry.value as string[]);
    expect(argvs[1]).toContain('--resume');
    expect((await r.events(session.id)).filter((event) => event.kind === 'turn.started').map((event) => (event.kind === 'turn.started' ? event.turnId : ''))).toEqual(['t_1', 't_2']);
  });

  it('a tool Claude Code offers although the session\'s list does not name it is logged once per session (the gate refuses it); smurg\'s own tools and the listed ones are not', async () => {
    const log = createMemoryLogger();
    const r = await rig([], { scenario: { extraTools: ['Skill', 'ListAgents'] }, daemon: { log } });
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'one' }, null as never, r.principal(TEST_HOST_USER));
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= 8, 'the first turn');
    const next = await r.say(session.id, TEST_HOST_USER, 'two');
    await waitFor(async () => (await r.deliveries(session.id, next.messageId)).includes('completed'), { timeoutMs: 15_000, what: 'the second turn' });
    const said = log.lines.filter((line) => line.message.includes('a tool that is not in its tool list'));
    expect(said.map((line) => [line.level, line.fields['tool'], line.fields['session']])).toEqual([
      ['info', 'Skill', session.id],
      ['info', 'ListAgents', session.id],
    ]);
  });

  it('R5-02 a personal subscription login, as Claude Code reports it ("Claude Max"): the host alone is told, once per workspace (also after a restart), and only when someone else is a member', async () => {
    const stateDir = await createTempRunDir();
    runDirs.push(stateDir);
    const r = await rig([], { scenario: { account: CLAUDE_ACCOUNTS.subscriptionMax }, daemon: { stateDir } });
    const told = (fakes: Rig['s']['fakes']): string[] => fakes.activity.notifications.filter((entry) => entry.msg?.id === 'notice.personalSubscription').map((entry) => entry.userId);
    const alone = (await r.host.conn.request('session.create', AGENT)).session;
    await r.until(alone.id, idle, 'the first start');
    // The host by themselves: a subscription for one's own use is what it is for.
    expect(told(r.s.fakes)).toEqual([]);
    expect(r.agents.get(alone.id)?.login).toBe('logged-in');
    await r.s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    for (let i = 0; i < 2; i++) {
      const { session } = await r.host.conn.request('session.create', AGENT);
      await r.until(session.id, idle, `start ${i + 2}`);
    }
    expect(told(r.s.fakes)).toEqual([TEST_HOST_USER]);
    // The host's smurg starts again over the same workspace: the host was told once, and is not told again.
    r.host.close();
    await r.s.t.daemon.stop();
    const fakes = createFakes();
    const selfCommand = { file: '/usr/bin/true', args: [] };
    const again = await createTestDaemon({
      root: r.s.t.root,
      stateDir,
      workspaceId: r.s.t.workspaceId,
      modules: [fakeServicesModule(fakes), createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', HOME: r.s.hostHome, ...r.s.fakeClaude.env }), hostShell: '/bin/sh', launch: { claudePath: r.s.fakeClaude.path, selfCommand } })],
      sessions: { selfCommand, hostHome: r.s.hostHome },
    });
    try {
      const host = await again.connectHost();
      expect(again.ctx.members.list().map((member) => member.userId)).toContain('dev:mei');
      const { session } = await host.conn.request('session.create', AGENT);
      await waitFor(() => again.ctx.services.agents.get(session.id)?.status === 'idle', { timeoutMs: 15_000, what: 'a start after the restart' });
      expect(told(fakes)).toEqual([]);
    } finally {
      await again.cleanup();
    }
  });

  it('R5-02 the names Claude Code has for a login: Pro and Max are personal subscriptions; Team, Enterprise and an API key are not; a host who is not connected gets the notice when they connect', async () => {
    const said = (subscriptionType: string | undefined): boolean => loginOfAccount({ ...(subscriptionType === undefined ? CLAUDE_ACCOUNTS.apiKey : { subscriptionType, apiProvider: 'firstParty' }) }).personalSubscription;
    expect(['Claude Max', 'Claude Pro', 'Claude Max 20x', 'max', 'pro'].map(said)).toEqual([true, true, true, true, true]);
    expect(['Claude Team', 'Claude Enterprise', 'Claude API', 'Claude Team Max', 'Claude Promo', undefined].map(said)).toEqual([false, false, false, false, false, false]);
    // A team login: nobody is told anything.
    const team = await rig([], { scenario: { account: { subscriptionType: 'Claude Team', apiProvider: 'firstParty' } } });
    await team.s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const first = (await team.host.conn.request('session.create', AGENT)).session;
    await team.until(first.id, idle, 'the start');
    expect(team.agents.get(first.id)?.login).toBe('logged-in');
    expect(team.s.fakes.activity.notifications.filter((entry) => entry.msg?.id === 'notice.personalSubscription')).toEqual([]);
    await team.s.cleanup();
    current = null;
    // A personal one while the host has no window open at all (a member started the session): it waits for the host.
    const s = await startSessionStack({ scenario: { account: CLAUDE_ACCOUNTS.subscriptionMax } });
    current = s;
    const agents = s.t.ctx.services.agents as AgentSessionsImpl;
    const mei = await s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    expect(s.t.ctx.hub.recipients({ userId: TEST_HOST_USER, purpose: 'interactive' })).toEqual([]);
    const { session } = await mei.conn.request('session.create', AGENT);
    await waitFor(() => agents.get(session.id)?.status === 'idle', { timeoutMs: 15_000, what: "Mei's start" });
    const notices = (): string[] => s.fakes.activity.notifications.filter((entry) => entry.msg?.id === 'notice.personalSubscription').map((entry) => entry.userId);
    expect(notices()).toEqual([]);
    await s.t.connectHost();
    await waitFor(() => notices().length === 1, { what: "the notice at the host's next connection" });
    expect(notices()).toEqual([TEST_HOST_USER]);
  });

  it('R5-07 the login state Claude Code reports at a start, in its own shapes: no credential is logged out at once (before any turn); an API key and a subscription are logged in', async () => {
    expect(loginOfAccount(CLAUDE_ACCOUNTS.loggedOut)).toEqual({ state: 'logged-out', personalSubscription: false });
    expect(loginOfAccount(CLAUDE_ACCOUNTS.apiKey)).toEqual({ state: 'logged-in', personalSubscription: false });
    expect(loginOfAccount(CLAUDE_ACCOUNTS.subscriptionMax)).toEqual({ state: 'logged-in', personalSubscription: true });
    // A cloud provider has neither a token nor a key; a shape without `tokenSource` says nothing by itself.
    expect(loginOfAccount({ tokenSource: 'none', apiProvider: 'bedrock' }).state).toBe('logged-in');
    expect(loginOfAccount({ apiProvider: 'firstParty' }).state).toBe('logged-in');
    expect(loginOfAccount({ tokenSource: 'none', apiKeySource: 'none', apiProvider: 'firstParty' }).state).toBe('logged-out');
    // `claude auth status` still said logged in (its answer is kept for a minute) when the process starts logged out.
    const r = await rig([], { scenario: { loggedIn: true, account: CLAUDE_ACCOUNTS.loggedOut } });
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, idle, 'the start');
    expect(r.agents.get(session.id)).toMatchObject({ login: 'logged-out', status: 'idle', lastSeq: 1 });
    expect(r.agents.account()).toEqual({ state: 'logged-out', sessions: 1 });
    expect(r.agents.attention()).toMatchObject([{ subject: 'account', recipients: [TEST_HOST_USER] }]);
  });

  it('R5-05 the host is told about a rule of their own ONCE, whichever folder reports it: the main folder and a worktree see different settings files, and neither the notice nor the inbox item returns when their sessions take turns', async () => {
    const r = await rig();
    const rules = r.s.t.ctx.services.hostRules as HostRulesImpl;
    const user = { rule: 'Bash(ls *)', source: 'user' as const };
    const local = { rule: 'Bash(pnpm lint *)', source: 'local' as const };
    const project = { rule: 'Bash(pnpm test *)', source: 'project' as const };
    const WORKTREE = { kind: 'worktree' as const, worktreeId: 'wt_1' };
    const found = (): number => r.s.fakes.activity.notifications.filter((entry) => entry.msg?.id === 'hostRules.found').length;
    // The discussion in the main folder: the user's rule and the one Claude Code saved in settings.local.json.
    rules.report([local, user], MAIN_ROOT);
    expect(found()).toBe(1);
    expect(rules.attention()).toMatchObject([{ subject: 'host-rules', count: 2 }]);
    await rules.markSeen(r.principal(TEST_HOST_USER));
    // Work items in their worktrees report the user's rule only; the discussion's process starts again after each.
    for (let round = 0; round < 3; round++) {
      rules.report([user], WORKTREE);
      rules.report([local, user], MAIN_ROOT);
    }
    expect(found()).toBe(1);
    expect(rules.attention()).toEqual([]);
    // The list is the workspace's: what applies in the main folder stays listed while a worktree session started last.
    rules.report([user], WORKTREE);
    expect(rules.view()).toEqual({ rules: [local, user], seen: true });
    expect(rules.applied()).toEqual(['Bash(pnpm lint *)', 'Bash(ls *)']);
    // A rule nobody was told about: told once, with the workspace's count.
    rules.report([local, project, user], MAIN_ROOT);
    expect(found()).toBe(2);
    expect(r.s.fakes.activity.notifications.filter((entry) => entry.msg?.id === 'hostRules.found').at(-1)?.msg).toMatchObject({ params: { count: 3 } });
    expect(rules.attention()).toMatchObject([{ count: 3 }]);
    await rules.markSeen(r.principal(TEST_HOST_USER));
    // The main folder starts without its project settings (nobody confirmed a change): its rules leave the list, and
    // are no news when they are back.
    rules.report([user], MAIN_ROOT);
    expect(rules.view()).toEqual({ rules: [user], seen: true });
    rules.report([local, project, user], MAIN_ROOT);
    expect(found()).toBe(2);
    expect(rules.attention()).toEqual([]);
    expect(rules.view().rules).toEqual([local, project, user]);
    // The host removed every rule: nothing is listed, nothing waits.
    rules.report([], MAIN_ROOT);
    rules.report([], WORKTREE);
    expect(rules.view()).toEqual({ rules: [], seen: true });
    expect(rules.attention()).toEqual([]);
  });

  it('a session whose worktree is gone cannot continue: a start there is refused, and a message to a session that lost its root ends it (worktree-removed)', async () => {
    const r = await rig();
    const host = r.principal(TEST_HOST_USER);
    await expect(r.agents.start({ purpose: 'free', openedBy: host, responsible: null, workspace: { mode: 'worktree', worktreeId: 'wt_never_was' }, mode: 'ask-commands', rolePrompt: () => '' })).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.worktreeGone' }, detail: { reason: 'worktree-removed' } });
    expect(r.agents.list()).toEqual([]);
    const handle = await r.s.fakes.worktrees.acquireForSession({ owner: host, sessionId: 'a-worktree' });
    const session = await r.agents.start({ purpose: 'free', openedBy: host, responsible: null, workspace: { mode: 'worktree', worktreeId: handle.worktree.id }, mode: 'ask-commands', rolePrompt: () => '' });
    await r.until(session.id, idle, 'the start');
    expect(session).toMatchObject({ root: { kind: 'worktree', worktreeId: handle.worktree.id }, branch: `smurg/x/${handle.worktree.id}`, permissionMode: 'ask-commands' });
    await r.agents.restartProcess(session.id, 'slot');
    await waitFor(() => r.agents.facts(session.id)?.hasProcess === false, { what: 'the process to be parked' });
    // The worktree is removed while the session has no process (a merge, a removal by its owner).
    await r.s.t.ctx.roots.unregisterWorktree(handle.worktree.id);
    await r.say(session.id, TEST_HOST_USER, 'are you there?');
    await r.until(session.id, (now) => now.status === 'ended', 'the session to end');
    expect(r.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'worktree-removed' });
    await waitFor(() => r.bus.some((entry) => entry.name === 'session.exited'), { what: 'session.exited' });
    expect(r.bus.find((entry) => entry.name === 'session.exited')?.event).toMatchObject({ reason: 'worktree-removed', session: { id: session.id, status: 'ended' } });
    // No failure notice and no "Try again": the session is over, not broken.
    expect((await r.events(session.id)).some((event) => event.kind === 'notice')).toBe(false);
    expect(r.agents.facts(session.id)?.hasProcess).toBe(false);
    await expect(r.say(session.id, TEST_HOST_USER, 'hello?')).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.ended.noMessages' } });
    // Its worktree is not the runtime's to remove: an ended session that had no root left releases nothing twice.
    expect(r.s.fakes.worktrees.released.filter((entry) => entry.sessionId === session.id).length).toBeLessThanOrEqual(1);
  });

  it('THE launch check at a start: profile flags that are not on the list refuse the launch (no process), and so do launch files that could not be written; the session says which', async () => {
    const r = await rig();
    const hooks = r.s.fakes.hooks;
    const write = hooks.writeSessionFiles.bind(hooks);
    let how: 'extra-flag' | 'no-files' | 'fine' = 'extra-flag';
    hooks.writeSessionFiles = async (sessionId, launch) => {
      if (how === 'no-files') throw new Error('ENOSPC: no space left on device');
      const files = await write(sessionId, launch);
      return how === 'extra-flag' ? { ...files, claudeArgs: [...files.claudeArgs, '--dangerously-skip-permissions'] } : files;
    };
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, (now) => now.status === 'failed', 'the refused launch');
    expect((await r.events(session.id)).at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: { id: 'session.hooks.settingsInvalid' }, action: 'retry' });
    expect((await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv')).toEqual([]);
    expect(reasons(r)).toEqual(['started', 'failed']);
    expect(r.agents.facts(session.id)?.hasProcess).toBe(false);
    how = 'no-files';
    await r.host.conn.request('session.retry', { sessionId: session.id });
    await waitFor(async () => (await r.ids(session.id)).includes('session.hooks.settingsNotWritten'), { what: 'the second refusal' });
    await r.until(session.id, (now) => now.status === 'failed', 'the second refused launch');
    expect((await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv')).toEqual([]);
    // Nothing of a refused start stays registered for the gate.
    expect(hooks.registered.has(session.id)).toBe(false);
    // With the writer's own files and flags the retry starts it.
    how = 'fine';
    await r.host.conn.request('session.retry', { sessionId: session.id });
    await r.until(session.id, idle, 'the retry');
    expect((await r.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv')).toHaveLength(1);
  });

  it('a Claude Code that never answers `initialize`: the process is ended at the deadline and the session is failed with its own sentence and "Try again"', async () => {
    const dir = await createTempDir('mute-claude');
    dirs.push(dir);
    const mute = join(dir, 'claude');
    // Answers the version and login probes like a real one, then reads its input and says nothing.
    await writeFile(mute, ['#!/bin/sh', 'case "$1" in', '  --version) echo "2.1.288 (Claude Code)"; exit 0 ;;', '  auth) echo \'{"loggedIn":true,"authMethod":"api_key"}\'; exit 0 ;;', 'esac', 'exec /bin/cat > /dev/null', ''].join('\n'));
    await chmod(mute, 0o755);
    const r = await rig([], { claudePath: mute, daemon: { agents: { initTimeoutMs: 400 } } });
    const { session } = await r.host.conn.request('session.create', AGENT);
    expect(session.status).toBe('starting');
    await waitFor(() => r.agents.liveChildren().length === 1, { what: 'the child' });
    const pid = r.agents.liveChildren()[0]?.pid as number;
    await r.until(session.id, (now) => now.status === 'failed', 'the failure at the deadline');
    expect((await r.events(session.id)).at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: { id: 'session.claude.initTimeout' }, action: 'retry' });
    expect(reasons(r)).toEqual(['started', 'failed']);
    expect(r.agents.liveChildren()).toEqual([]);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { what: 'the mute process to be gone' });
    expect(r.agents.get(session.id)?.retryHostOnly).toBeUndefined();
  });

  it('nothing an agent session needs is missing silently: without the hooks module, or without the command the gate runs, a start is refused with its own sentence and nothing is created', async () => {
    const bare = await rig([], { fakes: false });
    await expect(bare.host.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'internal', text: { id: 'session.hooks.unavailable' }, detail: { reason: 'no-hooks' } });
    expect(bare.agents.list()).toEqual([]);
    await bare.s.cleanup();
    current = null;
    const noCommand = await rig([], { daemonSessions: { selfCommand: null } });
    await expect(noCommand.host.conn.request('session.create', AGENT)).rejects.toMatchObject({ code: 'internal', text: { id: 'session.hooks.notConfigured' }, detail: { reason: 'no-self-command' } });
    expect(noCommand.agents.list()).toEqual([]);
    expect((await noCommand.s.fakeClaude.echoed()).filter((entry) => entry.kind === 'argv')).toEqual([]);
    // A runtime that was never started (its records are not loaded) starts nothing either.
    const ctx = noCommand.s.t.ctx;
    const unopened = new AgentSessionsImpl(ctx, { ...noCommand.s.sessions.agentDeps(), trust: ctx.services.projectTrust as ProjectTrustImpl, hostRules: ctx.services.hostRules as HostRulesImpl });
    await expect(unopened.start({ purpose: 'free', openedBy: noCommand.principal(TEST_HOST_USER), responsible: null, workspace: { mode: 'main' }, mode: 'ask-all', rolePrompt: () => '' })).rejects.toMatchObject({ code: 'conflict', text: { id: 'session.notStarted' }, detail: { reason: 'not-started' } });
  });

  it('a Claude Code that lost its login while the session runs: the notice in the conversation, the account state for everyone; "Check login again" finds it back', async () => {
    const r = await rig([], { scenario: { account: CLAUDE_ACCOUNTS.loggedOut } });
    const session = await r.s.sessions.create({ ...AGENT, firstMessage: 'hello' }, null as never, r.principal(TEST_HOST_USER));
    await r.until(session.id, (now) => now.status === 'idle' && now.lastSeq >= 7, 'the turn');
    const ids = await r.ids(session.id);
    expect(ids).toContain('notice.notLoggedIn');
    // Said once, in smurg's words: Claude Code's own "run /login" line is not shown (there is no /login here), and no second error notice.
    expect(ids).not.toContain('notice.turnError');
    expect((await r.events(session.id)).some((event) => event.kind === 'text')).toBe(false);
    expect((await r.events(session.id)).find((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'error' });
    expect(r.agents.get(session.id)).toMatchObject({ login: 'logged-out', status: 'idle' });
    expect(r.agents.account()).toEqual({ state: 'logged-out', sessions: 1 });
    expect(r.agents.attention()).toMatchObject([{ subject: 'account', recipients: [TEST_HOST_USER] }]);
    // The host logs in in their own terminal; `claude auth status` says so.
    await expect(r.host.conn.request('session.loginStatus', { sessionId: session.id })).resolves.toEqual({ login: 'logged-in' });
    expect(r.agents.account().state).toBe('ok');
  });

  it('a session keeps at most 50 remembered rules', async () => {
    const r = await rig();
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, idle, 'the start');
    const rule = (i: number) => ({ id: `rule_${i}`, tool: 'Bash' as const, pattern: `pnpm test${i} *`, scope: 'session' as const, addedBy: { userId: TEST_HOST_USER, displayName: 'Host' }, addedAt: 1 });
    const many = Array.from({ length: 51 }, (_, i) => rule(i));
    await expect(r.agents.setRules(session.id, many, { kind: 'system' })).rejects.toMatchObject({ code: 'conflict', text: { id: 'rule.limit', params: { max: 50 } }, detail: { reason: 'rule-limit' } });
    expect(r.agents.rules(session.id)).toEqual([]);
    await r.agents.setRules(session.id, many.slice(0, 50), { kind: 'system' });
    expect(r.agents.rules(session.id)).toHaveLength(50);
    expect(r.agents.get(session.id)?.ruleCount).toBe(50);
    // Adding rules restarts nothing (the running process has them); the process is still the first one.
    expect(reasons(r)).toEqual(['started']);
  });
});

describe('watchers and what is kept', { timeout: 60_000 }, () => {
  it('toWatchers: a card update reaches the channels that watch the session, the host\'s with the host\'s copy; a delta only the live ones; nobody else', async () => {
    const r = await rig();
    const mei = await r.s.t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const amy = await r.s.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const { session } = await r.host.conn.request('session.create', AGENT);
    await r.until(session.id, idle, 'the start');
    await r.host.conn.request('session.watch', { sessionId: session.id });
    await mei.conn.request('session.watch', { sessionId: session.id, live: false });
    expect(r.agents.watchers(session.id).sort()).toEqual([TEST_HOST_USER, 'dev:mei'].sort());
    expect(r.agents.watchers('ses_unknown')).toEqual([]);
    const got = { host: [] as PayloadOf<'permission.updated'>[], mei: [] as PayloadOf<'permission.updated'>[], amy: [] as PayloadOf<'permission.updated'>[] };
    const deltas = { host: [] as PayloadOf<'session.delta'>[], mei: [] as PayloadOf<'session.delta'>[] };
    r.host.conn.on('permission.updated', (payload) => got.host.push(payload));
    mei.conn.on('permission.updated', (payload) => got.mei.push(payload));
    amy.conn.on('permission.updated', (payload) => got.amy.push(payload));
    r.host.conn.on('session.delta', (payload) => deltas.host.push(payload));
    mei.conn.on('session.delta', (payload) => deltas.mei.push(payload));
    // What members see of a request outside the workspace, and the host's copy with the path.
    const forMembers = buildPermission({ id: 'pr_x', sessionId: session.id, hostOnly: true, alwaysRule: undefined });
    const forHost = buildPermission({ id: 'pr_x', sessionId: session.id, hostOnly: true, alwaysRule: undefined, command: 'cat /Users/host/notes.txt' });
    r.agents.toWatchers(session.id, 'permission.updated', { request: forMembers }, { request: forHost });
    r.agents.toWatchers(session.id, 'session.delta', { sessionId: session.id, turnId: 't_1', blockId: 'b_1_1', offset: 0, text: 'streaming' });
    r.agents.toWatchers('ses_unknown', 'permission.updated', { request: forMembers });
    await waitFor(() => got.host.length === 1 && got.mei.length === 1 && deltas.host.length === 1, { what: 'the fan-out' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(got.mei[0]?.request.command).toBe(forMembers.command);
    expect(got.host[0]?.request.command).toBe('cat /Users/host/notes.txt');
    expect(got.amy).toEqual([]);
    expect(deltas.mei).toEqual([]);
    // A channel that stops watching gets nothing more.
    mei.conn.notify('session.unwatch', { sessionId: session.id });
    await waitFor(() => r.agents.watchers(session.id).length === 1, { what: 'the unwatch' });
    r.agents.toWatchers(session.id, 'permission.updated', { request: forMembers });
    await waitFor(() => got.host.length === 2, { what: 'the second update' });
    expect(got.mei).toHaveLength(1);
  });

  it('retention: an ended free session and its log go after freeSessionRetentionMs; a log beyond its size loses its oldest segments and says so once; a full workspace is the host\'s attention item', async () => {
    const r = await rig([], { daemon: { agents: { freeSessionRetentionMs: 2 * 60 * 60_000, transcriptSegmentBytes: 2_000, transcriptMaxSessionBytes: 6_000, transcriptMaxBytes: 3_000, escalationSweepMs: 20, parkAfterMs: 24 * 60 * 60_000 } } });
    const kept = (await r.host.conn.request('session.create', AGENT)).session;
    const gone = (await r.host.conn.request('session.create', AGENT)).session;
    for (const id of [kept.id, gone.id]) await r.until(id, idle, 'the start');
    const goneDir = await r.agents.storageDir(gone.id);
    await r.host.conn.request('session.end', { sessionId: gone.id });
    expect(r.agents.get(gone.id)?.status).toBe('ended');
    // A long conversation: many small events over many segments.
    for (let i = 0; i < 120; i++) r.agents.append(kept.id, { kind: 'line', text: msg('conversation.agent.restarting'), fallback: `line ${i} ${'x'.repeat(100)}` });
    const lastSeq = r.agents.get(kept.id)?.lastSeq as number;
    expect((await r.agents.history({ sessionId: kept.id, afterSeq: 0, limit: 1 })).events[0]?.seq).toBe(1);
    expect(r.agents.attention().filter((fact) => fact.subject === 'storage')).toEqual([]);
    // The hourly pass: the log is cut to its size; the workspace is still over its budget, so the ended free session goes
    // although it is not old yet; what remains cannot be removed silently: the host is told.
    r.s.t.advanceClock(61 * 60_000);
    await waitFor(() => r.agents.get(gone.id) === null && r.agents.attention().some((fact) => fact.subject === 'storage'), { timeoutMs: 10_000, what: 'the retention pass' });
    expect(existsSync(goneDir)).toBe(false);
    const page = await r.agents.history({ sessionId: kept.id, afterSeq: 0, limit: 500 });
    expect(page.events[0]?.seq).toBeGreaterThan(1);
    expect(page.hasEarlier).toBe(false);
    expect(page.events.at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: { id: 'notice.transcriptTrimmed' }, seq: lastSeq + 1 });
    expect(r.agents.attention().filter((fact) => fact.subject === 'storage')).toMatchObject([{ recipients: [TEST_HOST_USER], target: { kind: 'console', section: 'sessions' } }]);
    expect(r.bus.filter((entry) => entry.name === 'attention.changed').map((entry) => (entry.event as DaemonEvents['attention.changed']).source)).toContain('sessions');
    expect(r.agents.get(kept.id)).toMatchObject({ status: 'idle', root: MAIN_ROOT });
    // The next pass trims nothing new and says nothing again.
    r.s.t.advanceClock(61 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await r.ids(kept.id)).filter((id) => id === 'notice.transcriptTrimmed')).toHaveLength(1);
  });

  it('an ended free session is forgotten when it is old enough, a live one and a topic\'s never by age', async () => {
    const r = await rig([], { daemon: { agents: { freeSessionRetentionMs: 30 * 60_000, escalationSweepMs: 20, parkAfterMs: 24 * 60 * 60_000 } } });
    const live = (await r.host.conn.request('session.create', AGENT)).session;
    const ended = (await r.host.conn.request('session.create', AGENT)).session;
    const discussion = await r.agents.start({ purpose: 'discussion', topic: { id: 'tp_checkout', slug: 'checkout', name: 'Checkout' }, openedBy: r.principal(TEST_HOST_USER), responsible: null, workspace: { mode: 'main' }, mode: 'ask-all', rolePrompt: () => 'ROLE' });
    for (const id of [live.id, ended.id, discussion.id]) await r.until(id, idle, 'the start');
    await r.host.conn.request('session.end', { sessionId: ended.id });
    await r.agents.end(discussion.id, { by: { kind: 'system' }, reason: 'archived', keepWorktree: true });
    r.s.t.advanceClock(61 * 60_000);
    await waitFor(() => r.agents.get(ended.id) === null, { timeoutMs: 10_000, what: 'the old ended session to be forgotten' });
    expect(r.agents.get(live.id)?.status).toBe('idle');
    // A topic's conversation lives as long as the topic: it goes with `forget` (topic.delete), never by age.
    expect(r.agents.get(discussion.id)).toMatchObject({ status: 'ended', endReason: 'archived' });
    await r.agents.forget([discussion.id]);
    expect(r.agents.get(discussion.id)).toBeNull();
  });
});
