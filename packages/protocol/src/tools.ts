// Claude Code's tools as smurg names them on the wire (ARCHITECTURE §5.9, §7.6): ONE classification for the tool card
// of a call (`ToolView.verb`, the runner), for its permission card (`PermissionRequest.what`, the conversation module)
// and for the tool gate (which tools edit files). Also the permission mode a session starts with. Pure and
// dependency-free: only type imports.
import type { PermissionWhat, ToolVerb, ToolView } from './schema/conversation.ts';
import type { AgentPurpose, PermissionMode } from './schema/entities.ts';
import type { RootRef } from './schema/paths.ts';

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
 * The permission mode a session starts with, and returns to when a member who loosened it is removed
 * (ARCHITECTURE §7.6 "Profiles"): a work item's session and a free session in a worktree ask before commands
 * (`ask-commands`); a free session in the main workspace asks before edits too (`ask-all`). A discussion session's
 * permissions are fixed (`modeFixed`); its `permissionMode` reads `ask-all`.
 */
export function defaultPermissionMode(purpose: AgentPurpose, root: RootRef): PermissionMode {
  if (purpose === 'discussion') return 'ask-all';
  if (purpose === 'item') return 'ask-commands';
  return root.kind === 'main' ? 'ask-all' : 'ask-commands';
}
