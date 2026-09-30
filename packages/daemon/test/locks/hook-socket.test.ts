// R8.1 / R8.2 / R8.3 / R8.5 through the real hook socket: the locks module composed with the hooks module, requests
// in the ARCHITECTURE §7.7 wire format (newline-delimited JSON, the session token from registerSession), exactly as
// `smurg hook` sends them for Claude Code. Only the contract is used here (HookServer.registerSession, the socket
// protocol), not the hooks module's internals.
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { hooksModule } from '../../src/hooks/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { humanTypes, recorder } from './agent-sim.ts';

const APP: FileRef = { root: MAIN_ROOT, path: 'src/app.ts' };

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

let requestSeq = 0;

/** One request line on the hook socket, one reply line back (ARCHITECTURE §7.7). */
function socketRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('no reply from the hook socket'));
    }, 10_000);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(text.slice(0, newline)) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface Agent {
  readonly sessionId: string;
  hook(hookInput: Record<string, unknown>): Promise<unknown>;
}

async function setup(): Promise<{ readonly d: TestDaemon; readonly ian: Agent; readonly hosts: Agent }> {
  const d = await createTestDaemon({ modules: [locksModule, hooksModule], project: { files: { 'src/app.ts': 'export const a = 1;\n' } } });
  t = d;
  await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
  const hooks = d.ctx.services.hooks;
  const agent = (sessionId: string, ownerUserId: string, name: string): Agent => {
    const { token } = hooks.registerSession({ sessionId, ownerUserId, agentName: `Claude（${name}）`, root: MAIN_ROOT, sandboxed: ownerUserId !== 'dev:host' });
    return {
      sessionId,
      hook: async (hookInput) => {
        requestSeq += 1;
        const reply = await socketRequest(hooks.socketPath, { id: `r${requestSeq}`, token, op: 'hook', hookInput });
        return reply['hookOutput'];
      },
    };
  };
  return { d, ian: agent('ses_ian', 'dev:ian', 'Ian'), hosts: agent('ses_host', 'dev:host', 'Host') };
}

function toolEvent(d: TestDaemon, event: 'PreToolUse' | 'PostToolUse' | 'PermissionRequest', tool = 'Edit'): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: 'claude-session-1',
    cwd: d.root,
    tool_name: tool,
    tool_use_id: 'toolu_1',
    tool_input: { file_path: join(d.root, 'src/app.ts'), old_string: 'a = 1', new_string: 'a = 2' },
  };
}

function denyReason(output: unknown): string | null {
  const specific = (output as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null)?.hookSpecificOutput;
  return specific?.permissionDecision === 'deny' ? (specific.permissionDecisionReason ?? '') : null;
}

describe('R8 through the hook socket (hooks module + locks module)', () => {
  it('R8.1 有人正在打字的檔案，agent 的 Edit 被擋下，並收到持有者的名字 — the PreToolUse answer Claude Code gets', async () => {
    const { d, ian } = await setup();
    humanTypes(d, { userId: 'dev:amy', displayName: 'Amy' }, APP);
    const output = await ian.hook(toolEvent(d, 'PreToolUse'));
    expect(denyReason(output)).toBe('此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試');
    expect(d.ctx.services.locks.get(APP)?.kind).toBe('human');
  });

  it('R8.2 / R8.3 / R8.5 — PreToolUse takes the lock (no decision: the owner’s prompt stays), a second agent is refused, PostToolUse frees it and the edit is in the feed', async () => {
    const { d, ian, hosts } = await setup();
    const host = await d.connectHost();
    const states = recorder(host.conn, 'lock.state');
    const activity = recorder(host.conn, 'activity.event');

    expect(await ian.hook(toolEvent(d, 'PreToolUse'))).toBeNull(); // granted: nothing printed, never "allow"
    expect(d.ctx.services.locks.get(APP)).toMatchObject({ kind: 'agent', sessionId: 'ses_ian', agentName: 'Claude（Ian）' });
    expect(await ian.hook(toolEvent(d, 'PermissionRequest'))).toBeNull();
    expect(denyReason(await hosts.hook(toolEvent(d, 'PreToolUse', 'Write')))).toContain('Claude（Ian）正在修改此檔案');

    expect(await ian.hook(toolEvent(d, 'PostToolUse'))).toBeNull();
    expect(d.ctx.services.locks.get(APP)).toBeNull();
    await waitFor(() => states.some((s) => s.lock === null) && activity.some((a) => a.event.kind === 'agent.edit'), { what: 'release and the activity entry' });
    expect(states[0]).toMatchObject({ file: APP, lock: { kind: 'agent', agentName: 'Claude（Ian）' } });
    expect(activity.find((a) => a.event.kind === 'agent.edit')?.event.actor).toEqual({ kind: 'agent', sessionId: 'ses_ian', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' });
    expect(activity.find((a) => a.event.kind === 'lock.denied')?.event.actor).toMatchObject({ kind: 'agent', sessionId: 'ses_host' });
  });

  it('R8.2 … — the owner rejects the permission prompt (no Post event): the next UserPromptSubmit frees the file', async () => {
    const { d, ian } = await setup();
    expect(await ian.hook(toolEvent(d, 'PreToolUse'))).toBeNull();
    expect(await ian.hook(toolEvent(d, 'PermissionRequest'))).toBeNull();
    expect(d.ctx.services.locks.get(APP)?.kind).toBe('agent');
    await ian.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-1', cwd: d.root });
    expect(d.ctx.services.locks.get(APP)).toBeNull();
  });
});
