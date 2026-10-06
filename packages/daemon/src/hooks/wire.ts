// The hook + MCP socket protocol (ARCHITECTURE §7.7) as plain constants, types and helpers, shared by the daemon side
// (hook-server.ts) and the two processes Claude Code starts inside a session (hook-cli.ts, ../mcp/coord-server.ts).
//
// This file imports NOTHING: the entry points load it on every hook invocation and must start fast, so it may not
// pull in zod, @smurg/protocol or the daemon (test/composition.test.ts checks their runtime import graph). The daemon
// validates every request with the zod schemas in schemas.ts; the helpers here only build requests and outputs.
//
// Wire format: newline-delimited JSON over the Unix socket config.runPaths.hook, one JSON object per line.
//   { id, token, op: 'hook', hookInput [, via] } → { id, hookOutput: object | null }     null ⇒ print nothing
//       (`via: 'bash-activity'`: the request comes from the Bash ACTIVITY hook: never a decision, see below)
//   { id, token, op: 'mcp', tool, args }        → { id, ok: true, result } | { id, ok: false, error: { code, message } }
//   anything the daemon cannot parse            → { id: string | null, error: { code, message } } and the socket closes
// A reply without `hookOutput` (or `ok`) is malformed: the hook fails closed on it.

/** Environment variables the daemon sets on every session (ARCHITECTURE §7.6). */
export const HOOK_ENV = Object.freeze({
  socket: 'SMURG_HOOK_SOCKET',
  token: 'SMURG_SESSION_TOKEN',
  sessionId: 'SMURG_SESSION_ID',
} as const);

/** Longest request line the daemon reads (bytes, without the newline). The hook projects its input to stay far below. */
export const HOOK_REQUEST_MAX_BYTES = 64 * 1024;
/** Longest reply line a client reads (list_sessions / lock_status results are the big ones). */
export const HOOK_RESPONSE_MAX_BYTES = 1024 * 1024;
/**
 * The hook's own deadline for one invocation (stdin + socket round trip). Shorter than HOOK_COMMAND_TIMEOUT_SECONDS:
 * Claude Code lets the tool run when a hook times out, so the hook must give its (deny) answer before that happens.
 */
export const HOOK_CLI_DEADLINE_MS = 5_000;
/** `timeout` of the command hook in the session settings (seconds). */
export const HOOK_COMMAND_TIMEOUT_SECONDS = 10;
/** The most hook input the hook reads from stdin (a Write of a large file carries the whole content). */
export const HOOK_STDIN_MAX_BYTES = 32 * 1024 * 1024;
/** The daemon answers a PreToolUse within this or denies it (so the hook never runs into its own deadline). */
export const HOOK_SERVER_DECISION_MS = 4_000;

// ---------------------------------------------------------------------------------------------------------------------
// The two hook behaviours (ARCHITECTURE §7.7). They are separate code paths in hook-cli.ts, chosen by the argument the
// DAEMON writes after `hook` in the session settings (never by anything a session sends):
//   `smurg hook`                 THE TOOL GATE: registered for PreToolUse of EVERY tool (matcher `*`), it asks the
//                                daemon and prints its decision; for the edit tools the daemon also takes the agent
//                                lock. Fails CLOSED (any error during PreToolUse ⇒ deny, whatever the tool);
//   `smurg hook bash-activity`   the Bash ACTIVITY hook (§11 D-13): only reports "this session started / finished a
//                                shell command", never takes a lock, never returns a decision, fails OPEN.
// ---------------------------------------------------------------------------------------------------------------------

/** The argument after `hook` that selects the Bash activity hook. Anything else is the lock hook (fail closed). */
export const HOOK_CLI_BASH_ACTIVITY_ARG = 'bash-activity';
/** The tool the Bash activity hook is registered for (matcher) and the only one it reports. */
export const BASH_TOOL_NAME = 'Bash';
/** The Bash activity hook's own deadline: a shell command never waits on it for longer (then nothing is reported). */
export const BASH_HOOK_DEADLINE_MS = 1_000;
/** `timeout` of the Bash activity command hook in the session settings (seconds; Claude Code's own limit). */
export const BASH_HOOK_TIMEOUT_SECONDS = 5;

/** Tools whose PreToolUse takes the agent lock. `MultiEdit` does not exist on the verified versions; listing it is harmless. */
export const EDIT_TOOL_NAMES: readonly string[] = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Exact-name matcher for the edit tools (claude-hooks.md §1.3). */
export const EDIT_TOOL_MATCHER = EDIT_TOOL_NAMES.join('|');

/** Matcher of the tool gate: every tool, the MCP tools and AskUserQuestion included. */
export const GATE_MATCHER = '*';
/** `via` of a hook request the Bash activity hook sends (the daemon then never answers with a decision). */
export const HOOK_VIA_BASH_ACTIVITY = 'bash-activity';

/** Hook events the session settings register (ARCHITECTURE §7.6). */
export const HOOK_EVENT_NAMES = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'UserPromptSubmit',
  'Stop',
  'SessionStart',
  'SessionEnd',
  'FileChanged',
] as const);
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** The coordination MCP server's name: its tools appear to the model as `mcp__smurg__<tool>`. */
export const MCP_SERVER_NAME = 'smurg';
/** The five coordination tools and the three topic tools (plan and report checks; answered by hooks/mcp-tools.ts). */
export const MCP_TOOL_NAMES = Object.freeze(['who_is_editing', 'lock_status', 'wait_for_lock', 'list_sessions', 'notify_member', 'check_plan', 'propose_split', 'check_report'] as const);
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export function isMcpToolName(value: unknown): value is McpToolName {
  return typeof value === 'string' && (MCP_TOOL_NAMES as readonly string[]).includes(value);
}

/** notify_member: longest message (= NOTIFY_TEXT_MAX_CHARS of @smurg/protocol, which this file may not import). */
export const NOTIFY_MESSAGE_MAX_CHARS = 2_000;

/** wait_for_lock: default and longest wait. */
export const WAIT_FOR_LOCK_DEFAULT_SECONDS = 30;
export const WAIT_FOR_LOCK_MAX_SECONDS = 120;
/** A client's deadline for one MCP call: the tool's own wait plus this margin. */
export const MCP_CALL_MARGIN_MS = 5_000;

// ---------------------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------------------

export type JsonObject = { [key: string]: unknown };

export interface HookRequest {
  readonly id: string;
  readonly token: string;
  readonly op: 'hook';
  readonly hookInput: JsonObject;
  readonly via?: typeof HOOK_VIA_BASH_ACTIVITY;
}

export interface McpRequest {
  readonly id: string;
  readonly token: string;
  readonly op: 'mcp';
  readonly tool: McpToolName;
  readonly args: JsonObject;
}

export type HookSocketRequest = HookRequest | McpRequest;

export interface WireError {
  readonly code: string;
  readonly message: string;
}

export type HookReply = { readonly id: string; readonly hookOutput: JsonObject | null };
export type McpReply = { readonly id: string; readonly ok: true; readonly result: unknown } | { readonly id: string; readonly ok: false; readonly error: WireError };
export type ProtocolErrorReply = { readonly id: string | null; readonly error: WireError };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Request ids: 1–64 printable ASCII characters without spaces (like Envelope ids). */
export const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;

// ---------------------------------------------------------------------------------------------------------------------
// Hook input projection
// ---------------------------------------------------------------------------------------------------------------------

const MAX_SHORT = 256;
const MAX_PATH = 8_192;

function shortString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_SHORT) : undefined;
}

function pathString(value: unknown): string | undefined {
  // Never shorten a path (a shortened path would name another file): an overlong one is forwarded whole, makes the
  // request exceed HOOK_REQUEST_MAX_BYTES or fail the daemon's schema, and PreToolUse is then denied.
  return typeof value === 'string' ? value : undefined;
}

/**
 * What the daemon needs from the hook input Claude Code wrote to stdin: the event, the tool, and the paths the call
 * names (an edit's or a Read's `file_path`, a search's `path` and a Glob's `pattern`: the gate decides by them).
 * Everything else stays in the hook process: commands, URLs, questions, file contents (`tool_input.content`,
 * `new_string`, `tool_response`), prompts, transcripts. That keeps the request
 * line small whatever the tool wrote, and content never reaches the daemon. The daemon treats all of it as a claim.
 */
export function projectHookInput(raw: unknown): JsonObject {
  const input = isJsonObject(raw) ? raw : {};
  const out: JsonObject = {};
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  set('hook_event_name', shortString(input['hook_event_name']));
  set('session_id', shortString(input['session_id']));
  set('cwd', pathString(input['cwd']));
  set('tool_name', shortString(input['tool_name']));
  set('tool_use_id', shortString(input['tool_use_id']));
  set('permission_mode', shortString(input['permission_mode']));
  const toolInput = input['tool_input'];
  if (isJsonObject(toolInput)) {
    const projected: JsonObject = {};
    const filePath = pathString(toolInput['file_path']);
    const notebookPath = pathString(toolInput['notebook_path']);
    if (filePath !== undefined) projected['file_path'] = filePath;
    if (notebookPath !== undefined) projected['notebook_path'] = notebookPath;
    // A search's directory and a Glob's pattern (which may be an absolute path): never shortened, like a path.
    const searchPath = pathString(toolInput['path']);
    if (searchPath !== undefined) projected['path'] = searchPath;
    if (input['tool_name'] === 'Glob') {
      const pattern = pathString(toolInput['pattern']);
      if (pattern !== undefined) projected['pattern'] = pattern;
    }
    out['tool_input'] = projected;
  }
  // FileChanged
  set('file_path', pathString(input['file_path']));
  set('event', shortString(input['event']));
  // SessionStart / SessionEnd
  set('source', shortString(input['source']));
  set('reason', shortString(input['reason']));
  if (typeof input['stop_hook_active'] === 'boolean') out['stop_hook_active'] = input['stop_hook_active'];
  return out;
}

/**
 * The event name when the input could not be parsed as JSON (it was cut, or too big): a regex on the raw text, so a
 * broken PostToolUse input is not answered with a PreToolUse deny. null when it cannot be told.
 */
export function sniffHookEventName(rawText: string): string | null {
  const match = /"hook_event_name"\s*:\s*"([A-Za-z]{1,64})"/.exec(rawText.slice(0, 64 * 1024));
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hook output
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The only decision smurg ever returns (claude-hooks.md §3.4). There is deliberately no "allow" builder: the gate
 * never allows (allowing stays with Claude Code's rules and with people), so a passed call returns no output at all.
 */
export function preToolUseDeny(reason: string): JsonObject {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
