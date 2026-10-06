import { z } from 'zod';
import {
  actorSchema,
  itemIdSchema,
  itemTitleSchema,
  MERGE_REQUEST_STATUSES,
  projectSettingsStateSchema,
  rememberedRuleSchema,
  topicNameSchema,
  topicSlugSchema,
  userRefSchema,
} from './entities.ts';
import { wireTextSchema } from './conversation.ts';
import {
  HAND_EDITS_MAX,
  ITEM_GLOB_MAX_CHARS,
  ITEM_SUMMARY_MAX_CHARS,
  ITEM_TOUCHES_MAX,
  PLAN_INFO_ITEMS_MAX,
  PLAN_ITEMS_MAX,
  PLAN_WAITING_FOR_MAX,
  PLAN_WARNINGS_MAX,
  PREFLIGHT_ALSO_IN_FOLDER_MAX,
  PREFLIGHT_BLOCKERS_MAX,
  PREFLIGHT_EDITING_NOW_MAX,
  REMEMBERED_RULES_MAX,
  REPORT_BY_HAND_MAX,
  REPORT_CHECKS_MAX,
  REPORT_CHECK_TEXT_MAX_CHARS,
  REPORT_FOLLOW_UPS_MAX,
  REPORT_FOLLOW_UP_TEXT_MAX_BYTES,
  REPORT_SECTION_MAX_BYTES,
  REVIEWERS_MAX,
  SHARED_DIRS_MAX,
  SPLIT_REASON_MAX_CHARS,
} from './limits.ts';
import { entryPathSchema, fileRefSchema } from './paths.ts';
import { epochMsSchema, indexSchema, largeTextSchema, lineTextSchema, multilineTextSchema, opaqueIdSchema, sha256HexSchema, shortTextSchema } from './primitives.ts';

// Topics, the plan and its work items, result reports, and what a Start confirms (ARCHITECTURE §5.10). A topic's
// spec and plan are FILES in the project (`specs/<slug>/SPEC.md`, `PLAN.md`); who is responsible, what runs and what
// is reviewed is daemon state keyed by item id.

// ---------------------------------------------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------------------------------------------

/** Derived by the daemon from facts, never set by a request. `archived` is a flag beside it. */
export const TOPIC_PHASES = ['discussing', 'spec', 'plan', 'executing', 'complete'] as const;
export const topicPhaseSchema = z.enum(TOPIC_PHASES);
export type TopicPhase = z.infer<typeof topicPhaseSchema>;

/** A write of the spec or the plan that was not the discussion agent's. `outside`: no member made it through smurg. */
export const handEditSchema = z.strictObject({ by: z.union([userRefSchema, z.literal('outside')]), at: epochMsSchema });
export type HandEdit = z.infer<typeof handEditSchema>;
export const handEditsSchema = z.strictObject({
  spec: z.array(handEditSchema).max(HAND_EDITS_MAX),
  plan: z.array(handEditSchema).max(HAND_EDITS_MAX),
});

/** A line of a file with what is wrong there. */
export const fileErrorSchema = wireTextSchema.extend({ line: z.int().min(1).optional() });
export type FileError = z.infer<typeof fileErrorSchema>;

export const PLAN_MODES = ['assigned', 'everyone'] as const;
export const planModeSchema = z.enum(PLAN_MODES);
export type PlanMode = z.infer<typeof planModeSchema>;

export const topicSchema = z.strictObject({
  id: opaqueIdSchema,
  name: topicNameSchema,
  /** The folder is `specs/<slug>`; it never changes. */
  slug: topicSlugSchema,
  phase: topicPhaseSchema,
  archived: z.boolean(),
  /** The main workspace is a git repository (execution needs one). */
  versioned: z.boolean(),
  createdBy: userRefSchema,
  createdAt: epochMsSchema,
  discussionSessionId: opaqueIdSchema.optional(),
  /** `lost`: the discussion session ended or failed for good; "Restart discussion" gives the topic a new one. */
  discussion: z.enum(['live', 'lost']),
  spec: z.strictObject({
    exists: z.boolean(),
    changedAt: epochMsSchema.optional(),
    changedBy: actorSchema.optional(),
    /** The discussion agent's last edit of the spec: its tool card, and who asked. */
    lastAgentChange: z.strictObject({ sessionId: opaqueIdSchema, seq: z.int().min(1), at: epochMsSchema, askedBy: userRefSchema.optional() }).optional(),
  }),
  /** Since the last confirmed Start. */
  handEdits: handEditsSchema,
  plan: z.strictObject({
    exists: z.boolean(),
    valid: z.boolean(),
    error: fileErrorSchema.optional(),
    /** The agent is writing it right now. */
    generating: z.boolean(),
    /** The spec changed after the plan was written. */
    stale: z.boolean(),
    mode: planModeSchema,
    /** After a restart of the host's smurg: nothing runs until "Continue all". */
    paused: z.boolean(),
    /** The last change of PLAN.md, whoever made it (a Plan row is bold when it is newer than what the browser showed). */
    changedAt: epochMsSchema.optional(),
    changedBy: actorSchema.optional(),
    items: indexSchema,
    started: indexSchema,
    reviewed: indexSchema,
    merged: indexSchema,
  }),
  /** Always allowed in every session of this topic. */
  rules: z.array(rememberedRuleSchema).max(REMEMBERED_RULES_MAX),
});
export type Topic = z.infer<typeof topicSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Result reports
// ---------------------------------------------------------------------------------------------------------------

export const REPORT_OUTCOMES = ['complete', 'partial', 'blocked'] as const;
export const reportOutcomeSchema = z.enum(REPORT_OUTCOMES);
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;

export const REPORT_STATES = ['to-review', 'reviewed', 'changed-after-review', 'invalid'] as const;
export const reportChecksSchema = z.strictObject({ passed: indexSchema, notVerified: indexSchema });

export const reportSummarySchema = z.strictObject({
  version: z.int().min(1),
  writtenAt: epochMsSchema,
  outcome: reportOutcomeSchema,
  state: z.enum(REPORT_STATES),
  /** Who may press "I've reviewed this" (routing.ts `reviewersOf`), kept current by the daemon. */
  reviewers: z.array(userRefSchema).max(REVIEWERS_MAX),
  escalatedAt: epochMsSchema.optional(),
  review: z.strictObject({ by: userRefSchema, at: epochMsSchema, version: z.int().min(1), insteadOf: userRefSchema.optional() }).optional(),
  checks: reportChecksSchema,
  /** With state `invalid`. */
  error: fileErrorSchema.optional(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

const reportSectionSchema = largeTextSchema(REPORT_SECTION_MAX_BYTES);

export const NO_CHANGES_REASONS = ['host-only-paths', 'spec-files', 'conflict-markers'] as const;
export type NoChangesReason = (typeof NO_CHANGES_REASONS)[number];

const followUpTextSchema = z.strictObject({ text: largeTextSchema(REPORT_FOLLOW_UP_TEXT_MAX_BYTES), truncated: z.literal(true).optional() });

/**
 * A result report as the report column shows it. `sections` are Markdown, masked. `changes`: the draft merge request
 * behind it (read its diff with `worktree.merge.diff`); `noChanges`: why the snapshot was refused. `questions`: the
 * follow-ups asked from the report, each clipped to REPORT_FOLLOW_UP_TEXT_MAX_BYTES (the session holds the whole text).
 */
export const reportInfoSchema = reportSummarySchema.extend({
  topicId: opaqueIdSchema,
  itemId: itemIdSchema,
  file: fileRefSchema,
  sections: z.strictObject({
    done: reportSectionSchema,
    why: reportSectionSchema,
    verified: z
      .array(z.strictObject({ text: multilineTextSchema(REPORT_CHECK_TEXT_MAX_CHARS), passed: z.boolean(), note: multilineTextSchema(REPORT_CHECK_TEXT_MAX_CHARS).optional() }))
      .max(REPORT_CHECKS_MAX),
    watchOut: reportSectionSchema,
    followUps: reportSectionSchema.optional(),
  }),
  changes: z
    .strictObject({
      requestId: opaqueIdSchema,
      files: indexSchema,
      additions: indexSchema,
      deletions: indexSchema,
      /** Files a person also edited in the worktree. */
      byHand: z.array(z.strictObject({ path: entryPathSchema, by: z.array(userRefSchema).max(REVIEWERS_MAX) })).max(REPORT_BY_HAND_MAX),
    })
    .optional(),
  noChanges: z.enum(NO_CHANGES_REASONS).optional(),
  questions: z
    .array(
      followUpTextSchema.extend({
        id: opaqueIdSchema,
        from: userRefSchema,
        at: epochMsSchema,
        answer: followUpTextSchema.extend({ at: epochMsSchema }).optional(),
      }),
    )
    .max(REPORT_FOLLOW_UPS_MAX),
});
export type ReportInfo = z.infer<typeof reportInfoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Work items and the plan
// ---------------------------------------------------------------------------------------------------------------

export const ITEM_STATES = ['not-started', 'waiting', 'queued', 'running', 'stalled', 'done', 'reviewed', 'failed', 'stopped'] as const;
export const itemStateSchema = z.enum(ITEM_STATES);
export type ItemState = z.infer<typeof itemStateSchema>;

export const ITEM_SIZES = ['s', 'm', 'l'] as const;
/**
 * Why an execution session is idle without a registered report: `agent` (it stopped in prose, after one nudge),
 * `restart` (smurg restarted mid-turn), `stopped` (a person stopped the turn), `error` (the turn ended with an error).
 */
export const STALLED_BY = ['agent', 'restart', 'stopped', 'error'] as const;
export const stalledBySchema = z.enum(STALLED_BY);
export type StalledBy = z.infer<typeof stalledBySchema>;
export const DISARMED_REASONS = ['plan-changed', 'starter-removed', 'start-failed'] as const;
export const RESPONSIBLE_SOURCES = ['agent', 'smurg', 'chosen'] as const;

export const workItemSchema = z.strictObject({
  /** From the file; the identity of the item. */
  id: itemIdSchema,
  /** 1-based position in the file (0: not in the file any more). */
  number: indexSchema,
  title: itemTitleSchema,
  summary: multilineTextSchema(ITEM_SUMMARY_MAX_CHARS),
  dependsOn: z.array(itemIdSchema).max(PLAN_ITEMS_MAX),
  size: z.enum(ITEM_SIZES),
  touches: z.array(lineTextSchema(ITEM_GLOB_MAX_CHARS, 1)).max(ITEM_TOUCHES_MAX),
  /** false: started, then removed from PLAN.md (shown below the plan; does not count for "topic complete"). */
  inPlan: z.boolean(),
  state: itemStateSchema,
  /** With state `stalled`. */
  stalledBy: stalledBySchema.optional(),
  /** It starts by itself when it can, from the pinned content only. */
  armed: z.boolean(),
  disarmed: z.enum(DISARMED_REASONS).optional(),
  /** Ids that are not merged yet. */
  waitsFor: z.array(itemIdSchema).max(PLAN_ITEMS_MAX).optional(),
  responsible: userRefSchema.extend({ source: z.enum(RESPONSIBLE_SOURCES) }).nullable(),
  startedBy: userRefSchema.optional(),
  sessionId: opaqueIdSchema.optional(),
  worktreeId: opaqueIdSchema.optional(),
  /** 0 before the first start. */
  attempt: indexSchema,
  startError: wireTextSchema.optional(),
  /** Someone sent a message from the report after its newest version. */
  changesAsked: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
  report: reportSummarySchema.optional(),
  merge: z
    .strictObject({
      requestId: opaqueIdSchema,
      status: z.enum(MERGE_REQUEST_STATUSES),
      /** Reviewed: in the host's inbox. */
      ready: z.boolean(),
    })
    .optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;

export const planInfoSchema = z.strictObject({
  topicId: opaqueIdSchema,
  /** Bumped by every successful parse that differs from the last one. With the two hashes: what a Start pins. */
  revision: indexSchema,
  specHash: sha256HexSchema,
  planHash: sha256HexSchema,
  mode: planModeSchema,
  paused: z.boolean(),
  items: z.array(workItemSchema).max(PLAN_INFO_ITEMS_MAX),
  /** Who proposed the split, and the agent's sentence why. */
  split: z.strictObject({ source: z.enum(['agent', 'smurg']), reason: multilineTextSchema(SPLIT_REASON_MAX_CHARS).optional() }).optional(),
  /** E.g. two items touch the same files. */
  warnings: z.array(wireTextSchema).max(PLAN_WARNINGS_MAX),
  /** Who this plan waits for, and for what. */
  waitingFor: z
    .array(z.strictObject({ user: userRefSchema, questions: indexSchema, permissions: indexSchema, reports: indexSchema, since: epochMsSchema }))
    .max(PLAN_WAITING_FOR_MAX),
  slots: z.strictObject({ inUse: indexSchema, max: indexSchema, waitingForPeople: indexSchema }),
});
export type PlanInfo = z.infer<typeof planInfoSchema>;

/** What the Start dialog shows; `plan.start` echoes `planRevision`, `specHash` and `planHash` (the pin). */
export const startPreflightSchema = z.strictObject({
  planRevision: indexSchema,
  specHash: sha256HexSchema,
  planHash: sha256HexSchema,
  startsNow: z.array(itemIdSchema).max(PLAN_INFO_ITEMS_MAX),
  waits: z.array(z.strictObject({ itemId: itemIdSchema, for: z.array(itemIdSchema).max(PLAN_ITEMS_MAX) })).max(PLAN_INFO_ITEMS_MAX),
  alreadyStarted: z.array(itemIdSchema).max(PLAN_INFO_ITEMS_MAX),
  responsible: z.array(z.strictObject({ itemId: itemIdSchema, user: userRefSchema.nullable(), online: z.boolean() })).max(PLAN_INFO_ITEMS_MAX),
  /** Sessions whose questions the caller will decide. */
  youDecide: indexSchema,
  /** The checkpoint commit of exactly the two files; null when the folder is not a git repository. */
  commit: z
    .strictObject({
      needed: z.boolean(),
      branch: shortTextSchema,
      as: userRefSchema,
      files: z.array(entryPathSchema).max(2),
      /** Other files in the topic's folder: not committed. */
      alsoInFolder: z.array(entryPathSchema).max(PREFLIGHT_ALSO_IN_FOLDER_MAX),
    })
    .nullable(),
  handEdits: handEditsSchema,
  /** These files contain characters people cannot see. */
  invisibleCharacters: z.array(z.enum(['spec', 'plan'])).max(2),
  stale: z.boolean(),
  openQuestion: z.boolean(),
  specOpenQuestions: indexSchema,
  editingNow: z.array(userRefSchema).max(PREFLIGHT_EDITING_NOW_MAX),
  projectSettings: projectSettingsStateSchema,
  rules: z.array(rememberedRuleSchema).max(REMEMBERED_RULES_MAX),
  sharedDirs: z.array(entryPathSchema).max(SHARED_DIRS_MAX),
  /** While one holds, `plan.start` is refused (not a git repository, git busy, the plan does not parse, …). */
  blockers: z.array(wireTextSchema).max(PREFLIGHT_BLOCKERS_MAX),
});
export type StartPreflight = z.infer<typeof startPreflightSchema>;
