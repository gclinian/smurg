// Schema of `state.json` (ARCHITECTURE §7.1): members, devices, invites (PSK-derived keys, never the secret),
// settings, and the registered worktree roots with their read-only shared links (PathGuard trusts only these).
// Owned by the core; feature modules keep their own documents (StateStore.document).
import { z } from 'zod';
import {
  avatarUrlSchema,
  colorSchema,
  displayNameSchema,
  entryPathSchema,
  epochMsSchema,
  hostSettingsSchema,
  opaqueIdSchema,
  roleSchema,
  shortTextSchema,
  userIdSchema,
  workspaceIdSchema,
  type HostSettings,
  topicSlugSchema,
  itemIdSchema,
} from '@smurg/protocol';

export const STATE_DOCUMENT = 'state';
export const STATE_VERSION = 1;

const hexSchema = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `not ${bytes} bytes of hex`);

export const memberRecordSchema = z.strictObject({
  userId: userIdSchema,
  displayName: displayNameSchema,
  avatarUrl: avatarUrlSchema.optional(),
  role: roleSchema,
  color: colorSchema,
  joinedAt: epochMsSchema,
  lastSeenAt: epochMsSchema,
  status: z.enum(['active', 'kicked']),
  kickedAt: epochMsSchema.optional(),
});

export const deviceRecordSchema = z.strictObject({
  deviceId: opaqueIdSchema,
  userId: userIdSchema,
  publicKeyHex: hexSchema(32),
  name: shortTextSchema,
  kind: z.enum(['web', 'cli']),
  addedAt: epochMsSchema,
  lastSeenAt: epochMsSchema,
  revoked: z.boolean(),
  revokedAt: epochMsSchema.optional(),
  inviteId: opaqueIdSchema.optional(),
});

export const inviteRecordSchema = z.strictObject({
  id: opaqueIdSchema,
  keyIdHex: hexSchema(16),
  pskHex: hexSchema(32),
  role: roleSchema,
  boundUserId: userIdSchema.optional(),
  createdAt: epochMsSchema,
  createdBy: userIdSchema.nullable(),
  expiresAt: epochMsSchema.optional(),
  maxUses: z.int().min(1).optional(),
  uses: z.int().min(0),
  revoked: z.boolean(),
  host: z.boolean(),
});

export const sharedLinkRecordSchema = z.strictObject({
  path: entryPathSchema,
  mainPath: entryPathSchema,
  targetRealPath: z.string().min(1).startsWith('/'),
});

export const worktreeRootRecordSchema = z.strictObject({
  worktreeId: opaqueIdSchema,
  realPath: z.string().min(1).startsWith('/'),
  ownerUserId: userIdSchema,
  sharedLinks: z.array(sharedLinkRecordSchema).max(64),
  registeredAt: epochMsSchema,
  /** An item worktree: nobody writes `specs/<topicSlug>/` in it through smurg (PathGuard). */
  item: z.strictObject({ topicId: opaqueIdSchema, topicSlug: topicSlugSchema, itemId: itemIdSchema }).optional(),
});

export const workspaceStateSchema = z.strictObject({
  version: z.literal(STATE_VERSION),
  workspaceId: workspaceIdSchema,
  members: z.array(memberRecordSchema),
  devices: z.array(deviceRecordSchema),
  invites: z.array(inviteRecordSchema),
  settings: hostSettingsSchema,
  worktreeRoots: z.array(worktreeRootRecordSchema),
});

export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export function initialWorkspaceState(workspaceId: string, settings: HostSettings): WorkspaceState {
  return { version: STATE_VERSION, workspaceId, members: [], devices: [], invites: [], settings, worktreeRoots: [] };
}
