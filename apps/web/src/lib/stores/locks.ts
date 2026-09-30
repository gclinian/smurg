// File locks (SPEC R8, D14): the human edit lock shared by everyone typing in a file, and the agent lock that makes a
// file read-only in every editor while Claude edits it. The daemon broadcasts every change as lock.state.
import { fileRefKey, type FileRef, type LockInfo } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, mapWith, mapWithout, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface LocksState extends Loadable {
  /** By fileRefKey(lock.file). */
  readonly locks: ReadonlyMap<string, LockInfo>;
}

export interface LocksStore extends ReadableStore<LocksState> {
  reload(): Promise<void>;
  /** 「讓 agent 先改」: leave the human lock of `file` (you must be one of its holders). */
  release(file: FileRef): Promise<void>;
  /** Host only (`lock.force-release`). */
  forceRelease(file: FileRef): Promise<void>;
}

export const INITIAL_LOCKS_STATE: LocksState = Object.freeze({ status: 'idle', error: null, locks: new Map() });

// ---- selectors

export function selectLock(state: LocksState, file: FileRef): LockInfo | undefined {
  return state.locks.get(fileRefKey(file));
}

export const selectAgentLocks = (state: LocksState): LockInfo[] => [...state.locks.values()].filter((lock) => lock.kind === 'agent');

/** Whether `userId` holds (shares) the human lock of this file. */
export function isHumanLockHolder(lock: LockInfo | undefined, userId: string | null): boolean {
  return lock?.kind === 'human' && userId !== null && lock.holders.some((holder) => holder.userId === userId);
}

export function createLocksArea(): { store: LocksStore; lifecycle: AreaLifecycle } {
  const state = createStore<LocksState>(INITIAL_LOCKS_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('locks store is not bound to a connection');
    return ctx;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => c.conn.request('lock.list', {}),
      ({ locks }) => state.setState({ ...readyState(), locks: mapFrom(locks, (lock) => fileRefKey(lock.file)) }),
    );
  };

  const store: LocksStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async release(file) {
      await context().conn.request('lock.release', { file });
    },
    async forceRelease(file) {
      await context().conn.request('lock.forceRelease', { file });
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      return c.conn.on('lock.state', ({ file, lock }) => {
        const key = fileRefKey(file);
        state.setState((previous) => ({ ...previous, locks: lock === null ? mapWithout(previous.locks, key) : mapWith(previous.locks, key, lock) }));
      });
    },
    reset() {
      state.setState(INITIAL_LOCKS_STATE);
    },
    load,
  };
  return { store, lifecycle };
}
