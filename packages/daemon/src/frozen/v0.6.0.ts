// FROZEN. What smurg 0.6.0 wrote into a workspace folder, for the one document whose shape smurg 0.7.0 changed:
// `state.json` (version 3: the workspace setting `merging`, the notice `auto-merge`). 0.6.0's other documents pass
// 0.7.0's schemas as they are: 0.7.0 only added optional keys and enum values to them (DESIGN 0.7.0 D4).
//
// This file is a LITERAL copy of what 0.6.0 accepted for state.json: the keys AND the rules of every scalar, as they
// were at the tag v0.6.0 (packages/protocol/src/schema/{primitives,paths,entities,limits}.ts, normalize.ts,
// relay/{frames,routes}.ts, roles.ts, constants.ts; packages/daemon/src/core/workspace-state.ts), which are 0.5.x's
// rules with the workspace's permission mode and the host's notices added (test/upgrade/shapes/state.json.txt of
// v0.6.0 is the walker's description of exactly this shape). It imports zod and nothing else, on purpose: a shape
// built from today's schemas with keys taken away moves whenever today's schemas do, and then matches files no
// published smurg ever wrote. NEVER edit a rule here to follow today's code. A file that matched this shape is
// upgraded by its step (core/workspace-state.ts stateStepFromV060) and the result must then pass today's strict
// schema; the step from 0.5.0 (core/workspace-state.ts stateStepFromV050) produces this shape.
//
// The pin of packages/daemon/test/upgrade fails when this file changes.
import { z } from 'zod';

// ---- scalars, as 0.6.0 had them (the same rules as 0.5.0's: v0.6.0 changed none of them) ----------------------------

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

// ---- relative paths, as 0.6.0 checked them (with the rule about runs of combining marks) ---------------------------

const REL_PATH_MAX_CHARS = 4_096;
const PATH_SEGMENT_MAX_UNITS = 255;
const MARK_RUN_MAX = 30;
// eslint-disable-next-line no-control-regex
const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PATH_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const DRIVE_LETTER = /^[A-Za-z]:/;
// Code points HFS+ ignores when it compares names: a joiner between two marks does not end their run.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
// A mark: the category Mark, and the two half-width Katakana sound marks (normalize.ts of 0.6.0, as of 0.5.0).
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

// 0.6.0 normalised with `normalized(input, 'NFC')`, which cuts a run of more than 30 marks first; no input that passed
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

/** A relative path that names an entry below the root; the result is NFC, as 0.6.0 loaded it. */
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

// ---- state.json of 0.6.0 (version 2: ten settings, the host's notices) ----------------------------------------------

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

/** The ten settings of 0.6.0: 0.5.0's nine and the workspace's permission mode (0.7.0 added `merging`). */
const hostSettings = z.strictObject({
  humanLockIdleMs: z.int().min(1_000).max(3_600_000),
  agentLockTimeoutMs: z.int().min(1_000).max(600_000),
  uploadChunkSize: z.int().min(1 * MiB).max(8 * MiB),
  sharedDirs: z.array(entryPath).max(64),
  permissionMode: z.enum(['auto', 'ask-commands', 'ask-all', 'ask-nothing']),
  diskReserveBytes: byteCount,
  diskReservePercent: z.number().min(0).max(100),
  maxLiveAgents: z.int().min(2).max(32),
  escalateAfterMs: z.int().min(60_000).max(3_600_000),
  agentMcp: z.boolean(),
});

export const stateShapeV060 = z.strictObject({
  version: z.literal(2),
  workspaceId,
  members: z.array(memberRecord),
  devices: z.array(deviceRecord),
  invites: z.array(inviteRecord),
  settings: hostSettings,
  worktreeRoots: z.array(worktreeRootRecord),
  /** Notices the host had not seen yet: 0.6.0 knew one (`agents-auto`, its update's). */
  hostNotices: z.array(z.enum(['agents-auto'])).max(1),
});
export type StateV060 = z.infer<typeof stateShapeV060>;
