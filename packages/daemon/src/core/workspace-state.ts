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

import { stateShapeV040, type StateV040 } from '../frozen/v0.4.0.ts';
import { defaultMaxLiveAgents } from './config.ts';
import { declareDocument, defineStep, type DocumentDeclaration, type DocumentStep } from './state-store.ts';

export const STATE_DOCUMENT = 'state';
/**
 * Version 1 has TWO published shapes, told apart by the shape, this once: 0.4.0's (six settings, src/frozen/v0.4.0.ts)
 * and 0.5.0's (nine). From the next change on, a change of what this document accepts is a new number and a step.
 */
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

/**
 * state.json of smurg 0.4.0 → today's: 0.5.0 added three settings. Everything else is carried as it is: every
 * member, device, invite and root, every kick, revocation and use count (an upgrade that reset or dropped one would
 * let a kicked member or a used-up link back in).
 *
 * The values are CONSTANTS OF THIS STEP, frozen with it, and never read from today's defaults for a new workspace:
 * `agentMcp: false` is the closed side (agents get no MCP server of the host or the project until the host switches
 * it on), and a later release that changes what a NEW workspace gets must not switch it on for every 0.4.0 workspace
 * it upgrades. `maxLiveAgents` is the one computed value: the default for this machine, by the function a new
 * workspace uses.
 */
export const stateStepFromV040: DocumentStep = defineStep({
  from: '0.4.0',
  sinceShapes: 1,
  shape: stateShapeV040,
  upgrade: (old: StateV040, env) => ({
    ...old,
    settings: { ...old.settings, maxLiveAgents: defaultMaxLiveAgents(env.memoryBytes), escalateAfterMs: 300_000, agentMcp: false },
  }),
});

/** The core's document of one workspace (`init`: what a new workspace gets on this machine). */
export function stateDocument(workspaceId: string, settings: HostSettings): DocumentDeclaration<typeof workspaceStateSchema> {
  return declareDocument({ name: STATE_DOCUMENT, schema: workspaceStateSchema, init: () => initialWorkspaceState(workspaceId, settings), steps: [stateStepFromV040] });
}
