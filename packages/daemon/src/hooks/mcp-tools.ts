// Daemon side of the coordination MCP tools (SPEC R8 「協調用 MCP server」; ARCHITECTURE §7.7 op 'mcp'). The stdio
// server Claude Code runs (../mcp/coord-server.ts) only forwards calls here with the session's token; the daemon
// answers from the LockManager, the SessionManager and the member directory, and delivers notify_member as
// `activity.notify` to that member only.
//
// The answers are read by the agent, so they are structured JSON with a one-line English `summary`. Paths are
// accepted absolute or relative to the session root, and only inside it (PathGuard with the agent's principal: the
// hidden .smurg stays hidden). Everything a session asks is bounded: waits end at the session's end, the daemon's
// stop or the caller's disconnect; notifications are rate-limited per session.
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { SmurgError, rootRefKey, rootRefEquals, type FileRef, type LockInfo } from '@smurg/protocol';
import { z } from 'zod';
import type { DaemonContext } from '../core/context.ts';
import { isPathDeniedError } from '../core/errors.ts';
import type { Principal } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import type { TokenBucket } from '../net/rate-limit.ts';
import { locateInSessionRoot, type HookSessionState } from './hook-events.ts';
import {
  listSessionsArgsSchema,
  lockStatusArgsSchema,
  notifyMemberArgsSchema,
  waitForLockArgsSchema,
  whoIsEditingArgsSchema,
} from './schemas.ts';
import { WAIT_FOR_LOCK_DEFAULT_SECONDS, type JsonObject, type McpToolName } from './wire.ts';

/** A refusal the agent should see (code of ARCHITECTURE §4.3, English message). */
export class McpToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

export interface McpToolContext {
  readonly ctx: DaemonContext;
  readonly state: HookSessionState;
  readonly principal: Principal;
  /** Aborted when the caller disconnects, the session is unregistered or the daemon stops. */
  readonly signal: AbortSignal;
  /** notify_member budget of this session. */
  readonly notifyBucket: TokenBucket;
}

/** Locks listed by lock_status without a path. */
const LOCK_LIST_MAX = 200;
const SESSION_LIST_MAX = 1_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  // Field paths and messages only, never the offending values.
  const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`);
  throw new McpToolError('bad_request', `Invalid arguments: ${issues.join('; ')}`);
}

function unavailable(what: string, err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  return new McpToolError('internal', `${what} is not available right now (${err instanceof SmurgError ? err.code : 'error'}). Try again later.`);
}

/** A path the agent named → a FileRef inside its session root, or a refusal it can act on. */
async function resolveToolPath(tc: McpToolContext, raw: string): Promise<FileRef> {
  const { ctx, state, principal } = tc;
  const root = ctx.roots.get(state.registration.root);
  if (root === null) throw new McpToolError('not_found', "This session's workspace root no longer exists.");
  const absolute = isAbsolute(raw) ? raw : resolvePath(root.realPath, raw);
  const located = await locateInSessionRoot(ctx, state.registration, absolute, undefined);
  if (!located.ok) throw new McpToolError('path_denied', "Only files inside this session's workspace can be queried.");
  try {
    return (await ctx.paths.resolve(located.ref, { principal, allowRoot: false })).ref;
  } catch (err) {
    if (isPathDeniedError(err)) throw new McpToolError(err.code, `This path cannot be used (${err.reason}).`);
    if (err instanceof SmurgError) throw new McpToolError(err.code, 'This path cannot be used.');
    throw err;
  }
}

function rootLabel(file: FileRef): string {
  return file.root.kind === 'main' ? 'main' : `worktree:${file.root.worktreeId}`;
}

function describeLock(lock: LockInfo, sessionId: string): JsonObject {
  if (lock.kind === 'human') {
    return {
      kind: 'human',
      file: lock.file.path,
      root: rootLabel(lock.file),
      holders: lock.holders.map((holder) => ({ name: holder.displayName, userId: holder.userId, lastActiveAt: iso(holder.lastActivityAt) })),
      since: iso(lock.acquiredAt),
    };
  }
  return {
    kind: 'agent',
    file: lock.file.path,
    root: rootLabel(lock.file),
    agent: lock.agentName,
    sessionId: lock.sessionId,
    ownerUserId: lock.ownerUserId,
    isYou: lock.sessionId === sessionId,
    since: iso(lock.acquiredAt),
    expiresAt: iso(lock.expiresAt),
  };
}

function lockSummary(path: string, lock: LockInfo | null, sessionId: string): string {
  if (lock === null) return `${path} is free: nobody is editing it.`;
  if (lock.kind === 'human') {
    const names = lock.holders.map((holder) => holder.displayName).join(', ');
    return `${path} is being edited by ${names} (a human edit lock). Do not edit it now: work on another file, or call wait_for_lock.`;
  }
  if (lock.sessionId === sessionId) return `${path} is locked by you (this session's pending edit).`;
  return `${path} is being modified by ${lock.agentName} (another agent). Do not edit it now: work on another file, or call wait_for_lock.`;
}

async function whoIsEditing(tc: McpToolContext, args: unknown): Promise<JsonObject> {
  const { file_path } = parseArgs(whoIsEditingArgsSchema, args);
  const file = await resolveToolPath(tc, file_path);
  const sessionId = tc.state.registration.sessionId;
  let info: ReturnType<DaemonContext['services']['locks']['whoIsEditing']>;
  let lock: LockInfo | null;
  try {
    info = tc.ctx.services.locks.whoIsEditing(file);
    lock = tc.ctx.services.locks.get(file);
  } catch (err) {
    throw unavailable('Lock information', err);
  }
  return {
    file: file.path,
    editing: info.humans.length > 0 || info.agent !== null,
    humans: info.humans.map((human) => ({ name: human.displayName, userId: human.userId, lastActiveAt: iso(human.lastActivityAt) })),
    agent: info.agent === null ? null : describeLock(info.agent, sessionId),
    summary: lockSummary(file.path, lock, sessionId),
  };
}

async function lockStatus(tc: McpToolContext, args: unknown): Promise<JsonObject> {
  const { file_path } = parseArgs(lockStatusArgsSchema, args);
  const sessionId = tc.state.registration.sessionId;
  if (file_path !== undefined) {
    const file = await resolveToolPath(tc, file_path);
    let lock: LockInfo | null;
    try {
      lock = tc.ctx.services.locks.get(file);
    } catch (err) {
      throw unavailable('Lock information', err);
    }
    return { file: file.path, locked: lock !== null, lock: lock === null ? null : describeLock(lock, sessionId), summary: lockSummary(file.path, lock, sessionId) };
  }
  let all: LockInfo[];
  try {
    all = tc.ctx.services.locks.list();
  } catch (err) {
    throw unavailable('Lock information', err);
  }
  const mine = all.filter((lock) => rootRefEquals(lock.file.root, tc.state.registration.root));
  return {
    locks: mine.slice(0, LOCK_LIST_MAX).map((lock) => describeLock(lock, sessionId)),
    truncated: mine.length > LOCK_LIST_MAX,
    summary: mine.length === 0 ? 'No file in this workspace is locked.' : `${mine.length} file(s) in this workspace are locked.`,
  };
}

async function waitForLock(tc: McpToolContext, args: unknown): Promise<JsonObject> {
  const { file_path, timeout_seconds } = parseArgs(waitForLockArgsSchema, args);
  const file = await resolveToolPath(tc, file_path);
  const sessionId = tc.state.registration.sessionId;
  const locks = tc.ctx.services.locks;
  let current: LockInfo | null;
  try {
    current = locks.get(file);
  } catch (err) {
    throw unavailable('Lock information', err);
  }
  if (current === null) return { file: file.path, released: true, waitedSeconds: 0, lock: null, summary: `${file.path} is free now.` };
  if (current.kind === 'agent' && current.sessionId === sessionId) {
    return { file: file.path, released: false, heldByYou: true, waitedSeconds: 0, lock: describeLock(current, sessionId), summary: lockSummary(file.path, current, sessionId) };
  }
  const timeoutMs = Math.round((timeout_seconds ?? WAIT_FOR_LOCK_DEFAULT_SECONDS) * 1000);
  const started = Date.now();
  let remaining: LockInfo | null;
  try {
    remaining = await locks.waitForRelease(file, { timeoutMs, signal: tc.signal });
  } catch (err) {
    if (tc.signal.aborted) throw new McpToolError('internal', 'The wait was cancelled (the session or the daemon is stopping).');
    throw unavailable('Lock information', err);
  }
  if (tc.signal.aborted) throw new McpToolError('internal', 'The wait was cancelled (the session or the daemon is stopping).');
  const waitedSeconds = Math.round((Date.now() - started) / 100) / 10;
  return {
    file: file.path,
    released: remaining === null,
    waitedSeconds,
    lock: remaining === null ? null : describeLock(remaining, sessionId),
    summary: remaining === null ? `${file.path} is free now.` : `Still locked after ${waitedSeconds} s. ${lockSummary(file.path, remaining, sessionId)}`,
  };
}

function listSessions(tc: McpToolContext, args: unknown): JsonObject {
  parseArgs(listSessionsArgsSchema, args);
  const sessionId = tc.state.registration.sessionId;
  let sessions: ReturnType<DaemonContext['services']['sessions']['list']>;
  try {
    sessions = tc.ctx.services.sessions.list();
  } catch (err) {
    throw unavailable('The session list', err);
  }
  let locks: LockInfo[] = [];
  try {
    locks = tc.ctx.services.locks.list();
  } catch {
    // the list is still useful without the files being edited
  }
  const editing = new Map<string, string[]>();
  for (const lock of locks) {
    if (lock.kind !== 'agent') continue;
    const files = editing.get(lock.sessionId) ?? [];
    files.push(`${rootRefKey(lock.file.root)}:${lock.file.path}`);
    editing.set(lock.sessionId, files);
  }
  return {
    sessions: sessions.slice(0, SESSION_LIST_MAX).map((session) => ({
      id: session.id,
      kind: session.kind,
      owner: session.ownerName,
      ownerUserId: session.ownerUserId,
      title: session.title,
      status: session.status,
      sandboxed: session.sandboxed,
      root: session.root.kind === 'main' ? 'main' : `worktree:${session.root.worktreeId}`,
      isYou: session.id === sessionId,
      editing: editing.get(session.id) ?? [],
    })),
    truncated: sessions.length > SESSION_LIST_MAX,
    summary: `${sessions.length} session(s) in this workspace.`,
  };
}

function foldName(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

async function notifyMember(tc: McpToolContext, args: unknown): Promise<JsonObject> {
  const { member, message, file_path } = parseArgs(notifyMemberArgsSchema, args);
  const { ctx, principal } = tc;
  const active = ctx.members.list().filter((record) => record.status === 'active');
  let matches = active.filter((record) => record.userId === member);
  if (matches.length === 0) matches = active.filter((record) => foldName(record.displayName) === foldName(member));
  if (matches.length === 0) {
    const names = active.map((record) => record.displayName).slice(0, 50).join(', ');
    throw new McpToolError('not_found', `No member called "${member}". Members: ${names}.`);
  }
  if (matches.length > 1) {
    throw new McpToolError('conflict', `Several members are called "${member}"; use one of their user ids: ${matches.map((record) => record.userId).join(', ')}.`);
  }
  const target = matches[0] as (typeof matches)[number];
  const file = file_path === undefined ? undefined : await resolveToolPath(tc, file_path);
  // Checked last: a refused call (bad name, bad path) does not use up the budget.
  if (!tc.notifyBucket.take()) throw new McpToolError('bad_request', 'Too many notifications from this session; wait a minute before sending another.');
  const notification = { from: principal.actor, text: message, ...(file ? { file } : {}) };
  if (!isStubService(ctx.services.activity)) {
    ctx.services.activity.notify(target.userId, notification);
  } else {
    // Until the activity module lands, deliver the same catalog message directly (ActivityFeed.notify's contract).
    ctx.hub.sendToUser(target.userId, 'activity.notify', { notification: { id: newId('ntf'), at: ctx.clock.now(), ...notification } });
  }
  ctx.log.info('agent notified a member', { session: tc.state.registration.sessionId, member: target.userId });
  const online = ctx.hub.isOnline(target.userId);
  return {
    delivered: true,
    member: { userId: target.userId, name: target.displayName },
    online,
    summary: online ? `${target.displayName} was notified.` : `${target.displayName} is offline right now; the notification reaches them only if their client resumes its connection.`,
  };
}

/** Runs one tool call for a registered session. Throws McpToolError for anything the agent should see. */
export async function runMcpTool(tc: McpToolContext, tool: McpToolName, args: unknown): Promise<JsonObject> {
  switch (tool) {
    case 'who_is_editing':
      return whoIsEditing(tc, args);
    case 'lock_status':
      return lockStatus(tc, args);
    case 'wait_for_lock':
      return waitForLock(tc, args);
    case 'list_sessions':
      return listSessions(tc, args);
    case 'notify_member':
      return notifyMember(tc, args);
  }
}
