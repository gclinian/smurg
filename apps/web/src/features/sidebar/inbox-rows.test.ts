// @vitest-environment node
// What an inbox row says, per kind (DESIGN §3.8, §5.12 items 1–2; P0-API §3.2), and the one action it may offer.
import { INBOX_KINDS, type HostState, type InboxItem } from '@smurg/protocol';
import { buildAgentSession, buildInboxItem, buildPlan, buildReport, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { describe, expect, it, vi } from 'vitest';
import { applyLocale } from '../../lib/locale.ts';
import { INITIAL_SESSIONS_STATE, type SessionsState } from '../../lib/stores/sessions.ts';
import { INITIAL_TOPICS_STATE, type TopicsState } from '../../lib/stores/topics.ts';
import { describeInboxItem, inboxTarget, isDismissable, plansToLoad, reportNeededFor, reportsToLoad, whereOf, type InboxRowContext } from './inbox-rows.ts';

const NOW = 1_727_000_600_000;
const IAN = { userId: 'dev:host', displayName: 'Ian' };
const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const KEN = { userId: 'dev:ken', displayName: 'Ken' };
const ME = 'dev:amy';

const topic = buildTopic({ id: 'tp_1', name: 'Checkout redesign' });
const cart = buildAgentSession({ id: 'sess_a', purpose: 'item', topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } });
const free = buildAgentSession({ id: 'sess_free', title: 'Fix flaky CI test' });

function context(overrides: Partial<InboxRowContext> = {}): InboxRowContext & { calls: string[] } {
  const calls: string[] = [];
  const sessions: SessionsState = { ...INITIAL_SESSIONS_STATE, status: 'ready', sessions: new Map([[cart.id, cart], [free.id, free]]) };
  const topics: TopicsState = { ...INITIAL_TOPICS_STATE, status: 'ready', topics: new Map([[topic.id, topic]]) };
  const record = (name: string) => vi.fn((...args: unknown[]) => (calls.push(`${name}(${args.join(',')})`), Promise.resolve(undefined as never)));
  return {
    sessions,
    topics,
    selfUserId: ME,
    account: null,
    now: NOW,
    stores: { topics: { continueItem: record('continueItem'), retryItem: record('retryItem'), resume: record('resume'), restartDiscussion: record('restartDiscussion') }, sessions: { retry: record('retry') } },
    calls,
    ...overrides,
  };
}

const row = (item: InboxItem, ctx: InboxRowContext = context()) => describeInboxItem(item, ctx);
const at = (minutesAgo: number): number => NOW - minutesAgo * 60_000;

describe('where an inbox item is', () => {
  it('topic › session; "No topic" for a session without one; the work item when the session is not known', () => {
    expect(whereOf(buildInboxItem('question', { topicId: 'tp_1' }), context())).toBe('Checkout redesign › 1 · Cart API');
    expect(whereOf(buildInboxItem('question', { sessionId: 'sess_free' }), context())).toBe('No topic › Fix flaky CI test');
    expect(whereOf(buildInboxItem('report'), context())).toBe('Checkout redesign › 1 · Cart API');
    expect(whereOf(buildInboxItem('report', { sessionId: undefined }), { ...context(), sessions: INITIAL_SESSIONS_STATE })).toBe('Checkout redesign › 1 · Cart API');
    expect(whereOf(buildInboxItem('mention', { sessionId: undefined, topicId: 'tp_1' }), context())).toBe('Checkout redesign');
    expect(whereOf(buildInboxItem('mention', { sessionId: 'unknown' }), context())).toBe('');
  });
});

describe('where an inbox row leads', () => {
  const report = { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' } as const;
  const changes = { kind: 'changes', requestId: 'mr_1' } as const;
  /** The topics store with the item's result report loaded: `requestId` is the request the report's "Merge…" opens. */
  const withReport = (overrides: Parameters<typeof buildReport>[0] = {}): TopicsState => ({
    ...context().topics,
    reports: new Map([['tp_1/cart-api', buildReport({ changes: { requestId: 'mr_1', files: 1, additions: 1, deletions: 0, byHand: [] }, ...overrides })]]),
  });
  const conflict = buildInboxItem('merge', { ready: false, conflict: true });
  const asked = buildInboxItem('merge', { ready: false, from: { kind: 'user', ...MEI } });

  it('every kind but a merge leads where the item says', () => {
    for (const kind of INBOX_KINDS.filter((one) => one !== 'merge')) {
      const item = buildInboxItem(kind);
      expect(inboxTarget(item, withReport()), kind).toBe(item.target);
      expect(reportNeededFor(item, context().topics), kind).toBeNull();
    }
  });

  it("a merge of a work item leads to the item's result report when the report's \"Merge…\" is about that request: ready after its review, asked for, or in conflict", () => {
    for (const item of [buildInboxItem('merge'), conflict, asked]) expect(inboxTarget(item, withReport())).toEqual(report);
    // Reviewed or not, invalid or not: the report column offers the host that request in every state.
    expect(inboxTarget(conflict, withReport({ state: 'to-review' }))).toEqual(report);
    expect(inboxTarget(buildInboxItem('merge'), withReport({ state: 'invalid' }))).toEqual(report);
  });

  it('a request the report is not about keeps the Changes column, where "Merge" merges what the row asks for', () => {
    // Somebody edited by hand after the report and asked to merge: a NEW request, while the report still names its own.
    const later = buildInboxItem('merge', { key: 'merge:mr_9', target: { kind: 'changes', requestId: 'mr_9' }, ready: false, from: { kind: 'user', ...MEI } });
    expect(inboxTarget(later, withReport())).toEqual({ kind: 'changes', requestId: 'mr_9' });
    // A report without changes (the snapshot was refused) names no request at all.
    const { changes: _none, ...bare } = buildReport();
    expect(inboxTarget(conflict, { ...context().topics, reports: new Map([['tp_1/cart-api', bare]]) })).toEqual(changes);
    // A free session's worktree, an item whose report is not read (or does not exist), an archived topic.
    expect(inboxTarget(buildInboxItem('merge', { ready: false, topicId: undefined, itemId: undefined, item: undefined }), withReport())).toEqual(changes);
    expect(inboxTarget(conflict, context().topics)).toEqual(changes);
    const archived: TopicsState = { ...withReport(), topics: new Map(), archived: new Map([[topic.id, { ...topic, archived: true }]]) };
    expect(inboxTarget(buildInboxItem('merge'), archived)).toEqual(changes);
  });

  it("says which report must be read before a merge row is followed: a work item's, in a topic that is open, not read yet", () => {
    expect(reportNeededFor(conflict, context().topics)).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(reportNeededFor(buildInboxItem('merge'), context().topics)).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(reportNeededFor(conflict, withReport())).toBeNull();
    expect(reportNeededFor(buildInboxItem('merge', { ready: false, topicId: undefined, itemId: undefined, item: undefined }), context().topics)).toBeNull();
    expect(reportNeededFor(conflict, { ...context().topics, topics: new Map() })).toBeNull();
    // An item the host has no report of was asked about once: nothing is left to read, the row leads to its changes.
    const none: TopicsState = { ...context().topics, noReport: new Set(['tp_1/cart-api']) };
    expect(reportNeededFor(conflict, none)).toBeNull();
    expect(inboxTarget(conflict, none)).toEqual(changes);
  });

  it('lists the reports the rows of an inbox need, each once', () => {
    const other = buildInboxItem('merge', { key: 'merge:mr_2', target: { kind: 'changes', requestId: 'mr_2' }, itemId: 'pay', item: { number: 2, title: 'Payment form' } });
    const free = buildInboxItem('merge', { key: 'merge:mr_4', target: { kind: 'changes', requestId: 'mr_4' }, ready: false, topicId: undefined, itemId: undefined, item: undefined });
    expect(reportsToLoad([conflict, asked, other, free, buildInboxItem('question')], context().topics)).toEqual([
      { topicId: 'tp_1', itemId: 'cart-api' },
      { topicId: 'tp_1', itemId: 'pay' },
    ]);
    expect(reportsToLoad([conflict, other], withReport())).toEqual([{ topicId: 'tp_1', itemId: 'pay' }]);
  });
});

describe('inbox rows', () => {
  it('every kind gives a title in both languages', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      applyLocale(locale);
      for (const kind of INBOX_KINDS) {
        const view = row(buildInboxItem(kind));
        expect(view.title, `${locale} ${kind}`).not.toBe('');
        expect(`${view.title} ${view.where}`, `${locale} ${kind}`).not.toMatch(/\{|\}|undefined|sidebar\./);
      }
    }
    applyLocale('en');
  });

  it('a question: its text, where it is, how many voted; all voted with the leading answer; who else may settle it', () => {
    expect(row(buildInboxItem('question', { excerpt: 'Where should the cart total be computed?', voted: 3, eligible: 4 }))).toEqual({
      title: 'Where should the cart total be computed?',
      where: 'Checkout › 1 · Cart API · 3 of 4 voted',
    });
    expect(row(buildInboxItem('question', { voted: 1, eligible: 4, leading: 'On the server' })).where).toBe('Checkout › 1 · Cart API · 1 of 4 voted · leading: “On the server”');
    expect(row(buildInboxItem('question', { voted: 3, eligible: 3, allVoted: true, leading: 'On the server' })).where).toBe('Checkout › 1 · Cart API · All 3 voted · submit “On the server”');
    // A tie: nothing leads.
    expect(row(buildInboxItem('question', { voted: 2, eligible: 2, allVoted: true })).where).toBe('Checkout › 1 · Cart API · All 2 voted');
    expect(row(buildInboxItem('question', { alsoFor: [MEI] })).where).toContain('you or Mei');
    expect(row(buildInboxItem('question', { alsoFor: [MEI, KEN], alsoForMore: 1 })).where).toContain('you or one of 3 others');
    expect(row(buildInboxItem('question', { excerpt: '' })).title).toBe('Question');
  });

  it('an escalated row says who has not answered and for how long; a row of someone who is away says so', () => {
    const escalated = buildInboxItem('question', { at: at(6), waitsFor: IAN, waitsForOffline: false, escalated: true });
    expect(row(escalated).where).toContain('Ian has not answered for 6 min');
    expect(row(buildInboxItem('permission', { at: at(1), waitsFor: MEI, waitsForOffline: true })).where).toContain('Mei is offline');
    // In the copy of the person it waits for, nothing of the kind.
    const mine = buildInboxItem('permission', { waitsFor: { userId: ME, displayName: 'Amy' }, waitsForOffline: false, escalated: true });
    expect(row(mine).where).toBe('Checkout › 1 · Cart API');
  });

  it('a vote: "Vote: …", how many voted and who decides', () => {
    expect(row(buildInboxItem('vote', { excerpt: 'Which filters come first?', voted: 1, eligible: 4, waitsFor: IAN, waitsForOffline: false }))).toEqual({
      title: 'Vote: Which filters come first?',
      where: 'Checkout › 1 · Cart API · 1 of 4 voted · Ian decides',
    });
    expect(row(buildInboxItem('vote', { waitsFor: IAN, waitsForOffline: true })).where).toContain('Ian decides · Ian is offline');
  });

  it('a permission request: the command as it is, in monospace', () => {
    expect(row(buildInboxItem('permission', { excerpt: 'pnpm test --filter cart' }))).toEqual({ title: 'pnpm test --filter cart', mono: true, where: 'Checkout › 1 · Cart API' });
    expect(row(buildInboxItem('permission', { excerpt: '' }))).toEqual({ title: 'Permission request', where: 'Checkout › 1 · Cart API' });
  });

  it('suggestions: one row per author and session', () => {
    expect(row(buildInboxItem('suggestion')).title).toBe('Amy: Use the session store');
    expect(row(buildInboxItem('suggestion', { count: 3 })).title).toBe('Amy: 3 suggestions');
  });

  it('a report: the work item by number and title, its outcome and its checks', () => {
    expect(row(buildInboxItem('report', { outcome: 'partial', checks: { passed: 2, notVerified: 1 } }))).toEqual({
      title: 'Result report: 1 · Cart API',
      where: 'Checkout redesign · Partial · 2 passed · 1 not verified',
    });
    expect(row(buildInboxItem('report', { at: at(12), waitsFor: MEI, waitsForOffline: false, escalated: true })).where).toContain('Mei has not reviewed it for 12 min');
  });

  it('a merge: ready after a review, asked for by someone, in conflict, and what waits for it', () => {
    expect(row(buildInboxItem('merge', { unblocks: [6] }))).toEqual({ title: 'Reviewed, ready to merge: 1 · Cart API', where: 'Checkout redesign · item 6 waits for it' });
    expect(row(buildInboxItem('merge', { unblocks: [5, 6] })).where).toBe('Checkout redesign · items 5 and 6 wait for it');
    expect(row(buildInboxItem('merge', { ready: false, from: { kind: 'user', ...MEI }, conflict: true, excerpt: 'Please merge before lunch' }))).toEqual({
      title: 'Mei asks to merge 1 · Cart API',
      where: 'Checkout redesign · Conflict · Please merge before lunch',
    });
    // A free session's worktree: no item, no topic.
    expect(row(buildInboxItem('merge', { ready: false, from: { kind: 'user', ...MEI }, topicId: undefined, itemId: undefined, item: undefined })).title).toBe('Mei asks to merge changes of a session');
    expect(row(buildInboxItem('merge', { ready: false })).title).toBe('Merge request: 1 · Cart API');
  });

  it('a mention and the result of my own suggestion name who it came from', () => {
    expect(row(buildInboxItem('mention', { from: { kind: 'user', ...KEN }, excerpt: 'A plus a cache would cover it' })).title).toBe('Ken mentioned you: A plus a cache would cover it');
    expect(row(buildInboxItem('mention', { from: { kind: 'agent', sessionId: 's', ownerUserId: 'u', displayName: 'Claude (Cart API)' } })).title).toContain('Claude (Cart API) mentioned you');
    expect(row(buildInboxItem('result')).title).toBe('Host rejected your suggestion: Use the session store');
    expect(row(buildInboxItem('result', { result: 'accepted-edited' })).title).toBe('Host accepted your suggestion with changes: Use the session store');
  });

  it('only a mention and a result can be dismissed', () => {
    expect(INBOX_KINDS.filter((kind) => isDismissable(buildInboxItem(kind)))).toEqual(['mention', 'result']);
  });
});

describe('attention rows: work that stopped and has no card', () => {
  const attention = (subject: NonNullable<InboxItem['subject']>, overrides: Partial<InboxItem> = {}) => buildInboxItem('attention', { subject, key: `attention:${subject}:x`, ...overrides });
  const hostItem = { topicId: undefined, itemId: undefined, item: undefined, sessionId: undefined } as const;

  it('an item that stopped without a report offers "Continue"', async () => {
    const ctx = context();
    const view = row(attention('item-stalled'), ctx);
    expect(view).toMatchObject({ title: '1 · Cart API stopped without a report', where: 'Checkout redesign', action: { id: 'continue', label: 'Continue' } });
    await view.action?.run();
    expect(ctx.calls).toEqual(['continueItem(tp_1,cart-api)']);
  });

  it('says why the item stopped, as its plan\'s badge and its session\'s status bar do; "Continue" either way', () => {
    const stalledBy = (why: 'agent' | 'restart' | 'stopped' | 'error'): InboxRowContext => {
      const ctx = context();
      return { ...ctx, topics: { ...ctx.topics, plans: new Map([['tp_1', buildPlan({ items: [buildWorkItem({ id: 'cart-api', state: 'stalled', stalledBy: why })] })]]) } };
    };
    expect(row(attention('item-stalled'), stalledBy('restart'))).toMatchObject({ title: '1 · Cart API is paused: smurg was restarted', action: { id: 'continue', label: 'Continue' } });
    expect(row(attention('item-stalled'), stalledBy('stopped')).title).toBe('1 · Cart API was stopped by a person, no report');
    expect(row(attention('item-stalled'), stalledBy('error')).title).toBe('1 · Cart API stopped on an error, no report');
    expect(row(attention('item-stalled'), stalledBy('agent')).title).toBe('1 · Cart API stopped without a report');
    // The plan of another item says nothing about this one.
    expect(row(attention('item-stalled', { itemId: 'other' }), stalledBy('restart')).title).toBe('1 · Cart API stopped without a report');
  });

  it('the plans the rows read and the store does not hold: why an item stopped', () => {
    const none = context().topics;
    const loaded: TopicsState = { ...none, plans: new Map([['tp_1', buildPlan()]]) };
    const rows = [attention('item-stalled'), buildInboxItem('merge', { ready: false }), buildInboxItem('merge'), buildInboxItem('question'), attention('item-failed')];
    expect(plansToLoad(rows, none)).toEqual(['tp_1']);
    expect(plansToLoad(rows, loaded)).toEqual([]);
    expect(plansToLoad([attention('item-failed'), buildInboxItem('report'), buildInboxItem('merge'), buildInboxItem('merge', { ready: false })], none)).toEqual([]);
  });

  it('a failed item offers "Try again": its session continues; without a session a new attempt starts', async () => {
    const ctx = context();
    const view = row(attention('item-failed'), ctx);
    expect(view).toMatchObject({ title: "1 · Cart API: the agent's process failed", action: { id: 'try-again', label: 'Try again' } });
    await view.action?.run();
    await row(attention('item-failed', { sessionId: undefined }), ctx).action?.run();
    await row(attention('item-stopped'), ctx).action?.run();
    expect(ctx.calls).toEqual(['retry(sess_i)', 'retryItem(tp_1,cart-api)', 'retryItem(tp_1,cart-api)']);
    expect(row(attention('item-stopped')).title).toBe('1 · Cart API: the session was ended');
  });

  it('an item that did not start only opens the plan (a feature may add "Start again")', () => {
    const view = row(attention('item-not-started', { sessionId: undefined, target: { kind: 'plan', topicId: 'tp_1' } }));
    expect(view).toEqual({ title: '1 · Cart API did not start', where: 'Checkout redesign' });
  });

  it('a paused plan says how many items wait and offers "Continue all"', async () => {
    const ctx = context();
    const view = row(attention('plan-paused', { ...hostItem, topicId: 'tp_1', count: 4, excerpt: 'Checkout redesign', target: { kind: 'plan', topicId: 'tp_1' } }), ctx);
    expect(view).toMatchObject({ title: 'smurg was restarted: 4 items are paused', where: 'Checkout redesign', action: { id: 'continue-all', label: 'Continue all' } });
    await view.action?.run();
    expect(ctx.calls).toEqual(['resume(tp_1)']);
    expect(row(attention('plan-paused', { ...hostItem, topicId: 'tp_1', count: 1, target: { kind: 'plan', topicId: 'tp_1' } })).title).toBe('smurg was restarted: 1 item is paused');
    expect(row(attention('plan-paused', { ...hostItem, topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' } })).title).toBe('smurg was restarted: the plan is paused');
  });

  it('a lost discussion offers "Restart discussion"', async () => {
    const ctx = context();
    const view = row(attention('discussion-lost', { ...hostItem, topicId: 'tp_1', excerpt: 'Checkout redesign', target: { kind: 'spec', topicId: 'tp_1' } }), ctx);
    expect(view).toMatchObject({ title: 'The discussion of Checkout redesign is closed', where: '', action: { id: 'restart-discussion', label: 'Restart discussion' } });
    await view.action?.run();
    expect(ctx.calls).toEqual(['restartDiscussion(tp_1)']);
  });

  it('the host\'s subjects: the account row reads the account state; the others are the wire catalogue\'s words', () => {
    const consoleTarget = { kind: 'console', section: 'sessions' } as const;
    const account = attention('account', { ...hostItem, count: 4, target: consoleTarget });
    const limit: HostState['account'] = { state: 'usage-limit', sessions: 4 };
    expect(row(account, context({ account: limit }))).toEqual({ title: "The host's Claude account reached a usage limit", where: '4 sessions wait' });
    expect(row(account, context({ account: { state: 'logged-out', sessions: 4 } })).title).toBe("The host's Claude Code is logged out");
    expect(row(account, context({ account: null })).title).toBe("The host's Claude account stops agents");
    expect(row(attention('account', { ...hostItem, count: 1, target: consoleTarget }), context({ account: limit })).where).toBe('1 session waits');
    expect(row(attention('project-settings', { ...hostItem, target: { kind: 'console', section: 'claude-config' } })).title).toBe('Claude Code project settings wait for the host');
    expect(row(attention('host-rules', { ...hostItem, waiting: false, target: { kind: 'console', section: 'host-rules' } })).title).toBe('Your own Claude Code rules apply here');
    expect(row(attention('storage', { ...hostItem, waiting: false, target: consoleTarget })).title).toBe('Conversations use more disk space than the limit');
  });

  it('in Traditional Chinese the same rows are composed from the same fields', () => {
    applyLocale('zh-TW');
    expect(row(attention('item-stalled'))).toMatchObject({ title: '1 · Cart API 沒寫報告就停下了', action: { label: '繼續' } });
    const paused = context();
    const byRestart: InboxRowContext = { ...paused, topics: { ...paused.topics, plans: new Map([['tp_1', buildPlan({ items: [buildWorkItem({ id: 'cart-api', state: 'stalled', stalledBy: 'restart' })] })]]) } };
    expect(row(attention('item-stalled'), byRestart).title).toBe('1 · Cart API 已暫停：smurg 重新啟動過');
    expect(row(buildInboxItem('vote', { excerpt: '先做哪個篩選？', voted: 1, eligible: 3, waitsFor: IAN, waitsForOffline: false })).title).toBe('投票：先做哪個篩選？');
    expect(row(buildInboxItem('question', { sessionId: 'sess_free' })).where).toContain('未分主題 › Fix flaky CI test');
    applyLocale('en');
  });
});
