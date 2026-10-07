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
// whole map at the next keystroke. So a deletion also changes a mark in the storage, and a writer looks at the marks
// before it writes (features/conversation/drafts.ts): when one changed, the drafts it holds were deleted and it writes
// nothing from then on.
//
//   - one workspace's drafts: the mark of THAT workspace (`smurg.drafts-forgotten.<workspace>`). A deletion of
//     another workspace's drafts is nothing a tab of this one sees: two tabs on one workspace, of which the other
//     typed last, cannot tell "the other tab wrote" from "deleted, and written again" by the entry alone, and one mark
//     for the whole browser made the first of them give up its drafts (review R2-D, fourth round);
//   - every workspace's (a logout): the one mark of the browser (`smurg.drafts-forgotten`), and the marks of single
//     workspaces go with the drafts, so what a logout leaves names no workspace.
//
// A mark's value says nothing: it is random, and holds no time.
import type { ConnectionState } from '../connection/types.ts';
import { browserLocalStorage, type PreferenceStorage } from '../preferences.ts';

const PREFIX = 'smurg.drafts.';
/** Not under PREFIX: a mark is not a workspace's drafts. */
const FORGOTTEN_ALL_MARK = 'smurg.drafts-forgotten';
const FORGOTTEN_MARK_PREFIX = `${FORGOTTEN_ALL_MARK}.`;

export const draftsStorageKey = (workspaceId: string): string => `${PREFIX}${workspaceId}`;

/**
 * The marks a writer of `workspaceId`'s drafts goes by, as they are now: the workspace's own and the browser's, as one
 * value (the bare separator while nothing was ever deleted, or without a storage).
 */
export function forgottenMarks(storage: PreferenceStorage | null, workspaceId: string): string {
  try {
    return `${storage?.getItem(`${FORGOTTEN_MARK_PREFIX}${workspaceId}`) ?? ''}|${storage?.getItem(FORGOTTEN_ALL_MARK) ?? ''}`;
  } catch {
    return '|';
  }
}

/** A new value of a mark: different from every earlier one in this browser. */
const newMark = (): string => `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

/** Deletes what this browser kept of one workspace's unsent texts. */
export function forgetDrafts(workspaceId: string, storage: PreferenceStorage | null = browserLocalStorage()): void {
  try {
    if (storage === null) return;
    storage.removeItem(draftsStorageKey(workspaceId));
    storage.setItem(`${FORGOTTEN_MARK_PREFIX}${workspaceId}`, newMark());
  } catch {
    // A blocked storage kept nothing. A full one took the deletion and not the mark: the writer whose entry is gone
    // sees that (drafts.ts).
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
      if (key !== null && (key.startsWith(PREFIX) || key.startsWith(FORGOTTEN_MARK_PREFIX))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    storage.setItem(FORGOTTEN_ALL_MARK, newMark());
  } catch {
    // As in forgetDrafts.
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
