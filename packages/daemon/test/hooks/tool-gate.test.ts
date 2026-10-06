// THE TOOL GATE on the hook socket (DESIGN §2.10, AD-7): the real hook server asked for EVERY tool, as `smurg hook`
// (registered with the matcher `*`) asks it. Its table as a pure function: test/sessions/agent-pure.test.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHookRegistration } from '../../src/core/fakes/build.ts';
import type { DaemonEvents } from '../../src/core/interfaces.ts';
import { daemonUnreachableReason, gateDenyReason } from '../../src/hooks/deny-text.ts';
import { runHookCli } from '../../src/hooks/hook-cli.ts';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { denyReasonOf, hookRequest, pre, startHookDaemon, type HookDaemon } from './helpers.ts';

let d: HookDaemon | null = null;
afterEach(async () => {
  await d?.t.cleanup();
  d = null;
});

const DISCUSSION_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion'];
const EXECUTION_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TaskStop', 'WebFetch', 'WebSearch', 'Task', 'AskUserQuestion'];
const call = (tool: string, toolInput: Record<string, unknown> = {}): Record<string, unknown> => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: `toolu_${tool}_${Math.random().toString(36).slice(2)}`, cwd: d?.t.root });

async function setup(): Promise<{ gate: DaemonEvents['agent.tool.gate'][]; token(purpose: 'discussion' | 'item' | 'free', pathRights?: 'member' | 'host'): string; sessionId(purpose: string): string }> {
  d = await startHookDaemon({ daemon: { project: { files: { 'src/cart.ts': 'x', 'specs/checkout/SPEC.md': '# spec', '.envrc': 'SECRET=1', 'README.md': '#' } } } });
  await d.t.connectHost();
  const gate: DaemonEvents['agent.tool.gate'][] = [];
  d.t.ctx.bus.on('agent.tool.gate', (event) => gate.push(event));
  const ids = new Map<string, string>();
  return {
    gate,
    sessionId: (purpose) => ids.get(purpose) ?? '',
    token: (purpose, pathRights = 'host') => {
      const sessionId = `ses_${purpose}_${ids.size}`;
      ids.set(purpose, sessionId);
      const hooks = (d as HookDaemon).hooks;
      return hooks.registerSession(
        buildHookRegistration({
          sessionId,
          ownerUserId: TEST_HOST_USER,
          agentName: 'Claude (Checkout)',
          root: { kind: 'main' },
          purpose,
          ...(purpose === 'free' ? {} : { topic: { id: 'tp_1', slug: 'checkout' } }),
          ...(purpose === 'item' ? { itemId: 'cart-api' } : {}),
          pathRights,
          tools: purpose === 'discussion' ? DISCUSSION_TOOLS : EXECUTION_TOOLS,
        }),
      ).token;
    },
  };
}

describe('the tool gate on the hook socket', () => {
  it('a discussion session: it writes only its SPEC.md and PLAN.md (with the lock), reads only inside the project and never a private file, and has no other tool; each refusal is one fixed sentence and a bus event', async () => {
    const s = await setup();
    const hooks = (d as HookDaemon).hooks;
    const root = (d as HookDaemon).t.root;
    const token = s.token('discussion');
    const ask = async (tool: string, input: Record<string, unknown> = {}) => denyReasonOf(await hookRequest(hooks.socketPath, token, call(tool, input)));
    // G6: any other file, a neighbour topic's file, a new file next to the spec, a file outside the project.
    expect(await ask('Write', { file_path: join(root, 'src/cart.ts') })).toBe(gateDenyReason('G6', { slug: 'checkout' }));
    expect(await ask('Edit', { file_path: join(root, 'specs/other/SPEC.md') })).toBe(gateDenyReason('G6', { slug: 'checkout' }));
    expect(await ask('Write', { file_path: join(root, 'specs/checkout/CLAUDE.md') })).toBe(gateDenyReason('G6', { slug: 'checkout' }));
    expect(await ask('Write', { file_path: '/tmp/elsewhere.txt' })).toBe(gateDenyReason('G6', { slug: 'checkout' }));
    expect((d as HookDaemon).fakes.locks.list()).toEqual([]);
    // Its own two files: no decision is printed, the agent lock is taken as for every edit.
    expect(await ask('Edit', { file_path: join(root, 'specs/checkout/SPEC.md') })).toBeNull();
    expect(await ask('Write', { file_path: join(root, 'specs/checkout/PLAN.md') })).toBeNull();
    expect((d as HookDaemon).fakes.locks.list().length).toBeGreaterThanOrEqual(1);
    // G5: reads outside the root, of a host-private file, a Glob that leaves the folder.
    expect(await ask('Read', { file_path: join(root, 'src/cart.ts') })).toBeNull();
    expect(await ask('Read', { file_path: '/etc/passwd' })).toBe(gateDenyReason('G5'));
    expect(await ask('Read', { file_path: join(root, '.envrc') })).toBe(gateDenyReason('G5'));
    expect(await ask('Grep', { pattern: 'SECRET', path: join(root, '.git') })).toBe(gateDenyReason('G5'));
    expect(await ask('Grep', { pattern: 'SECRET' })).toBeNull();
    expect(await ask('Glob', { pattern: '/etc/**' })).toBe(gateDenyReason('G5'));
    expect(await ask('Glob', { pattern: 'src/**/*.ts', path: root })).toBeNull();
    expect(await ask('Glob', { pattern: '**', path: '/Users' })).toBe(gateDenyReason('G5'));
    // G2: no command, no network, no tool smurg does not list; its own questions and smurg's own tools pass.
    expect(await ask('Bash', { command: 'ls' })).toBe(gateDenyReason('G2', { tool: 'Bash' }));
    expect(await ask('WebFetch', { url: 'https://example.com' })).toBe(gateDenyReason('G2', { tool: 'WebFetch' }));
    expect(await ask('mcp__mail__send', {})).toBe(gateDenyReason('G2', { tool: 'mcp__mail__send' }));
    expect(await ask('AskUserQuestion', { questions: [] })).toBeNull();
    expect(await ask('mcp__smurg__check_plan', {})).toBeNull();
    expect(s.gate.map((event) => event.row)).toEqual(['G6', 'G6', 'G6', 'G6', 'G5', 'G5', 'G5', 'G5', 'G5', 'G2', 'G2', 'G2']);
    expect(s.gate[0]).toEqual({ sessionId: s.sessionId('discussion'), tool: 'Write', row: 'G6', path: 'src/cart.ts' });
    expect(s.gate[3]).toEqual({ sessionId: s.sessionId('discussion'), tool: 'Write', row: 'G6' });
  });

  it('a work item never edits its topic\'s spec or plan; a free session of a member never Claude Code\'s configuration or a host-only path; commands get NO decision (Claude Code\'s rules and people decide)', async () => {
    const s = await setup();
    const hooks = (d as HookDaemon).hooks;
    const root = (d as HookDaemon).t.root;
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), '{}');
    const item = s.token('item', 'member');
    const free = s.token('free', 'member');
    const ask = async (token: string, tool: string, input: Record<string, unknown> = {}) => denyReasonOf(await hookRequest(hooks.socketPath, token, call(tool, input)));
    expect(await ask(item, 'Edit', { file_path: join(root, 'specs/checkout/SPEC.md') })).toBe(gateDenyReason('G7'));
    expect(await ask(item, 'Write', { file_path: join(root, 'specs/checkout/PLAN.md') })).toBe(gateDenyReason('G7'));
    expect(await ask(item, 'Write', { file_path: join(root, 'specs/checkout/reports/cart-api.md') })).toBeNull();
    expect(await ask(item, 'Edit', { file_path: join(root, 'src/cart.ts') })).toBeNull();
    expect(await ask(free, 'Edit', { file_path: join(root, 'specs/checkout/SPEC.md') })).toBeNull();
    expect(await ask(free, 'Write', { file_path: join(root, '.claude/settings.json') })).toBe(gateDenyReason('G3'));
    expect(await ask(free, 'Write', { file_path: join(root, '.mcp.json') })).toBe(gateDenyReason('G3'));
    expect(await ask(free, 'Edit', { file_path: join(root, 'CLAUDE.md') })).toBe(gateDenyReason('G4'));
    // G9: no decision at all for what the gate does not judge.
    for (const [tool, input] of [['Bash', { command: 'rm -rf /' }], ['WebFetch', { url: 'https://example.com' }], ['Task', { description: 'x' }], ['Read', { file_path: '/etc/passwd' }], ['TaskStop', {}]] as const) {
      expect((await hookRequest(hooks.socketPath, free, call(tool, input)))['hookOutput'], tool).toBeNull();
    }
    expect(await ask(free, 'BrandNewTool')).toBe(gateDenyReason('G2', { tool: 'BrandNewTool' }));
    expect(s.gate.map((event) => `${event.tool}:${event.row}`)).toEqual(['Edit:G7', 'Write:G7', 'Write:G3', 'Write:G3', 'Edit:G4', 'BrandNewTool:G2']);
  });

  it('G1: when the daemon does not answer, `smurg hook` refuses EVERY tool by itself, not only edits (an orphaned agent\'s command does not run)', async () => {
    for (const tool of ['Bash', 'Read', 'WebFetch', 'AskUserQuestion', 'mcp__smurg__check_plan', 'Edit']) {
      let stdout = '';
      const code = await runHookCli({
        stdin: (async function* () {
          yield JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' });
        })(),
        stdout: { write: (chunk: string | Uint8Array) => (stdout += String(chunk)) },
        stderr: { write: () => undefined },
        env: { SMURG_HOOK_SOCKET: '/nonexistent/smurg.hook', SMURG_SESSION_TOKEN: 'x'.repeat(43), SMURG_SESSION_ID: 'ses_x' },
        args: [],
      });
      expect(code).toBe(0);
      const output = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(output.hookSpecificOutput.permissionDecision, tool).toBe('deny');
      expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/^smurg is not reachable on the host \(.+\)\. Nothing can run until it is back\.$/);
    }
    expect(daemonUnreachableReason('x')).toBe('smurg is not reachable on the host (x). Nothing can run until it is back.');
    // An unknown token (the session ended, the daemon restarted): refused as well, whatever the tool.
    const s = await setup();
    void s;
    const reply = await hookRequest((d as HookDaemon).hooks.socketPath, 'y'.repeat(43), pre('/x', 'Bash')).catch(() => ({ hookOutput: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'closed' } } }));
    expect(denyReasonOf(reply)).not.toBeNull();
  });
});
