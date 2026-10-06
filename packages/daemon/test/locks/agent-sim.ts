// Test stand-ins for the modules that call the locks module and are built by other engineers: the hooks module
// (PreToolUse / PostToolUse / UserPromptSubmit on the hook socket, ARCHITECTURE §7.7), the docs module (touchHuman on
// every human Yjs update, §7.5) and the files module's watcher (file.changed). Each helper does exactly what the
// contract (core/interfaces.ts) says that module does, so these tests pin the locks module's side of it.
import { buildAgentSession, buildTerminalSession } from '../../src/core/fakes/build.ts';
import { MAIN_ROOT, type Actor, type FileRef, type PayloadOf, type RootRef, type SessionInfo } from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';
import type { FileChangeKind } from '../../src/core/interfaces.ts';
import type { TestDaemon } from '../../src/testing/index.ts';

export interface SimSession {
  readonly id: string;
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly root: RootRef;
}

export function agentSession(id: string, ownerUserId: string, ownerName: string, root: RootRef = MAIN_ROOT): SimSession {
  return { id, ownerUserId, ownerName, root };
}

/** The SessionInfo of a simulated session: an agent session (`running` / `ended`) or, for contrast, a terminal. */
export function sessionInfo(session: SimSession, status: 'running' | 'ended' = 'running', kind: SessionInfo['kind'] = 'agent'): SessionInfo {
  const openedBy = { userId: session.ownerUserId, displayName: session.ownerName };
  if (kind === 'terminal') return buildTerminalSession({ id: session.id, openedBy, title: 'shell', root: session.root, status: status === 'ended' ? 'exited' : 'running', createdAt: Date.now() });
  return buildAgentSession({ id: session.id, openedBy, title: 'claude', root: session.root, status, createdAt: Date.now() });
}

/** The deny JSON the hook prints on stdout (claude-hooks.md §3.4), or null (no decision: the owner's prompt stays). */
export type HookOutput = { readonly hookSpecificOutput: { readonly hookEventName: 'PreToolUse'; readonly permissionDecision: 'deny'; readonly permissionDecisionReason: string } } | null;

/** The hooks module's PreToolUse for Edit / Write / NotebookEdit. */
export function preToolUse(t: TestDaemon, session: SimSession, file: FileRef, tool = 'Edit'): { readonly granted: boolean; readonly hookOutput: HookOutput } {
  const result = t.ctx.services.locks.requestAgent({
    file,
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    agentName: `Claude (${session.ownerName})`,
    sessionRoot: session.root,
  });
  t.ctx.bus.emit('agent.tool.pre', {
    sessionId: session.id,
    ownerUserId: session.ownerUserId,
    tool,
    file,
    outcome: result.granted ? 'granted' : 'denied',
    ...(!result.granted && result.holder ? { holder: result.holder } : {}),
  });
  if (result.granted) return { granted: true, hookOutput: null };
  return { granted: false, hookOutput: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } } };
}

/** PostToolUse (ok) / PostToolUseFailure (ok: false). */
export function postToolUse(t: TestDaemon, session: SimSession, file: FileRef, options: { readonly ok?: boolean; readonly tool?: string } = {}): void {
  t.ctx.services.locks.releaseAgent(session.id, file);
  t.ctx.bus.emit('agent.tool.post', { sessionId: session.id, ownerUserId: session.ownerUserId, tool: options.tool ?? 'Edit', file, ok: options.ok ?? true });
}

export function permissionRequest(t: TestDaemon, session: SimSession, file: FileRef): void {
  t.ctx.services.locks.markAwaitingApproval(session.id, file);
}

export function userPromptSubmit(t: TestDaemon, session: SimSession): void {
  t.ctx.services.locks.releaseAllForSession(session.id, 'prompt');
}

/** DocService on a human Yjs update. */
export function humanTypes(t: TestDaemon, who: { readonly userId: string; readonly displayName: string }, file: FileRef) {
  return t.ctx.services.locks.touchHuman(file, who);
}

/** The files module's watcher. */
export function watcherSaw(t: TestDaemon, file: FileRef, change: FileChangeKind = 'change', by?: Actor): void {
  t.ctx.bus.emit('file.changed', { root: file.root, changes: [{ path: file.path, change, ...(by ? { by } : {}) }] });
}

type RecordedTypes = 'lock.state' | 'activity.event' | 'presence.state' | 'activity.notify';

/** Everything of `type` a client receives from now on. */
export function recorder<T extends RecordedTypes>(conn: Connection, type: T): PayloadOf<T>[] {
  const seen: PayloadOf<T>[] = [];
  conn.on(type, (payload) => seen.push(payload as PayloadOf<T>));
  return seen;
}
