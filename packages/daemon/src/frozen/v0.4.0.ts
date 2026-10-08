// FROZEN. What smurg 0.4.0 wrote into a workspace folder, for the documents whose shape a later smurg changed:
// `state.json` and `suggestions.json`. (0.4.0's worktrees.json, conflicts.json and sessions.json pass today's
// schemas as they are.)
//
// This file is a LITERAL copy of what 0.4.0 accepted: the keys AND the rules of every scalar, as they were at the tag
// v0.4.0 (packages/protocol/src/schema/{primitives,paths,entities,limits}.ts, relay/{frames,routes}.ts, roles.ts,
// constants.ts; packages/daemon/src/core/workspace-state.ts, suggest/store.ts). It imports zod and nothing else, on
// purpose: a shape built from today's schemas with keys taken away moves whenever today's schemas do, and then
// matches files no published smurg ever wrote. NEVER edit a rule here to follow today's code. A file that matched
// this shape is upgraded by its step (core/workspace-state.ts, suggest/store.ts) and the result must then pass
// today's strict schema; where today's rule is tighter (a path with more than 30 combining marks in a row) the file
// is refused, naming the entry.
//
// The pin of packages/daemon/test/upgrade fails when this file changes.
import { z } from 'zod';

// ---- scalars, as 0.4.0 had them -------------------------------------------------------------------------------------

const epochMs = z.int().min(0);
const byteCount = z.int().min(0);
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not an id ([A-Za-z0-9_-]{1,64})');
const userId = z.string().regex(/^(?:github:[1-9][0-9]{0,19}|google:[A-Za-z0-9_-]{1,255}|dev:[A-Za-z0-9._-]{1,64})$/, 'not a relay user id');
const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'not a workspace id');
const role = z.enum(['host', 'agent', 'editor', 'viewer']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'not a #rrggbb colour');
const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `not ${bytes} bytes of hex`);

const UNSAFE_NAME_CHARS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
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
// eslint-disable-next-line no-control-regex
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function textProblem(text: string, multiline: boolean): string | null {
  if ((multiline ? CONTROL_MULTILINE : CONTROL_SINGLE_LINE).test(text)) return 'control character';
  if (BIDI_CONTROLS.test(text)) return 'bidi control character';
  if (LONE_SURROGATE.test(text)) return 'lone surrogate';
  return null;
}

function lineText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, ctx) => {
      const problem = textProblem(text, false);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: `text contains a ${problem}` });
    });
}

function multilineText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, ctx) => {
      const problem = textProblem(text, true);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: `text contains a ${problem}` });
    });
}

const shortText = lineText(256);

// ---- relative paths, as 0.4.0 checked them (no rule about runs of combining marks) ------------------------------

const REL_PATH_MAX_CHARS = 4_096;
const PATH_SEGMENT_MAX_UNITS = 255;
// eslint-disable-next-line no-control-regex
const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PATH_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

type PathCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: string };

// The ONE thing here that is not 0.4.0's own line, and it changes no answer. 0.4.0 normalised first and then refused
// a name of more than 255 units ('segment-too-long'). `normalize` puts a run of combining marks in order at the
// square of the run's length (packages/protocol/src/normalize.ts), so that answer is given BEFORE normalising for a
// run that cannot fit a name whatever NFC does with it: a canonical composition takes at most four code points into
// one, so more than 4 x 255 marks in a row are more than 255 units afterwards. No longer run reaches `normalize`.
const MARK = /^\p{M}$/u;
const MARK_RUN_NEVER_A_NAME = 4 * PATH_SEGMENT_MAX_UNITS;

function hasRunNoNameCanHold(input: string): boolean {
  let run = 0;
  for (const character of input) {
    if (character.charCodeAt(0) >= 0x300 && MARK.test(character)) {
      run += 1;
      if (run > MARK_RUN_NEVER_A_NAME) return true;
    } else run = 0;
  }
  return false;
}

function checkEntryPath(input: string): PathCheck {
  if (input.length > REL_PATH_MAX_CHARS * 4) return { ok: false, problem: 'too-long' };
  if (PATH_CONTROL.test(input)) return { ok: false, problem: 'control-character' };
  if (PATH_BIDI.test(input)) return { ok: false, problem: 'bidi-character' };
  if (LONE_SURROGATE.test(input)) return { ok: false, problem: 'lone-surrogate' };
  if (hasRunNoNameCanHold(input)) return { ok: false, problem: 'segment-too-long' };
  const path = input.normalize('NFC');
  if (path.length > REL_PATH_MAX_CHARS) return { ok: false, problem: 'too-long' };
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

/** A relative path that names an entry below the root; the result is NFC, as 0.4.0 loaded it. */
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
const entryRef = z.strictObject({ root: rootRef, path: entryPath });
const userRef = z.strictObject({ userId, displayName });

// ---- state.json of 0.4.0 --------------------------------------------------------------------------------------------

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
});

/** The six settings of 0.4.0 (0.5.0 added maxLiveAgents, escalateAfterMs and agentMcp). */
const hostSettings = z.strictObject({
  humanLockIdleMs: z.int().min(1_000).max(3_600_000),
  agentLockTimeoutMs: z.int().min(1_000).max(600_000),
  uploadChunkSize: z.int().min(1 * MiB).max(8 * MiB),
  sharedDirs: z.array(entryPath).max(64),
  diskReserveBytes: byteCount,
  diskReservePercent: z.number().min(0).max(100),
});

export const stateShapeV040 = z.strictObject({
  version: z.literal(1),
  workspaceId,
  members: z.array(memberRecord),
  devices: z.array(deviceRecord),
  invites: z.array(inviteRecord),
  settings: hostSettings,
  worktreeRoots: z.array(worktreeRootRecord),
});
export type StateV040 = z.infer<typeof stateShapeV040>;

// ---- suggestions.json of 0.4.0 --------------------------------------------------------------------------------------

const suggestionText = multilineText(64 * 1024, 1).refine((text) => /\S/u.test(text), 'suggestion is blank');

const suggestionSource = z
  .strictObject({ file: entryRef, startLine: z.int().min(1), endLine: z.int().min(1) })
  .refine((source) => source.endLine >= source.startLine, 'endLine < startLine');

/** A stored suggestion of 0.4.0: no `origin` (0.5.0 made it required), no `cleaned`, topic, item, mentions, decidedBy. */
const storedSuggestion = z.strictObject({
  id: opaqueId,
  sessionId: opaqueId,
  author: userRef,
  text: suggestionText,
  source: suggestionSource.optional(),
  status: z.enum(['pending', 'accepted', 'accepted-modified', 'rejected', 'withdrawn']),
  createdAt: epochMs,
  resolvedAt: epochMs.optional(),
  finalText: suggestionText.optional(),
  rejectReason: lineText(1_000).optional(),
  closedReason: z.enum(['session-ended', 'author-kicked', 'author-demoted']).optional(),
  sessionOwnerUserId: userId,
  editedAt: epochMs.optional(),
});

export const suggestionsShapeV040 = z.strictObject({
  version: z.literal(1),
  suggestions: z.array(storedSuggestion).max(1_000),
});
export type SuggestionsV040 = z.infer<typeof suggestionsShapeV040>;
