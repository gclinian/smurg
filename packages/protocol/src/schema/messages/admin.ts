import { z } from 'zod';
import { guestRoleSchema } from '../../roles.ts';
import {
  auditEntrySchema,
  hostSettingsPatchSchema,
  hostSettingsSchema,
  inviteInfoSchema,
  memberSchema,
  memberWithDevicesSchema,
} from '../entities.ts';
import { LIST_MAX_ITEMS, PAGE_LIMIT_MAX } from '../limits.ts';
import { epochMsSchema, opaqueIdSchema, userIdSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// admin.* — every type requires the `admin` capability (ARCHITECTURE §5.8).

export const INVITE_EXPIRES_IN_SEC_MAX = 365 * 24 * 3600;
export const INVITE_MAX_USES_MAX = 10_000;
export const INVITE_URL_MAX_CHARS = 2_048;

export const adminInviteCreatePayloadSchema = z.strictObject({
  role: guestRoleSchema,
  expiresInSec: z.int().min(1).max(INVITE_EXPIRES_IN_SEC_MAX).optional(),
  maxUses: z.int().min(1).max(INVITE_MAX_USES_MAX).optional(),
});
/**
 * `url` is `https://<web-origin>/join/<workspaceId>#k=…&s=…` (ARCHITECTURE §4.1). It contains the invite secret:
 * sensitive, shown to the host once, never logged.
 */
export const adminInviteCreateResultSchema = z.strictObject({
  invite: inviteInfoSchema,
  url: z
    .string()
    .max(INVITE_URL_MAX_CHARS)
    .regex(/^https?:\/\/[\x21-\x7e]+$/, 'not an invite URL'),
});

export const adminInviteListPayloadSchema = emptyPayloadSchema;
export const adminInviteListResultSchema = z.strictObject({ invites: z.array(inviteInfoSchema).max(LIST_MAX_ITEMS) });

export const adminInviteRevokePayloadSchema = z.strictObject({ inviteId: opaqueIdSchema });
export const adminInviteRevokeResultSchema = emptyPayloadSchema;

export const adminMemberListPayloadSchema = emptyPayloadSchema;
export const adminMemberListResultSchema = z.strictObject({
  members: z.array(memberWithDevicesSchema).max(LIST_MAX_ITEMS),
});

export const adminMemberSetRolePayloadSchema = z.strictObject({ userId: userIdSchema, role: guestRoleSchema });
export const adminMemberSetRoleResultSchema = z.strictObject({ member: memberSchema });

export const adminMemberKickPayloadSchema = z.strictObject({ userId: userIdSchema });
export const adminMemberKickResultSchema = emptyPayloadSchema;

export const adminSessionTerminatePayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
export const adminSessionTerminateResultSchema = emptyPayloadSchema;

/** `before`: only entries with `at < before` (epoch ms, strictly increasing per log). */
export const adminAuditQueryPayloadSchema = z.strictObject({
  limit: z.int().min(1).max(PAGE_LIMIT_MAX).optional(),
  before: epochMsSchema.optional(),
});
export const adminAuditQueryResultSchema = z.strictObject({
  entries: z.array(auditEntrySchema).max(PAGE_LIMIT_MAX),
});

/** Live audit feed, sent to the host only. */
export const adminAuditEntryPayloadSchema = z.strictObject({ entry: auditEntrySchema });

export const adminSettingsGetPayloadSchema = emptyPayloadSchema;
export const hostSettingsResultSchema = z.strictObject({ settings: hostSettingsSchema });

/** `Partial<HostSettings>`; unknown keys are refused. */
export const adminSettingsSetPayloadSchema = hostSettingsPatchSchema;
