// What this browser keeps of a workspace's unsent composer texts (features/conversation/drafts.ts writes it), and the
// deletion for every place where a person's access to a workspace ends. A draft can quote project code, so it is not a
// convenience like a pane's width: it must not stay in the browser of someone who was removed, whose device was
// revoked, who left, or who logged out (review R4-08).
//
//   - removed / device revoked / the browser is another account's: lib/workspace/session.ts watches the connection of
//     EVERY session, whatever page shows it (forgetDrafts);
//   - "Leave": the same file (forgetDrafts);
//   - "Log out": app/pages/LandingPage.tsx (forgetAllDrafts: every workspace of this browser, on the list of recent
//     ones or not);
//   - a workspace taken off the list of recent ones: app/pages/LandingPage.tsx (forgetDrafts).
import type { ConnectionState } from '../connection/types.ts';
import { browserLocalStorage, type PreferenceStorage } from '../preferences.ts';

const PREFIX = 'smurg.drafts.';

export const draftsStorageKey = (workspaceId: string): string => `${PREFIX}${workspaceId}`;

/** Deletes what this browser kept of one workspace's unsent texts. */
export function forgetDrafts(workspaceId: string, storage: PreferenceStorage | null = browserLocalStorage()): void {
  try {
    storage?.removeItem(draftsStorageKey(workspaceId));
  } catch {
    // a blocked storage kept nothing
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Deletes what this browser kept of every workspace's unsent texts. */
export function forgetAllDrafts(storage: Pick<Storage, 'length' | 'key' | 'removeItem'> | null = browserStorage()): void {
  if (storage === null) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // a blocked storage kept nothing
  }
}

/**
 * Whether the connection says that this person's access to the workspace, from this browser, is over: the daemon
 * removed the member or revoked the device (while connected, or as its answer to the next attempt), or the device
 * belongs to another account than the one logged in now. A closed page, a host that is away, an expired login or an
 * outdated client end nothing.
 */
export function accessEnded(state: ConnectionState): boolean {
  if (state.kind === 'closed') return state.reason === 'kicked' || state.reason === 'revoked';
  if (state.kind === 'rejected') return state.reason === 'kicked' || state.reason === 'device-revoked' || state.reason === 'device-other-account';
  return false;
}
