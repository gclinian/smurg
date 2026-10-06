// `worktrees.json` in the workspace state dir (ARCHITECTURE §7.1 "worktrees, merge requests"): every worktree the
// daemon created, what it must look like on disk (integrity.ts), and every merge request. Loaded with its schema: a
// file that does not match stops the daemon (StateStore), it is never reset.
import { z } from 'zod';
import {
  displayNameSchema,
  entryPathSchema,
  epochMsSchema,
  gitCommitSchema,
  mergeMessageSchema,
  mergeRequestSchema,
  opaqueIdSchema,
  reasonTextSchema,
  resultPathSchema,
  shortTextSchema,
  userIdSchema,
} from '@smurg/protocol';
import type { MergeRequest, WorktreeInfo } from '@smurg/protocol';

export const WORKTREES_DOCUMENT = 'worktrees';
export const WORKTREES_VERSION = 1;

/** Worktree ids name a directory (and a ref component): lowercase only, safe on case-insensitive file systems. */
export const WORKTREE_ID_PATTERN = /^wt_[0-9a-f]{24}$/;
/** Merge request ids name a ref (`refs/smurg/merge/<id>`), a loose file on a case-insensitive file system. */
export const MERGE_ID_PATTERN = /^mr_[0-9a-f]{24}$/;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const storedWorktreeSchema = z.strictObject({
  id: opaqueIdSchema.regex(WORKTREE_ID_PATTERN),
  ownerUserId: userIdSchema,
  ownerName: displayNameSchema,
  branch: shortTextSchema.pipe(z.string().min(1)),
  sessionId: opaqueIdSchema.optional(),
  kept: z.boolean(),
  createdAt: epochMsSchema,
  /** Main-root paths of the shared read-only dirs linked in (D12); the link sits at the same path in the worktree. */
  sharedDirs: z.array(entryPathSchema).max(64),
  /** The main workspace's HEAD the branch started from. */
  baseCommit: gitCommitSchema,
  /** SHA-256 of `.git/config`, `.git/HEAD` and `.git/objects/info/alternates` as the daemon left them. */
  configHash: sha256HexSchema,
  headHash: sha256HexSchema,
  alternatesHash: sha256HexSchema,
});
export type StoredWorktree = z.infer<typeof storedWorktreeSchema>;

export const storedMergeSchema = z.strictObject({
  id: opaqueIdSchema.regex(MERGE_ID_PATTERN),
  worktreeId: opaqueIdSchema,
  /** The worktree's owner (the only one who may request): kept here because the worktree may be removed later. */
  ownerUserId: userIdSchema,
  requestedBy: z.strictObject({ userId: userIdSchema, displayName: displayNameSchema }),
  message: mergeMessageSchema.optional(),
  commit: gitCommitSchema,
  status: z.enum(['pending', 'merged', 'rejected', 'conflict']),
  conflictFiles: z.array(resultPathSchema).max(10_000).optional(),
  createdAt: epochMsSchema,
  decidedAt: epochMsSchema.optional(),
  rejectReason: reasonTextSchema.optional(),
  /** The merge commit written into the main workspace (status merged; absent when it was already up to date). */
  mergeCommit: gitCommitSchema.optional(),
});
export type StoredMerge = z.infer<typeof storedMergeSchema>;

export const worktreesDocumentSchema = z.strictObject({
  version: z.literal(WORKTREES_VERSION),
  worktrees: z.array(storedWorktreeSchema).max(256),
  merges: z.array(storedMergeSchema).max(1_000),
});
export type WorktreesDocument = z.infer<typeof worktreesDocumentSchema>;

export function initialWorktreesDocument(): WorktreesDocument {
  return { version: WORKTREES_VERSION, worktrees: [], merges: [] };
}

export function toWorktreeInfo(record: StoredWorktree): WorktreeInfo {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    ownerName: record.ownerName,
    branch: record.branch,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    kept: record.kept,
    createdAt: record.createdAt,
    sharedDirs: [...record.sharedDirs],
  };
}

export function toMergeRequest(record: StoredMerge): MergeRequest {
  const request: MergeRequest = {
    id: record.id,
    worktreeId: record.worktreeId,
    requestedBy: { ...record.requestedBy },
    commit: record.commit,
    status: record.status,
    reviewed: false,
    createdAt: record.createdAt,
    ...(record.message !== undefined ? { message: record.message } : {}),
    ...(record.conflictFiles !== undefined ? { conflictFiles: [...record.conflictFiles] } : {}),
    ...(record.decidedAt !== undefined ? { decidedAt: record.decidedAt } : {}),
    ...(record.rejectReason !== undefined ? { rejectReason: record.rejectReason } : {}),
  };
  return mergeRequestSchema.parse(request);
}
