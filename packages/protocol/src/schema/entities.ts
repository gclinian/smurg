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
  ESCALATE_AFTER_MS_RANGE,
  ITEM_ID_MAX_CHARS,
  ITEM_TITLE_MAX_CHARS,
  MAX_LIVE_AGENTS_RANGE,
  MENTIONS_PER_TEXT_MAX,
  RULE_PATTERN_MAX_CHARS,
  SHARED_DIRS_MAX,
  SUGGESTION_TEXT_MAX_CHARS,
  TERMINAL_COLS_MAX,
  TERMINAL_ROWS_MAX,
  TOPIC_NAME_MAX_CHARS,
  TOPIC_SLUG_MAX_CHARS,
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
 * (Protocol 2: the guest sandbox's network allow-list `allowedDomains` is gone. Protocol 4 added the three agent settings.)
 */
export const hostSettingsSchema = publicSettingsSchema.extend({
  diskReserveBytes: byteCountSchema,
  diskReservePercent: z.number().min(0).max(100),
  /** Processes of work items the scheduler may keep alive at once (a person's message always gets a process). */
  maxLiveAgents: z.int().min(MAX_LIVE_AGENTS_RANGE.min).max(MAX_LIVE_AGENTS_RANGE.max),
  /** How long a question or a permission request waits before it also reaches the others who may settle it. */
  escalateAfterMs: z.int().min(ESCALATE_AFTER_MS_RANGE.min).max(ESCALATE_AFTER_MS_RANGE.max),
  /** "Agents may use my own and this project's MCP servers": off, execution and free sessions get only smurg's own. */
  agentMcp: z.boolean(),
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
// Sessions (ARCHITECTURE §5.5)
// ---------------------------------------------------------------------------------------------------------------

/** A plain shell in a PTY (`terminal`), or a Claude Code conversation in structured mode (`agent`). */
export const SESSION_KINDS = ['agent', 'terminal'] as const;
export const sessionKindSchema = z.enum(SESSION_KINDS);
export type SessionKind = z.infer<typeof sessionKindSchema>;

export const TERMINAL_STATUSES = ['starting', 'running', 'exited'] as const;
export const terminalStatusSchema = z.enum(TERMINAL_STATUSES);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

/**
 * An agent session's status. When several apply the most urgent one shows: `failed`, `waiting-permission`,
 * `waiting-answer`, `stalled`, `running`, `idle`. `stalled`: an execution session that is idle without a registered
 * result report. `done`: an execution session whose item has a registered report and that is idle. `failed` is left by
 * the next message or `session.retry`. `ended` is final. A parked session (no process) is `idle`.
 */
export const AGENT_STATUSES = ['starting', 'running', 'waiting-answer', 'waiting-permission', 'idle', 'stalled', 'done', 'failed', 'ended'] as const;
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const LOGIN_STATES = ['unknown', 'logged-out', 'logged-in'] as const;
export const loginStateSchema = z.enum(LOGIN_STATES);
export type LoginState = z.infer<typeof loginStateSchema>;

/**
 * Why a session ended. `exit`: its process exited by itself (terminals); `ended`: a member ended it; `terminated`: the
 * host did, in the console; `kicked` / `left` / `role-changed`: the member who opened it went (terminals and free
 * sessions; topic sessions pass to the host instead); `stopped`: the daemon stopped (terminals); `worktree-removed`;
 * `archived`: its topic was archived; `replaced`: a new discussion was started for its topic; `merged`: its work item
 * was merged and reviewed.
 */
export const SESSION_END_REASONS = [
  'exit',
  'ended',
  'terminated',
  'kicked',
  'left',
  'role-changed',
  'stopped',
  'worktree-removed',
  'archived',
  'replaced',
  'merged',
] as const;
export const sessionEndReasonSchema = z.enum(SESSION_END_REASONS);
export type SessionEndReason = z.infer<typeof sessionEndReasonSchema>;

export const terminalColsSchema = z.int().min(1).max(TERMINAL_COLS_MAX);
export const terminalRowsSchema = z.int().min(1).max(TERMINAL_ROWS_MAX);

/** `ask-commands`: edits are automatic, commands ask. `ask-all`: edits ask too. A discussion session has neither (`modeFixed`). */
export const PERMISSION_MODES = ['ask-all', 'ask-commands'] as const;
export const permissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const REMEMBERED_RULE_TOOLS = ['Bash', 'WebFetch'] as const;
export const rememberedRuleToolSchema = z.enum(REMEMBERED_RULE_TOOLS);
/** The inside of a rule (`pnpm test *`, `domain:example.com`); the checked forms are in rules.ts. */
export const rulePatternSchema = z
  .string()
  .min(1)
  .max(RULE_PATTERN_MAX_CHARS)
  .regex(/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/, 'not a rule pattern');

/** An always-allowed kind ("Always allow this kind"), for one session or for every session of a topic. */
export const rememberedRuleSchema = z.strictObject({
  id: opaqueIdSchema,
  tool: rememberedRuleToolSchema,
  pattern: rulePatternSchema,
  scope: z.enum(['session', 'topic']),
  addedBy: userRefSchema,
  addedAt: epochMsSchema,
});
export type RememberedRule = z.infer<typeof rememberedRuleSchema>;

/** A topic's folder name: `specs/<slug>`. */
export const TOPIC_SLUG_PATTERN = new RegExp(`^[a-z0-9][a-z0-9-]{0,${TOPIC_SLUG_MAX_CHARS - 1}}$`);
export const topicSlugSchema = z.string().regex(TOPIC_SLUG_PATTERN, 'not a topic slug');
/** A work item's id, from PLAN.md. */
export const ITEM_ID_PATTERN = new RegExp(`^[a-z0-9][a-z0-9-]{0,${ITEM_ID_MAX_CHARS - 1}}$`);
export const itemIdSchema = z.string().regex(ITEM_ID_PATTERN, 'not a work item id');
/** A topic's name as people typed it (any language; the folder is the slug). */
export const topicNameSchema = lineTextSchema(TOPIC_NAME_MAX_CHARS, 1).refine((name) => /\S/u.test(name), 'name is blank');
/** A work item's title, from PLAN.md. */
export const itemTitleSchema = lineTextSchema(ITEM_TITLE_MAX_CHARS, 1);

/** `openedBy`: who created the session (attribution; never changes). `endedBy`: the person who ended it, when one did. */
const sessionCommon = {
  id: opaqueIdSchema,
  openedBy: userRefSchema,
  root: rootRefSchema,
  createdAt: epochMsSchema,
  endedAt: epochMsSchema.optional(),
  endReason: sessionEndReasonSchema.optional(),
  endedBy: userRefSchema.optional(),
};

/** A plain shell in a PTY. It runs as the host's OS user, unsandboxed (ARCHITECTURE §11 D-15). */
export const terminalSessionSchema = z.strictObject({
  kind: z.literal('terminal'),
  ...sessionCommon,
  /** Present only when the opener typed one; without it a client shows `session.title.terminal` in its language. */
  title: shortTextSchema.optional(),
  status: terminalStatusSchema,
  exitCode: z.int().optional(),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  /** clients currently attached */
  attached: indexSchema,
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

export const AGENT_PURPOSES = ['discussion', 'item', 'free'] as const;
export const agentPurposeSchema = z.enum(AGENT_PURPOSES);
export type AgentPurpose = z.infer<typeof agentPurposeSchema>;

export const PROJECT_SETTINGS_STATES = ['used', 'ignored', 'none'] as const;
export const projectSettingsStateSchema = z.enum(PROJECT_SETTINGS_STATES);
export type ProjectSettingsState = z.infer<typeof projectSettingsStateSchema>;

/**
 * A Claude Code conversation (structured mode). `purpose`: a topic's `discussion`, the session of one work `item`, or a
 * `free` session without a topic. `responsible`: whose inbox its questions and reports go to and who decides them
 * (routing only, no extra rights); null when nobody is assigned. Not here on purpose: the remembered rules
 * (`session.rules.get`), the host's own rules, and who has the session on screen.
 */
export const agentSessionSchema = z
  .strictObject({
    kind: z.literal('agent'),
    ...sessionCommon,
    purpose: agentPurposeSchema,
    topicId: opaqueIdSchema.optional(),
    itemId: itemIdSchema.optional(),
    /** 1 for the first session of an item; a retry of a stopped item is a new session with the next number. */
    attempt: z.int().min(1).optional(),
    /** The topic's name, kept current by the daemon: a client names the session without loading the topic. */
    topicName: topicNameSchema.optional(),
    /** The work item's number and title as PLAN.md has them now (`number` 0: the item left the plan). */
    item: z.strictObject({ number: indexSchema, title: itemTitleSchema }).optional(),
    responsible: userRefSchema.nullable(),
    /**
     * Only what a person gave: the title typed in `session.create`, the first 40 characters of a FREE session's first
     * message (`titleFromFirstMessage`), or `session.rename`. A topic's session has none until someone renames it.
     * Without it a client shows `sessionTitleRef(session)` in the viewer's language.
     */
    title: shortTextSchema.optional(),
    /** The worktree's branch, for the header strip. */
    branch: shortTextSchema.pipe(z.string().min(1)).optional(),
    status: agentStatusSchema,
    /** Since when it waits for an answer or a permission. */
    waitingSince: epochMsSchema.optional(),
    /** When the turn that is running now started ("Claude is revising · 20 s"); absent between turns. */
    runningSince: epochMsSchema.optional(),
    doing: z.literal('compacting').optional(),
    /** It failed to start three times in a row: only the host may try again. */
    retryHostOnly: z.literal(true).optional(),
    permissionMode: permissionModeSchema,
    /** A discussion session: its permissions are fixed. */
    modeFixed: z.boolean(),
    /** How many always-allowed kinds apply (the session's and its topic's). */
    ruleCount: indexSchema,
    login: loginStateSchema,
    claudeVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/, 'not a version').optional(),
    projectSettings: projectSettingsStateSchema,
    /** The last turn end, card, report, failure or person's message: what makes a row bold in the session list. */
    noteworthyAt: epochMsSchema,
    /** `seq` of the newest conversation event (0: none yet). */
    lastSeq: indexSchema,
    lastActivityAt: epochMsSchema,
  })
  .refine((s) => (s.purpose === 'free') === (s.topicId === undefined), 'a topic session has topicId; a free session has none')
  .refine((s) => (s.purpose === 'item') === (s.itemId !== undefined), 'exactly an item session has itemId')
  .refine((s) => (s.topicId === undefined) === (s.topicName === undefined), 'topicName goes with topicId')
  .refine((s) => (s.itemId === undefined) === (s.item === undefined), 'item goes with itemId')
  .refine((s) => (s.purpose === 'item') === (s.attempt !== undefined), 'exactly an item session has attempt');
export type AgentSession = z.infer<typeof agentSessionSchema>;

/**
 * The state of the host's Claude account as the workspace sees it (ONE state per workspace, not per session).
 * `usage-limit`: `resetsAt` when Claude Code reported it. `sessions`: how many agent sessions it stops right now.
 */
export const ACCOUNT_STATES = ['ok', 'logged-out', 'usage-limit'] as const;
export const accountStateSchema = z.enum(ACCOUNT_STATES);
export type AccountState = z.infer<typeof accountStateSchema>;
export const accountInfoSchema = z.strictObject({ state: accountStateSchema, resetsAt: epochMsSchema.optional(), sessions: indexSchema });
export type AccountInfo = z.infer<typeof accountInfoSchema>;

/**
 * What every member may know about the host's side of agent sessions before a session exists (`session.host.get`,
 * `session.host`): the account state, and whether the MAIN folder's Claude Code project settings are used.
 */
export const hostStateSchema = z.strictObject({ account: accountInfoSchema, mainProjectSettings: projectSettingsStateSchema });
export type HostState = z.infer<typeof hostStateSchema>;

/** A session: discriminated by `kind`. */
export const sessionInfoSchema = z.union([terminalSessionSchema, agentSessionSchema]);
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** Whether a session is over for good: a terminal that exited, an agent session that ended. */
export function isSessionOver(session: Pick<SessionInfo, 'kind' | 'status'>): boolean {
  return session.kind === 'terminal' ? session.status === 'exited' : session.status === 'ended';
}

// ---------------------------------------------------------------------------------------------------------------
// Text written by people (ARCHITECTURE §5.9 "Text for agents")
// ---------------------------------------------------------------------------------------------------------------

const NUL = '\u0000';

/**
 * Text a person sends that an agent may read (a message, a suggestion, a note, an "Other" answer, a comment), as it
 * ARRIVES: any text but NUL, not blank. The daemon stores, shows and sends `agentText(text).text` (agent-text.ts) and
 * checks the limit again on that string.
 */
export function personTextSchema(maxChars: number) {
  return z
    .string()
    .min(1)
    .max(maxChars)
    .refine((text) => !text.includes(NUL), 'text contains NUL')
    .refine((text) => /\S/u.test(text), 'text is blank');
}

/** The same text as the daemon STORES and sends it: the output of `agentText()`. */
export function cleanedTextSchema(maxChars: number) {
  return multilineTextSchema(maxChars, 1).refine((text) => /\S/u.test(text), 'text is blank');
}

export const mentionsSchema = z.array(userIdSchema).max(MENTIONS_PER_TEXT_MAX);

/** Where a person's text for an agent was written. */
export const MESSAGE_ORIGINS = ['composer', 'follow-up', 'revise', 'selection'] as const;
export const messageOriginSchema = z.enum(MESSAGE_ORIGINS);
export type MessageOrigin = z.infer<typeof messageOriginSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Suggestions (ARCHITECTURE §5.6)
// ---------------------------------------------------------------------------------------------------------------

/** Suggestion text as it arrives (`suggest.create`, `suggest.edit`, `suggest.accept`). */
export const suggestionTextSchema = personTextSchema(SUGGESTION_TEXT_MAX_CHARS);
/** Suggestion text as stored: what the card shows and what an accept sends. */
export const suggestionStoredTextSchema = cleanedTextSchema(SUGGESTION_TEXT_MAX_CHARS);

/** A code selection a suggestion was made from; lines are 1-based and inclusive. */
export const suggestionSourceSchema = z
  .strictObject({ file: entryRefSchema, startLine: z.int().min(1), endLine: z.int().min(1) })
  .refine((source) => source.endLine >= source.startLine, 'endLine < startLine');

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'accepted-modified', 'rejected', 'withdrawn'] as const;

export const reasonTextSchema = lineTextSchema(REASON_MAX_CHARS);

/** Why a suggestion was closed without a person deciding on it. */
export const SUGGESTION_CLOSED_REASONS = ['session-ended', 'author-kicked', 'author-demoted', 'topic-archived'] as const;
export type SuggestionClosedReason = (typeof SUGGESTION_CLOSED_REASONS)[number];

/**
 * A person's text for an AGENT session that reaches the agent only when a member with `session.drive` accepts it.
 * `text` is the output of `agentText()`: exactly what the card shows and what an accept sends.
 */
export const suggestionSchema = z.strictObject({
  id: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  author: userRefSchema,
  text: suggestionStoredTextSchema,
  /** Invisible characters were removed from what the author typed. */
  cleaned: z.literal(true).optional(),
  origin: messageOriginSchema,
  topicId: opaqueIdSchema.optional(),
  itemId: itemIdSchema.optional(),
  mentions: mentionsSchema.optional(),
  source: suggestionSourceSchema.optional(),
  status: z.enum(SUGGESTION_STATUSES),
  createdAt: epochMsSchema,
  resolvedAt: epochMsSchema.optional(),
  /** the text actually sent to the agent (differs from `text` for accepted-modified) */
  finalText: suggestionStoredTextSchema.optional(),
  /** Who accepted or rejected it. */
  decidedBy: userRefSchema.optional(),
  /** A person's words (the member who rejected it). Never written by the daemon. */
  rejectReason: reasonTextSchema.optional(),
  /**
   * Why the daemon itself closed the suggestion (its session ended or its topic was archived: `rejected`; its author
   * was kicked or lost the right to suggest: `withdrawn`). Nobody decided it; clients word the reason themselves.
   */
  closedReason: z.enum(SUGGESTION_CLOSED_REASONS).optional(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------------------------------------------

/** A git branch name as smurg shows it (`smurg/<owner>/<id>`, `smurg/<topic slug>/<item id>`). */
export const shortBranchSchema = shortTextSchema.pipe(z.string().min(1));

export const worktreeInfoSchema = z.strictObject({
  id: opaqueIdSchema,
  ownerUserId: userIdSchema,
  ownerName: displayNameSchema,
  /** git branch, e.g. smurg/<owner>/<id> */
  branch: shortBranchSchema,
  sessionId: opaqueIdSchema.optional(),
  kept: z.boolean(),
  createdAt: epochMsSchema,
  /** shared read-only dirs linked into this worktree (paths in the main root) */
  sharedDirs: z.array(entryPathSchema).max(SHARED_DIRS_MAX),
  /** The worktree of one work item of a topic (owned by the member who pressed Start; the host after a handover). */
  topicId: opaqueIdSchema.optional(),
  itemId: itemIdSchema.optional(),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

/** `draft`: the snapshot behind a result report; nobody asked to merge it yet (ARCHITECTURE §5.7). */
export const MERGE_REQUEST_STATUSES = ['draft', 'pending', 'merged', 'rejected', 'conflict'] as const;
export type MergeRequestStatus = (typeof MERGE_REQUEST_STATUSES)[number];

export const mergeMessageSchema = multilineTextSchema(MERGE_MESSAGE_MAX_CHARS);

/** A full git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. */
export const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, 'not a git commit id');

export const mergeRequestSchema = z.strictObject({
  id: opaqueIdSchema,
  worktreeId: opaqueIdSchema,
  /** Absent while the request is a `draft`. */
  requestedBy: userRefSchema.optional(),
  message: mergeMessageSchema.optional(),
  topicId: opaqueIdSchema.optional(),
  itemId: itemIdSchema.optional(),
  /** Its result report was reviewed: a reviewed draft is in the host's inbox as ready to merge. */
  reviewed: z.boolean(),
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
  status: agentStatusSchema,
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

/** Audit `action` vocabulary (ARCHITECTURE §5.8). */
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
  'session.message',
  'smurg.message',
  'session.interrupt',
  'session.retry',
  'session.restart',
  'session.responsible',
  'session.mode',
  'session.rule.remove',
  'session.handover',
  'responsible.fallback',
  'question.submit',
  'question.remind',
  'permission.decide',
  'permission.auto',
  'permission.auto-deny',
  'agent.command',
  'topic.create',
  'topic.rename',
  'topic.archive',
  'topic.delete',
  'topic.discussion.restart',
  'topic.spec.request',
  'topic.rule.add',
  'topic.rule.remove',
  'plan.generate',
  'plan.start',
  'plan.resume',
  'plan.assign',
  'plan.mode',
  'plan.item.retry',
  'plan.item.continue',
  'plan.item.resolve',
  'scheduler.start',
  'scheduler.disarm',
  'report.register',
  'report.review',
  'spec.commit',
  'claude-config.decide',
  'transcript.redact',
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
