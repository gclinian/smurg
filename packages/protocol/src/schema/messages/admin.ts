import { z } from 'zod';
import { guestRoleSchema } from '../../roles.ts';
import {
  auditEntrySchema,
  hostSettingsPatchSchema,
  hostSettingsSchema,
  inviteInfoSchema,
  memberSchema,
  memberWithDevicesSchema,
  projectSettingsStateSchema,
} from '../entities.ts';
import {
  CLAUDE_CONFIG_ENTRY_MAX_CHARS,
  CLAUDE_CONFIG_FILES_MAX,
  CLAUDE_CONFIG_LIST_MAX,
  CLAUDE_CONFIG_SCRIPTS_MAX,
  CLAUDE_CONFIG_TEXT_MAX_BYTES,
  HOST_RULES_MAX,
  HOST_RULE_MAX_CHARS,
  LIST_MAX_ITEMS,
  PAGE_LIMIT_MAX,
  SHORT_TEXT_MAX_CHARS,
} from '../limits.ts';
import { entryPathSchema, rootRefSchema } from '../paths.ts';
import { epochMsSchema, indexSchema, largeTextSchema, lineTextSchema, multilineTextSchema, opaqueIdSchema, sha256HexSchema, userIdSchema } from '../primitives.ts';
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

// ---------------------------------------------------------------------------------------------------------------
// Claude Code on the host: project settings (the trust gate), the host's own rules, transcripts (ARCHITECTURE §5.8)
// ---------------------------------------------------------------------------------------------------------------

export const CLAUDE_CONFIG_DECISIONS = ['trust', 'ignore'] as const;
/**
 * What a file's content needs its own tick for before "Use them". `incomplete`: the lists do not show everything the
 * content does (see `cut`); the host confirms having read the file itself.
 */
export const CLAUDE_CONFIG_ACKS = ['credentials', 'allows-tools', 'incomplete'] as const;
const claudeConfigEntrySchema = multilineTextSchema(CLAUDE_CONFIG_ENTRY_MAX_CHARS);
const claudeConfigListSchema = z.array(claudeConfigEntrySchema).max(CLAUDE_CONFIG_LIST_MAX);

/**
 * One of a root's three project-level Claude Code files (`.claude/settings.json`, `.claude/settings.local.json`,
 * `.mcp.json`) with everything it does: `runs` (each command line), `permissions` (each rule), `env` (every
 * variable; `flagged`: it can send the host's login to another server; `programs`: it changes which programs run or
 * what they load, and its value is listed under `runs`), `otherKeys`, and `scripts` (files inside the root the
 * commands point at: part of the trusted content, host-only for writes while it is trusted). `text`: the raw file.
 * `changed`: the content differs from the one a stored decision was made for.
 *
 * `cut`: present when the lists are NOT everything the content does: `omitted` entries beyond a list's limit,
 * `shortened` entries cut at the entry limit. `needsAck` then holds `incomplete`.
 *
 * The entry with `path` PROJECT_LOADED_ENTRY (`.claude`) is not a file: it stands for everything else Claude Code
 * loads from that folder (agents, skills, commands, rules, …), confirmed and re-asked like a file. Its `otherKeys`
 * are the paths of those files, `text` lists every one with its hash, `hash` covers the list; `runs` and
 * `permissions` are what the files' own headers declare (hooks, allowed tools).
 */
export const claudeConfigFileSchema = z.strictObject({
  path: entryPathSchema,
  hash: sha256HexSchema,
  decision: z.enum(CLAUDE_CONFIG_DECISIONS).nullable(),
  changed: z.boolean(),
  text: largeTextSchema(CLAUDE_CONFIG_TEXT_MAX_BYTES),
  runs: claudeConfigListSchema,
  permissions: claudeConfigListSchema,
  env: z.array(z.strictObject({ name: lineTextSchema(SHORT_TEXT_MAX_CHARS, 1), flagged: z.boolean(), programs: z.boolean().optional() })).max(CLAUDE_CONFIG_LIST_MAX),
  otherKeys: z.array(lineTextSchema(SHORT_TEXT_MAX_CHARS, 1)).max(CLAUDE_CONFIG_LIST_MAX),
  scripts: z.array(z.strictObject({ path: entryPathSchema, hash: sha256HexSchema })).max(CLAUDE_CONFIG_SCRIPTS_MAX),
  needsAck: z.array(z.enum(CLAUDE_CONFIG_ACKS)).max(CLAUDE_CONFIG_ACKS.length),
  cut: z.strictObject({ omitted: indexSchema, shortened: indexSchema }).optional(),
});
export type ClaudeConfigFile = z.infer<typeof claudeConfigFileSchema>;

export const claudeConfigRootSchema = z.strictObject({
  root: rootRefSchema,
  state: projectSettingsStateSchema,
  files: z.array(claudeConfigFileSchema).max(CLAUDE_CONFIG_FILES_MAX),
});

/** THE list rule: a reply is closed at LIST_REPLY_MAX_BYTES; `hasMore` then, and `after` (`rootRefKey`) continues. */
export const adminClaudeConfigGetPayloadSchema = z.strictObject({ after: lineTextSchema(SHORT_TEXT_MAX_CHARS, 1).optional() });
export const adminClaudeConfigGetResultSchema = z.strictObject({
  roots: z.array(claudeConfigRootSchema).max(LIST_MAX_ITEMS),
  hasMore: z.boolean(),
});

/** Refused when a hash is no longer the file's (`claudeConfig.changed`) or a needed tick is missing (`claudeConfig.ackNeeded`). */
export const adminClaudeConfigDecidePayloadSchema = z.strictObject({
  root: rootRefSchema,
  files: z.array(z.strictObject({ path: entryPathSchema, hash: sha256HexSchema })).min(1).max(CLAUDE_CONFIG_FILES_MAX),
  decision: z.enum(CLAUDE_CONFIG_DECISIONS),
  acknowledged: z.array(z.enum(CLAUDE_CONFIG_ACKS)).max(CLAUDE_CONFIG_ACKS.length),
});
export const adminClaudeConfigDecideResultSchema = emptyPayloadSchema;

export const HOST_RULE_SOURCES = ['user', 'project', 'local', 'managed'] as const;

/**
 * The host's own Claude Code allow rules as agent sessions last reported them. They APPLY to agent sessions: every
 * session runs as the host. `seen`: the host was shown this list (`admin.hostRules.seen`).
 */
export const adminHostRulesGetPayloadSchema = emptyPayloadSchema;
export const adminHostRulesGetResultSchema = z.strictObject({
  rules: z.array(z.strictObject({ rule: lineTextSchema(HOST_RULE_MAX_CHARS, 1), source: z.enum(HOST_RULE_SOURCES) })).max(HOST_RULES_MAX),
  seen: z.boolean(),
});

/** The host has the list on screen: the `host-rules` inbox item leaves. No decision is taken. */
export const adminHostRulesSeenPayloadSchema = emptyPayloadSchema;
export const adminHostRulesSeenResultSchema = emptyPayloadSchema;

/** Replaces one conversation event by "The host removed this entry." under the same `seq`. */
export const adminTranscriptRedactPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, seq: z.int().min(1) });
export const adminTranscriptRedactResultSchema = emptyPayloadSchema;
