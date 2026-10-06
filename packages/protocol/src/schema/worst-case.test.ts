// The worst case of every protocol 4 message fits one Envelope (ARCHITECTURE §4.3): below MAX_APP_MESSAGE, with every
// string below MSGPACK_MAX_STR_LENGTH. The samples are in worst-case.fixture.ts: at the schema's own maxima, or, where
// the registry names a size rule, the largest message that rule lets through.
import { describe, expect, it } from 'vitest';
import { collectPages, decodeEnvelope, encodeEnvelope, encodedSize, takeListPage, takeWithinBytes } from '../codec.ts';
import { MAX_APP_MESSAGE, MSGPACK_MAX_STR_LENGTH } from '../constants.ts';
import { EVENTS_BATCH_MAX_BYTES, EVENTS_PAGE_MAX_BYTES, LIST_REPLY_MAX_BYTES } from './limits.ts';
import { MESSAGE_REGISTRY, MESSAGE_TYPES, type MessageType } from './registry.ts';
import { WORST_CASES, worstConfigRoot, worstEvent, worstInboxItem, worstPermission, worstPlan, worstQuestion, worstReport, worstSession, worstSuggestion, worstTopic } from './worst-case.fixture.ts';

/** The types protocol 3 already had and that kept their shape: their bounds are those of their own tests. */
const UNCHANGED_PREFIXES = ['channel.', 'file.', 'doc.', 'lock.', 'presence.', 'activity.', 'exec.', 'worktree.'];
const UNCHANGED = new Set(['error', 'session.attach', 'session.detach', 'session.end', 'session.loginStatus', 'suggest.edit', 'suggest.withdraw', 'suggest.accept', 'suggest.reject']);
const ADMIN_PROTOCOL_3 = /^admin\.(invite|member|session|audit|settings)\./;
const isNew = (type: string): boolean => !UNCHANGED.has(type) && !UNCHANGED_PREFIXES.some((prefix) => type.startsWith(prefix)) && !ADMIN_PROTOCOL_3.test(type);

function longestString(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return 0;
  let longest = 0;
  for (const item of Array.isArray(value) ? value : Object.values(value)) longest = Math.max(longest, longestString(item));
  return longest;
}

describe('worst-case sizes of the protocol 4 messages', () => {
  const newTypes = MESSAGE_TYPES.filter(isNew);

  it('there is a worst case for exactly the new and reshaped types', () => {
    expect(Object.keys(WORST_CASES).sort()).toEqual([...newTypes].sort());
    expect(newTypes.length).toBeGreaterThan(55);
  });

  it.each(newTypes)('%s: the largest payload is valid and fits one Envelope', (type) => {
    const worst = WORST_CASES[type as MessageType] as { payload: unknown };
    const spec = MESSAGE_REGISTRY[type as MessageType];
    const parsed = spec.payload.safeParse(worst.payload);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(longestString(worst.payload)).toBeLessThan(MSGPACK_MAX_STR_LENGTH);
    const from = spec.dir === 'd2c' ? 'daemon' : 'client';
    const bytes = encodeEnvelope({ type, id: 'x'.repeat(64), seq: Number.MAX_SAFE_INTEGER, payload: worst.payload } as never, { from, channel: 'interactive' });
    expect(bytes.byteLength).toBeLessThan(MAX_APP_MESSAGE);
    expect(decodeEnvelope(bytes, { from, channel: 'interactive' }).ok).toBe(true);
  });

  it.each(newTypes.filter((type) => MESSAGE_REGISTRY[type as MessageType].result !== null))('%s.ok: the largest result is valid and fits one Envelope', (type) => {
    const worst = WORST_CASES[type as MessageType] as { result?: unknown };
    const spec = MESSAGE_REGISTRY[type as MessageType];
    const parsed = (spec.result as NonNullable<typeof spec.result>).safeParse(worst.result);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(longestString(worst.result)).toBeLessThan(MSGPACK_MAX_STR_LENGTH);
    const bytes = encodeEnvelope({ type: `${type}.ok`, id: 'x'.repeat(64), seq: Number.MAX_SAFE_INTEGER, payload: worst.result } as never, { from: 'daemon', channel: 'interactive' });
    expect(bytes.byteLength).toBeLessThan(MAX_APP_MESSAGE);
    expect(decodeEnvelope(bytes, { from: 'daemon', channel: 'interactive' }).ok).toBe(true);
  });

  it('one entry of anything a rule may send alone fits the rule’s own budget, so "at least one" never breaks an Envelope', () => {
    const sizes = {
      event: encodedSize(worstEvent),
      question: encodedSize(worstQuestion),
      permission: encodedSize(worstPermission),
      suggestion: encodedSize(worstSuggestion),
      topic: encodedSize(worstTopic),
      inboxItem: encodedSize(worstInboxItem(0)),
      configRoot: encodedSize(worstConfigRoot),
    };
    // A card always fits a page, so a card named in `moreCards` can always be fetched with session.cards.get.
    for (const card of ['question', 'permission', 'suggestion'] as const) expect(sizes[card], card).toBeLessThan(EVENTS_PAGE_MAX_BYTES);
    // An event always fits a batch and a page.
    expect(sizes.event).toBeLessThan(EVENTS_BATCH_MAX_BYTES);
    // A list entry fits one Envelope with room to spare, even when it alone exceeds the list budget.
    expect(sizes.topic).toBeLessThan(LIST_REPLY_MAX_BYTES);
    expect(sizes.inboxItem).toBeLessThan(LIST_REPLY_MAX_BYTES);
    expect(sizes.suggestion).toBeLessThan(LIST_REPLY_MAX_BYTES);
    expect(encodedSize(worstSession)).toBeLessThan(LIST_REPLY_MAX_BYTES);
    expect(sizes.configRoot).toBeLessThan(MAX_APP_MESSAGE - 64 * 1024);
    // Single entities that travel whole.
    expect(encodedSize(worstPlan)).toBeLessThan(MAX_APP_MESSAGE);
    expect(encodedSize(worstReport)).toBeLessThan(MAX_APP_MESSAGE);
  });
});

describe('takeWithinBytes: the one rule behind every bounded reply', () => {
  const sizeOf = (item: number): number => item;

  it('takes items in order while they fit, and stops at the first that does not', () => {
    expect(takeWithinBytes([3, 3, 3, 3], 9, { sizeOf })).toEqual({ taken: [3, 3, 3], rest: [3], bytes: 9 });
    expect(takeWithinBytes([3, 9, 1], 5, { sizeOf })).toEqual({ taken: [3], rest: [9, 1], bytes: 3 }); // never skips ahead to the 1
    expect(takeWithinBytes([], 5, { sizeOf })).toEqual({ taken: [], rest: [], bytes: 0 });
  });

  it('atLeastOne takes the first item even when it alone exceeds the budget, and only the first', () => {
    expect(takeWithinBytes([9, 1], 5, { sizeOf })).toEqual({ taken: [], rest: [9, 1], bytes: 0 });
    expect(takeWithinBytes([9, 1], 5, { sizeOf, atLeastOne: true })).toEqual({ taken: [9], rest: [1], bytes: 9 });
    expect(takeWithinBytes([9, 1], 0, { sizeOf, atLeastOne: true })).toEqual({ taken: [9], rest: [1], bytes: 9 });
  });

  it('maxItems bounds the count as well', () => {
    expect(takeWithinBytes([1, 1, 1, 1], 100, { sizeOf, maxItems: 2 })).toEqual({ taken: [1, 1], rest: [1, 1], bytes: 2 });
  });

  it('takeListPage: the list rule with its cursor (the last id of the page before)', () => {
    const big = { text: 'x'.repeat(1024 * 1024 - 64) }; // just under one MiB each
    const items = Array.from({ length: 9 }, (_, index) => ({ id: `e${index}`, ...big }));
    const first = takeListPage(items, undefined, (item) => item.id);
    expect(first.items.map((item) => item.id)).toEqual(['e0', 'e1', 'e2', 'e3']); // 4 MiB
    expect(first.hasMore).toBe(true);
    const second = takeListPage(items, 'e3', (item) => item.id);
    expect(second.items.map((item) => item.id)).toEqual(['e4', 'e5', 'e6', 'e7']);
    expect(takeListPage(items, 'e7', (item) => item.id)).toEqual({ items: [items[8]], hasMore: false });
    expect(takeListPage(items, 'e8', (item) => item.id)).toEqual({ items: [], hasMore: false });
    // A cursor that is no longer in the list starts over; a count limit closes a page as well.
    expect(takeListPage(items, 'gone', (item) => item.id).items[0]?.id).toBe('e0');
    expect(takeListPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], undefined, (item) => item.id, { maxItems: 2 })).toEqual({ items: [{ id: 'a' }, { id: 'b' }], hasMore: true });
    expect(takeListPage([], undefined, () => 'x')).toEqual({ items: [], hasMore: false });
  });

  it('collectPages: a client reads every page of a list by passing the last id back', async () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ id: `e${index}` }));
    const asked: (string | undefined)[] = [];
    const all = await collectPages(async (after) => {
      asked.push(after);
      const page = takeListPage(items, after, (item) => item.id, { maxItems: 3 });
      return { items: page.items, hasMore: page.hasMore };
    }, (item) => item.id);
    expect(all).toEqual(items);
    expect(asked).toEqual([undefined, 'e2', 'e5']);
    // One page, an empty list, and a daemon that says "more" without sending anything: each ends.
    expect(await collectPages(async () => ({ items: [{ id: 'a' }], hasMore: false }), (item) => item.id)).toEqual([{ id: 'a' }]);
    expect(await collectPages(async () => ({ items: [] as { id: string }[], hasMore: true }), (item) => item.id)).toEqual([]);
  });

  it('measures with encodedSize by default: the msgpack size of the value as it travels', () => {
    expect(encodedSize('abc')).toBe(4);
    expect(encodedSize({ a: 1 })).toBe(4);
    expect(encodedSize(new Uint8Array(10))).toBe(12);
    expect(encodedSize(() => 1)).toBe(Number.POSITIVE_INFINITY);
    const items = [{ text: 'x'.repeat(100) }, { text: 'y'.repeat(100) }];
    const one = encodedSize(items[0]);
    expect(takeWithinBytes(items, one).taken).toEqual([items[0]]);
    expect(takeWithinBytes(items, 2 * one).taken).toEqual(items);
  });
});
