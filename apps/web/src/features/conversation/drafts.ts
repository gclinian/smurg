// Unsent text of a composer, kept per session in this browser (UX §4: "Unsent text is kept per session in this
// browser"; replacing a column loses nothing). One store per workspace; the composer of a session reads and writes
// its entry, and "Send to agent" from the editor puts a quoted selection into it from outside the column.
import { MESSAGE_TEXT_MAX_CHARS, fileRefSchema, type FileRef } from '@smurg/protocol';
import { browserLocalStorage, readJson, writeJson, type PreferenceStorage } from '../../lib/preferences.ts';
import { createStore, type ReadableStore } from '../../lib/store.ts';

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
}

/** Drafts of sessions that no longer matter are not kept forever. */
export const DRAFTS_MAX = 50;

const storageKey = (workspaceId: string): string => `smurg.drafts.${workspaceId}`;

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
  const key = workspaceId === null ? null : storageKey(workspaceId);
  const state = createStore<ReadonlyMap<string, Draft>>(key === null ? new Map() : parse(readJson(storage, key)));
  const save = (drafts: ReadonlyMap<string, Draft>): void => {
    if (key === null) return;
    // Newest last; the oldest go when there are too many.
    const entries = [...drafts].slice(-DRAFTS_MAX).map(([sessionId, draft]) => [sessionId, { text: draft.text, source: draft.source }] as const);
    writeJson(storage, key, entries);
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
    save(next);
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
        text: draft.text.trim() === '' ? text : `${draft.text.replace(/\s*$/u, '')}\n\n${text}`,
        source: source ?? draft.source,
        focusToken: draft.focusToken + 1,
      }));
    },
    clear(sessionId) {
      put(sessionId, (draft) => (draft.text === '' && draft.source === null ? draft : { text: '', source: null, focusToken: draft.focusToken }));
    },
  };
}

const stores = new WeakMap<object, DraftsStore>();

/** The drafts of one workspace session (created on first use; gone with the session object). */
export function draftsOf(owner: object, workspaceId: string | null): DraftsStore {
  let store = stores.get(owner);
  if (store === undefined) {
    store = createDraftsStore(workspaceId);
    stores.set(owner, store);
  }
  return store;
}
