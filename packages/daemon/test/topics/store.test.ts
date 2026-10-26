// topics.json and reports.json of 0.7.0 (DESIGN 0.7.0 D3, D4): optional keys only, so what 0.6.0 wrote passes as it is
// (the published fixtures prove that with real files: test/upgrade/fixtures.test.ts); and the rules the new keys bring,
// which an edited file must keep (a file that does not fit stops the daemon instead of starting an agent from it).
import { describe, expect, it } from 'vitest';
import { pinSchema, storedAutoMergeSchema, storedItemSchema } from '../../src/topics/store.ts';

const HASH = 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);
const IAN = { userId: 'dev:ian', displayName: 'Ian' };
/** A pin as 0.6.0's Start wrote it (the folder's own git). */
const PIN_060 = { by: IAN, at: 1, planRevision: 2, specHash: HASH, planHash: HASH, commit: COMMIT, specBlob: COMMIT, planBlob: COMMIT };
const ITEM_060 = {
  id: 'cart-api',
  number: 1,
  title: 'Cart API',
  summary: '',
  dependsOn: [],
  size: 'm',
  touches: [],
  state: 'done',
  since: 1,
  armed: false,
  retry: false,
  responsible: null,
  chosen: false,
  pin: PIN_060,
  sessions: ['ses_1'],
  attempt: 1,
  merged: false,
  checked: [{ sessionId: 'ses_1', attempt: 1, hash: HASH }],
  nudged: false,
};

describe('the pin of a Start (DESIGN 0.7.0 D3)', () => {
  it('a pin of 0.6.0 passes as it is (no `merging`: the host merges its items)', () => {
    expect(pinSchema.safeParse(PIN_060).success).toBe(true);
    expect(storedItemSchema.safeParse(ITEM_060).success).toBe(true);
  });

  it('`auto` in the folder\'s own git names the branch the Start used; a detached Start pins the host and no branch', () => {
    expect(pinSchema.safeParse({ ...PIN_060, merging: 'auto', branch: 'main' }).success).toBe(true);
    expect(pinSchema.safeParse({ ...PIN_060, merging: 'auto' }).success).toBe(false);
    expect(pinSchema.safeParse({ ...PIN_060, merging: 'host' }).success).toBe(true);
    expect(pinSchema.safeParse({ ...PIN_060, merging: 'smurg' }).success).toBe(false);
  });

  it('smurg\'s own history names no branch; a direct Start names no merge policy (nothing to merge)', () => {
    expect(pinSchema.safeParse({ ...PIN_060, history: 'smurg', merging: 'auto' }).success).toBe(true);
    expect(pinSchema.safeParse({ ...PIN_060, history: 'smurg', merging: 'auto', branch: 'main' }).success).toBe(false);
    const direct = { ...PIN_060, history: 'direct', commit: null, specBlob: null, planBlob: null };
    expect(pinSchema.safeParse(direct).success).toBe(true);
    expect(pinSchema.safeParse({ ...direct, merging: 'host' }).success).toBe(false);
    expect(pinSchema.safeParse({ ...direct, merging: 'auto' }).success).toBe(false);
  });
});

describe('what a work item waits for before smurg merges it (DESIGN 0.7.0 D4, D8, D9)', () => {
  const held = { state: 'held', reason: 'partial', since: 1, hostOnly: false } as const;

  it('a hold, a wait the queue keeps and a resolve turn are stored; the waits nobody keeps are not', () => {
    expect(storedAutoMergeSchema.safeParse(held).success).toBe(true);
    expect(storedAutoMergeSchema.safeParse({ state: 'waiting', reason: 'typing', since: 1, hostOnly: false, paths: ['a.txt'] }).success).toBe(true);
    expect(storedAutoMergeSchema.safeParse({ state: 'resolving', reason: 'stale-report', since: 1, hostOnly: false }).success).toBe(true);
    for (const reason of ['queued', 'paused', 'busy', 'asked']) expect(storedAutoMergeSchema.safeParse({ state: 'waiting', reason, since: 1, hostOnly: false }).success, reason).toBe(false);
    expect(storedAutoMergeSchema.safeParse({ ...held, reason: 'asked' }).success).toBe(true);
  });

  it('the host\'s holds are the host\'s alone and never escalate; the branches and the people go with their reasons', () => {
    expect(storedAutoMergeSchema.safeParse({ ...held, reason: 'policy', hostOnly: true, paths: ['.github/workflows/ci.yml'] }).success).toBe(true);
    expect(storedAutoMergeSchema.safeParse({ ...held, reason: 'policy' }).success).toBe(false);
    expect(storedAutoMergeSchema.safeParse({ ...held, hostOnly: true }).success).toBe(false);
    expect(storedAutoMergeSchema.safeParse({ ...held, escalatedAt: 2 }).success).toBe(true);
    expect(storedAutoMergeSchema.safeParse({ ...held, reason: 'by-hand', hostOnly: true, escalatedAt: 2 }).success).toBe(false);
    expect(storedAutoMergeSchema.safeParse({ ...held, reason: 'branch', hostOnly: true, branch: { expected: 'main', current: 'experiment' } }).success).toBe(true);
    expect(storedAutoMergeSchema.safeParse({ ...held, branch: { expected: 'main', current: 'experiment' } }).success).toBe(false);
    const people = [{ path: 'config.txt', by: [IAN], outside: false }];
    expect(storedAutoMergeSchema.safeParse({ ...held, reason: 'conflict', people }).success).toBe(true);
    expect(storedAutoMergeSchema.safeParse({ ...held, people }).success).toBe(false);
  });

  it('an item carries it beside who merged it, what was left out or undone, the turns and the continues', () => {
    const item = {
      ...ITEM_060,
      pin: { ...PIN_060, merging: 'auto', branch: 'main' },
      checked: [{ sessionId: 'ses_1', attempt: 1, hash: HASH, turn: 3 }],
      turns: 2,
      lastTurn: { outcome: 'interrupted', at: 4 },
      mergeTries: 1,
      autoMerge: held,
      autoContinue: { cause: 'error', count: 1, at: 5 },
    };
    expect(storedItemSchema.safeParse(item).success).toBe(true);
    expect(storedItemSchema.safeParse({ ...ITEM_060, merged: true, mergedAs: { requestId: 'mr_1', commit: COMMIT, at: 6, by: 'smurg' } }).success).toBe(true);
    expect(storedItemSchema.safeParse({ ...ITEM_060, merged: true, mergedAs: { at: 6, by: IAN } }).success).toBe(true);
    expect(storedItemSchema.safeParse({ ...ITEM_060, mergedAs: { at: 6, by: 'host' } }).success).toBe(false);
    expect(storedItemSchema.safeParse({ ...ITEM_060, leftOut: { by: IAN, at: 7 } }).success).toBe(true);
    expect(storedItemSchema.safeParse({ ...ITEM_060, undone: { by: IAN, at: 8, commit: COMMIT } }).success).toBe(true);
    expect(storedItemSchema.safeParse({ ...ITEM_060, undone: { by: IAN, at: 8 } }).success).toBe(false);
    expect(storedItemSchema.safeParse({ ...ITEM_060, lastTurn: { outcome: 'completed', at: 4 } }).success).toBe(false);
    expect(storedItemSchema.safeParse({ ...ITEM_060, autoContinue: { cause: 'stopped', count: 1, at: 5 } }).success).toBe(false);
  });
});
