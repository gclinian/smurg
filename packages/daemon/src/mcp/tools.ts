// The coordination MCP server's tools (SPEC R8 「協調用 MCP server」): what the agent sees in `tools/list`. The daemon
// decides every answer (src/hooks/mcp-tools.ts); these definitions only describe the calls. Descriptions are English
// and written for the agent: when to use the tool, what the answer means, what to do next.
//
// Loaded by the `smurg mcp` entry point: no imports beyond the dependency-free wire constants (fast start).
import { NOTIFY_MESSAGE_MAX_CHARS, WAIT_FOR_LOCK_DEFAULT_SECONDS, WAIT_FOR_LOCK_MAX_SECONDS, type JsonObject, type McpToolName } from '../hooks/wire.ts';

/** One entry of `tools/list` (MCP 2025-06-18 Tool). */
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly annotations: JsonObject;
}

const FILE_PATH = {
  type: 'string',
  description: 'The file, as an absolute path or relative to the workspace root (the session\'s working directory).',
};

export const MCP_TOOLS: readonly (ToolDefinition & { readonly name: McpToolName })[] = Object.freeze([
  {
    name: 'who_is_editing',
    title: 'Who is editing a file',
    description:
      'Check whether anyone is working on a file of this shared smurg workspace right now: teammates typing in it (they hold a shared human edit lock) or another Claude agent modifying it (an agent lock). ' +
      'smurg blocks Edit/Write/NotebookEdit on a file someone else holds, so call this before starting on a file other people may be working in, or after an edit was blocked, to learn who holds it.',
    inputSchema: { type: 'object', properties: { file_path: FILE_PATH }, required: ['file_path'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'lock_status',
    title: 'File locks',
    description:
      'Show the lock on one file, or, without file_path, every locked file in this workspace. While a file is locked by someone else, your edits to it are blocked: ' +
      'humans hold a lock while they type (released about 30 s after they stop), an agent holds one while its edit is pending (at most 60 s). Locks you hold yourself are marked isYou.',
    inputSchema: { type: 'object', properties: { file_path: FILE_PATH }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wait_for_lock',
    title: 'Wait for a file to be free',
    description:
      `Wait until a file is no longer locked by a teammate or another agent, for at most timeout_seconds (default ${WAIT_FOR_LOCK_DEFAULT_SECONDS}, max ${WAIT_FOR_LOCK_MAX_SECONDS}). ` +
      'Returns released=true as soon as the file is free (then retry your edit), or released=false with the current lock when the time is up. ' +
      'Prefer working on other files first; wait only when the blocked file is the one thing left to do.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: FILE_PATH,
        timeout_seconds: { type: 'number', minimum: 1, maximum: WAIT_FOR_LOCK_MAX_SECONDS, description: `How long to wait at most, in seconds (default ${WAIT_FOR_LOCK_DEFAULT_SECONDS}).` },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_sessions',
    title: 'Sessions in this workspace',
    description:
      'List every Claude Code session and terminal in this smurg workspace: its owner, status, whether it works in the main workspace or in a worktree, and the files each agent is modifying right now (isYou marks this session). ' +
      'Use it to avoid working on the same files as another agent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'notify_member',
    title: 'Notify a workspace member',
    description:
      "Send a short notification to one member of this workspace; it pops up in their smurg window. Use it when a person needs to act, e.g. to ask the teammate who holds a file to release it, or to tell the session's owner that a long task is done. " +
      `member is their display name or user id (see list_sessions for owners); message is plain text (at most ${NOTIFY_MESSAGE_MAX_CHARS} characters); file_path optionally points them at a file. ` +
      'Members see every notification: do not send routine progress updates.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: "The member's display name (as shown in smurg) or user id, e.g. \"Amy\" or \"github:12345\"." },
        message: { type: 'string', maxLength: NOTIFY_MESSAGE_MAX_CHARS, description: 'What to tell them (plain text).' },
        file_path: FILE_PATH,
      },
      required: ['member', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
]);
