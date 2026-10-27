// PURE: whether a work item that smurg merges by itself is "in order" (DESIGN 0.7.0 D6). One function, read by the
// merge queue (auto-merge.ts: what a pass does, and "still in order" inside the worktree module's queue, the last time
// just before `git merge`), by the wire (`WorkItem.autoMerge`, core.ts) and so by the plan, the inbox and the phase.
// It reads only what the topics module holds (its store, the session's state, the report, the request's status): the
// checks of the main workspace (the branch, the index, git busy, people typing, local changes, the trial, who changed
// the other side) are the worktree module's (worktree-manager.ts `autoMerge`, D7).
//
// The rows, in order; the first that applies decides:
//    1. not smurg's to merge (the host merges, nothing to merge), the topic archived, the item left out, not done
//    2. its current request is merged; an undo of its topic claims it                                       → none
//    3. the plan is paused                                                                                   → wait
//    4. its session is in a turn, has a card open or a message waiting, or an automatic continue is to come  → wait
//    5. somebody wrote to its agent since this version: the answer is to come → wait; it came without one   → hold
//    6. a later turn did not finish (a person stopped it, or it ended on an error)                           → hold
//    7. no report → none; a report smurg cannot read                                                         → hold
//    8. its snapshot was refused: files only the host may merge, the topic's own files → hold; conflict markers →
//       its agent resolves them (three times), then a hold; no history (direct)                              → none
//    9. a file of it was edited by hand by someone without agent access (or the list was cut)                → hold
//   10. the report is partial or blocked; 11. a check failed; 12. no check passed                            → hold
//   13. the report was not checked in the turn that made this version: its agent is asked once        → verify / hold
//   14. a decision it holds already (a hold of the merge itself, a conflict, a rejection) → hold; its agent is at work
//       on it                                                                                                → none
//   15. a draft, or a conflict nobody asked to merge                                                         → merge
//   16. anything else (a merge somebody asked for is the host's row)                                         → none
import { type AutoMergeInfo, type AutoMergeReason, type MergePolicy, type MergeRequestStatus, type NoChangesReason, type ReportOutcome, type ReportState, type UserRef, AUTO_MERGE_PATHS_MAX, AUTO_MERGE_TEXT_MAX_BYTES, HOST_HOLDS, SELF_CLEARING_HOLDS, autoMergeTextBytes } from '@smurg/protocol';
import type { StoredAutoMerge, StoredItem } from './store.ts';

/** Resolve turns smurg asks an item's own agent for, at most, since its Start (DESIGN 0.7.0 D8; the lead's answer 6). */
export const AUTO_MERGE_TRIES = 3;

/** How many automatic continues of each cause an item gets (DESIGN 0.7.0 D15; S6 sends them): a usage limit has no bound. */
export const AUTO_CONTINUE_BOUNDS: Readonly<Record<NonNullable<StoredItem['autoContinue']>['cause'], number>> = Object.freeze({
  'usage-limit': Number.POSITIVE_INFINITY,
  error: 2,
  crash: 1,
  snapshot: 1,
});

/** An automatic continue of D15 is still to come for the item (its record is there and its bound is not spent). */
export function autoContinueDue(record: StoredItem['autoContinue']): boolean {
  return record !== undefined && record.count < AUTO_CONTINUE_BOUNDS[record.cause];
}

/** The reasons of the state `held` (D9). */
export type HoldReason = Extract<
  AutoMergeReason,
  | 'partial' | 'blocked' | 'check-failed' | 'not-verified' | 'report-invalid' | 'rejected' | 'stopped' | 'policy' | 'local-changes' | 'in-the-way' | 'staged' | 'branch'
  | 'history-changed' | 'merge-failed' | 'by-hand' | 'undo-interrupted' | 'conflict' | 'stale-report' | 'asked' | 'git-busy'
>;

/**
 * Holds that only rows 5–13 give (from the store, the report and the session): a stored one of these that the verdict
 * no longer gives is over (its cause went: a new version, "Merge it as it is", a completed turn).
 */
export const COMPUTED_HOLDS: readonly HoldReason[] = ['asked', 'stopped', 'report-invalid', 'by-hand', 'partial', 'blocked', 'check-failed', 'not-verified'];

/**
 * Row 14: the holds a person settles that stay until what clears them happens (D8 "Clearing"): the merge's own holds
 * that do not end by themselves, a conflict after the tries or with a person's change, the host's rejection. The holds
 * that end by themselves (SELF_CLEARING_HOLDS) fall through: the queue looks at the main workspace again when its
 * re-check is due.
 */
export const KEPT_HOLDS: readonly HoldReason[] = ['policy', 'history-changed', 'merge-failed', 'conflict', 'rejected'];

export type AutoMergeVerdict =
  /** Not smurg's to merge (the host merges, nothing to merge, not done, merged), or its agent is at work on it. */
  | { readonly kind: 'none' }
  | { readonly kind: 'merge'; readonly requestId: string }
  /** Nobody is needed: smurg looks again by itself. */
  | { readonly kind: 'wait'; readonly reason: 'paused' | 'busy' | 'asked' }
  /** Ask the agent once to check its report again (row 13). */
  | { readonly kind: 'verify' }
  /** Ask the agent to resolve the conflict markers its checkout holds (row 8). */
  | { readonly kind: 'resolve'; readonly reason: 'markers'; readonly paths: readonly string[] }
  /** A person decides. */
  | { readonly kind: 'hold'; readonly reason: HoldReason; readonly paths?: readonly string[] };

export interface AutoMergeVerdictInput {
  /** `mergingOf(item, settings)` (D3). */
  readonly policy: MergePolicy | null;
  readonly topic: { readonly archived: boolean; readonly paused: boolean };
  /** An undo of this topic claims the item while it runs (D14): nothing of it merges meanwhile. */
  readonly claimed: boolean;
  readonly item: Pick<StoredItem, 'state' | 'merged' | 'leftOut' | 'changesAsked' | 'merge' | 'autoMerge' | 'lastTurn' | 'autoContinue'>;
  /** The item's current request as the worktree module has it: `requested` when someone asked for its merge. */
  readonly request: { readonly id: string; readonly status: MergeRequestStatus; readonly requested: boolean } | null;
  readonly report: {
    readonly version: number;
    readonly state: ReportState;
    readonly outcome: ReportOutcome;
    readonly checks: { readonly passed: number; readonly notVerified: number; readonly failed?: number };
    /** `check_report` answered ok for this content in the turn that produced this version (or a later one confirmed it). */
    readonly checkedInTurn: boolean;
    /** Follow-ups from the report whose answer is still to come (a message no turn has taken, a suggestion not decided). */
    readonly pendingFollowUps: number;
    readonly noChanges?: NoChangesReason;
    /** The files the refused snapshot named (row 8), as the item's record keeps them. */
    readonly paths?: readonly string[];
  } | null;
  /** Files of the version edited by hand by someone who holds no agent access now (row 9); `truncated`: the list was cut. */
  readonly byHandOutside: readonly string[] | 'truncated' | null;
  /** `turnOpen`: in a turn, or a message waits for one. */
  readonly session: { readonly turnOpen: boolean; readonly openCards: number } | null;
  /** The item's `mergeTries`. */
  readonly tries: number;
  readonly maxTries: number;
}

const NONE: AutoMergeVerdict = Object.freeze({ kind: 'none' });

function hold(reason: HoldReason, paths?: readonly string[]): AutoMergeVerdict {
  return paths === undefined || paths.length === 0 ? { kind: 'hold', reason } : { kind: 'hold', reason, paths: paths.slice(0, AUTO_MERGE_PATHS_MAX) };
}

export function autoMergeVerdict(input: AutoMergeVerdictInput): AutoMergeVerdict {
  const { item, report, request } = input;
  const record = item.autoMerge;
  // 1. smurg's to merge at all
  if (input.policy !== 'auto' || input.topic.archived || item.leftOut !== undefined || (item.state !== 'done' && item.state !== 'reviewed')) return NONE;
  // 2. merged already; claimed by an undo
  if (request?.status === 'merged' || input.claimed) return NONE;
  // 3. a paused plan merges nothing
  if (input.topic.paused) return { kind: 'wait', reason: 'paused' };
  // 4. the agent is at work, or a person is asked something, or smurg continues it by itself later
  if (input.session !== null && (input.session.turnOpen || input.session.openCards > 0)) return { kind: 'wait', reason: 'busy' };
  if (autoContinueDue(item.autoContinue)) return { kind: 'wait', reason: 'busy' };
  // 5. somebody wrote to the agent since this version (R-SAFE S7)
  if (report !== null && report.pendingFollowUps > 0) return { kind: 'wait', reason: 'asked' };
  if (item.changesAsked !== undefined) return hold('asked');
  // 6. a later turn did not finish
  if (item.lastTurn !== undefined) return hold('stopped');
  // 7. the report
  if (report === null) return NONE;
  if (report.state === 'invalid') return hold('report-invalid');
  // 8. a refused snapshot
  if (report.noChanges === 'host-only-paths' || report.noChanges === 'spec-files') return hold('policy', report.paths);
  if (report.noChanges === 'conflict-markers') {
    if (record?.state === 'resolving') return NONE;
    if (record?.state === 'held' && record.reason === 'conflict') return hold('conflict', record.paths);
    return input.tries < input.maxTries && (report.paths ?? []).length > 0 ? { kind: 'resolve', reason: 'markers', paths: (report.paths ?? []).slice(0, AUTO_MERGE_PATHS_MAX) } : hold('conflict', report.paths);
  }
  if (report.noChanges === 'no-history') return NONE;
  // 9. a hand edit by someone without agent access (R-SAFE S8)
  if (input.byHandOutside !== null) return hold('by-hand', input.byHandOutside === 'truncated' ? undefined : input.byHandOutside);
  // 10.–12. what the report says
  if (report.outcome === 'partial') return hold('partial');
  if (report.outcome === 'blocked') return hold('blocked');
  if ((report.checks.failed ?? 0) > 0) return hold('check-failed');
  if (report.checks.passed === 0) return hold('not-verified');
  // 13. checked in the turn that made it (R-SAFE S4)
  if (!report.checkedInTurn) {
    if (record?.state === 'resolving' && record.reason === 'stale-report') return NONE;
    if (record?.state === 'held' && record.reason === 'stale-report') return hold('stale-report');
    return { kind: 'verify' };
  }
  // 14. a decision it holds already, or its agent at work on it
  if (record?.state === 'held' && (KEPT_HOLDS as readonly string[]).includes(record.reason)) return hold(record.reason as HoldReason, record.paths);
  if (record?.state === 'resolving') return NONE;
  // 15. smurg's to merge (a request somebody asked for stays the host's, R-SAFE S12)
  if (request !== null && (request.status === 'draft' || (request.status === 'conflict' && !request.requested))) return { kind: 'merge', requestId: request.id };
  // 16.
  return NONE;
}

/** What `WorkItem.autoMerge` needs besides the verdict: the times and the people of the facts behind it. */
export interface AutoMergeWireFacts {
  readonly record: StoredAutoMerge | undefined;
  readonly tries: number;
  /** When the current report version was registered (the start of every wait and hold the verdict computes). */
  readonly reportAt: number | null;
  readonly pausedAt?: number;
  readonly changesAsked?: { readonly by: UserRef; readonly at: number };
  readonly lastTurnAt?: number;
}

/**
 * The paths and the people of a wait or a hold, cut to what the wire carries for one item (AUTO_MERGE_PATHS_MAX each,
 * AUTO_MERGE_TEXT_MAX_BYTES together, the people first): a plan travels whole.
 */
export function withinTextBudget<T extends { readonly paths?: readonly string[]; readonly people?: readonly { readonly path: string; readonly by: readonly UserRef[]; readonly outside: boolean }[] }>(info: T): T {
  let paths = info.paths?.slice(0, AUTO_MERGE_PATHS_MAX);
  let people = info.people?.slice(0, AUTO_MERGE_PATHS_MAX).map((change) => ({ path: change.path, by: change.by.slice(0, 5).map((user) => ({ ...user })), outside: change.outside }));
  while (autoMergeTextBytes({ paths, people }) > AUTO_MERGE_TEXT_MAX_BYTES) {
    if (people !== undefined && people.length > 0) people = people.slice(0, -1);
    else if (paths !== undefined && paths.length > 0) paths = paths.slice(0, -1);
    else break;
  }
  const { paths: _paths, people: _people, ...rest } = info;
  return { ...rest, ...(paths === undefined || paths.length === 0 ? {} : { paths }), ...(people === undefined || people.length === 0 ? {} : { people }) } as T;
}

/**
 * The wire's `WorkItem.autoMerge` of an item that smurg merges by itself (D9): the record the queue keeps while the
 * verdict still gives it (a hold of the same reason, a wait or a hold of the main workspace the queue looks at again,
 * the agent at work), else what the verdict computes (`queued`, `paused`, `busy`, `asked`, the holds of rows 5–13).
 * Absent: nothing is waited for (it is merged, or not smurg's).
 */
export function autoMergeInfoOf(verdict: AutoMergeVerdict, facts: AutoMergeWireFacts): AutoMergeInfo | undefined {
  const record = facts.record;
  const fromRecord = (stored: StoredAutoMerge): AutoMergeInfo =>
    withinTextBudget({
      state: stored.state,
      reason: stored.reason,
      since: stored.since,
      tries: facts.tries,
      hostOnly: stored.hostOnly,
      escalated: stored.escalatedAt !== undefined,
      ...(stored.paths === undefined || stored.paths.length === 0 ? {} : { paths: [...stored.paths] }),
      ...(stored.branch === undefined ? {} : { branch: { ...stored.branch } }),
      ...(stored.people === undefined || stored.people.length === 0 ? {} : { people: stored.people }),
      ...(stored.reason === 'asked' && facts.changesAsked !== undefined ? { asked: { ...facts.changesAsked.by } } : {}),
    });
  const since = facts.reportAt ?? 0;
  const computed = (state: AutoMergeInfo['state'], reason: AutoMergeReason, at: number, paths?: readonly string[]): AutoMergeInfo => {
    const hostOnly = state === 'held' && (HOST_HOLDS as readonly string[]).includes(reason);
    return withinTextBudget({
      state,
      reason,
      since: at,
      tries: facts.tries,
      hostOnly,
      escalated: false,
      ...(paths === undefined || paths.length === 0 ? {} : { paths: [...paths] }),
      ...(reason === 'asked' && facts.changesAsked !== undefined ? { asked: { ...facts.changesAsked.by } } : {}),
    });
  };
  switch (verdict.kind) {
    case 'hold':
      if (record?.state === 'held' && record.reason === verdict.reason) return fromRecord(record);
      return computed('held', verdict.reason, verdict.reason === 'asked' ? (facts.changesAsked?.at ?? since) : verdict.reason === 'stopped' ? (facts.lastTurnAt ?? since) : since, verdict.paths);
    case 'merge':
      if (record !== undefined && (record.state === 'waiting' || (record.state === 'held' && (SELF_CLEARING_HOLDS as readonly string[]).includes(record.reason)))) return fromRecord(record);
      return computed('waiting', 'queued', since);
    case 'verify':
      return computed('waiting', 'queued', since);
    case 'resolve':
      return computed('resolving', 'markers', since, verdict.paths);
    case 'wait':
      // The agent at work on what smurg asked of it (a resolution, a check of its report) says so.
      if (verdict.reason === 'busy' && record?.state === 'resolving') return fromRecord(record);
      if (verdict.reason === 'asked') return computed('waiting', 'asked', facts.changesAsked?.at ?? since);
      return computed('waiting', verdict.reason, verdict.reason === 'paused' ? (facts.pausedAt ?? since) : since);
    case 'none':
      return record?.state === 'resolving' ? fromRecord(record) : undefined;
  }
}
