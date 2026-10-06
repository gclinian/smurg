// The tools of smurg's own MCP server (ARCHITECTURE §7.7; SPEC R8): what the agent sees in `tools/list`. The daemon
// decides every answer (src/hooks/mcp-tools.ts); these definitions only describe the calls. Descriptions are English
// and written for the agent: when to use the tool, what the answer means, what to do next.
//
// Two groups: the coordination tools every agent session has (who_is_editing, lock_status, wait_for_lock,
// list_sessions, notify_member) and the tools of a topic's sessions (check_plan and propose_split for the discussion
// session, check_report for a work item's session). Every session lists all of them: a tool called from the wrong
// kind of session answers with one sentence saying so (the daemon knows the session from its token).
//
// Loaded by the `smurg mcp` entry point: no imports beyond the dependency-free wire constants (fast start).
import { NOTIFY_MESSAGE_MAX_CHARS, WAIT_FOR_LOCK_DEFAULT_SECONDS, WAIT_FOR_LOCK_MAX_SECONDS, type JsonObject, type McpToolName } from '../hooks/wire.ts';

/** The tools of a topic's sessions (the agent validates its own plan and report in-band before its turn ends). */
export const TOPIC_TOOL_NAMES = Object.freeze(['check_plan', 'propose_split', 'check_report'] as const);
export type TopicToolName = (typeof TOPIC_TOOL_NAMES)[number];
/** Every tool of the `smurg` MCP server. */
export type AgentToolName = McpToolName | TopicToolName;

/** propose_split: most pairs in one call (a plan has at most 40 work items) and the longest reason. */
export const PROPOSE_SPLIT_ITEMS_MAX = 40;
export const PROPOSE_SPLIT_REASON_MAX_CHARS = 500;

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

export const MCP_TOOLS: readonly (ToolDefinition & { readonly name: AgentToolName })[] = Object.freeze([
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
  {
    name: 'check_plan',
    title: 'Check the plan file',
    description:
      "For the discussion session of a topic. Checks the work item block of the topic's PLAN.md as smurg reads it. " +
      'Answers ok=true with the number of work items and any warnings, or ok=false with errors, each with the line of the file and what is wrong there. ' +
      'Call it after every change of PLAN.md and fix what it reports until it answers ok: smurg can only use a plan that passes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'propose_split',
    title: 'Propose who is responsible for which work item',
    description:
      'For the discussion session of a topic, after check_plan answered ok. Proposes who is responsible for which work item: ' +
      'items is a list of { id, person }, id being the id of a work item in PLAN.md and person one of the names smurg gave you as "People who can be responsible right now"; reason is one sentence saying why. ' +
      'smurg keeps the pairs it can match and splits the remaining items evenly; people can change it afterwards. The answer says how many pairs were assigned and how many named an unknown person.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: PROPOSE_SPLIT_ITEMS_MAX,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The id of a work item, as in its "- id:" line.' },
              person: { type: 'string', description: 'One of the names smurg listed as people who can be responsible.' },
            },
            required: ['id', 'person'],
            additionalProperties: false,
          },
        },
        reason: { type: 'string', maxLength: PROPOSE_SPLIT_REASON_MAX_CHARS, description: 'One sentence: why this split.' },
      },
      required: ['items'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'check_report',
    title: 'Check the result report',
    description:
      "For the session of a work item. Checks the result report of your work item (specs/<topic>/reports/<item id>.md in your checkout) against the fixed format. " +
      'Answers ok=true, or ok=false with errors, each with the line of the file and what is wrong there. ' +
      'smurg registers a report only after this tool answered ok for exactly the content the file has when you stop: call it again after every change of the report.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

/** Whether `value` names a tool of the `smurg` MCP server. */
export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === 'string' && MCP_TOOLS.some((tool) => tool.name === value);
}
