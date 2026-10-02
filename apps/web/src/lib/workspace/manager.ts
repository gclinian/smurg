// Keeps exactly ONE session (connection + stores) per workspace for the whole app. The join page opens it with the
// invite; the workspace page and the host console then acquire the same one, so the join's admission, its pinned
// daemon key and its logical channel carry straight into the workspace (no second handshake, no second use of a
// single-use invite).
//
// Sessions are reference counted: a page acquires on mount and releases on unmount; the session is closed a grace
// period after the last release. That also absorbs React StrictMode's mount → unmount → mount in development.
import { isTerminalState } from '@smurg/protocol/client';
import type { ConnectFn, OpenOptions } from '../connection/types.ts';
import type { CreateStoresOptions } from '../stores/index.ts';
import { createWorkspaceSession, type WorkspaceSession } from './session.ts';

export interface WorkspaceHandle {
  readonly session: WorkspaceSession;
  /** Idempotent. */
  release(): void;
}

export interface WorkspaceManager {
  /**
   * The live session of `workspaceId`, created and started if there is none. An existing session is reused unless its
   * connection ended (then: replaced if an invite is given, or if it ended because we closed it; kept otherwise, so
   * the page keeps showing why it ended, e.g. the key-mismatch warning).
   */
  acquire(workspaceId: string, options?: OpenOptions): WorkspaceHandle;
  /** The current session without acquiring it. */
  peek(workspaceId: string): WorkspaceSession | null;
  /** "Leave" through the manager: leave, then forget the session. */
  leave(workspaceId: string): Promise<void>;
  /** Closes every session now (page unload). */
  closeAll(): void;
}

export interface WorkspaceManagerOptions {
  readonly connect: ConnectFn;
  readonly storeOptions?: CreateStoresOptions;
  /** How long a session with no page showing it stays open. */
  readonly releaseGraceMs?: number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

interface Entry {
  session: WorkspaceSession;
  refs: number;
  timer: unknown;
}

/** Long enough for the lazy workspace chunk to load after the join page hands over, short enough to free sockets. */
export const DEFAULT_RELEASE_GRACE_MS = 15_000;

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  const entries = new Map<string, Entry>();
  const grace = options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS;
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const forget = (workspaceId: string, entry: Entry): void => {
    if (entry.timer !== null) cancel(entry.timer);
    entry.timer = null;
    if (entries.get(workspaceId) === entry) entries.delete(workspaceId);
    entry.session.dispose();
  };

  const create = (workspaceId: string, openOptions: OpenOptions): Entry => {
    const connection = options.connect(workspaceId, openOptions);
    const session = createWorkspaceSession(workspaceId, connection, options.storeOptions);
    const entry: Entry = { session, refs: 0, timer: null };
    entries.set(workspaceId, entry);
    return entry;
  };

  const shouldReplace = (entry: Entry, openOptions: OpenOptions): boolean => {
    if (entry.session.disposed) return true;
    const state = entry.session.connection.getState();
    if (!isTerminalState(state)) return false;
    if (openOptions.invite) return true;
    return state.kind === 'closed' && state.reason === 'local';
  };

  return {
    acquire(workspaceId, openOptions = {}) {
      let entry = entries.get(workspaceId);
      if (entry && shouldReplace(entry, openOptions)) {
        forget(workspaceId, entry);
        entry = undefined;
      }
      entry ??= create(workspaceId, openOptions);
      const held = entry;
      if (held.timer !== null) {
        cancel(held.timer);
        held.timer = null;
      }
      held.refs++;
      let released = false;
      return {
        session: held.session,
        release() {
          if (released) return;
          released = true;
          held.refs--;
          if (held.refs > 0 || entries.get(workspaceId) !== held) return;
          held.timer = schedule(() => {
            held.timer = null;
            if (held.refs === 0) forget(workspaceId, held);
          }, grace);
        },
      };
    },
    peek(workspaceId) {
      return entries.get(workspaceId)?.session ?? null;
    },
    async leave(workspaceId) {
      const entry = entries.get(workspaceId);
      if (!entry) return;
      try {
        await entry.session.leave();
      } finally {
        forget(workspaceId, entry);
      }
    },
    closeAll() {
      for (const [workspaceId, entry] of [...entries]) forget(workspaceId, entry);
    },
  };
}
