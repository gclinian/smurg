import { z } from 'zod';
import {
  agentSessionSchema,
  itemIdSchema,
  itemTitleSchema,
  mentionsSchema,
  rememberedRuleToolSchema,
  rulePatternSchema,
  sessionModeChoiceSchema,
  shortBranchSchema,
  suggestionSchema,
  topicNameSchema,
  topicSlugSchema,
  userRefSchema,
  wireTextSchema,
} from '../entities.ts';
import { LIST_MAX_ITEMS, PLAN_CHANGES_DIFF_MAX_BYTES, PLAN_INFO_ITEMS_MAX, PLAN_ITEMS_MAX, QUOTE_HEADING_MAX_CHARS, QUOTE_TEXT_MAX_CHARS, UNDO_ITEMS_MAX } from '../limits.ts';
import { entryPathSchema } from '../paths.ts';
import { indexSchema, largeTextSchema, lineTextSchema, modelIdSchema, multilineTextSchema, opaqueIdSchema, sha256HexSchema, shortTextSchema, userIdSchema } from '../primitives.ts';
import { planInfoSchema, planModeSchema, reportInfoSchema, reportSummarySchema, startPreflightSchema, topicSchema } from '../topics.ts';
import { emptyPayloadSchema } from './channel.ts';
import { messageTextInputSchema } from './sessions.ts';

// topic.*, plan.* and report.* (ARCHITECTURE §5.10).

/**
 * The slug defaults from the name (`slugFromName`); refused when a topic uses it or `specs/<slug>` exists. Creates the
 * folder and the discussion session; `firstMessage` is the caller's first message to the agent. `model` (protocol 5):
 * the model of the discussion and of the topic's later sessions (absent: the host's default).
 */
export const topicCreatePayloadSchema = z.strictObject({
  name: topicNameSchema,
  slug: topicSlugSchema.optional(),
  firstMessage: messageTextInputSchema.optional(),
  model: modelIdSchema.optional(),
});
export const topicWithSessionResultSchema = z.strictObject({ topic: topicSchema, session: agentSessionSchema });

/**
 * `archived` (default false): the archived topics instead of the others. THE list rule: a reply is closed at
 * LIST_REPLY_MAX_BYTES; `hasMore` then, and `after` (the last topic's id) continues.
 */
export const topicListPayloadSchema = z.strictObject({ archived: z.boolean().optional(), after: opaqueIdSchema.optional() });
export const topicListResultSchema = z.strictObject({ topics: z.array(topicSchema).max(LIST_MAX_ITEMS), hasMore: z.boolean() });

export const topicUpdatedPayloadSchema = z.strictObject({ topic: topicSchema });
export const topicRemovedPayloadSchema = z.strictObject({ topicId: opaqueIdSchema });
export const topicResultSchema = z.strictObject({ topic: topicSchema });

/** The folder keeps its slug. */
export const topicRenamePayloadSchema = z.strictObject({ topicId: opaqueIdSchema, name: topicNameSchema });

/**
 * Archiving ends the topic's sessions (reason `archived`) and removes their worktrees. Worktrees with changes that
 * were never merged need a decision: `deleteUnmerged: false` keeps them, `true` removes them; without it the request
 * is refused with `unmergedError` (`conflict`, reason `unmerged`, `detail.worktrees`): the dialog shows the list and
 * repeats the request. `deleteUnmerged` is ignored when nothing is unmerged and when `archived` is false (restoring).
 */
export const topicArchivePayloadSchema = z.strictObject({ topicId: opaqueIdSchema, archived: z.boolean(), deleteUnmerged: z.boolean().optional() });

/** Archived topics only; removes the daemon's records and transcripts, never files in the project. */
export const topicDeletePayloadSchema = z.strictObject({ topicId: opaqueIdSchema });
export const topicDeleteResultSchema = emptyPayloadSchema;

/** A NEW discussion session for the topic; the old one ends with reason `replaced` and stays readable. */
export const topicDiscussionRestartPayloadSchema = z.strictObject({ topicId: opaqueIdSchema });

export const REVISE_TARGETS = ['spec', 'plan'] as const;
const quoteSchema = z.strictObject({ heading: lineTextSchema(QUOTE_HEADING_MAX_CHARS).optional(), text: multilineTextSchema(QUOTE_TEXT_MAX_CHARS, 1) });

/**
 * "Ask the agent to revise". A member with `session.drive`: a message to the discussion session (origin `revise`).
 * Anyone else: a suggestion with that origin. Either way the text that is stored, shown and sent is
 * `composeRevise({ target, quote, text })`: a first line naming the file, the quoted section, then the member's text
 * (`too_large` when that exceeds MESSAGE_TEXT_MAX_CHARS).
 */
export const topicRevisePayloadSchema = z.strictObject({
  topicId: opaqueIdSchema,
  target: z.enum(REVISE_TARGETS),
  text: messageTextInputSchema,
  quote: quoteSchema.optional(),
  mentions: mentionsSchema.optional(),
});
/** Exactly one of the two: the message that was sent, or the suggestion that was created. */
export const messageOrSuggestionResultSchema = z.union([z.strictObject({ messageId: opaqueIdSchema }), z.strictObject({ suggestion: suggestionSchema })]);

/** "Write the spec now": asks the agent for the first draft. */
export const topicSpecRequestPayloadSchema = z.strictObject({ topicId: opaqueIdSchema });
export const topicSpecRequestResultSchema = emptyPayloadSchema;

/**
 * The topic's agent settings (protocol 5): the model of its new sessions and the mode its work items follow; null:
 * the host's default model / the workspace's mode; a key left out is left as it is. At least one key.
 */
export const topicAgentSetPayloadSchema = z
  .strictObject({
    topicId: opaqueIdSchema,
    model: modelIdSchema.nullable().optional(),
    permissionMode: sessionModeChoiceSchema.nullable().optional(),
  })
  .refine((p) => p.model !== undefined || p.permissionMode !== undefined, 'nothing to set');

/** The checked forms only (`rules.ts`). */
export const topicRuleAddPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, tool: rememberedRuleToolSchema, pattern: rulePatternSchema });
export const topicRuleRemovePayloadSchema = z.strictObject({ topicId: opaqueIdSchema, ruleId: opaqueIdSchema });

const topicIdPayloadSchema = z.strictObject({ topicId: opaqueIdSchema });
const topicItemPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemId: itemIdSchema });
const itemIdsSchema = z.array(itemIdSchema).min(1).max(PLAN_INFO_ITEMS_MAX);

/** Generates or updates the plan; sets `Topic.plan.generating` until the turn ends. */
export const planGeneratePayloadSchema = topicIdPayloadSchema;
export const planGenerateResultSchema = emptyPayloadSchema;

export const planGetPayloadSchema = topicIdPayloadSchema;
export const planGetResultSchema = z.strictObject({ plan: planInfoSchema.nullable() });
export const planUpdatedPayloadSchema = z.strictObject({ plan: planInfoSchema });
export const planResultSchema = z.strictObject({ plan: planInfoSchema });

export const planModeSetPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, mode: planModeSchema });

/** Before the item has a session the plan holds the fact; afterwards this writes through the session. */
export const planAssignPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemId: itemIdSchema, userId: userIdSchema.nullable() });

/** "Suggest again": smurg's even split, for items that are not started and not `chosen`. */
export const planSuggestPayloadSchema = topicIdPayloadSchema;

export const planPreflightPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemIds: itemIdsSchema.optional() });
export const planPreflightResultSchema = z.strictObject({ preflight: startPreflightSchema });

/**
 * Without ids: every item of that revision that is not started. The three pins are what the dialog showed
 * (`plan.preflight`): refused with `conflict` reason `plan-changed` when one differs from the files now. Protocol 5:
 * `agent` sets the topic's agent settings in the same change that starts the items (a refused Start changes neither);
 * `direct` confirms that the items change the shared folder directly (required when the preflight said `direct`, and
 * only the host's). Protocol 6 (DESIGN 0.7.0 D3): `merging: 'host'` is "The host merges each item" of this Start, the
 * stricter choice any member may make; there is no way to ask for smurg's merge (the workspace's setting gives it).
 */
export const planStartPayloadSchema = z.strictObject({
  topicId: opaqueIdSchema,
  itemIds: itemIdsSchema.optional(),
  planRevision: z.int().min(0),
  specHash: sha256HexSchema,
  planHash: sha256HexSchema,
  agent: z.strictObject({ model: modelIdSchema.nullable().optional(), permissionMode: sessionModeChoiceSchema.nullable().optional() }).optional(),
  direct: z.literal(true).optional(),
  merging: z.literal('host').optional(),
});

/**
 * "Show the changes" (the Start dialog, the `item-not-started` row): what changed in SPEC.md and PLAN.md since the
 * last confirmed Start (the working tree against the pinned content), or against the last commit before the first
 * Start. One entry per file that differs; `diff` is a unified diff through `mask()`, cut at
 * PLAN_CHANGES_DIFF_MAX_BYTES (`truncated`). Empty when nothing changed or the folder is not a git repository.
 */
export const planChangesPayloadSchema = topicIdPayloadSchema;
export const planChangesResultSchema = z.strictObject({
  files: z.array(z.strictObject({ target: z.enum(REVISE_TARGETS), diff: largeTextSchema(PLAN_CHANGES_DIFF_MAX_BYTES), truncated: z.boolean() })).max(REVISE_TARGETS.length),
});

/** "Continue all" after a restart of the host's smurg. */
export const planResumePayloadSchema = topicIdPayloadSchema;

/** A failed item resumes its session; a stopped item gets a new session in the same worktree. */
export const planItemRetryPayloadSchema = topicItemPayloadSchema;
/** Tells a stalled execution session to go on. */
export const planItemContinuePayloadSchema = topicItemPayloadSchema;
/** After a merge conflict: smurg merges the main workspace into the item's worktree and asks the agent to resolve. */
export const planItemResolvePayloadSchema = topicItemPayloadSchema;
export const planItemActionResultSchema = emptyPayloadSchema;

// ---- protocol 6 (DESIGN 0.7.0 D9, D10, D11, D13): what a person decides about a work item, and the end ----

/**
 * "I've checked the result": refused unless the topic is ready to check (`topic.check.notReady`). The topic is then
 * complete and its work items' sessions end. Anyone who may discuss.
 */
export const topicCheckPayloadSchema = topicIdPayloadSchema;
/**
 * "Leave it out": the item and every item of the plan that depends on it and is not merged are left out (not merged,
 * not started, their sessions ended, their worktrees kept), without editing PLAN.md. Refused for a merged item
 * (`plan.item.leaveOut.merged`: undo is the way back for that).
 */
export const planItemLeaveOutPayloadSchema = topicItemPayloadSchema;
/**
 * "Accept as it is" (the host): an item that ran directly in the shared folder and whose report is not complete and
 * verified counts as merged after all; what depends on it starts. `version`: the report version the host read.
 */
export const planItemAcceptPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemId: itemIdSchema, version: z.int().min(1) });
/**
 * "Merge it as it is": the current version of an item that smurg merges by itself stands although somebody wrote to its
 * agent since, a later turn was stopped, or its report was not checked again; smurg merges it when it is otherwise in
 * order. `version`: the report version the caller read.
 */
export const planItemReleasePayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemId: itemIdSchema, version: z.int().min(1) });
/** "Ask the agent to take them out" (the host): the item changes files only the host may merge; its agent is asked to undo those changes. */
export const planItemRemovePathsPayloadSchema = topicItemPayloadSchema;

// ---- protocol 6 (DESIGN 0.7.0 D14): the host's undo, where smurg keeps history ----

/** Paths an undo's preview names per blocker (each list is cut here; the undo is refused anyway while one is there). */
export const UNDO_PATHS_MAX = 20;
/** Why an item is taken back: it was asked for, its work stands on one that is, or it changed the same lines later. */
export const UNDO_REASONS = ['asked', 'built-on', 'same-lines'] as const;
/** The history an undo writes its commit into: the folder's own `.git`, or smurg's own history (`.smurg/git`). */
export const UNDO_HISTORIES = ['folder', 'smurg'] as const;

/**
 * A work item an undo names, with its topic: an item of ANOTHER topic that is taken back with it (it changed the same
 * lines later) is named with its topic (R-SAFE S13). `number` 0: the item left PLAN.md after it was started.
 */
export const undoItemRefSchema = z.strictObject({ topicId: opaqueIdSchema, topicName: topicNameSchema, itemId: itemIdSchema, number: indexSchema, title: itemTitleSchema });

/**
 * What an undo would do, computed without touching the folder (in smurg's own history after it recorded the folder
 * first). `token`: what `topic.undo` must echo, over what the undo DOES (the merges it reverts, the items it takes back
 * and leaves out, whether its trial is clean), not over the head: a saved edit elsewhere does not make it stale.
 * `undone`: what it takes back; `leftOut`: items not merged that wait for one of them or stand on it (they are left out
 * as "Leave it out" does); `blockers`: what stops it now, each named; `ok`: nothing stops it.
 */
export const undoPreviewSchema = z
  .strictObject({
    token: sha256HexSchema,
    history: z.enum(UNDO_HISTORIES),
    undone: z.array(undoItemRefSchema.extend({ why: z.enum(UNDO_REASONS) })).max(UNDO_ITEMS_MAX),
    leftOut: z.array(undoItemRefSchema).max(UNDO_ITEMS_MAX),
    blockers: z.strictObject({
      /** Items that would go with it and are in a turn now: wait for them, or stop them. */
      running: z.array(undoItemRefSchema).max(UNDO_ITEMS_MAX),
      /** Files a later change of a person (or one made outside smurg: `outside`) touched on the same lines. */
      changedSince: z.array(z.strictObject({ path: entryPathSchema, by: z.array(userRefSchema).max(5), outside: z.boolean() })).max(UNDO_PATHS_MAX),
      /** Files it changes that someone is typing in. */
      typing: z.array(z.strictObject({ path: entryPathSchema, names: z.array(userRefSchema).max(5) })).max(UNDO_PATHS_MAX),
      /** Files it changes that hold uncommitted edits, or an untracked file where it puts one back (the folder's own git). */
      uncommitted: z.array(entryPathSchema).max(UNDO_PATHS_MAX),
      staged: z.boolean(),
      busy: z.boolean(),
      /** The main workspace is not on the branch the items' Start committed on. */
      branch: z.strictObject({ expected: shortBranchSchema, current: shortTextSchema }).nullable(),
      /** It cannot be done here at all: the items ran directly in the folder, smurg's own history changed or is gone, a merge commit cannot be found, an earlier undo was interrupted, too many items. */
      unavailable: wireTextSchema.nullable(),
    }),
    ok: z.boolean(),
  })
  .refine(
    (p) =>
      !p.ok ||
      (p.undone.length > 0 &&
        p.blockers.running.length === 0 &&
        p.blockers.changedSince.length === 0 &&
        p.blockers.typing.length === 0 &&
        p.blockers.uncommitted.length === 0 &&
        !p.blockers.staged &&
        !p.blockers.busy &&
        p.blockers.branch === null &&
        p.blockers.unavailable === null),
    'an undo is ok only with something to take back and nothing in its way',
  );
export type UndoPreview = z.infer<typeof undoPreviewSchema>;
export type UndoItemRef = z.infer<typeof undoItemRefSchema>;

/**
 * "Undo…" (the host, `worktree.merge.decide`): what taking back these merged items (null: every merged item of the
 * topic) would do. Nothing changes. Long-running: the page waits five minutes, as for a merge request.
 */
export const topicUndoPreviewPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemIds: z.array(itemIdSchema).min(1).max(PLAN_ITEMS_MAX).nullable() });
export const topicUndoPreviewResultSchema = z.strictObject({ preview: undoPreviewSchema });
/**
 * "Undo" (the host): takes them back with one new commit, the reports kept. `token`: the preview's; refused with
 * `undo.changed` when what the undo does changed since, and with `undo.notOk` while something is in its way. What goes
 * with it is named by the preview: items built on them are undone too, items that wait for them are left out.
 */
export const topicUndoPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemIds: z.array(itemIdSchema).min(1).max(PLAN_ITEMS_MAX).nullable(), token: sha256HexSchema });

export const reportGetPayloadSchema = topicItemPayloadSchema;
export const reportGetResultSchema = z.strictObject({ report: reportInfoSchema });
export const reportUpdatedPayloadSchema = z.strictObject({ topicId: opaqueIdSchema, itemId: itemIdSchema, report: reportSummarySchema });

/** Like `topic.revise`, to the item's session (origin `follow-up`). */
export const reportFollowUpPayloadSchema = z.strictObject({
  topicId: opaqueIdSchema,
  itemId: itemIdSchema,
  text: messageTextInputSchema,
  mentions: mentionsSchema.optional(),
});

/**
 * "I've reviewed this". `version` must be the current one; a report whose outcome is not `complete` needs
 * `acknowledgeUnfinished`.
 */
export const reportReviewPayloadSchema = z.strictObject({
  topicId: opaqueIdSchema,
  itemId: itemIdSchema,
  version: z.int().min(1),
  acknowledgeUnfinished: z.boolean().optional(),
});
export const reportReviewResultSchema = z.strictObject({ report: reportSummarySchema });
