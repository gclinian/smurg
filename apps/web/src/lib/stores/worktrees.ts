// Worktrees and merge requests (SPEC R9, ARCHITECTURE §5.7). A "worktree" is a shared clone at
// .smurg/worktrees/<id> (§11 D-2); its files are a root of their own (RootRef kind 'worktree'). Live through
// worktree.updated, worktree.removed and worktree.merge.updated.
import type { MergeRequest, ResultOf, SessionInfo, WorktreeInfo } from '@smurg/protocol';
import { tStores } from '../../strings/stores.ts';
import { formatDateTime } from '../format.ts';
import { createStore, type ReadableStore } from '../store.ts';
import { plainSessionTitle } from './sessions.ts';
import { loadSnapshot, mapFrom, mapWith, mapWithout, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface WorktreesState extends Loadable {
  readonly worktrees: ReadonlyMap<string, WorktreeInfo>;
  readonly mergeRequests: ReadonlyMap<string, MergeRequest>;
}

export interface WorktreesStore extends ReadableStore<WorktreesState> {
  reload(): Promise<void>;
  /** Owner or host. */
  remove(worktreeId: string): Promise<void>;
  /** Owner (runner or host): commits the worktree and asks the host to merge exactly that commit. */
  requestMerge(worktreeId: string, message?: string): Promise<MergeRequest>;
  /** Owner of the worktree or host: the full diff under review (capped at 1 MiB: see fileDiff). */
  diff(requestId: string): Promise<ResultOf<'worktree.merge.diff'>>;
  /** One file of the request's diff, for files the capped diff truncated (R9 「主人看到完整 diff」). */
  fileDiff(requestId: string, path: string): Promise<ResultOf<'worktree.merge.fileDiff'>>;
  /** Host. Status becomes `merged`, or `conflict` with `conflictFiles`. */
  approve(requestId: string): Promise<MergeRequest>;
  /** Host. The worktree stays as it is (R9.3). */
  reject(requestId: string, reason?: string): Promise<MergeRequest>;
}

export const INITIAL_WORKTREES_STATE: WorktreesState = Object.freeze({
  status: 'idle',
  error: null,
  worktrees: new Map(),
  mergeRequests: new Map(),
});

/** Newest first. */
export const selectWorktreeList = (state: WorktreesState): WorktreeInfo[] => [...state.worktrees.values()].sort((a, b) => b.createdAt - a.createdAt);
export const selectMergeRequestList = (state: WorktreesState): MergeRequest[] =>
  [...state.mergeRequests.values()].sort((a, b) => b.createdAt - a.createdAt);
export const selectPendingMergeRequests = (state: WorktreesState): MergeRequest[] => selectMergeRequestList(state).filter((r) => r.status === 'pending');

export function createWorktreesArea(): { store: WorktreesStore; lifecycle: AreaLifecycle } {
  const state = createStore<WorktreesState>(INITIAL_WORKTREES_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('worktrees store is not bound to a connection');
    return ctx;
  };
  const upsertRequest = (request: MergeRequest): MergeRequest => {
    state.setState((previous) => ({ ...previous, mergeRequests: mapWith(previous.mergeRequests, request.id, request) }));
    return request;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => Promise.all([c.conn.request('worktree.list', {}), c.conn.request('worktree.merge.list', {})]),
      ([{ worktrees }, { requests }]) =>
        state.setState({ ...readyState(), worktrees: mapFrom(worktrees, (w) => w.id), mergeRequests: mapFrom(requests, (r) => r.id) }),
    );
  };

  const store: WorktreesStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async remove(worktreeId) {
      await context().conn.request('worktree.remove', { worktreeId });
    },
    async requestMerge(worktreeId, message) {
      return upsertRequest((await context().conn.request('worktree.merge.request', message === undefined ? { worktreeId } : { worktreeId, message })).request);
    },
    diff(requestId) {
      return context().conn.request('worktree.merge.diff', { requestId });
    },
    fileDiff(requestId, path) {
      return context().conn.request('worktree.merge.fileDiff', { requestId, path });
    },
    async approve(requestId) {
      return upsertRequest((await context().conn.request('worktree.merge.approve', { requestId })).request);
    },
    async reject(requestId, reason) {
      return upsertRequest((await context().conn.request('worktree.merge.reject', reason === undefined ? { requestId } : { requestId, reason })).request);
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offs = [
        c.conn.on('worktree.updated', ({ worktree }) =>
          state.setState((previous) => ({ ...previous, worktrees: mapWith(previous.worktrees, worktree.id, worktree) })),
        ),
        c.conn.on('worktree.removed', ({ worktreeId }) =>
          state.setState((previous) => ({ ...previous, worktrees: mapWithout(previous.worktrees, worktreeId) })),
        ),
        c.conn.on('worktree.merge.updated', ({ request }) => upsertRequest(request)),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    reset() {
      state.setState(INITIAL_WORKTREES_STATE);
    },
    load,
  };
  return { store, lifecycle };
}

/**
 * How a person names a worktree (review WEB-18): whose it is and what it is for — 「王小明的 worktree（加測試）」 — instead
 * of its branch 「smurg/dev-ming/wt_aa17…」, which stays available as a detail. `name` is the session working in it
 * (default: the one recorded on the worktree, when `sessions` knows it); without one, when it was created.
 */
export function worktreeLabel(
  worktree: Pick<WorktreeInfo, 'ownerUserId' | 'ownerName' | 'sessionId' | 'createdAt'>,
  options: { readonly selfUserId: string | null; readonly name?: string; readonly sessions?: ReadonlyMap<string, SessionInfo> },
): string {
  const who = worktree.ownerUserId === options.selfUserId ? tStores('worktree.mine') : tStores('worktree.of', { owner: worktree.ownerName });
  const session = worktree.sessionId === undefined ? undefined : options.sessions?.get(worktree.sessionId);
  const name = options.name ?? (session ? plainSessionTitle(session) : undefined);
  return name !== undefined && name.trim() !== '' ? tStores('worktree.named', { who, name }) : tStores('worktree.since', { who, time: formatDateTime(worktree.createdAt) });
}
