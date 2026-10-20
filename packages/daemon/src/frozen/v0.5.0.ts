// FROZEN. What smurg 0.5.0 wrote into a workspace folder, and 0.5.1 and 0.5.2 after it (they wrote the same shapes),
// for the documents whose shape smurg 0.6.0 changed: `state.json` (version 2: the workspace's permission mode, the
// host's notices) and `agent-sessions.json` (a session's mode choice and its model). 0.5.x's other documents pass
// 0.6.0's schemas as they are: 0.6.0 only added optional keys to them.
//
// This file is a LITERAL copy of what 0.5.0, 0.5.1 and 0.5.2 accepted: the keys AND the rules of every scalar, as they
// were at the tags v0.5.0, v0.5.1 and v0.5.2 (identical there: packages/protocol/src/schema/{primitives,paths,
// entities,conversation,limits}.ts, normalize.ts, agent-text.ts, relay/{frames,routes}.ts, roles.ts, constants.ts;
// packages/daemon/src/core/workspace-state.ts, sessions/agent/store.ts). It imports zod and nothing else, on purpose: a
// shape built from today's schemas with keys taken away moves whenever today's schemas do, and then matches files no
// published smurg ever wrote. NEVER edit a rule here to follow today's code. A file that matched this shape is
// upgraded by its step (core/workspace-state.ts, sessions/agent/store.ts) and the result must then pass today's strict
// schema.
//
// The pin of packages/daemon/test/upgrade fails when this file changes.
import { z } from 'zod';

// ---- scalars, as 0.5.0 had them -------------------------------------------------------------------------------------

const epochMs = z.int().min(0);
const byteCount = z.int().min(0);
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not an id ([A-Za-z0-9_-]{1,64})');
const userId = z.string().regex(/^(?:github:[1-9][0-9]{0,19}|google:[A-Za-z0-9_-]{1,255}|dev:[A-Za-z0-9._-]{1,64})$/, 'not a relay user id');
const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'not a workspace id');
const role = z.enum(['host', 'agent', 'editor', 'viewer']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'not a #rrggbb colour');
const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `not ${bytes} bytes of hex`);
const topicSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'not a topic slug');
const itemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'not a work item id');

const UNSAFE_NAME_CHARS = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;
const displayName = z
  .string()
  .min(1)
  .max(256)
  .refine((name) => /\S/u.test(name), 'display name is blank')
  .refine((name) => !UNSAFE_NAME_CHARS.test(name), 'display name contains control or bidi characters');

const avatarUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'avatar URL must be an https URL without credentials');

// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function lineText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, ctx) => {
      const problem = CONTROL_SINGLE_LINE.test(text) ? 'control character' : BIDI_CONTROLS.test(text) ? 'bidi control character' : LONE_SURROGATE.test(text) ? 'lone surrogate' : null;
      if (problem !== null) ctx.addIssue({ code: 'custom', message: `text contains a ${problem}` });
    });
}

const shortText = lineText(256);

// ---- relative paths, as 0.5.0 checked them (with the rule about runs of combining marks) ---------------------------

const REL_PATH_MAX_CHARS = 4_096;
const PATH_SEGMENT_MAX_UNITS = 255;
const MARK_RUN_MAX = 30;
// eslint-disable-next-line no-control-regex
const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PATH_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const DRIVE_LETTER = /^[A-Za-z]:/;
// Code points HFS+ ignores when it compares names: a joiner between two marks does not end their run.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
// A mark: the category Mark, and the two half-width Katakana sound marks (normalize.ts of 0.5.0).
const ONE_MARK = /^[\p{M}\uff9e\uff9f]$/u;

/** Whether `text` holds a run of more than MARK_RUN_MAX marks, read with the HFS+ ignorable code points left out. */
function hasMarkRun(input: string): boolean {
  const text = input.replace(HFS_IGNORABLE, '');
  let run = 0;
  for (const character of text) {
    if (character.charCodeAt(0) >= 0x300 && ONE_MARK.test(character)) {
      run += 1;
      if (run > MARK_RUN_MAX) return true;
    } else run = 0;
  }
  return false;
}

type PathCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: string };

// 0.5.0 normalised with `normalized(input, 'NFC')`, which cuts a run of more than 30 marks first; no input that passed
// the rule above holds such a run, so that cut never happened, and `normalize` alone gives the same path.
function checkEntryPath(input: string): PathCheck {
  if (input.length > REL_PATH_MAX_CHARS * 4) return { ok: false, problem: 'too-long' };
  if (PATH_CONTROL.test(input)) return { ok: false, problem: 'control-character' };
  if (PATH_BIDI.test(input)) return { ok: false, problem: 'bidi-character' };
  if (LONE_SURROGATE.test(input)) return { ok: false, problem: 'lone-surrogate' };
  if (hasMarkRun(input)) return { ok: false, problem: 'mark-run' };
  const path = input.normalize('NFC');
  if (path.length > REL_PATH_MAX_CHARS) return { ok: false, problem: 'too-long' };
  if (path !== input && hasMarkRun(path)) return { ok: false, problem: 'mark-run' };
  if (path === '') return { ok: false, problem: 'root-not-allowed' };
  if (path.includes('\\')) return { ok: false, problem: 'backslash' };
  if (DRIVE_LETTER.test(path)) return { ok: false, problem: 'drive-letter' };
  if (path.startsWith('/')) return { ok: false, problem: 'absolute' };
  for (const segment of path.split('/')) {
    if (segment === '') return { ok: false, problem: 'empty-segment' };
    if (segment === '.' || segment === '..') return { ok: false, problem: 'dot-segment' };
    if (segment.length > PATH_SEGMENT_MAX_UNITS) return { ok: false, problem: 'segment-too-long' };
  }
  return { ok: true, path };
}

/** A relative path that names an entry below the root; the result is NFC, as 0.5.0 loaded it. */
const entryPath = z
  .string()
  .max(REL_PATH_MAX_CHARS * 4)
  .transform((input, ctx) => {
    const result = checkEntryPath(input);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: `invalid relative path: ${result.problem}` });
      return z.NEVER;
    }
    return result.path;
  });

const rootRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('main') }),
  z.strictObject({ kind: z.literal('worktree'), worktreeId: opaqueId }),
]);
const userRef = z.strictObject({ userId, displayName });

// ---- state.json of 0.5.0, 0.5.1 and 0.5.2 (version 1, nine settings) ------------------------------------------------

const MiB = 1024 * 1024;

const memberRecord = z.strictObject({
  userId,
  displayName,
  avatarUrl: avatarUrl.optional(),
  role,
  color,
  joinedAt: epochMs,
  lastSeenAt: epochMs,
  status: z.enum(['active', 'kicked']),
  kickedAt: epochMs.optional(),
});

const deviceRecord = z.strictObject({
  deviceId: opaqueId,
  userId,
  publicKeyHex: hex(32),
  name: shortText,
  kind: z.enum(['web', 'cli']),
  addedAt: epochMs,
  lastSeenAt: epochMs,
  revoked: z.boolean(),
  revokedAt: epochMs.optional(),
  inviteId: opaqueId.optional(),
});

const inviteRecord = z.strictObject({
  id: opaqueId,
  keyIdHex: hex(16),
  pskHex: hex(32),
  role,
  boundUserId: userId.optional(),
  createdAt: epochMs,
  createdBy: userId.nullable(),
  expiresAt: epochMs.optional(),
  maxUses: z.int().min(1).optional(),
  uses: z.int().min(0),
  revoked: z.boolean(),
  host: z.boolean(),
});

const sharedLinkRecord = z.strictObject({
  path: entryPath,
  mainPath: entryPath,
  targetRealPath: z.string().min(1).startsWith('/'),
});

const worktreeRootRecord = z.strictObject({
  worktreeId: opaqueId,
  realPath: z.string().min(1).startsWith('/'),
  ownerUserId: userId,
  sharedLinks: z.array(sharedLinkRecord).max(64),
  registeredAt: epochMs,
  item: z.strictObject({ topicId: opaqueId, topicSlug, itemId }).optional(),
});

/** The nine settings of 0.5.0 (0.6.0 added `permissionMode`). */
const hostSettings = z.strictObject({
  humanLockIdleMs: z.int().min(1_000).max(3_600_000),
  agentLockTimeoutMs: z.int().min(1_000).max(600_000),
  uploadChunkSize: z.int().min(1 * MiB).max(8 * MiB),
  sharedDirs: z.array(entryPath).max(64),
  diskReserveBytes: byteCount,
  diskReservePercent: z.number().min(0).max(100),
  maxLiveAgents: z.int().min(2).max(32),
  escalateAfterMs: z.int().min(60_000).max(3_600_000),
  agentMcp: z.boolean(),
});

export const stateShapeV050 = z.strictObject({
  version: z.literal(1),
  workspaceId,
  members: z.array(memberRecord),
  devices: z.array(deviceRecord),
  invites: z.array(inviteRecord),
  settings: hostSettings,
  worktreeRoots: z.array(worktreeRootRecord),
});
export type StateV050 = z.infer<typeof stateShapeV050>;

// ---- agent-sessions.json of 0.5.0, 0.5.1 and 0.5.2 (no version key) -------------------------------------------------

const rememberedRule = z.strictObject({
  id: opaqueId,
  tool: z.enum(['Bash', 'WebFetch']),
  pattern: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/, 'not a rule pattern'),
  scope: z.enum(['session', 'topic']),
  addedBy: userRef,
  addedAt: epochMs,
});

const pendingMessage = z.strictObject({
  messageId: opaqueId,
  text: z.string().min(1).max(4 * 1024 * 1024),
  turn: z.strictObject({
    messageId: opaqueId,
    kind: z.enum(['person', 'smurg']),
    origin: z.enum(['composer', 'follow-up', 'revise', 'selection']).optional(),
    from: userRef.optional(),
    by: userRef.optional(),
    purpose: z
      .enum([
        'write-spec',
        'generate-plan',
        'update-plan',
        'start-item',
        'continue-item',
        'retry-item',
        'fix-plan',
        'fix-report',
        'nudge-report',
        'resolve-conflict',
        'conversation-lost',
        'restart-discussion',
      ])
      .optional(),
    suggestionId: opaqueId.optional(),
  }),
  fromUserId: userId.nullable(),
});

/** One session of 0.5.0: `mode` was one of the two ask modes; no model (every session ran on the host's default). */
const agentRecord = z.strictObject({
  id: opaqueId,
  purpose: z.enum(['discussion', 'item', 'free']),
  topic: z.strictObject({ id: opaqueId, slug: z.string().min(1).max(64), name: z.string().min(1).max(256) }).optional(),
  item: z.strictObject({ id: itemId, number: z.int().min(0), title: z.string().min(1).max(256), attempt: z.int().min(1) }).optional(),
  openedBy: userRef,
  ownerUserId: userId,
  pathRights: z.enum(['member', 'host']),
  responsible: userRef.nullable(),
  fallbackDecider: userId.nullable(),
  title: shortText.optional(),
  root: rootRef,
  worktreeId: opaqueId.optional(),
  branch: shortText.optional(),
  mode: z.enum(['ask-all', 'ask-commands']),
  modeChangedBy: z.strictObject({ userId, displayName }).optional(),
  rules: z.array(rememberedRule).max(200),
  claudeSessionId: z.uuid(),
  hasConversation: z.boolean(),
  turnCounter: z.int().min(0),
  smurgTag: z.string().regex(/^[a-z0-9]{4}$/),
  startFailures: z.int().min(0),
  lastTurnOpen: z.boolean(),
  state: z.enum(['live', 'failed', 'ended']),
  itemState: z.strictObject({ reportRegistered: z.boolean(), stalled: z.enum(['agent', 'restart', 'stopped', 'error']).optional() }).optional(),
  untrustedSaid: z.boolean(),
  createdAt: epochMs,
  endedAt: epochMs.optional(),
  endReason: z.enum(['exit', 'ended', 'terminated', 'kicked', 'left', 'role-changed', 'stopped', 'worktree-removed', 'archived', 'replaced', 'merged']).optional(),
  endedBy: userRef.optional(),
  noteworthyAt: epochMs,
  lastActivityAt: epochMs,
  claudeVersion: z.string().max(40).optional(),
  pending: z.array(pendingMessage).max(200).optional(),
});

export const agentSessionsShapeV050 = z.strictObject({ sessions: z.array(agentRecord).max(10_000) });
export type AgentSessionsV050 = z.infer<typeof agentSessionsShapeV050>;
