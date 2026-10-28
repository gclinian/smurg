// DESIGN 0.7.0 D6: "in order", one pure function. One row of the table per branch, in the order the function asks
// them (the first that applies decides), and what the wire shows of each (`WorkItem.autoMerge`).
import { describe, expect, it } from 'vitest';
import { autoMergeInfoSchema, HOST_HOLDS } from '@smurg/protocol';
import { AUTO_MERGE_TRIES, autoContinueDue, autoMergeInfoOf, autoMergeInfoOfRecord, autoMergeVerdict, directVerdict, withinTextBudget, type AutoMergeVerdict, type AutoMergeVerdictInput } from '../../src/topics/auto-merge-verdict.ts';
import { mergingOf } from '../../src/topics/core.ts';
import type { Pin, StoredAutoMerge } from '../../src/topics/store.ts';

const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const IAN = { userId: 'dev:host', displayName: 'Ian' };

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
  // (0.7.0 fix5, the check of d374e39 S1: a message nothing delivers by itself waits in the session of an item the host
  // merges, and its version is merged: the host's Merge… delivers nothing either; the topic said ready, nobody was told,
  // and "I've checked the result" made it complete with the message never delivered. Its carers' Continue delivers it)
  ['1 the host merges, its version is merged, and a message nothing delivers by itself waits: row 2\'s hold for its carers', (input) => ({ ...input, policy: 'host', request: { id: 'mr_1', status: 'merged', requested: true }, undelivered: true }), { kind: 'hold', reason: 'stopped' }],
  ['1 the host merges, such a message waits, and its version is not merged: the host\'s to merge', (input) => ({ ...input, policy: 'host', undelivered: true }), { kind: 'none' }],
  ['1 the host merges, its version is merged, its checkout holds work no merge carried: the host reads the diff', (input) => ({ ...input, policy: 'host', request: { id: 'mr_1', status: 'merged', requested: true }, unmergedWork: true }), { kind: 'none' }],
  ['1 nothing to merge (direct), such a message waits', (input) => ({ ...input, policy: null, request: { id: 'mr_1', status: 'merged', requested: false }, undelivered: true }), { kind: 'none' }],
  // (0.7.0 fix6, the check of bb6c323 C1: the turn that answered a message to an item the host merged was cut after the
  // merge, by a restart, a hard death, an API error, its process's death or a person's Stop; the topic said ready, the
  // session was ended, and the answer was lost with nobody told. Row 2's hold for its carers, or the wait for smurg's
  // continue, which the wire does not show for the host's item)
  ['1 the host merges, its version is merged, and a later turn did not finish after the merge: row 2\'s hold for its carers', (input) => ({ ...input, policy: 'host', item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 7, restart: true }, mergedAs: { requestId: 'mr_1', at: 6, by: IAN } }, request: { id: 'mr_1', status: 'merged', requested: true } }), { kind: 'hold', reason: 'stopped' }],
  ['1 the host merges, a later turn after the merge ended on an error, and smurg\'s continue is still to come: it waits', (input) => ({ ...input, policy: 'host', item: { ...input.item, lastTurn: { outcome: 'error', at: 7 }, autoContinue: { cause: 'error', count: 0, at: 7 }, mergedAs: { requestId: 'mr_1', at: 6, by: IAN } }, request: { id: 'mr_1', status: 'merged', requested: true } }), { kind: 'wait', reason: 'busy' }],
  ['1 the host merged over a turn that did not finish before: the host\'s decision', (input) => ({ ...input, policy: 'host', item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 5 }, mergedAs: { requestId: 'mr_1', at: 6, by: IAN } }, request: { id: 'mr_1', status: 'merged', requested: true } }), { kind: 'none' }],
  ['1 the host merges, a later version is not merged, a turn after the first merge did not finish: the host\'s to merge', (input) => ({ ...input, policy: 'host', item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 7 }, mergedAs: { requestId: 'mr_0', at: 6, by: IAN } } }), { kind: 'none' }],
  // (0.7.0 fix8, the check of 6f42b50 E3: a later turn of an item the host merged left half of a change in its checkout
  // and was stopped, then its session was ended: nobody had a hold or a row, and the topic stayed unsettled for good.
  // Row 2's hold for its carers, `edited`: nothing continues it, the worktree's "Request merge" asks the host)
  ['1 the host merges, its version is merged, its session has ended and its checkout holds work no merge carried: row 2\'s hold for its carers', (input) => ({ ...input, policy: 'host', session: null, request: { id: 'mr_1', status: 'merged', requested: true }, unmergedWork: true, sessionEnded: true }), { kind: 'hold', reason: 'edited' }],
  ['1 the host merges, a turn before its merge did not finish, then its session ended with that work in its checkout: `edited`, nothing continues it', (input) => ({ ...input, policy: 'host', session: null, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 5 }, mergedAs: { requestId: 'mr_1', at: 6, by: IAN } }, request: { id: 'mr_1', status: 'merged', requested: true }, unmergedWork: true, sessionEnded: true }), { kind: 'hold', reason: 'edited' }],
  ['1 the host merges, its session has ended, its checkout holds nothing more', (input) => ({ ...input, policy: 'host', session: null, request: { id: 'mr_1', status: 'merged', requested: true }, unmergedWork: false, sessionEnded: true }), { kind: 'none' }],
  ['1 the host merges, its session has ended, its version is not merged: the host\'s to merge', (input) => ({ ...input, policy: 'host', session: null, unmergedWork: true, sessionEnded: true }), { kind: 'none' }],
  ['1 nothing to merge (direct, never started)', (input) => ({ ...input, policy: null }), { kind: 'none' }],
  ['1 the topic archived', (input) => ({ ...input, topic: { archived: true, paused: false } }), { kind: 'none' }],
  ['1 left out', withItem({ leftOut: { by: MEI, at: 1 } }), { kind: 'none' }],
  ['1 not done (running)', withItem({ state: 'running' }), { kind: 'none' }],
  ['1 reviewed counts as done', withItem({ state: 'reviewed' }), { kind: 'merge', requestId: 'mr_1' }],
  // 2.
  ['2 its current request is merged', (input) => ({ ...input, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'none' }],
  ['2 an undo claims it', (input) => ({ ...input, claimed: true }), { kind: 'none' }],
  // (0.7.0 review: a merged item whose later turn did not finish and left work in its checkout is the carers' decision)
  ['2 merged, a later turn did not finish, its checkout holds work no merge carried', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 6 } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: true }), { kind: 'hold', reason: 'stopped' }],
  // (0.7.0 verify: the reason says what is so, `edited`, when no turn of it was cut: the hold was `stopped`, "its last
  // turn did not finish", for a checkout that a completed turn or a person had changed)
  ['2 merged, edits since are owed a snapshot, its checkout holds them', (input) => ({ ...input, item: { ...input.item, snapshotOwed: true }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: true }), { kind: 'hold', reason: 'edited' }],
  // (0.7.0 verify: whatever its last turn did, a merged item whose checkout git says holds work no merge carried is
  // held for its carers: a completed turn that changed files through a command, a person's save; before, row 2 asked
  // only after an unfinished turn, and the topic stayed "executing" with nobody asked)
  ['2 merged, its checkout holds work no merge carried (a command\'s edits, a person\'s save)', (input) => ({ ...input, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: true }), { kind: 'hold', reason: 'edited' }],
  ['2 merged, its checkout holds such work, and somebody wrote to its agent', (input) => ({ ...input, item: { ...input.item, changesAsked: { by: MEI, at: 5 } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: true }), { kind: 'hold', reason: 'edited' }],
  // (0.7.0 fix8: once its session has ended, what its checkout holds is asked to merge as it is: no turn can finish)
  ['2 merged, a later turn did not finish, its session has ended, its checkout holds work no merge carried: `edited`', (input) => ({ ...input, session: null, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 5 } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: true, sessionEnded: true }), { kind: 'hold', reason: 'edited' }],
  ['2 merged, a later turn did not finish, its checkout not looked at yet', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 6, restart: true }, snapshotOwed: true }, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'none' }],
  ['2 merged, a later turn did not finish, its checkout holds nothing more', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 6 } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: false }), { kind: 'none' }],
  ['2 merged with half of a change left: while its agent is at work, it waits', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 6 } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: true, session: { turnOpen: true, openCards: 0 } }), { kind: 'wait', reason: 'busy' }],
  // (0.7.0 fix4, the check of 76114a1 H1, H2: a message nothing delivers by itself waits in a merged item's session, sent
  // after its merge or left by the host's merge of an earlier version over a person's follow-up; the item was not held,
  // the topic said ready, and the end of the session threw the message away. Its carers' Continue delivers it)
  ['2 merged, a message a restart left in its session waits, its checkout holds nothing more', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 6, restart: true } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: false, undelivered: true }), { kind: 'hold', reason: 'stopped' }],
  ['2 merged, a message waits that its failed process never took (no turn of it was cut): "its last turn did not finish"', (input) => ({ ...input, request: { id: 'mr_1', status: 'merged', requested: false }, undelivered: true }), { kind: 'hold', reason: 'stopped' }],
  ['2 merged, a message waits, and the plan is paused', (input) => ({ ...input, topic: { archived: false, paused: true }, request: { id: 'mr_1', status: 'merged', requested: false }, undelivered: true }), { kind: 'wait', reason: 'paused' }],
  // (0.7.0 fix6, the check of bb6c323 C1: a later turn that did not finish AFTER the merge is like work no merge
  // carried: smurg's continue (D15) is waited for, otherwise its carers' Continue. It was none: the topic said ready, the
  // session was ended, the continue never came and the answer to the message was lost)
  ['2 merged by smurg, a restart (or a hard death, or a person\'s Stop) cut a later turn, its checkout holds nothing more: held for its carers', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 7, restart: true }, mergedAs: { requestId: 'mr_1', at: 6, by: 'smurg' } }, request: { id: 'mr_1', status: 'merged', requested: false }, unmergedWork: false }), { kind: 'hold', reason: 'stopped' }],
  ['2 merged by smurg, a later turn ended on an API error: smurg\'s continue is still to come', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'error', at: 7 }, autoContinue: { cause: 'error', count: 0, at: 7 }, mergedAs: { requestId: 'mr_1', at: 6, by: 'smurg' } }, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'wait', reason: 'busy' }],
  ['2 merged by smurg, the process of a later turn died: smurg\'s continue is still to come', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'error', at: 7 }, autoContinue: { cause: 'crash', count: 0, at: 7 }, mergedAs: { requestId: 'mr_1', at: 6, by: 'smurg' } }, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'wait', reason: 'busy' }],
  ['2 merged by smurg, a later turn ended on an error and the continues are spent: held for its carers', (input) => ({ ...input, item: { ...input.item, lastTurn: { outcome: 'error', at: 7 }, autoContinue: { cause: 'error', count: 2, at: 7 }, mergedAs: { requestId: 'mr_1', at: 6, by: 'smurg' } }, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'hold', reason: 'stopped' }],
  ['2 merged by smurg, a later turn did not finish, and the plan is paused', (input) => ({ ...input, topic: { archived: false, paused: true }, item: { ...input.item, lastTurn: { outcome: 'interrupted', at: 7 }, mergedAs: { requestId: 'mr_1', at: 6, by: 'smurg' } }, request: { id: 'mr_1', status: 'merged', requested: false } }), { kind: 'wait', reason: 'paused' }],
  // 3.
  ['3 the plan is paused', (input) => ({ ...input, topic: { archived: false, paused: true } }), { kind: 'wait', reason: 'paused' }],
  // 4.
  ['4 its session is in a turn', (input) => ({ ...input, session: { turnOpen: true, openCards: 0 } }), { kind: 'wait', reason: 'busy' }],
  ['4 a card of it is open', (input) => ({ ...input, session: { turnOpen: false, openCards: 1 } }), { kind: 'wait', reason: 'busy' }],
  ['4 an automatic continue is still to come (a later turn broke, and the bound is not spent)', withItem({ lastTurn: { outcome: 'error', at: 6 }, autoContinue: { cause: 'error', count: 1, at: 1 } }), { kind: 'wait', reason: 'busy' }],
  ['4 a failed snapshot is still to be retaken', withItem({ snapshotOwed: true, autoContinue: { cause: 'snapshot', count: 0, at: 1 } }), { kind: 'wait', reason: 'busy' }],
  ['4 the record of a continue whose turn completed owes nothing', withItem({ autoContinue: { cause: 'error', count: 1, at: 1 } }), { kind: 'merge', requestId: 'mr_1' }],
  ['4 the automatic continues are spent', withItem({ autoContinue: { cause: 'error', count: 2, at: 1 } }), { kind: 'merge', requestId: 'mr_1' }],
  // 5.
  ['5 a follow-up whose answer is to come', withReport({ pendingFollowUps: 1 }), { kind: 'wait', reason: 'asked' }],
  // (0.7.0 verify: a follow-up a restart left in the session's queue comes to the agent only with its carers' Continue:
  // it waited for ever, "busy" and "asked", with nobody told)
  ['5 a follow-up a restart left behind waits for nothing: the carers decide', (input) => withItem({ lastTurn: { outcome: 'interrupted', at: 6, restart: true }, changesAsked: { by: MEI, at: 5 } })(withReport({ pendingFollowUps: 1 })(input)), { kind: 'hold', reason: 'asked' }],
  ['5 a message a restart left behind: its last turn did not finish', (input) => withItem({ lastTurn: { outcome: 'interrupted', at: 6, restart: true } })(withReport({ pendingFollowUps: 1 })(input)), { kind: 'hold', reason: 'stopped' }],
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

describe('DESIGN 0.7.0 D10: an item that ran directly in the folder counts as merged only when its report is complete and verified', () => {
  const report = (overrides: Partial<Parameters<typeof directVerdict>[0]> = {}): Parameters<typeof directVerdict>[0] => ({ outcome: 'complete', checks: { passed: 1 }, checkedInTurn: true, ...overrides });
  const ROWS: readonly { readonly name: string; readonly report: Parameters<typeof directVerdict>[0]; readonly verdict: ReturnType<typeof directVerdict> }[] = [
    { name: 'complete, a check passed, none failed, checked in its turn: merged', report: report(), verdict: { kind: 'merged' } },
    { name: 'partial (before anything else)', report: report({ outcome: 'partial', checks: { passed: 0, failed: 1 }, checkedInTurn: false }), verdict: { kind: 'hold', reason: 'partial' } },
    { name: 'blocked', report: report({ outcome: 'blocked' }), verdict: { kind: 'hold', reason: 'blocked' } },
    { name: 'a check failed', report: report({ checks: { passed: 2, failed: 1 } }), verdict: { kind: 'hold', reason: 'check-failed' } },
    { name: 'no check passed', report: report({ checks: { passed: 0 } }), verdict: { kind: 'hold', reason: 'not-verified' } },
    { name: 'not checked in the turn that made it: its agent is asked once', report: report({ checkedInTurn: false }), verdict: { kind: 'verify' } },
  ];
  for (const row of ROWS) it(row.name, () => expect(directVerdict(row.report)).toEqual(row.verdict));

  it('what it is held for is its record on the wire, as it is stored', () => {
    const info = autoMergeInfoOfRecord(record('held', 'not-verified', { escalatedAt: 2_000 }), { tries: 0 });
    expect(info).toEqual({ state: 'held', reason: 'not-verified', since: 1_000, tries: 0, hostOnly: false, escalated: true });
    expect(autoMergeInfoSchema.safeParse(info).success).toBe(true);
  });
});
