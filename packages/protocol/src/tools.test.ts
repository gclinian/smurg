import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, PERMISSION_WHATS, TOOL_VERBS } from './schema/index.ts';
import { MAIN_ROOT, worktreeRoot } from './schema/paths.ts';
import { EDIT_TOOL_NAMES, SMURG_TOOL_PREFIX, defaultPermissionMode, isEditTool, permissionWhat, toolVerb } from './tools.ts';

describe("Claude Code's tools as smurg classifies them: one function for the tool card, the permission card and the gate", () => {
  it('the edit tools', () => {
    expect([...EDIT_TOOL_NAMES]).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    for (const name of EDIT_TOOL_NAMES) expect(isEditTool(name)).toBe(true);
    for (const name of ['Bash', 'Read', 'edit', 'mcp__smurg__check_plan', '']) expect(isEditTool(name)).toBe(false);
  });

  it('a verb for every tool; an unknown tool is `other`, smurg\'s own MCP tools are `smurg`', () => {
    const table: Record<string, string> = {
      Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'edit',
      Bash: 'run', BashOutput: 'run', KillShell: 'run', Glob: 'search', Grep: 'search', WebFetch: 'fetch', WebSearch: 'fetch',
      Task: 'task', TodoWrite: 'todo', AskUserQuestion: 'other', mcp__github__create_issue: 'other', toString: 'other', __proto__: 'other',
      [`${SMURG_TOOL_PREFIX}check_report`]: 'smurg',
    };
    for (const [name, verb] of Object.entries(table)) expect(toolVerb(name), name).toBe(verb);
    for (const name of Object.keys(table)) expect(TOOL_VERBS).toContain(toolVerb(name));
    // Every edit tool reads as an edit (the runner says `create` for a Write of a new file).
    for (const name of EDIT_TOOL_NAMES) expect(toolVerb(name)).toBe('edit');
  });

  it('what a permission card is about follows the tool card of the same call; a path outside every root wins', () => {
    expect(permissionWhat({ verb: 'run' })).toBe('command');
    expect(permissionWhat({ verb: 'edit' })).toBe('edit');
    expect(permissionWhat({ verb: 'create' })).toBe('edit');
    expect(permissionWhat({ verb: 'fetch' })).toBe('fetch');
    for (const verb of ['read', 'search', 'task', 'smurg', 'todo', 'other'] as const) expect(permissionWhat({ verb })).toBe('other');
    for (const verb of TOOL_VERBS) expect(permissionWhat({ verb, outside: true })).toBe('outside');
    for (const verb of TOOL_VERBS) expect(PERMISSION_WHATS).toContain(permissionWhat({ verb }));
  });

  it('the mode a session starts with: only a free session in the main workspace asks before edits', () => {
    expect(defaultPermissionMode('free', MAIN_ROOT)).toBe('ask-all');
    expect(defaultPermissionMode('free', worktreeRoot('wt_1'))).toBe('ask-commands');
    expect(defaultPermissionMode('item', worktreeRoot('wt_1'))).toBe('ask-commands');
    expect(defaultPermissionMode('discussion', MAIN_ROOT)).toBe('ask-all');
    expect(PERMISSION_MODES).toContain(defaultPermissionMode('item', MAIN_ROOT));
  });
});
