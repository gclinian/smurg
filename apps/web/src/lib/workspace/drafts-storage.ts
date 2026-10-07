// What this browser keeps of a workspace's unsent composer texts (features/conversation/drafts.ts writes it), and the
// deletion for every place where a person's access to a workspace ends. A draft can quote project code, so it is not a
// convenience like a pane's width: it must not stay in the browser of someone who was removed, whose device was
// revoked, who left, or who logged out (review R4-08).
//
//   - removed / device revoked / the browser is another account's: lib/workspace/session.ts watches the connection of
//     EVERY session, whatever page shows it (forgetDrafts);
//   - "Leave": the same file (forgetDrafts);
//   - "Log out": app/pages/LandingPage.tsx, once the logout has succeeded (forgetAllDrafts: every workspace of this
//     browser, on the list of recent ones or not);
//   - a workspace taken off the list of recent ones: app/pages/LandingPage.tsx (forgetDrafts).
//
// DELETED STAYS DELETED. Another tab that still shows the workspace holds the drafts in its memory and writes its
// whole map at the next keystroke. So every deletion also changes ONE mark in the storage (`smurg.drafts-forgotten`,
// a value that says nothing: no workspace, no time anyone could use), and a writer looks at the mark before it
// writes: when it changed and the writer's own entry is no longer what it wrote last, its drafts were deleted and it
// writes nothing from then on (features/conversation/drafts.ts).
import type { ConnectionState } from '../connection/types.ts';
import { browserLocalStorage, type PreferenceStorage } from '../preferences.ts';

const PREFIX = 'smurg.drafts.';
/** Not under PREFIX: the mark is not a workspace's drafts. */
const FORGOTTEN_MARK = 'smurg.drafts-forgotten';

export const draftsStorageKey = (workspaceId: string): string => `${PREFIX}${workspaceId}`;

/** The mark as it is now ('' while nothing was ever deleted, or without a storage). */
export function forgottenMark(storage: PreferenceStorage | null): string {
  try {
    return storage?.getItem(FORGOTTEN_MARK) ?? '';
  } catch {
    return '';
  }
}

/** A new value of the mark: different from every earlier one in this browser. */
function markForgotten(storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(FORGOTTEN_MARK, `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`);
}

/** Deletes what this browser kept of one workspace's unsent texts. */
export function forgetDrafts(workspaceId: string, storage: PreferenceStorage | null = browserLocalStorage()): void {
  try {
    if (storage === null) return;
    storage.removeItem(draftsStorageKey(workspaceId));
    markForgotten(storage);
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
export function forgetAllDrafts(storage: Pick<Storage, 'length' | 'key' | 'removeItem' | 'setItem'> | null = browserStorage()): void {
  if (storage === null) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    markForgotten(storage);
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
