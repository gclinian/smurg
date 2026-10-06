// `worktrees.json` in the workspace state dir (ARCHITECTURE §7.1 "worktrees, merge requests"): every worktree the
// daemon created, what it must look like on disk (integrity.ts), and every merge request, drafts included. Loaded with
// its schema: a file that does not match stops the daemon (StateStore), it is never reset.
import { z } from 'zod';
import {
  MERGE_FILES_MAX,
  MERGE_REQUEST_STATUSES,
  REVIEWERS_MAX,
  displayNameSchema,
  entryPathSchema,
  epochMsSchema,
  gitCommitSchema,
  itemIdSchema,
  mergeMessageSchema,
  mergeRequestSchema,
  opaqueIdSchema,
  reasonTextSchema,
  resultPathSchema,
  shortTextSchema,
  topicSlugSchema,
  userIdSchema,
  userRefSchema,
} from '@smurg/protocol';
import type { MergeRequest, WorktreeInfo } from '@smurg/protocol';

export const WORKTREES_DOCUMENT = 'worktrees';
export const WORKTREES_VERSION = 1;

/** Worktree ids name a directory (and a ref component): lowercase only, safe on case-insensitive file systems. */
export const WORKTREE_ID_PATTERN = /^wt_[0-9a-f]{24}$/;
/** Merge request ids name a ref (`refs/smurg/merge/<id>`), a loose file on a case-insensitive file system. */
export const MERGE_ID_PATTERN = /^mr_[0-9a-f]{24}$/;

/** Files of one item worktree the daemon remembers as edited by hand (a report shows at most REPORT_BY_HAND_MAX). */
export const HAND_EDIT_PATHS_MAX = 500;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The work item a worktree belongs to (ARCHITECTURE §5.10): what its root is registered with. */
export const storedItemSchema = z.strictObject({ topicId: opaqueIdSchema, topicSlug: topicSlugSchema, itemId: itemIdSchema });
export type StoredItem = z.infer<typeof storedItemSchema>;

/** A file of an item worktree that people edited through smurg, and who (`ReportInfo.changes.byHand`). */
export const storedHandEditSchema = z.strictObject({ path: entryPathSchema, by: z.array(userRefSchema).max(REVIEWERS_MAX) });
export type StoredHandEdit = z.infer<typeof storedHandEditSchema>;

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
  /** A work item's worktree: owned by the item, not by a session; outside the per-owner limit. */
  item: storedItemSchema.optional(),
  /**
   * The main workspace's HEAD that the daemon merged into the working tree WITHOUT committing (updateFromMain), and
   * the files git left with conflict markers. The next commit of the working tree gets `parent` as its second
   * parent, is refused while one of `conflicted` still has a marker line, and clears this.
   */
  merge: z.strictObject({ parent: gitCommitSchema, conflicted: z.array(resultPathSchema).max(MERGE_FILES_MAX) }).optional(),
  /** Item worktrees: the files people edited there by hand, oldest first. */
  handEdits: z.array(storedHandEditSchema).max(HAND_EDIT_PATHS_MAX).optional(),
});
export type StoredWorktree = z.infer<typeof storedWorktreeSchema>;

export const storedMergeSchema = z.strictObject({
  id: opaqueIdSchema.regex(MERGE_ID_PATTERN),
  worktreeId: opaqueIdSchema,
  /** The worktree's owner when the request was made: kept here because the worktree may be removed later. */
  ownerUserId: userIdSchema,
  /** Absent while the request is a draft (the daemon's snapshot of a work item: nobody asked yet). */
  requestedBy: userRefSchema.optional(),
  message: mergeMessageSchema.optional(),
  commit: gitCommitSchema,
  status: z.enum(MERGE_REQUEST_STATUSES),
  /** The request's result report was reviewed (WorktreeManager.setReviewed). Absent: no. */
  reviewed: z.literal(true).optional(),
  /** The work item whose changes these are; the slug is kept for the policy check at approval (the worktree may be gone). */
  topicId: opaqueIdSchema.optional(),
  itemId: itemIdSchema.optional(),
  topicSlug: topicSlugSchema.optional(),
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
    ...(record.item !== undefined ? { topicId: record.item.topicId, itemId: record.item.itemId } : {}),
  };
}

export function toMergeRequest(record: StoredMerge): MergeRequest {
  const request: MergeRequest = {
    id: record.id,
    worktreeId: record.worktreeId,
    commit: record.commit,
    status: record.status,
    reviewed: record.reviewed === true,
    createdAt: record.createdAt,
    ...(record.requestedBy !== undefined ? { requestedBy: { ...record.requestedBy } } : {}),
    ...(record.topicId !== undefined ? { topicId: record.topicId } : {}),
    ...(record.itemId !== undefined ? { itemId: record.itemId } : {}),
    ...(record.message !== undefined ? { message: record.message } : {}),
    ...(record.conflictFiles !== undefined ? { conflictFiles: [...record.conflictFiles] } : {}),
    ...(record.decidedAt !== undefined ? { decidedAt: record.decidedAt } : {}),
    ...(record.rejectReason !== undefined ? { rejectReason: record.rejectReason } : {}),
  };
  return mergeRequestSchema.parse(request);
}
