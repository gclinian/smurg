import { z } from 'zod';
import { mergeMessageSchema, mergeRequestSchema, reasonTextSchema, resultPathSchema, worktreeInfoSchema } from '../entities.ts';
import { LIST_MAX_ITEMS, MERGE_DIFF_MAX_BYTES, MERGE_FILES_MAX } from '../limits.ts';
import { indexSchema, largeTextSchema, opaqueIdSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// worktree.* (ARCHITECTURE §5.7, SPEC R9). A "worktree" is a shared clone at .smurg/worktrees/<id> (§11 D-2).

export const worktreeListPayloadSchema = emptyPayloadSchema;
export const worktreeListResultSchema = z.strictObject({
  worktrees: z.array(worktreeInfoSchema).max(LIST_MAX_ITEMS),
});

export const worktreeRemovePayloadSchema = z.strictObject({ worktreeId: opaqueIdSchema });
export const worktreeRemoveResultSchema = emptyPayloadSchema;

export const worktreeMergeRequestPayloadSchema = z.strictObject({
  worktreeId: opaqueIdSchema,
  message: mergeMessageSchema.optional(),
});
export const mergeRequestResultSchema = z.strictObject({ request: mergeRequestSchema });

export const worktreeMergeListPayloadSchema = emptyPayloadSchema;
export const worktreeMergeListResultSchema = z.strictObject({
  requests: z.array(mergeRequestSchema).max(LIST_MAX_ITEMS),
});

export const MERGE_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'unmerged',
  'unknown',
] as const;

/** One file of `git diff --numstat/--name-status`. `oldPath` for renames/copies; `binary` when git shows `-`. */
export const mergeDiffFileSchema = z.strictObject({
  path: resultPathSchema,
  status: z.enum(MERGE_FILE_STATUSES),
  additions: indexSchema,
  deletions: indexSchema,
  oldPath: resultPathSchema.optional(),
  binary: z.boolean().optional(),
});

export const worktreeMergeDiffPayloadSchema = z.strictObject({ requestId: opaqueIdSchema });
/**
 * The complete diff the host reviews (R9). `truncated` (addition): the unified diff was cut at MERGE_DIFF_MAX_BYTES
 * (msgpack's string limit); `files` is still complete up to MERGE_FILES_MAX.
 */
export const worktreeMergeDiffResultSchema = z.strictObject({
  diff: largeTextSchema(MERGE_DIFF_MAX_BYTES),
  truncated: z.boolean(),
  files: z.array(mergeDiffFileSchema).max(MERGE_FILES_MAX),
});

/**
 * (Addition) One file of the request's commit, for a whole-diff review when `worktree.merge.diff` was truncated
 * (R9: the host sees the complete diff): the UI refuses to approve until every file marked truncated was opened here. The diff
 * itself is cut at MERGE_DIFF_MAX_BYTES too (`truncated`); `binary` when git shows no text diff. The daemon answers
 * only paths listed in the request's diff `files` (never a git pathspec) and runs git with `--` before the path.
 */
export const worktreeMergeFileDiffPayloadSchema = z.strictObject({ requestId: opaqueIdSchema, path: resultPathSchema });
export const worktreeMergeFileDiffResultSchema = z.strictObject({
  path: resultPathSchema,
  diff: largeTextSchema(MERGE_DIFF_MAX_BYTES),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const worktreeMergeApprovePayloadSchema = z.strictObject({ requestId: opaqueIdSchema });

export const worktreeMergeRejectPayloadSchema = z.strictObject({
  requestId: opaqueIdSchema,
  reason: reasonTextSchema.optional(),
});

export const worktreeUpdatedPayloadSchema = z.strictObject({ worktree: worktreeInfoSchema });
export const worktreeMergeUpdatedPayloadSchema = z.strictObject({ request: mergeRequestSchema });

/** (Addition) The worktree is gone; file trees showing it switch back to the main root. */
export const worktreeRemovedPayloadSchema = z.strictObject({ worktreeId: opaqueIdSchema });
