// Suggestions (DESIGN §3.10, §5.3; ARCHITECTURE §5.6): text an Editor proposes for an agent session, which reaches
// the agent only when a member with agent access accepts it (as it is, or edited). Nothing accepts one automatically.
//
// The store holds every suggestion the daemon told this member about (`suggest.list`, then `suggest.updated`, which
// reaches a session's watchers, the author and the members whose inbox holds it), by id and BY SESSION: a
// conversation column shows a session's suggestions as cards where they were made (the card's entity comes with the
// conversation's page; this store is where its requests are), the host console lists the pending ones across
// sessions.
import { collectPages, type PayloadInputOf, type Suggestion } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';
import { compareIds } from '../format.ts';

export interface SuggestionsState extends Loadable {
  readonly suggestions: ReadonlyMap<string, Suggestion>;
  /** The same suggestions by session, oldest first (the order they were made in). */
  readonly bySession: ReadonlyMap<string, readonly Suggestion[]>;
}

export interface SuggestionsStore extends ReadableStore<SuggestionsState> {
  reload(): Promise<void>;
  /** `suggest.create`: for an agent session (the daemon refuses a terminal, an ended session and an archived topic's). */
  create(input: PayloadInputOf<'suggest.create'>): Promise<Suggestion>;
  /** The author, while it is pending. */
  edit(suggestionId: string, text: string): Promise<Suggestion>;
  /** The author, while it is pending. */
  withdraw(suggestionId: string): Promise<Suggestion>;
  /** `session.drive`. With `text`: accepted after editing (accepted-modified). */
  accept(suggestionId: string, text?: string): Promise<Suggestion>;
  /** `session.drive`. */
  reject(suggestionId: string, reason?: string): Promise<Suggestion>;
}

const NO_SUGGESTIONS: readonly Suggestion[] = Object.freeze([]);

export const INITIAL_SUGGESTIONS_STATE: SuggestionsState = Object.freeze({ status: 'idle', error: null, suggestions: new Map(), bySession: new Map() });

function indexed(suggestions: ReadonlyMap<string, Suggestion>): Pick<SuggestionsState, 'suggestions' | 'bySession'> {
  const bySession = new Map<string, Suggestion[]>();
  for (const suggestion of suggestions.values()) {
    const list = bySession.get(suggestion.sessionId);
    if (list) list.push(suggestion);
    else bySession.set(suggestion.sessionId, [suggestion]);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
  return { suggestions, bySession };
}

// ---- selectors

/** Oldest first (a queue). */
export const selectSuggestionList = (state: SuggestionsState): Suggestion[] => [...state.suggestions.values()].sort((a, b) => a.createdAt - b.createdAt);
/** The suggestions of one session, oldest first; the same array until one of them changes. */
export const selectSuggestionsForSession = (state: SuggestionsState, sessionId: string): readonly Suggestion[] => state.bySession.get(sessionId) ?? NO_SUGGESTIONS;
/** The pending suggestions of one session, oldest first. */
export const selectPendingForSession = (state: SuggestionsState, sessionId: string): Suggestion[] =>
  selectSuggestionsForSession(state, sessionId).filter((suggestion) => suggestion.status === 'pending');
/** How many suggestions wait for a decision, per session. */
export function selectPendingCounts(state: SuggestionsState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [sessionId, list] of state.bySession) {
    const pending = list.filter((suggestion) => suggestion.status === 'pending').length;
    if (pending > 0) counts.set(sessionId, pending);
  }
  return counts;
}

export function createSuggestionsArea(): { store: SuggestionsStore; lifecycle: AreaLifecycle } {
  const state = createStore<SuggestionsState>(INITIAL_SUGGESTIONS_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('suggestions store is not bound to a connection');
    return ctx;
  };
  const upsert = (suggestion: Suggestion): Suggestion => {
    state.setState((previous) => {
      const suggestions = new Map(previous.suggestions);
      suggestions.set(suggestion.id, suggestion);
      return { ...previous, ...indexed(suggestions) };
    });
    return suggestion;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      // `suggest.list` follows the list rule: read every page.
      () =>
        collectPages(async (after) => {
          const page = await c.conn.request('suggest.list', after === undefined ? {} : { after });
          return { items: page.suggestions, hasMore: page.hasMore };
        }, (suggestion: Suggestion) => suggestion.id),
      (suggestions) => state.setState({ ...readyState(), ...indexed(new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]))) }),
    );
  };

  const store: SuggestionsStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async create(input) {
      return upsert((await context().conn.request('suggest.create', input)).suggestion);
    },
    async edit(suggestionId, text) {
      return upsert((await context().conn.request('suggest.edit', { suggestionId, text })).suggestion);
    },
    async withdraw(suggestionId) {
      return upsert((await context().conn.request('suggest.withdraw', { suggestionId })).suggestion);
    },
    async accept(suggestionId, text) {
      return upsert((await context().conn.request('suggest.accept', text === undefined ? { suggestionId } : { suggestionId, text })).suggestion);
    },
    async reject(suggestionId, reason) {
      return upsert((await context().conn.request('suggest.reject', reason === undefined ? { suggestionId } : { suggestionId, reason })).suggestion);
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      return c.conn.on('suggest.updated', ({ suggestion }) => upsert(suggestion));
    },
    reset() {
      state.setState(INITIAL_SUGGESTIONS_STATE);
    },
    load,
  };
  return { store, lifecycle };
}
