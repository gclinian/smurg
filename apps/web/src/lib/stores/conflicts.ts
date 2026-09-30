// Conflicts (SPEC R8): when a process outside the edit tools (Bash `sed`, a formatter, `git checkout`) changed a file
// someone was typing in, the human text is kept and the overlapping agent text lands here. Live through doc.conflict.
import type { ConflictRecord, PayloadInputOf, ResultOf } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, mapWith, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface ConflictsState extends Loadable {
  readonly conflicts: ReadonlyMap<string, ConflictRecord>;
}

export interface ConflictsStore extends ReadableStore<ConflictsState> {
  reload(): Promise<void>;
  /** 'dismiss' keeps the human text; 'apply-agent-version' writes the agent's version (audited). */
  resolve(conflictId: string, action: PayloadInputOf<'doc.conflict.resolve'>['action']): Promise<ConflictRecord>;
  /** The agent's full version as UTF-8 bytes (it is not inline in the record: it can be a whole document). */
  get(conflictId: string): Promise<ResultOf<'doc.conflict.get'>>;
}

export const INITIAL_CONFLICTS_STATE: ConflictsState = Object.freeze({ status: 'idle', error: null, conflicts: new Map() });

/** Newest first. */
export const selectConflictList = (state: ConflictsState): ConflictRecord[] => [...state.conflicts.values()].sort((a, b) => b.createdAt - a.createdAt);
export const selectOpenConflicts = (state: ConflictsState): ConflictRecord[] => selectConflictList(state).filter((c) => c.status === 'open');

export function createConflictsArea(): { store: ConflictsStore; lifecycle: AreaLifecycle } {
  const state = createStore<ConflictsState>(INITIAL_CONFLICTS_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('conflicts store is not bound to a connection');
    return ctx;
  };
  const upsert = (conflict: ConflictRecord): ConflictRecord => {
    state.setState((previous) => ({ ...previous, conflicts: mapWith(previous.conflicts, conflict.id, conflict) }));
    return conflict;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => c.conn.request('doc.conflict.list', {}),
      ({ conflicts }) => state.setState({ ...readyState(), conflicts: mapFrom(conflicts, (x) => x.id) }),
    );
  };

  const store: ConflictsStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async resolve(conflictId, action) {
      return upsert((await context().conn.request('doc.conflict.resolve', { conflictId, action })).conflict);
    },
    async get(conflictId) {
      const result = await context().conn.request('doc.conflict.get', { conflictId });
      upsert(result.conflict);
      return result;
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      return c.conn.on('doc.conflict', ({ conflict }) => upsert(conflict));
    },
    reset() {
      state.setState(INITIAL_CONFLICTS_STATE);
    },
    load,
  };
  return { store, lifecycle };
}
