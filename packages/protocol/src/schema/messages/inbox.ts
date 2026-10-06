import { z } from 'zod';
import { inboxItemSchema, inboxKeySchema } from '../inbox.ts';
import { INBOX_ITEMS_MAX, INBOX_SEEN_KEYS_MAX } from '../limits.ts';
import { emptyPayloadSchema } from './channel.ts';

// inbox.* (ARCHITECTURE §5.11). Every member reads their OWN inbox; nothing here names another member.

/** THE list rule: a reply is closed at LIST_REPLY_MAX_BYTES; `hasMore` then, and `after` (the last key) continues. */
export const inboxListPayloadSchema = z.strictObject({ after: inboxKeySchema.optional() });
export const inboxListResultSchema = z.strictObject({ items: z.array(inboxItemSchema).max(INBOX_ITEMS_MAX), hasMore: z.boolean() });

/** To the member's own channels. Large changes are split into several events by the list rule. */
export const inboxChangedPayloadSchema = z.strictObject({
  upsert: z.array(inboxItemSchema).max(INBOX_ITEMS_MAX),
  remove: z.array(inboxKeySchema).max(INBOX_ITEMS_MAX),
});

/** Clears `unread`; opening a mention or a result this way also removes it. */
export const inboxSeenPayloadSchema = z.strictObject({ keys: z.array(inboxKeySchema).min(1).max(INBOX_SEEN_KEYS_MAX) });

/** Mentions and results only (`inbox.notDismissable` otherwise). */
export const inboxDismissPayloadSchema = z.strictObject({ key: inboxKeySchema });
export const inboxDismissResultSchema = emptyPayloadSchema;
