import { z } from 'zod';
import { reasonTextSchema, suggestionSchema, suggestionSourceSchema, suggestionTextSchema } from '../entities.ts';
import { LIST_MAX_ITEMS } from '../limits.ts';
import { opaqueIdSchema } from '../primitives.ts';

// suggest.* (ARCHITECTURE §5.6, SPEC R6). There is no auto-accept path: suggestion text reaches a PTY only through
// the suggest.accept handler, after the session-ownership check.

/** Target session must belong to someone else (checked by the daemon). */
export const suggestCreatePayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  text: suggestionTextSchema,
  source: suggestionSourceSchema.optional(),
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

/** Without `sessionId`: every suggestion the caller may see. */
export const suggestListPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema.optional() });
export const suggestListResultSchema = z.strictObject({
  suggestions: z.array(suggestionSchema).max(LIST_MAX_ITEMS),
});

/** Sent to the session owner, the author and the host. */
export const suggestUpdatedPayloadSchema = z.strictObject({ suggestion: suggestionSchema });
