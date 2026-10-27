// DESIGN 0.7.0 D6: "in order", one pure function. One row of the table per branch, in the order the function asks
// them (the first that applies decides), and what the wire shows of each (`WorkItem.autoMerge`).
import { describe, expect, it } from 'vitest';
import { autoMergeInfoSchema, HOST_HOLDS } from '@smurg/protocol';
import { AUTO_MERGE_TRIES, autoContinueDue, autoMergeInfoOf, autoMergeVerdict, withinTextBudget, type AutoMergeVerdict, type AutoMergeVerdictInput } from '../../src/topics/auto-merge-verdict.ts';
import { mergingOf } from '../../src/topics/core.ts';
import type { Pin, StoredAutoMerge } from '../../src/topics/store.ts';

const MEI = { userId: 'dev:mei', displayName: 'Mei' };

/** A done item of a Start that smurg merges, its report complete with a passed check, checked in its turn, a draft. */
function inOrder(): AutoMergeVerdictInput {
  return {
    policy: 'auto',
    topic: { archived: false, paused: false },
    claimed: false,
    item: { state: 'done', merged: false, merge: { requestId: 'mr_1', status: 'draft', ready: false } },
    request: { id: 'mr_1', status: 'draft', requested: false },
    report: { version: 1, state: 'to-review', outcome: 'complete', checks: { passed: 1, notVerified: 0 }, checkedInTurn: true, pendingFollowUps: 0 },
    byHandOutside: null,
    session: { turnOpen: false, openCards: 0 },
    tries: 0,
    maxTries: AUTO_MERGE_TRIES,
  };
}

function record(state: StoredAutoMerge['state'], reason: StoredAutoMerge['reason'], extra: Partial<StoredAutoMerge> = {}): StoredAutoMerge {
  return { state, reason, since: 1_000, hostOnly: state === 'held' && (HOST_HOLDS as readonly string[]).includes(reason), ...extra };
}

type Change = (input: AutoMergeVerdictInput) => AutoMergeVerdictInput;
const withItem = (item: Partial<AutoMergeVerdictInput['item']>): Change => (input) => ({ ...input, item: { ...input.item, ...item } });
const withReport = (report: Partial<NonNullable<AutoMergeVerdictInput['report']>>): Change => (input) => ({ ...input, report: input.report === null ? null : { ...input.report, ...report } });

const ROWS: readonly (readonly [string, Change, AutoMergeVerdict])[] = [
  // 1.
  ['1 the host merges', (input) => ({ ...input, policy: 'host' }), { kind: 'none' }],
  ['1 nothing to merge (direct, never started)', (input) => ({ ...input, policy: null }), { kind: 'none' }],
  ['1 the topic archived', (input) => ({ ...input, topic: { archived: true, paused: false } }), { kind: 'none' }],
  ['1 left out', withItem({ leftOut: { by: MEI, at: 1 } }), { kind: 'none' }],
  ['1 not done (running)', withItem({ state: 'running' }), { kind: 'none' }],
  ['1 reviewed counts as done', withItem({ state: 'reviewed' }), { kind: 'merge', requestId: 'mr_1' }],
  // 2.
  ['2 its current request is merged', (input) => ({ ...input, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'none' }],
  ['2 an undo claims it', (input) => ({ ...input, claimed: true }), { kind: 'none' }],
  // 3.
  ['3 the plan is paused', (input) => ({ ...input, topic: { archived: false, paused: true } }), { kind: 'wait', reason: 'paused' }],
  // 4.
  ['4 its session is in a turn', (input) => ({ ...input, session: { turnOpen: true, openCards: 0 } }), { kind: 'wait', reason: 'busy' }],
  ['4 a card of it is open', (input) => ({ ...input, session: { turnOpen: false, openCards: 1 } }), { kind: 'wait', reason: 'busy' }],
  ['4 an automatic continue is still to come', withItem({ autoContinue: { cause: 'error', count: 1, at: 1 } }), { kind: 'wait', reason: 'busy' }],
  ['4 the automatic continues are spent', withItem({ autoContinue: { cause: 'error', count: 2, at: 1 } }), { kind: 'merge', requestId: 'mr_1' }],
  // 5.
  ['5 a follow-up whose answer is to come', withReport({ pendingFollowUps: 1 }), { kind: 'wait', reason: 'asked' }],
  ['5 somebody wrote to the agent and no version came', withItem({ changesAsked: { by: MEI, at: 5 } }), { kind: 'hold', reason: 'asked' }],
  // 6.
  ['6 a later turn was stopped', withItem({ lastTurn: { outcome: 'interrupted', at: 6 } }), { kind: 'hold', reason: 'stopped' }],
  ['6 a later turn ended on an error', withItem({ lastTurn: { outcome: 'error', at: 6 } }), { kind: 'hold', reason: 'stopped' }],
  // 7.
  ['7 no report', (input) => ({ ...input, report: null }), { kind: 'none' }],
  ['7 a report smurg cannot read', withReport({ state: 'invalid' }), { kind: 'hold', reason: 'report-invalid' }],
  // 8.
  ['8 files only the host may merge', withReport({ noChanges: 'host-only-paths', paths: ['CLAUDE.md'] }), { kind: 'hold', reason: 'policy', paths: ['CLAUDE.md'] }],
  ['8 the topic\'s own files', withReport({ noChanges: 'spec-files' }), { kind: 'hold', reason: 'policy' }],
  ['8 conflict markers: its agent resolves them', withReport({ noChanges: 'conflict-markers', paths: ['src/a.ts'] }), { kind: 'resolve', reason: 'markers', paths: ['src/a.ts'] }],
  ['8 conflict markers, the tries spent', (input) => ({ ...withReport({ noChanges: 'conflict-markers', paths: ['src/a.ts'] })(input), tries: 3 }), { kind: 'hold', reason: 'conflict', paths: ['src/a.ts'] }],
  ['8 conflict markers, its agent at work', (input) => withItem({ autoMerge: record('resolving', 'markers', { paths: ['src/a.ts'] }) })(withReport({ noChanges: 'conflict-markers', paths: ['src/a.ts'] })(input)), { kind: 'none' }],
  ['8 no history (direct)', withReport({ noChanges: 'no-history' }), { kind: 'none' }],
  // 9.
  ['9 a hand edit by someone without agent access', (input) => ({ ...input, byHandOutside: ['src/a.ts'] }), { kind: 'hold', reason: 'by-hand', paths: ['src/a.ts'] }],
  ['9 the hand edits were too many to list', (input) => ({ ...input, byHandOutside: 'truncated' }), { kind: 'hold', reason: 'by-hand' }],
  // 10.–12.
  ['10 partial', withReport({ outcome: 'partial' }), { kind: 'hold', reason: 'partial' }],
  ['10 blocked', withReport({ outcome: 'blocked' }), { kind: 'hold', reason: 'blocked' }],
  ['11 a check failed (a hand-edited store)', withReport({ checks: { passed: 1, notVerified: 0, failed: 1 } }), { kind: 'hold', reason: 'check-failed' }],
  ['12 no check passed', withReport({ checks: { passed: 0, notVerified: 2 } }), { kind: 'hold', reason: 'not-verified' }],
  ['12 a check not verified does not stop it', withReport({ checks: { passed: 1, notVerified: 2 } }), { kind: 'merge', requestId: 'mr_1' }],
  // 13.
  ['13 not checked in the turn that made it: asked once', withReport({ checkedInTurn: false }), { kind: 'verify' }],
  ['13 its agent checks again', (input) => withItem({ autoMerge: record('resolving', 'stale-report') })(withReport({ checkedInTurn: false })(input)), { kind: 'none' }],
  ['13 that turn did not check it', (input) => withItem({ autoMerge: record('held', 'stale-report') })(withReport({ checkedInTurn: false })(input)), { kind: 'hold', reason: 'stale-report' }],
  // 14.
  ['14 a conflict after the tries is kept', withItem({ autoMerge: record('held', 'conflict', { paths: ['src/a.ts'] }) }), { kind: 'hold', reason: 'conflict', paths: ['src/a.ts'] }],
  ['14 the host rejected it', withItem({ autoMerge: record('held', 'rejected') }), { kind: 'hold', reason: 'rejected' }],
  ['14 a merge-time policy hold is kept', withItem({ autoMerge: record('held', 'policy', { paths: ['.github/workflows/ci.yml'] }) }), { kind: 'hold', reason: 'policy', paths: ['.github/workflows/ci.yml'] }],
  ['14 its agent resolves a conflict', withItem({ autoMerge: record('resolving', 'conflict', { paths: ['src/a.ts'] }) }), { kind: 'none' }],
  ['14 a hold of the main workspace falls through (the queue looks again)', withItem({ autoMerge: record('held', 'local-changes', { paths: ['src/a.ts'] }) }), { kind: 'merge', requestId: 'mr_1' }],
  ['14 a wait falls through', withItem({ autoMerge: record('waiting', 'typing', { paths: ['src/a.ts'] }) }), { kind: 'merge', requestId: 'mr_1' }],
  ['14 a computed hold that is over falls through', withItem({ autoMerge: record('held', 'asked') }), { kind: 'merge', requestId: 'mr_1' }],
  // 15.
  ['15 a draft', (input) => input, { kind: 'merge', requestId: 'mr_1' }],
  ['15 a conflict nobody asked for', (input) => ({ ...input, request: { id: 'mr_1', status: 'conflict', requested: false } }), { kind: 'merge', requestId: 'mr_1' }],
  ['15 a merge somebody asked for is the host\'s', (input) => ({ ...input, request: { id: 'mr_1', status: 'pending', requested: true } }), { kind: 'none' }],
  ['15 a conflict that keeps who asked is the host\'s', (input) => ({ ...input, request: { id: 'mr_1', status: 'conflict', requested: true } }), { kind: 'none' }],
  // 16.
  ['16 a rejected request without a hold', (input) => ({ ...input, request: { id: 'mr_1', status: 'rejected', requested: false } }), { kind: 'none' }],
  ['16 no request (the snapshot was refused for another reason)', (input) => ({ ...input, request: null }), { kind: 'none' }],
];

describe('DESIGN 0.7.0 D6: autoMergeVerdict', () => {
  it.each(ROWS)('%s', (_name, change, expected) => {
    expect(autoMergeVerdict(change(inOrder()))).toEqual(expected);
  });

  it('the rows are asked in order: an earlier one decides (paused before busy, asked before stopped, a hold before the check, the check before a kept decision)', () => {
    const all = withItem({ changesAsked: { by: MEI, at: 5 }, lastTurn: { outcome: 'interrupted', at: 6 } });
    expect(autoMergeVerdict(all(inOrder()))).toEqual({ kind: 'hold', reason: 'asked' });
    expect(autoMergeVerdict({ ...inOrder(), topic: { archived: false, paused: true }, session: { turnOpen: true, openCards: 1 } })).toEqual({ kind: 'wait', reason: 'paused' });
    expect(autoMergeVerdict(withReport({ outcome: 'partial', checkedInTurn: false })(inOrder()))).toEqual({ kind: 'hold', reason: 'partial' });
    expect(autoMergeVerdict(withItem({ autoMerge: record('held', 'conflict') })(withReport({ checkedInTurn: false })(inOrder())))).toEqual({ kind: 'verify' });
  });

  it('a stopped turn is a decision only after its automatic continues are spent; a usage limit has no bound', () => {
    expect(autoContinueDue(undefined)).toBe(false);
    expect(autoContinueDue({ cause: 'usage-limit', count: 50, at: 1 })).toBe(true);
    expect(autoContinueDue({ cause: 'error', count: 1, at: 1 })).toBe(true);
    expect(autoContinueDue({ cause: 'error', count: 2, at: 1 })).toBe(false);
    expect(autoContinueDue({ cause: 'crash', count: 1, at: 1 })).toBe(false);
    expect(autoMergeVerdict(withItem({ lastTurn: { outcome: 'error', at: 6 }, autoContinue: { cause: 'error', count: 2, at: 1 } })(inOrder()))).toEqual({ kind: 'hold', reason: 'stopped' });
  });
});

describe('DESIGN 0.7.0 D3: mergingOf (the pin and the setting together)', () => {
  const pin = (extra: Partial<Pin>): Pin => ({ by: MEI, at: 1, planRevision: 1, specHash: 'a'.repeat(64), planHash: 'b'.repeat(64), commit: 'c'.repeat(40), specBlob: 'd'.repeat(40), planBlob: 'e'.repeat(40), ...extra });
  const direct = pin({ commit: null, specBlob: null, planBlob: null, history: 'direct' });
  it.each([
    ['never started', undefined, 'auto', null],
    ['a direct Start', direct, 'auto', null],
    ['a Start of 0.6.0 (no merging in its pin)', pin({}), 'auto', 'host'],
    ['an automatic Start, the setting on', pin({ merging: 'auto', branch: 'main' }), 'auto', 'auto'],
    ['an automatic Start, the setting off', pin({ merging: 'auto', branch: 'main' }), 'host', 'host'],
    ['the host\'s Start, the setting on', pin({ merging: 'host', branch: 'main' }), 'auto', 'host'],
    ['smurg\'s own history, automatic', pin({ merging: 'auto', history: 'smurg' }), 'auto', 'auto'],
  ] as const)('%s', (_name, itemPin, setting, expected) => {
    expect(mergingOf({ pin: itemPin }, { merging: setting })).toBe(expected);
  });
});

describe('DESIGN 0.7.0 D9: what the wire shows (`WorkItem.autoMerge`)', () => {
  const facts = (record?: StoredAutoMerge) => ({ record, tries: 1, reportAt: 100, pausedAt: 200, changesAsked: { by: MEI, at: 300 }, lastTurnAt: 400 });
  it('the computed waits and holds, with when they began and who wrote; a stored record while the verdict still gives it', () => {
    const shown = (verdict: AutoMergeVerdict, record?: StoredAutoMerge) => {
      const info = autoMergeInfoOf(verdict, facts(record));
      if (info !== undefined) expect(autoMergeInfoSchema.safeParse(info).success).toBe(true);
      return info;
    };
    expect(shown({ kind: 'merge', requestId: 'mr_1' })).toEqual({ state: 'waiting', reason: 'queued', since: 100, tries: 1, hostOnly: false, escalated: false });
    expect(shown({ kind: 'wait', reason: 'paused' })).toMatchObject({ state: 'waiting', reason: 'paused', since: 200 });
    expect(shown({ kind: 'wait', reason: 'asked' })).toMatchObject({ state: 'waiting', reason: 'asked', since: 300, asked: MEI });
    expect(shown({ kind: 'hold', reason: 'asked' })).toMatchObject({ state: 'held', reason: 'asked', since: 300, asked: MEI, hostOnly: false });
    expect(shown({ kind: 'hold', reason: 'stopped' })).toMatchObject({ state: 'held', reason: 'stopped', since: 400 });
    expect(shown({ kind: 'hold', reason: 'by-hand', paths: ['src/a.ts'] })).toMatchObject({ state: 'held', reason: 'by-hand', hostOnly: true, paths: ['src/a.ts'] });
    // The record of the same hold, with its own time and escalation.
    expect(shown({ kind: 'hold', reason: 'partial' }, record('held', 'partial', { since: 50, escalatedAt: 60 }))).toMatchObject({ since: 50, escalated: true });
    // A wait of the main workspace the queue keeps, while the verdict says "merge".
    expect(shown({ kind: 'merge', requestId: 'mr_1' }, record('waiting', 'typing', { paths: ['src/a.ts'] }))).toMatchObject({ state: 'waiting', reason: 'typing', paths: ['src/a.ts'] });
    expect(shown({ kind: 'merge', requestId: 'mr_1' }, record('held', 'branch', { branch: { expected: 'main', current: 'experiment' } }))).toMatchObject({ state: 'held', reason: 'branch', hostOnly: true, branch: { expected: 'main', current: 'experiment' } });
    // A hold the verdict no longer gives is not shown (the queue removes it).
    expect(shown({ kind: 'merge', requestId: 'mr_1' }, record('held', 'asked'))).toMatchObject({ state: 'waiting', reason: 'queued' });
    // The agent at work, and nothing to wait for.
    expect(shown({ kind: 'none' }, record('resolving', 'conflict', { paths: ['src/a.ts'] }))).toMatchObject({ state: 'resolving', reason: 'conflict' });
    expect(shown({ kind: 'none' })).toBeUndefined();
  });

  it('the paths and the people of one item fit the wire\'s budget (16 KiB together): the people go first', () => {
    // (a path of about 4,000 bytes: twenty folders of 200 characters)
    const long = Array.from({ length: 20 }, () => 'x'.repeat(199)).join('/');
    const people = Array.from({ length: 20 }, (_, index) => ({ path: `${long}/f${index}`, by: [MEI], outside: false }));
    const paths = Array.from({ length: 20 }, (_, index) => `${long}/f${index}`);
    const cut = withinTextBudget({ paths, people });
    expect(cut.paths?.length).toBe(4);
    expect(cut.people).toBeUndefined();
    const info = autoMergeInfoOf({ kind: 'hold', reason: 'conflict' }, facts(record('held', 'conflict', { paths: paths.slice(0, 2), people: people.slice(0, 5) })));
    expect(autoMergeInfoSchema.safeParse(info).success).toBe(true);
    expect(info?.paths).toHaveLength(2);
    expect(info?.people?.length).toBeLessThan(5);
  });
});
