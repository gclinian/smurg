import { z } from 'zod';
import { memberSchema, publicSettingsSchema, reasonTextSchema } from '../entities.ts';
import { seqSchema } from '../primitives.ts';

// channel.* (ARCHITECTURE §5.1). `channel.hello` / `channel.welcome` are handshake structures (handshake.ts), and
// `error` uses errorPayloadSchema from errors.ts.

/** Payload of requests and results that carry nothing. Unknown keys are refused like everywhere else. */
export const emptyPayloadSchema = z.strictObject({});

export const channelMemberUpdatedPayloadSchema = z.strictObject({ member: memberSchema });

/**
 * (Addition) The host changed the settings every member works with (lock timeouts, upload chunk size, shared dirs):
 * connected clients apply them without reconnecting. Broadcast after every successful admin.settings.set.
 */
export const channelSettingsUpdatedPayloadSchema = z.strictObject({ settings: publicSettingsSchema });

export const CHANNEL_CLOSED_REASONS = ['kicked', 'revoked', 'stopped', 'role-changed', 'protocol-error'] as const;
export const channelClosedPayloadSchema = z.strictObject({
  reason: z.enum(CHANNEL_CLOSED_REASONS),
  message: reasonTextSchema.optional(),
});

/** Lets the peer trim its outbox: every Envelope with `seq ≤ upTo` was processed. */
export const channelAckPayloadSchema = z.strictObject({ upTo: seqSchema });

/**
 * (Addition) The member leaves the workspace on purpose (SPEC R4 「客人離開」): the daemon ends the caller's sessions,
 * deletes their guest directory (which logs Claude out) within R4's 5 s, audits `member.leave`, then answers. The
 * membership and device key stay, so the member can come back later. A mere disconnect does none of this, because
 * sessions must survive disconnects (R4).
 */
export const channelLeavePayloadSchema = emptyPayloadSchema;
export const channelLeaveResultSchema = emptyPayloadSchema;
