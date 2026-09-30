// The CPU-heavy step of disk → Yjs reconciliation as one pure function, run on the compute worker
// (compute-worker.ts) so a 5 MiB rewrite never stalls the daemon's event loop (ARCHITECTURE §0 rule 5, §7.5).
//
// Input: a snapshot of the room's Y.Doc (Y.encodeStateAsUpdate at the moment the job was queued), the disk texts and
// lockBase. The job forks the Y.Doc from the snapshot, merges (three-way against lockBase when a human lock is held,
// or when unsaved human text differs from the disk), diffs the fork's text to the result, applies that diff to the
// fork and returns ONE Yjs update. The room applies the update in one transaction: characters the diff kept keep
// their item ids (cursors stay put), and anything humans typed while the job ran is merged by Yjs itself instead of
// being overwritten by a stale diff (no retry loop that could starve while someone types).
//
// Measured on this machine (see test/docs/compute.test.ts): applying 20-30k operations as an update takes ~20 ms on
// the main thread, 80k over 100 ms, hence MAX_APPLY_OPS.
import * as Y from 'yjs';
import { coarsenOps, compactOps, smartDiff, type CompactOp } from './diff.ts';
import { threeWayReconcile } from './merge.ts';
import { applyCompactOps } from './apply-ops.ts';

/** Name of the document's Y.Text (DOC_TEXT_NAME in @smurg/protocol; not imported: the worker stays light). */
const TEXT_NAME = 'content';

/** Conflict hunks reported per ConflictRecord (CONFLICT_HUNKS_MAX); the worker sends no more than this. */
export const MAX_REPORTED_CONFLICTS = 64;

/** Most Y.Text operations in the one update a reconcile produces (beyond: coarsened in groups, see coarsenOps). */
export const MAX_APPLY_OPS = 30_000;

/** Diff budgets. The worker affords more than the main thread (the inline fallback uses the research's values). */
export interface ComputeBudgets {
  readonly lineTimeoutMs: number;
  readonly refineBudgetMs: number;
  readonly mergeTimeoutMs: number;
}

export const WORKER_BUDGETS: ComputeBudgets = Object.freeze({ lineTimeoutMs: 1_000, refineBudgetMs: 1_000, mergeTimeoutMs: 1_000 });
export const INLINE_BUDGETS: ComputeBudgets = Object.freeze({ lineTimeoutMs: 300, refineBudgetMs: 150, mergeTimeoutMs: 500 });

export interface ComputeJob {
  /** 'reconcile': merge `theirs` into the fork; 'replace': make the fork's text exactly `theirs`. */
  readonly mode: 'reconcile' | 'replace';
  /** Y.encodeStateAsUpdate(room.doc) when the job was created. */
  readonly snapshot: Uint8Array;
  /** The last text known to be on disk (two-way base). */
  readonly diskText: string;
  /** The disk text when the current human lock was taken, or null. */
  readonly lockBase: string | null;
  /** The new disk text (normalised), or the replacement. */
  readonly theirs: string;
}

export interface ComputedConflict {
  /** 0-based line in the merged text where the kept human text starts. */
  readonly mergedStartLine: number;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

export interface ComputeResult {
  /** The Yjs update turning the snapshot into the merged text; null when nothing changes. */
  readonly update: Uint8Array | null;
  /** Relative position (JSON) just after the last change: the agent's caret. */
  readonly caret: Record<string, unknown> | null;
  readonly conflicts: ComputedConflict[];
  /** Conflicts beyond MAX_REPORTED_CONFLICTS. */
  readonly conflictsOmitted: number;
  /** merged === theirs: nothing to write back. */
  readonly mergedIsTheirs: boolean;
  /** A merge diff timed out (the whole middle became one conflict, all human text kept). */
  readonly mergeTimedOut: boolean;
  /** Too many operations: they were coarsened (cursors inside replaced spans moved). */
  readonly coarse: boolean;
  /** Operations applied (diagnostics, tests). */
  readonly ops: number;
}

export function runComputeJob(job: ComputeJob, budgets: ComputeBudgets = INLINE_BUDGETS): ComputeResult {
  const fork = new Y.Doc();
  try {
    Y.applyUpdate(fork, job.snapshot);
    const text = fork.getText(TEXT_NAME);
    const ours = text.toString();
    let merged = job.theirs;
    let conflicts: ComputedConflict[] = [];
    let conflictsOmitted = 0;
    let mergeTimedOut = false;
    const base = job.lockBase ?? job.diskText;
    if (job.mode === 'reconcile' && (job.lockBase !== null || ours !== job.diskText)) {
      const result = threeWayReconcile(base, ours, job.theirs, budgets.mergeTimeoutMs);
      merged = result.merged;
      mergeTimedOut = result.timedOut;
      conflicts = result.conflicts.slice(0, MAX_REPORTED_CONFLICTS).map((c) => ({ mergedStartLine: c.mergedStartLine, base: c.base, ours: c.ours, theirs: c.theirs }));
      conflictsOmitted = Math.max(0, result.conflicts.length - MAX_REPORTED_CONFLICTS);
    }
    let ops: CompactOp[] = compactOps(smartDiff(ours, merged, { lineTimeoutMs: budgets.lineTimeoutMs, refineBudgetMs: budgets.refineBudgetMs }));
    const coarse = ops.length > MAX_APPLY_OPS;
    if (coarse) ops = coarsenOps(ours, ops, MAX_APPLY_OPS);
    const before = Y.encodeStateVector(fork);
    const applied = applyCompactOps(text, ops, null);
    const update = applied.changed ? Y.encodeStateAsUpdate(fork, before) : null;
    const caret =
      applied.lastChangeEnd === null ? null : (Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, applied.lastChangeEnd)) as Record<string, unknown>);
    return { update, caret, conflicts, conflictsOmitted, mergedIsTheirs: merged === job.theirs, mergeTimedOut, coarse, ops: ops.length };
  } finally {
    fork.destroy();
  }
}
