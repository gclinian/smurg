import { z } from 'zod';
import { mentionsSchema, reasonTextSchema, suggestionSchema, suggestionSourceSchema, suggestionTextSchema } from '../entities.ts';
import { LIST_MAX_ITEMS } from '../limits.ts';
import { opaqueIdSchema } from '../primitives.ts';

// suggest.* (ARCHITECTURE §5.6, SPEC R6). There is no auto-accept path: suggestion text reaches an agent only through
// the suggest.accept handler (a member with `session.drive`), as a message of its author.

/**
 * Agent sessions only (`suggest.terminal`), the author's own included; at most SUGGESTIONS_PENDING_PER_AUTHOR_MAX
 * pending per author and session. With `source` the suggestion's origin is `selection`, else `composer`.
 */
export const suggestCreatePayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  text: suggestionTextSchema,
  source: suggestionSourceSchema.optional(),
  mentions: mentionsSchema.optional(),
});
export const suggestionResultSchema = z.strictObject({ suggestion: suggestionSchema });

export const suggestEditPayloadSchema = z.strictObject({ suggestionId: opaqueIdSchema, text: suggestionTextSchema });

export const suggestWithdrawPayloadSchema = z.strictObject({ suggestionId: opaqueIdSchema });

/** `text` present ⇒ status `accepted-modified` and `finalText = text`. */
export const suggestAcceptPayloadSchema = z.strictObject({
  suggestionId: opaqueIdSchema,
  text: suggestionTextSchema.optional(),
});

export const suggestRejectPayloadSchema = z.strictObject({
  suggestionId: opaqueIdSchema,
  reason: reasonTextSchema.optional(),
});

/**
 * Without `sessionId`: every suggestion the caller may see. Newest first. THE list rule: a reply is closed at
 * LIST_REPLY_MAX_BYTES or LIST_MAX_ITEMS; `hasMore` then, and `after` (the last suggestion's id) continues.
 */
export const suggestListPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema.optional(), after: opaqueIdSchema.optional() });
export const suggestListResultSchema = z.strictObject({
  suggestions: z.array(suggestionSchema).max(LIST_MAX_ITEMS),
  hasMore: z.boolean(),
});

/** To the watchers of the session, the author, and the members whose inbox holds it. */
export const suggestUpdatedPayloadSchema = z.strictObject({ suggestion: suggestionSchema });
