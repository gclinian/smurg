import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DOC_TEXT_NAME,
  awarenessStateSchema,
  relativePositionSchema,
  sanitizeAwarenessSelection,
  sanitizeRelativePosition,
} from './awareness.ts';

// Ported from the yjs-monaco verification (test-verify/awareness-sanitize.test.ts, V5): every position Yjs produces
// is accepted unchanged; every hostile payload that passed the spike's loose check is rejected; nothing the schema
// accepts makes Y.createAbsolutePositionFromRelativePosition throw.

const doc = new Y.Doc();
const text = doc.getText(DOC_TEXT_NAME);
text.insert(0, 'hello 世界\n😀 end');

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const VALID = [0, 3, 7, text.length].flatMap((index) => [
  json(Y.createRelativePositionFromTypeIndex(text, index)),
  json(Y.createRelativePositionFromTypeIndex(text, index, -1)),
]);

const HOSTILE: readonly unknown[] = [
  { type: null, tname: null, item: { client: 1, clock: 'x' }, assoc: 0 },
  { item: { client: 1, clock: -5 }, assoc: 0 },
  { item: { client: 1, clock: 0.5 }, assoc: 0 },
  { item: {}, assoc: 0 },
  { item: 'str', assoc: 0 },
  { type: null, tname: null, item: null, assoc: 0 },
  { tname: 'other', item: null, assoc: 0 },
  { type: { client: 42, clock: 0 }, item: null, tname: null, assoc: 0 },
  { item: { client: 1, clock: 0, extra: 1 } },
  { tname: DOC_TEXT_NAME, assoc: 1 },
  { tname: DOC_TEXT_NAME, evil: true },
  { item: { client: 2 ** 53, clock: 0 } },
  null,
  'content',
];

describe('strict RelativePosition schema', () => {
  it('accepts every position Yjs itself produces (inside, at the end, assoc -1/0)', () => {
    expect(VALID.length).toBe(8);
    for (const position of VALID) expect(sanitizeRelativePosition(position), JSON.stringify(position)).toEqual(position);
  });

  it('rejects every hostile payload', () => {
    for (const position of HOSTILE) {
      expect(sanitizeRelativePosition(position), JSON.stringify(position)).toBeNull();
      expect(relativePositionSchema.safeParse(position).success).toBe(false);
    }
  });

  it('normalises absent fields to null (Yjs treats undefined and null differently)', () => {
    const withItem = VALID.find((position) => (position as { item: unknown }).item !== null) as { item: { client: number; clock: number } };
    const itemId = withItem.item;
    expect(sanitizeRelativePosition({ item: itemId })).toEqual({ type: null, tname: null, item: itemId, assoc: 0 });
    expect(sanitizeRelativePosition({ tname: DOC_TEXT_NAME })).toEqual({ type: null, tname: DOC_TEXT_NAME, item: null, assoc: 0 });
  });

  it('nothing it accepts throws in createAbsolutePositionFromRelativePosition (fuzz)', () => {
    let seed = 5;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const id = (): unknown =>
      pick([null, undefined, { client: pick([doc.clientID, 1, 0, 2 ** 32]), clock: pick([0, 3, 9, 1e9, -1, 0.5, 'x']) }, {}]);
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const candidate = { type: pick([null, undefined, id()]), tname: pick([null, undefined, DOC_TEXT_NAME, 'other', 1]), item: id(), assoc: pick([0, -1, 1, 2, undefined]) };
      const clean = sanitizeRelativePosition(candidate);
      if (clean === null) continue;
      accepted++;
      expect(() => Y.createAbsolutePositionFromRelativePosition(clean as unknown as Y.RelativePosition, doc), JSON.stringify(candidate)).not.toThrow();
    }
    expect(accepted).toBeGreaterThan(100);
  });
});

describe('awareness selection', () => {
  it('accepts y-monaco selections and "no cursor"', () => {
    const selection = { anchor: VALID[0], head: VALID[2] };
    expect(sanitizeAwarenessSelection(selection)).toEqual({ ok: true, selection });
    expect(sanitizeAwarenessSelection(null)).toEqual({ ok: true, selection: null });
    expect(sanitizeAwarenessSelection(undefined)).toEqual({ ok: true, selection: null });
  });

  it('drops malformed selections', () => {
    expect(sanitizeAwarenessSelection({ anchor: VALID[0] })).toEqual({ ok: false });
    expect(sanitizeAwarenessSelection({ anchor: VALID[0], head: HOSTILE[0] })).toEqual({ ok: false });
    expect(sanitizeAwarenessSelection({ anchor: VALID[0], head: VALID[0], extra: 1 })).toEqual({ ok: false });
    expect(sanitizeAwarenessSelection('x')).toEqual({ ok: false });
  });

  it('the re-encoded state carries the daemon-assigned user', () => {
    const state = {
      user: { name: 'Claude (Ian)', color: '#f59e0b', kind: 'agent', userId: 'github:12345' },
      selection: { anchor: VALID[0], head: VALID[0] },
    };
    expect(awarenessStateSchema.safeParse(state).success).toBe(true);
    expect(awarenessStateSchema.safeParse({ ...state, user: { ...state.user, kind: 'host' } }).success).toBe(false);
    expect(awarenessStateSchema.safeParse({ ...state, user: { ...state.user, name: 'Ian‮' } }).success).toBe(false);
  });
});
