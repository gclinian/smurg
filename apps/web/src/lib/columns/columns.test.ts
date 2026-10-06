// @vitest-environment node
// What a column shows: its identity, its component kind, and its name from the stores.
import type { SessionInfo } from '@smurg/protocol';
import { buildAgentSession, buildMergeRequest, buildPlan, buildTerminalSession, buildTopic, buildWorkItem, buildWorktree } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { applyLocale } from '../locale.ts';
import { IDLE } from '../stores/base.ts';
import { INITIAL_SESSIONS_STATE, type SessionsState } from '../stores/sessions.ts';
import { INITIAL_TOPICS_STATE, type TopicsState } from '../stores/topics.ts';
import { INITIAL_WORKTREES_STATE, type WorktreesState } from '../stores/worktrees.ts';
import { describeColumn, itemLabel } from './describe.ts';
import { columnBodyProps, columnId, columnKindOf, isColumnRef, parseColumnRef, sameColumn, topicIdOfTarget, type ColumnRef } from './target.ts';

const ready = { status: 'ready', error: null } as const;
const sessions = (...list: SessionInfo[]): SessionsState => ({ ...INITIAL_SESSIONS_STATE, ...ready, sessions: new Map(list.map((s) => [s.id, s])) });
const topics = (list: readonly ReturnType<typeof buildTopic>[], plans: readonly ReturnType<typeof buildPlan>[] = []): TopicsState => ({
  ...INITIAL_TOPICS_STATE,
  ...ready,
  topics: new Map(list.map((t) => [t.id, t])),
  plans: new Map(plans.map((p) => [p.topicId, p])),
});

describe('column targets', () => {
  it('a column is identified by what it shows', () => {
    expect(columnId({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
    expect(columnId({ kind: 'spec', topicId: 't1' })).toBe('spec:t1');
    expect(columnId({ kind: 'plan', topicId: 't1' })).toBe('plan:t1');
    expect(columnId({ kind: 'report', topicId: 't1', itemId: 'cart-api' })).toBe('report:t1:cart-api');
    expect(columnId({ kind: 'changes', requestId: 'mr_1' })).toBe('changes:mr_1');
    expect(sameColumn({ kind: 'plan', topicId: 't1' }, { kind: 'plan', topicId: 't1' })).toBe(true);
    expect(sameColumn({ kind: 'plan', topicId: 't1' }, { kind: 'spec', topicId: 't1' })).toBe(false);
  });

  it('a console section is not a column', () => {
    expect(isColumnRef({ kind: 'console', section: 'audit' })).toBe(false);
    expect(isColumnRef({ kind: 'plan', topicId: 't1' })).toBe(true);
    expect(parseColumnRef({ kind: 'console', section: 'audit' })).toBeNull();
    expect(parseColumnRef({ kind: 'plan', topicId: 't1' })).toEqual({ kind: 'plan', topicId: 't1' });
    expect(parseColumnRef({ kind: 'plan', topicId: 't1', extra: 1 })).toBeNull();
    expect(parseColumnRef('plan:t1')).toBeNull();
  });

  it('a session column is a conversation or a terminal, once the session is known', () => {
    const target: ColumnRef = { kind: 'session', sessionId: 's1' };
    expect(columnKindOf(target, undefined)).toBeNull();
    expect(columnKindOf(target, buildAgentSession())).toBe('conversation');
    expect(columnKindOf(target, buildTerminalSession())).toBe('terminal');
    expect(columnKindOf({ kind: 'report', topicId: 't', itemId: 'i' }, undefined)).toBe('report');
  });

  it('gives each kind its props and knows the topic of a target', () => {
    expect(columnBodyProps('conversation', { kind: 'session', sessionId: 's1' })).toEqual({ sessionId: 's1' });
    expect(columnBodyProps('plan', { kind: 'plan', topicId: 't1' })).toEqual({ topicId: 't1' });
    expect(columnBodyProps('report', { kind: 'report', topicId: 't1', itemId: 'i1' })).toEqual({ topicId: 't1', itemId: 'i1' });
    expect(columnBodyProps('changes', { kind: 'changes', requestId: 'mr_1' })).toEqual({ requestId: 'mr_1' });
    expect(topicIdOfTarget({ kind: 'report', topicId: 't1', itemId: 'i1' })).toBe('t1');
    expect(topicIdOfTarget({ kind: 'session', sessionId: 's1' })).toBeUndefined();
  });
});

describe('the name of a column', () => {
  const topic = buildTopic({ id: 't1', name: 'Checkout redesign' });

  it('a session: its title, its topic, its status glyph or the terminal picture', () => {
    const item = buildAgentSession({ id: 's1', purpose: 'item', topicId: 't1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, status: 'waiting-answer' });
    const described = describeColumn({ kind: 'session', sessionId: 's1' }, { sessions: sessions(item), topics: topics([topic]) });
    expect(described).toMatchObject({ title: '1 · Cart API', topicName: 'Checkout redesign', topicId: 't1', kind: 'conversation', gone: false, discussion: false, picture: { kind: 'status', status: 'question' } });

    const terminal = buildTerminalSession({ id: 's2', openedBy: { userId: 'u', displayName: 'Ian' } });
    expect(describeColumn({ kind: 'session', sessionId: 's2' }, { sessions: sessions(terminal), topics: topics([]) })).toMatchObject({ title: 'Terminal (Ian)', kind: 'terminal', picture: { kind: 'terminal' } });
    expect(describeColumn({ kind: 'session', sessionId: 's2' }, { sessions: sessions(terminal), topics: topics([]) }).topicName).toBeUndefined();
  });

  it('a discussion is marked, unless a person named it; the topic\'s name falls back to the session\'s own copy', () => {
    const discussion = buildAgentSession({ id: 's1', purpose: 'discussion', topicId: 't1', topicName: 'Checkout' });
    const state = { sessions: sessions(discussion), topics: topics([]) };
    expect(describeColumn({ kind: 'session', sessionId: 's1' }, state)).toMatchObject({ title: 'Discussion', topicName: 'Checkout', discussion: true });
    const named = { sessions: sessions({ ...discussion, title: 'Kick-off' }), topics: topics([topic]) };
    expect(describeColumn({ kind: 'session', sessionId: 's1' }, named)).toMatchObject({ title: 'Kick-off', topicName: 'Checkout redesign', discussion: false });
  });

  it('a session the list does not hold: waiting while the list loads, gone once it is loaded', () => {
    const target: ColumnRef = { kind: 'session', sessionId: 'nope' };
    expect(describeColumn(target, { sessions: { ...INITIAL_SESSIONS_STATE, ...IDLE }, topics: topics([]) })).toMatchObject({ kind: null, gone: false, title: 'Session' });
    expect(describeColumn(target, { sessions: sessions(), topics: topics([]) })).toMatchObject({ kind: null, gone: true });
    // A session of an archived topic that was looked up is found.
    const others = { ...sessions(), others: new Map([['old', buildAgentSession({ id: 'old', status: 'ended' })]]) };
    expect(describeColumn({ kind: 'session', sessionId: 'old' }, { sessions: others, topics: topics([]) })).toMatchObject({ gone: false, kind: 'conversation', picture: { kind: 'status', status: 'ended' } });
  });

  it('spec, plan and report are named by what they are and their topic; a report names its work item', () => {
    const plan = buildPlan({ topicId: 't1', items: [buildWorkItem({ id: 'receipt', number: 3, title: 'Receipt email' })] });
    const state = { sessions: sessions(), topics: topics([topic], [plan]) };
    expect(describeColumn({ kind: 'spec', topicId: 't1' }, state)).toMatchObject({ title: 'Spec', topicName: 'Checkout redesign', kind: 'spec', picture: { kind: 'spec' }, gone: false });
    expect(describeColumn({ kind: 'plan', topicId: 't1' }, state)).toMatchObject({ title: 'Plan', kind: 'plan' });
    expect(describeColumn({ kind: 'report', topicId: 't1', itemId: 'receipt' }, state)).toMatchObject({ title: 'Result report: 3 · Receipt email', kind: 'report' });
    // Without the plan the item's own session names it; without either the report is just a report.
    const fromSession = { sessions: sessions(buildAgentSession({ id: 's', purpose: 'item', topicId: 't1', itemId: 'receipt', item: { number: 3, title: 'Receipt email' } })), topics: topics([topic]) };
    expect(describeColumn({ kind: 'report', topicId: 't1', itemId: 'receipt' }, fromSession).title).toBe('Result report: 3 · Receipt email');
    expect(describeColumn({ kind: 'report', topicId: 't1', itemId: 'receipt' }, { sessions: sessions(), topics: topics([topic]) }).title).toBe('Result report');
    // A deleted topic.
    expect(describeColumn({ kind: 'plan', topicId: 'gone' }, state)).toMatchObject({ gone: true });
    expect(describeColumn({ kind: 'plan', topicId: 'gone' }, { sessions: sessions(), topics: INITIAL_TOPICS_STATE }).gone).toBe(false);
  });

  it('changes are named by their branch', () => {
    const worktrees: WorktreesState = { ...INITIAL_WORKTREES_STATE, ...ready, worktrees: new Map([['wt_1', buildWorktree()]]), mergeRequests: new Map([['mr_1', buildMergeRequest()]]) };
    const state = { sessions: sessions(), topics: topics([]), worktrees };
    expect(describeColumn({ kind: 'changes', requestId: 'mr_1' }, state)).toMatchObject({ title: 'Changes: smurg/host/wt_1', kind: 'changes', gone: false });
    expect(describeColumn({ kind: 'changes', requestId: 'mr_x' }, state)).toMatchObject({ title: 'Changes', gone: true });
    expect(describeColumn({ kind: 'changes', requestId: 'mr_x' }, { sessions: sessions(), topics: topics([]) }).gone).toBe(false);
  });

  it('itemLabel and the titles follow the language', () => {
    expect(itemLabel({ number: 3, title: 'Receipt email' })).toBe('3 · Receipt email');
    applyLocale('zh-TW');
    expect(describeColumn({ kind: 'plan', topicId: 't1' }, { sessions: sessions(), topics: topics([topic]) }).title).toBe('計畫');
    applyLocale('en');
  });
});
