// The suggestions store (src/lib/stores/suggestions.ts): every suggestion the daemon told this member about, by id
// and by session, kept current by suggest.updated; its requests.
import { describe, expect, it } from 'vitest';
import { buildSuggestion, FAKE_NOW } from '@smurg/protocol/testing';
import {
  createSuggestionsArea,
  selectPendingCounts,
  selectPendingForSession,
  selectSuggestionList,
  selectSuggestionsForSession,
} from '../../lib/stores/suggestions.ts';
import type { StoreContext } from '../../lib/stores/base.ts';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { makeWelcome } from '../../testing/fixtures.ts';
import { createManualScheduler } from '../../testing/services.tsx';

const tick = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

function setup() {
  const conn = new FakeConnection();
  const { store, lifecycle } = createSuggestionsArea();
  const ctx: StoreContext = { conn, role: () => 'host', userId: () => 'dev:host', generation: () => 1, scheduler: createManualScheduler(FAKE_NOW), reportError: () => {} };
  const unbind = lifecycle.bind(ctx);
  conn.start();
  conn.admit(makeWelcome({ role: 'host' }));
  return { conn, store, lifecycle, unbind };
}

describe('suggestions store', () => {
  it('reads every page of the list and keeps the suggestions by session, oldest first', async () => {
    const { conn, store, lifecycle } = setup();
    const loading = lifecycle.load();
    expect(store.getState().status).toBe('loading');
    conn.respond('suggest.list', { suggestions: [buildSuggestion({ id: 'b', sessionId: 's1', createdAt: 20 }), buildSuggestion({ id: 'c', sessionId: 's2', createdAt: 30 })], hasMore: true });
    await tick();
    expect(conn.lastRequest('suggest.list')?.payload).toEqual({ after: 'c' });
    conn.respond('suggest.list', { suggestions: [buildSuggestion({ id: 'a', sessionId: 's1', createdAt: 10, status: 'rejected' })], hasMore: false });
    await loading;
    const state = store.getState();
    expect(state.status).toBe('ready');
    expect(selectSuggestionList(state).map((suggestion) => suggestion.id)).toEqual(['a', 'b', 'c']);
    expect(selectSuggestionsForSession(state, 's1').map((suggestion) => suggestion.id)).toEqual(['a', 'b']);
    expect(selectPendingForSession(state, 's1').map((suggestion) => suggestion.id)).toEqual(['b']);
    expect([...selectPendingCounts(state)]).toEqual([['s1', 1], ['s2', 1]]);
    // A session without suggestions answers the same empty list every time.
    expect(selectSuggestionsForSession(state, 'none')).toBe(selectSuggestionsForSession(state, 'other'));
  });

  it('follows suggest.updated, and puts the answer of each request into the store', async () => {
    const { conn, store, unbind } = setup();
    conn.emit('suggest.updated', { suggestion: buildSuggestion({ id: 'a', sessionId: 's1' }) });
    expect(selectPendingForSession(store.getState(), 's1')).toHaveLength(1);
    const before = selectSuggestionsForSession(store.getState(), 's1');

    const accepting = store.accept('a', 'edited');
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'a', text: 'edited' });
    conn.respond('suggest.accept', { suggestion: buildSuggestion({ id: 'a', sessionId: 's1', status: 'accepted-modified', finalText: 'edited' }) });
    expect((await accepting).status).toBe('accepted-modified');
    expect(selectPendingForSession(store.getState(), 's1')).toEqual([]);
    expect(selectSuggestionsForSession(store.getState(), 's1')).not.toBe(before);

    void store.accept('a');
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'a' });
    void store.reject('a', 'no');
    expect(conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'a', reason: 'no' });
    void store.reject('a');
    expect(conn.lastRequest('suggest.reject')?.payload).toEqual({ suggestionId: 'a' });
    void store.edit('a', 'new text');
    expect(conn.lastRequest('suggest.edit')?.payload).toEqual({ suggestionId: 'a', text: 'new text' });
    void store.withdraw('a');
    expect(conn.lastRequest('suggest.withdraw')?.payload).toEqual({ suggestionId: 'a' });
    const creating = store.create({ sessionId: 's2', text: 'Use the session store' });
    conn.respond('suggest.create', { suggestion: buildSuggestion({ id: 'n', sessionId: 's2' }) });
    await creating;
    expect(selectSuggestionsForSession(store.getState(), 's2').map((suggestion) => suggestion.id)).toEqual(['n']);

    unbind();
    expect(conn.listenerCount('suggest.updated')).toBe(0);
  });

  it('a fresh channel starts from nothing', () => {
    const { conn, store, lifecycle } = setup();
    conn.emit('suggest.updated', { suggestion: buildSuggestion({ id: 'a', sessionId: 's1' }) });
    lifecycle.reset();
    expect(store.getState().suggestions.size).toBe(0);
    expect(store.getState().bySession.size).toBe(0);
    expect(store.getState().status).toBe('idle');
  });
});
