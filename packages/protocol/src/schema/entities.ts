import { z } from 'zod';
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE } from '../constants.ts';
import { FORBIDDEN_RECORD_KEYS } from '../errors.ts';
import { roleSchema } from '../roles.ts';
import {
  ACTIVITY_SUMMARY_MAX_CHARS,
  AUDIT_DETAIL_MAX_KEYS,
  AUDIT_TARGET_MAX_CHARS,
  CONFLICT_HUNKS_MAX,
  CONFLICT_TEXT_MAX_BYTES,
  DEVICES_PER_MEMBER_MAX,
  LIST_MAX_ITEMS,
  MERGE_FILES_MAX,
  MERGE_MESSAGE_MAX_CHARS,
  REASON_MAX_CHARS,
  SHARED_DIRS_MAX,
  SUGGESTION_TEXT_MAX_CHARS,
  TERMINAL_COLS_MAX,
  TERMINAL_ROWS_MAX,
} from './limits.ts';
import { messageRefSchema } from './message-ref.ts';
import { entryPathSchema, entryRefSchema, fileRefSchema, pathSegmentSchema, relPathSchema, rootRefSchema } from './paths.ts';
import {
  avatarUrlSchema,
  byteCountSchema,
  colorSchema,
  displayNameSchema,
  epochMsSchema,
  fileTimeMsSchema,
  indexSchema,
  largeTextSchema,
  lineTextSchema,
  multilineTextSchema,
  opaqueIdSchema,
  shortTextSchema,
  userIdSchema,
  workspaceIdSchema,
} from './primitives.ts';

// Shared types of the message catalog (ARCHITECTURE §3 and §5). Where the architecture abbreviates a field
// (`{ id; at; actor }`), the precise rule is the one in primitives.ts: ids are strings, times are epoch ms,
// sizes/offsets/counts are non-negative safe integers, text is bounded.

// ---------------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------------

/** `{ userId, displayName }`: suggestion authors, merge requesters, lock holders, conflict participants. */
export const userRefSchema = z.strictObject({ userId: userIdSchema, displayName: displayNameSchema });
export type UserRef = z.infer<typeof userRefSchema>;

/** Who did something (ARCHITECTURE §3). An agent's displayName is `Claude (<owner>)` (agentDisplayName). */
export const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: userIdSchema, displayName: displayNameSchema }),
  z.strictObject({
    kind: z.literal('agent'),
    sessionId: opaqueIdSchema,
    ownerUserId: userIdSchema,
    displayName: displayNameSchema,
  }),
  z.strictObject({ kind: z.literal('system') }),
]);
export type Actor = z.infer<typeof actorSchema>;

export const memberSchema = z.strictObject({
  userId: userIdSchema,
  displayName: displayNameSchema,
  avatarUrl: avatarUrlSchema.optional(),
  role: roleSchema,
  color: colorSchema,
  online: z.boolean(),
  joinedAt: epochMsSchema,
});
export type Member = z.infer<typeof memberSchema>;

export const PLATFORMS = ['darwin', 'linux'] as const;
export const platformSchema = z.enum(PLATFORMS);

export const workspaceInfoSchema = z.strictObject({
  id: workspaceIdSchema,
  /** Name of the shared folder, for display. */
  name: shortTextSchema.pipe(z.string().min(1)),
  hostUserId: userIdSchema,
  hostName: displayNameSchema,
  platform: platformSchema,
  isGitRepo: z.boolean(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

export const HUMAN_LOCK_IDLE_MS_RANGE = { min: 1_000, max: 3_600_000 } as const;
export const AGENT_LOCK_TIMEOUT_MS_RANGE = { min: 1_000, max: 600_000 } as const;

/**
 * Settings every member receives in the Welcome. `sharedDirs` are paths in the main root (D12). (Protocol 2,
 * ARCHITECTURE §11 D-15: the guest switches `guestSubscriptionLogin` and `guestMainWorkspace` of protocol 1 are gone
 * with the guest sandbox.)
 */
export const publicSettingsSchema = z.strictObject({
  humanLockIdleMs: z.int().min(HUMAN_LOCK_IDLE_MS_RANGE.min).max(HUMAN_LOCK_IDLE_MS_RANGE.max),
  agentLockTimeoutMs: z.int().min(AGENT_LOCK_TIMEOUT_MS_RANGE.min).max(AGENT_LOCK_TIMEOUT_MS_RANGE.max),
  uploadChunkSize: z.int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
  sharedDirs: z.array(entryPathSchema).max(SHARED_DIRS_MAX),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

/**
 * Host-only settings. `diskReservePercent` is a percentage of the volume size (0–100); bytes are bytes (5 GiB = 5 × 2^30).
 * (Protocol 2: the guest sandbox's network allow-list `allowedDomains` is gone.)
 */
export const hostSettingsSchema = publicSettingsSchema.extend({
  diskReserveBytes: byteCountSchema,
  diskReservePercent: z.number().min(0).max(100),
});
export type HostSettings = z.infer<typeof hostSettingsSchema>;

/** `admin.settings.set` payload: `Partial<HostSettings>` (unknown keys are refused, not ignored). */
export const hostSettingsPatchSchema = hostSettingsSchema.partial();
export type HostSettingsPatch = z.infer<typeof hostSettingsPatchSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Files, disk, locks
// ---------------------------------------------------------------------------------------------------------------

/**
 * Disk check of an upload (ARCHITECTURE §5.2). All values are bytes. `freeAfterBytes` is
 * `availableBytes − pendingBytes − requestedBytes` and may be negative; `ok` ⇔ `freeAfterBytes ≥ reserveBytes`.
 */
export const diskReportSchema = z.strictObject({
  totalBytes: byteCountSchema,
  availableBytes: byteCountSchema,
  reserveBytes: byteCountSchema,
  pendingBytes: byteCountSchema,
  requestedBytes: byteCountSchema,
  freeAfterBytes: z.int(),
  ok: z.boolean(),
});
export type DiskReport = z.infer<typeof diskReportSchema>;

export const humanLockHolderSchema = z.strictObject({
  userId: userIdSchema,
  displayName: displayNameSchema,
  lastActivityAt: epochMsSchema,
});

/** A file lock (SPEC R8, ARCHITECTURE §5.4). */
export const lockInfoSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('human'),
    file: fileRefSchema,
    holders: z.array(humanLockHolderSchema).min(1).max(LIST_MAX_ITEMS),
    acquiredAt: epochMsSchema,
  }),
  z.strictObject({
    kind: z.literal('agent'),
    file: fileRefSchema,
    sessionId: opaqueIdSchema,
    ownerUserId: userIdSchema,
    /** `Claude (<owner>)` */
    agentName: displayNameSchema,
    acquiredAt: epochMsSchema,
    expiresAt: epochMsSchema,
  }),
]);
export type LockInfo = z.infer<typeof lockInfoSchema>;

export const FILE_ENTRY_KINDS = ['file', 'dir', 'symlink'] as const;

/** The name of an entry: one path segment, or `""` for a root. */
const entryNameSchema = z.union([z.literal(''), pathSegmentSchema]);

export const fileEntrySchema = z.strictObject({
  name: entryNameSchema,
  path: relPathSchema,
  kind: z.enum(FILE_ENTRY_KINDS),
  size: byteCountSchema,
  /** Epoch ms, floored (fs reports fractional ms). */
  mtime: fileTimeMsSchema,
  /** e.g. inside a shared read-only dir of a worktree */
  readOnly: z.boolean().optional(),
  lock: lockInfoSchema.optional(),
  /** drives the tree badge ("recently changed by Claude (Ian)") */
  lastModifiedBy: actorSchema.optional(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** Relative paths in results (worktree conflict files, merge diffs); `""` is never meaningful there. */
export const resultPathSchema = entryPathSchema;

// ---------------------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------------------

/** One overlapping region kept for the human (yjs-monaco.md Q5). Texts are truncated to CONFLICT_TEXT_MAX_BYTES. */
export const conflictHunkSchema = z.strictObject({
  humanText: largeTextSchema(CONFLICT_TEXT_MAX_BYTES),
  agentText: largeTextSchema(CONFLICT_TEXT_MAX_BYTES),
  baseText: largeTextSchema(CONFLICT_TEXT_MAX_BYTES),
  /** 1-based line in the merged document where the kept human text starts. */
  startLine: z.int().min(1),
  /** Set when any of the three texts was cut to CONFLICT_TEXT_MAX_BYTES. */
  truncated: z.boolean().optional(),
});
export type ConflictHunk = z.infer<typeof conflictHunkSchema>;

export const CONFLICT_STATUSES = ['open', 'dismissed', 'applied'] as const;

/**
 * A conflict between human text and an external write (ARCHITECTURE §5.3). The full text the agent/process wrote is
 * not inline (it can be as large as a whole document, which exceeds msgpack's string limit): its size is
 * `agentVersionBytes` and `doc.conflict.get` returns it as bytes.
 */
export const conflictRecordSchema = z.strictObject({
  id: opaqueIdSchema,
  file: fileRefSchema,
  createdAt: epochMsSchema,
  /** the agent, or `system` for an unknown process */
  source: actorSchema,
  humans: z.array(userRefSchema).max(LIST_MAX_ITEMS),
  hunks: z.array(conflictHunkSchema).max(CONFLICT_HUNKS_MAX),
  /** Hunks beyond CONFLICT_HUNKS_MAX that are not listed. */
  hunksOmitted: indexSchema.optional(),
  /** UTF-8 size of the full agent version. */
  agentVersionBytes: byteCountSchema,
  status: z.enum(CONFLICT_STATUSES),
});
export type ConflictRecord = z.infer<typeof conflictRecordSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------------------

export const SESSION_STATUSES = ['starting', 'running', 'exited'] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** A Claude Code session, or a plain shell. (Protocol 1's guest `login` process is gone, ARCHITECTURE §11 D-15.) */
export const SESSION_KINDS = ['agent', 'terminal'] as const;
export const sessionKindSchema = z.enum(SESSION_KINDS);
export type SessionKind = z.infer<typeof sessionKindSchema>;

export const LOGIN_STATES = ['unknown', 'logged-out', 'logged-in'] as const;
export const loginStateSchema = z.enum(LOGIN_STATES);
export type LoginState = z.infer<typeof loginStateSchema>;

/**
 * Why an exited session ended (a session the host terminated must not look like a normal exit to its
 * owner): its process exited by itself (`exit`), its owner ended it, the host terminated it, its owner (the member who
 * opened it) was kicked / left / lost the role `agent` ("Agent access"), or the daemon stopped. Same words as the daemon's
 * `session.exited`.
 */
export const SESSION_END_REASONS = ['exit', 'ended', 'terminated', 'kicked', 'left', 'role-changed', 'stopped'] as const;
export const sessionEndReasonSchema = z.enum(SESSION_END_REASONS);
export type SessionEndReason = z.infer<typeof sessionEndReasonSchema>;

export const terminalColsSchema = z.int().min(1).max(TERMINAL_COLS_MAX);
export const terminalRowsSchema = z.int().min(1).max(TERMINAL_ROWS_MAX);

/**
 * A PTY session. Every session runs like the host's own (ARCHITECTURE §11 D-15): the host's OS user, unsandboxed, the
 * host's Claude Code login. `ownerUserId` / `ownerName`: the member who OPENED it (attribution: the agent is
 * `Claude (ownerName)`, its locks and edits carry ownerUserId). `login` is the host's Claude login as that session
 * sees it. (Protocol 1's `sandboxed` is gone.)
 */
export const sessionInfoSchema = z.strictObject({
  id: opaqueIdSchema,
  kind: sessionKindSchema,
  ownerUserId: userIdSchema,
  ownerName: displayNameSchema,
  /**
   * Present only when the opener typed a title. Without it a client shows the default built from `kind` + `ownerName`
   * in the viewer's language (`session.title.agent` / `session.title.terminal` of `@smurg/protocol/i18n`).
   */
  title: shortTextSchema.optional(),
  root: rootRefSchema,
  status: sessionStatusSchema,
  exitCode: z.int().optional(),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  createdAt: epochMsSchema,
  endedAt: epochMsSchema.optional(),
  /** Set with status 'exited'. */
  endReason: sessionEndReasonSchema.optional(),
  /** The person who ended it (the owner for 'ended', the host for 'terminated'), when a person did. */
  endedBy: z.strictObject({ userId: userIdSchema, displayName: displayNameSchema }).optional(),
  login: loginStateSchema,
  /** clients currently attached */
  attached: indexSchema,
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------------------------

/** Suggestion text: multi-line, no control characters but tab/LF (it is pasted into a PTY). */
export const suggestionTextSchema = multilineTextSchema(SUGGESTION_TEXT_MAX_CHARS, 1).refine(
  (text) => /\S/u.test(text),
  'suggestion is blank',
);

/** A code selection a suggestion was made from; lines are 1-based and inclusive. */
export const suggestionSourceSchema = z
  .strictObject({ file: entryRefSchema, startLine: z.int().min(1), endLine: z.int().min(1) })
  .refine((source) => source.endLine >= source.startLine, 'endLine < startLine');

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'accepted-modified', 'rejected', 'withdrawn'] as const;

export const reasonTextSchema = lineTextSchema(REASON_MAX_CHARS);

/** Why a suggestion was closed without a person deciding on it. */
export const SUGGESTION_CLOSED_REASONS = ['session-ended', 'author-kicked', 'author-demoted'] as const;
export type SuggestionClosedReason = (typeof SUGGESTION_CLOSED_REASONS)[number];

export const suggestionSchema = z.strictObject({
  id: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  author: userRefSchema,
  text: suggestionTextSchema,
  source: suggestionSourceSchema.optional(),
  status: z.enum(SUGGESTION_STATUSES),
  createdAt: epochMsSchema,
  resolvedAt: epochMsSchema.optional(),
  /** the text actually sent to the agent (differs from `text` for accepted-modified) */
  finalText: suggestionTextSchema.optional(),
  /** A person's words (the member who rejected it). Never written by the daemon. */
  rejectReason: reasonTextSchema.optional(),
  /**
   * Why the daemon itself closed the suggestion (its session ended: `rejected`; its author was kicked or lost the
   * right to suggest: `withdrawn`). Nobody decided it; clients word the reason themselves.
   */
  closedReason: z.enum(SUGGESTION_CLOSED_REASONS).optional(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------------------------------------------

export const worktreeInfoSchema = z.strictObject({
  id: opaqueIdSchema,
  ownerUserId: userIdSchema,
  ownerName: displayNameSchema,
  /** git branch, e.g. smurg/<owner>/<id> */
  branch: shortTextSchema.pipe(z.string().min(1)),
  sessionId: opaqueIdSchema.optional(),
  kept: z.boolean(),
  createdAt: epochMsSchema,
  /** shared read-only dirs linked into this worktree (paths in the main root) */
  sharedDirs: z.array(entryPathSchema).max(SHARED_DIRS_MAX),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

export const MERGE_REQUEST_STATUSES = ['pending', 'merged', 'rejected', 'conflict'] as const;

export const mergeMessageSchema = multilineTextSchema(MERGE_MESSAGE_MAX_CHARS);

/** A full git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
export const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, 'not a git commit id');

export const mergeRequestSchema = z.strictObject({
  id: opaqueIdSchema,
  worktreeId: opaqueIdSchema,
  requestedBy: userRefSchema,
  message: mergeMessageSchema.optional(),
  /**
   * The commit under review: worktree.merge.request commits the worktree's working tree (as the owner, with
   * `message`) onto its branch and fetches it into refs/smurg/merge/<id>. worktree.merge.diff / .fileDiff show exactly
   * this commit and worktree.merge.approve merges exactly this commit, whatever happened in the worktree since.
   */
  commit: gitCommitSchema,
  status: z.enum(MERGE_REQUEST_STATUSES),
  /** set with status `conflict` */
  conflictFiles: z.array(resultPathSchema).max(MERGE_FILES_MAX).optional(),
  createdAt: epochMsSchema,
  decidedAt: epochMsSchema.optional(),
  /** reason given by the host with worktree.merge.reject */
  rejectReason: reasonTextSchema.optional(),
});
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Presence and activity
// ---------------------------------------------------------------------------------------------------------------

export const presenceMemberSchema = memberSchema.extend({
  /** open channels of this member */
  connections: indexSchema,
  activeFile: fileRefSchema.optional(),
});
export type PresenceMember = z.infer<typeof presenceMemberSchema>;

export const presenceAgentSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  ownerUserId: userIdSchema,
  /** `Claude (<owner>)` */
  displayName: displayNameSchema,
  color: colorSchema,
  activeFile: fileRefSchema.optional(),
  status: sessionStatusSchema,
});
export type PresenceAgent = z.infer<typeof presenceAgentSchema>;

export const ACTIVITY_KINDS = [
  'agent.edit',
  'human.edit',
  'file.create',
  'file.delete',
  'file.rename',
  'file.upload',
  'external.change',
  'conflict',
  'lock.denied',
  /** A worktree merge request, its approval, rejection or conflict: everyone sees merges in the feed. */
  'merge',
] as const;

export const activityEventSchema = z.strictObject({
  id: opaqueIdSchema,
  at: epochMsSchema,
  actor: actorSchema,
  kind: z.enum(ACTIVITY_KINDS),
  file: fileRefSchema.optional(),
  /**
   * The sentence as a message reference (`activity.*` of `@smurg/protocol/i18n`): a client renders it in the viewer's
   * language (`render(locale, event.text) ?? event.summary`). Parameters are clipped by the daemon (a path to 200
   * characters, at most 3 sample paths, at most 5 holder names).
   */
  text: messageRefSchema,
  /** The English rendering of `text`, at most ACTIVITY_SUMMARY_MAX_CHARS: the fallback, and what logs show. */
  summary: lineTextSchema(ACTIVITY_SUMMARY_MAX_CHARS),
  /**
   * (addition, ARCHITECTURE §11 D-13) How an `agent.edit` was attributed when it is not the agent's own edit tool:
   * `bash` = a change inside the agent's shell-command window. Clients mark such entries from this field, never from the
   * wording. Absent everywhere else.
   */
  via: z.literal('bash').optional(),
  /** On a `file.rename` event: the path the entry had before, relative to `file.root` (`file.path` is the new one). */
  renamedFrom: entryPathSchema.optional(),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------------------------

export const inviteInfoSchema = z.strictObject({
  id: opaqueIdSchema,
  role: roleSchema,
  createdAt: epochMsSchema,
  expiresAt: epochMsSchema.optional(),
  maxUses: z.int().min(1).optional(),
  uses: indexSchema,
  revoked: z.boolean(),
});
export type InviteInfo = z.infer<typeof inviteInfoSchema>;

export const CLIENT_KINDS = ['web', 'cli'] as const;
export const clientKindSchema = z.enum(CLIENT_KINDS);

export const deviceInfoSchema = z.strictObject({
  deviceId: opaqueIdSchema,
  name: shortTextSchema,
  kind: clientKindSchema,
  addedAt: epochMsSchema,
  lastSeenAt: epochMsSchema,
  revoked: z.boolean(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const memberWithDevicesSchema = memberSchema.extend({
  devices: z.array(deviceInfoSchema).max(DEVICES_PER_MEMBER_MAX),
});
export type MemberWithDevices = z.infer<typeof memberWithDevicesSchema>;

/** Audit `action` vocabulary (ARCHITECTURE §5.8) plus `member.leave` and `doc.conflict-resolve` (additions). */
export const AUDIT_ACTIONS = [
  'auth.join',
  'auth.connect',
  'auth.disconnect',
  'auth.rejected',
  'authz.denied',
  'path.denied',
  'file.write',
  'file.create',
  'file.rename',
  'file.delete',
  'file.upload',
  'file.download',
  'doc.edit',
  'agent.edit',
  'external.change',
  'doc.conflict',
  'doc.conflict-resolve',
  'lock.acquire',
  'lock.release',
  'lock.denied',
  'lock.force-release',
  'session.create',
  'session.end',
  'session.terminate',
  'suggest.create',
  'suggest.edit',
  'suggest.accept',
  'suggest.reject',
  'suggest.withdraw',
  'worktree.create',
  'worktree.remove',
  'worktree.merge.request',
  'worktree.merge.approve',
  'worktree.merge.reject',
  'member.role',
  'member.kick',
  'member.leave',
  'invite.create',
  'invite.revoke',
  'device.revoke',
  'settings.change',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_OUTCOMES = ['ok', 'denied', 'error'] as const;

/** Free-form audit detail. Never put sensitive payload fields here (see the registry's `sensitive` flags). */
export const auditDetailSchema = z
  .record(z.string().min(1).max(64), z.unknown())
  .refine((detail) => Object.keys(detail).length <= AUDIT_DETAIL_MAX_KEYS, `at most ${AUDIT_DETAIL_MAX_KEYS} keys`)
  .refine((detail) => Object.keys(detail).every((key) => !FORBIDDEN_RECORD_KEYS.has(key)), 'forbidden key');

export const auditEntrySchema = z.strictObject({
  id: opaqueIdSchema,
  /** strictly increasing within one audit log, so `admin.audit.query.before` is an exact cursor */
  at: epochMsSchema,
  actor: actorSchema,
  action: auditActionSchema,
  target: lineTextSchema(AUDIT_TARGET_MAX_CHARS).optional(),
  outcome: z.enum(AUDIT_OUTCOMES),
  detail: auditDetailSchema.optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
