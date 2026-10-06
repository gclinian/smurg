// @vitest-environment node
// The sessions store: the union of agent sessions and terminals, the requests about an agent session, what an
// archived or deleted topic does to the list, and the one name of a session (P0-API §3.1).
import { buildAgentSession, buildTerminalSession, buildTopic } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { applyLocale } from '../locale.ts';
import { answerLoads, setupStores } from '../../testing/stores.ts';
import { isAgentSession, isTerminalSession, plainSessionTitle, selectAgentList, selectSession, selectTerminalList, selectTopicSessions, sessionTitle } from './sessions.ts';

const discussion = buildAgentSession({ id: 's_disc', purpose: 'discussion', topicId: 'tp_1', createdAt: 1 });
const item = buildAgentSession({ id: 's_item', purpose: 'item', topicId: 'tp_1', itemId: 'cart-api', createdAt: 2 });
const free = buildAgentSession({ id: 's_free', createdAt: 3 });
const terminal = buildTerminalSession({ id: 's_term', createdAt: 4 });

async function ready(sessions = [discussion, item, free, terminal]) {
  const ctx = setupStores({ role: 'host' });
  ctx.admit();
  answerLoads(ctx.conn, { 'session.list': { sessions, hasMore: false } });
  await ctx.flush();
  return ctx;
}

describe('sessions store', () => {
  it('keeps agent sessions and terminals in one list and tells them apart', async () => {
    const { stores } = await ready();
    const state = stores.sessions.getState();
    expect(selectAgentList(state).map((s) => s.id)).toEqual(['s_free', 's_item', 's_disc']);
    expect(selectTerminalList(state).map((s) => s.id)).toEqual(['s_term']);
    expect(selectTopicSessions(state, 'tp_1').map((s) => s.id)).toEqual(['s_disc', 's_item']);
    expect(isAgentSession(free)).toBe(true);
    expect(isTerminalSession(terminal)).toBe(true);
    expect(isTerminalSession(free)).toBe(false);
  });

  it('reads every page of session.list', async () => {
    const { conn, stores, admit, flush } = setupStores();
    admit();
    conn.respond('session.list', { sessions: [free], hasMore: true });
    await flush();
    expect(conn.lastRequest('session.list')?.payload).toEqual({ after: 's_free' });
    conn.respond('session.list', { sessions: [terminal], hasMore: false });
    await flush();
    expect(stores.sessions.getState().sessions.size).toBe(2);
  });

  it('the requests about an agent session send what they say and put the answered session into the store', async () => {
    const { conn, stores } = await ready();
    const cases = [
      ['session.retry', () => stores.sessions.retry('s_free'), { sessionId: 's_free' }, { status: 'running' }],
      ['session.restart', () => stores.sessions.restart('s_free'), { sessionId: 's_free' }, { status: 'starting' }],
      ['session.responsible.set', () => stores.sessions.setResponsible('s_free', 'dev:mei'), { sessionId: 's_free', userId: 'dev:mei' }, { responsible: { userId: 'dev:mei', displayName: 'Mei' } }],
      ['session.responsible.set', () => stores.sessions.setResponsible('s_free', null), { sessionId: 's_free', userId: null }, { responsible: null }],
      ['session.mode.set', () => stores.sessions.setMode('s_free', 'ask-commands'), { sessionId: 's_free', mode: 'ask-commands' }, { permissionMode: 'ask-commands' }],
      ['session.rule.remove', () => stores.sessions.removeRule('s_free', 'r1'), { sessionId: 's_free', ruleId: 'r1' }, { ruleCount: 0 }],
      ['session.rename', () => stores.sessions.rename('s_free', 'Fix the flaky test'), { sessionId: 's_free', title: 'Fix the flaky test' }, { title: 'Fix the flaky test' }],
    ] as const;
    for (const [type, run, payload, change] of cases) {
      const done = run();
      expect(conn.lastRequest(type)?.payload, type).toEqual(payload);
      conn.respond(type, { session: buildAgentSession({ id: 's_free', createdAt: 3, ...change }) } as never);
      await done;
      expect(stores.sessions.getState().sessions.get('s_free'), type).toMatchObject(change);
    }
    conn.handle('session.interrupt', () => ({}));
    await stores.sessions.interrupt('s_free');
    expect(conn.lastRequest('session.interrupt')?.payload).toEqual({ sessionId: 's_free' });
    const rules = stores.sessions.rules('s_free');
    conn.respond('session.rules.get', { rules: [], host: { state: 'applied', rules: ['Bash(pnpm test:*)'] } });
    expect((await rules).host).toEqual({ state: 'applied', rules: ['Bash(pnpm test:*)'] });
  });

  it('a deleted topic takes its sessions along; sessions without a topic stay', async () => {
    const { conn, stores } = await ready();
    conn.emit('topic.removed', { topicId: 'tp_1' });
    expect([...stores.sessions.getState().sessions.keys()].sort()).toEqual(['s_free', 's_term']);
    expect(stores.sessions.getState().others.size).toBe(0);
  });

  it('an archived topic\'s sessions leave the list but stay readable; a restored topic brings a fresh list', async () => {
    const { conn, stores, flush } = await ready();
    conn.emit('topic.updated', { topic: buildTopic({ archived: true }) });
    expect([...stores.sessions.getState().sessions.keys()].sort()).toEqual(['s_free', 's_term']);
    // A column that shows one of them still finds it.
    expect(selectSession(stores.sessions.getState(), 's_disc')?.id).toBe('s_disc');
    // Its last state change (ended by the archive) updates the copy, and does not bring it back into the list.
    conn.emit('session.state', { session: { ...discussion, status: 'ended', endReason: 'archived', endedAt: 9 } });
    expect(stores.sessions.getState().sessions.has('s_disc')).toBe(false);
    expect(selectSession(stores.sessions.getState(), 's_disc')?.status).toBe('ended');
    // A session of that topic nobody looked up is not collected.
    conn.emit('session.state', { session: buildAgentSession({ id: 's_other', purpose: 'item', topicId: 'tp_1', itemId: 'x' }) });
    expect(selectSession(stores.sessions.getState(), 's_other')).toBeUndefined();

    const before = conn.requestsOf('session.list').length;
    conn.emit('topic.updated', { topic: buildTopic({ archived: false }) });
    expect(conn.requestsOf('session.list')).toHaveLength(before + 1);
    conn.respond('session.list', { sessions: [discussion, item, free, terminal], hasMore: false });
    await flush();
    expect(stores.sessions.getState().sessions.size).toBe(4);
    // Deleted for good: also the copies go.
    conn.emit('topic.updated', { topic: buildTopic({ archived: true }) });
    conn.emit('topic.removed', { topicId: 'tp_1' });
    expect(selectSession(stores.sessions.getState(), 's_disc')).toBeUndefined();
  });

  it('ofTopic() reads every session of a topic, newest first, and keeps the ones the list does not hold', async () => {
    const { conn, stores } = await ready([free]);
    const reading = stores.sessions.ofTopic('tp_old');
    expect(conn.lastRequest('session.list')?.payload).toEqual({ topicId: 'tp_old' });
    const old1 = buildAgentSession({ id: 'old_1', purpose: 'discussion', topicId: 'tp_old', status: 'ended', createdAt: 1 });
    const old2 = buildAgentSession({ id: 'old_2', purpose: 'item', topicId: 'tp_old', itemId: 'a', status: 'ended', createdAt: 2 });
    conn.respond('session.list', { sessions: [old1, old2], hasMore: false });
    expect((await reading).map((s) => s.id)).toEqual(['old_2', 'old_1']);
    expect([...stores.sessions.getState().others.keys()].sort()).toEqual(['old_1', 'old_2']);
    expect(stores.sessions.getState().sessions.size).toBe(1);
    expect(selectSession(stores.sessions.getState(), 'old_1')?.status).toBe('ended');
  });

  it('a full resync starts from nothing', async () => {
    const { conn, stores, admit } = await ready();
    conn.emit('topic.updated', { topic: buildTopic({ archived: true }) });
    admit({ resumed: false, channelId: 'ch_2' });
    expect(stores.sessions.getState()).toMatchObject({ status: 'loading', sessions: new Map(), others: new Map() });
  });
});

describe('the name of a session', () => {
  it('is the title a person gave it, else the one rule of the wire catalogue', () => {
    expect(sessionTitle(buildTerminalSession({ openedBy: { userId: 'u', displayName: 'Ian' } }))).toBe('Terminal (Ian)');
    expect(sessionTitle(buildAgentSession({ openedBy: { userId: 'u', displayName: 'Ian' } }))).toBe('Claude (Ian)');
    expect(sessionTitle(discussion)).toBe('Discussion');
    expect(sessionTitle(buildAgentSession({ purpose: 'item', topicId: 't', itemId: 'pay', item: { number: 2, title: 'Payment form' } }))).toBe('2 · Payment form');
    expect(sessionTitle(buildAgentSession({ title: '  Fix the flaky test ' }))).toBe('Fix the flaky test');
    expect(sessionTitle(buildAgentSession({ title: '   ', openedBy: { userId: 'u', displayName: 'Mei' } }))).toBe('Claude (Mei)');
  });

  it('follows the viewer\'s language', () => {
    applyLocale('zh-TW');
    expect(sessionTitle(discussion)).not.toBe('Discussion');
    expect(sessionTitle(buildAgentSession({ title: 'Fix the flaky test' }))).toBe('Fix the flaky test');
    applyLocale('en');
  });

  it('plainSessionTitle: the bare kind where the sentence already names who opened it', () => {
    expect(plainSessionTitle(terminal)).toBe('Terminal');
    expect(plainSessionTitle(free)).toBe('Claude');
    expect(plainSessionTitle(buildAgentSession({ title: 'Mine' }))).toBe('Mine');
  });
});
