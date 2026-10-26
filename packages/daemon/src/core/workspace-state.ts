// Schema of `state.json` (ARCHITECTURE §7.1): members, devices, invites (PSK-derived keys, never the secret),
// settings, the registered worktree roots with their read-only shared links (PathGuard trusts only these), and the
// notices the host has not seen yet (0.6.0; 0.7.0's `auto-merge` beside `agents-auto`). Owned by the core; feature
// modules keep their own documents (StateStore.document).
import { z } from 'zod';
import {
  avatarUrlSchema,
  colorSchema,
  displayNameSchema,
  entryPathSchema,
  epochMsSchema,
  HOST_NOTICES,
  hostNoticeSchema,
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
import { stateShapeV050, type StateV050 } from '../frozen/v0.5.0.ts';
import { stateShapeV060, type StateV060 } from '../frozen/v0.6.0.ts';
import { defaultMaxLiveAgents } from './config.ts';
import { declareDocument, defineStep, type DocumentDeclaration, type DocumentStep } from './state-store.ts';

export const STATE_DOCUMENT = 'state';
/**
 * Version 1 has TWO published shapes, told apart by the shape, this once: 0.4.0's (six settings, src/frozen/v0.4.0.ts)
 * and 0.5.0's (nine, written by 0.5.0, 0.5.1 and 0.5.2: src/frozen/v0.5.0.ts). Version 2 is 0.6.0's (the workspace's
 * permission mode, the host's notices: src/frozen/v0.6.0.ts). Version 3 is 0.7.0's (the workspace setting `merging`,
 * the notice `auto-merge`). Every later change of what this document accepts is a new number and a step.
 */
export const STATE_VERSION = 3;

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
  /**
   * Notices the host has not seen yet (`agents-auto`: the 0.6.0 update switched the workspace to auto mode;
   * `auto-merge`: the 0.7.0 update switched it to automatic merging).
   */
  hostNotices: z.array(hostNoticeSchema).max(HOST_NOTICES.length),
});

export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

/**
 * A new workspace: the caller's settings (their `permissionMode` is auto and their `merging` is auto unless the caller
 * says otherwise) and no notice.
 */
export function initialWorkspaceState(workspaceId: string, settings: HostSettings): WorkspaceState {
  return { version: STATE_VERSION, workspaceId, members: [], devices: [], invites: [], settings, worktreeRoots: [], hostNotices: [] };
}

/**
 * state.json of smurg 0.4.0 → 0.5.0's (src/frozen/v0.5.0.ts; the next step takes it on): 0.5.0 added three settings.
 * Everything else is carried as it is: every member, device, invite and root, every kick, revocation and use count
 * (an upgrade that reset or dropped one would let a kicked member or a used-up link back in).
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

/**
 * state.json of smurg 0.5.0, 0.5.1, 0.5.2 → 0.6.0's (src/frozen/v0.6.0.ts; the next step takes it on). THE OWNER'S
 * DECISION (2026-10-20, DECISIONS.md 2): the workspace
 * switches to auto mode at the update, and the host is told (`hostNotices: ['agents-auto']`: `smurg host`'s line, the
 * inbox and the console's banner, until the host has seen it). This is the one step that sets a security-relevant
 * value to the OPEN side (ARCHITECTURE §0 rule 8 names the exception); the value is the step's own constant and never
 * today's default for a new workspace. Everything else is carried as it is.
 */
export const stateStepFromV050: DocumentStep = defineStep({
  from: '0.5.0',
  sinceShapes: 2,
  shape: stateShapeV050,
  upgrade: (old: StateV050) => ({
    ...old,
    version: 2,
    settings: { ...old.settings, permissionMode: 'auto' },
    hostNotices: ['agents-auto'],
  }),
});

/**
 * state.json of smurg 0.6.0 → today's. THE OWNER'S WORDS (2026-10-26, the lead's frame of 0.7.0): existing workspaces
 * merge work items by themselves after the update, and the host is told (`auto-merge` joins `hostNotices`: `smurg
 * host`'s line, the inbox and the console's banner, until the host has seen it or set `merging`). The second step
 * that sets a security-relevant value to the OPEN side, after 0.6.0's auto mode (ARCHITECTURE §0 rule 8 names both);
 * the value is the step's own constant and never today's default for a new workspace. Work items a 0.6.0 Start armed
 * keep the host's merge: their pins say nothing of `merging` (DESIGN 0.7.0 D3). Everything else is carried as it is.
 */
export const stateStepFromV060: DocumentStep = defineStep({
  from: '0.6.0',
  sinceShapes: 3,
  shape: stateShapeV060,
  upgrade: (old: StateV060) => ({
    ...old,
    version: 3,
    settings: { ...old.settings, merging: 'auto' },
    hostNotices: [...new Set([...old.hostNotices, 'auto-merge'])],
  }),
});

/** The core's document of one workspace (`init`: what a new workspace gets on this machine). */
export function stateDocument(workspaceId: string, settings: HostSettings): DocumentDeclaration<typeof workspaceStateSchema> {
  return declareDocument({ name: STATE_DOCUMENT, schema: workspaceStateSchema, init: () => initialWorkspaceState(workspaceId, settings), steps: [stateStepFromV040, stateStepFromV050, stateStepFromV060] });
}
