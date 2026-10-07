// Unsent text of a composer, kept per session in this browser (UX §4: "Unsent text is kept per session in this
// browser"; replacing a column loses nothing). One store per workspace; the composer of a session reads and writes
// its entry, and "Send to agent" from the editor puts a quoted selection into it from outside the column.
//
// A draft can hold project code (a quoted selection), so it is not a convenience like a pane's width: it must not
// stay in the browser of someone whose access to the workspace has ended. Where it is deleted from the storage is
// lib/workspace/drafts-storage.ts (removal, a revoked device, another account's browser, leaving, logging out). Here
// the store of a page that is still showing stops writing at the same moment (draftsOf watches the connection), and
// a store whose drafts were deleted by ANOTHER page of this browser (a second tab that logged out or left) never
// writes them back: it looks at the storage's mark before every write.
import { MESSAGE_TEXT_MAX_CHARS, fileRefSchema, type FileRef } from '@smurg/protocol';
import type { WorkspaceConnection } from '../../lib/connection/types.ts';
import { browserLocalStorage, readJson, type PreferenceStorage } from '../../lib/preferences.ts';
import { createStore, type ReadableStore } from '../../lib/store.ts';
import { accessEnded, draftsStorageKey, forgetDrafts, forgottenMark } from '../../lib/workspace/drafts-storage.ts';

/** The code selection a draft was made from (it travels with a suggestion as its `source`). */
export interface DraftSource {
  readonly file: FileRef;
  readonly startLine: number;
  readonly endLine: number;
}

export interface Draft {
  readonly text: string;
  readonly source: DraftSource | null;
  /** Increments when something outside the composer changed the draft: the composer takes the focus. */
  readonly focusToken: number;
}

export const EMPTY_DRAFT: Draft = Object.freeze({ text: '', source: null, focusToken: 0 });

export interface DraftsStore extends ReadableStore<ReadonlyMap<string, Draft>> {
  get(sessionId: string): Draft;
  setText(sessionId: string, text: string): void;
  setSource(sessionId: string, source: DraftSource | null): void;
  /** Adds `text` under what is there (a quoted selection) and asks the composer to take the focus. */
  append(sessionId: string, text: string, source: DraftSource | null): void;
  clear(sessionId: string): void;
  /** The member's access has ended: every draft goes, from the page and from the storage, and none is kept from now on. */
  forget(): void;
}

/** Drafts of sessions that no longer matter are not kept forever. */
export const DRAFTS_MAX = 50;

function parseSource(value: unknown): DraftSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const { file, startLine, endLine } = value as Record<string, unknown>;
  const parsed = fileRefSchema.safeParse(file);
  if (!parsed.success || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if ((startLine as number) < 1 || (endLine as number) < (startLine as number)) return null;
  return { file: parsed.data, startLine: startLine as number, endLine: endLine as number };
}

function parse(value: unknown): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  if (!Array.isArray(value)) return drafts;
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'object' || entry[1] === null) continue;
    const { text, source } = entry[1] as Record<string, unknown>;
    if (typeof text !== 'string' || text.length > MESSAGE_TEXT_MAX_CHARS) continue;
    const parsedSource = parseSource(source);
    if (text === '' && parsedSource === null) continue;
    drafts.set(entry[0], { text, source: parsedSource, focusToken: 0 });
    if (drafts.size === DRAFTS_MAX) break;
  }
  return drafts;
}

export function createDraftsStore(workspaceId: string | null, storage: PreferenceStorage | null = browserLocalStorage()): DraftsStore {
  let key = workspaceId === null || storage === null ? null : draftsStorageKey(workspaceId);
  const raw = (): string | null => {
    try {
      return key === null ? null : (storage?.getItem(key) ?? null);
    } catch {
      return null;
    }
  };
  const state = createStore<ReadonlyMap<string, Draft>>(key === null ? new Map() : parse(readJson(storage, key)));
  /** The storage's mark of deletions and this workspace's entry, as this store last saw them. */
  let mark = forgottenMark(storage);
  let written = raw();
  const save = (drafts: ReadonlyMap<string, Draft>, held: boolean): void => {
    if (key === null) return;
    // Drafts were deleted somewhere in this browser since this store last looked. If the entry of this workspace is
    // still what this store wrote, the deletion was another workspace's. If not, it was this one's (and somebody may
    // have written there since): what this page holds is the page's only from now on, and nothing is written back.
    const now = forgottenMark(storage);
    if (now !== mark) {
      if (held && raw() !== written) {
        key = null;
        return;
      }
      mark = now;
    }
    // Newest last; the oldest go when there are too many.
    const entries = [...drafts].slice(-DRAFTS_MAX).map(([sessionId, draft]) => [sessionId, { text: draft.text, source: draft.source }] as const);
    try {
      const text = JSON.stringify(entries);
      storage?.setItem(key, text);
      written = text;
    } catch {
      // Quota or blocked storage: a convenience is lost, nothing else.
    }
  };
  const put = (sessionId: string, change: (draft: Draft) => Draft): void => {
    const previous = state.getState();
    const before = previous.get(sessionId) ?? EMPTY_DRAFT;
    const after = change(before);
    if (after === before) return;
    const next = new Map(previous);
    next.delete(sessionId);
    if (after.text !== '' || after.source !== null || after.focusToken !== 0) next.set(sessionId, after);
    state.setState(next);
    // `held`: this store had something before this change that a deletion elsewhere would have been about.
    save(next, previous.size > 0);
  };
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    get: (sessionId) => state.getState().get(sessionId) ?? EMPTY_DRAFT,
    setText(sessionId, text) {
      put(sessionId, (draft) => (draft.text === text ? draft : { ...draft, text }));
    },
    setSource(sessionId, source) {
      put(sessionId, (draft) => (draft.source === source ? draft : { ...draft, source }));
    },
    append(sessionId, text, source) {
      put(sessionId, (draft) => ({
        text: draft.text.trim() === '' ? text : `${draft.text.trimEnd()}\n\n${text}`,
        source: source ?? draft.source,
        focusToken: draft.focusToken + 1,
      }));
    },
    clear(sessionId) {
      put(sessionId, (draft) => (draft.text === '' && draft.source === null ? draft : { text: '', source: null, focusToken: draft.focusToken }));
    },
    forget() {
      if (workspaceId !== null) forgetDrafts(workspaceId, storage);
      // From here on the store is the page's only: what is typed while the page still shows is not written anywhere.
      key = null;
      if (state.getState().size > 0) state.setState(new Map());
    },
  };
}

/** What drafts need of a workspace session: its connection's state. */
export interface DraftsOwner {
  readonly connection: Pick<WorkspaceConnection, 'getState' | 'subscribe'>;
}

const stores = new WeakMap<object, DraftsStore>();

/**
 * The drafts of one workspace session (created on first use; gone with the session object). They are forgotten the
 * moment the session's connection says the member's access has ended.
 */
export function draftsOf(owner: DraftsOwner, workspaceId: string | null): DraftsStore {
  let store = stores.get(owner);
  if (store === undefined) {
    const created = createDraftsStore(workspaceId);
    store = created;
    stores.set(owner, created);
    if (accessEnded(owner.connection.getState())) created.forget();
    else {
      const stop = owner.connection.subscribe((state) => {
        if (!accessEnded(state)) return;
        stop();
        created.forget();
      });
    }
  }
  return store;
}
