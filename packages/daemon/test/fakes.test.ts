// The in-memory fakes of core/fakes (ARCHITECTURE §7.2): what every v0.5.0 package builds and tests against while
// the others are being written. This suite is their contract: each fake fits its service slot, keeps the state the
// real service keeps, emits the bus events of ARCHITECTURE §7.3, and produces only entities that pass the wire schemas.
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENTS_CATCH_UP_MAX,
  EVENTS_PAGE_MAX,
  MAIN_ROOT,
  SmurgError,
  agentSessionSchema,
  conversationEventSchema,
  getMessageSpec,
  inboxItemSchema,
  mergeRequestSchema,
  permissionRequestSchema,
  planInfoSchema,
  questionSchema,
  reportInfoSchema,
  reportSummarySchema,
  sessionWatchResultSchema,
  settledOfError,
  startPreflightSchema,
  suggestionSchema,
  terminalSessionSchema,
  topicSchema,
  unmergedWorktreesOfError,
  workItemSchema,
  worktreeInfoSchema,
  type ConversationEvent,
  type SessionInfo,
} from '@smurg/protocol';
import { FEATURE_SERVICE_NAMES, type AgentRequest, type DaemonEvents } from '../src/core/interfaces.ts';
import { isStubService } from '../src/core/stubs.ts';
import {
  FAKE_SERVICE_NAMES,
  buildAgentSession,
  buildEvent,
  buildHookRegistration,
  buildInboxItem,
  buildLaunchProfile,
  buildMergeRequest,
  buildPermission,
  buildPlan,
  buildQuestion,
  buildReport,
  buildReportSummary,
  buildSuggestion,
  buildTerminalSession,
  buildTopic,
  buildWorkItem,
  buildWorktree,
  createFakeEnv,
  createFakes,
  fakePrincipal,
  fakesModule,
  fakesOf,
  recordActivity,
  type FakeEnv,
  type Fakes,
} from '../src/core/fakes/index.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';
import { createProbe } from './fixtures/probe-module.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const host = fakePrincipal('dev:host', 'host', 'Host');
const mei = fakePrincipal('dev:mei', 'agent', 'Mei');
const eddie = fakePrincipal('dev:eddie', 'editor', 'Eddie');
const REGISTRATION = { sessionId: 'ses_1', ownerUserId: 'dev:mei', agentName: "Mei's agent", root: MAIN_ROOT } as const;

type BusName = keyof DaemonEvents & string;

/** Fakes over a bare environment, with every bus event recorded by name. */
function bare(): { env: FakeEnv; fakes: Fakes; events: BusName[]; payloads: { [K in BusName]?: DaemonEvents[K][] } } {
  const env = createFakeEnv();
  const events: BusName[] = [];
  const payloads: { [K in BusName]?: DaemonEvents[K][] } = {};
  const names: BusName[] = [
    'session.created',
    'session.updated',
    'session.exited',
    'agent.ready',
    'agent.process',
    'agent.tool.gate',
    'agent.turn.started',
    'agent.turn.finished',
    'agent.request',
    'agent.request.withdrawn',
    'account.changed',
    'activity.recorded',
    'question.changed',
    'permission.changed',
    'suggestion.changed',
    'topic.changed',
    'topic.removed',
    'plan.changed',
    'report.changed',
    'attention.changed',
    'trust.changed',
    'merge.changed',
    'worktree.changed',
  ];
  for (const name of names) {
    env.bus.on(name, (payload) => {
      events.push(name);
      ((payloads[name] ??= []) as unknown[]).push(payload);
    });
  }
  return { env, fakes: createFakes(env), events, payloads };
}

function valid(schema: { safeParse(value: unknown): { success: boolean; error?: unknown } }, value: unknown): void {
  const parsed = schema.safeParse(value);
  expect(parsed.success ? null : parsed.error).toBeNull();
}

function freeStart(openedBy = mei): Parameters<Fakes['agents']['start']>[0] {
  return { purpose: 'free', openedBy, responsible: null, workspace: { mode: 'main' }, mode: 'ask-all', rolePrompt: ({ smurgTag }) => `You work in a shared folder. [smurg ${smurgTag}]` };
}

/** A permission request as the runner raises it: the ToolView of the call beside Claude Code's raw input. */
function permission(id: string, tool: 'Bash' | 'WebFetch', target: string): Extract<AgentRequest, { kind: 'permission' }> {
  return { id, kind: 'permission', toolUseId: `tu_${id}`, tool, view: { name: tool, verb: tool === 'Bash' ? 'run' : 'fetch', target }, input: tool === 'Bash' ? { command: target } : { url: target } };
}

const lines = (fakes: Fakes, sessionId: string): string[] => fakes.agents.eventsOf(sessionId).flatMap((event) => (event.kind === 'line' || event.kind === 'notice' ? [event.text.id] : []));

describe('the builders', () => {
  it('every builder makes an entity that passes its wire schema, with and without overrides', () => {
    valid(agentSessionSchema, buildAgentSession());
    valid(agentSessionSchema, buildAgentSession({ id: 'ses_d', purpose: 'discussion', topicId: 'tp_1', modeFixed: true }));
    valid(agentSessionSchema, buildAgentSession({ id: 'ses_i', purpose: 'item', topicId: 'tp_1', itemId: 't2', attempt: 2, root: { kind: 'worktree', worktreeId: 'wt_1' }, branch: 'smurg/login/t2' }));
    valid(terminalSessionSchema, buildTerminalSession());
    valid(questionSchema, buildQuestion());
    valid(permissionRequestSchema, buildPermission());
    valid(suggestionSchema, buildSuggestion());
    valid(topicSchema, buildTopic());
    valid(topicSchema, buildTopic({ phase: 'plan', archived: true }));
    valid(workItemSchema, buildWorkItem());
    valid(planInfoSchema, buildPlan());
    valid(reportSummarySchema, buildReportSummary());
    valid(reportInfoSchema, buildReport());
    valid(mergeRequestSchema, buildMergeRequest());
    valid(worktreeInfoSchema, buildWorktree());
    expect(buildHookRegistration(REGISTRATION)).toMatchObject({ sessionId: 'ses_1', purpose: 'free', pathRights: 'member' });
    expect(buildLaunchProfile({ rolePrompt: 'You are an agent.' })).toMatchObject({ mode: 'default', strictMcp: true, rolePrompt: 'You are an agent.' });
  });
});

describe('FakeAgentSessions', () => {
  it('start: a valid session, the role prompt with the session\'s tag, `session.created`, the first message sent', async () => {
    const { fakes, events } = bare();
    const session = await fakes.agents.start({ ...freeStart(), title: 'Look at the tests', firstMessage: { kind: 'person', from: mei, text: 'hello', cleaned: false, origin: 'composer' } });
    valid(agentSessionSchema, session);
    expect(session).toMatchObject({ kind: 'agent', purpose: 'free', status: 'idle', permissionMode: 'ask-all', openedBy: { userId: 'dev:mei' }, responsible: null, title: 'Look at the tests' });
    expect(fakes.agents.rolePromptOf(session.id)).toEqual({ rolePrompt: 'You work in a shared folder. [smurg k7f2]', smurgTag: 'k7f2' });
    expect(fakes.agents.facts(session.id)).toMatchObject({ purpose: 'free', ownerUserId: 'dev:mei', fallbackDecider: 'dev:mei', pathRights: 'member', hasProcess: true });
    expect(fakes.agents.sentTo(session.id)).toHaveLength(1);
    expect(fakes.agents.eventsOf(session.id).map((event) => event.kind)).toEqual(['message']);
    expect(events[0]).toBe('session.created');
    expect(fakes.agents.get(session.id)?.lastSeq).toBe(1);
    expect(fakes.agents.list().map((item) => item.id)).toEqual([session.id]);
  });

  it('a turn: events with increasing seq that pass the event schema, the bus events of a turn, status running → idle', async () => {
    const { fakes, events, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    await fakes.agents.send(session.id, { kind: 'person', from: mei, text: 'run the tests', cleaned: false, origin: 'composer' });
    const turnId = fakes.agents.startTurn(session.id);
    expect(fakes.agents.get(session.id)?.status).toBe('running');
    fakes.agents.say(session.id, 'Running them now.');
    fakes.agents.edit(session.id, { root: MAIN_ROOT, path: 'src/app.ts' });
    fakes.agents.finishTurn(session.id, { finalText: 'All green.' });
    const log = fakes.agents.eventsOf(session.id);
    for (const event of log) valid(conversationEventSchema, event);
    expect(log.map((event) => event.seq)).toEqual(log.map((_event, index) => index + 1));
    expect(log.map((event) => event.kind)).toEqual(['message', 'turn.started', 'text', 'tool.started', 'tool.finished', 'text', 'turn.finished']);
    expect(fakes.agents.get(session.id)).toMatchObject({ status: 'idle', lastSeq: 7 });
    expect(events.filter((name) => name.startsWith('agent.'))).toEqual(['agent.process', 'agent.turn.started', 'agent.turn.finished']);
    const finished = payloads['agent.turn.finished']?.[0];
    expect(finished).toMatchObject({ sessionId: session.id, turnId, outcome: 'completed', finalText: 'All green.' });
    // Who wrote what the turn took: the scheduler names who asked for a spec change from this.
    expect(finished?.messages).toEqual([{ messageId: expect.any(String), kind: 'person', origin: 'composer', from: { userId: 'dev:mei', displayName: 'Mei' } }]);
    expect(finished?.stoppedBy).toBeUndefined();
    // `runningSince` is there exactly while a turn runs.
    expect(fakes.agents.get(session.id)?.runningSince).toBeUndefined();
    fakes.agents.startTurn(session.id);
    expect(fakes.agents.get(session.id)?.runningSince).toBeTypeOf('number');
    expect(finished?.edited).toMatchObject([{ file: { root: MAIN_ROOT, path: 'src/app.ts' } }]);
  });

  it('a request: `agent.request`, waiting status, the answer is kept for the test; a withdrawal says why', async () => {
    const { fakes, events, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    fakes.agents.raise(session.id, { id: 'req_q', kind: 'question', toolUseId: 'tu_1', parts: buildQuestion().parts });
    expect(fakes.agents.get(session.id)).toMatchObject({ status: 'waiting-answer' });
    expect(fakes.agents.get(session.id)?.waitingSince).toBeTypeOf('number');
    fakes.agents.raise(session.id, { ...permission('req_p', 'Bash', 'pnpm test'), suggestedRule: { tool: 'Bash', pattern: 'pnpm test *' } });
    expect(fakes.agents.get(session.id)?.status).toBe('waiting-permission');
    fakes.agents.decidePermission(session.id, 'req_p', { allow: true });
    expect(fakes.agents.answerTo(session.id, 'req_p')).toEqual({ allow: true });
    expect(fakes.agents.get(session.id)?.status).toBe('waiting-answer');
    fakes.agents.answerQuestion(session.id, 'req_q', { answers: { 'Which database?': 'Postgres' }, notes: {} });
    expect(fakes.agents.answerTo(session.id, 'req_q')).toEqual({ answers: { 'Which database?': 'Postgres' }, notes: {} });
    expect(fakes.agents.get(session.id)?.status).toBe('running');
    expect(() => fakes.agents.answerQuestion(session.id, 'req_q', { answers: {}, notes: {} })).toThrow();

    fakes.agents.raise(session.id, permission('req_w', 'WebFetch', 'https://example.com'));
    fakes.agents.withdraw(session.id, 'req_w', 'stopped');
    expect(payloads['agent.request.withdrawn']).toEqual([{ sessionId: session.id, requestId: 'req_w', reason: 'stopped' }]);
    expect(events.filter((name) => name === 'agent.request')).toHaveLength(3);
  });

  it('interrupt withdraws what is open and ends the turn; fail makes the session `failed`; retry starts it again', async () => {
    const { fakes, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    fakes.agents.raise(session.id, permission('req_p', 'Bash', 'rm -rf build'));
    await fakes.agents.interrupt(session.id, mei.actor);
    // Who stopped it travels with the withdrawal and with the end of the turn (`Question.withdrawn.by`, `stoppedBy`).
    expect(payloads['agent.request.withdrawn']?.[0]).toEqual({ sessionId: session.id, requestId: 'req_p', reason: 'stopped', by: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(payloads['agent.turn.finished']?.[0]).toMatchObject({ outcome: 'interrupted', stoppedBy: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(fakes.agents.eventsOf(session.id).findLast((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'interrupted', stoppedBy: { userId: 'dev:mei' } });
    expect(fakes.agents.get(session.id)?.status).toBe('idle');

    fakes.agents.fail(session.id, 137);
    expect(fakes.agents.get(session.id)?.status).toBe('failed');
    expect(fakes.agents.facts(session.id)?.hasProcess).toBe(false);
    expect(fakes.agents.eventsOf(session.id).at(-1)).toMatchObject({ kind: 'notice', level: 'error', action: 'retry' });
    await expect(fakes.agents.retry(session.id, mei)).resolves.toMatchObject({ status: 'idle' });
    await expect(fakes.agents.retry(session.id, mei)).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'not-failed' } });
    // Three failed starts in a row: only the host tries again.
    fakes.agents.fail(session.id);
    fakes.agents.startFailures.set(session.id, 3);
    await expect(fakes.agents.retry(session.id, mei)).rejects.toMatchObject({ code: 'forbidden', detail: { reason: 'host-only' } });
    await expect(fakes.agents.retry(session.id, host)).resolves.toMatchObject({ status: 'idle' });
  });

  it('a parked session queues what is sent; a kicked member\'s queued messages can be cancelled', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    fakes.agents.park(session.id);
    const sent = await fakes.agents.send(session.id, { kind: 'person', from: eddie, text: 'later', cleaned: false, origin: 'composer' });
    expect(fakes.agents.eventsOf(session.id).at(-1)).toMatchObject({ kind: 'delivery', messageId: sent.messageId, state: 'queued' });
    expect(fakes.agents.cancelQueued('dev:eddie')).toEqual([{ sessionId: session.id, messageIds: [sent.messageId] }]);
    expect(fakes.agents.eventsOf(session.id).at(-1)).toMatchObject({ kind: 'delivery', messageId: sent.messageId, state: 'cancelled' });
    expect(fakes.agents.cancelQueued('dev:eddie')).toEqual([]);
    // A message that stays queued is delivered when the session has a process again.
    const kept = await fakes.agents.send(session.id, { kind: 'person', from: mei, text: 'go on', cleaned: false, origin: 'composer' });
    fakes.agents.resume(session.id);
    expect(fakes.agents.facts(session.id)?.hasProcess).toBe(true);
    expect(fakes.agents.eventsOf(session.id).at(-1)).toMatchObject({ kind: 'delivery', messageId: kept.messageId, state: 'started' });
  });

  it('`agent.process` says every change of `hasProcess`, and nothing else: how the scheduler learns that a slot is free', async () => {
    const { fakes, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    const changes = (): unknown[] => (payloads['agent.process'] ?? []).map((event) => [event.hasProcess, event.reason]);
    expect(payloads['agent.process']).toEqual([{ sessionId: session.id, purpose: 'free', hasProcess: true, reason: 'started' }]);
    fakes.agents.park(session.id);
    fakes.agents.park(session.id); // already parked: no event
    expect(fakes.agents.get(session.id)?.status).toBe('idle'); // parking is invisible on the wire
    fakes.agents.startTurn(session.id); // a turn needs a process
    fakes.agents.finishTurn(session.id);
    fakes.agents.fail(session.id);
    await fakes.agents.retry(session.id, mei);
    await fakes.agents.restartProcess(session.id, 'slot');
    await fakes.agents.end(session.id, { by: { kind: 'system' }, reason: 'archived', keepWorktree: true }); // parked: no process to lose
    expect(changes()).toEqual([[true, 'started'], [false, 'parked'], [true, 'started'], [false, 'failed'], [true, 'started'], [false, 'parked']]);
    const item = await fakes.agents.start({ ...freeStart(), purpose: 'item', topic: { id: 'tp_1', slug: 'login', name: 'Login' }, item: { id: 't2', number: 2, title: 'Token store', attempt: 1 }, workspace: { mode: 'worktree', worktreeId: 'wt_1' }, mode: 'ask-commands' });
    await fakes.agents.end(item.id, { by: mei.actor, reason: 'ended', keepWorktree: true });
    expect((payloads['agent.process'] ?? []).slice(-2)).toEqual([
      { sessionId: item.id, purpose: 'item', topicId: 'tp_1', hasProcess: true, reason: 'started' },
      { sessionId: item.id, purpose: 'item', topicId: 'tp_1', hasProcess: false, reason: 'ended' },
    ]);
  });

  it('start refuses what the wire would refuse: a topic session names its topic, an item session its item, a free one neither', async () => {
    const { fakes } = bare();
    await expect(fakes.agents.start({ ...freeStart(), purpose: 'item' })).rejects.toThrow(/topic/);
    await expect(fakes.agents.start({ ...freeStart(), purpose: 'item', topic: { id: 'tp_1', slug: 'login', name: 'Login' } })).rejects.toThrow(/item/);
    await expect(fakes.agents.start({ ...freeStart(), purpose: 'discussion' })).rejects.toThrow(/topic/);
    await expect(fakes.agents.start({ ...freeStart(), topic: { id: 'tp_1', slug: 'login', name: 'Login' } })).rejects.toThrow(/free/);
    const item = await fakes.agents.start({ ...freeStart(), purpose: 'item', topic: { id: 'tp_1', slug: 'login', name: 'Login' }, item: { id: 't2', number: 2, title: 'Token store', attempt: 3 }, workspace: { mode: 'worktree', worktreeId: 'wt_1' }, mode: 'ask-commands', opening: { id: 'conversation.started.item', params: { number: 2, branch: 'smurg/login/t2' } } });
    valid(agentSessionSchema, item);
    // What a client names the session with, and no title: a title is only what a person gave.
    expect(item).toMatchObject({ topicId: 'tp_1', topicName: 'Login', itemId: 't2', item: { number: 2, title: 'Token store' }, attempt: 3, branch: 'smurg/login/t2' });
    expect(item.title).toBeUndefined();
    expect(fakes.agents.agentActor(item.id).displayName).toBe('Claude (Token store)');
    expect(fakes.agents.eventsOf(item.id)).toMatchObject([{ seq: 1, kind: 'line', text: { id: 'conversation.started.item' } }]);
    // The labels follow a renamed topic and a re-parsed plan.
    fakes.agents.setLabels(item.id, { topicName: 'Sign in', item: { number: 1, title: 'Tokens' } });
    expect(fakes.agents.get(item.id)).toMatchObject({ topicName: 'Sign in', item: { number: 1, title: 'Tokens' } });
    expect(fakes.agents.agentActor(item.id).displayName).toBe('Claude (Tokens)');
    // A free session: the start of its first message, unless a title was typed.
    const free = await fakes.agents.start({ ...freeStart(), firstMessage: { kind: 'person', from: mei, text: 'Look at the cache and tell me why it is slow, please', cleaned: false, origin: 'composer' } });
    expect(free.title).toBe('Look at the cache and tell me why it is…');
    expect(() => fakes.agents.setLabels(free.id, { topicName: 'x' })).toThrow();
  });

  it('who writes which line: a stop, a mode, a removed rule, who is responsible, an end and a restart each leave theirs, once', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    const rule = { id: 'r_1', tool: 'Bash' as const, pattern: 'pnpm test *', scope: 'session' as const, addedBy: { userId: 'dev:mei', displayName: 'Mei' }, addedAt: 1 };
    await fakes.agents.setMode(session.id, 'ask-commands', mei.actor);
    expect(fakes.agents.facts(session.id)?.modeChangedBy).toBe('dev:mei');
    await fakes.agents.setRules(session.id, [rule], mei.actor); // an ADDED rule: the caller's line (`conversation.rule.added`), none here
    fakes.agents.setResponsible(session.id, { userId: 'dev:eddie', displayName: 'Eddie' }, mei.actor);
    fakes.agents.setResponsible(session.id, null, mei.actor);
    fakes.agents.setResponsible(session.id, { userId: 'dev:eddie', displayName: 'Eddie' }, { kind: 'system' }); // the teardown writes its own line
    expect(lines(fakes, session.id)).toEqual(['conversation.mode.changed', 'conversation.responsible.changed', 'conversation.responsible.cleared']);
    // What the system takes back when a member goes names that member.
    await fakes.agents.setRules(session.id, [], { kind: 'system' });
    await fakes.agents.setMode(session.id, 'ask-all', { kind: 'system' });
    expect(fakes.agents.facts(session.id)?.modeChangedBy).toBeUndefined();
    const log = fakes.agents.eventsOf(session.id);
    expect(log.find((event) => event.kind === 'line' && event.text.id === 'conversation.rule.removed.member')).toMatchObject({ text: { params: { name: 'Mei', rule: 'Bash(pnpm test *)' } } });
    expect(log.find((event) => event.kind === 'line' && event.text.id === 'conversation.mode.reset')).toMatchObject({ text: { params: { name: 'Mei' } }, fallback: 'The permission mode is back to its default: Mei, who changed it, was removed or lost agent access' });
    // A removed rule restarts the process at its next idle moment, and says so.
    expect(fakes.agents.log.of('restartProcess')).toEqual([[session.id, 'rules']]);
    expect(lines(fakes, session.id).slice(3)).toEqual(['conversation.rule.removed.member', 'conversation.agent.restarting', 'conversation.mode.reset']);
    // A person removes a rule, stops the agent, asks for a restart, ends the session.
    await fakes.agents.setRules(session.id, [rule], mei.actor);
    await fakes.agents.setRules(session.id, [], host.actor);
    fakes.agents.startTurn(session.id);
    await fakes.agents.interrupt(session.id, host.actor);
    await fakes.agents.restartProcess(session.id, 'asked');
    await fakes.agents.restartProcess(session.id, 'slot'); // the scheduler's parking is invisible
    await fakes.agents.end(session.id, { by: host.actor, reason: 'ended', keepWorktree: true });
    expect(lines(fakes, session.id).slice(6)).toEqual(['conversation.rule.removed', 'conversation.agent.restarting', 'conversation.stopped', 'conversation.agent.restarting', 'conversation.ended']);
    for (const event of fakes.agents.eventsOf(session.id)) valid(conversationEventSchema, event);
  });

  it('what the runner and the hooks announce: `agent.ready`, a refusal of the tool gate, the account state, a recorded activity', async () => {
    const { env, fakes, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    fakes.agents.ready(session.id, { login: 'logged-out', claudeVersion: '2.1.290', tools: ['Read', 'Bash'] });
    expect(payloads['agent.ready']).toEqual([{ sessionId: session.id, claudeVersion: '2.1.290', login: 'logged-out', tools: ['Read', 'Bash'] }]);
    expect(fakes.agents.get(session.id)).toMatchObject({ login: 'logged-out', claudeVersion: '2.1.290' });
    fakes.agents.gateDenied(session.id, { tool: 'Edit', row: 'G6', path: 'src/app.ts' });
    expect(payloads['agent.tool.gate']).toEqual([{ sessionId: session.id, tool: 'Edit', row: 'G6', path: 'src/app.ts' }]);
    fakes.agents.setAccount({ state: 'usage-limit', resetsAt: 1_727_003_600_000, sessions: 4 });
    expect(fakes.agents.account()).toEqual({ state: 'usage-limit', resetsAt: 1_727_003_600_000, sessions: 4 });
    expect(payloads['account.changed']).toEqual([{ account: { state: 'usage-limit', resetsAt: 1_727_003_600_000, sessions: 4 } }]);
    expect(payloads['attention.changed']).toEqual([{ source: 'sessions' }]);
    recordActivity(env, { actor: eddie.actor, kind: 'file.rename', file: { root: MAIN_ROOT, path: 'specs/login/OLD.md' }, renamedFrom: 'specs/login/SPEC.md' });
    expect(payloads['activity.recorded']).toEqual([{ entry: { actor: eddie.actor, kind: 'file.rename', file: { root: MAIN_ROOT, path: 'specs/login/OLD.md' }, renamedFrom: 'specs/login/SPEC.md', at: env.clock.now() } }]);
  });

  it('a question the wire would refuse is never raised: the runner refuses it towards the agent before a card exists', async () => {
    const { fakes, events } = bare();
    const session = await fakes.agents.start(freeStart());
    const part = buildQuestion().parts[0] as NonNullable<ReturnType<typeof buildQuestion>['parts'][0]>;
    const five = { ...part, options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, description: '' })) };
    expect(() => fakes.agents.raise(session.id, { id: 'rq_1', kind: 'question', toolUseId: 'tu_1', parts: [five] })).toThrow(/never raises/);
    // Two parts with the same text: Claude Code keys the answer by the text.
    expect(() => fakes.agents.raise(session.id, { id: 'rq_2', kind: 'question', toolUseId: 'tu_2', parts: [part, part] })).toThrow(/distinct/);
    expect(events).not.toContain('agent.request');
    expect(fakes.agents.get(session.id)?.status).toBe('idle');
    // A request of either kind can be refused by the conversation module with a sentence for the agent.
    fakes.agents.raise(session.id, { id: 'rq_3', kind: 'question', toolUseId: 'tu_3', parts: [part] });
    fakes.agents.decidePermission(session.id, 'rq_3', { allow: false, message: 'Ask one thing at a time.' });
    expect(fakes.agents.answerTo(session.id, 'rq_3')).toEqual({ allow: false, message: 'Ask one thing at a time.' });
  });

  it('end: status `ended`, `session.exited`, nothing more can be sent; mode, rules, title, responsible, owner are kept on the session', async () => {
    const { fakes, events, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    await fakes.agents.setMode(session.id, 'ask-commands', mei.actor);
    await fakes.agents.setRules(session.id, [{ id: 'r_1', tool: 'Bash', pattern: 'pnpm test *', scope: 'session', addedBy: { userId: 'dev:mei', displayName: 'Mei' }, addedAt: 1 }], mei.actor);
    fakes.agents.setTitle(session.id, 'Renamed', mei.actor);
    fakes.agents.setResponsible(session.id, { userId: 'dev:eddie', displayName: 'Eddie' }, mei.actor);
    fakes.agents.setOwner(session.id, 'dev:host', { kind: 'system' });
    const now = fakes.agents.get(session.id);
    valid(agentSessionSchema, now);
    expect(now).toMatchObject({ permissionMode: 'ask-commands', ruleCount: 1, title: 'Renamed', responsible: { userId: 'dev:eddie' } });
    expect(fakes.agents.rules(session.id)).toHaveLength(1);
    expect(fakes.agents.facts(session.id)?.ownerUserId).toBe('dev:host');
    expect(fakes.agents.facts(session.id)?.pathRights).toBe('member'); // a handover never raises it
    expect(events.filter((name) => name === 'session.updated').length).toBeGreaterThanOrEqual(4);

    // The ender is on the session and on the withdrawals of what was still open.
    fakes.agents.raise(session.id, { id: 'req_open', kind: 'question', toolUseId: 'tu_9', parts: buildQuestion().parts });
    await fakes.agents.end(session.id, { by: mei.actor, reason: 'ended', keepWorktree: true });
    expect(fakes.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'ended', endedBy: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(payloads['agent.request.withdrawn']?.at(-1)).toEqual({ sessionId: session.id, requestId: 'req_open', reason: 'ended', by: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(events.at(-1)).toBe('session.exited');
    await expect(fakes.agents.send(session.id, { kind: 'person', from: mei, text: 'too late', cleaned: false, origin: 'composer' })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'ended' } });
  });

  it('pages follow THE page rule: at most EVENTS_PAGE_MAX events, the newest page by default, `after` and `before` continue', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    for (let i = 0; i < EVENTS_PAGE_MAX + 100; i++) fakes.agents.say(session.id, `line ${i}`);
    const total = fakes.agents.eventsOf(session.id).length;
    // watch without `haveSeq`: the newest page.
    const newest = await fakes.agents.watch({ sessionId: session.id }, { channelId: 'ch_test', userId: 'dev:mei' } as never);
    expect(newest.events).toHaveLength(EVENTS_PAGE_MAX);
    expect(newest.events.at(-1)?.seq).toBe(total);
    expect(newest).toMatchObject({ hasEarlier: true, hasMore: false, nextSeq: total + 1, firstSeq: total - EVENTS_PAGE_MAX + 1 });
    const earlier = await fakes.agents.history({ sessionId: session.id, beforeSeq: newest.firstSeq, limit: EVENTS_PAGE_MAX });
    expect(earlier.events.at(-1)?.seq).toBe(newest.firstSeq - 1);
    expect(earlier.hasEarlier).toBe(false);
    const after = await fakes.agents.history({ sessionId: session.id, afterSeq: total - 3, limit: EVENTS_PAGE_MAX });
    expect(after.events.map((event: ConversationEvent) => event.seq)).toEqual([total - 2, total - 1, total]);
    const two = await fakes.agents.history({ sessionId: session.id, afterSeq: 0, limit: 2 });
    expect(two).toMatchObject({ firstSeq: 1, hasMore: true, hasEarlier: false });
    expect(two.events).toHaveLength(2);
  });

  it('a watch whose `haveSeq` is current answers an EMPTY page that continues the window: earlier events still exist', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    for (let i = 0; i < 5; i++) fakes.agents.say(session.id, `line ${i}`);
    const last = fakes.agents.eventsOf(session.id).length;
    const channel = { channelId: 'ch_test', userId: 'dev:mei' } as never;
    const current = await fakes.agents.watch({ sessionId: session.id, haveSeq: last }, channel);
    expect(current).toMatchObject({ events: [], firstSeq: 0, nextSeq: last + 1, hasEarlier: true, hasMore: false });
    const { cardRefs: _refs, bytes: _bytes, afterReply: _after, ...wire } = current;
    valid(sessionWatchResultSchema, { ...wire, questions: [], permissions: [], suggestions: [], moreCards: [] });
    // One behind: the page starts right after what the caller has (it continues the window).
    expect(await fakes.agents.watch({ sessionId: session.id, haveSeq: last - 1 }, channel)).toMatchObject({ firstSeq: last, hasEarlier: true, hasMore: false });
    // Nothing at all yet: nothing earlier.
    const empty = await fakes.agents.start(freeStart());
    expect(await fakes.agents.watch({ sessionId: empty.id, haveSeq: 0 }, channel)).toMatchObject({ events: [], firstSeq: 0, nextSeq: 1, hasEarlier: false, hasMore: false });
    // history: an empty page says on which side the events are.
    expect(await fakes.agents.history({ sessionId: session.id, afterSeq: last, limit: 10 })).toMatchObject({ events: [], hasEarlier: true, hasMore: false });
    expect(await fakes.agents.history({ sessionId: session.id, beforeSeq: 1, limit: 10 })).toMatchObject({ events: [], hasEarlier: false, hasMore: true });
  });

  it('a watch more than EVENTS_CATCH_UP_MAX behind answers the NEWEST page (it replaces the window) instead of paging forward', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    for (let i = 0; i < EVENTS_CATCH_UP_MAX + 600; i++) fakes.agents.say(session.id, 'x');
    const total = fakes.agents.eventsOf(session.id).length;
    const channel = { channelId: 'ch_test', userId: 'dev:mei' } as never;
    const far = await fakes.agents.watch({ sessionId: session.id, haveSeq: 2 }, channel);
    expect(total - 2).toBeGreaterThan(EVENTS_CATCH_UP_MAX);
    expect(far.events).toHaveLength(EVENTS_PAGE_MAX);
    expect(far).toMatchObject({ firstSeq: total - EVENTS_PAGE_MAX + 1, hasEarlier: true, hasMore: false });
    expect(far.firstSeq).not.toBe(3); // not `haveSeq + 1`: the client replaces what it holds
    // Exactly at the limit it still continues from `haveSeq`.
    const near = await fakes.agents.watch({ sessionId: session.id, haveSeq: total - EVENTS_CATCH_UP_MAX }, channel);
    expect(near).toMatchObject({ firstSeq: total - EVENTS_CATCH_UP_MAX + 1, hasMore: true });
  });

  it('a streaming block: `delta` keeps the text for the next watch and sends it to the live watchers; a turn\'s end clears it', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    const turnId = fakes.agents.startTurn(session.id);
    fakes.agents.delta(session.id, { turnId, blockId: 'b_1' }, 'The cart');
    fakes.agents.delta(session.id, { turnId, blockId: 'b_1' }, ' lives in');
    fakes.agents.delta(session.id, { turnId, blockId: 'b_2', parentToolUseId: 'tu_task' }, 'In the subagent');
    fakes.agents.thinking(session.id, { turnId, blockId: 'b_3' });
    const deltas = fakes.agents.toWatchersLog.filter((entry) => entry.type === 'session.delta').map((entry) => entry.payload);
    expect(deltas).toEqual([
      { sessionId: session.id, turnId, blockId: 'b_1', offset: 0, text: 'The cart' },
      { sessionId: session.id, turnId, blockId: 'b_1', offset: 8, text: ' lives in' },
      { sessionId: session.id, turnId, blockId: 'b_2', offset: 0, text: 'In the subagent', parentToolUseId: 'tu_task' },
      { sessionId: session.id, turnId, blockId: 'b_3', offset: 0, text: '', thinking: true },
    ]);
    for (const delta of deltas) valid(getMessageSpec('session.delta')?.payload as never, delta);
    const mid = await fakes.agents.watch({ sessionId: session.id }, { channelId: 'ch_test', userId: 'dev:mei' } as never);
    // A block the agent only thinks in is never in `streaming`.
    expect(mid.streaming).toEqual([{ turnId, blockId: 'b_1', text: 'The cart lives in' }, { turnId, blockId: 'b_2', text: 'In the subagent', parentToolUseId: 'tu_task' }]);
    fakes.agents.finishTurn(session.id);
    expect((await fakes.agents.watch({ sessionId: session.id }, { channelId: 'ch_test', userId: 'dev:mei' } as never)).streaming).toEqual([]);
  });
});

describe('FakeConversationService and FakeSuggestionService', () => {
  it('a question: asked, voted on, commented, submitted; every version passes the schema and is announced on the bus', async () => {
    const { fakes, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    const question = fakes.conversation.ask({ sessionId: session.id });
    valid(questionSchema, question);
    fakes.conversation.vote({ questionId: question.id, part: 0, options: [1] }, eddie);
    fakes.conversation.vote({ questionId: question.id, part: 0, options: [0] }, eddie); // a vote replaces the member's earlier one
    const { commentId } = fakes.conversation.comment({ questionId: question.id, text: 'the second, I think' }, eddie);
    expect(commentId).toBeTruthy();
    const answered = await fakes.conversation.submit({ questionId: question.id, answers: [{ options: [0] }] }, mei);
    valid(questionSchema, answered);
    expect(answered).toMatchObject({ status: 'answered', answer: { by: { userId: 'dev:mei' }, parts: [{ options: [0] }] } });
    expect(answered.votes).toHaveLength(1);
    expect(answered.comments).toHaveLength(1);
    expect(payloads['question.changed']).toHaveLength(5);
    expect(payloads['question.changed']?.[0]?.previous).toBeNull();
    expect(payloads['question.changed']?.[4]).toMatchObject({ question: { status: 'answered' }, previous: { status: 'open' } });
    for (const change of payloads['question.changed'] ?? []) valid(questionSchema, change.question);
    // The submitter was not the decider: the answer says for whom; the tally is THE tally (votes.ts).
    expect(answered.answer).toMatchObject({ onBehalfOf: { userId: 'dev:host' }, tally: [[1, 0, 0]] });
    // Too late: which card, how it ended and who did it; never the card itself.
    const late = await fakes.conversation.submit({ questionId: question.id, answers: [{ options: [0] }] }, mei).catch((error: unknown) => error);
    expect(late).toMatchObject({ code: 'conflict', detail: { reason: 'settled' } });
    expect(settledOfError(late as SmurgError)).toEqual({ reason: 'settled', card: { kind: 'question', id: question.id }, sessionId: session.id, status: 'answered', by: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(() => fakes.conversation.vote({ questionId: question.id, part: 0, options: [1] }, eddie)).toThrow(SmurgError);
    expect(fakes.conversation.openQuestions()).toEqual([]);
    expect(fakes.conversation.answeredQuestions(session.id).map((item) => item.id)).toEqual([question.id]);
    // A new card has its `card` event in the session; every change went to the session's watchers as the whole entity.
    expect(fakes.agents.eventsOf(session.id)).toMatchObject([{ kind: 'card', card: 'question', id: question.id }]);
    expect(fakes.agents.toWatchersLog.filter((entry) => entry.type === 'question.updated')).toHaveLength(5);
  });

  it('a permission request: the first answer wins; `permission.changed` carries the request before and after', async () => {
    const { fakes, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    const request = fakes.conversation.request({ sessionId: session.id });
    valid(permissionRequestSchema, request);
    const decided = await fakes.conversation.decide({ requestId: request.id, decision: 'deny', message: 'not on main' }, mei);
    valid(permissionRequestSchema, decided);
    expect(decided).toMatchObject({ status: 'denied', decision: { by: { userId: 'dev:mei' }, message: 'not on main' } });
    const late = await fakes.conversation.decide({ requestId: request.id, decision: 'allow' }, host).catch((error: unknown) => error);
    expect(settledOfError(late as SmurgError)).toEqual({ reason: 'settled', card: { kind: 'permission', id: request.id }, sessionId: session.id, status: 'denied', by: { userId: 'dev:mei', displayName: 'Mei' } });
    expect(JSON.stringify((late as SmurgError).toPayload())).not.toContain('pnpm');
    expect(payloads['permission.changed']?.map((change) => [change.previous?.status ?? null, change.request.status])).toEqual([[null, 'open'], ['open', 'denied']]);
    // The host's copy of an `outside` request carries the path; nobody else's does.
    const outside = fakes.conversation.request({ sessionId: session.id, what: 'outside', outside: true, path: '/Users/host/notes.txt', command: undefined, alwaysRule: undefined, hostOnly: true });
    const sent = fakes.agents.toWatchersLog.findLast((entry) => entry.type === 'permission.updated');
    expect(sent).toMatchObject({ payload: { request: { id: outside.id } }, hostPayload: { request: { id: outside.id, path: '/Users/host/notes.txt' } } });
    expect((sent?.payload as { request: object }).request).not.toHaveProperty('path');
    expect(fakes.agents.eventsOf(session.id).filter((event) => event.kind === 'card')).toHaveLength(2);
  });

  it('"Ask the agent to revise": the text that is stored, shown and sent is composed before a message or a suggestion exists', async () => {
    const { fakes } = bare();
    const { topic, session } = await fakes.topics.create({ name: 'Checkout' }, mei);
    const revise = { topicId: topic.id, target: 'spec' as const, text: 'Say who pays', quote: { heading: 'Cart rules', text: 'The cart is free.' } };
    const composed = 'About SPEC.md, section "Cart rules":\n```text\nThe cart is free.\n```\nSay who pays';
    // A member with agent access: a message of theirs.
    expect(await fakes.topics.revise(revise, mei)).toHaveProperty('messageId');
    expect(fakes.agents.sentTo(session.id).at(-1)).toMatchObject({ kind: 'person', origin: 'revise', text: composed, from: { userId: 'dev:mei' } });
    // An Editor: a suggestion whose card shows exactly what an accept sends.
    const proposed = await fakes.topics.revise({ topicId: topic.id, target: 'plan', text: 'Say who pays' }, eddie);
    if (!('suggestion' in proposed)) throw new Error('expected a suggestion');
    expect(proposed.suggestion).toMatchObject({ origin: 'revise', topicId: topic.id, text: 'About PLAN.md:\nSay who pays' });
    await fakes.suggestions.accept({ suggestionId: proposed.suggestion.id }, mei);
    expect(fakes.agents.sentTo(session.id).at(-1)).toMatchObject({ text: 'About PLAN.md:\nSay who pays', suggestion: { modified: false } });
    // Too long once composed: refused before anything is created.
    await expect(fakes.conversation.sendAs(eddie, { sessionId: session.id, origin: 'revise', target: 'spec', text: 'x'.repeat(64 * 1024) })).rejects.toMatchObject({ code: 'too_large' });
    await expect(fakes.conversation.sendAs(mei, { sessionId: session.id, origin: 'composer', text: ' \n ' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(fakes.suggestions.pending()).toEqual([]);
  });

  it('a message of a member with agent access goes to the session; an Editor\'s text becomes a suggestion that an accept sends', async () => {
    const { fakes, payloads } = bare();
    const session = await fakes.agents.start(freeStart());
    const direct = await fakes.conversation.sendAs(mei, { sessionId: session.id, text: 'do it', origin: 'composer' });
    expect(direct).toHaveProperty('messageId');
    const proposed = await fakes.conversation.sendAs(eddie, { sessionId: session.id, text: 'maybe​ this', origin: 'composer' });
    if (!('suggestion' in proposed)) throw new Error('expected a suggestion');
    valid(suggestionSchema, proposed.suggestion);
    expect(proposed.suggestion).toMatchObject({ status: 'pending', text: 'maybe this', cleaned: true, author: { userId: 'dev:eddie' } });
    expect(fakes.agents.sentTo(session.id)).toHaveLength(1);

    const accepted = await fakes.suggestions.accept({ suggestionId: proposed.suggestion.id }, mei);
    valid(suggestionSchema, accepted);
    expect(accepted.status).toBe('accepted');
    const last = fakes.agents.sentTo(session.id).at(-1);
    expect(last).toMatchObject({ kind: 'person', from: { userId: 'dev:eddie' }, text: 'maybe this', suggestion: { id: proposed.suggestion.id, acceptedBy: { userId: 'dev:mei' }, modified: false } });
    expect(payloads['suggestion.changed']?.map((change) => change.suggestion.status)).toEqual(['pending', 'accepted']);
    expect(fakes.suggestions.pending()).toEqual([]);
  });

  it('cards(): the open cards of a session within a byte budget, the rest by reference', async () => {
    const { fakes } = bare();
    const session = await fakes.agents.start(freeStart());
    const open = fakes.conversation.ask({ sessionId: session.id });
    const other = fakes.conversation.ask({ sessionId: 'ses_other' });
    const permission = fakes.conversation.request({ sessionId: session.id });
    const all = fakes.conversation.cards(session.id, [], { includeOpen: true, budgetBytes: 1_000_000, forHost: false });
    expect(all.questions.map((question) => question.id)).toEqual([open.id]);
    expect(all.permissions.map((request) => request.id)).toEqual([permission.id]);
    expect(all.more).toEqual([]);
    expect(all.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(all)).not.toContain(other.id);
    const none = fakes.conversation.cards(session.id, [], { includeOpen: true, budgetBytes: 1, forHost: false });
    expect([...none.questions, ...none.permissions]).toEqual([]);
    expect(none.more.map((ref) => ref.id).sort()).toEqual([open.id, permission.id].sort());
    const one = fakes.conversation.cards(session.id, [{ kind: 'question', id: open.id }], { includeOpen: false, budgetBytes: 1, forHost: false, atLeastOne: true });
    expect(one.questions.map((question) => question.id)).toEqual([open.id]);
  });
});

describe('FakeTopicService, FakePlanService and FakeReportService', () => {
  it('a topic is created with its discussion session; list pages; archive, then delete, each announced', async () => {
    const { fakes, events } = bare();
    const { topic, session } = await fakes.topics.create({ name: 'Login with passkeys' }, mei);
    valid(topicSchema, topic);
    valid(agentSessionSchema, session);
    expect(topic).toMatchObject({ slug: 'login-with-passkeys', discussionSessionId: session.id, createdBy: { userId: 'dev:mei' } });
    expect(session).toMatchObject({ purpose: 'discussion', topicId: topic.id, modeFixed: true });
    expect(fakes.topics.bySession(session.id)?.id).toBe(topic.id);
    await expect(fakes.topics.create({ name: 'Other', slug: 'login-with-passkeys' }, mei)).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'slug-taken' } });
    expect(fakes.topics.list({})).toMatchObject({ topics: [{ id: topic.id }], hasMore: false });
    await expect(fakes.topics.delete({ topicId: topic.id }, host)).rejects.toMatchObject({ detail: { reason: 'not-archived' } });
    await fakes.topics.archive({ topicId: topic.id, archived: true }, host);
    expect(fakes.topics.list({}).topics).toEqual([]);
    expect(fakes.topics.list({ archived: true }).topics).toHaveLength(1);
    // An archived topic's sessions ended and left the general list; with the topic's id they are still found.
    expect(fakes.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'archived' });
    expect(fakes.agents.list()).toEqual([]);
    expect(fakes.sessions.list()).toEqual([]);
    expect(fakes.agents.list({ topicId: topic.id }).map((item) => item.id)).toEqual([session.id]);
    expect(fakes.sessions.list({ topicId: topic.id }).map((item) => item.id)).toEqual([session.id]);
    await fakes.topics.delete({ topicId: topic.id }, host);
    expect(fakes.topics.get(topic.id)).toBeNull();
    // create: the topic first, then again with its discussion session; archive; delete.
    expect(events.filter((name) => name.startsWith('topic.'))).toEqual(['topic.changed', 'topic.changed', 'topic.changed', 'topic.removed']);
  });

  it('the order a topic\'s parts appear and go in: the topic before its session, `topic.removed` with the session ids before the transcripts go', async () => {
    const { env, fakes } = bare();
    const found: (string | null)[] = [];
    env.bus.on('session.created', (event) => found.push(event.session.kind === 'agent' && event.session.topicId !== undefined ? (fakes.topics.get(event.session.topicId)?.name ?? null) : 'free'));
    const { topic, session } = await fakes.topics.create({ name: 'Checkout', firstMessage: 'Where do we start?' }, mei);
    expect(found).toEqual(['Checkout']);
    expect(session).toMatchObject({ topicName: 'Checkout' });
    expect(session.title).toBeUndefined(); // "Discussion" is every client's wording, not a stored title
    expect(fakes.agents.agentActor(session.id).displayName).toBe('Claude (Checkout)');
    expect(fakes.agents.eventsOf(session.id).map((event) => (event.kind === 'line' ? event.text.id : event.kind))).toEqual(['conversation.started.discussion', 'message']);

    // A rename relabels the topic's sessions.
    await fakes.topics.rename({ topicId: topic.id, name: 'Paying' }, mei);
    expect(fakes.agents.get(session.id)?.topicName).toBe('Paying');

    // A restart of the discussion: the old one is told and ends `replaced`; the new one opens with its own line.
    const restarted = await fakes.topics.restartDiscussion({ topicId: topic.id }, mei);
    expect(fakes.agents.get(session.id)).toMatchObject({ status: 'ended', endReason: 'replaced' });
    expect(lines(fakes, session.id).at(-1)).toBe('conversation.discussion.replaced');
    expect(lines(fakes, restarted.session.id)).toEqual(['conversation.discussion.restarted']);
    expect(restarted.topic.discussionSessionId).toBe(restarted.session.id);

    await fakes.topics.archive({ topicId: topic.id, archived: true }, host);
    const stillThere: boolean[] = [];
    env.bus.on('topic.removed', (event) => {
      expect([...event.sessionIds].sort()).toEqual([session.id, restarted.session.id].sort());
      stillThere.push(event.sessionIds.every((id) => fakes.agents.get(id) !== null));
    });
    await fakes.topics.delete({ topicId: topic.id }, host);
    expect(stillThere).toEqual([true]); // listeners could still read the sessions …
    expect(fakes.agents.get(session.id)).toBeNull(); // … and then the records and transcripts went
    expect(fakes.agents.log.of('forget')).toHaveLength(1);
  });

  it('archiving a topic with unmerged work needs a decision: the refusal lists the worktrees, `deleteUnmerged` keeps or removes them', async () => {
    const { fakes } = bare();
    const { topic } = await fakes.topics.create({ name: 'Login' }, mei);
    const merged = await fakes.worktrees.acquireForItem({ topic: { id: topic.id, slug: topic.slug }, itemId: 'api', owner: mei });
    const open = await fakes.worktrees.acquireForItem({ topic: { id: topic.id, slug: topic.slug }, itemId: 'ui', owner: mei });
    const draft = await fakes.worktrees.snapshot({ worktreeId: merged.worktree.id, message: 'item api' });
    if (!draft.ok) throw new Error('snapshot');
    await fakes.worktrees.approve({ requestId: draft.request.id }, host);
    await fakes.worktrees.snapshot({ worktreeId: open.worktree.id, message: 'item ui' });
    const refused = await fakes.topics.archive({ topicId: topic.id, archived: true }, mei).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'conflict', detail: { reason: 'unmerged' }, text: { id: 'topic.archive.unmerged', params: { count: 1 } } });
    expect(unmergedWorktreesOfError(refused as SmurgError)).toEqual([{ itemId: 'ui', worktreeId: open.worktree.id, branch: 'smurg/login/ui' }]);
    expect(fakes.topics.get(topic.id)?.archived).toBe(false); // nothing changed
    expect(fakes.worktrees.list()).toHaveLength(2);
    // "Keep them": the merged item's worktree goes, the unmerged one stays.
    await fakes.topics.archive({ topicId: topic.id, archived: true, deleteUnmerged: false }, mei);
    expect(fakes.worktrees.list().map((worktree) => worktree.id)).toEqual([open.worktree.id]);
    // Restored and archived again with "Delete them".
    await fakes.topics.archive({ topicId: topic.id, archived: false }, mei);
    await fakes.topics.archive({ topicId: topic.id, archived: true, deleteUnmerged: true }, mei);
    expect(fakes.worktrees.list()).toEqual([]);
    // A session's end never releases a work item's worktree, whatever `keep` says; edits no snapshot has count as unmerged.
    const later = await fakes.worktrees.acquireForItem({ topic: { id: topic.id, slug: topic.slug }, itemId: 'docs', owner: mei });
    await fakes.worktrees.releaseFromSession(later.worktree.id, 'ses_x', { keep: false });
    expect(fakes.worktrees.get(later.worktree.id)).not.toBeNull();
    expect(fakes.worktrees.unmerged(topic.id)).toEqual([]);
    fakes.worktrees.unsavedEdits.add(later.worktree.id);
    expect(fakes.worktrees.unmerged(topic.id).map((worktree) => worktree.itemId)).toEqual(['docs']);
    // The handover of an item's worktree.
    await fakes.worktrees.setOwner(later.worktree.id, host);
    expect(fakes.worktrees.get(later.worktree.id)).toMatchObject({ ownerUserId: 'dev:host', ownerName: 'Host' });
  });

  it('"Show the changes": what a test put is what `plan.changes` and the worktree module\'s diff answer', async () => {
    const { fakes } = bare();
    expect(await fakes.plans.changes({ topicId: 'tp_1' }, mei)).toEqual({ files: [] });
    fakes.plans.nextChanges = { files: [{ target: 'spec', diff: '-old\n+new\n', truncated: false }] };
    expect(await fakes.plans.changes({ topicId: 'tp_1' }, mei)).toEqual({ files: [{ target: 'spec', diff: '-old\n+new\n', truncated: false }] });
    valid(getMessageSpec('plan.changes')?.result as never, await fakes.plans.changes({ topicId: 'tp_1' }, mei));
    fakes.worktrees.mainDiffs.set('specs/login/SPEC.md', { diff: '-old\n+new\n' });
    const input = { paths: ['specs/login/SPEC.md', 'specs/login/PLAN.md'], against: 'head' as const };
    expect(await fakes.worktrees.diffMainPaths({ ...input, maxBytes: 1024 })).toEqual([{ path: 'specs/login/SPEC.md', diff: '-old\n+new\n', truncated: false }]);
    expect(await fakes.worktrees.diffMainPaths({ ...input, against: { 'specs/login/SPEC.md': 'abc', 'specs/login/PLAN.md': null }, maxBytes: 4 })).toEqual([{ path: 'specs/login/SPEC.md', diff: '-old', truncated: true }]);
    fakes.worktrees.main = { ...fakes.worktrees.main, isRepo: false };
    expect(await fakes.worktrees.diffMainPaths({ ...input, maxBytes: 1024 })).toEqual([]);
  });

  it('a plan: preflight for the items that would start, start arms them under the pins, a changed pin is refused', async () => {
    const { fakes, payloads } = bare();
    const plan = fakes.plans.putPlan(buildPlan({ topicId: 'tp_1', items: [buildWorkItem({ id: 'api', number: 1 }), buildWorkItem({ id: 'ui', number: 2, dependsOn: ['api'] })] }));
    valid(planInfoSchema, plan);
    const preflight = await fakes.plans.preflight({ topicId: 'tp_1' }, mei);
    valid(startPreflightSchema, preflight);
    expect(preflight).toMatchObject({ startsNow: ['api'], waits: [{ itemId: 'ui', for: ['api'] }], blockers: [] });
    await expect(fakes.plans.start({ topicId: 'tp_1', planRevision: plan.revision + 1, specHash: plan.specHash, planHash: plan.planHash }, mei)).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'plan-changed' } });
    const started = await fakes.plans.start({ topicId: 'tp_1', planRevision: plan.revision, specHash: plan.specHash, planHash: plan.planHash }, mei);
    valid(planInfoSchema, started);
    expect(started.items.map((item) => [item.id, item.state, item.armed])).toEqual([['api', 'queued', true], ['ui', 'waiting', true]]);
    fakes.plans.patchItem('tp_1', 'api', { state: 'running', sessionId: 'ses_api' });
    expect(fakes.plans.itemBySession('ses_api')).toMatchObject({ topicId: 'tp_1', item: { id: 'api' } });
    expect(payloads['plan.changed']).toHaveLength(3);
    for (const change of payloads['plan.changed'] ?? []) valid(planInfoSchema, change.plan);
  });

  it('a report: registered to review, reviewed once for all; an unfinished one needs the acknowledgement', async () => {
    const { fakes, payloads } = bare();
    const report = fakes.reports.register('tp_1', 'api', { outcome: 'partial' });
    valid(reportInfoSchema, report);
    expect(fakes.reports.toReview()).toMatchObject([{ topicId: 'tp_1', itemId: 'api' }]);
    await expect(fakes.reports.review({ topicId: 'tp_1', itemId: 'api', version: report.version }, mei)).rejects.toMatchObject({ detail: { reason: 'unfinished' } });
    await expect(fakes.reports.review({ topicId: 'tp_1', itemId: 'api', version: report.version + 1, acknowledgeUnfinished: true }, mei)).rejects.toMatchObject({ detail: { reason: 'report-changed' } });
    const reviewed = await fakes.reports.review({ topicId: 'tp_1', itemId: 'api', version: report.version, acknowledgeUnfinished: true }, mei);
    valid(reportSummarySchema, reviewed);
    expect(reviewed).toMatchObject({ state: 'reviewed', review: { by: { userId: 'dev:mei' } } });
    expect(fakes.reports.toReview()).toEqual([]);
    expect(payloads['report.changed']?.map((change) => [change.previous?.state ?? null, change.report.state])).toEqual([[null, 'to-review'], ['to-review', 'reviewed']]);
  });
});

describe('FakeInboxService, FakeWorktreeManager, FakeSessionManager, FakeHookServer', () => {
  it('the inbox keeps derived items and stored notes per member; opening a note removes it, a waiting item cannot be dismissed', () => {
    const { fakes } = bare();
    expect(fakes.inbox.addMention({ userId: 'dev:eddie', from: mei.actor, target: { kind: 'session', sessionId: 'ses_1' }, excerpt: 'can you look?' })).toBe('stored');
    fakes.inbox.addResult({ userId: 'dev:eddie', from: mei.actor, suggestionId: 'sg_1', sessionId: 'ses_1', outcome: 'rejected', excerpt: 'no' });
    const items = fakes.inbox.itemsOf('dev:eddie');
    for (const item of items) valid(inboxItemSchema, item);
    expect(items.map((item) => item.kind)).toEqual(['mention', 'result']);
    expect(fakes.inbox.list(eddie).items).toHaveLength(2);
    expect(fakes.inbox.list(mei).items).toEqual([]);
    fakes.inbox.seen(eddie, [items[0]?.key as string]);
    fakes.inbox.dismiss(eddie, items[1]?.key as string);
    expect(fakes.inbox.itemsOf('dev:eddie')).toEqual([]);
    expect(() => fakes.inbox.dismiss(eddie, 'mention:nope')).toThrow();
    fakes.inbox.full.add('dev:eddie');
    expect(fakes.inbox.addMention({ userId: 'dev:eddie', from: mei.actor, target: { kind: 'session', sessionId: 'ses_1' }, excerpt: 'again' })).toBe('full');
    expect(fakes.inbox.mentions).toHaveLength(1);
    expect(fakes.inbox.results).toHaveLength(1);
  });

  it('derived items and stored notes are kept apart: replacing what is derived never drops a mention or a result', () => {
    const { fakes } = bare();
    fakes.inbox.addMention({ userId: 'dev:eddie', from: mei.actor, target: { kind: 'session', sessionId: 'ses_1' }, excerpt: 'look' });
    fakes.inbox.addResult({ userId: 'dev:eddie', from: mei.actor, suggestionId: 'sg_1', sessionId: 'ses_1', outcome: 'accepted-edited', excerpt: 'mine' });
    const derived = [buildInboxItem('question'), buildInboxItem('report'), buildInboxItem('attention')];
    fakes.inbox.setItems('dev:eddie', derived);
    expect(fakes.inbox.itemsOf('dev:eddie').map((item) => item.kind)).toEqual(['question', 'report', 'attention', 'mention', 'result']);
    for (const item of fakes.inbox.itemsOf('dev:eddie')) valid(inboxItemSchema, item);
    expect(fakes.inbox.itemsOf('dev:eddie').at(-1)).toMatchObject({ kind: 'result', result: 'accepted-edited', anchor: { cardId: 'sg_1' } });
    fakes.inbox.setItems('dev:eddie', []);
    expect(fakes.inbox.itemsOf('dev:eddie').map((item) => item.kind)).toEqual(['mention', 'result']);
    // A derived item is read, never dismissed; reading keeps it.
    fakes.inbox.setItems('dev:eddie', derived);
    fakes.inbox.seen(eddie, ['question:q_1']);
    expect(fakes.inbox.itemsOf('dev:eddie').find((item) => item.kind === 'question')).toMatchObject({ unread: false });
    expect(() => fakes.inbox.dismiss(eddie, 'question:q_1')).toThrow(SmurgError);
    expect(fakes.inbox.list(eddie, { after: 'question:q_1' }).items.map((item) => item.kind)).toEqual(['report', 'attention', 'mention', 'result']);
  });

  it('worktrees: an item worktree, a snapshot, a merge request that is approved; each change announced', async () => {
    const { fakes, events } = bare();
    const handle = await fakes.worktrees.acquireForItem({ topic: { id: 'tp_1', slug: 'login' }, itemId: 'api', owner: mei });
    const info = fakes.worktrees.get(handle.worktree.id);
    valid(worktreeInfoSchema, info);
    expect(info).toMatchObject({ topicId: 'tp_1', itemId: 'api' });
    const snapshot = await fakes.worktrees.snapshot({ worktreeId: handle.worktree.id, message: 'item api', topicSlug: 'login' });
    expect(snapshot.ok).toBe(true);
    const request = await fakes.worktrees.requestMerge({ worktreeId: handle.worktree.id }, mei);
    valid(mergeRequestSchema, request);
    const approved = await fakes.worktrees.approve({ requestId: request.id }, host);
    valid(mergeRequestSchema, approved);
    expect(approved.status).toBe('merged');
    expect(events.filter((name) => name === 'merge.changed').length).toBeGreaterThanOrEqual(2);
    expect(events).toContain('worktree.changed');
  });

  it('the session registry holds both kinds; a terminal is ended by the member who opened it', async () => {
    const { fakes, events } = bare();
    const terminal = await fakes.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 }, {} as never, mei);
    valid(terminalSessionSchema, terminal);
    const agent = await fakes.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, firstMessage: 'hello' }, {} as never, mei);
    valid(agentSessionSchema, agent);
    expect(fakes.sessions.list().map((session) => session.kind).sort()).toEqual(['agent', 'terminal']);
    expect(fakes.agents.sentTo(agent.id)).toHaveLength(1);
    await expect(fakes.sessions.end({ sessionId: terminal.id }, eddie)).rejects.toMatchObject({ code: 'forbidden' });
    await fakes.sessions.end({ sessionId: terminal.id }, mei);
    expect(fakes.sessions.get(terminal.id)).toMatchObject({ status: 'exited' });
    expect(events.filter((name) => name === 'session.created')).toHaveLength(2);
    expect(events).toContain('session.exited');
    // A free session opens with its line, takes its title from the first message and starts in its default mode.
    expect(agent).toMatchObject({ purpose: 'free', title: 'hello', permissionMode: 'ask-all' });
    expect(fakes.agents.eventsOf(agent.id).map((event) => (event.kind === 'line' ? event.text.id : event.kind))).toEqual(['conversation.started.free', 'message']);
    const inWorktree = await fakes.sessions.create({ kind: 'agent', workspace: { mode: 'worktree' }, title: 'Try the cache' }, {} as never, mei);
    expect(inWorktree).toMatchObject({ title: 'Try the cache', permissionMode: 'ask-commands' });
  });

  it('a member who goes: their topic sessions pass to the host with a line, an item\'s worktree with them; the rights of the session stay', async () => {
    const { fakes } = bare();
    const { topic, session: discussion } = await fakes.topics.create({ name: 'Login' }, mei);
    const handle = await fakes.worktrees.acquireForItem({ topic: { id: topic.id, slug: topic.slug }, itemId: 't2', owner: mei });
    const item = await fakes.agents.start({ ...freeStart(), purpose: 'item', topic: { id: topic.id, slug: topic.slug, name: topic.name }, item: { id: 't2', number: 2, title: 'Token store', attempt: 1 }, responsible: { userId: 'dev:mei', displayName: 'Mei' }, workspace: { mode: 'worktree', worktreeId: handle.worktree.id }, mode: 'ask-commands' });
    fakes.agents.startTurn(item.id);
    const result = await fakes.sessions.teardownUser('dev:mei', 'kicked');
    expect(result.handedOver).toEqual([{ sessionId: discussion.id, topicId: topic.id, stopped: true }, { sessionId: item.id, topicId: topic.id, stopped: true }]);
    expect([...result.cleared].sort()).toEqual([discussion.id, item.id].sort());
    expect(fakes.agents.facts(item.id)).toMatchObject({ ownerUserId: 'dev:host', pathRights: 'member', fallbackDecider: null });
    expect(fakes.worktrees.get(handle.worktree.id)).toMatchObject({ ownerUserId: 'dev:host' });
    expect(fakes.agents.get(item.id)).toMatchObject({ status: 'idle', responsible: null });
    // The system's stop writes no "stopped by" line: the handover line says it. ONE fallback line per session.
    expect(lines(fakes, item.id)).toEqual(['conversation.owner.handover.kicked', 'conversation.responsible.fallback']);
    expect(lines(fakes, discussion.id)).toEqual(['conversation.started.discussion', 'conversation.owner.handover.kicked', 'conversation.responsible.fallback']);
    // Asked again (another path of the same teardown): nothing is handed over twice.
    expect((await fakes.sessions.teardownUser('dev:mei', 'kicked')).handedOver).toEqual([]);
    // A demotion to Editor keeps `discuss`: sessions are handed over RUNNING, nothing is cleared.
    const { session: other } = await fakes.topics.create({ name: 'Billing' }, fakePrincipal('dev:rita', 'agent', 'Rita'));
    fakes.agents.setResponsible(other.id, { userId: 'dev:rita', displayName: 'Rita' }, { kind: 'system' });
    expect(await fakes.sessions.teardownUser('dev:rita', 'role-changed', 'editor')).toEqual({ ended: [], handedOver: [{ sessionId: other.id, topicId: expect.any(String), stopped: false }], cleared: [] });
    expect(lines(fakes, other.id).at(-1)).toBe('conversation.owner.handover');
    expect(fakes.agents.get(other.id)?.responsible).toEqual({ userId: 'dev:rita', displayName: 'Rita' });
  });

  it('the hook server registers a session with its profile and hands out launch file paths without writing anything', async () => {
    const { fakes } = bare();
    const credentials = fakes.hooks.registerSession(buildHookRegistration(REGISTRATION));
    expect(credentials.token).toBeTruthy();
    expect(credentials.env['SMURG_SESSION_ID']).toBe('ses_1');
    const files = await fakes.hooks.writeSessionFiles('ses_1', buildLaunchProfile({ rolePrompt: 'You are an agent.' }));
    expect(files.rolePromptPath.endsWith('role.md')).toBe(true);
    expect(fakes.hooks.profiles.get('ses_1')?.rolePrompt).toBeTruthy();
    fakes.hooks.reassignSession('ses_1', 'dev:host');
    expect(fakes.hooks.registrations.get('ses_1')?.ownerUserId).toBe('dev:host');
    fakes.hooks.unregisterSession('ses_1');
    expect(fakes.hooks.registrations.has('ses_1')).toBe(false);
  });
});

describe('in a test daemon', () => {
  it('fakesModule() fills every protocol 4 slot; `except` leaves a slot for the module under test', async () => {
    t = await createTestDaemon({ modules: [fakesModule()] });
    const fakes = fakesOf(t.ctx);
    for (const name of FAKE_SERVICE_NAMES) expect(t.ctx.services[name], name).toBe(fakes[name]);
    // What protocol 4 did not touch stays a stub here (files, docs, locks, …): compose the real module when you need it.
    expect(FEATURE_SERVICE_NAMES.filter((name) => isStubService(t?.ctx.services[name])).sort()).toEqual(FEATURE_SERVICE_NAMES.filter((name) => !(FAKE_SERVICE_NAMES as readonly string[]).includes(name)).sort());
    await t.cleanup();

    t = await createTestDaemon({ modules: [fakesModule({ except: ['conversation', 'inbox'] })] });
    expect(isStubService(t.ctx.services.conversation)).toBe(true);
    expect(isStubService(t.ctx.services.inbox)).toBe(true);
    expect(t.ctx.services.agents).toBe(fakesOf(t.ctx).agents);
    await t.cleanup();

    t = await createTestDaemon({ modules: [] });
    expect(() => fakesOf((t as TestDaemon).ctx)).toThrow(/fakesModule/);
  });

  it('with the daemon\'s hub, what a fake appends really reaches the channels that watch the session, as the wire defines it', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [fakesModule(), probe.module] });
    const fakes = fakesOf(t.ctx);
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const session = await fakes.agents.start(freeStart(t.ctx.members.principalOf('dev:rita') ?? mei));
    const seen: ConversationEvent[] = [];
    const veraSeen: ConversationEvent[] = [];
    const states: string[] = [];
    rita.conn.on('session.events', (payload) => seen.push(...payload.events));
    vera.conn.on('session.events', (payload) => veraSeen.push(...payload.events));
    // The wire's `session.state` is the sessions module's to send; a fake announces a change on the bus.
    t.ctx.bus.on('session.updated', (event) => states.push(event.session.kind === 'agent' ? event.session.status : 'terminal'));
    const ritaConn = t.ctx.hub.connections({ userId: 'dev:rita' })[0];
    if (!ritaConn) throw new Error('rita is not connected');
    const start = await fakes.agents.watch({ sessionId: session.id }, ritaConn);
    start.afterReply();
    expect(fakes.agents.watchers(session.id)).toEqual(['dev:rita']);

    fakes.agents.say(session.id, 'Hello from the agent');
    fakes.agents.finishTurn(session.id);
    await waitFor(() => seen.length === 3, { what: 'three events at the watcher' });
    expect(seen.map((event) => event.kind)).toEqual(['turn.started', 'text', 'turn.finished']);
    expect(states).toContain('running');
    expect(states.at(-1)).toBe('idle');
    // Nobody who does not watch gets conversation events.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(veraSeen).toEqual([]);

    fakes.agents.unwatch(session.id, ritaConn.channelId);
    fakes.agents.say(session.id, 'nobody watches');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(3);
    // Every message the fakes put on the wire is a registered daemon → client type.
    for (const type of ['session.events', 'session.state', 'question.updated', 'permission.updated', 'inbox.changed'] as const) expect(getMessageSpec(type)?.dir).toBe('d2c');
    // Without a `session.watch` handler composed, a test makes a channel a watcher directly.
    fakes.agents.addWatcher(ritaConn, session.id);
    fakes.agents.say(session.id, 'watched again');
    await waitFor(() => seen.length === 4, { what: 'the event after addWatcher' });
    expect(seen.at(-1)).toMatchObject({ kind: 'text', text: 'watched again' });
  });

  it('fakesModule({ handlers: true }): a client talks the whole wire to the fakes (watch, cards, lists, the forwards of the bus)', async () => {
    t = await createTestDaemon({ modules: [fakesModule({ handlers: true })] });
    const fakes = fakesOf(t.ctx);
    const hostClient = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    const eddieClient = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    const states: SessionInfo[] = [];
    const topics: string[] = [];
    eddieClient.conn.on('session.state', (payload) => states.push(payload.session));
    eddieClient.conn.on('topic.updated', (payload) => topics.push(payload.topic.name));

    // A topic over the wire: `topic.updated` and `session.state` reach everyone.
    const { topic, session } = await rita.conn.request('topic.create', { name: 'Checkout', firstMessage: 'Where do we start?' });
    await waitFor(() => topics.length >= 2 && states.length >= 1, { what: 'the topic and its session at another member' });
    expect((await eddieClient.conn.request('topic.list', {})).topics.map((item) => item.id)).toEqual([topic.id]);
    expect(await eddieClient.conn.request('session.list', {})).toMatchObject({ sessions: [{ id: session.id, topicName: 'Checkout' }], hasMore: false });
    expect((await eddieClient.conn.request('session.list', { topicId: topic.id })).sessions).toHaveLength(1);

    // An editor watches the discussion: the page, then live events and card updates.
    const live: string[] = [];
    const cards: string[] = [];
    eddieClient.conn.on('session.events', (payload) => live.push(...payload.events.map((event) => event.kind)));
    eddieClient.conn.on('question.updated', (payload) => cards.push(payload.question.status));
    const watched = await eddieClient.conn.request('session.watch', { sessionId: session.id });
    expect(watched.events.map((event) => event.kind)).toEqual(['line', 'message']);
    expect(watched).toMatchObject({ firstSeq: 1, nextSeq: 3, hasEarlier: false, hasMore: false, questions: [], moreCards: [] });
    const question = fakes.conversation.ask({ sessionId: session.id });
    await waitFor(() => live.includes('card') && cards.length === 1, { what: 'the card event and the card at the watcher' });
    await eddieClient.conn.request('question.vote', { questionId: question.id, part: 0, options: [1] });
    await rita.conn.request('question.submit', { questionId: question.id, answers: [{ options: [1] }] });
    await waitFor(() => cards.at(-1) === 'answered', { what: 'the answered card at the watcher' });
    expect((await eddieClient.conn.request('session.cards.get', { sessionId: session.id, cards: [{ kind: 'question', id: question.id }] })).questions).toMatchObject([{ id: question.id, status: 'answered' }]);
    expect((await eddieClient.conn.request('session.history', { sessionId: session.id, afterSeq: 0, limit: 10 })).events.at(-1)).toMatchObject({ kind: 'card', id: question.id });
    // A terminal is not a conversation.
    const terminal = await rita.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    await expect(eddieClient.conn.request('session.watch', { sessionId: terminal.session.id })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'not-an-agent' } });

    // What every member may know of the host's side, and its changes.
    const hostStates: unknown[] = [];
    eddieClient.conn.on('session.host', (payload) => hostStates.push(payload));
    expect(await eddieClient.conn.request('session.host.get', {})).toEqual({ account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' });
    fakes.agents.setAccount({ state: 'logged-out', sessions: 1 });
    fakes.projectTrust.set(MAIN_ROOT, 'ignored');
    await waitFor(() => hostStates.length === 2, { what: 'two session.host events' });
    expect(hostStates.at(-1)).toEqual({ account: { state: 'logged-out', sessions: 1 }, mainProjectSettings: 'ignored' });

    // Restart, rename, the inbox, a plan and its changes: each request reaches its fake.
    expect(await rita.conn.request('session.restart', { sessionId: session.id })).toMatchObject({ session: { id: session.id } });
    expect(fakes.agents.log.of('restartProcess')).toEqual([[session.id, 'asked']]);
    expect((await rita.conn.request('session.rename', { sessionId: terminal.session.id, title: 'build shell' })).session).toMatchObject({ kind: 'terminal', title: 'build shell' });
    fakes.inbox.setItems('dev:eddie', [buildInboxItem('vote')]);
    expect((await eddieClient.conn.request('inbox.list', {})).items.map((item) => item.kind)).toEqual(['vote']);
    fakes.plans.putPlan(buildPlan({ topicId: topic.id }));
    expect((await eddieClient.conn.request('plan.get', { topicId: topic.id })).plan?.items).toHaveLength(1);
    expect(await eddieClient.conn.request('plan.changes', { topicId: topic.id })).toEqual({ files: [] });
    expect(buildEvent('text').kind).toBe('text');
    void hostClient;
  });

  it('`except` takes a slot\'s handlers with it: the module under test registers its own', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [fakesModule({ except: ['conversation', 'inbox'], handlers: true }), probe.module] });
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    // The probe answers what nobody handles: these two areas were left to the real module.
    await expect(rita.conn.request('inbox.list', {})).rejects.toMatchObject({ detail: { reason: 'probe-reached' } });
    await expect(rita.conn.request('question.remind', { questionId: 'q_nope' })).rejects.toMatchObject({ detail: { reason: 'probe-reached' } });
    // The faked areas are answered by the fakes.
    expect(await rita.conn.request('topic.list', {})).toEqual({ topics: [], hasMore: false });
    expect(await rita.conn.request('suggest.list', {})).toEqual({ suggestions: [], hasMore: false });
  });
});
