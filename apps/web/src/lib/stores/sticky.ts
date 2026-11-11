// The sticky notes (DESIGN 0.8.0 D2, D7.3): the daemon's index of `notes/*.md` in the main workspace (each note's name
// on disk, the names it links to, its flags; nothing else of its text), the outside sources' state, and the note
// last open in the notes view of this page.
//
//   notes     by foldNoteName(name): Home and home are one note (D1.3). A fold twin the daemon does not read is in
//             `shadowed`, by its own name. Loaded with every page of sticky.list, and kept current by sticky.changed,
//             which carries only what changed. A note that did not change keeps its object, so a memo that holds it
//             holds;
//   wanted    the index is loaded when the notes view is first shown (`want()`), NOT when a channel opens: a member
//             who never opens the notes view never asks for it (D7.3). Once asked for, it is loaded again after every
//             full resync and on a resumed channel;
//   lastOpen  the note the notes view showed last in this page, for the mode link (kept in memory only: a note's
//             name is project text).
import { NOTES_HOME, collectPages, foldNoteName, noteTree, type NoteInfo, type NoteTree, type NoteTreeNode, type SourceState } from '@smurg/protocol';
import { compareText } from '../format.ts';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface StickyState extends Loadable {
  /** The notes view asked for the index: it is loaded, and loaded again after a resync. */
  readonly wanted: boolean;
  /** The notes the index lists, by foldNoteName(name). */
  readonly notes: ReadonlyMap<string, NoteInfo>;
  /** The fold twins the daemon does not read (D1.3), by their name on disk. */
  readonly shadowed: ReadonlyMap<string, NoteInfo>;
  /** `notes/` holds more sticky notes than the index lists (NOTES_MAX). */
  readonly truncated: boolean;
  /** The outside sources the host connected (D6.4). */
  readonly sources: readonly SourceState[];
  /** The note last open in the notes view of this page; undefined: Home, or the view was not shown yet. */
  readonly lastOpen: string | undefined;
}

export interface StickyStore extends ReadableStore<StickyState> {
  /** The notes view is shown: the index is loaded now (once; afterwards sticky.changed keeps it current). */
  want(): Promise<void>;
  reload(): Promise<void>;
  /** sticky.create: a new, empty sticky note. Its NoteInfo (the index's) is in the store before this resolves. */
  create(name: string): Promise<NoteInfo>;
  /** The notes view shows `name` (undefined: Home). */
  setLastOpen(name: string | undefined): void;
}

export const INITIAL_STICKY_STATE: StickyState = Object.freeze({
  status: 'idle',
  error: null,
  wanted: false,
  notes: new Map(),
  shadowed: new Map(),
  truncated: false,
  sources: [],
  lastOpen: undefined,
});

// ---- selectors

/** The note the index lists under `name` (folded: `home` finds Home), with its name on disk. */
export function selectNote(state: StickyState, name: string): NoteInfo | undefined {
  return state.notes.get(foldNoteName(name));
}

/** The tree grown from Home (D2.3), and the notes it does not reach, by name (compareText). */
export interface StickyTree {
  readonly home: NoteTreeNode | null;
  readonly notLinked: readonly NoteInfo[];
}

const trees = new WeakMap<ReadonlyMap<string, NoteInfo>, { readonly shadowed: ReadonlyMap<string, NoteInfo>; readonly tree: StickyTree }>();

/** The tree of the sticky notes, derived from the index (noteTree of @smurg/protocol) and kept while the notes are the same. */
export function selectNoteTree(state: StickyState): StickyTree {
  const known = trees.get(state.notes);
  if (known !== undefined && known.shadowed === state.shadowed) return known.tree;
  const all = [...state.notes.values(), ...state.shadowed.values()];
  const derived: NoteTree = noteTree(all);
  const byName = new Map(all.map((note) => [note.name, note]));
  const notLinked = derived.notLinked
    .map((name) => byName.get(name))
    .filter((note): note is NoteInfo => note !== undefined)
    .sort((a, b) => compareText(a.name, b.name));
  const tree: StickyTree = { home: derived.home, notLinked };
  trees.set(state.notes, { shadowed: state.shadowed, tree });
  return tree;
}

/** Whether the index lists Home. */
export const selectHasHome = (state: StickyState): boolean => state.notes.has(foldNoteName(NOTES_HOME));

// ---- the area

const sameNote = (a: NoteInfo, b: NoteInfo): boolean =>
  a.name === b.name &&
  a.oversized === b.oversized &&
  a.unreadable === b.unreadable &&
  a.shadowed === b.shadowed &&
  a.links.length === b.links.length &&
  a.links.every((link, index) => link === b.links[index]) &&
  (a.builds ?? []).length === (b.builds ?? []).length &&
  (a.builds ?? []).every((build, index) => build === b.builds?.[index]);

/** `note` itself, or the object the store held for it when nothing of it changed. */
function kept(note: NoteInfo, before: NoteInfo | undefined): NoteInfo {
  return before !== undefined && sameNote(before, note) ? before : note;
}

interface Maps {
  notes: Map<string, NoteInfo>;
  shadowed: Map<string, NoteInfo>;
}

/** Takes the note named exactly `name` (its name on disk) out of both maps. */
function remove(maps: Maps, name: string): void {
  const key = foldNoteName(name);
  if (maps.notes.get(key)?.name === name) maps.notes.delete(key);
  maps.shadowed.delete(name);
}

/** Puts `note` where it belongs: the note of its folded name, or a fold twin. */
function put(maps: Maps, note: NoteInfo, before: Maps): void {
  remove(maps, note.name);
  if (note.shadowed === true) maps.shadowed.set(note.name, kept(note, before.shadowed.get(note.name)));
  else {
    const key = foldNoteName(note.name);
    maps.notes.set(key, kept(note, before.notes.get(key)));
  }
}

export function createStickyArea(): { store: StickyStore; lifecycle: AreaLifecycle } {
  const state = createStore<StickyState>(INITIAL_STICKY_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('sticky store is not bound to a connection');
    return ctx;
  };
  /** The load that is on its way (want() called while one runs waits for it). */
  let loading: Promise<void> | null = null;

  const fetchIndex = async (c: StoreContext): Promise<{ notes: NoteInfo[]; truncated: boolean; sources: readonly SourceState[] }> => {
    let truncated = false;
    let sources: readonly SourceState[] = [];
    // `sticky.list` follows the list rule: read every page.
    const notes = await collectPages(async (after) => {
      const page = await c.conn.request('sticky.list', after === undefined ? {} : { after });
      truncated = page.truncated;
      sources = page.sources;
      return { items: page.notes, hasMore: page.hasMore };
    }, (note: NoteInfo) => note.name);
    return { notes, truncated, sources };
  };

  const load = (): Promise<void> => {
    if (!state.getState().wanted) return Promise.resolve();
    const c = context();
    const run = loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => fetchIndex(c),
      ({ notes, truncated, sources }) =>
        state.setState((previous) => {
          const before: Maps = { notes: new Map(previous.notes), shadowed: new Map(previous.shadowed) };
          const maps: Maps = { notes: new Map(), shadowed: new Map() };
          for (const note of notes) put(maps, note, before);
          return { ...previous, ...readyState(), notes: maps.notes, shadowed: maps.shadowed, truncated, sources };
        }),
    );
    const settled = run.finally(() => {
      if (loading === settled) loading = null;
    });
    loading = settled;
    return settled;
  };

  const store: StickyStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    want() {
      if (state.getState().wanted) return loading ?? Promise.resolve();
      state.setState((previous) => ({ ...previous, wanted: true }));
      return load();
    },
    reload: load,
    async create(name) {
      const { note } = await context().conn.request('sticky.create', { name });
      state.setState((previous) => {
        const before: Maps = { notes: new Map(previous.notes), shadowed: new Map(previous.shadowed) };
        const maps: Maps = { notes: new Map(previous.notes), shadowed: new Map(previous.shadowed) };
        put(maps, note, before);
        return { ...previous, notes: maps.notes, shadowed: maps.shadowed };
      });
      return note;
    },
    setLastOpen(name) {
      if (state.getState().lastOpen !== name) state.setState((previous) => ({ ...previous, lastOpen: name }));
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const off = c.conn.on('sticky.changed', ({ upserted, removed, truncated, sources }) => {
        // Nothing is shown before the index was asked for: a change alone would be a list of a few notes.
        if (!state.getState().wanted) return;
        state.setState((previous) => {
          const before: Maps = { notes: new Map(previous.notes), shadowed: new Map(previous.shadowed) };
          const maps: Maps = { notes: new Map(previous.notes), shadowed: new Map(previous.shadowed) };
          for (const name of removed) remove(maps, name);
          for (const note of upserted) put(maps, note, before);
          return { ...previous, notes: maps.notes, shadowed: maps.shadowed, truncated, ...(sources === undefined ? {} : { sources }) };
        });
      });
      return off;
    },
    reset() {
      // What was asked for stays asked for (`wanted`), and the note last open stays: load() fetches the index again.
      state.setState((previous) => ({ ...INITIAL_STICKY_STATE, wanted: previous.wanted, lastOpen: previous.lastOpen }));
    },
    load,
    onResumed() {
      // What the daemon tells every member (sticky.changed) is not replayed to a channel that was away: ask again.
      if (state.getState().wanted) load().catch((error: unknown) => ctx?.reportError('sticky', error));
    },
  };
  return { store, lifecycle };
}
