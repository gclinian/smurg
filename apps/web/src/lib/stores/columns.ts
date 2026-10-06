// The member's own view of the sessions view (DESIGN §5.3, UX §2): which columns are open, their order, widths and
// pins, which one has the focus; what this browser showed last (what makes a row of the session list bold); how the
// session list is folded and filtered; which session code mode shows beside the editor. Nothing here comes from the
// daemon and nothing is sent: columns are a personal view. Kept per browser and workspace in
// localStorage['smurg.columns.<workspace id>'].
//
// Opening rules (UX §2 with the pin of DESIGN §5.12 item 24), all in open():
//   - a thing is open at most once: opening it again gives its column the focus;
//   - a click on a row replaces what the focused column shows; "open to the side" adds a column right of it;
//   - a pinned column is never replaced: the click then opens to the side, or replaces the nearest column that is
//     not pinned;
//   - an inbox item opens to the side while fewer columns are open than fit the window, and replaces only when the
//     strip is full;
//   - at most four columns: a fifth is refused (`refusal`, which the shell turns into a notice).
import type { RootRef } from '@smurg/protocol';
import type { ColumnAnchorRequest } from '../columns/context.tsx';
import { columnId, parseColumnRef, type ColumnAnchor, type ColumnRef } from '../columns/target.ts';
import { readJson, writeJson, type PreferenceStorage } from '../preferences.ts';
import { createStore, type ReadableStore } from '../store.ts';

export const MAX_COLUMNS = 4;
/** A column's share of the strip, in multiples of an equal share. */
export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 5;
const SEEN_MAX = 500;

export interface OpenColumn {
  /** `columnId(target)`. */
  readonly id: string;
  readonly target: ColumnRef;
  /** A pinned column is never replaced by a click on the left. */
  readonly pinned: boolean;
  /** 1: as wide as an equal share of the strip. */
  readonly weight: number;
}

export type SessionFilter = 'all' | 'mine' | 'waiting';
export const SESSION_FILTERS: readonly SessionFilter[] = ['all', 'mine', 'waiting'];

/** What a "seen" mark is about: a session's `noteworthyAt`, a topic's spec or plan file change. */
export type SeenKind = 'session' | 'spec' | 'plan';

export interface SeenMarks {
  readonly session: Readonly<Record<string, number>>;
  readonly spec: Readonly<Record<string, number>>;
  readonly plan: Readonly<Record<string, number>>;
}

/** Where "open in code mode" came from: the line above the editor offers the way back. */
export interface CodeOrigin {
  readonly sessionId?: string;
  readonly root: RootRef;
  readonly path?: string;
}

export interface ColumnsState {
  /** Left to right, at most MAX_COLUMNS. */
  readonly columns: readonly OpenColumn[];
  /** The focused column: where a click on the left opens and next to which "open to the side" adds. */
  readonly focusedId: string | null;
  /** Where a column was asked to scroll (an inbox item, a link). Not stored. */
  readonly anchors: ReadonlyMap<string, ColumnAnchorRequest>;
  /**
   * The column that was just asked for (opened, opened again, or the neighbour of a closed one): the strip brings it
   * into view and puts the focus on its title. A new `token` for every request. Not stored.
   */
  readonly reveal: { readonly id: string; readonly token: number } | null;
  /** The latest refused fifth column. Not stored. */
  readonly refusal: { readonly id: number; readonly target: ColumnRef } | null;
  /** How many whole columns fit the strip right now (1 to MAX_COLUMNS); MAX_COLUMNS until the strip measured itself. */
  readonly capacity: number;
  readonly seen: SeenMarks;
  /** When this browser first opened this workspace: nothing older counts as "happened since I last looked". */
  readonly since: number;
  /** The session list's groups a person folded or unfolded by hand: group id → open. */
  readonly groupOpen: Readonly<Record<string, boolean>>;
  readonly filter: SessionFilter;
  /** Code mode: the session beside the editor, and where one came from. `origin` is not stored. */
  readonly code: { readonly sessionId: string | null; readonly origin: CodeOrigin | null };
}

export interface OpenColumnOptions {
  /** Add a column right of the focused one; never replaces. */
  readonly side?: boolean;
  /** `inbox`: opens to the side while the strip has room. Default `row`. */
  readonly from?: 'row' | 'inbox';
  readonly anchor?: ColumnAnchor;
  /** Pin the column if this call creates it (the plan of a topic that is executing). */
  readonly pin?: boolean;
}

export type OpenColumnResult =
  /** It was open already and has the focus now. */
  | { readonly outcome: 'focused'; readonly id: string }
  /** A new column. */
  | { readonly outcome: 'opened'; readonly id: string }
  /** It took the place of another thing in an existing column. */
  | { readonly outcome: 'replaced'; readonly id: string; readonly replacedId: string }
  /** Four columns are open and none may be replaced. */
  | { readonly outcome: 'refused' };

export interface ColumnsStore extends ReadableStore<ColumnsState> {
  open(target: ColumnRef, options?: OpenColumnOptions): OpenColumnResult;
  /** Closes a column. Returns the id of the column that has the focus afterwards (right neighbour, else left), or null. */
  close(id: string): string | null;
  closeOthers(id: string): void;
  focus(id: string): void;
  setPinned(id: string, pinned: boolean): void;
  /** One weight per open column, left to right (a dragged divider). */
  setWeights(weights: readonly number[]): void;
  /** Every column as wide as the others (a double click on a divider). */
  equalize(): void;
  setCapacity(columns: number): void;
  /** The body showed the anchor: drops the request if it is still that one. */
  clearAnchor(id: string, token: number): void;
  /** This browser shows the thing now, in the state of `at` (its noteworthyAt / changedAt). */
  markSeen(kind: SeenKind, id: string, at: number): void;
  setGroupOpen(groupId: string, open: boolean): void;
  setFilter(filter: SessionFilter): void;
  setCodeSession(sessionId: string | null): void;
  setCodeOrigin(origin: CodeOrigin | null): void;
}

// ---- selectors

export const selectColumn = (state: ColumnsState, id: string): OpenColumn | undefined => state.columns.find((column) => column.id === id);
export const selectFocusedColumn = (state: ColumnsState): OpenColumn | undefined => (state.focusedId === null ? undefined : selectColumn(state, state.focusedId));
export const isColumnOpen = (state: ColumnsState, target: ColumnRef): boolean => selectColumn(state, columnId(target)) !== undefined;

/** Whether something happened to the thing since this browser showed it (a bold row). `at` undefined: nothing to tell. */
export function isUnseen(state: Pick<ColumnsState, 'seen' | 'since'>, kind: SeenKind, id: string, at: number | undefined): boolean {
  if (at === undefined) return false;
  return at > (state.seen[kind][id] ?? state.since);
}

// ---- the opening rules, as a pure function

type Placement = { readonly mode: 'insert'; readonly index: number } | { readonly mode: 'replace'; readonly index: number } | { readonly mode: 'refuse' };

/** Where a thing that is not open yet goes. */
export function placeColumn(state: Pick<ColumnsState, 'columns' | 'focusedId' | 'capacity'>, options: Pick<OpenColumnOptions, 'side' | 'from'> = {}): Placement {
  const { columns } = state;
  if (columns.length === 0) return { mode: 'insert', index: 0 };
  const found = columns.findIndex((column) => column.id === state.focusedId);
  // Without a focused column (it was closed by another tab's storage, a corrupt store) the last one stands in.
  const focused = found === -1 ? columns.length - 1 : found;
  const beside: Placement = columns.length < MAX_COLUMNS ? { mode: 'insert', index: focused + 1 } : { mode: 'refuse' };
  if (options.side === true) return beside;
  const room = Math.max(1, Math.min(MAX_COLUMNS, state.capacity));
  if (options.from === 'inbox' && columns.length < room) return beside;
  if (!(columns[focused] as OpenColumn).pinned) return { mode: 'replace', index: focused };
  // The focused column is pinned. A row click keeps what is on screen when it can; an inbox item on a full strip
  // (and a row click on four columns) takes the nearest column that is not pinned: right first, then left.
  if (options.from !== 'inbox' && beside.mode === 'insert') return beside;
  for (let distance = 1; distance < columns.length; distance += 1) {
    for (const index of [focused + distance, focused - distance]) {
      const candidate = columns[index];
      if (candidate !== undefined && !candidate.pinned) return { mode: 'replace', index };
    }
  }
  return beside;
}

// ---- storage

interface Persisted {
  readonly v: 1;
  readonly columns: readonly { readonly target: ColumnRef; readonly pinned: boolean; readonly weight: number }[];
  readonly focusedId: string | null;
  readonly seen: SeenMarks;
  readonly since: number;
  readonly groupOpen: Readonly<Record<string, boolean>>;
  readonly filter: SessionFilter;
  readonly codeSessionId: string | null;
}

export const columnsStorageKey = (workspaceId: string): string => `smurg.columns.${workspaceId}`;

const clampWeight = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, value)) : 1);

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, at] of Object.entries(value)) if (typeof at === 'number' && Number.isFinite(at)) out[key] = at;
  return out;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, open] of Object.entries(value)) if (typeof open === 'boolean') out[key] = open;
  return out;
}

/** The stored view, or a fresh one. Every field tolerates a missing, corrupt or older value. */
export function readColumnsState(stored: unknown, now: number): ColumnsState {
  const s = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<Record<keyof Persisted, unknown>>;
  const columns: OpenColumn[] = [];
  for (const entry of Array.isArray(s.columns) ? s.columns : []) {
    if (columns.length === MAX_COLUMNS || typeof entry !== 'object' || entry === null) continue;
    const { target, pinned, weight } = entry as Record<string, unknown>;
    const ref = parseColumnRef(target);
    if (ref === null || columns.some((column) => column.id === columnId(ref))) continue;
    columns.push({ id: columnId(ref), target: ref, pinned: pinned === true, weight: clampWeight(weight) });
  }
  const seen = (typeof s.seen === 'object' && s.seen !== null ? s.seen : {}) as Partial<Record<SeenKind, unknown>>;
  const focusedId = typeof s.focusedId === 'string' && columns.some((column) => column.id === s.focusedId) ? s.focusedId : (columns[0]?.id ?? null);
  return {
    columns,
    focusedId,
    anchors: new Map(),
    reveal: null,
    refusal: null,
    capacity: MAX_COLUMNS,
    seen: { session: numberRecord(seen.session), spec: numberRecord(seen.spec), plan: numberRecord(seen.plan) },
    since: typeof s.since === 'number' && Number.isFinite(s.since) ? s.since : now,
    groupOpen: booleanRecord(s.groupOpen),
    filter: SESSION_FILTERS.includes(s.filter as SessionFilter) ? (s.filter as SessionFilter) : 'all',
    code: { sessionId: typeof s.codeSessionId === 'string' ? s.codeSessionId : null, origin: null },
  };
}

function persisted(state: ColumnsState): Persisted {
  return {
    v: 1,
    columns: state.columns.map(({ target, pinned, weight }) => ({ target, pinned, weight })),
    focusedId: state.focusedId,
    seen: state.seen,
    since: state.since,
    groupOpen: state.groupOpen,
    filter: state.filter,
    codeSessionId: state.code.sessionId,
  };
}

/** Keeps a map of marks from growing for ever: the oldest marks go first. */
function capMarks(marks: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const entries = Object.entries(marks);
  if (entries.length <= SEEN_MAX) return marks;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX));
}

export interface CreateColumnsOptions {
  readonly workspaceId: string;
  /** null: nothing is remembered (tests, a browser that refuses storage). */
  readonly storage: PreferenceStorage | null;
  readonly now?: () => number;
}

export function createColumnsStore(options: CreateColumnsOptions): ColumnsStore {
  const key = columnsStorageKey(options.workspaceId);
  const now = options.now ?? (() => Date.now());
  const state = createStore<ColumnsState>(readColumnsState(readJson(options.storage, key), now()));
  let anchorToken = 0;
  let revealToken = 0;
  let refusalId = 0;
  const revealOf = (id: string | null): ColumnsState['reveal'] => {
    if (id === null) return null;
    revealToken += 1;
    return { id, token: revealToken };
  };

  /** Applies a change and stores the result (what is stored is a part of the state: a transient change costs one small write). */
  const update = (change: (previous: ColumnsState) => ColumnsState): void => {
    const before = state.getState();
    state.setState(change);
    const after = state.getState();
    if (after !== before) writeJson(options.storage, key, persisted(after));
  };

  const withAnchor = (anchors: ReadonlyMap<string, ColumnAnchorRequest>, id: string, anchor: ColumnAnchor | undefined): ReadonlyMap<string, ColumnAnchorRequest> => {
    if (anchor === undefined || (anchor.cardId === undefined && anchor.seq === undefined)) return anchors;
    anchorToken += 1;
    const next = new Map(anchors);
    next.set(id, { ...anchor, token: anchorToken });
    return next;
  };
  const withoutAnchor = (anchors: ReadonlyMap<string, ColumnAnchorRequest>, id: string): ReadonlyMap<string, ColumnAnchorRequest> => {
    if (!anchors.has(id)) return anchors;
    const next = new Map(anchors);
    next.delete(id);
    return next;
  };

  return {
    getState: state.getState,
    subscribe: state.subscribe,

    open(target, openOptions = {}) {
      const id = columnId(target);
      const current = state.getState();
      if (current.columns.some((column) => column.id === id)) {
        update((previous) => ({ ...previous, focusedId: id, reveal: revealOf(id), anchors: withAnchor(previous.anchors, id, openOptions.anchor) }));
        return { outcome: 'focused', id };
      }
      const placement = placeColumn(current, openOptions);
      if (placement.mode === 'refuse') {
        refusalId += 1;
        const refusal = { id: refusalId, target };
        state.setState((previous) => ({ ...previous, refusal }));
        return { outcome: 'refused' };
      }
      const column: OpenColumn = { id, target, pinned: openOptions.pin === true, weight: 1 };
      if (placement.mode === 'insert') {
        update((previous) => {
          const columns = [...previous.columns];
          columns.splice(placement.index, 0, column);
          return { ...previous, columns, focusedId: id, reveal: revealOf(id), anchors: withAnchor(previous.anchors, id, openOptions.anchor) };
        });
        return { outcome: 'opened', id };
      }
      const replaced = current.columns[placement.index] as OpenColumn;
      update((previous) => ({
        ...previous,
        // The column keeps its place and its width; what it shows is another thing.
        columns: previous.columns.map((existing, index) => (index === placement.index ? { ...column, weight: existing.weight } : existing)),
        focusedId: id,
        reveal: revealOf(id),
        anchors: withAnchor(withoutAnchor(previous.anchors, replaced.id), id, openOptions.anchor),
      }));
      return { outcome: 'replaced', id, replacedId: replaced.id };
    },

    close(id) {
      const current = state.getState();
      const index = current.columns.findIndex((column) => column.id === id);
      if (index === -1) return current.focusedId;
      const columns = current.columns.filter((column) => column.id !== id);
      // The right neighbour takes the closed column's index; without one, the left neighbour is the new last column.
      const neighbour = columns[index] ?? columns[index - 1];
      const focusedId = current.focusedId === id || current.focusedId === null ? (neighbour?.id ?? null) : current.focusedId;
      // The keyboard focus was in the closed column: it goes to the title of the one that has the focus now.
      update((previous) => ({ ...previous, columns, focusedId, reveal: revealOf(focusedId), anchors: withoutAnchor(previous.anchors, id) }));
      return focusedId;
    },

    closeOthers(id) {
      update((previous) => {
        const kept = previous.columns.filter((column) => column.id === id);
        if (kept.length === 0 || previous.columns.length === 1) return previous;
        return { ...previous, columns: kept, focusedId: id, reveal: revealOf(id), anchors: new Map([...previous.anchors].filter(([anchorId]) => anchorId === id)) };
      });
    },

    focus(id) {
      update((previous) => (previous.focusedId === id || !previous.columns.some((column) => column.id === id) ? previous : { ...previous, focusedId: id }));
    },

    setPinned(id, pinned) {
      update((previous) => {
        const column = selectColumn(previous, id);
        if (!column || column.pinned === pinned) return previous;
        return { ...previous, columns: previous.columns.map((existing) => (existing.id === id ? { ...existing, pinned } : existing)) };
      });
    },

    setWeights(weights) {
      update((previous) => {
        if (weights.length !== previous.columns.length) return previous;
        const next = previous.columns.map((column, index) => ({ ...column, weight: clampWeight(weights[index]) }));
        return next.every((column, index) => column.weight === (previous.columns[index] as OpenColumn).weight) ? previous : { ...previous, columns: next };
      });
    },

    equalize() {
      update((previous) => (previous.columns.every((column) => column.weight === 1) ? previous : { ...previous, columns: previous.columns.map((column) => ({ ...column, weight: 1 })) }));
    },

    setCapacity(columns) {
      const capacity = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(columns)));
      // A fact of the window, not of the view: not stored.
      state.setState((previous) => (previous.capacity === capacity ? previous : { ...previous, capacity }));
    },

    clearAnchor(id, token) {
      state.setState((previous) => (previous.anchors.get(id)?.token === token ? { ...previous, anchors: withoutAnchor(previous.anchors, id) } : previous));
    },

    markSeen(kind, id, at) {
      update((previous) => {
        if ((previous.seen[kind][id] ?? Number.NEGATIVE_INFINITY) >= at) return previous;
        return { ...previous, seen: { ...previous.seen, [kind]: capMarks({ ...previous.seen[kind], [id]: at }) } };
      });
    },

    setGroupOpen(groupId, open) {
      update((previous) => (previous.groupOpen[groupId] === open ? previous : { ...previous, groupOpen: { ...previous.groupOpen, [groupId]: open } }));
    },

    setFilter(filter) {
      update((previous) => (previous.filter === filter ? previous : { ...previous, filter }));
    },

    setCodeSession(sessionId) {
      update((previous) => (previous.code.sessionId === sessionId ? previous : { ...previous, code: { ...previous.code, sessionId } }));
    },

    setCodeOrigin(origin) {
      state.setState((previous) => ({ ...previous, code: { ...previous.code, origin } }));
    },
  };
}
