// @vitest-environment node
// The columns store: the opening rules of UX §2 with the pin of DESIGN §5.12 item 24, focus, widths, what was seen,
// and what is remembered per browser and workspace.
import { describe, expect, it } from 'vitest';
import { columnId, type ColumnRef } from '../columns/target.ts';
import type { PreferenceStorage } from '../preferences.ts';
import { MAX_COLUMNS, columnsStorageKey, createColumnsStore, isColumnOpen, isUnseen, placeColumn, readColumnsState, selectFocusedColumn, type ColumnsStore } from './columns.ts';

const session = (id: string): ColumnRef => ({ kind: 'session', sessionId: id });
const plan = (topicId: string): ColumnRef => ({ kind: 'plan', topicId });
const spec = (topicId: string): ColumnRef => ({ kind: 'spec', topicId });
const report = (topicId: string, itemId: string): ColumnRef => ({ kind: 'report', topicId, itemId });

function memoryStorage(): PreferenceStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) };
}

function make(storage: PreferenceStorage | null = null, now = 1_000): ColumnsStore {
  return createColumnsStore({ workspaceId: 'ws_1', storage, now: () => now });
}

const ids = (store: ColumnsStore): string[] => store.getState().columns.map((column) => column.id);

describe('columns store: opening', () => {
  it('with nothing open a thing becomes the first column and has the focus', () => {
    const store = make();
    expect(store.open(session('a'))).toEqual({ outcome: 'opened', id: 'session:a' });
    expect(ids(store)).toEqual(['session:a']);
    expect(store.getState().focusedId).toBe('session:a');
    expect(isColumnOpen(store.getState(), session('a'))).toBe(true);
  });

  it('a click on a row replaces what the focused column shows; the column keeps its place and its width', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    store.setWeights([1.5, 0.5]);
    store.focus('session:a');
    expect(store.open(plan('t1'))).toEqual({ outcome: 'replaced', id: 'plan:t1', replacedId: 'session:a' });
    expect(ids(store)).toEqual(['plan:t1', 'session:b']);
    expect(store.getState().columns[0]).toMatchObject({ weight: 1.5, pinned: false });
    expect(store.getState().focusedId).toBe('plan:t1');
  });

  it('a thing is open at most once: opening it again gives its column the focus', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    expect(store.getState().focusedId).toBe('session:b');
    expect(store.open(session('a'))).toEqual({ outcome: 'focused', id: 'session:a' });
    expect(ids(store)).toEqual(['session:a', 'session:b']);
    expect(store.getState().focusedId).toBe('session:a');
    // "To the side" of something that is open does not open it twice either.
    expect(store.open(session('b'), { side: true })).toEqual({ outcome: 'focused', id: 'session:b' });
    expect(ids(store)).toHaveLength(2);
  });

  it('"open to the side" adds a column right of the focused one and gives it the focus', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('c'), { side: true });
    store.focus('session:a');
    expect(store.open(session('b'), { side: true })).toEqual({ outcome: 'opened', id: 'session:b' });
    expect(ids(store)).toEqual(['session:a', 'session:b', 'session:c']);
    expect(store.getState().focusedId).toBe('session:b');
  });

  it('a fifth column is refused and nothing changes', () => {
    const store = make();
    store.open(session('a'));
    for (const id of ['b', 'c', 'd']) store.open(session(id), { side: true });
    expect(ids(store)).toHaveLength(MAX_COLUMNS);
    const before = store.getState();
    expect(store.open(session('e'), { side: true })).toEqual({ outcome: 'refused' });
    expect(store.getState().columns).toBe(before.columns);
    expect(store.getState().refusal).toMatchObject({ target: session('e') });
    const first = store.getState().refusal?.id;
    store.open(session('f'), { side: true });
    expect(store.getState().refusal?.id).not.toBe(first);
    // A plain click still replaces the focused column of the four.
    expect(store.open(session('e')).outcome).toBe('replaced');
  });
});

describe('columns store: the pin (DESIGN §5.12 item 24)', () => {
  it('a pinned column is never replaced: a row click opens beside it while there is room', () => {
    const store = make();
    store.open(plan('t1'), { pin: true });
    expect(store.getState().columns[0]?.pinned).toBe(true);
    expect(store.open(session('a'))).toEqual({ outcome: 'opened', id: 'session:a' });
    expect(ids(store)).toEqual(['plan:t1', 'session:a']);
  });

  it('with four columns and the focused one pinned, a click replaces the nearest column that is not pinned', () => {
    const store = make();
    store.open(session('a'));
    store.open(plan('t1'), { side: true, pin: true });
    store.open(session('c'), { side: true });
    store.open(session('d'), { side: true });
    store.focus('plan:t1');
    // Right first …
    expect(store.open(session('x'))).toEqual({ outcome: 'replaced', id: 'session:x', replacedId: 'session:c' });
    // … then left.
    store.setPinned('session:x', true);
    store.setPinned('session:d', true);
    store.focus('plan:t1');
    expect(store.open(session('y'))).toEqual({ outcome: 'replaced', id: 'session:y', replacedId: 'session:a' });
  });

  it('four pinned columns refuse a click', () => {
    const store = make();
    store.open(session('a'), { pin: true });
    for (const id of ['b', 'c', 'd']) store.open(session(id), { side: true, pin: true });
    expect(store.open(session('e'))).toEqual({ outcome: 'refused' });
    expect(ids(store)).toEqual(['session:a', 'session:b', 'session:c', 'session:d']);
  });

  it('the pin is asked for only when the call creates the column; it can be set and cleared by hand', () => {
    const store = make();
    store.open(plan('t1'));
    store.open(plan('t1'), { pin: true });
    expect(store.getState().columns[0]?.pinned).toBe(false);
    store.setPinned('plan:t1', true);
    expect(store.getState().columns[0]?.pinned).toBe(true);
    store.setPinned('plan:t1', false);
    expect(store.getState().columns[0]?.pinned).toBe(false);
  });

  it('an inbox item opens to the side while fewer columns are open than fit, and replaces only when the strip is full', () => {
    const store = make();
    store.setCapacity(2);
    store.open(session('a'));
    expect(store.open(session('b'), { from: 'inbox' })).toEqual({ outcome: 'opened', id: 'session:b' });
    // The strip is full (two fit): the focused column, which is not pinned, is replaced.
    expect(store.open(session('c'), { from: 'inbox' })).toEqual({ outcome: 'replaced', id: 'session:c', replacedId: 'session:b' });
    // A pinned focused column is kept: the other one goes.
    store.setPinned('session:c', true);
    expect(store.open(session('d'), { from: 'inbox' })).toEqual({ outcome: 'replaced', id: 'session:d', replacedId: 'session:a' });
    expect(ids(store)).toEqual(['session:d', 'session:c']);
  });

  it('placeColumn: without a focused column the last one stands in', () => {
    const columns = [session('a'), session('b')].map((target) => ({ id: columnId(target), target, pinned: false, weight: 1 }));
    expect(placeColumn({ columns, focusedId: null, capacity: 4 })).toEqual({ mode: 'replace', index: 1 });
    expect(placeColumn({ columns, focusedId: 'gone', capacity: 4 }, { side: true })).toEqual({ mode: 'insert', index: 2 });
    expect(placeColumn({ columns: [], focusedId: null, capacity: 4 })).toEqual({ mode: 'insert', index: 0 });
  });
});

describe('columns store: closing and focus', () => {
  it('closing moves the focus to the right neighbour, else the left one, else nowhere; it is also asked to be revealed', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    store.open(session('c'), { side: true });
    store.focus('session:b');
    expect(store.close('session:b')).toBe('session:c');
    expect(store.getState().reveal?.id).toBe('session:c');
    expect(store.close('session:c')).toBe('session:a');
    expect(store.close('session:a')).toBeNull();
    expect(store.getState()).toMatchObject({ columns: [], focusedId: null, reveal: null });
  });

  it('closing a column that is not focused leaves the focus where it is', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    store.focus('session:a');
    expect(store.close('session:b')).toBe('session:a');
    expect(store.getState().focusedId).toBe('session:a');
    expect(store.close('nope')).toBe('session:a');
  });

  it('"close the other columns" keeps one', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    store.open(session('c'), { side: true });
    store.closeOthers('session:b');
    expect(ids(store)).toEqual(['session:b']);
    expect(store.getState().focusedId).toBe('session:b');
    store.closeOthers('nope');
    expect(ids(store)).toEqual(['session:b']);
  });

  it('focus() follows a click inside a column and ignores an unknown id; selectFocusedColumn reads it', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    store.focus('session:a');
    expect(selectFocusedColumn(store.getState())?.id).toBe('session:a');
    store.focus('nope');
    expect(store.getState().focusedId).toBe('session:a');
  });

  it('every request to open says which column to reveal, with a new token each time', () => {
    const store = make();
    store.open(session('a'));
    const first = store.getState().reveal;
    store.open(session('a'));
    const second = store.getState().reveal;
    expect(first?.id).toBe('session:a');
    expect(second?.id).toBe('session:a');
    expect(second?.token).not.toBe(first?.token);
  });
});

describe('columns store: anchors', () => {
  it('an anchor travels with the open request and is dropped when the body showed it', () => {
    const store = make();
    store.open(session('a'), { anchor: { cardId: 'q_1' } });
    const anchor = store.getState().anchors.get('session:a');
    expect(anchor).toMatchObject({ cardId: 'q_1' });
    // The same card asked again: a new request object.
    store.open(session('a'), { anchor: { cardId: 'q_1' } });
    const again = store.getState().anchors.get('session:a');
    expect(again?.token).not.toBe(anchor?.token);
    // An old token clears nothing.
    store.clearAnchor('session:a', anchor?.token as number);
    expect(store.getState().anchors.has('session:a')).toBe(true);
    store.clearAnchor('session:a', again?.token as number);
    expect(store.getState().anchors.has('session:a')).toBe(false);
  });

  it('an empty anchor asks nothing; a replaced or closed column loses its anchor', () => {
    const store = make();
    store.open(session('a'), { anchor: {} });
    expect(store.getState().anchors.size).toBe(0);
    store.open(session('a'), { anchor: { seq: 7 } });
    store.open(session('b'));
    expect([...store.getState().anchors.keys()]).toEqual([]);
    store.open(session('c'), { side: true, anchor: { cardId: 'p_1' } });
    store.close('session:c');
    expect(store.getState().anchors.size).toBe(0);
  });
});

describe('columns store: widths, capacity, seen, folds', () => {
  it('weights are per column, clamped, and "equalize" makes every column as wide as the others', () => {
    const store = make();
    store.open(session('a'));
    store.open(session('b'), { side: true });
    store.setWeights([1.4, 0.6]);
    expect(store.getState().columns.map((column) => column.weight)).toEqual([1.4, 0.6]);
    store.setWeights([100, Number.NaN]);
    expect(store.getState().columns.map((column) => column.weight)).toEqual([5, 1]);
    // The wrong number of weights is ignored (a column was closed while a divider was dragged).
    store.setWeights([1, 1, 1]);
    expect(store.getState().columns.map((column) => column.weight)).toEqual([5, 1]);
    store.equalize();
    expect(store.getState().columns.map((column) => column.weight)).toEqual([1, 1]);
  });

  it('the capacity is between one and four', () => {
    const store = make();
    expect(store.getState().capacity).toBe(4);
    store.setCapacity(0);
    expect(store.getState().capacity).toBe(1);
    store.setCapacity(9);
    expect(store.getState().capacity).toBe(4);
    store.setCapacity(2.9);
    expect(store.getState().capacity).toBe(2);
  });

  it('a thing is unseen when it changed after this browser showed it, or after this browser first opened the workspace', () => {
    const store = make(null, 1_000);
    expect(isUnseen(store.getState(), 'session', 's1', undefined)).toBe(false);
    // Older than the first visit: nothing new.
    expect(isUnseen(store.getState(), 'session', 's1', 900)).toBe(false);
    expect(isUnseen(store.getState(), 'session', 's1', 1_500)).toBe(true);
    store.markSeen('session', 's1', 1_500);
    expect(isUnseen(store.getState(), 'session', 's1', 1_500)).toBe(false);
    expect(isUnseen(store.getState(), 'session', 's1', 1_501)).toBe(true);
    // A mark never moves back.
    store.markSeen('session', 's1', 1_200);
    expect(store.getState().seen.session['s1']).toBe(1_500);
    // Spec and plan marks are separate.
    expect(isUnseen(store.getState(), 'spec', 's1', 1_500)).toBe(true);
    store.markSeen('plan', 't1', 2_000);
    expect(isUnseen(store.getState(), 'plan', 't1', 2_000)).toBe(false);
  });

  it('folds, the filter and code mode\'s session are part of the view', () => {
    const store = make();
    store.setGroupOpen('topic:t1', false);
    store.setFilter('waiting');
    store.setCodeSession('s9');
    store.setCodeOrigin({ root: { kind: 'main' }, sessionId: 's9', path: 'src/a.ts' });
    expect(store.getState()).toMatchObject({ groupOpen: { 'topic:t1': false }, filter: 'waiting', code: { sessionId: 's9', origin: { path: 'src/a.ts' } } });
    store.setCodeOrigin(null);
    expect(store.getState().code).toEqual({ sessionId: 's9', origin: null });
  });
});

describe('columns store: remembered per browser and workspace', () => {
  it('writes the view under smurg.columns.<workspace id> and reads it back', () => {
    const storage = memoryStorage();
    const store = make(storage, 5_000);
    store.open(session('a'));
    store.open(plan('t1'), { side: true, pin: true });
    store.open(report('t1', 'cart-api'), { side: true });
    store.setWeights([1.2, 0.8, 1]);
    store.focus('plan:t1');
    store.markSeen('session', 'a', 6_000);
    store.setGroupOpen('free', false);
    store.setFilter('mine');
    store.setCodeSession('a');
    expect(columnsStorageKey('ws_1')).toBe('smurg.columns.ws_1');
    expect(storage.data.has('smurg.columns.ws_1')).toBe(true);

    const again = make(storage, 9_000);
    expect(again.getState().columns).toEqual([
      { id: 'session:a', target: session('a'), pinned: false, weight: 1.2 },
      { id: 'plan:t1', target: plan('t1'), pinned: true, weight: 0.8 },
      { id: 'report:t1:cart-api', target: report('t1', 'cart-api'), pinned: false, weight: 1 },
    ]);
    expect(again.getState()).toMatchObject({ focusedId: 'plan:t1', since: 5_000, filter: 'mine', groupOpen: { free: false }, code: { sessionId: 'a', origin: null } });
    expect(again.getState().seen.session).toEqual({ a: 6_000 });
    // Another workspace starts empty.
    expect(createColumnsStore({ workspaceId: 'ws_2', storage, now: () => 1 }).getState().columns).toEqual([]);
  });

  it('what is transient is not written: anchors, the refusal, the capacity, where code mode came from', () => {
    const storage = memoryStorage();
    const store = make(storage);
    store.open(session('a'), { anchor: { cardId: 'q_1' } });
    store.setCapacity(2);
    store.setCodeOrigin({ root: { kind: 'main' } });
    const stored = JSON.parse(storage.data.get('smurg.columns.ws_1') as string) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['codeSessionId', 'columns', 'filter', 'focusedId', 'groupOpen', 'seen', 'since', 'v']);
    const again = make(storage);
    expect(again.getState()).toMatchObject({ capacity: 4, refusal: null, reveal: null });
    expect(again.getState().anchors.size).toBe(0);
  });

  it('tolerates a missing, corrupt or foreign value field by field', () => {
    expect(readColumnsState(undefined, 7).columns).toEqual([]);
    expect(readColumnsState('nonsense', 7)).toMatchObject({ since: 7, filter: 'all', focusedId: null });
    const state = readColumnsState(
      {
        columns: [
          { target: { kind: 'session', sessionId: 'a' }, pinned: 'yes', weight: 'wide' },
          { target: { kind: 'session', sessionId: 'a' }, pinned: true, weight: 1 }, // twice: dropped
          { target: { kind: 'console', section: 'audit' } }, // not a column
          { target: { kind: 'nope' } },
          null,
          { target: spec('t1'), pinned: true, weight: 0.001 },
          { target: plan('t1') },
          { target: plan('t2') },
          { target: plan('t3') }, // a fifth
        ],
        focusedId: 'plan:t9',
        seen: { session: { a: 5, b: 'x' }, spec: null },
        since: 'yesterday',
        groupOpen: { free: false, other: 3 },
        filter: 'everything',
        codeSessionId: 9,
      },
      42,
    );
    expect(state.columns.map((column) => column.id)).toEqual(['session:a', 'spec:t1', 'plan:t1', 'plan:t2']);
    expect(state.columns[0]).toMatchObject({ pinned: false, weight: 1 });
    expect(state.columns[1]).toMatchObject({ pinned: true, weight: 0.2 });
    // The focus falls back to the first column.
    expect(state).toMatchObject({ focusedId: 'session:a', since: 42, filter: 'all', groupOpen: { free: false }, code: { sessionId: null } });
    expect(state.seen).toEqual({ session: { a: 5 }, spec: {}, plan: {} });
  });

  it('without storage nothing is remembered and nothing throws', () => {
    const store = make(null);
    store.open(session('a'));
    expect(make(null).getState().columns).toEqual([]);
    const refusing: PreferenceStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    const blocked = make(refusing);
    expect(() => blocked.open(session('a'))).not.toThrow();
    expect(blocked.getState().columns).toHaveLength(1);
  });
});
