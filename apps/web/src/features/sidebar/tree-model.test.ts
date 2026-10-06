// @vitest-environment node
// The session list as data (UX §3.2; DESIGN §5.12 items 3–8): a topic's fixed rows, one row per work item, what is
// bold, what is open, the filter, a collapsed topic's count.
import type { SessionInfo, Topic } from '@smurg/protocol';
import { buildAgentSession, buildPlan, buildReportSummary, buildTerminalSession, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { applyLocale } from '../../lib/locale.ts';
import { readColumnsState, type ColumnsState } from '../../lib/stores/columns.ts';
import { INITIAL_SESSIONS_STATE, type SessionsState } from '../../lib/stores/sessions.ts';
import { INITIAL_TOPICS_STATE, type TopicsState } from '../../lib/stores/topics.ts';
import { FREE_GROUP, buildArchivedGroups, buildSessionTree, runningTargets, topicGroupId, type TreeGroup, type TreeInput } from './tree-model.ts';

const IAN = { userId: 'dev:host', displayName: 'Ian' };
const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const SINCE = 1_000;
const plan = { exists: true, valid: true, generating: false, stale: false, mode: 'assigned', paused: false, items: 3, started: 2, reviewed: 1, merged: 0 } as const;

const topic = buildTopic({ id: 't1', name: 'Checkout redesign', phase: 'executing', discussionSessionId: 's_disc', spec: { exists: true, changedAt: 500 }, plan: { ...plan, changedAt: 500 }, createdAt: 10 });
const discussion = buildAgentSession({ id: 's_disc', purpose: 'discussion', topicId: 't1', openedBy: IAN, createdAt: 1, noteworthyAt: 500 });
const cart = buildAgentSession({ id: 's_cart', purpose: 'item', topicId: 't1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, status: 'waiting-answer', responsible: IAN, openedBy: IAN, createdAt: 2, noteworthyAt: 500 });
const pay = buildAgentSession({ id: 's_pay', purpose: 'item', topicId: 't1', itemId: 'pay', item: { number: 2, title: 'Payment form' }, status: 'running', responsible: MEI, openedBy: IAN, createdAt: 3, noteworthyAt: 500 });
const free = buildAgentSession({ id: 's_free', title: 'Fix flaky CI test', status: 'waiting-permission', openedBy: MEI, createdAt: 5, noteworthyAt: 500 });
const terminal = buildTerminalSession({ id: 's_term', openedBy: IAN, createdAt: 4 });

function input(options: { topics?: readonly Topic[]; sessions?: readonly SessionInfo[]; plans?: readonly ReturnType<typeof buildPlan>[]; columns?: Partial<ColumnsState>; selfUserId?: string | null; archived?: readonly Topic[]; others?: readonly SessionInfo[] } = {}): TreeInput {
  const sessions: SessionsState = {
    ...INITIAL_SESSIONS_STATE,
    status: 'ready',
    sessions: new Map((options.sessions ?? [discussion, cart, pay, free, terminal]).map((s) => [s.id, s])),
    others: new Map((options.others ?? []).map((s) => [s.id, s])),
  };
  const topics: TopicsState = {
    ...INITIAL_TOPICS_STATE,
    status: 'ready',
    topics: new Map((options.topics ?? [topic]).map((t) => [t.id, t])),
    plans: new Map((options.plans ?? []).map((p) => [p.topicId, p])),
    archived: options.archived === undefined ? null : new Map(options.archived.map((t) => [t.id, t])),
  };
  return { topics, sessions, columns: { ...readColumnsState(undefined, SINCE), ...options.columns }, selfUserId: options.selfUserId === undefined ? IAN.userId : options.selfUserId };
}

const titles = (group: TreeGroup | undefined): string[] => (group?.rows ?? []).map((row) => (row.meta === undefined ? row.title : `${row.title} (${row.meta})`));
const groupOf = (groups: TreeGroup[], id: string): TreeGroup | undefined => groups.find((group) => group.id === id);

describe('the session list: a topic\'s rows', () => {
  it('are fixed from its creation: Discussion, Spec, Plan', () => {
    const fresh = buildTopic({ id: 't9', name: 'Search filters', discussionSessionId: 's9' });
    const groups = buildSessionTree(input({ topics: [fresh], sessions: [buildAgentSession({ id: 's9', purpose: 'discussion', topicId: 't9' })] }));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'topic:t9', name: 'Search filters', open: true, waiting: 0 });
    expect(titles(groups[0])).toEqual(['Discussion', 'Spec (not written yet)', 'Plan (no plan yet)']);
    const [, spec, planRow] = groups[0]!.rows;
    // An empty step opens its empty state, and is drawn quieter.
    expect(spec).toMatchObject({ kind: 'spec', target: { kind: 'spec', topicId: 't9' }, quiet: true, glyph: null });
    expect(planRow).toMatchObject({ kind: 'plan', target: { kind: 'plan', topicId: 't9' }, quiet: true });
  });

  it('the spec is a "draft" until a plan exists; the plan says how much is reviewed', () => {
    const drafted = buildTopic({ id: 't1', phase: 'spec', spec: { exists: true } });
    expect(titles(buildSessionTree(input({ topics: [drafted], sessions: [] }))[0])).toEqual(['Spec (draft)', 'Plan (no plan yet)']);
    expect(titles(groupOf(buildSessionTree(input()), 'topic:t1'))).toEqual(['Discussion', 'Spec', 'Plan (1 of 3 reviewed)', '1 · Cart API', '2 · Payment form']);
  });

  it('without the plan loaded, one row per work item that has a session, in item order, showing its newest attempt', () => {
    const second = buildAgentSession({ ...cart, id: 's_cart2', attempt: 2, status: 'running', createdAt: 9 });
    const group = groupOf(buildSessionTree(input({ sessions: [pay, cart, second, discussion] })), 'topic:t1');
    expect(titles(group)).toEqual(['Discussion', 'Spec', 'Plan (1 of 3 reviewed)', '1 · Cart API', '2 · Payment form']);
    expect(group?.rows[3]).toMatchObject({ id: 'session:s_cart2', glyph: 'running', target: { kind: 'session', sessionId: 's_cart2' } });
  });

  it('with the plan loaded, one row per item in plan order: a started item is its session, the others show their state and open the plan', () => {
    const items = [
      buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API', state: 'running', sessionId: 's_cart', responsible: { ...IAN, source: 'chosen' }, attempt: 1 }),
      buildWorkItem({ id: 'pay', number: 2, title: 'Payment form', state: 'done', sessionId: 's_pay', attempt: 1, report: buildReportSummary() }),
      buildWorkItem({ id: 'receipt', number: 3, title: 'Receipt email', state: 'waiting', responsible: { ...MEI, source: 'agent' } }),
      buildWorkItem({ id: 'history', number: 4, title: 'Order history page' }),
      // Left the plan and never started: no row.
      buildWorkItem({ id: 'gone', number: 0, title: 'Dropped', inPlan: false }),
    ];
    const group = groupOf(buildSessionTree(input({ plans: [buildPlan({ topicId: 't1', items })] })), 'topic:t1');
    expect(titles(group)).toEqual(['Discussion', 'Spec', 'Plan (1 of 3 reviewed)', '1 · Cart API', '2 · Payment form', '3 · Receipt email', '4 · Order history page']);
    const [, , , first, second, third, fourth] = group!.rows;
    expect(first).toMatchObject({ kind: 'session', glyph: 'question', responsible: IAN, target: { kind: 'session', sessionId: 's_cart' } });
    // The report mark: it waits for review, and opens the report.
    expect(second?.report).toEqual({ target: { kind: 'report', topicId: 't1', itemId: 'pay' }, waiting: true });
    expect(third).toMatchObject({ kind: 'item', glyph: 'blocked', responsible: MEI, target: { kind: 'plan', topicId: 't1' }, quiet: true, open: false, current: false });
    expect(fourth).toMatchObject({ kind: 'item', glyph: 'todo', responsible: null });
  });

  it('a reviewed report is marked as such', () => {
    const items = [buildWorkItem({ state: 'reviewed', sessionId: 's_cart', attempt: 1, report: buildReportSummary({ state: 'reviewed' }) })];
    const group = groupOf(buildSessionTree(input({ plans: [buildPlan({ topicId: 't1', items })] })), 'topic:t1');
    expect(group?.rows[3]?.report?.waiting).toBe(false);
  });

  it('an earlier discussion is a row of its own, ended, after the items', () => {
    const old = buildAgentSession({ id: 's_old', purpose: 'discussion', topicId: 't1', status: 'ended', createdAt: 0 });
    const group = groupOf(buildSessionTree(input({ sessions: [old, discussion, cart] })), 'topic:t1');
    expect(titles(group)).toEqual(['Discussion', 'Spec', 'Plan (1 of 3 reviewed)', '1 · Cart API', 'Earlier discussion']);
    expect(group?.rows.at(-1)).toMatchObject({ id: 'session:s_old', quiet: true, glyph: 'ended' });
  });

  it('a session a person named keeps its name', () => {
    const named = buildAgentSession({ ...cart, title: 'Cart, second try' });
    const items = [buildWorkItem({ state: 'running', sessionId: 's_cart', attempt: 1 })];
    expect(titles(groupOf(buildSessionTree(input({ sessions: [named], plans: [buildPlan({ topicId: 't1', items })] })), 'topic:t1'))).toContain('Cart, second try');
  });
});

describe('the session list: groups', () => {
  it('"No topic" holds the sessions without a topic and the terminals, newest first; a terminal has no glyph and nobody responsible', () => {
    const groups = buildSessionTree(input());
    expect(groups.map((group) => group.id)).toEqual(['topic:t1', FREE_GROUP]);
    const none = groupOf(groups, FREE_GROUP);
    expect(none?.name).toBe('No topic');
    expect(titles(none)).toEqual(['Fix flaky CI test', 'Terminal (Ian)']);
    expect(none?.rows[1]).toMatchObject({ kind: 'terminal', glyph: null });
    expect(none?.rows[1]?.responsible).toBeUndefined();
    expect(none?.rows[0]?.responsible).toBeNull();
    // No group at all without such sessions.
    expect(buildSessionTree(input({ sessions: [discussion] })).map((group) => group.id)).toEqual(['topic:t1']);
  });

  it('topics still worked on come first; a complete topic folds by itself; a person\'s own fold wins', () => {
    const done = buildTopic({ id: 't2', name: 'Dark mode', phase: 'complete', createdAt: 99 });
    const groups = buildSessionTree(input({ topics: [done, topic] }));
    expect(groups.map((group) => [group.id, group.open])).toEqual([['topic:t1', true], ['topic:t2', false], [FREE_GROUP, true]]);
    const folded = buildSessionTree(input({ topics: [done, topic], columns: { groupOpen: { 'topic:t1': false, 'topic:t2': true, [FREE_GROUP]: false } } }));
    expect(folded.map((group) => group.open)).toEqual([false, true, false]);
    expect(topicGroupId('t1')).toBe('topic:t1');
  });

  it('a group knows how many of its rows wait for a person and which status is the most urgent', () => {
    const failed = buildAgentSession({ id: 's_seed', purpose: 'item', topicId: 't1', itemId: 'seed', item: { number: 5, title: 'Seed data script' }, status: 'failed', createdAt: 6 });
    const groups = buildSessionTree(input({ sessions: [discussion, cart, pay, failed, free] }));
    expect(groupOf(groups, 'topic:t1')).toMatchObject({ waiting: 2, urgent: 'failed' });
    expect(groupOf(groups, FREE_GROUP)).toMatchObject({ waiting: 1, urgent: 'permission' });
    expect(groupOf(buildSessionTree(input({ sessions: [discussion, pay] })), 'topic:t1')).toMatchObject({ waiting: 0, urgent: 'running' });
  });
});

describe('the session list: what a row says about this browser', () => {
  it('bold: something happened since this browser showed it, or since it first opened the workspace', () => {
    const later = { ...cart, noteworthyAt: 2_000 };
    const rows = (columns: Partial<ColumnsState> = {}) => groupOf(buildSessionTree(input({ sessions: [discussion, later, pay], columns })), 'topic:t1')!.rows;
    const unread = (columns: Partial<ColumnsState> = {}) => rows(columns).filter((row) => row.unread).map((row) => row.title);
    // Before the first visit (500 < 1000): nothing is new. After it: bold.
    expect(unread()).toEqual(['1 · Cart API']);
    expect(unread({ seen: { session: { s_cart: 2_000 }, spec: {}, plan: {} } })).toEqual([]);
    expect(unread({ seen: { session: { s_cart: 1_500 }, spec: {}, plan: {} } })).toEqual(['1 · Cart API']);
    // A spec or a plan row is bold when the file changed.
    const changed = { ...topic, spec: { exists: true, changedAt: 3_000 }, plan: { ...plan, changedAt: 3_000 } };
    const group = groupOf(buildSessionTree(input({ topics: [changed], sessions: [] })), 'topic:t1');
    expect(group?.rows.filter((row) => row.unread).map((row) => row.title)).toEqual(['Spec', 'Plan']);
    const seen = groupOf(buildSessionTree(input({ topics: [changed], sessions: [], columns: { seen: { session: {}, spec: { t1: 3_000 }, plan: {} } } })), 'topic:t1');
    expect(seen?.rows.filter((row) => row.unread).map((row) => row.title)).toEqual(['Plan']);
  });

  it('open in a column, and the one the focused column shows', () => {
    const columns: Partial<ColumnsState> = {
      columns: [
        { id: 'session:s_cart', target: { kind: 'session', sessionId: 's_cart' }, pinned: false, weight: 1 },
        { id: 'plan:t1', target: { kind: 'plan', topicId: 't1' }, pinned: true, weight: 1 },
      ],
      focusedId: 'plan:t1',
    };
    const rows = groupOf(buildSessionTree(input({ columns })), 'topic:t1')!.rows;
    expect(rows.filter((row) => row.open).map((row) => row.title)).toEqual(['Plan', '1 · Cart API']);
    expect(rows.filter((row) => row.current).map((row) => row.title)).toEqual(['Plan']);
  });
});

describe('the session list: the filter', () => {
  it('"Mine": the sessions I am responsible for, or that I opened when nobody is; steps without a person go', () => {
    const groups = buildSessionTree(input({ columns: { filter: 'mine' } }));
    // Ian: responsible for the cart item; opened the discussion (nobody responsible) and the terminal.
    expect(titles(groupOf(groups, 'topic:t1'))).toEqual(['Discussion', '1 · Cart API']);
    expect(titles(groupOf(groups, FREE_GROUP))).toEqual(['Terminal (Ian)']);
    const mei = buildSessionTree(input({ columns: { filter: 'mine' }, selfUserId: MEI.userId }));
    expect(titles(groupOf(mei, 'topic:t1'))).toEqual(['2 · Payment form']);
    expect(titles(groupOf(mei, FREE_GROUP))).toEqual(['Fix flaky CI test']);
    // An item that has not started counts for the person it is assigned to.
    const items = [buildWorkItem({ id: 'receipt', number: 3, title: 'Receipt email', state: 'waiting', responsible: { ...MEI, source: 'agent' } })];
    const planned = buildSessionTree(input({ sessions: [], plans: [buildPlan({ topicId: 't1', items })], columns: { filter: 'mine' }, selfUserId: MEI.userId }));
    expect(titles(groupOf(planned, 'topic:t1'))).toEqual(['3 · Receipt email']);
  });

  it('"Waiting": the rows a person must act on; a group without any goes; the count of a group does not depend on the filter', () => {
    const groups = buildSessionTree(input({ columns: { filter: 'waiting' } }));
    expect(titles(groupOf(groups, 'topic:t1'))).toEqual(['1 · Cart API']);
    expect(titles(groupOf(groups, FREE_GROUP))).toEqual(['Fix flaky CI test']);
    expect(groupOf(groups, 'topic:t1')?.waiting).toBe(1);
    expect(buildSessionTree(input({ sessions: [discussion, pay, terminal], columns: { filter: 'waiting' } }))).toEqual([]);
    expect(buildSessionTree(input({ columns: { filter: 'mine' }, selfUserId: null }))).toEqual([]);
  });
});

describe('the session list: more', () => {
  it('"watch its running sessions side by side": the item sessions that are going, at most four', () => {
    const ended = buildAgentSession({ id: 's_end', purpose: 'item', topicId: 't1', itemId: 'x', item: { number: 9, title: 'Old' }, status: 'ended' });
    const group = groupOf(buildSessionTree(input({ sessions: [discussion, cart, pay, ended] })), 'topic:t1') as TreeGroup;
    expect(runningTargets(group, 4)).toEqual([{ kind: 'session', sessionId: 's_cart' }, { kind: 'session', sessionId: 's_pay' }]);
    expect(runningTargets(group, 1)).toHaveLength(1);
  });

  it('archived topics are folded groups with their files and, once looked up, their sessions', () => {
    const archived = buildTopic({ id: 't0', name: 'Old checkout', archived: true, spec: { exists: true }, plan });
    const old = buildAgentSession({ id: 's_old', purpose: 'discussion', topicId: 't0', status: 'ended' });
    expect(buildArchivedGroups(input())).toEqual([]);
    const [group] = buildArchivedGroups(input({ archived: [archived], others: [old] }));
    expect(group).toMatchObject({ id: 'topic:t0', name: 'Old checkout', open: false, waiting: 0, urgent: null });
    expect(titles(group)).toEqual(['Spec', 'Plan (1 of 3 reviewed)', 'Discussion']);
    expect(group?.rows.every((row) => row.quiet && !row.unread)).toBe(true);
    expect(buildArchivedGroups(input({ archived: [archived], columns: { groupOpen: { 'topic:t0': true } } }))[0]?.open).toBe(true);
  });

  it('the rows are worded in the viewer\'s language', () => {
    applyLocale('zh-TW');
    const groups = buildSessionTree(input({ topics: [buildTopic({ id: 't9', discussionSessionId: 's9' })], sessions: [buildAgentSession({ id: 's9', purpose: 'discussion', topicId: 't9' }), terminal] }));
    expect(titles(groups[0])).toEqual(['討論', 'spec (還沒寫)', '計畫 (還沒有計畫)']);
    expect(groups[1]?.name).toBe('未分主題');
    applyLocale('en');
  });
});
