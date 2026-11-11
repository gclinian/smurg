// The sticky notes (DESIGN 0.8.0 D2, D4, D7.3, D7.8): the daemon's index of `notes/*.md` in the main workspace (each
// note's name on disk, the names it links to, its flags; nothing else of its text), the outside sources' state, the
// feedback people gave on the notes, and the note last open in the notes view of this page.
//
//   notes     by foldNoteName(name): Home and home are one note (D1.3). A fold twin the daemon does not read is in
//             `shadowed`, by its own name. Loaded with every page of sticky.list, and kept current by sticky.changed,
//             which carries only what changed. A note that did not change keeps its object, so a memo that holds it
//             holds;
//   wanted    the index is loaded when the notes view is first shown (`want()`), NOT when a channel opens: a member
//             who never opens the notes view never asks for it (D7.3). Once asked for, it is loaded again after every
//             full resync and on a resumed channel. Asked again while it is ready (a resumed channel, a note somebody
//             wrote a moment ago), it stays ready until the answer replaces it, and a failure keeps it as it was and
//             goes to the caller (a resumed channel reports it): the open note stays held, the list keeps its focus;
//   feedback  by id, in the daemon's order (oldest first), with a load status of its own: every page of
//             sticky.feedback.list, then sticky.feedback.updated (one entry as it is now, or the id of one that went).
//             For a member who holds `session.drive` it loads WITH THE CHANNEL (D7.3), so that the waiting count on
//             the mode link is right in every view; for everyone else it loads with the index, when the notes view is
//             first shown. Read again like the index (a resumed channel: it stays ready). It holds entries only once a
//             list came (`feedbackStatus` ready): before the first answer, or after it failed, what is told and the
//             replies are no list (the counts would say 1 where 11 wait, review S6-R1); the load on its way applies
//             what is told meanwhile to its answer, and the next one holds the rest. A reply never takes an entry
//             back to an earlier state (feedback only goes from waiting to accepted or rejected, or away), and never
//             brings back an entry that went;
//   lastOpen  the note the notes view showed last in this page, for the mode link (kept in memory only: a note's
//             name is project text).
//
// The text typed into a note's feedback box and not sent yet lives in a map of this store, for the life of the page
// (never in the browser's storage: it is project text), so that it is still there when the person comes back to the
// note.
import {
  FEEDBACK_MAX,
  NOTES_HOME,
  can,
  collectPages,
  foldNoteName,
  noteTree,
  type Feedback,
  type NoteInfo,
  type NoteTree,
  type NoteTreeNode,
  type PayloadOf,
  type SourceState,
} from '@smurg/protocol';
import { compareText } from '../format.ts';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, readyState, type AreaLifecycle, type Loadable, type LoadStatus, type StoreContext } from './base.ts';

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
  /**
   * The feedback on the sticky notes (D4.3), by id, oldest first. A withdrawn entry is never here: it went. Empty
   * unless `feedbackStatus` is ready: what is here is the whole list.
   */
  readonly feedback: ReadonlyMap<string, Feedback>;
  /** The feedback's own load: `idle` until it was asked for on this channel (see the header). */
  readonly feedbackStatus: LoadStatus;
  /** A sentence when the feedback could not be loaded. */
  readonly feedbackError: string | null;
}

export interface StickyStore extends ReadableStore<StickyState> {
  /** The notes view is shown: the index is loaded now (once; afterwards sticky.changed keeps it current), and the feedback with it. */
  want(): Promise<void>;
  /** Asks for the index again. While it is ready it stays ready, and a failure leaves it as it was (and rejects). */
  reload(): Promise<void>;
  /** sticky.create: a new, empty sticky note. Its NoteInfo (the index's) is in the store before this resolves. */
  create(name: string): Promise<NoteInfo>;
  /** The notes view shows `name` (undefined: Home). */
  setLastOpen(name: string | undefined): void;
  /** Asks for the feedback again (its "Try again"). While it is ready it stays ready, and a failure leaves it as it was. */
  reloadFeedback(): Promise<void>;
  /** sticky.feedback.create: feedback on the sticky note `note` (any member, a Viewer too). In the store's list (while it holds one) before this resolves. */
  giveFeedback(note: string, text: string): Promise<Feedback>;
  /** sticky.feedback.withdraw: the author, while it waits. Gone from the store before this resolves. */
  withdrawFeedback(feedbackId: string): Promise<void>;
  /** sticky.feedback.accept (`session.drive`): the daemon sends it once to Claude for the sticky notes. */
  acceptFeedback(feedbackId: string): Promise<Feedback>;
  /** sticky.feedback.reject (`session.drive`), with an optional reason everyone sees. Nothing is sent. */
  rejectFeedback(feedbackId: string, reason?: string): Promise<Feedback>;
  /** What was typed into the feedback box of `note` and not sent yet ('' when nothing). */
  feedbackDraft(note: string): string;
  /** Keeps (or, with '', forgets) the unsent text of the feedback box of `note`, for the life of the page. */
  setFeedbackDraft(note: string, text: string): void;
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
  feedback: new Map(),
  feedbackStatus: 'idle',
  feedbackError: null,
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

/** The feedback on one sticky note (D7.8): what waits, oldest first (a queue); what was decided, the newest decision first. */
export interface NoteFeedback {
  readonly waiting: readonly Feedback[];
  readonly settled: readonly Feedback[];
}

const NO_FEEDBACK: NoteFeedback = Object.freeze({ waiting: Object.freeze([]), settled: Object.freeze([]) });

interface FeedbackDerived {
  /** By the folded name of the note each entry is on. */
  readonly byNote: ReadonlyMap<string, NoteFeedback>;
  /** How many wait, by the folded name of their note (only names with some). */
  readonly waitingByNote: ReadonlyMap<string, number>;
  readonly waiting: number;
}

const feedbackDerived = new WeakMap<ReadonlyMap<string, Feedback>, FeedbackDerived>();

function deriveFeedback(feedback: ReadonlyMap<string, Feedback>): FeedbackDerived {
  const known = feedbackDerived.get(feedback);
  if (known !== undefined) return known;
  const waiting = new Map<string, Feedback[]>();
  const settled = new Map<string, Feedback[]>();
  for (const entry of feedback.values()) {
    const key = foldNoteName(entry.note);
    const into = entry.status === 'waiting' ? waiting : settled;
    const list = into.get(key);
    if (list === undefined) into.set(key, [entry]);
    else list.push(entry);
  }
  const byNote = new Map<string, NoteFeedback>();
  const waitingByNote = new Map<string, number>();
  let total = 0;
  for (const key of new Set([...waiting.keys(), ...settled.keys()])) {
    const queue = waiting.get(key) ?? [];
    // The newest decision first; for two decided at the same moment, the daemon's order (oldest first).
    const decided = (settled.get(key) ?? []).map((entry, index) => ({ entry, index }));
    decided.sort((a, b) => (b.entry.decidedAt ?? b.entry.createdAt) - (a.entry.decidedAt ?? a.entry.createdAt) || a.index - b.index);
    byNote.set(key, { waiting: queue, settled: decided.map(({ entry }) => entry) });
    if (queue.length > 0) waitingByNote.set(key, queue.length);
    total += queue.length;
  }
  const derived: FeedbackDerived = { byNote, waitingByNote, waiting: total };
  feedbackDerived.set(feedback, derived);
  return derived;
}

/** The feedback on the sticky note `name` (folded: feedback on `home` is Home's); the same object while it is the same. */
export function selectFeedbackOf(state: StickyState, name: string): NoteFeedback {
  return deriveFeedback(state.feedback).byNote.get(foldNoteName(name)) ?? NO_FEEDBACK;
}

/** How much feedback waits for a decision: on the sticky note `name` (folded), or on all of them. */
export function selectWaitingCount(state: StickyState, name?: string): number {
  const derived = deriveFeedback(state.feedback);
  return name === undefined ? derived.waiting : (derived.waitingByNote.get(foldNoteName(name)) ?? 0);
}

/** A name with waiting feedback that the index does not hold (D7.4): the note was renamed, or its file went. */
export interface GoneNote {
  /** As the feedback names it (its oldest entry's spelling). */
  readonly name: string;
  readonly waiting: number;
}

const goneNotes = new WeakMap<ReadonlyMap<string, Feedback>, { readonly notes: ReadonlyMap<string, NoteInfo>; readonly gone: readonly GoneNote[] }>();
const NO_GONE: readonly GoneNote[] = Object.freeze([]);

/**
 * The names with waiting feedback that the index does not hold, by name (compareText): the group "Feedback on sticky
 * notes that are gone" (D7.4). None while the index is not loaded: every name would look gone. None either while the
 * index is cut at NOTES_MAX (`truncated`): a name it does not hold may be a sticky note past the limit, and the group
 * would say that no sticky note has it (review S6-SEC-1).
 */
export function selectGoneNotes(state: StickyState): readonly GoneNote[] {
  if (state.status !== 'ready' || state.truncated) return NO_GONE;
  const known = goneNotes.get(state.feedback);
  if (known !== undefined && known.notes === state.notes) return known.gone;
  // A name is spelled as its oldest feedback spells it, whatever became of that one: the row keeps its name while
  // its feedback is decided one by one.
  const spelling = new Map<string, string>();
  for (const entry of state.feedback.values()) {
    const key = foldNoteName(entry.note);
    if (!spelling.has(key)) spelling.set(key, entry.note);
  }
  const counts = deriveFeedback(state.feedback).waitingByNote;
  const names = [...counts.keys()].filter((key) => !state.notes.has(key));
  const gone =
    names.length === 0 ? NO_GONE : names.map((key) => ({ name: spelling.get(key) ?? key, waiting: counts.get(key) ?? 0 })).sort((a, b) => compareText(a.name, b.name));
  goneNotes.set(state.feedback, { notes: state.notes, gone });
  return gone;
}

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

/** The same entry, as far as anything of it can change (feedback changes only by its decision). */
const sameFeedback = (a: Feedback, b: Feedback): boolean =>
  a.id === b.id &&
  a.status === b.status &&
  a.decidedAt === b.decidedAt &&
  a.decidedBy?.userId === b.decidedBy?.userId &&
  a.decidedBy?.displayName === b.decidedBy?.displayName &&
  a.rejectReason === b.rejectReason &&
  a.note === b.note &&
  a.text === b.text;

/** Feedback goes from waiting to accepted or rejected, never back: `entry` when it is not an earlier state of `before`. */
function later(before: Feedback | undefined, entry: Feedback): Feedback {
  if (before === undefined) return entry;
  if (before.status !== 'waiting' && entry.status === 'waiting') return before;
  return sameFeedback(before, entry) ? before : entry;
}

type FeedbackUpdate = PayloadOf<'sticky.feedback.updated'>;

/** The id of the entry an update says went (withdrawn, or dropped at a bound), if it says so. */
const wentOf = (update: FeedbackUpdate): string | undefined =>
  'removed' in update ? update.removed : update.feedback.status === 'withdrawn' ? update.feedback.id : undefined;

/** How many ids of entries that went are remembered on a channel (a reply that comes after its entry went cannot bring it back). */
const GONE_REMEMBERED = FEEDBACK_MAX * 2;

export function createStickyArea(): { store: StickyStore; lifecycle: AreaLifecycle } {
  const state = createStore<StickyState>(INITIAL_STICKY_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('sticky store is not bound to a connection');
    return ctx;
  };
  /** The load that is on its way (want() called while one runs waits for it). */
  let loading: Promise<void> | null = null;
  /** The feedback's load that is on its way. */
  let feedbackLoading: Promise<void> | null = null;
  /**
   * The events that came while a load of the feedback was on its way, one list per load, applied again to its answer.
   * The channel is ordered: a page asked for after an event holds it already, one asked for before does not; the
   * events in order after the whole list give every entry its newest state.
   */
  const pendingEvents = new Set<FeedbackUpdate[]>();
  /** The ids of entries that went on this channel (withdrawn, or dropped at a bound), oldest first. */
  let gone = new Set<string>();
  /** The unsent text of each note's feedback box, by folded name: for the life of the page, never stored. */
  const drafts = new Map<string, string>();

  const forget = (id: string): void => {
    gone.add(id);
    if (gone.size > GONE_REMEMBERED) gone.delete(gone.values().next().value as string);
  };
  /** One update into a copy of the feedback map. */
  const applyUpdate = (map: Map<string, Feedback>, update: FeedbackUpdate): void => {
    const went = wentOf(update);
    if (went !== undefined) {
      forget(went);
      map.delete(went);
    } else if ('feedback' in update && !gone.has(update.feedback.id)) map.set(update.feedback.id, later(map.get(update.feedback.id), update.feedback));
  };
  /**
   * What is told, or what a reply carries, into the store's feedback: only while it holds the list (ready). Before the
   * first list came, or after it failed, a few entries are no list (review S6-R1): the load on its way applies what is
   * told meanwhile to its answer (pendingEvents), a later one is asked for after it and holds it. Only an entry that
   * went is remembered then, so that a reply that comes after the next list cannot bring it back.
   */
  const take = (update: FeedbackUpdate): void => {
    if (state.getState().feedbackStatus !== 'ready') {
      const went = wentOf(update);
      if (went !== undefined) forget(went);
      return;
    }
    state.setState((previous) => {
      const map = new Map(previous.feedback);
      applyUpdate(map, update);
      return { ...previous, feedback: map };
    });
  };
  /** An entry a reply carries, as the store then holds it (the entry itself while the store holds no list). */
  const upsertFeedback = (entry: Feedback): Feedback => {
    take({ feedback: entry });
    return state.getState().feedback.get(entry.id) ?? entry;
  };
  /** This channel asks for the feedback: a member who holds session.drive at once, everyone else with the index. */
  const feedbackWanted = (c: StoreContext): boolean => {
    const role = c.role();
    return state.getState().wanted || (role !== null && can(role, 'session.drive'));
  };

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

  const loadIndex = (): Promise<void> => {
    if (!state.getState().wanted) return Promise.resolve();
    const c = context();
    // A refresh of an index on screen never shows it loading or failed: the views would put a spinner in the place of
    // the open note and the list, and so release the note's shared document (review S3-R1).
    const refresh = state.getState().status === 'ready';
    const run = loadSnapshot(
      c,
      (loadable) => {
        if (!refresh) state.setState((previous) => ({ ...previous, ...loadable }));
      },
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

  const loadFeedback = (): Promise<void> => {
    const c = context();
    // Read again while it is ready (a resumed channel), it stays ready: the counts and the open note's feedback stay
    // on screen until the answer replaces them, and a failure keeps them (and rejects).
    const refresh = state.getState().feedbackStatus === 'ready';
    const events: FeedbackUpdate[] = [];
    pendingEvents.add(events);
    const run = loadSnapshot(
      c,
      (loadable) => {
        if (!refresh) state.setState((previous) => ({ ...previous, feedbackStatus: loadable.status, feedbackError: loadable.error }));
      },
      // `sticky.feedback.list` follows the list rule: read every page.
      () =>
        collectPages(async (after) => {
          const page = await c.conn.request('sticky.feedback.list', after === undefined ? {} : { after });
          return { items: page.feedback, hasMore: page.hasMore };
        }, (entry: Feedback) => entry.id),
      (list) =>
        state.setState((previous) => {
          const map = new Map<string, Feedback>();
          for (const entry of list) {
            const before = previous.feedback.get(entry.id);
            map.set(entry.id, before !== undefined && sameFeedback(before, entry) ? before : entry);
          }
          for (const update of events) applyUpdate(map, update);
          return { ...previous, feedback: map, feedbackStatus: 'ready', feedbackError: null };
        }),
    );
    const settled = run.finally(() => {
      pendingEvents.delete(events);
      if (feedbackLoading === settled) feedbackLoading = null;
    });
    feedbackLoading = settled;
    return settled;
  };

  /** The feedback, if this channel asks for it and has not asked yet (else the load on its way, if any). */
  const wantFeedback = (c: StoreContext): Promise<void> => {
    if (!feedbackWanted(c)) return Promise.resolve();
    if (state.getState().feedbackStatus !== 'idle') return feedbackLoading ?? Promise.resolve();
    return loadFeedback();
  };

  /** What a channel loads: the index once it was wanted, the feedback once it is wanted (a failure of either rejects). */
  const load = (): Promise<void> => Promise.all([loadIndex(), feedbackWanted(context()) ? loadFeedback() : Promise.resolve()]).then(() => undefined);

  const store: StickyStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    want() {
      if (state.getState().wanted) return loading ?? Promise.resolve();
      state.setState((previous) => ({ ...previous, wanted: true }));
      // The feedback comes with the index (a member with session.drive has it from the channel): its failure is kept
      // in its own status, where the view says it with "Try again".
      wantFeedback(context()).catch(() => {});
      return loadIndex();
    },
    reload: loadIndex,
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
    reloadFeedback: loadFeedback,
    async giveFeedback(note, text) {
      return upsertFeedback((await context().conn.request('sticky.feedback.create', { note, text })).feedback);
    },
    async withdrawFeedback(feedbackId) {
      const { feedback } = await context().conn.request('sticky.feedback.withdraw', { feedbackId });
      take({ removed: feedback.id });
    },
    async acceptFeedback(feedbackId) {
      return upsertFeedback((await context().conn.request('sticky.feedback.accept', { feedbackId })).feedback);
    },
    async rejectFeedback(feedbackId, reason) {
      return upsertFeedback((await context().conn.request('sticky.feedback.reject', reason === undefined ? { feedbackId } : { feedbackId, reason })).feedback);
    },
    feedbackDraft(note) {
      return drafts.get(foldNoteName(note)) ?? '';
    },
    setFeedbackDraft(note, text) {
      if (text === '') drafts.delete(foldNoteName(note));
      else drafts.set(foldNoteName(note), text);
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offIndex = c.conn.on('sticky.changed', ({ upserted, removed, truncated, sources }) => {
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
      const offFeedback = c.conn.on('sticky.feedback.updated', (update) => {
        // Nothing is kept before the feedback was asked for on this channel: one entry alone is no list. A load on its
        // way applies it to its answer; the store's list takes it only once there is one (take).
        if (state.getState().feedbackStatus === 'idle') return;
        for (const events of pendingEvents) events.push(update);
        take(update);
      });
      return () => {
        offIndex();
        offFeedback();
      };
    },
    reset() {
      // What was asked for stays asked for (`wanted`); the note last open and the unsent texts stay: load() fetches
      // the index and the feedback again.
      gone = new Set();
      state.setState((previous) => ({ ...INITIAL_STICKY_STATE, wanted: previous.wanted, lastOpen: previous.lastOpen }));
    },
    load,
    onResumed() {
      // What the daemon tells every member (sticky.changed, sticky.feedback.updated) is asked for again on a channel
      // that was away.
      if (state.getState().wanted) loadIndex().catch((error: unknown) => ctx?.reportError('sticky', error));
      if (state.getState().feedbackStatus !== 'idle') loadFeedback().catch((error: unknown) => ctx?.reportError('sticky', error));
    },
    onRoleChange(role) {
      // Made a member with agent access (or the host) on this channel: the waiting count is wanted from now on (D7.3).
      if (ctx !== null && can(role, 'session.drive')) wantFeedback(ctx).catch((error: unknown) => ctx?.reportError('sticky', error));
    },
  };
  return { store, lifecycle };
}
