import { z } from 'zod';
import {
  actorSchema,
  itemIdSchema,
  itemTitleSchema,
  MERGE_REQUEST_STATUSES,
  mergePolicySchema,
  permissionModeSchema,
  projectSettingsStateSchema,
  rememberedRuleSchema,
  sessionModeChoiceSchema,
  shortBranchSchema,
  topicNameSchema,
  topicSlugSchema,
  userRefSchema,
  wireTextSchema,
} from './entities.ts';
import {
  AUTO_MERGE_PATHS_MAX,
  AUTO_MERGE_TEXT_MAX_BYTES,
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
  PREFLIGHT_NESTED_REPOS_MAX,
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
import { epochMsSchema, indexSchema, largeTextSchema, lineTextSchema, modelIdSchema, multilineTextSchema, opaqueIdSchema, sha256HexSchema, shortTextSchema } from './primitives.ts';

// Topics, the plan and its work items, result reports, and what a Start confirms (ARCHITECTURE §5.10). A topic's
// spec and plan are FILES in the project (`specs/<slug>/SPEC.md`, `PLAN.md`); who is responsible, what runs and what
// is reviewed is daemon state keyed by item id.

// ---------------------------------------------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------------------------------------------

/**
 * Derived by the daemon from facts, never set by a request. `archived` is a flag beside it. `ready` (protocol 6): every
 * work item of the plan is settled (merged with nothing of it in progress, left out or undone) and nobody has checked
 * the result yet ("Ready to check").
 */
export const TOPIC_PHASES = ['discussing', 'spec', 'plan', 'executing', 'ready', 'complete'] as const;
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

/**
 * A topic's agent settings (protocol 5): the model of its new sessions (null: the host's default) and the permission
 * mode its work items follow (null: the workspace's).
 */
export const topicAgentSchema = z.strictObject({ model: modelIdSchema.nullable(), permissionMode: sessionModeChoiceSchema.nullable() });
export type TopicAgent = z.infer<typeof topicAgentSchema>;

export const topicSchema = z.strictObject({
  id: opaqueIdSchema,
  name: topicNameSchema,
  /** The folder is `specs/<slug>`; it never changes. */
  slug: topicSlugSchema,
  phase: topicPhaseSchema,
  archived: z.boolean(),
  /**
   * The shared folder has a git repository of its own. Nothing decides from it any more (protocol 5): a folder without
   * one gets smurg's own history, and `HostState.work` says how work items run.
   */
  versioned: z.boolean(),
  /** The model and the permission mode of this topic's sessions and work items. */
  agent: topicAgentSchema,
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
    /**
     * Nothing of the plan starts, merges or continues by itself until "Continue all": a person's "Pause" (protocol 6),
     * or smurg's after a restart of the host's smurg left an item that runs directly in the folder interrupted (until
     * 0.6.0 every restart paused a plan with armed or interrupted items).
     */
    paused: z.boolean(),
    /** Who paused it ("Pause", protocol 6); absent with `paused`: smurg paused it. */
    pausedBy: userRefSchema.optional(),
    /** The last change of PLAN.md, whoever made it (a Plan row is bold when it is newer than what the browser showed). */
    changedAt: epochMsSchema.optional(),
    changedBy: actorSchema.optional(),
    items: indexSchema,
    started: indexSchema,
    reviewed: indexSchema,
    merged: indexSchema,
    /** Items of the plan left out ("Leave it out", protocol 6). */
    leftOut: indexSchema,
    /** Items of the plan whose merge the host undid (protocol 6). */
    undone: indexSchema,
  }),
  /** Always allowed in every session of this topic. */
  rules: z.array(rememberedRuleSchema).max(REMEMBERED_RULES_MAX),
  /** "I've checked the result" (protocol 6): who pressed it, and when. */
  checked: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
});
export type Topic = z.infer<typeof topicSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Result reports
// ---------------------------------------------------------------------------------------------------------------

export const REPORT_OUTCOMES = ['complete', 'partial', 'blocked'] as const;
export const reportOutcomeSchema = z.enum(REPORT_OUTCOMES);
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;

export const REPORT_STATES = ['to-review', 'reviewed', 'changed-after-review', 'invalid'] as const;
export type ReportState = (typeof REPORT_STATES)[number];
/** `failed` (protocol 6): checks written `- [!] <what>: failed: <what happened>`; absent: 0 (a report of 0.6.0 had none). */
export const reportChecksSchema = z.strictObject({ passed: indexSchema, notVerified: indexSchema, failed: indexSchema.optional() });

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

/** Why a report has no changes to review. `no-history` (protocol 5): the item ran directly in the shared folder (no git). */
export const NO_CHANGES_REASONS = ['host-only-paths', 'spec-files', 'conflict-markers', 'no-history'] as const;
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
    /** `failed` (protocol 6): a check that failed, with what happened in `note`. */
    verified: z
      .array(
        z
          .strictObject({
            text: multilineTextSchema(REPORT_CHECK_TEXT_MAX_CHARS),
            passed: z.boolean(),
            note: multilineTextSchema(REPORT_CHECK_TEXT_MAX_CHARS).optional(),
            failed: z.literal(true).optional(),
          })
          .refine((check) => check.failed === undefined || (!check.passed && check.note !== undefined), 'a failed check did not pass and says what happened'),
      )
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
      /** The list of files edited by hand (or of who edited one) was longer than what is kept (protocol 6). */
      byHandTruncated: z.literal(true).optional(),
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

// ---- automatic merging (protocol 6, DESIGN 0.7.0 D6-D9) ----------------------------------------------------------

/**
 * Why a started work item that smurg merges by itself is not merged yet: one enum for `WorkItem.autoMerge.reason` and
 * the inbox item of kind `decision`. `conflict`, `stale-report`, `asked` and `git-busy` appear in two states: still
 * resolving or waiting, then held.
 */
export const AUTO_MERGE_REASONS = [
  // waiting: nobody is needed, smurg tries again by itself
  'queued', 'paused', 'busy', 'asked', 'typing', 'git-busy', 'behind', 'retry',
  // resolving: the item's own agent brings its work up to date, or checks its report again
  'conflict', 'markers', 'stale-report',
  // held: a person decides (the host alone for the second line); `edited`: a merged item's worktree holds changes no
  // merge carried (0.7.0 verify)
  'partial', 'blocked', 'check-failed', 'not-verified', 'report-invalid', 'rejected', 'stopped', 'edited',
  'policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted',
] as const;
export const autoMergeReasonSchema = z.enum(AUTO_MERGE_REASONS);
export type AutoMergeReason = z.infer<typeof autoMergeReasonSchema>;
export const AUTO_MERGE_STATES = ['waiting', 'resolving', 'held'] as const;
export type AutoMergeState = (typeof AUTO_MERGE_STATES)[number];
/** The holds only the host can settle; the others go to the item's carers (`decisionRecipients`). */
export const HOST_HOLDS = ['policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted'] as const;
/** Holds that end by themselves once the host's main workspace is no longer in the way (the merge queue looks again). */
export const SELF_CLEARING_HOLDS = ['local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'undo-interrupted'] as const;
/** Holds the carers may end with "Merge it as it is" (`plan.item.release`): the version stands as it is. */
export const RELEASABLE_HOLDS = ['asked', 'stopped', 'stale-report'] as const;

/** Which reasons each state may carry (the groups of AUTO_MERGE_REASONS, and the four reasons of two states). */
export const AUTO_MERGE_REASONS_OF_STATE: Readonly<Record<AutoMergeState, readonly AutoMergeReason[]>> = Object.freeze({
  waiting: ['queued', 'paused', 'busy', 'asked', 'typing', 'git-busy', 'behind', 'retry'],
  resolving: ['conflict', 'markers', 'stale-report'],
  held: [
    'partial', 'blocked', 'check-failed', 'not-verified', 'report-invalid', 'rejected', 'stopped', 'edited',
    'policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted',
    'conflict', 'stale-report', 'asked', 'git-busy',
  ],
});

/** UTF-8 length without allocating (a lone surrogate counts 3, like TextEncoder's U+FFFD). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The UTF-8 bytes of the paths and the people (their paths, ids and names) of a work item's merge wait or hold, which
 * the wire bounds by AUTO_MERGE_TEXT_MAX_BYTES together.
 */
export function autoMergeTextBytes(info: {
  readonly paths?: readonly string[] | undefined;
  readonly people?: readonly { readonly path: string; readonly by: readonly { readonly userId: string; readonly displayName: string }[] }[] | undefined;
}): number {
  let bytes = 0;
  for (const path of info.paths ?? []) bytes += utf8Bytes(path);
  for (const change of info.people ?? []) {
    bytes += utf8Bytes(change.path);
    for (const user of change.by) bytes += utf8Bytes(user.userId) + utf8Bytes(user.displayName);
  }
  return bytes;
}

/** A path the other side of a conflict changed outside this plan's work items, and who (`outside`: no member made it). */
export const peopleChangeSchema = z.strictObject({ path: entryPathSchema, by: z.array(userRefSchema).max(5), outside: z.boolean() });
export type PeopleChange = z.infer<typeof peopleChangeSchema>;

/**
 * What a started item that smurg merges by itself waits for now (protocol 6). `since`: when the state or the reason
 * last changed. `tries`: the resolve turns smurg asked for since the item's Start. `hostOnly`: a hold only the host
 * can settle (HOST_HOLDS); such a hold never escalates. `paths`: the files concerned. `branch`: with `branch`, the
 * branch the Start used and the one the main workspace is on. `people`: with a `conflict` whose other side is a
 * person's change. `asked`: with `asked`, who wrote to the agent. `undelivered`: with a hold, a message no turn has
 * taken waits in the item's session, which has no process, and nothing delivers it by itself (a restart left it there,
 * or the process failed): "Merge it as it is" and "Accept as it is" are refused until Continue delivered it (0.7.0 last
 * check). The paths and the people together take at most AUTO_MERGE_TEXT_MAX_BYTES (every item of a plan may carry
 * them, and a plan travels whole).
 */
export const autoMergeInfoSchema = z
  .strictObject({
    state: z.enum(AUTO_MERGE_STATES),
    reason: autoMergeReasonSchema,
    since: epochMsSchema,
    tries: indexSchema,
    hostOnly: z.boolean(),
    escalated: z.boolean(),
    paths: z.array(entryPathSchema).max(AUTO_MERGE_PATHS_MAX).optional(),
    branch: z.strictObject({ expected: shortBranchSchema, current: shortTextSchema }).optional(),
    people: z.array(peopleChangeSchema).max(AUTO_MERGE_PATHS_MAX).optional(),
    asked: userRefSchema.optional(),
    undelivered: z.literal(true).optional(),
  })
  .refine((info) => AUTO_MERGE_REASONS_OF_STATE[info.state].includes(info.reason), 'a reason of another state')
  .refine((info) => info.hostOnly === (info.state === 'held' && (HOST_HOLDS as readonly string[]).includes(info.reason)), 'only a hold of HOST_HOLDS is the host\'s')
  .refine((info) => !info.escalated || (info.state === 'held' && !info.hostOnly), 'only a hold that is not the host\'s escalates')
  .refine((info) => info.branch === undefined || info.reason === 'branch', '`branch` goes with the reason branch')
  .refine((info) => info.people === undefined || info.reason === 'conflict', '`people` goes with a conflict')
  .refine((info) => info.asked === undefined || info.reason === 'asked', '`asked` goes with the reason asked')
  .refine((info) => info.undelivered === undefined || info.state === 'held', '`undelivered` goes with a hold')
  .refine((info) => autoMergeTextBytes(info) <= AUTO_MERGE_TEXT_MAX_BYTES, `the paths and the people take more than ${AUTO_MERGE_TEXT_MAX_BYTES} bytes`);
export type AutoMergeInfo = z.infer<typeof autoMergeInfoSchema>;

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
  /**
   * How this started item's change reaches the main workspace now (protocol 6): smurg merges it (`auto`, both its
   * Start and the workspace's setting say so), or the host does. Absent: not started, or nothing to merge (it ran
   * directly in the shared folder).
   */
  merging: mergePolicySchema.optional(),
  /**
   * With `merging: 'auto'`: what it waits for before smurg merges it (absent: nothing, or it is merged). With
   * `merging: 'host'`: only the hold of an item whose version is merged while a message nothing delivers by itself
   * waits in its session (`stopped`, `undelivered`; 0.7.0 fix5), or whose later turn did not finish after its merge
   * (`stopped`; 0.7.0 fix6). An item that ran directly in the shared folder (no `merging`): what it is held for before
   * it counts as merged (DESIGN 0.7.0 D10).
   */
  autoMerge: autoMergeInfoSchema.optional(),
  /** Its change reached the main workspace (protocol 6): when, and who merged it (`smurg`: on the host's standing consent). */
  merged: z.strictObject({ at: epochMsSchema, by: z.union([z.literal('smurg'), userRefSchema]) }).optional(),
  /** "Leave it out" (protocol 6): it and what depends on it are not merged. */
  leftOut: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
  /** The host undid its merge (protocol 6). */
  undone: z.strictObject({ by: userRefSchema, at: epochMsSchema }).optional(),
  /** Its session waits for a person: an open question or a permission request (protocol 6). */
  waiting: z.enum(['question', 'permission']).optional(),
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
  /** Who this plan waits for, and for what (`decisions`, protocol 6: the work items' decisions in their inbox). */
  waitingFor: z
    .array(z.strictObject({ user: userRefSchema, questions: indexSchema, permissions: indexSchema, reports: indexSchema, decisions: indexSchema, since: epochMsSchema }))
    .max(PLAN_WAITING_FOR_MAX),
  slots: z.strictObject({ inUse: indexSchema, max: indexSchema, waitingForPeople: indexSchema }),
});
export type PlanInfo = z.infer<typeof planInfoSchema>;

/** How the items a Start starts now would run: the folder's own git, smurg's own history, or directly in the folder. */
export const START_HISTORIES = ['folder', 'smurg', 'direct'] as const;

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
  /** How the items started now run (protocol 5). */
  history: z.enum(START_HISTORIES),
  /**
   * With history `direct`: why git cannot be used, and `hostOnly` when the caller is not the host (only the host starts
   * items that run directly in the folder). Null otherwise.
   */
  direct: z.strictObject({ reason: wireTextSchema, hostOnly: z.boolean() }).nullable(),
  /** The topic's agent settings a Start would use, and the mode its items would run with (`effectivePermissionMode`). */
  agent: z.strictObject({ model: modelIdSchema.nullable(), permissionMode: sessionModeChoiceSchema.nullable(), effective: permissionModeSchema }),
  /** With history `smurg`: folders that are git repositories of their own and are not copied into work items. */
  nestedRepos: z.array(entryPathSchema).max(PREFLIGHT_NESTED_REPOS_MAX),
  /** With history `smurg`: the folder lies in a folder a cloud service syncs. */
  cloudSynced: z.boolean(),
  /** The checkpoint commit of exactly the two files; only with history `folder` (null otherwise). */
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
  /**
   * How the items started now reach the main workspace (protocol 6); null with history `direct` (nothing to merge).
   * `workspace`: the host's setting. `proposed`: what the dialog selects first: `host` when the workspace says so, the
   * main workspace is on no branch, or the topic's last Start chose it, else `auto`. `detached`: the folder's own git
   * with HEAD on no branch: only `host` is possible.
   */
  merging: z.strictObject({ workspace: mergePolicySchema, proposed: mergePolicySchema, detached: z.boolean() }).nullable(),
})
  .refine((p) => (p.direct !== null) === (p.history === 'direct'), '`direct` goes with history direct')
  .refine((p) => (p.merging === null) === (p.history === 'direct'), 'how the items merge is said unless they run directly in the folder')
  .refine((p) => p.merging === null || !p.merging.detached || (p.history === 'folder' && p.merging.proposed === 'host'), 'a detached HEAD: the folder\'s own git, and only the host merges')
  .refine((p) => p.merging === null || p.merging.workspace === 'auto' || p.merging.proposed === 'host', 'nobody proposes automatic merging while the workspace says the host merges')
  .refine((p) => p.commit === null || p.history === 'folder', 'a checkpoint commit only in the folder\'s own repository')
  .refine((p) => p.history === 'smurg' || (p.nestedRepos.length === 0 && !p.cloudSynced), 'nested repositories and the cloud-synced flag only with smurg\'s own history');
export type StartPreflight = z.infer<typeof startPreflightSchema>;
