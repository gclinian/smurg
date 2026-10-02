import { z } from 'zod';
import {
  activityEventSchema,
  actorSchema,
  lockInfoSchema,
  presenceAgentSchema,
  presenceMemberSchema,
} from '../entities.ts';
import { LIST_MAX_ITEMS, NOTIFY_TEXT_MAX_CHARS, PAGE_LIMIT_MAX } from '../limits.ts';
import { messageRefSchema } from '../message-ref.ts';
import { entryRefSchema, fileRefSchema } from '../paths.ts';
import { epochMsSchema, multilineTextSchema, opaqueIdSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// lock.*, presence.*, activity.* (ARCHITECTURE §5.4). There is no lock.acquire Envelope: the human lock is taken by
// the daemon on the first human Yjs update, and agent locks are requested on the hook socket (§7.7).

/** Broadcast on every change; `lock: null` = the file is free. */
export const lockStatePayloadSchema = z.strictObject({ file: fileRefSchema, lock: lockInfoSchema.nullable() });

export const lockListPayloadSchema = emptyPayloadSchema;
export const lockListResultSchema = z.strictObject({ locks: z.array(lockInfoSchema).max(LIST_MAX_ITEMS) });

/** "Let the agent go first": the caller leaves the human lock of `file`. */
export const lockReleasePayloadSchema = z.strictObject({ file: entryRefSchema });
export const lockReleaseResultSchema = emptyPayloadSchema;

export const lockForceReleasePayloadSchema = z.strictObject({ file: entryRefSchema });
export const lockForceReleaseResultSchema = emptyPayloadSchema;

/** Every PRESENCE_HEARTBEAT_INTERVAL_MS; the client shows "The host is offline" after CLIENT_OFFLINE_THRESHOLD_MS of silence. */
export const presenceHeartbeatPayloadSchema = z.strictObject({ at: epochMsSchema });

export const presenceStatePayloadSchema = z.strictObject({
  members: z.array(presenceMemberSchema).max(LIST_MAX_ITEMS),
  agents: z.array(presenceAgentSchema).max(LIST_MAX_ITEMS),
});

/** The file the member is looking at (`null` = none). */
export const presenceUpdatePayloadSchema = z.strictObject({ activeFile: fileRefSchema.nullable().optional() });

export const activityEventPayloadSchema = z.strictObject({ event: activityEventSchema });

/** `before`: only events with `at < before` (epoch ms; `at` is strictly increasing per log, so this is exact). */
export const activityListPayloadSchema = z.strictObject({
  limit: z.int().min(1).max(PAGE_LIMIT_MAX).optional(),
  before: epochMsSchema.optional(),
});
export const activityListResultSchema = z.strictObject({
  events: z.array(activityEventSchema).max(PAGE_LIMIT_MAX),
});

/**
 * (Addition) A notification for one member, sent only to that member's connections. SPEC R8 gives agents an MCP tool
 * to notify a teammate (`notify_member`, §7.7); this is how the notification reaches the member.
 *
 * Exactly one of:
 *  - `text`: an agent's own words (never translated);
 *  - `msg` + `fallback`: a notification the daemon wrote (`notify.*` of `@smurg/protocol/i18n`) and its English
 *    rendering. A client shows `render(locale, msg) ?? fallback`.
 */
export const memberNotificationSchema = z
  .strictObject({
    id: opaqueIdSchema,
    at: epochMsSchema,
    from: actorSchema,
    text: multilineTextSchema(NOTIFY_TEXT_MAX_CHARS, 1).optional(),
    msg: messageRefSchema.optional(),
    fallback: multilineTextSchema(NOTIFY_TEXT_MAX_CHARS, 1).optional(),
    file: fileRefSchema.optional(),
  })
  .refine(
    (n) => (n.text !== undefined ? n.msg === undefined && n.fallback === undefined : n.msg !== undefined && n.fallback !== undefined),
    'exactly one of `text` or `msg` + `fallback`',
  );
export type MemberNotification = z.infer<typeof memberNotificationSchema>;
export const activityNotifyPayloadSchema = z.strictObject({ notification: memberNotificationSchema });
