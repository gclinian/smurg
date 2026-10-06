// The release composition across a restart of the host's smurg, and across a crash of one agent process (DESIGN §2.2,
// §3.5, §4.5 "After a restart", §7 S16; REQUESTS-P12 "From P1" item 9, "From P2" item 4, "From P3" item 5): the real
// modules together on a real git repository with the stand-in `claude` (release-flow.support.ts).
//
// The daemon stops in the middle of a topic: one work item waits for a permission, one waits for another item, one
// has a report to review, the discussion has an open question with votes and a pending suggestion. After the start:
// everything is readable, the open cards are withdrawn and asked again with NEW ids, the plan is paused and nothing
// runs by itself until a member with agent access presses "Continue all". Then one session's process is killed:
// "Try again" continues the same session. On the way the host's own `smurg` command (the real CLI through the control
// socket: REQUESTS-P12 "From P6" item 3) shows the agent sessions of the composition, and in the end stops sharing.
import { describe, expect, it } from 'vitest';
import type { AgentSession, ConversationEvent, PlanInfo } from '@smurg/protocol';
import type { FakeClaudeScenario, FakeClaudeStep } from '../../src/testing/index.ts';
import { AMY, IAN, MEI, audited, eventOf, inboxItem, inboxWithout, kinds, launches, onDisk, permissionAt, questionAt, refusal, startFlow, statuses, statusIs, told, turnsFinished, waitFor, type Flow, type Person } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (itemId: string): string => `specs/${SLUG}/reports/${itemId}.md`;

const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Open questions', 'None.', ''].join('\n');
const PLAN = [
  '# Plan: Checkout',
  '',
  '<!-- smurg:plan v1 -->',
  '',
  '### 1. Cart API',
  '- id: cart-api',
  '- size: m',
  '',
  'Compute the total in one module.',
  '',
  '### 2. Checkout page',
  '- id: checkout-page',
  '- depends on: cart-api',
  '',
  'Put cart and payment on one page.',
  '',
  '### 3. Receipt email',
  '- id: receipt-email',
  '- size: s',
  '',
  'Send a receipt after the payment.',
  '',
  '<!-- smurg:plan end -->',
  '',
].join('\n');

function report(itemId: string, title: string): string {
  return [`# Result report: ${title}`, '', `<!-- smurg:report v1 item=${itemId} -->`, '- outcome: complete', '', '## What was done', `The work of ${title}.`, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}
const reportSteps = (itemId: string, title: string): FakeClaudeStep[] => [{ tool: 'Write', input: { file_path: reportPath(itemId), content: report(itemId, title) } }, { tool: 'mcp__smurg__check_report', input: {} }, { text: `${title} is done.` }];

const PAYMENT = { question: 'How do people pay?', header: 'Payment', multiSelect: false, options: [{ label: 'Cards only', description: 'One provider.' }, { label: 'Cards and invoices', description: 'More work.' }] };
const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm test' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' };

/** What the "model" does; `onContinue` is what a session does when smurg tells it to go on (it differs per phase). */
function scenario(onContinue: FakeClaudeStep[]): FakeClaudeScenario {
  return {
    turns: [
      { match: 'one page', once: true, steps: [{ tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } }, { text: 'The first draft of the spec is ready.' }] },
      { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'The plan has three work items.' }] },
      // Work item 1 wants to run a command and waits for a person.
      { match: 'Start work item 1 ', steps: [{ tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = 1;\n' } }, PNPM_TEST, ...reportSteps('cart-api', 'Cart API')] },
      // Work item 2 (after 1 is merged) too; its process is killed while it waits.
      { match: 'Start work item 2 ', steps: [{ tool: 'Write', input: { file_path: 'src/checkout/page.ts', content: 'export const page = 1;\n' } }, { tool: 'Bash', input: { command: 'pnpm build' } }, { text: 'never said' }] },
      // Work item 3 finishes with its report.
      { match: 'Start work item 3 ', steps: [{ tool: 'Write', input: { file_path: 'src/receipt/send.ts', content: 'export const send = 1;\n' } }, ...reportSteps('receipt-email', 'Receipt email')] },
      { match: 'ask us how people pay', steps: [{ tool: 'AskUserQuestion', input: { questions: [PAYMENT] } }, { text: 'Thank you.' }] },
      { match: 'Continue the work item', steps: onContinue },
      { steps: [{ text: 'ok' }] },
    ],
  };
}

const lastPlan = (member: Person, topicId: string): PlanInfo | undefined => member.got('plan.updated').filter((update) => update.plan.topicId === topicId).at(-1)?.plan;
async function planIs(member: Person, topicId: string, fits: (plan: PlanInfo) => boolean, what: string): Promise<PlanInfo> {
  await waitFor(() => { const plan = lastPlan(member, topicId); return plan !== undefined && fits(plan); }, { timeoutMs: 30_000, what: `${what}, as ${member.name} is told` });
  return lastPlan(member, topicId) as PlanInfo;
}
const itemOf = (plan: PlanInfo | null | undefined, id: string) => plan?.items.find((item) => item.id === id);
const sessionsOf = async (member: Person, topicId: string): Promise<AgentSession[]> => (await member.conn.request('session.list', { topicId })).sessions as AgentSession[];

/** The topic up to the moment the daemon stops. */
async function untilTheMiddle(flow: Flow): Promise<{ topicId: string; discussionId: string; cartId: string; receiptId: string }> {
  const { ian, mei, amy, leo } = flow;
  const created = await mei.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We want the checkout on one page.' });
  const topicId = created.topic.id;
  const discussionId = created.session.id;
  for (const member of [ian, mei, amy, leo]) await member.watch(discussionId);
  await turnsFinished(leo, discussionId, 1);
  await statusIs(leo, discussionId, 'idle');
  await mei.conn.request('plan.generate', { topicId });
  await turnsFinished(leo, discussionId, 2);
  await planIs(leo, topicId, (plan) => plan.items.length === 3, 'the plan');
  // Nobody is assigned: everyone watches.
  await mei.conn.request('plan.mode.set', { topicId, mode: 'everyone' });
  const { preflight } = await mei.conn.request('plan.preflight', { topicId });
  expect(preflight).toMatchObject({ blockers: [], youDecide: 3, startsNow: ['cart-api', 'receipt-email'] });
  const started = (await mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash })).plan;
  const cartId = itemOf(started, 'cart-api')?.sessionId as string;
  const receiptId = itemOf(started, 'receipt-email')?.sessionId as string;
  for (const member of [ian, mei, amy, leo]) for (const id of [cartId, receiptId]) await member.watch(id);
  return { topicId, discussionId, cartId, receiptId };
}

describe('the release composition across a restart of the host\'s smurg and a crashed agent process', { timeout: 480_000 }, () => {
  it('the daemon restarts in the middle of a topic: everything is readable, open cards are withdrawn and asked again, the plan is paused until "Continue all"; a killed process: "Try again" continues the session', async () => {
    // (The folder has Claude Code settings of its own that the host has not looked at: one more thing in his inbox.)
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n', '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] } }) } });
    await flow.claude.setScenario(scenario([PNPM_TEST, ...reportSteps('cart-api', 'Cart API')]));
    const { topicId, discussionId, cartId, receiptId } = await untilTheMiddle(flow);

    // ================================================================================================================
    // The middle: a permission request, a report to review, an armed item, an open question with votes, a suggestion
    // ================================================================================================================
    let { ian, mei, amy, leo } = flow;
    const asked = await permissionAt(leo, (request) => request.sessionId === cartId && request.status === 'open', 'the command of work item 1');
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'receipt-email'), { timeoutMs: 30_000, what: 'the report of work item 3' });
    await mei.conn.request('session.message.send', { sessionId: discussionId, text: 'Please ask us how people pay.' });
    const question = await questionAt(leo, (candidate) => candidate.sessionId === discussionId && candidate.status === 'open', 'the question');
    await ian.conn.request('question.vote', { questionId: question.id, part: 0, options: [0] });
    await amy.conn.request('question.vote', { questionId: question.id, part: 0, options: [1] });
    const { commentId } = await amy.conn.request('question.comment', { questionId: question.id, text: 'Invoices matter to schools.' });
    const { suggestion } = await amy.conn.request('suggest.create', { sessionId: discussionId, text: 'Please also think of gift cards.' });
    // While the question is open the Start dialog says so.
    expect((await mei.conn.request('plan.preflight', { topicId })).preflight).toMatchObject({ openQuestion: true, projectSettings: 'ignored', alreadyStarted: ['cart-api', 'checkout-page', 'receipt-email'] });
    // Mei asks the host to merge what work item 3 changed, before anyone reviewed its report.
    const receiptWt = itemOf((await leo.conn.request('plan.get', { topicId })).plan, 'receipt-email')?.worktreeId as string;
    const receiptDraft = (await leo.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report.changes?.requestId as string;
    const requested = (await mei.conn.request('worktree.merge.request', { worktreeId: receiptWt, message: 'The receipt email' })).request;
    // (the report's draft itself became the request: the same id)
    expect(requested).toMatchObject({ id: receiptDraft, status: 'pending', requestedBy: { userId: MEI }, itemId: 'receipt-email' });
    // Nobody is assigned: the request is for Ian and Mei, the report for everyone who may review, the question for
    // Mei (she pressed Start and opened the discussion), the others are asked to vote. The host has two things more.
    const before = {
      mei: (await inboxItem(mei, (item) => item.kind === 'suggestion', 'the suggestion').then(() => mei.inbox())).map((item) => item.key).sort(),
      ian: (await inboxItem(ian, (item) => item.kind === 'merge', 'the merge request').then(() => ian.inbox())).map((item) => item.key).sort(),
      amy: (await amy.inbox()).map((item) => item.key).sort(),
    };
    const reportKey = `report:${topicId}.receipt-email`;
    const suggestionKey = (await mei.inbox()).find((item) => item.kind === 'suggestion')?.key as string;
    // (one per root that has a session and whose settings wait for him: the main folder and the two item worktrees,
    // which hold the same file; ONE decision of his settles all three)
    const settingsKeys = (await ian.inbox()).filter((item) => item.subject === 'project-settings').map((item) => item.key);
    expect(settingsKeys).toHaveLength(3);
    const mergeKey = `merge:${receiptDraft}`;
    expect(before.mei).toEqual([`permission:${asked.id}`, `question:${question.id}`, reportKey, suggestionKey].sort());
    expect(before.ian).toEqual([`permission:${asked.id}`, reportKey, suggestionKey, ...settingsKeys, mergeKey].sort());
    expect(before.amy).toEqual([reportKey]);
    // Mei and Ian have looked at all of it.
    mei.conn.notify('inbox.seen', { keys: before.mei });
    ian.conn.notify('inbox.seen', { keys: before.ian });
    for (const member of [mei, ian]) await waitFor(async () => (await member.inbox()).every((item) => !item.unread), { what: `${member.name}'s inbox to be read` });
    const planBefore = (await leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
    expect(planBefore.items.map((item) => `${item.id} ${item.state}${item.armed ? ' armed' : ''}`)).toEqual(['cart-api running', 'checkout-page waiting armed', 'receipt-email done']);
    // (the plan lists who its WORK ITEMS wait for: the discussion's question is not one of them)
    expect(planBefore.waitingFor.map((entry) => `${entry.user.displayName} q${entry.questions} p${entry.permissions} r${entry.reports}`).sort()).toEqual(['Amy q0 p0 r1', 'Ian q0 p1 r1', 'Mei q0 p1 r1']);
    const pagesBefore = new Map<string, ConversationEvent[]>();
    for (const id of [discussionId, cartId, receiptId]) pagesBefore.set(id, (await leo.conn.request('session.watch', { sessionId: id })).events);
    // What the host's own `smurg` command says on that computer, through the control socket.
    const status = await flow.smurg(['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`Workspace ${flow.d.workspaceId}\n`);
    expect(status.stdout).toContain('  Connections: 4, members online: 4\n');
    expect(status.stdout).toContain('  Claude Code: 2.1.288 (verified with this smurg), logged in\n');
    expect(status.stdout).toContain('  Agent sessions: 0 running, 2 waiting for a person, 0 stopped without a report or failed, 1 idle\n');
    expect(status.stdout).toContain('  Topics: 1 (0 paused)\n');
    expect(status.stdout).toContain('  Claude Code project settings: not confirmed');
    // `smurg attach` lists the conversations and says where they open; one cannot be attached like a terminal.
    const list = await flow.smurg(['attach']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`\\n${discussionId}\\s+waiting for an answer\\s+Checkout\\s+Discussion\\n`));
    expect(list.stdout).toMatch(new RegExp(`\\n${cartId}\\s+waiting for permission\\s+Checkout\\s+1 \u00b7 Cart API\\n`));
    expect(list.stdout).toMatch(new RegExp(`\\n${receiptId}\\s+done\\s+Checkout\\s+3 \u00b7 Receipt email\\n`));
    expect(list.stdout).toContain(`\nAgent conversations open in the browser: https://relay.smurg.test/w/${flow.d.workspaceId}\n`);
    const launchesBefore = await launches(flow);
    expect(launchesBefore).toBe(3);
    expect((await flow.processes()).length).toBeGreaterThanOrEqual(3);

    // ================================================================================================================
    // The host's smurg stops and starts again
    // ================================================================================================================
    await flow.stop();
    // A stopped smurg writes nothing more: not into its state (sessions, cards, topics, reports, the inbox, the audit
    // and activity logs, transcripts), not into the shared folder (a late write would land in a folder that the next
    // start, or an uninstall, already took over).
    const left = { state: await onDisk(flow.stateDir), folder: await onDisk(flow.root) };
    expect(left.state.some((line) => line.includes('topics.json'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await onDisk(flow.stateDir)).toEqual(left.state);
    expect(await onDisk(flow.root)).toEqual(left.folder);
    await flow.restart();
    ({ ian, mei, amy, leo } = flow);
    // No process survived, and none was started by the start.
    expect(await flow.processes()).toEqual([]);
    expect(await launches(flow)).toBe(launchesBefore);

    // ---- everything is readable: the topic, the plan (paused), the sessions, the conversations
    const topics = (await leo.conn.request('topic.list', {})).topics;
    expect(topics).toMatchObject([{ id: topicId, phase: 'executing', discussion: 'live', plan: { paused: true, items: 3, started: 3 } }]);
    const planAfter = (await leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
    // The session that was in the middle of a turn is stalled by the restart, what was armed still waits, what was
    // done is done; nothing holds a process.
    expect(planAfter.paused).toBe(true);
    expect(planAfter.items.map((item) => `${item.id} ${item.state}${item.stalledBy === undefined ? '' : ` by ${item.stalledBy}`}${item.armed ? ' armed' : ''}`)).toEqual(['cart-api stalled by restart', 'checkout-page waiting armed', 'receipt-email done']);
    expect(planAfter.slots).toMatchObject({ inUse: 0, waitingForPeople: 0 });
    expect(itemOf(planAfter, 'cart-api')).toMatchObject({ sessionId: cartId, attempt: 1 });
    expect((await sessionsOf(leo, topicId)).map((session) => `${session.purpose} ${session.itemId ?? ''} ${session.status}`)).toEqual(['discussion  idle', 'item cart-api stalled', 'item receipt-email done']);
    for (const member of [ian, mei, amy, leo]) for (const id of [discussionId, cartId, receiptId]) await member.watch(id);
    // Every conversation reads as before, with what the stop added: the turn ended, and why.
    for (const id of [discussionId, cartId]) {
      const earlier = pagesBefore.get(id) as ConversationEvent[];
      expect(leo.events(id).slice(0, earlier.length)).toEqual(earlier);
      expect(leo.events(id).slice(earlier.length)).toMatchObject([{ kind: 'turn.finished', outcome: 'interrupted' }, { kind: 'delivery' }, { kind: 'line', text: { id: 'conversation.interrupted.restart' } }]);
    }
    expect(leo.events(receiptId)).toEqual(pagesBefore.get(receiptId));
    expect((await leo.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report).toMatchObject({ version: 1, state: 'to-review', outcome: 'complete' });

    expect((await flow.smurg(['status'])).stdout).toContain('  Agent sessions: 0 running, 0 waiting for a person, 1 stopped without a report or failed, 2 idle\n  Topics: 1 (1 paused)\n');

    // ---- the cards that were open are withdrawn, with everything people had said on them still readable
    const discussionPage = await leo.conn.request('session.watch', { sessionId: discussionId });
    expect(discussionPage.questions).toMatchObject([{ id: question.id, status: 'withdrawn', withdrawn: { reason: 'restarted' }, votes: [{ userId: IAN, options: [0] }, { userId: AMY, options: [1] }], comments: [{ id: commentId, text: 'Invoices matter to schools.' }] }]);
    expect(discussionPage.suggestions).toMatchObject([{ id: suggestion.id, status: 'pending', text: 'Please also think of gift cards.' }]);
    expect((await leo.conn.request('session.watch', { sessionId: cartId })).permissions).toMatchObject([{ id: asked.id, status: 'withdrawn', withdrawn: { reason: 'restarted' }, command: 'pnpm test' }]);
    expect(await refusal(mei.conn.request('permission.decide', { requestId: asked.id, decision: 'allow' }))).toMatchObject({ code: 'conflict', reason: 'settled', detail: { status: 'withdrawn' } });
    expect(await refusal(mei.conn.request('question.submit', { questionId: question.id, answers: [{ options: [0] }] }))).toMatchObject({ code: 'conflict', reason: 'settled' });

    // ---- the inbox: what was withdrawn is gone; a report and a suggestion keep the mark of who had read them; the
    // pause is one new item per topic for the host and every member with agent access
    const paused = await inboxItem(mei, (item) => item.kind === 'attention' && item.subject === 'plan-paused', 'the paused plan');
    expect(paused).toMatchObject({ unread: true, waiting: true, topicId, count: 2, target: { kind: 'plan', topicId }, excerpt: 'Checkout' });
    const meiInbox = await mei.inbox();
    expect(meiInbox.filter((item) => item.kind === 'question' || item.kind === 'permission' || item.kind === 'vote')).toEqual([]);
    expect(meiInbox.find((item) => item.key === reportKey)).toMatchObject({ unread: false });
    expect(meiInbox.find((item) => item.key === suggestionKey)).toMatchObject({ unread: false });
    // (Mei pressed Start: the interrupted item is hers to look after as well.)
    expect(meiInbox.find((item) => item.subject === 'item-stalled')).toMatchObject({ itemId: 'cart-api', unread: true });
    // The host's: the same, and a merge request and an attention item keep their marks too (the keys are the same).
    const ianInbox = await ian.inbox();
    expect(ianInbox.map((item) => `${item.kind}${item.subject === undefined ? '' : `:${item.subject}`} ${item.unread ? 'unread' : 'read'}`).sort()).toEqual(['attention:plan-paused unread', 'attention:project-settings read', 'merge read', 'report read', 'suggestion read']);
    // (no session holds a process in a worktree now: the settings item of the main folder is the one that is left)
    expect(ianInbox.find((item) => item.subject === 'project-settings')?.key).toBe('attention:project-settings:main');
    expect(ianInbox.find((item) => item.key === mergeKey)).toMatchObject({ from: { kind: 'user', userId: MEI }, ready: false, conflict: false, itemId: 'receipt-email' });
    expect((await amy.inbox()).map((item) => item.key)).toEqual([reportKey]);
    // While the plan is paused the Start dialog says so.
    expect((await mei.conn.request('plan.preflight', { topicId })).preflight.blockers.map((blocker) => blocker.text.id)).toContain('plan.paused');

    // ================================================================================================================
    // "Continue all": the interrupted session goes on in its own conversation and asks again, with a NEW card
    // ================================================================================================================
    expect(await refusal(amy.conn.request('plan.resume', { topicId }))).toMatchObject({ code: 'forbidden' });
    expect(await launches(flow)).toBe(launchesBefore);
    const resumed = (await mei.conn.request('plan.resume', { topicId })).plan;
    expect(resumed.paused).toBe(false);
    expect(itemOf(resumed, 'cart-api')).toMatchObject({ state: 'running', sessionId: cartId });
    for (const member of [ian, mei]) await inboxWithout(member, (item) => item.subject === 'plan-paused' || item.subject === 'item-stalled', 'the pause');
    const askedAgain = await permissionAt(leo, (request) => request.sessionId === cartId && request.status === 'open', 'the command, asked again');
    expect(askedAgain).toMatchObject({ command: 'pnpm test', alwaysRule: { pattern: 'pnpm test *' } });
    expect(askedAgain.id).not.toBe(asked.id);
    // A new card is unread again, also for Mei who had read the old one.
    expect(await inboxItem(mei, (item) => item.key === `permission:${askedAgain.id}`, 'the request, asked again')).toMatchObject({ unread: true });
    // The same Claude conversation was resumed (not a new one), with smurg's message to go on.
    const cartLaunches = (await flow.claude.echoed()).filter((entry) => entry.kind === 'argv' && entry.session === cartId).map((entry) => entry.value as string[]);
    expect(cartLaunches).toHaveLength(2);
    expect(cartLaunches[0]).toContain('--session-id');
    expect(cartLaunches[1]).toContain('--resume');
    expect(cartLaunches[1]?.[cartLaunches[1].indexOf('--resume') + 1]).toBe(cartLaunches[0]?.[(cartLaunches[0] as string[]).indexOf('--session-id') + 1]);
    expect((await told(flow, cartId)).at(-1)).toMatch(/^\[smurg [a-z0-9]{4}\]\nContinue the work item where you stopped\. Finish with the result report\.$/);
    expect(leo.events(cartId).filter((event) => event.kind === 'line').at(-1)).toMatchObject({ text: { id: 'conversation.continueRequested', params: { name: 'Mei' } } });
    expect((await audited(flow, 'plan.resume')).map((entry) => entry.detail)).toMatchObject([{ topicId, itemIds: ['cart-api'] }]);
    // Who is responsible is the SESSION'S fact once an item has one, whichever side it is changed from: the plan
    // follows the session, and the session follows the plan.
    expect((await mei.conn.request('session.responsible.set', { sessionId: cartId, userId: AMY })).session).toMatchObject({ responsible: { userId: AMY } });
    expect(itemOf(await planIs(leo, topicId, (plan) => itemOf(plan, 'cart-api')?.responsible?.userId === AMY, 'the plan to follow the session'), 'cart-api')?.responsible).toEqual({ userId: AMY, displayName: 'Amy', source: 'chosen' });
    // (Amy cannot allow: the request stays with Ian and Mei.)
    expect((await amy.inbox()).some((item) => item.key === `permission:${askedAgain.id}`)).toBe(false);
    expect(itemOf((await mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: IAN })).plan, 'cart-api')?.responsible).toMatchObject({ userId: IAN, source: 'chosen' });
    await waitFor(async () => (await sessionsOf(leo, topicId)).find((session) => session.id === cartId)?.responsible?.userId === IAN, { what: 'the session to follow the plan' });
    // Ian is responsible and may allow: now the request is his alone.
    await inboxWithout(mei, (item) => item.key === `permission:${askedAgain.id}`, "the request that is the responsible person's now");
    expect((await inboxItem(ian, (item) => item.key === `permission:${askedAgain.id}`, 'the request of his session')).alsoFor).toBeUndefined();
    await ian.conn.request('permission.decide', { requestId: askedAgain.id, decision: 'allow' });
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'cart-api'), { timeoutMs: 30_000, what: 'the report of work item 1' });
    await planIs(leo, topicId, (plan) => itemOf(plan, 'cart-api')?.state === 'done', 'work item 1 done');
    // Its report is his to review, and nobody else's.
    expect((await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report.reviewers).toEqual([{ userId: IAN, displayName: 'Ian' }]);
    expect(await refusal(amy.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'forbidden', reason: 'not-reviewer' });

    // ---- the discussion's question, asked again after the restart, shows what was voted before
    await mei.conn.request('session.message.send', { sessionId: discussionId, text: 'Please ask us how people pay.' });
    const again = await questionAt(leo, (candidate) => candidate.sessionId === discussionId && candidate.status === 'open', 'the question, asked again');
    expect(again.id).not.toBe(question.id);
    expect(again).toMatchObject({ votes: [], comments: [], decider: { userId: MEI }, previous: { askedAt: question.askedAt, tally: [[1, 1, 0]] } });
    expect(await inboxItem(mei, (item) => item.key === `question:${again.id}`, 'the question, asked again')).toMatchObject({ unread: true });
    await mei.conn.request('question.submit', { questionId: again.id, answers: [{ options: [1] }] });
    await statusIs(leo, discussionId, 'idle');
    // The discussion resumed its conversation too: it was told the three things in order, in one Claude conversation.
    expect((await told(flow, discussionId)).map((message) => message.split('\n')[1]?.slice(0, 30))).toEqual(['We want the checkout on one pa', 'Read specs/checkout/SPEC.md as', 'Please ask us how people pay.', 'Please ask us how people pay.']);
    const discussionLaunches = (await flow.claude.echoed()).filter((entry) => entry.kind === 'argv' && entry.session === discussionId).map((entry) => entry.value as string[]);
    expect(discussionLaunches.map((argv) => (argv.includes('--resume') ? 'resume' : 'new'))).toEqual(['new', 'resume']);

    // ================================================================================================================
    // A crash: the process of a session is killed while it waits for a person. "Try again" continues the session
    // ================================================================================================================
    // Work item 1 is reviewed and merged: work item 2 starts and asks.
    await ian.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
    const cartDraft = (await leo.conn.request('report.get', { topicId, itemId: 'cart-api' })).report.changes?.requestId as string;
    expect((await ian.conn.request('worktree.merge.approve', { requestId: cartDraft })).request).toMatchObject({ status: 'merged' });
    const running = await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.sessionId !== undefined, 'work item 2 started');
    const pageId = itemOf(running, 'checkout-page')?.sessionId as string;
    for (const member of [ian, mei, amy, leo]) await member.watch(pageId);
    const build = await permissionAt(leo, (request) => request.sessionId === pageId && request.status === 'open', 'the command of work item 2');
    await inboxItem(mei, (item) => item.key === `permission:${build.id}`, 'the request of work item 2');
    // (told to go on, it will want its command once more)
    await flow.claude.setScenario(scenario([{ tool: 'Bash', input: { command: 'pnpm build' } }, { text: 'never said' }]));

    expect(await flow.killProcessOf(pageId)).toBe(1);
    await statusIs(leo, pageId, 'failed');
    // The card it waited on is withdrawn; the turn ended with an error; the conversation says the process is gone.
    expect(await permissionAt(leo, (request) => request.id === build.id && request.status === 'withdrawn', 'the withdrawn request')).toMatchObject({ withdrawn: { reason: 'failed' } });
    await inboxWithout(mei, (item) => item.key === `permission:${build.id}`, 'the withdrawn request');
    await waitFor(() => leo.events(pageId).some((event) => event.kind === 'notice' && event.text.id === 'notice.processExited'), { what: 'the notice of the crash' });
    expect(kinds(leo.events(pageId)).slice(-4)).toEqual(['tool.started', 'card:permission', 'turn.finished', 'notice']);
    expect(leo.events(pageId).findLast((event) => event.kind === 'turn.finished')).toMatchObject({ outcome: 'error' });
    expect(leo.events(pageId).at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: { id: 'notice.processExited' }, action: 'retry' });
    // The item is FAILED (not "stopped without a report"), and whoever looks after it is told: nobody is assigned, so
    // the member who pressed Start.
    const failed = await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.state === 'failed', 'the failed item');
    expect(itemOf(failed, 'checkout-page')).toMatchObject({ state: 'failed', sessionId: pageId, attempt: 1 });
    expect(itemOf(failed, 'checkout-page')?.stalledBy).toBeUndefined();
    expect(failed.slots).toMatchObject({ inUse: 0 });
    const failedItem = await inboxItem(mei, (item) => item.kind === 'attention' && item.subject === 'item-failed', 'the failed item');
    expect(failedItem).toMatchObject({ waiting: true, unread: true, topicId, itemId: 'checkout-page', sessionId: pageId, target: { kind: 'session', sessionId: pageId } });
    expect((await ian.inbox()).some((item) => item.subject === 'item-failed')).toBe(false);
    expect((await mei.inbox()).some((item) => item.subject === 'item-stalled')).toBe(false);

    // ---- "Try again" in the session's own column (`session.retry`): for a work item it is the plan's "Try again":
    // the same session, the same attempt, AND smurg tells the agent to go on (it is never left idle and "running")
    const exits = (): number[] => leo.events(pageId).flatMap((event, index) => (event.kind === 'notice' && event.text.id === 'notice.processExited' ? [index] : []));
    const lineIds = (events: readonly ConversationEvent[]): string[] => events.flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));
    for (const member of [amy, leo]) expect(await refusal(member.conn.request('session.retry', { sessionId: pageId }))).toMatchObject({ code: 'forbidden' });
    expect((await mei.conn.request('session.retry', { sessionId: pageId })).session).toMatchObject({ id: pageId, purpose: 'item', itemId: 'checkout-page' });
    // The agent works again: it wants its command once more (a new card), and the plan says so.
    const buildAgain = await permissionAt(leo, (request) => request.sessionId === pageId && request.status === 'open' && request.id !== build.id, 'the command of work item 2, asked again after "Try again"');
    expect(itemOf(await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.state === 'running', 'work item 2 running again'), 'checkout-page')).toMatchObject({ state: 'running', sessionId: pageId, attempt: 1 });
    await inboxWithout(mei, (item) => item.key === failedItem.key, 'the item that goes on');
    const afterFirstKill = leo.events(pageId).slice((exits()[0] ?? 0) + 1);
    expect(lineIds(afterFirstKill)).toEqual(['conversation.retry.resumed', 'conversation.continueRequested']);
    expect(afterFirstKill.find((event) => event.kind === 'smurg')).toMatchObject({ purpose: 'continue-item', by: { userId: MEI } });
    expect((await audited(flow, 'session.retry', 'plan.item.retry')).map((entry) => `${entry.action} ${entry.actor.kind === 'user' ? entry.actor.userId : ''}`)).toEqual([`session.retry ${MEI}`, `plan.item.retry ${MEI}`]);

    // ---- it crashes once more; "Try again" in the plan (`plan.item.retry`) does the same
    await flow.claude.setScenario(scenario(reportSteps('checkout-page', 'Checkout page')));
    expect(await flow.killProcessOf(pageId)).toBe(1);
    await statusIs(leo, pageId, 'failed');
    expect(await permissionAt(leo, (request) => request.id === buildAgain.id && request.status === 'withdrawn', 'the second withdrawn request')).toMatchObject({ withdrawn: { reason: 'failed' } });
    await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.state === 'failed', 'the item failed again');
    await inboxItem(mei, (item) => item.key === failedItem.key, 'the failed item, again');
    expect(await refusal(amy.conn.request('plan.item.retry', { topicId, itemId: 'checkout-page' }))).toMatchObject({ code: 'forbidden' });
    const retried = (await mei.conn.request('plan.item.retry', { topicId, itemId: 'checkout-page' })).plan;
    expect(itemOf(retried, 'checkout-page')).toMatchObject({ state: 'running', sessionId: pageId, attempt: 1 });
    await waitFor(() => leo.got('report.updated').some((update) => update.itemId === 'checkout-page'), { timeoutMs: 30_000, what: 'the report of work item 2' });
    await planIs(leo, topicId, (plan) => itemOf(plan, 'checkout-page')?.state === 'done', 'work item 2 done');
    await inboxWithout(mei, (item) => item.key === failedItem.key, 'the item that goes on');
    await eventOf(leo, pageId, (event) => event.kind === 'pointer' && event.target === 'report', "the report's card of work item 2");
    expect(exits()).toHaveLength(2);
    const afterKill = leo.events(pageId).slice((exits()[1] ?? 0) + 1);
    expect(lineIds(afterKill)).toEqual(['conversation.retry.resumed', 'conversation.continueRequested']);
    expect(afterKill.find((event) => event.kind === 'smurg')).toMatchObject({ purpose: 'continue-item', by: { userId: MEI } });
    expect(afterKill.at(-1)).toMatchObject({ kind: 'pointer', target: 'report', itemId: 'checkout-page', version: 1 });
    expect((await audited(flow, 'session.retry', 'plan.item.retry')).map((entry) => `${entry.action} ${entry.actor.kind === 'user' ? entry.actor.userId : ''}`)).toEqual([`session.retry ${MEI}`, `plan.item.retry ${MEI}`, `session.retry ${MEI}`, `plan.item.retry ${MEI}`]);
    expect(await statuses(leo, pageId).at(-1)).toBe('done');
    // Nothing a crash left behind runs on: every process is one of a live session.
    const alive = (await sessionsOf(leo, topicId)).filter((session) => session.status !== 'ended').length;
    expect((await flow.processes()).length).toBeLessThanOrEqual(alive);

    // ================================================================================================================
    // The host stops sharing from his terminal: `smurg stop`
    // ================================================================================================================
    const stop = await flow.smurg(['stop']);
    expect(stop.code).toBe(0);
    expect(stop.stdout.endsWith(`Stopped sharing.\n${alive} agent sessions are paused. They continue when you share this folder again.\n`)).toBe(true);
    expect(flow.d.daemon.status().stopped).toBe(true);
    await waitFor(async () => (await flow.processes()).length === 0, { timeoutMs: 20_000, what: 'every agent process to be gone after the stop' });
  });
});
