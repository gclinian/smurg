// The ended sessions whose tab this person closed (ARCHITECTURE §9 "Closing an ended session's tab"). Closing a tab is
// a matter of one's own panel: nothing is sent to the daemon, every other member keeps the tab, and the session stays
// in session.list until the daemon forgets it (15 minutes after it ended, §7.6). The closed ids are kept in
// localStorage per workspace, so a closed tab does not come back on a reload or a reconnect while the daemon still
// lists the session; an id the daemon no longer lists is forgotten (`retain`), so nothing accumulates.
//
// Like every preference (lib/preferences.ts) this is a convenience, not a source of truth: a missing, corrupt or
// blocked storage means the tab is closed until the page is loaded again.
import { browserLocalStorage, readJson, writeJson, type PreferenceStorage } from '../../lib/preferences.ts';
import { createStore, type ReadableStore } from '../../lib/store.ts';

export const CLOSED_SESSIONS_KEY = 'smurg.agents.closedSessions';
/** Workspaces remembered (the one written longest ago goes first). */
export const CLOSED_MAX_WORKSPACES = 16;
/** Closed ids remembered per workspace (the oldest goes first); the daemon keeps at most 32 ended sessions. */
export const CLOSED_MAX_IDS = 128;
const ID_MAX_LENGTH = 128;

export interface ClosedSessions extends ReadableStore<ReadonlySet<string>> {
  /** The caller checks that the session ended: a running session is never closed (index.tsx). */
  close(sessionId: string): void;
  /** Shows the tab again (the focusSession command names a closed session). */
  reopen(sessionId: string): void;
  /** `listed`: the ended sessions the daemon lists. The closed ids that are not among them are forgotten. */
  retain(listed: { has(sessionId: string): boolean }): void;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_LENGTH;

/** workspace id → closed session ids, in the order they were written; anything malformed is dropped. */
function parseStored(value: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [workspaceId, ids] of Object.entries(value)) {
    if (!isId(workspaceId) || !Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter(isId))].slice(-CLOSED_MAX_IDS);
    if (clean.length > 0) out.set(workspaceId, clean);
  }
  return out;
}

/**
 * The closed tabs of one workspace in this browser. `workspaceId` null (before the first Welcome) or `storage` null
 * (blocked): kept in memory only.
 */
export function createClosedSessions(workspaceId: string | null, storage: PreferenceStorage | null = browserLocalStorage()): ClosedSessions {
  // Another window of this browser may have written since: every change starts from what is stored now.
  const read = (): string[] => (workspaceId === null ? [] : (parseStored(readJson(storage, CLOSED_SESSIONS_KEY)).get(workspaceId) ?? []));
  const write = (ids: readonly string[]): void => {
    if (workspaceId === null) return;
    const stored = parseStored(readJson(storage, CLOSED_SESSIONS_KEY));
    stored.delete(workspaceId);
    if (ids.length > 0) stored.set(workspaceId, ids.slice(-CLOSED_MAX_IDS));
    const entries = [...stored].slice(-CLOSED_MAX_WORKSPACES);
    if (entries.length > 0) {
      writeJson(storage, CLOSED_SESSIONS_KEY, Object.fromEntries(entries));
      return;
    }
    try {
      storage?.removeItem(CLOSED_SESSIONS_KEY);
    } catch {
      // blocked storage: nothing was stored either
    }
  };

  const state = createStore<ReadonlySet<string>>(new Set(read()));
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    close(sessionId) {
      if (!isId(sessionId)) return;
      write([...read().filter((id) => id !== sessionId), sessionId]);
      state.setState((previous) => (previous.has(sessionId) ? previous : new Set([...previous, sessionId])));
    },
    reopen(sessionId) {
      const stored = read();
      if (stored.includes(sessionId)) write(stored.filter((id) => id !== sessionId));
      state.setState((previous) => (previous.has(sessionId) ? new Set([...previous].filter((id) => id !== sessionId)) : previous));
    },
    retain(listed) {
      const gone = new Set([...state.getState()].filter((id) => !listed.has(id)));
      if (gone.size === 0) return;
      write(read().filter((id) => !gone.has(id)));
      state.setState((previous) => new Set([...previous].filter((id) => !gone.has(id))));
    },
  };
}
