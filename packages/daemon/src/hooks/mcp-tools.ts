// Daemon side of the tools of smurg's own MCP server (ARCHITECTURE §7.7 op 'mcp'; SPEC R8). The stdio server Claude
// Code runs (../mcp/coord-server.ts) only forwards calls here with the session's token; the daemon answers:
//  - the coordination tools of every agent session from the LockManager, the SessionManager and the member directory
//    (notify_member is delivered as `activity.notify` to that member only, and stored as a mention in their inbox);
//  - the tools of a topic's sessions through the contracts of core/interfaces.ts: `check_plan` and `propose_split`
//    (PlanService) for the discussion session, `check_report` (ReportService) for a work item's session.
//
// WHO calls is known from the session's token (the registration the hook server holds), never from an argument: the
// session, its purpose, its topic and item make the McpToolContext of every call. A tool called from the wrong kind
// of session answers with one sentence saying so.
//
// The answers are read by the agent, so they are structured JSON with a one-line English `summary`, in fixed
// English; people's names go through `agentSafeName`. Paths are accepted absolute or relative to the session root,
// and only inside it (PathGuard with the agent's principal: the hidden .smurg stays hidden). Everything a session
// asks is bounded: waits end at the session's end, the daemon's stop or the caller's disconnect; notifications are
// rate-limited per session (`ctx.rates`, bucket `agent-notify`).
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { INBOX_EXCERPT_MAX_CHARS, SmurgError, agentSafeName, agentText, defaultSessionTitle, mask, rootRefKey, rootRefEquals, type FileRef, type LockInfo, type SessionInfo } from '@smurg/protocol';
import { z } from 'zod';
import type { DaemonContext } from '../core/context.ts';
import { isPathDeniedError } from '../core/errors.ts';
import type { HookSessionRegistration, McpToolContext, Principal } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import { PROPOSE_SPLIT_ITEMS_MAX, PROPOSE_SPLIT_REASON_MAX_CHARS, type AgentToolName } from '../mcp/tools.ts';
import { locateInSessionRoot } from './hook-events.ts';
import {
  listSessionsArgsSchema,
  lockStatusArgsSchema,
  notifyMemberArgsSchema,
  waitForLockArgsSchema,
  whoIsEditingArgsSchema,
} from './schemas.ts';
import { WAIT_FOR_LOCK_DEFAULT_SECONDS, type JsonObject } from './wire.ts';

/** A refusal the agent should see (code of ARCHITECTURE §4.3, English message). */
export class McpToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

/** One tool call as the hook server hands it over: the daemon, the session the token named, and its agent's principal. */
export interface McpCall {
  readonly ctx: DaemonContext;
  /** The session the token named (the hook server's entry; only its registration is read here). */
  readonly state: { readonly registration: HookSessionRegistration };
  readonly principal: Principal;
  /** Aborted when the caller disconnects, the session is unregistered or the daemon stops. */
  readonly signal: AbortSignal;
  /** Not read any more: the notify_member budget is `ctx.rates` (`agent-notify`, per session). */
  readonly notifyBucket?: unknown;
}

/** Who calls, for the services (core/interfaces.ts McpToolContext): from the registration, never from an argument. */
export function toolContextOf(call: Pick<McpCall, 'state' | 'principal'>): McpToolContext {
  const registration = call.state.registration;
  return {
    sessionId: registration.sessionId,
    purpose: registration.purpose,
    ...(registration.topic === undefined ? {} : { topic: { id: registration.topic.id, slug: registration.topic.slug } }),
    ...(registration.itemId === undefined ? {} : { itemId: registration.itemId }),
    root: registration.root,
    agent: call.principal.actor,
  };
}

/** The one sentence a tool of a topic's sessions answers from another kind of session. */
export const WRONG_SESSION = Object.freeze({
  discussion: 'This tool is for the discussion session of a topic. This session is not one.',
  item: 'This tool is for the session of a work item. This session is not one.',
} as const);

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
async function resolveToolPath(tc: McpCall, raw: string): Promise<FileRef> {
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
      holders: lock.holders.map((holder) => ({ name: agentSafeName(holder.displayName, holder.userId), userId: holder.userId, lastActiveAt: iso(holder.lastActivityAt) })),
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
    const names = lock.holders.map((holder) => agentSafeName(holder.displayName, holder.userId)).join(', ');
    return `${path} is being edited by ${names} (a human edit lock). Do not edit it now: work on another file, or call wait_for_lock.`;
  }
  if (lock.sessionId === sessionId) return `${path} is locked by you (this session's pending edit).`;
  return `${path} is being modified by ${lock.agentName} (another agent). Do not edit it now: work on another file, or call wait_for_lock.`;
}

async function whoIsEditing(tc: McpCall, args: unknown): Promise<JsonObject> {
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
    humans: info.humans.map((human) => ({ name: agentSafeName(human.displayName, human.userId), userId: human.userId, lastActiveAt: iso(human.lastActivityAt) })),
    agent: info.agent === null ? null : describeLock(info.agent, sessionId),
    summary: lockSummary(file.path, lock, sessionId),
  };
}

async function lockStatus(tc: McpCall, args: unknown): Promise<JsonObject> {
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

async function waitForLock(tc: McpCall, args: unknown): Promise<JsonObject> {
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

/** A session's name for a model: what a person typed (cleaned), else the fixed English default of its kind. */
function sessionLabel(session: SessionInfo): string {
  if (session.title !== undefined) return agentText(session.title).text;
  const owner = agentSafeName(session.openedBy.displayName, session.openedBy.userId);
  if (session.kind === 'agent' && session.purpose === 'discussion') return 'Discussion';
  if (session.kind === 'agent' && session.purpose === 'item' && session.item !== undefined && session.itemId !== undefined) return `Work item ${session.item.number}: ${agentSafeName(session.item.title, session.itemId)}`;
  return defaultSessionTitle(session.kind, owner);
}

function listSessions(tc: McpCall, args: unknown): JsonObject {
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
      owner: agentSafeName(session.openedBy.displayName, session.openedBy.userId),
      ownerUserId: session.openedBy.userId,
      title: sessionLabel(session),
      // A topic's session also names its topic and, for a work item, the item.
      ...(session.kind === 'agent' && session.topicId !== undefined && session.topicName !== undefined ? { topic: agentSafeName(session.topicName, session.topicId) } : {}),
      ...(session.kind === 'agent' && session.itemId !== undefined && session.item !== undefined ? { item: { id: session.itemId, number: session.item.number, title: agentSafeName(session.item.title, session.itemId) } } : {}),
      ...(session.kind === 'agent' ? { purpose: session.purpose } : {}),
      status: session.status,
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

/**
 * notify_member: a toast for one member, and a mention in their inbox (so it is still there when they were away).
 * The member is named by user id, by display name, or by the safe name the agent was given for them.
 */
async function notifyMember(tc: McpCall, args: unknown): Promise<JsonObject> {
  const { member, message, file_path } = parseArgs(notifyMemberArgsSchema, args);
  const { ctx, principal } = tc;
  const sessionId = tc.state.registration.sessionId;
  const active = ctx.members.list().filter((record) => record.status === 'active');
  const safe = (record: (typeof active)[number]): string => agentSafeName(record.displayName, record.userId);
  let matches = active.filter((record) => record.userId === member);
  if (matches.length === 0) matches = active.filter((record) => foldName(record.displayName) === foldName(member) || foldName(safe(record)) === foldName(member));
  if (matches.length === 0) {
    const names = active.map(safe).slice(0, 50).join(', ');
    throw new McpToolError('not_found', `No member has that name. Members: ${names}.`);
  }
  if (matches.length > 1) {
    throw new McpToolError('conflict', `Several members have that name; use one of their user ids: ${matches.map((record) => record.userId).join(', ')}.`);
  }
  const target = matches[0] as (typeof matches)[number];
  const name = safe(target);
  const file = file_path === undefined ? undefined : await resolveToolPath(tc, file_path);
  // Checked last: a refused call (bad name, bad path) does not use up the budget.
  if (!ctx.rates.take('agent-notify', sessionId)) throw new McpToolError('rate_limited', 'Too many notifications from this session; wait a minute before sending another.');
  // An agent's own words for a person: masked like every text of an agent before it is stored or sent (it may repeat
  // a credential it read to a member who could never open that file).
  const text = mask(message);
  const notification = { from: principal.actor, text, ...(file ? { file } : {}) };
  if (!isStubService(ctx.services.activity)) {
    ctx.services.activity.notify(target.userId, notification);
  } else {
    // Without the activity module, deliver the same message directly (ActivityFeed.notify's contract).
    ctx.hub.sendToUser(target.userId, 'activity.notify', { notification: { id: newId('ntf'), at: ctx.clock.now(), ...notification } });
  }
  // The same notification as a mention from this agent, kept in the member's inbox until they open it.
  let inbox: 'stored' | 'full' | 'unavailable' = 'unavailable';
  if (!isStubService(ctx.services.inbox)) {
    try {
      inbox = ctx.services.inbox.addMention({ userId: target.userId, from: principal.actor, target: { kind: 'session', sessionId }, excerpt: text.slice(0, INBOX_EXCERPT_MAX_CHARS) });
    } catch (err) {
      ctx.log.warn('mention not stored', { session: sessionId, member: target.userId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  ctx.log.info('agent notified a member', { session: sessionId, member: target.userId });
  const online = ctx.hub.isOnline(target.userId);
  const delivered = online ? `${name} was notified.` : `${name} is offline right now; the notification reaches them only if their client resumes its connection.`;
  // A full inbox is the agent's to know: nobody else is told.
  const stored = inbox === 'stored' ? ' It is also in their inbox.' : inbox === 'full' ? ` Their inbox is full, so it was not stored there: ${name} sees it only if they are looking now.` : '';
  return { delivered: true, member: { userId: target.userId, name }, online, inbox, summary: `${delivered}${stored}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tools of a topic's sessions
// ---------------------------------------------------------------------------------------------------------------------

const noArgsSchema = z.strictObject({});
const proposeSplitArgsSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.string().min(1).max(64), person: z.string().min(1).max(256) })).max(PROPOSE_SPLIT_ITEMS_MAX),
  reason: z.string().max(PROPOSE_SPLIT_REASON_MAX_CHARS).optional(),
});

/**
 * The file checks of the contract are synchronous, but a real service must first read the file (through PathGuard,
 * asynchronously): one that has `prepareCheck` is given the chance. A fake has none and answers at once.
 */
async function prepare(service: object, context: McpToolContext): Promise<void> {
  const prepareCheck = (service as { prepareCheck?: unknown }).prepareCheck;
  if (typeof prepareCheck === 'function') await (prepareCheck as (this: object, context: McpToolContext) => Promise<void>).call(service, context);
}

function problems(count: number, tool: string): string {
  return `${count} ${count === 1 ? 'problem' : 'problems'}. Fix exactly what is reported and call ${tool} again.`;
}

async function checkPlan(tc: McpCall, args: unknown): Promise<JsonObject> {
  parseArgs(noArgsSchema, args);
  const context = toolContextOf(tc);
  if (context.purpose !== 'discussion') return { ok: false, errors: [{ message: WRONG_SESSION.discussion }], summary: WRONG_SESSION.discussion };
  const plans = tc.ctx.services.plans;
  if (isStubService(plans)) throw new McpToolError('internal', 'Plans are not available right now. Try again later.');
  let result: ReturnType<typeof plans.checkPlan>;
  try {
    await prepare(plans, context);
    result = plans.checkPlan(context);
  } catch (err) {
    throw unavailable('The plan check', err);
  }
  if (!result.ok) return { ok: false, errors: result.errors.map((error) => ({ ...error })), summary: problems(result.errors.length, 'check_plan') };
  return {
    ok: true,
    items: result.items,
    warnings: [...result.warnings],
    summary: `ok: smurg reads ${result.items} work ${result.items === 1 ? 'item' : 'items'}${result.warnings.length === 0 ? '' : `, with ${result.warnings.length} ${result.warnings.length === 1 ? 'warning' : 'warnings'}`}. Now call propose_split.`,
  };
}

async function proposeSplit(tc: McpCall, args: unknown): Promise<JsonObject> {
  const input = parseArgs(proposeSplitArgsSchema, args);
  const context = toolContextOf(tc);
  if (context.purpose !== 'discussion') throw new McpToolError('conflict', WRONG_SESSION.discussion);
  const plans = tc.ctx.services.plans;
  if (isStubService(plans)) throw new McpToolError('internal', 'Plans are not available right now. Try again later.');
  try {
    await prepare(plans, context);
    const result = plans.recordSplit(context, { items: input.items, reason: input.reason ?? '' });
    return {
      ...result,
      summary:
        `${result.assigned} work ${result.assigned === 1 ? 'item was' : 'items were'} assigned as you proposed` +
        (result.unknownPeople === 0 ? '.' : `; ${result.unknownPeople} ${result.unknownPeople === 1 ? 'pair names' : 'pairs name'} a person smurg does not know and ${result.unknownPeople === 1 ? 'was' : 'were'} dropped.`) +
        ' smurg splits the remaining items evenly; people can change it.',
    };
  } catch (err) {
    const reason = err instanceof SmurgError ? err.detail?.['reason'] : undefined;
    if (reason === 'not-a-discussion') throw new McpToolError('conflict', WRONG_SESSION.discussion);
    if (reason === 'no-plan') throw new McpToolError('conflict', 'There is no plan that passes yet. Write PLAN.md, call check_plan until it answers ok, then call propose_split.');
    throw unavailable('The split', err);
  }
}

async function checkReport(tc: McpCall, args: unknown): Promise<JsonObject> {
  parseArgs(noArgsSchema, args);
  const context = toolContextOf(tc);
  if (context.purpose !== 'item') return { ok: false, errors: [{ message: WRONG_SESSION.item }], summary: WRONG_SESSION.item };
  const reports = tc.ctx.services.reports;
  if (isStubService(reports)) throw new McpToolError('internal', 'Reports are not available right now. Try again later.');
  let result: ReturnType<typeof reports.checkReport>;
  try {
    await prepare(reports, context);
    result = reports.checkReport(context);
  } catch (err) {
    throw unavailable('The report check', err);
  }
  if (!result.ok) return { ok: false, errors: result.errors.map((error) => ({ ...error })), summary: problems(result.errors.length, 'check_report') };
  return { ok: true, summary: 'ok: smurg registers the report with exactly this content when you stop. If you change the file, call check_report again.' };
}

/** Runs one tool call for a registered session. Throws McpToolError for anything the agent should see. */
export async function runMcpTool(tc: McpCall, tool: AgentToolName, args: unknown): Promise<JsonObject> {
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
    case 'check_plan':
      return checkPlan(tc, args);
    case 'propose_split':
      return proposeSplit(tc, args);
    case 'check_report':
      return checkReport(tc, args);
  }
}
