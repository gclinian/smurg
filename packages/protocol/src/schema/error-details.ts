import { z } from 'zod';
import { SmurgError } from '../errors.ts';
import type { MessageRef } from '../i18n/index.ts';
import { cardRefSchema } from './conversation.ts';
import { type DiskReport, diskReportSchema, itemIdSchema, type LockInfo, lockInfoSchema, shortBranchSchema, userRefSchema } from './entities.ts';
import { UNMERGED_WORKTREES_MAX } from './limits.ts';
import { opaqueIdSchema } from './primitives.ts';

// Typed `error.detail` conventions that the UI relies on (ARCHITECTURE §4.3; §5.2 disk rule, §5.4 locks, §5.9 cards,
// §5.10 archive). A client reacts to a refusal by its `text.id` (one catalog id per sentence) or by one of the
// reasons below with its typed detail; it never parses `message`.

/**
 * The `detail.reason` values protocol 4's contracts fix (a module may use others for its own refusals; a client then
 * branches on `error.text.id`):
 *  - `not-a-terminal` / `not-an-agent`: the session is of the other kind (`bad_request`);
 *  - `ended`: the agent session has ended (`conflict`);
 *  - `archived`: its topic is archived (`conflict`);
 *  - `settled`: the card was answered, decided or withdrawn first (`conflict`, settledError);
 *  - `plan-changed`: a pin of `plan.start` is not the files' now (`conflict`: the Start dialog reloads);
 *  - `report-changed`: `report.review` named an older version (`conflict`);
 *  - `unfinished`: the report's outcome is not `complete` and `acknowledgeUnfinished` is missing (`conflict`);
 *  - `unmerged`: `topic.archive` needs `deleteUnmerged` (`conflict`, unmergedError);
 *  - `not-failed`: `session.retry` of a session that is not `failed` (`conflict`);
 *  - `host-only`: only the host may (`forbidden` / `host_only`);
 *  - `discussion`: a topic's discussion is not ended with `session.end` (`forbidden`);
 *  - `rate-limited`: a token bucket is empty (`rate_limited`, with `detail.bucket`).
 */
export const ERROR_REASONS = [
  'not-a-terminal',
  'not-an-agent',
  'ended',
  'archived',
  'settled',
  'plan-changed',
  'report-changed',
  'unfinished',
  'unmerged',
  'not-failed',
  'host-only',
  'discussion',
  'rate-limited',
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

/** `insufficient_disk` with the numbers, so the UI can show them and point the host to the setting (R7). */
export function insufficientDiskError(disk: DiskReport, message?: string | MessageRef): SmurgError {
  return new SmurgError('insufficient_disk', message, { disk });
}

/** `locked` with the lock that blocks the request, so the UI can name the holder. */
export function lockedError(lock: LockInfo, message?: string | MessageRef): SmurgError {
  return new SmurgError('locked', message, { lock });
}

/** The DiskReport of an `insufficient_disk` error, or null. */
export function diskReportOfError(error: SmurgError): DiskReport | null {
  if (error.code !== 'insufficient_disk') return null;
  const parsed = diskReportSchema.safeParse(error.detail?.['disk']);
  return parsed.success ? parsed.data : null;
}

/** The LockInfo of a `locked` error, or null. */
export function lockOfError(error: SmurgError): LockInfo | null {
  if (error.code !== 'locked') return null;
  const parsed = lockInfoSchema.safeParse(error.detail?.['lock']);
  return parsed.success ? parsed.data : null;
}

/** `detail.reason` of an error, when it is a string. */
export function errorReasonOf(error: SmurgError): string | null {
  const reason = error.detail?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

/** `detail.reason` when it is one of ERROR_REASONS. */
export function knownErrorReasonOf(error: SmurgError): ErrorReason | null {
  const reason = errorReasonOf(error);
  return reason !== null && (ERROR_REASONS as readonly string[]).includes(reason) ? (reason as ErrorReason) : null;
}

// ---- a card that was settled first (questions, permission requests, suggestions) -----------------------------------

/** How a card ended: a question `answered`, a permission request `allowed` / `denied`, a suggestion by its status. */
export const SETTLED_STATUSES = ['answered', 'allowed', 'denied', 'withdrawn', 'accepted', 'accepted-modified', 'rejected'] as const;

/**
 * What a refusal says about a card that is no longer open: which card, in which session, how it ended and (when a
 * person did it) who. The card itself is NOT in the error (an error's detail holds no text people or agents wrote):
 * watchers already have it from `question.updated` / `permission.updated` / `suggest.updated`, and anyone else reads
 * it with `session.cards.get`.
 */
export const settledDetailSchema = z.object({
  reason: z.literal('settled'),
  card: cardRefSchema,
  sessionId: opaqueIdSchema,
  status: z.enum(SETTLED_STATUSES),
  by: userRefSchema.optional(),
});
export type SettledDetail = z.infer<typeof settledDetailSchema>;

/** `conflict` for a vote, a submit, a decision, an accept or a reject that came after the card was settled. */
export function settledError(card: Omit<SettledDetail, 'reason'>, message?: string | MessageRef): SmurgError {
  return new SmurgError('conflict', message, { reason: 'settled', ...card });
}

/** The settled card of a `conflict` error with reason `settled`, or null. */
export function settledOfError(error: SmurgError): SettledDetail | null {
  if (error.code !== 'conflict') return null;
  const parsed = settledDetailSchema.safeParse(error.detail);
  return parsed.success ? parsed.data : null;
}

// ---- topic.archive: worktrees with changes that were never merged ---------------------------------------------------

export const unmergedWorktreeSchema = z.strictObject({ itemId: itemIdSchema, worktreeId: opaqueIdSchema, branch: shortBranchSchema });
export type UnmergedWorktree = z.infer<typeof unmergedWorktreeSchema>;
const unmergedWorktreesSchema = z.array(unmergedWorktreeSchema).max(UNMERGED_WORKTREES_MAX);

/** `conflict` reason `unmerged`: `topic.archive` without `deleteUnmerged` while these worktrees hold unmerged changes. */
export function unmergedError(worktrees: readonly UnmergedWorktree[], message?: string | MessageRef): SmurgError {
  return new SmurgError('conflict', message, { reason: 'unmerged', worktrees: worktrees.slice(0, UNMERGED_WORKTREES_MAX) });
}

/** The worktrees of a `conflict` error with reason `unmerged`, or null. */
export function unmergedWorktreesOfError(error: SmurgError): UnmergedWorktree[] | null {
  if (error.code !== 'conflict' || errorReasonOf(error) !== 'unmerged') return null;
  const parsed = unmergedWorktreesSchema.safeParse(error.detail?.['worktrees']);
  return parsed.success ? parsed.data : null;
}
