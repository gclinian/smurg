// Claude Code's tools as smurg names them on the wire (ARCHITECTURE §5.9, §7.6): ONE classification for the tool card
// of a call (`ToolView.verb`, the runner), for its permission card (`PermissionRequest.what`, the conversation module)
// and for the tool gate (which tools edit files). Also the permission mode a session runs with. Pure and
// dependency-free: only type imports.
import type { PermissionWhat, ToolVerb, ToolView } from './schema/conversation.ts';
import type { AgentPurpose, PermissionMode, SessionModeChoice } from './schema/entities.ts';

/** The tools that edit a file: the tool gate takes the agent lock for them; a permission card shows the diff. */
export const EDIT_TOOL_NAMES = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const);
export type EditToolName = (typeof EDIT_TOOL_NAMES)[number];

export function isEditTool(name: string): name is EditToolName {
  return (EDIT_TOOL_NAMES as readonly string[]).includes(name);
}

/** The tools of smurg's own MCP server (`mcp__smurg__check_plan`, …): never refused by the gate's tool list. */
export const SMURG_TOOL_PREFIX = 'mcp__smurg__';

const VERB_BY_TOOL: Readonly<Record<string, ToolVerb>> = Object.freeze({
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  KillShell: 'run',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'task',
  TodoWrite: 'todo',
});

/**
 * What a tool does, by its name. `Write` is `edit` here: the runner says `create` instead when the file does not
 * exist yet. A tool smurg does not know (a host's or a project's MCP server) is `other`.
 */
export function toolVerb(name: string): ToolVerb {
  if (name.startsWith(SMURG_TOOL_PREFIX)) return 'smurg';
  return Object.hasOwn(VERB_BY_TOOL, name) ? (VERB_BY_TOOL[name] as ToolVerb) : 'other';
}

/**
 * `PermissionRequest.what` of a call, from the ToolView of the same call: a path outside every root is `outside`
 * whatever the tool; else a command, an edit, a fetch, or `other` (the card then shows the whole input).
 */
export function permissionWhat(view: Pick<ToolView, 'verb' | 'outside'>): PermissionWhat {
  if (view.outside === true) return 'outside';
  if (view.verb === 'run') return 'command';
  if (view.verb === 'edit' || view.verb === 'create') return 'edit';
  if (view.verb === 'fetch') return 'fetch';
  return 'other';
}

/**
 * The permission mode one session runs with (protocol 5, ARCHITECTURE §7.6 "Profiles"): its own choice, else (a work
 * item) its topic's, else the workspace's (`HostSettings.permissionMode`). The workspace's mode applies everywhere, the
 * main workspace included. A discussion session's permissions are fixed (`modeFixed`): it reads `ask-all`, whatever is
 * chosen. A topic's choice is read only for a work item.
 */
export function effectivePermissionMode(input: {
  readonly purpose: AgentPurpose;
  readonly session: SessionModeChoice | null;
  readonly topic: SessionModeChoice | null;
  readonly workspace: PermissionMode;
}): PermissionMode {
  if (input.purpose === 'discussion') return 'ask-all';
  return input.session ?? (input.purpose === 'item' ? input.topic : null) ?? input.workspace;
}

/** From strict to loose (the index is the order). */
const LOOSENESS: Readonly<Record<PermissionMode, number>> = Object.freeze({ 'ask-all': 0, 'ask-commands': 1, auto: 2, 'ask-nothing': 3 });

/** Strict to loose: ask-all < ask-commands < auto < ask-nothing. True when `a` lets more run without asking than `than`. */
export function isLooserMode(a: PermissionMode, than: PermissionMode): boolean {
  return LOOSENESS[a] > LOOSENESS[than];
}
