import { z } from 'zod';
import { actorSchema, itemIdSchema, itemTitleSchema, userRefSchema } from './entities.ts';
import { reportChecksSchema, reportOutcomeSchema } from './topics.ts';
import { INBOX_ALSO_FOR_MAX, INBOX_EXCERPT_MAX_CHARS, INBOX_KEY_MAX_CHARS, OPTION_LABEL_MAX_CHARS, PLAN_ITEMS_MAX } from './limits.ts';
import { epochMsSchema, indexSchema, lineTextSchema, multilineTextSchema, opaqueIdSchema } from './primitives.ts';

// The inbox (ARCHITECTURE §5.11): a per-member view the daemon DERIVES from open things (questions, permission
// requests, suggestions, reports, merges, work that stopped). Only mentions, the results of one's own suggestions and
// the "seen" marks are stored. An item leaves when the thing is settled. The sentence of a row is composed by each
// client from these fields in the viewer's language.

/**
 * The sections of the host console an item may open (`ColumnTarget { kind: 'console' }`). The attention subjects map
 * to them: `account` and `storage` → `sessions`; `project-settings` → `claude-config`; `host-rules` → `host-rules`.
 */
export const CONSOLE_SECTIONS = ['members', 'sessions', 'suggestions', 'merges', 'invites', 'audit', 'settings', 'claude-config', 'host-rules'] as const;
export const consoleSectionSchema = z.enum(CONSOLE_SECTIONS);
export type ConsoleSection = z.infer<typeof consoleSectionSchema>;

/** What a column shows; an inbox item opens its `target`. */
export const columnTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('spec'), topicId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('plan'), topicId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('report'), topicId: opaqueIdSchema, itemId: itemIdSchema }),
  z.strictObject({ kind: z.literal('changes'), requestId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('console'), section: consoleSectionSchema }),
]);
export type ColumnTarget = z.infer<typeof columnTargetSchema>;

export const INBOX_KINDS = ['question', 'vote', 'permission', 'attention', 'suggestion', 'report', 'merge', 'mention', 'result'] as const;
export const inboxKindSchema = z.enum(INBOX_KINDS);
export type InboxKind = z.infer<typeof inboxKindSchema>;

/** Work that stopped and has no card. */
export const ATTENTION_SUBJECTS = [
  'item-stalled',
  'item-failed',
  'item-stopped',
  'item-not-started',
  'plan-paused',
  'discussion-lost',
  'account',
  'project-settings',
  'host-rules',
  'storage',
] as const;
export const attentionSubjectSchema = z.enum(ATTENTION_SUBJECTS);
export type AttentionSubject = z.infer<typeof attentionSubjectSchema>;

/** `<kind>:<entity id>`; an attention item: `attention:<subject>:<id>`. */
export const inboxKeySchema = z.string().min(3).max(INBOX_KEY_MAX_CHARS).regex(/^[a-z]+:[\x21-\x7e]+$/, 'not an inbox key');

export const inboxAnchorSchema = z.strictObject({ cardId: opaqueIdSchema.optional(), seq: z.int().min(1).optional() });

/** What became of one's own suggestion (an item of kind `result`). */
export const INBOX_RESULTS = ['rejected', 'accepted-edited'] as const;

/** Whether an item of this kind stops an agent or a plan (`InboxItem.waiting`). */
export function inboxKindWaits(kind: InboxKind, subject?: AttentionSubject): boolean {
  if (kind === 'question' || kind === 'vote' || kind === 'permission') return true;
  return kind === 'attention' && subject !== undefined && subject !== 'host-rules' && subject !== 'storage';
}

/** The fields of an item beyond the ones every item has (`key`, `kind`, `at`, `unread`, `waiting`, `target`, `excerpt`). */
export const INBOX_KIND_FIELD_NAMES = [
  'subject',
  'topicId',
  'sessionId',
  'itemId',
  'item',
  'anchor',
  'from',
  'count',
  'voted',
  'eligible',
  'allVoted',
  'leading',
  'waitsFor',
  'waitsForOffline',
  'escalated',
  'alsoFor',
  'alsoForMore',
  'outcome',
  'checks',
  'result',
  'ready',
  'unblocks',
  'conflict',
] as const;
export type InboxKindField = (typeof INBOX_KIND_FIELD_NAMES)[number];

const WHERE = ['topicId', 'itemId', 'item'] as const;
const WAITS_FOR = ['waitsFor', 'waitsForOffline', 'escalated', 'alsoFor', 'alsoForMore'] as const;

/**
 * Which fields each kind carries: `required` are always there, `optional` may be, anything else is refused. What
 * `excerpt` holds is the last column of the table in ARCHITECTURE §5.11:
 *
 *   question    the text of part 1                              vote        the text of part 1
 *   permission  the command, the URL or the path relative to the root (never the absolute `path`)
 *   suggestion  the text of the author's oldest pending one     result      the suggestion's text
 *   mention     the text around the mention                     merge       the request's message, or ''
 *   report      ''                                              attention   the topic's name for `plan-paused` and
 *                                                                           `discussion-lost`, else ''
 *
 * The row names a work item from `item` (its number and title), never from `excerpt`.
 */
export const INBOX_KIND_FIELDS: Readonly<Record<InboxKind, { readonly required: readonly InboxKindField[]; readonly optional: readonly InboxKindField[] }>> = Object.freeze({
  // A question I decide. `anchor.cardId`: the question. `leading`: `leadingLabel()`. `waitsFor`: the decider, in the
  // copies of the others who may submit once it escalated.
  question: { required: ['sessionId', 'anchor', 'voted', 'eligible', 'allVoted'], optional: [...WHERE, 'leading', ...WAITS_FOR] },
  // An open question of a session with nobody assigned, for a member who has not voted. `waitsFor`: who decides.
  vote: { required: ['sessionId', 'anchor', 'voted', 'eligible'], optional: [...WHERE, 'waitsFor', 'waitsForOffline'] },
  permission: { required: ['sessionId', 'anchor'], optional: [...WHERE, ...WAITS_FOR] },
  // ONE item per author and session. `anchor.cardId`: the oldest pending one. `count`: how many are pending.
  suggestion: { required: ['sessionId', 'anchor', 'from', 'count'], optional: [...WHERE, 'alsoFor', 'alsoForMore'] },
  report: { required: ['topicId', 'itemId', 'item', 'outcome', 'checks'], optional: ['sessionId', ...WAITS_FOR] },
  // `ready`: a reviewed draft nobody asked to merge yet (then there is no `from`). `unblocks`: item numbers that wait.
  merge: { required: ['ready', 'conflict'], optional: [...WHERE, 'from', 'unblocks'] },
  mention: { required: ['from'], optional: [...WHERE, 'sessionId', 'anchor'] },
  // `from`: who rejected or edited it. `anchor.cardId`: the suggestion.
  result: { required: ['sessionId', 'anchor', 'from', 'result'], optional: [...WHERE] },
  // `count`: sessions an account problem stops; items of a paused plan.
  attention: { required: ['subject'], optional: [...WHERE, 'sessionId', 'count'] },
});

/** Kinds whose `anchor.cardId` names the card the item is about. */
export const INBOX_CARD_KINDS: readonly InboxKind[] = Object.freeze(['question', 'vote', 'permission', 'suggestion', 'result']);

export const inboxItemSchema = z
  .strictObject({
    key: inboxKeySchema,
    kind: inboxKindSchema,
    /** With kind `attention`. */
    subject: attentionSubjectSchema.optional(),
    at: epochMsSchema,
    unread: z.boolean(),
    /** An agent or a plan is stopped on this (the amber count): `inboxKindWaits(kind, subject)`. */
    waiting: z.boolean(),
    topicId: opaqueIdSchema.optional(),
    sessionId: opaqueIdSchema.optional(),
    itemId: itemIdSchema.optional(),
    /** The work item's number and title, wherever `itemId` is ("1 · Cart API"; `number` 0: it left the plan). */
    item: z.strictObject({ number: indexSchema, title: itemTitleSchema }).optional(),
    target: columnTargetSchema,
    anchor: inboxAnchorSchema.optional(),
    /** The suggestions' author, the merge requester, who mentioned (a person or an agent), who decided a suggestion. */
    from: actorSchema.optional(),
    /** Per kind: INBOX_KIND_FIELDS. Clipped to INBOX_EXCERPT_MAX_CHARS. */
    excerpt: multilineTextSchema(INBOX_EXCERPT_MAX_CHARS),
    /** Suggestions of one author in one session; sessions an account problem stops; items of a paused plan. */
    count: indexSchema.optional(),
    /** Members who voted on every part (`votersOf(question).complete`), of `eligible`. */
    voted: indexSchema.optional(),
    eligible: indexSchema.optional(),
    allVoted: z.boolean().optional(),
    /** The leading option of the question's first part (`leadingLabel`); absent on a tie and before anyone voted. */
    leading: lineTextSchema(OPTION_LABEL_MAX_CHARS).optional(),
    waitsFor: userRefSchema.optional(),
    waitsForOffline: z.boolean().optional(),
    escalated: z.boolean().optional(),
    /** Others who may settle it; `alsoForMore`: how many more. */
    alsoFor: z.array(userRefSchema).max(INBOX_ALSO_FOR_MAX).optional(),
    alsoForMore: indexSchema.optional(),
    outcome: reportOutcomeSchema.optional(),
    checks: reportChecksSchema.optional(),
    /** With kind `result`: what became of my suggestion. */
    result: z.enum(INBOX_RESULTS).optional(),
    /** merge: a reviewed draft. */
    ready: z.boolean().optional(),
    /** Item numbers that wait for this merge. */
    unblocks: z.array(z.int().min(1)).max(PLAN_ITEMS_MAX).optional(),
    conflict: z.boolean().optional(),
  })
  .superRefine((item, ctx) => {
    const fields = INBOX_KIND_FIELDS[item.kind];
    for (const name of fields.required) if (item[name] === undefined) ctx.addIssue({ code: 'custom', path: [name], message: `an inbox item of kind ${item.kind} has ${name}` });
    for (const name of INBOX_KIND_FIELD_NAMES) {
      if (item[name] !== undefined && !fields.required.includes(name) && !fields.optional.includes(name)) {
        ctx.addIssue({ code: 'custom', path: [name], message: `an inbox item of kind ${item.kind} has no ${name}` });
      }
    }
    if (INBOX_CARD_KINDS.includes(item.kind) && item.anchor?.cardId === undefined) ctx.addIssue({ code: 'custom', path: ['anchor', 'cardId'], message: 'the item names its card' });
    if ((item.item !== undefined) !== (item.itemId !== undefined)) ctx.addIssue({ code: 'custom', path: ['item'], message: 'item goes with itemId' });
    if (item.itemId !== undefined && item.topicId === undefined) ctx.addIssue({ code: 'custom', path: ['topicId'], message: 'an item belongs to a topic' });
    if (item.waiting !== inboxKindWaits(item.kind, item.subject)) ctx.addIssue({ code: 'custom', path: ['waiting'], message: 'waiting follows the kind' });
    const prefix = item.kind === 'attention' ? `attention:${item.subject ?? ''}:` : `${item.kind}:`;
    if (!item.key.startsWith(prefix) || item.key.length === prefix.length) ctx.addIssue({ code: 'custom', path: ['key'], message: `the key starts with ${prefix}` });
  });
export type InboxItem = z.infer<typeof inboxItemSchema>;
