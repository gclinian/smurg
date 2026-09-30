// Suggestions (SPEC R6, ARCHITECTURE §5.6): text proposed for someone else's agent session. Only the session owner can
// accept (optionally edited) or reject; there is no auto-accept anywhere. Live through suggest.updated, which reaches
// the session owner, the author and the host.
import type { PayloadInputOf, SessionInfo, Suggestion } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, mapWith, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface SuggestionsState extends Loadable {
  readonly suggestions: ReadonlyMap<string, Suggestion>;
}

export interface SuggestionsStore extends ReadableStore<SuggestionsState> {
  reload(): Promise<void>;
  /** For someone else's session (the daemon refuses your own). */
  create(input: PayloadInputOf<'suggest.create'>): Promise<Suggestion>;
  /** Author, while pending. */
  edit(suggestionId: string, text: string): Promise<Suggestion>;
  /** Author, while pending. */
  withdraw(suggestionId: string): Promise<Suggestion>;
  /** Session owner. With `text`: accepted after editing (accepted-modified). */
  accept(suggestionId: string, text?: string): Promise<Suggestion>;
  /** Session owner. */
  reject(suggestionId: string, reason?: string): Promise<Suggestion>;
}

export const INITIAL_SUGGESTIONS_STATE: SuggestionsState = Object.freeze({ status: 'idle', error: null, suggestions: new Map() });

// ---- selectors

/** Oldest first (a queue). */
export const selectSuggestionList = (state: SuggestionsState): Suggestion[] => [...state.suggestions.values()].sort((a, b) => a.createdAt - b.createdAt);
export const selectSuggestionsForSession = (state: SuggestionsState, sessionId: string): Suggestion[] =>
  selectSuggestionList(state).filter((s) => s.sessionId === sessionId);
/** Pending suggestions waiting for `userId`'s decision (on sessions they own). */
export function selectPendingForOwner(state: SuggestionsState, sessions: ReadonlyMap<string, SessionInfo>, userId: string): Suggestion[] {
  return selectSuggestionList(state).filter((s) => s.status === 'pending' && sessions.get(s.sessionId)?.ownerUserId === userId);
}
/** What `userId` proposed. */
export const selectAuthoredBy = (state: SuggestionsState, userId: string): Suggestion[] =>
  selectSuggestionList(state).filter((s) => s.author.userId === userId);

export function createSuggestionsArea(): { store: SuggestionsStore; lifecycle: AreaLifecycle } {
  const state = createStore<SuggestionsState>(INITIAL_SUGGESTIONS_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('suggestions store is not bound to a connection');
    return ctx;
  };
  const upsert = (suggestion: Suggestion): Suggestion => {
    state.setState((previous) => ({ ...previous, suggestions: mapWith(previous.suggestions, suggestion.id, suggestion) }));
    return suggestion;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => c.conn.request('suggest.list', {}),
      ({ suggestions }) => state.setState({ ...readyState(), suggestions: mapFrom(suggestions, (s) => s.id) }),
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
