import { z } from 'zod';
import { mentionsSchema, personTextSchema } from '../entities.ts';
import {
  alwaysScopeSchema,
  optionIndexesSchema,
  permissionRequestSchema,
  questionCommentSchema,
  questionSchema,
  questionVoteSchema,
} from '../conversation.ts';
import { ANSWER_NOTE_MAX_CHARS, COMMENT_MAX_CHARS, DENY_MESSAGE_MAX_CHARS, OTHER_ANSWER_MAX_CHARS, QUESTION_PARTS_MAX } from '../limits.ts';
import { epochMsSchema, indexSchema, opaqueIdSchema, userIdSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// question.* and permission.* (ARCHITECTURE §5.9): the cards of an agent session. Card updates go to the session's
// watchers through AgentSessions.toWatchers.

const partIndexSchema = z.int().min(0).max(QUESTION_PARTS_MAX - 1);
const otherTextSchema = personTextSchema(OTHER_ANSWER_MAX_CHARS);

/**
 * One of `options` / `other`, or neither to take the vote back. `options` are indexes into that part's options:
 * exactly one unless the part is `multi`. `other`: the voter's own words, for every member holding `discuss`; shown
 * to people only, never sent to the agent by the daemon.
 */
export const questionVotePayloadSchema = z
  .strictObject({ questionId: opaqueIdSchema, part: partIndexSchema, options: optionIndexesSchema.optional(), other: otherTextSchema.optional() })
  .refine((vote) => vote.options === undefined || vote.other === undefined, 'options or other, not both');
export const questionVoteResultSchema = emptyPayloadSchema;

export const questionCommentPayloadSchema = z.strictObject({
  questionId: opaqueIdSchema,
  text: personTextSchema(COMMENT_MAX_CHARS),
  mentions: mentionsSchema.optional(),
});
export const questionCommentResultSchema = z.strictObject({ commentId: opaqueIdSchema });

/**
 * One answer per part, validated exactly like a vote. Allowed for the decider; for the host at any time; once the
 * question escalated, for every member with `session.drive`. Whenever the submitter is not the decider the answer
 * records `onBehalfOf`. SUBMITTING `other` or `note` needs `session.drive` (`question.otherNeedsAgentAccess`).
 * `otherBy` names the member whose "Other" vote the text came from. The first submit wins: a later one is refused
 * with `settledError` (`conflict`, reason `settled`).
 */
export const questionSubmitPayloadSchema = z.strictObject({
  questionId: opaqueIdSchema,
  answers: z
    .array(z.union([z.strictObject({ options: optionIndexesSchema }), z.strictObject({ other: otherTextSchema, otherBy: userIdSchema.optional() })]))
    .min(1)
    .max(QUESTION_PARTS_MAX),
  note: personTextSchema(ANSWER_NOTE_MAX_CHARS).optional(),
});
export const questionResultSchema = z.strictObject({ question: questionSchema });

/** The decider or the host: a mention for every eligible member who has not voted; once a minute per question. */
export const questionRemindPayloadSchema = z.strictObject({ questionId: opaqueIdSchema });
export const questionRemindResultSchema = emptyPayloadSchema;

/** The decider's client sends it once the card is on screen. */
export const questionSeenPayloadSchema = z.strictObject({ questionId: opaqueIdSchema });

/** One small change of an OPEN question (a few hundred bytes, never the whole question). */
export const questionChangedPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  questionId: opaqueIdSchema,
  vote: questionVoteSchema.optional(),
  voteRemoved: z.strictObject({ userId: userIdSchema, part: partIndexSchema }).optional(),
  comment: questionCommentSchema.optional(),
  eligible: indexSchema.optional(),
  deciderSeenAt: epochMsSchema.optional(),
});

/** The whole entity: when it is answered or withdrawn, when the decider changes, when it escalates. */
export const questionUpdatedPayloadSchema = z.strictObject({ question: questionSchema });

export const PERMISSION_DECISIONS = ['allow', 'allow-always', 'deny'] as const;

/**
 * The first answer wins: a later one is refused with `settledError` (`conflict`, reason `settled`, `detail.card`,
 * `detail.status`, `detail.by`; the card itself is not in the error: watchers have it from `permission.updated`).
 * `allow-always` only when the request offers `alwaysRule` (the client never sends a rule); `scope` defaults to
 * `session`; `topic` only for a session of a topic. `message`: with `deny`, what the agent should do instead.
 */
export const permissionDecidePayloadSchema = z
  .strictObject({
    requestId: opaqueIdSchema,
    decision: z.enum(PERMISSION_DECISIONS),
    scope: alwaysScopeSchema.optional(),
    message: personTextSchema(DENY_MESSAGE_MAX_CHARS).optional(),
  })
  .refine((p) => p.scope === undefined || p.decision === 'allow-always', 'scope goes with allow-always')
  .refine((p) => p.message === undefined || p.decision === 'deny', 'message goes with deny');
export const permissionResultSchema = z.strictObject({ request: permissionRequestSchema });

/** The host's copy carries `path` for an `outside` request; everyone else's does not. */
export const permissionUpdatedPayloadSchema = z.strictObject({ request: permissionRequestSchema });
