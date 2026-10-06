// TEST ONLY: a daemon with the real hook server (and fake locks / sessions / activity), plus socket clients that speak
// the hook protocol directly: well-formed requests through the same client the hook uses, raw bytes for forgeries.
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { MAIN_ROOT, type RootRef } from '@smurg/protocol';
import { buildHookRegistration } from '../../src/core/fakes/build.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { requestDaemon } from '../../src/hooks/socket-client.ts';
import type { JsonObject } from '../../src/hooks/wire.ts';
import { TEST_HOST_USER, createTestDaemon, type TestDaemon, type TestDaemonOptions } from '../../src/testing/index.ts';
import { fakeServices, type FakeServices } from './fakes.ts';

export interface HookDaemon {
  readonly t: TestDaemon;
  readonly hooks: HookServerImpl;
  readonly fakes: FakeServices;
}

export async function startHookDaemon(
  options: { readonly fakes?: Parameters<typeof fakeServices>[0]; readonly daemon?: Omit<TestDaemonOptions, 'modules'> } = {},
): Promise<HookDaemon> {
  const fakes = fakeServices(options.fakes);
  const t = await createTestDaemon({ ...options.daemon, modules: [fakes.module, hooksModule] });
  const hooks = t.ctx.services.hooks;
  if (!(hooks instanceof HookServerImpl)) throw new Error('the hooks slot is not the HookServerImpl');
  return { t, hooks, fakes };
}

/**
 * Registers a session as the sessions module does: `pathRights` is `host` exactly when the host opened it (fixed at
 * creation; a later `reassignSession` never changes it). Pass `pathRights` to say otherwise.
 */
export function registerAgent(
  hooks: HookServerImpl,
  owner: { readonly userId: string; readonly name: string },
  options: { readonly sessionId?: string; readonly root?: RootRef; readonly pathRights?: 'member' | 'host' } = {},
): { readonly sessionId: string; readonly token: string; readonly env: Readonly<Record<string, string>> } {
  const sessionId = options.sessionId ?? `ses_${randomBytes(8).toString('hex')}`;
  const pathRights = options.pathRights ?? (owner.userId === TEST_HOST_USER ? 'host' : 'member');
  const creds = hooks.registerSession(buildHookRegistration({ sessionId, ownerUserId: owner.userId, agentName: `Claude (${owner.name})`, root: options.root ?? MAIN_ROOT, pathRights }));
  return { sessionId, token: creds.token, env: creds.env };
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${seq}`;
}

/** One hook request; resolves with the whole reply object. */
export function hookRequest(socketPath: string, token: string, hookInput: JsonObject): Promise<JsonObject> {
  return requestDaemon(socketPath, { id: nextId(), token, op: 'hook', hookInput }, { deadlineMs: 15_000 });
}

/** A request of the Bash ACTIVITY hook (`smurg hook bash-activity`): it carries `via` and is never answered with a decision. */
export function bashActivityRequest(socketPath: string, token: string, hookInput: JsonObject): Promise<JsonObject> {
  return requestDaemon(socketPath, { id: nextId(), token, op: 'hook', hookInput, via: 'bash-activity' }, { deadlineMs: 15_000 });
}

export function mcpRequest(socketPath: string, token: string, tool: string, args: JsonObject = {}, deadlineMs = 15_000): Promise<JsonObject> {
  return requestDaemon(socketPath, { id: nextId(), token, op: 'mcp', tool, args }, { deadlineMs });
}

/** Writes raw bytes, collects everything the daemon answers until it closes the connection (or the timeout). */
export function rawExchange(socketPath: string, data: string | Buffer, timeoutMs = 5_000): Promise<{ readonly text: string; readonly closedByDaemon: boolean }> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (closedByDaemon: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ text: Buffer.concat(chunks).toString('utf8'), closedByDaemon });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('connect', () => socket.write(data));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => finish(true));
    socket.on('close', () => finish(true));
  });
}

export function pre(filePath: string, tool = 'Edit', extra: JsonObject = {}): JsonObject {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: filePath } : { file_path: filePath }, tool_use_id: `toolu_${nextId()}`, ...extra };
}

export function post(filePath: string, event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' = 'PostToolUse', tool = 'Edit'): JsonObject {
  return { hook_event_name: event, tool_name: tool, tool_input: { file_path: filePath }, tool_use_id: `toolu_${nextId()}` };
}

export function lifecycle(event: 'UserPromptSubmit' | 'Stop' | 'SessionEnd' | 'SessionStart'): JsonObject {
  return { hook_event_name: event, session_id: 'claude-session' };
}

export function denyReasonOf(reply: JsonObject): string | null {
  const output = reply['hookOutput'];
  if (typeof output !== 'object' || output === null) return null;
  const specific = (output as JsonObject)['hookSpecificOutput'] as JsonObject | undefined;
  if (specific?.['permissionDecision'] !== 'deny') return null;
  return String(specific['permissionDecisionReason']);
}
