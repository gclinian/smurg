// `topics.json` and `reports.json` (ARCHITECTURE §7.1): what the topics module must still know after a restart of the
// host's smurg. A topic's spec and plan are FILES in the project; here is only daemon state: which topics exist, the
// last plan that parsed, and per work item id who is responsible, what was armed with which pin, which session and
// worktree it has, and its report bookkeeping. Report bodies (large, rarely written) are a document of their own.
//
// Both are validated on load and on every update (StateStore): an edited file that does not fit stops the daemon
// instead of starting an agent from it.
import { z } from 'zod';
import { declareDocument } from '../core/state-store.ts';
import {
  DISARMED_REASONS,
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
  epochMsSchema,
  fileErrorSchema,
  handEditSchema,
  indexSchema,
  itemIdSchema,
  itemStateSchema,
  itemTitleSchema,
  lineTextSchema,
  multilineTextSchema,
  opaqueIdSchema,
  rememberedRuleSchema,
  reportInfoSchema,
  sha256HexSchema,
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
 * hash as pinned in the working tree AND at HEAD.
 */
export const pinSchema = z.strictObject({
  by: userRefSchema,
  at: epochMsSchema,
  planRevision: indexSchema,
  specHash: sha256HexSchema,
  planHash: sha256HexSchema,
  commit: gitIdSchema,
  specBlob: gitIdSchema.nullable(),
  planBlob: gitIdSchema.nullable(),
});
export type Pin = z.infer<typeof pinSchema>;

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
  /** Contents of the report file `check_report` answered ok for, with the session that asked. */
  checked: z.array(z.strictObject({ sessionId: opaqueIdSchema, attempt: indexSchema, hash: sha256HexSchema })).max(CHECKED_HASHES_MAX),
  /** `nudge-report` was sent since a person last wrote to the session. */
  nudged: z.boolean(),
  /** `fix-report` was sent for this content, this many times in a row. */
  fix: z.strictObject({ hash: sha256HexSchema, count: indexSchema }).optional(),
  /**
   * A report the agent had checked could not be registered because the snapshot of its worktree failed: the next
   * completed turn of the item's session takes the snapshot again, whatever the report file says by then.
   */
  snapshotOwed: z.literal(true).optional(),
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
