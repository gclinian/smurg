import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, PERMISSION_WHATS, SESSION_MODE_CHOICES, TOOL_VERBS, type PermissionMode, type SessionModeChoice } from './schema/index.ts';
import { EDIT_TOOL_NAMES, SMURG_TOOL_PREFIX, effectivePermissionMode, isEditTool, isLooserMode, permissionWhat, toolVerb } from './tools.ts';

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

  // Changed on purpose in 0.6.0 (protocol 5): `defaultPermissionMode(purpose, root)` is gone. The workspace's mode
  // applies everywhere, the main workspace included; a session's own choice, else (a work item) its topic's, wins.
  it('the mode a session runs with: its own choice, else (a work item) its topic\'s, else the workspace\'s; a discussion reads ask-all', () => {
    const choices: (SessionModeChoice | null)[] = [null, ...SESSION_MODE_CHOICES];
    for (const workspace of PERMISSION_MODES) {
      for (const session of choices) {
        for (const topic of choices) {
          expect(effectivePermissionMode({ purpose: 'discussion', session, topic, workspace })).toBe('ask-all');
          expect(effectivePermissionMode({ purpose: 'item', session, topic, workspace })).toBe(session ?? topic ?? workspace);
          // A free session has no topic: a topic's choice is never read for it.
          expect(effectivePermissionMode({ purpose: 'free', session, topic, workspace })).toBe(session ?? workspace);
        }
      }
    }
    expect(effectivePermissionMode({ purpose: 'free', session: null, topic: null, workspace: 'auto' })).toBe('auto');
    expect(effectivePermissionMode({ purpose: 'item', session: null, topic: 'ask-all', workspace: 'ask-nothing' })).toBe('ask-all');
    expect(effectivePermissionMode({ purpose: 'item', session: 'auto', topic: 'ask-all', workspace: 'ask-commands' })).toBe('auto');
  });

  it('strict to loose: ask-all < ask-commands < auto < ask-nothing', () => {
    const order: PermissionMode[] = ['ask-all', 'ask-commands', 'auto', 'ask-nothing'];
    expect([...PERMISSION_MODES].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(order);
    for (const [i, a] of order.entries()) {
      for (const [j, b] of order.entries()) expect(isLooserMode(a, b), `${a} looser than ${b}`).toBe(i > j);
    }
  });
});
