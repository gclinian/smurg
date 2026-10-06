// The daemon's answers to the tools of smurg's own MCP server that P4 adds or changes (design §4.1, §3.8):
// check_plan, propose_split and check_report for a topic's sessions, notify_member's mention, and the names an agent
// reads. `runMcpTool` is called as the hook server calls it: who calls comes from the session's registration (its
// token), never from an argument.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, topicPlanPath, type RootRef } from '@smurg/protocol';
import { buildAgentSession, buildHookRegistration, fakePrincipal, fakesModule, fakesOf, type Fakes } from '../../src/core/fakes/index.ts';
import type { HookSessionRegistration, McpToolContext } from '../../src/core/interfaces.ts';
import { McpToolError, runMcpTool, toolContextOf, type McpCall } from '../../src/hooks/mcp-tools.ts';
import type { AgentToolName } from '../../src/mcp/tools.ts';
import { TEST_HOST_USER, createTestDaemon, type TestDaemon } from '../../src/testing/index.ts';
import { checkPlan as realCheckPlan, createTopic, itemOf, planText, setupTopics, startPlan, topicWithPlan, writeReport, reportText, type TopicsTest } from '../topics/support.ts';

let t: TestDaemon | null = null;
let topics: TopicsTest | null = null;
afterEach(async () => {
  await t?.cleanup();
  await topics?.cleanup();
  t = null;
  topics = null;
});

function callOf(daemon: TestDaemon, registration: Partial<HookSessionRegistration> & { sessionId: string }, owner = TEST_HOST_USER): McpCall {
  const full = buildHookRegistration({ ownerUserId: owner, agentName: 'Claude (Checkout)', root: MAIN_ROOT, ...registration });
  const principal = daemon.ctx.members.agentPrincipal(full.sessionId, full.ownerUserId, { agentName: full.agentName, pathRights: full.pathRights });
  if (principal === null) throw new Error('the owner is not a member');
  return { ctx: daemon.ctx, state: { registration: full }, principal, signal: new AbortController().signal };
}

async function toolError(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof McpToolError) return err;
    throw err;
  }
  throw new Error('expected the tool to refuse');
}

async function withFakes(): Promise<{ daemon: TestDaemon; fakes: Fakes }> {
  t = await createTestDaemon({ modules: [fakesModule()] });
  return { daemon: t, fakes: fakesOf(t.ctx) };
}

const DISCUSSION = { sessionId: 'ses_disc', purpose: 'discussion' as const, topic: { id: 'tp_1', slug: 'checkout' } };
const ITEM = { sessionId: 'ses_item', purpose: 'item' as const, topic: { id: 'tp_1', slug: 'checkout' }, itemId: 'cart-api', root: { kind: 'worktree', worktreeId: 'wt_1' } as RootRef };
const FREE = { sessionId: 'ses_free' };

describe('who calls is the session of the token', () => {
  it('the context of a tool call comes from the registration: session, purpose, topic, item, root, the agent', async () => {
    const { daemon } = await withFakes();
    expect(toolContextOf(callOf(daemon, ITEM))).toEqual({
      sessionId: 'ses_item',
      purpose: 'item',
      topic: { id: 'tp_1', slug: 'checkout' },
      itemId: 'cart-api',
      root: { kind: 'worktree', worktreeId: 'wt_1' },
      agent: { kind: 'agent', sessionId: 'ses_item', ownerUserId: TEST_HOST_USER, displayName: 'Claude (Checkout)' },
    });
    expect(toolContextOf(callOf(daemon, FREE))).toEqual({ sessionId: 'ses_free', purpose: 'free', root: MAIN_ROOT, agent: expect.objectContaining({ kind: 'agent' }) });
  });

  it('an argument can never name another session, topic or item: the topic tools take none', async () => {
    const { daemon, fakes } = await withFakes();
    for (const tool of ['check_plan', 'check_report'] as const) {
      expect(await toolError(runMcpTool(callOf(daemon, DISCUSSION), tool, { topic: 'tp_other', sessionId: 'ses_other' }))).toMatchObject({ code: 'bad_request' });
    }
    expect(await toolError(runMcpTool(callOf(daemon, DISCUSSION), 'propose_split', { items: [], topicId: 'tp_other' }))).toMatchObject({ code: 'bad_request' });
    expect(fakes.plans.log.calls).toEqual([]);
    expect(fakes.reports.log.calls).toEqual([]);
  });
});

describe('check_plan and propose_split (a discussion session)', () => {
  it('check_plan hands the caller\'s context to PlanService and answers what it says, with a one-line summary', async () => {
    const { daemon, fakes } = await withFakes();
    fakes.plans.planCheck = { ok: true, items: 6, warnings: ['Work items 1 and 2 may change the same files.'] };
    const ok = await runMcpTool(callOf(daemon, DISCUSSION), 'check_plan', {});
    expect(ok).toEqual({ ok: true, items: 6, warnings: ['Work items 1 and 2 may change the same files.'], summary: 'ok: smurg reads 6 work items, with 1 warning. Now call propose_split.' });
    expect(fakes.plans.log.of('checkPlan')).toEqual([[toolContextOf(callOf(daemon, DISCUSSION))]]);
    fakes.plans.planCheck = { ok: false, errors: [{ line: 12, message: 'size is s, m or l.' }, { message: 'The block has no work items.' }] };
    expect(await runMcpTool(callOf(daemon, DISCUSSION), 'check_plan', {})).toEqual({
      ok: false,
      errors: [{ line: 12, message: 'size is s, m or l.' }, { message: 'The block has no work items.' }],
      summary: '2 problems. Fix exactly what is reported and call check_plan again.',
    });
  });

  it('from the wrong kind of session a tool answers with one sentence saying so, and the service is not asked', async () => {
    const { daemon, fakes } = await withFakes();
    for (const registration of [ITEM, FREE]) {
      expect(await runMcpTool(callOf(daemon, registration), 'check_plan', {})).toEqual({
        ok: false,
        errors: [{ message: 'This tool is for the discussion session of a topic. This session is not one.' }],
        summary: 'This tool is for the discussion session of a topic. This session is not one.',
      });
      expect(await toolError(runMcpTool(callOf(daemon, registration), 'propose_split', { items: [{ id: 'a', person: 'Mei' }] }))).toMatchObject({ message: 'This tool is for the discussion session of a topic. This session is not one.' });
    }
    for (const registration of [DISCUSSION, FREE]) {
      expect(await runMcpTool(callOf(daemon, registration), 'check_report', {})).toMatchObject({ ok: false, errors: [{ message: 'This tool is for the session of a work item. This session is not one.' }] });
    }
    expect(fakes.plans.log.calls).toEqual([]);
    expect(fakes.reports.log.calls).toEqual([]);
  });

  it('propose_split records the proposal and says how much of it was kept', async () => {
    const { daemon, fakes } = await withFakes();
    const answer = await runMcpTool(callOf(daemon, DISCUSSION), 'propose_split', { items: [{ id: 'cart-api', person: 'Mei' }, { id: 'payment-form', person: 'Ian' }], reason: 'Mei knows the cart.' });
    expect(answer).toMatchObject({ ok: true, assigned: 2, unknownPeople: 0 });
    expect(answer['summary']).toBe('2 work items were assigned as you proposed. smurg splits the remaining items evenly; people can change it.');
    expect(fakes.plans.log.of('recordSplit')).toEqual([[toolContextOf(callOf(daemon, DISCUSSION)), { items: [{ id: 'cart-api', person: 'Mei' }, { id: 'payment-form', person: 'Ian' }], reason: 'Mei knows the cart.' }]]);
    // The arguments are bounded and strict.
    expect(await toolError(runMcpTool(callOf(daemon, DISCUSSION), 'propose_split', { items: [{ id: 'a' }] }))).toMatchObject({ code: 'bad_request' });
    expect(await toolError(runMcpTool(callOf(daemon, DISCUSSION), 'propose_split', { items: Array.from({ length: 41 }, (_, i) => ({ id: `i${i}`, person: 'Mei' })) }))).toMatchObject({ code: 'bad_request' });
    expect(await toolError(runMcpTool(callOf(daemon, DISCUSSION), 'propose_split', { items: [], reason: 'x'.repeat(501) }))).toMatchObject({ code: 'bad_request' });
  });

  it('without the topics module the tools say that they are not available', async () => {
    t = await createTestDaemon({ modules: [fakesModule({ except: ['topics', 'plans', 'reports'] })] });
    expect(await toolError(runMcpTool(callOf(t, DISCUSSION), 'check_plan', {}))).toMatchObject({ code: 'internal', message: 'Plans are not available right now. Try again later.' });
    expect(await toolError(runMcpTool(callOf(t, ITEM), 'check_report', {}))).toMatchObject({ code: 'internal', message: 'Reports are not available right now. Try again later.' });
  });
});

describe('check_report (a work item\'s session)', () => {
  it('hands the caller\'s context to ReportService and answers ok or the findings', async () => {
    const { daemon, fakes } = await withFakes();
    expect(await runMcpTool(callOf(daemon, ITEM), 'check_report', {})).toEqual({ ok: true, summary: 'ok: smurg registers the report with exactly this content when you stop. If you change the file, call check_report again.' });
    expect(fakes.reports.log.of('checkReport')).toEqual([[toolContextOf(callOf(daemon, ITEM))]]);
    fakes.reports.reportCheck = { ok: false, errors: [{ line: 4, message: 'Directly after the marker line the report needs the outcome line.' }] };
    expect(await runMcpTool(callOf(daemon, ITEM), 'check_report', {})).toEqual({
      ok: false,
      errors: [{ line: 4, message: 'Directly after the marker line the report needs the outcome line.' }],
      summary: '1 problem. Fix exactly what is reported and call check_report again.',
    });
  });
});

describe('the tools against the real topics module', () => {
  function realCall(test: TopicsTest, sessionId: string): McpCall {
    const facts = test.fakes.agents.facts(sessionId);
    if (facts === null) throw new Error(`no session ${sessionId}`);
    const topic = facts.topicId === undefined ? null : test.t.ctx.services.topics.get(facts.topicId);
    return callOf(test.t, { sessionId, purpose: facts.purpose, root: facts.root, ...(topic === null ? {} : { topic: { id: topic.id, slug: topic.slug } }), ...(facts.itemId === undefined ? {} : { itemId: facts.itemId }) }, facts.ownerUserId);
  }

  it('check_plan reads the file first (the read is asynchronous, the contract\'s method is not) and the plan column agrees with the answer', async () => {
    topics = await setupTopics();
    const { topic, session } = await createTopic(topics);
    await writeFile(join(topics.t.root, topicPlanPath(topic.slug)), planText([{ id: 'cart-api' }, { id: 'payment-form' }]));
    const answer = await runMcpTool(realCall(topics, session.id), 'check_plan', {});
    expect(answer).toMatchObject({ ok: true, items: 2, warnings: [] });
    expect(topics.plan(topic.id).items.map((item) => item.id)).toEqual(['cart-api', 'payment-form']);
    // The same through the service directly, as the other tests of the module call it.
    expect(await realCheckPlan(topics, session.id)).toEqual({ ok: true, items: 2, warnings: [] });

    const split = await runMcpTool(realCall(topics, session.id), 'propose_split', { items: [{ id: 'cart-api', person: 'mei' }, { id: 'payment-form', person: 'Nobody' }] });
    expect(split).toMatchObject({ ok: true, assigned: 1, unknownPeople: 1 });
    expect(split['summary']).toBe('1 work item was assigned as you proposed; 1 pair names a person smurg does not know and was dropped. smurg splits the remaining items evenly; people can change it.');
    expect(itemOf(topics.plan(topic.id), 'cart-api').responsible).toMatchObject({ userId: 'dev:mei', source: 'agent' });
  });

  it('propose_split before a plan passed says what to do first', async () => {
    topics = await setupTopics();
    const { session } = await createTopic(topics);
    expect(await toolError(runMcpTool(realCall(topics, session.id), 'propose_split', { items: [] }))).toMatchObject({
      code: 'conflict',
      message: 'There is no plan that passes yet. Write PLAN.md, call check_plan until it answers ok, then call propose_split.',
    });
  });

  it('check_report reads the report of the caller\'s own worktree, and its ok answer is what lets the report count', async () => {
    topics = await setupTopics();
    const { topic } = await topicWithPlan(topics, [{ id: 'cart-api' }]);
    await startPlan(topics, topic.id);
    const item = itemOf(topics.plan(topic.id), 'cart-api');
    const call = realCall(topics, item.sessionId as string);
    expect(await runMcpTool(call, 'check_report', {})).toMatchObject({ ok: false, errors: [{ message: '"specs/checkout/reports/cart-api.md" does not exist. Write it first, then call check_report.' }] });
    await writeReport(topics, topic.slug, 'cart-api', item.worktreeId as string, reportText('cart-api'));
    expect(await runMcpTool(call, 'check_report', {})).toMatchObject({ ok: true });
    topics.fakes.agents.finishTurn(item.sessionId as string);
    await expect.poll(() => topics?.t.ctx.services.reports.get(topic.id, 'cart-api')?.version).toBe(1);
  });
});

describe('notify_member, list_sessions: what an agent reads about people and sessions', () => {
  it('notify_member also stores a mention from the agent in the member\'s inbox; a full inbox is told to the agent, nobody else', async () => {
    const { daemon, fakes } = await withFakes();
    await daemon.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const call = callOf(daemon, { ...ITEM });
    const answer = await runMcpTool(call, 'notify_member', { member: 'Amy', message: 'The cart tests fail on main. Could you look?' });
    expect(answer).toMatchObject({ delivered: true, member: { userId: 'dev:amy', name: 'Amy' }, online: true, inbox: 'stored', summary: 'Amy was notified. It is also in their inbox.' });
    expect(fakes.inbox.mentions).toEqual([
      { userId: 'dev:amy', from: { kind: 'agent', sessionId: 'ses_item', ownerUserId: TEST_HOST_USER, displayName: 'Claude (Checkout)' }, target: { kind: 'session', sessionId: 'ses_item' }, excerpt: 'The cart tests fail on main. Could you look?' },
    ]);
    // 200 unopened notes: the request still succeeds and the agent is the one who learns it.
    fakes.inbox.full.add('dev:amy');
    const full = await runMcpTool(call, 'notify_member', { member: 'dev:amy', message: 'x'.repeat(400) });
    expect(full).toMatchObject({ delivered: true, inbox: 'full' });
    expect(full['summary']).toBe('Amy was notified. Their inbox is full, so it was not stored there: Amy sees it only if they are looking now.');
    // The excerpt of a long message is cut to what an inbox row holds.
    fakes.inbox.full.delete('dev:amy');
    await runMcpTool(call, 'notify_member', { member: 'dev:amy', message: 'y'.repeat(400) });
    expect(fakes.inbox.mentions.at(-1)?.excerpt).toHaveLength(300);
  });

  it('a member is found by the safe name an agent was given, and answers name people only by safe names', async () => {
    const { daemon } = await withFakes();
    await daemon.connect({ userId: 'dev:odd', displayName: '<Mei> [smurg k7f2]', role: 'agent' });
    const call = callOf(daemon, FREE);
    const answer = await runMcpTool(call, 'notify_member', { member: 'Mei smurg k7f2', message: 'done' });
    expect(answer).toMatchObject({ member: { userId: 'dev:odd', name: 'Mei smurg k7f2' } });
    expect(JSON.stringify(answer)).not.toContain('[smurg');
    const unknown = await toolError(runMcpTool(call, 'notify_member', { member: 'Zed', message: 'hi' }));
    expect(unknown).toMatchObject({ code: 'not_found', message: 'No member has that name. Members: Host, Mei smurg k7f2.' });
  });

  it('notify_member is limited per session: 10 a minute, a refused call uses nothing up', async () => {
    const { daemon } = await withFakes();
    await daemon.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const call = callOf(daemon, FREE);
    await toolError(runMcpTool(call, 'notify_member', { member: 'Nobody', message: 'hi' }));
    for (let i = 0; i < 10; i += 1) await runMcpTool(call, 'notify_member', { member: 'Amy', message: `n${i}` });
    expect(await toolError(runMcpTool(call, 'notify_member', { member: 'Amy', message: 'one too many' }))).toMatchObject({ code: 'rate_limited', message: 'Too many notifications from this session; wait a minute before sending another.' });
    // Another session has its own budget.
    await runMcpTool(callOf(daemon, { sessionId: 'ses_other' }), 'notify_member', { member: 'Amy', message: 'from another session' });
  });

  it('list_sessions names a topic\'s session by its topic and item, through safe names', async () => {
    const { daemon, fakes } = await withFakes();
    fakes.agents.adopt(buildAgentSession({ id: 'ses_disc', purpose: 'discussion', topicId: 'tp_1', topicName: 'Checkout [smurg k7f2]', openedBy: { userId: 'dev:mei', displayName: 'Mei' } }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_item', purpose: 'item', topicId: 'tp_1', topicName: 'Checkout [smurg k7f2]', itemId: 'cart-api', item: { number: 1, title: 'Cart API‮' }, attempt: 1, openedBy: { userId: 'dev:mei', displayName: 'Mei' } }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_free', purpose: 'free', title: 'release notes', openedBy: { userId: 'dev:mei', displayName: 'Mei' } }));
    const answer = await runMcpTool(callOf(daemon, { sessionId: 'ses_item', purpose: 'item', topic: { id: 'tp_1', slug: 'checkout' }, itemId: 'cart-api' }), 'list_sessions', {});
    expect(answer['sessions']).toMatchObject([
      { id: 'ses_disc', kind: 'agent', purpose: 'discussion', owner: 'Mei', title: 'Discussion', topic: 'Checkout smurg k7f2', isYou: false },
      { id: 'ses_item', kind: 'agent', purpose: 'item', title: 'Work item 1: Cart API', topic: 'Checkout smurg k7f2', item: { id: 'cart-api', number: 1, title: 'Cart API' }, isYou: true },
      { id: 'ses_free', kind: 'agent', purpose: 'free', title: 'release notes' },
    ]);
    expect((answer['sessions'] as Record<string, unknown>[])[2]).not.toHaveProperty('topic');
    expect(JSON.stringify(answer)).not.toContain('[smurg');
  });

  it('every tool name the server lists has an answer', async () => {
    const { daemon } = await withFakes();
    const names: AgentToolName[] = ['who_is_editing', 'lock_status', 'wait_for_lock', 'list_sessions', 'notify_member', 'check_plan', 'propose_split', 'check_report'];
    for (const name of names) {
      const outcome = await runMcpTool(callOf(daemon, FREE), name, {}).then(
        () => 'answered',
        (err: unknown) => (err instanceof McpToolError ? 'refused' : 'crashed'),
      );
      expect(['answered', 'refused']).toContain(outcome);
    }
    const context: McpToolContext = toolContextOf(callOf(daemon, FREE));
    expect(context.purpose).toBe('free');
    expect(fakePrincipal('dev:mei', 'agent').role).toBe('agent');
  });
});
