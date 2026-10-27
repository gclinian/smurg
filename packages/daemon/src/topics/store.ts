// `topics.json` and `reports.json` (ARCHITECTURE §7.1): what the topics module must still know after a restart of the
// host's smurg. A topic's spec and plan are FILES in the project; here is only daemon state: which topics exist, the
// last plan that parsed, and per work item id who is responsible, what was armed with which pin, which session and
// worktree it has, and its report bookkeeping. Report bodies (large, rarely written) are a document of their own.
//
// Both are validated on load and on every update (StateStore): an edited file that does not fit stops the daemon
// instead of starting an agent from it.
//
// 0.6.0 (DESIGN D6): optional keys only (a 0.5.x file passes as it is): a topic's agent settings, an item that ran
// directly in the shared folder, and a pin that says which history the Start used.
//
// 0.7.0 (DESIGN 0.7.0 D4): optional keys only again (a 0.6.0 file passes as it is): the merge policy and the branch a
// Start pinned, what an item that smurg merges by itself waits for (`autoMerge`, `mergeTries`), the turns of its
// sessions and the turn a report was checked in (`turns`, `checked[].turn`, `lastTurn`), who merged it (`mergedAs`),
// "Leave it out" (`leftOut`), the host's undo (`undone`), the automatic continues (`autoContinue`), a topic's
// "I've checked the result" (`checked`) and who paused a plan (`pausedBy`); and a report checked in the turn that
// made it (`checkedInTurn`). Nothing reads them yet but the store (0.7.0 S2 to S6).
import { z } from 'zod';
import { declareDocument } from '../core/state-store.ts';
import {
  AUTO_MERGE_PATHS_MAX,
  AUTO_MERGE_REASONS,
  AUTO_MERGE_REASONS_OF_STATE,
  AUTO_MERGE_STATES,
  DISARMED_REASONS,
  HOST_HOLDS,
  MERGE_POLICIES,
  HAND_EDITS_MAX,
  ITEM_GLOB_MAX_CHARS,
  ITEM_SIZES,
  ITEM_SUMMARY_MAX_CHARS,
  ITEM_TOUCHES_MAX,
  MERGE_REQUEST_STATUSES,
  PLAN_INFO_ITEMS_MAX,
  PLAN_ITEMS_MAX,
  PLAN_MODES,
  PLAN_WARNINGS_MAX,
  REMEMBERED_RULES_MAX,
  RESPONSIBLE_SOURCES,
  SPLIT_REASON_MAX_CHARS,
  TOPICS_MAX,
  actorSchema,
  entryPathSchema,
  epochMsSchema,
  fileErrorSchema,
  gitCommitSchema,
  handEditSchema,
  indexSchema,
  itemIdSchema,
  itemStateSchema,
  itemTitleSchema,
  lineTextSchema,
  multilineTextSchema,
  opaqueIdSchema,
  modelIdSchema,
  rememberedRuleSchema,
  reportInfoSchema,
  SESSION_MODE_CHOICES,
  sha256HexSchema,
  shortBranchSchema,
  shortTextSchema,
  stalledBySchema,
  topicNameSchema,
  topicSlugSchema,
  userIdSchema,
  userRefSchema,
  wireTextSchema,
} from '@smurg/protocol';

export const TOPICS_DOCUMENT = 'topics';
export const REPORTS_DOCUMENT = 'reports';
export const TOPICS_VERSION = 1;

/** Sessions an item or a topic remembers it had (every attempt; a topic's replaced discussions). */
const SESSIONS_KEPT_MAX = 64;
/** Report contents `check_report` answered ok for, per item (the newest are kept). */
export const CHECKED_HASHES_MAX = 16;

/** A git object id as the worktree module reports it (SHA-1 or SHA-256 hex), or the fake's stand-in. */
const gitIdSchema = z.string().regex(/^[0-9a-f]{7,64}$/, 'not a git object id');

/**
 * What a Start confirmed (security S3): the plan revision and the two file hashes the dialog showed, and the commit
 * and blob ids the checkpoint left at the main workspace's HEAD. An armed item starts only while both files still
 * hash as pinned in the working tree AND at HEAD. `history` (0.6.0): which history the Start used: `smurg` (smurg's
 * own history, `.smurg/git`) or `direct` (no git: no checkpoint, `commit` and the blobs null; the items run in the
 * folder itself); absent: the folder's own git, as every 0.5.x pin.
 *
 * 0.7.0 (DESIGN 0.7.0 D3): `merging`, what the Start said about how its items reach the main workspace (`auto`: smurg
 * merges an item that is in order, while the workspace's setting says so too; `host`: the host merges each); absent:
 * a Start of 0.6.0 (the host merges), or a direct Start (nothing to merge). `branch`: with the folder's own git, the
 * branch the checkpoint was committed on (smurg merges only into it). A Start on a detached HEAD pins `host` and no
 * branch.
 */
export const pinSchema = z
  .strictObject({
    by: userRefSchema,
    at: epochMsSchema,
    planRevision: indexSchema,
    specHash: sha256HexSchema,
    planHash: sha256HexSchema,
    commit: gitIdSchema.nullable(),
    specBlob: gitIdSchema.nullable(),
    planBlob: gitIdSchema.nullable(),
    history: z.enum(['smurg', 'direct']).optional(),
    merging: z.enum(MERGE_POLICIES).optional(),
    branch: shortBranchSchema.optional(),
  })
  .refine((pin) => (pin.commit === null) === (pin.history === 'direct'), 'a pin has a checkpoint commit unless its items run directly in the folder')
  .refine((pin) => pin.history !== 'direct' || (pin.specBlob === null && pin.planBlob === null), 'a direct pin names no blob')
  .refine((pin) => pin.history !== 'direct' || pin.merging === undefined, 'a direct pin names no merge policy (nothing to merge)')
  .refine((pin) => pin.branch === undefined || (pin.history === undefined && pin.commit !== null), 'a branch only with the folder\'s own git')
  .refine((pin) => pin.merging !== 'auto' || pin.history !== undefined || pin.branch !== undefined, 'smurg merges into the folder\'s own git only on the branch the Start used (a detached Start pins host)');
export type Pin = z.infer<typeof pinSchema>;

/**
 * What a started item that smurg merges by itself waits for now (0.7.0, DESIGN 0.7.0 D4, D8, D9): the record the merge
 * queue keeps, which the wire's `WorkItem.autoMerge` shows. The waits nobody keeps (`queued`, `paused`, `busy`, and
 * `asked` while its answer is to come) are computed, never stored. `requestId`: the merge request it is about.
 * `escalatedAt`: when a hold that is not the host's also reached the host and the members with agent access.
 */
export const storedAutoMergeSchema = z
  .strictObject({
    state: z.enum(AUTO_MERGE_STATES),
    reason: z.enum(AUTO_MERGE_REASONS),
    since: epochMsSchema,
    hostOnly: z.boolean(),
    paths: z.array(entryPathSchema).max(AUTO_MERGE_PATHS_MAX).optional(),
    branch: z.strictObject({ expected: shortBranchSchema, current: shortTextSchema }).optional(),
    escalatedAt: epochMsSchema.optional(),
    requestId: opaqueIdSchema.optional(),
    /** A `conflict` whose other side is a person's change (or a change made outside smurg). */
    people: z.array(z.strictObject({ path: entryPathSchema, by: z.array(userRefSchema).max(5), outside: z.boolean() })).max(AUTO_MERGE_PATHS_MAX).optional(),
  })
  .refine((record) => AUTO_MERGE_REASONS_OF_STATE[record.state].includes(record.reason), 'a reason of another state')
  .refine((record) => record.state !== 'waiting' || !['queued', 'paused', 'busy', 'asked'].includes(record.reason), 'a wait nobody keeps is computed, not stored')
  .refine((record) => record.hostOnly === (record.state === 'held' && (HOST_HOLDS as readonly string[]).includes(record.reason)), 'only a hold of HOST_HOLDS is the host\'s')
  .refine((record) => record.escalatedAt === undefined || (record.state === 'held' && !record.hostOnly), 'only a hold that is not the host\'s escalates')
  .refine((record) => record.branch === undefined || record.reason === 'branch', 'the branches go with the reason branch')
  .refine((record) => record.people === undefined || record.reason === 'conflict', 'people go with a conflict');
export type StoredAutoMerge = z.infer<typeof storedAutoMergeSchema>;

export const storedItemSchema = z.strictObject({
  id: itemIdSchema,
  // ---- the definition, as the file last gave it (kept when the item leaves the file) ----
  /** 1-based position in the file; 0: started, then removed from PLAN.md. */
  number: indexSchema,
  title: itemTitleSchema,
  summary: multilineTextSchema(ITEM_SUMMARY_MAX_CHARS),
  dependsOn: z.array(itemIdSchema).max(PLAN_ITEMS_MAX),
  size: z.enum(ITEM_SIZES),
  touches: z.array(lineTextSchema(ITEM_GLOB_MAX_CHARS, 1)).max(ITEM_TOUCHES_MAX),
  // ---- daemon state, keyed by the id ----
  state: itemStateSchema,
  stalledBy: stalledBySchema.optional(),
  /** When `state` last changed (the time of an attention item). */
  since: epochMsSchema,
  armed: z.boolean(),
  disarmed: z.enum(DISARMED_REASONS).optional(),
  /** Armed by "Try again" of a stopped item: it starts a NEW session in the worktree it already has (no pin check). */
  retry: z.boolean(),
  responsible: userRefSchema.extend({ source: z.enum(RESPONSIBLE_SOURCES) }).nullable(),
  /** A person decided who is responsible (also: nobody). Nothing recomputes it. */
  chosen: z.boolean(),
  startedBy: userRefSchema.optional(),
  pin: pinSchema.optional(),
  sessionId: opaqueIdSchema.optional(),
  /** Every session the item had, oldest first (its attempts). */
  sessions: z.array(opaqueIdSchema).max(SESSIONS_KEPT_MAX),
  worktreeId: opaqueIdSchema.optional(),
  attempt: indexSchema,
  startError: wireTextSchema.optional(),
  changesAsked: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
  merge: z.strictObject({ requestId: opaqueIdSchema, status: z.enum(MERGE_REQUEST_STATUSES), ready: z.boolean() }).optional(),
  /** Its changes reached the main workspace once: what depends on it may start. */
  merged: z.boolean(),
  // ---- report bookkeeping ----
  /**
   * Contents of the report file `check_report` answered ok for, with the session that asked. `turn` (0.7.0): the turn
   * it answered in (`turns + 1` at that moment); absent on entries of 0.6.0.
   */
  checked: z.array(z.strictObject({ sessionId: opaqueIdSchema, attempt: indexSchema, hash: sha256HexSchema, turn: indexSchema.optional() })).max(CHECKED_HASHES_MAX),
  /** `nudge-report` was sent since a person last wrote to the session. */
  nudged: z.boolean(),
  /** `fix-report` was sent for this content, this many times in a row. */
  fix: z.strictObject({ hash: sha256HexSchema, count: indexSchema }).optional(),
  /**
   * A report the agent had checked could not be registered because the snapshot of its worktree failed, or (0.7.0) a
   * later turn that did not finish edited files of it: the next completed turn of the item's session takes the
   * snapshot again, whatever the report file says by then.
   */
  snapshotOwed: z.literal(true).optional(),
  /** It ran directly in the shared folder (no git, DESIGN 0.6.0 D15). */
  direct: z.literal(true).optional(),
  // ---- automatic merging and what goes with it (0.7.0; absent in every file of 0.6.0) ----
  /** What it waits for before smurg merges it; it goes when that is over. */
  autoMerge: storedAutoMergeSchema.optional(),
  /** Resolve turns smurg asked for since the item's Start (kept when a new version clears a hold; absent: 0). */
  mergeTries: indexSchema.optional(),
  /** Finished turns of the item's sessions, counted when a turn's end arrives (absent: 0). */
  turns: indexSchema.optional(),
  /**
   * The newest turn after the current report version did not complete (a person stopped it, or it ended on an error).
   * `restart`: the stop of the host's smurg cut it (0.7.0 review: what that turn was asked is not known after the start).
   */
  lastTurn: z.strictObject({ outcome: z.enum(['interrupted', 'error']), at: epochMsSchema, restart: z.literal(true).optional() }).optional(),
  /** Who merged it and the merge commit (worktrees.json keeps only the newest decided merges; direct and accepted items have no request). */
  mergedAs: z.strictObject({ requestId: opaqueIdSchema.optional(), commit: gitCommitSchema.optional(), at: epochMsSchema, by: z.union([z.literal('smurg'), userRefSchema]) }).optional(),
  /** "Leave it out": it and what depends on it are not merged. */
  leftOut: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
  /** The host undid its merge with this commit. */
  undone: z.strictObject({ by: userRefSchema, at: epochMsSchema, commit: gitCommitSchema }).optional(),
  /** smurg continued it by itself (a usage limit that ended, a broken turn, a crash, a failed snapshot), this many times. */
  autoContinue: z.strictObject({ cause: z.enum(['usage-limit', 'error', 'crash', 'snapshot']), count: indexSchema, at: epochMsSchema }).optional(),
});
export type StoredItem = z.infer<typeof storedItemSchema>;

export const splitPersonSchema = z.strictObject({ userId: userIdSchema, name: shortTextSchema, joinedAt: epochMsSchema });

export const storedPlanSchema = z.strictObject({
  exists: z.boolean(),
  hash: sha256HexSchema,
  valid: z.boolean(),
  error: fileErrorSchema.optional(),
  changedAt: epochMsSchema.optional(),
  changedBy: actorSchema.optional(),
  /** A plan has parsed at least once: `PlanInfo` exists. */
  parsed: z.boolean(),
  /** What the last successful parse was (plan-format.ts planFingerprint); a different one bumps `revision`. */
  fingerprint: z.string().max(1_048_576),
  revision: indexSchema,
  mode: z.enum(PLAN_MODES),
  paused: z.boolean(),
  pausedAt: epochMsSchema.optional(),
  /** A person's "Pause" (0.7.0); absent with `paused`: smurg paused it (a restart of 0.6.0, an interrupted direct item). */
  pausedBy: userRefSchema.optional(),
  warnings: z.array(wireTextSchema).max(PLAN_WARNINGS_MAX),
  split: z.strictObject({ source: z.enum(['agent', 'smurg']), reason: multilineTextSchema(SPLIT_REASON_MAX_CHARS).optional() }).optional(),
  /** The members with agent access who were online when "Generate plan" was pressed: who the agent may propose. */
  people: z.array(splitPersonSchema).max(20),
  /** The pin of the last confirmed Start ("Show the changes" compares with it). */
  lastPin: pinSchema.optional(),
  /** `fix-plan` was sent for this content, this many times in a row. */
  fix: z.strictObject({ hash: sha256HexSchema, count: indexSchema }).optional(),
});
export type StoredPlan = z.infer<typeof storedPlanSchema>;

/**
 * A topic's agent settings (0.6.0): the model of its new sessions (absent: the host's default) and the mode its work
 * items follow (absent: the workspace's), each with who chose it.
 */
export const storedTopicAgentSchema = z.strictObject({
  model: modelIdSchema.optional(),
  permissionMode: z.enum(SESSION_MODE_CHOICES).optional(),
  modeChangedBy: userRefSchema.optional(),
  modelChangedBy: userRefSchema.optional(),
});
export type StoredTopicAgent = z.infer<typeof storedTopicAgentSchema>;

export const storedTopicSchema = z.strictObject({
  id: opaqueIdSchema,
  name: topicNameSchema,
  slug: topicSlugSchema,
  archived: z.boolean(),
  createdBy: userRefSchema,
  createdAt: epochMsSchema,
  discussionSessionId: opaqueIdSchema.optional(),
  discussion: z.enum(['live', 'lost']),
  /** Since when the discussion is lost. */
  lostAt: epochMsSchema.optional(),
  /** Every discussion session the topic had, oldest first. */
  discussionSessions: z.array(opaqueIdSchema).max(SESSIONS_KEPT_MAX),
  spec: z.strictObject({
    exists: z.boolean(),
    hash: sha256HexSchema,
    changedAt: epochMsSchema.optional(),
    changedBy: actorSchema.optional(),
    lastAgentChange: z.strictObject({ sessionId: opaqueIdSchema, seq: z.int().min(1), at: epochMsSchema, askedBy: userRefSchema.optional() }).optional(),
  }),
  handEdits: z.strictObject({ spec: z.array(handEditSchema).max(HAND_EDITS_MAX), plan: z.array(handEditSchema).max(HAND_EDITS_MAX) }),
  rules: z.array(rememberedRuleSchema).max(REMEMBERED_RULES_MAX),
  plan: storedPlanSchema,
  items: z.array(storedItemSchema).max(PLAN_INFO_ITEMS_MAX),
  /** The topic's agent settings; absent: none chosen (the host's default model, the workspace's mode). */
  agent: storedTopicAgentSchema.optional(),
  /** "I've checked the result" (0.7.0): who pressed it, and when. */
  checked: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
});
export type StoredTopic = z.infer<typeof storedTopicSchema>;

export const topicsDocumentSchema = z.strictObject({
  version: z.literal(TOPICS_VERSION),
  topics: z.array(storedTopicSchema).max(TOPICS_MAX),
});
export type TopicsDocument = z.infer<typeof topicsDocumentSchema>;

export function initialTopicsDocument(): TopicsDocument {
  return { version: TOPICS_VERSION, topics: [] };
}

/**
 * A registered report version: the wire's ReportInfo plus what the daemon needs to decide whether a later content is a
 * new version, whose follow-up a turn answers, and when the review has waited too long.
 */
export const storedReportSchema = reportInfoSchema.extend({
  /** SHA-256 of the report file this version was registered from (checked ok in `sessionId`). */
  contentHash: sha256HexSchema,
  sessionId: opaqueIdSchema,
  /** Since when this version waits for a review (the escalation's start). */
  waitingSince: epochMsSchema,
  /**
   * 0.7.0: `check_report` answered ok for this content in the turn that produced this version, or a later turn that
   * changed nothing confirmed it (stored only; absent: no).
   */
  checkedInTurn: z.literal(true).optional(),
  /** Follow-ups whose answer is still to come: the message a turn will take, or the suggestion that may be accepted. */
  pending: z
    .array(
      z.strictObject({
        questionId: opaqueIdSchema,
        messageId: opaqueIdSchema.optional(),
        suggestionId: opaqueIdSchema.optional(),
        /** A follow-up that is still a suggestion: it joins `questions` when its message was taken by a turn. */
        question: z.strictObject({ from: userRefSchema, text: z.string().max(65_536), truncated: z.literal(true).optional(), at: epochMsSchema }).optional(),
      }),
    )
    .max(100),
});
export type StoredReport = z.infer<typeof storedReportSchema>;

export const reportsDocumentSchema = z.strictObject({
  version: z.literal(TOPICS_VERSION),
  reports: z.array(storedReportSchema).max(TOPICS_MAX * PLAN_INFO_ITEMS_MAX),
});
export type ReportsDocument = z.infer<typeof reportsDocumentSchema>;

export function initialReportsDocument(): ReportsDocument {
  return { version: TOPICS_VERSION, reports: [] };
}

/**
 * topics.json and reports.json (new in 0.5.0). Declared by the topics module.
 *
 * NEITHER can be set aside (no `canSetAside`; test/upgrade/set-aside.test.ts shows what a start without one leaves):
 * without topics.json the discussion sessions of every topic stay in the list, idle, naming a topic that is not there
 * (only the item sessions are ended), and merge requests and suggestions name it too; without reports.json the items
 * still say `done` or `reviewed` and have no report anyone could read or review. Nothing here looks for that when it
 * starts. Whoever adds that handling may say `canSetAside: true`, with the proof in that test.
 */
export const topicsDocument = declareDocument({ name: TOPICS_DOCUMENT, schema: topicsDocumentSchema, init: initialTopicsDocument });
export const reportsDocument = declareDocument({ name: REPORTS_DOCUMENT, schema: reportsDocumentSchema, init: initialReportsDocument });
