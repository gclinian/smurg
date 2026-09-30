// zod schemas of the hook + MCP socket protocol (ARCHITECTURE §7.7), daemon side. Everything that arrives on the
// socket is a CLAIM from a process inside a (possibly sandboxed) session: these schemas bound every field before any
// decision is taken, and identity never comes from here (the daemon derives session and owner from the token).
// The clients (hook-cli.ts, ../mcp/coord-server.ts) do not load this file: they must start without zod (wire.ts).
import { NOTIFY_TEXT_MAX_CHARS, displayNameSchema, multilineTextSchema, userIdSchema } from '@smurg/protocol';
import { z } from 'zod';
import { HOOK_PROBE_NONCE_PATTERN, MCP_TOOL_NAMES, REQUEST_ID_PATTERN, WAIT_FOR_LOCK_MAX_SECONDS } from './wire.ts';

/** Absolute or relative file paths from Claude Code; PATH_MAX-sized with room for Linux's 4,095 bytes. */
const MAX_PATH_CHARS = 4_096;
const pathString = z.string().min(1).max(MAX_PATH_CHARS).refine((value) => !value.includes('\u0000'), 'NUL in path');
const shortString = z.string().max(256);

export const requestIdSchema = z.string().regex(REQUEST_ID_PATTERN);
/** Tokens are 43 base64url characters; anything much longer is not worth hashing. */
export const tokenSchema = z.string().min(1).max(128);

/**
 * The projection of Claude Code's hook input that hook-cli forwards (wire.ts projectHookInput). Unknown keys are
 * stripped, not refused: they are never used, and the line length already bounds them.
 */
export const hookInputSchema = z.object({
  hook_event_name: z.string().min(1).max(64),
  session_id: shortString.optional(),
  cwd: pathString.optional(),
  tool_name: shortString.optional(),
  tool_use_id: shortString.optional(),
  permission_mode: shortString.optional(),
  tool_input: z
    .object({
      file_path: pathString.optional(),
      notebook_path: pathString.optional(),
    })
    .optional(),
  file_path: pathString.optional(),
  event: shortString.optional(),
  source: shortString.optional(),
  reason: shortString.optional(),
  stop_hook_active: z.boolean().optional(),
  /** The hook self-test's nonce (event SmurgProbe, wire.ts). */
  smurg_probe: z.string().regex(HOOK_PROBE_NONCE_PATTERN).optional(),
});
export type HookInput = z.infer<typeof hookInputSchema>;

const hookRequestSchema = z.strictObject({
  id: requestIdSchema,
  token: tokenSchema,
  op: z.literal('hook'),
  hookInput: hookInputSchema,
});

const mcpRequestSchema = z.strictObject({
  id: requestIdSchema,
  token: tokenSchema,
  op: z.literal('mcp'),
  tool: z.enum(MCP_TOOL_NAMES),
  args: z.record(z.string().max(64), z.unknown()),
});

export const hookSocketRequestSchema = z.discriminatedUnion('op', [hookRequestSchema, mcpRequestSchema]);
export type ParsedHookSocketRequest = z.infer<typeof hookSocketRequestSchema>;

/** Only what is needed to answer a request the daemon cannot parse with the right id. */
export const requestEnvelopeSchema = z.object({ id: requestIdSchema, op: z.string().max(16).optional() });

// ---------------------------------------------------------------------------------------------------------------------
// MCP tool arguments (strict: the model gets a precise error and can retry)
// ---------------------------------------------------------------------------------------------------------------------

export const whoIsEditingArgsSchema = z.strictObject({ file_path: pathString });
export const lockStatusArgsSchema = z.strictObject({ file_path: pathString.optional() });
export const waitForLockArgsSchema = z.strictObject({
  file_path: pathString,
  timeout_seconds: z.number().min(1).max(WAIT_FOR_LOCK_MAX_SECONDS).optional(),
});
export const listSessionsArgsSchema = z.strictObject({});
export const notifyMemberArgsSchema = z.strictObject({
  /** A member's user id (`github:…`) or display name. */
  member: z.union([userIdSchema, displayNameSchema]),
  message: multilineTextSchema(NOTIFY_TEXT_MAX_CHARS, 1).refine((text) => /\S/u.test(text), 'message is blank'),
  file_path: pathString.optional(),
});
