// What the daemon does with each Claude Code hook event (ARCHITECTURE §7.5 "Agent lock", §7.6, §7.7; claude-hooks.md
// §1.3). The HookServer has already mapped the token to a registered session; everything in `input` is still a
// CLAIM of a process inside that session (its agent can read its own token and forge events for its own session):
//  * a file path counts only after realpath (PathGuard.toFileRef) and only inside the session's root, and a lock is
//    requested only after PathGuard.resolve(forWrite) with the agent's principal accepted it;
//  * PreToolUse never returns "allow" (that would skip the owner's permission prompt): a granted lock returns no
//    output at all, a refusal a JSON deny whose reason (fixed English, deny-text.ts) names the holder;
//  * every failure while deciding a PreToolUse is a deny (fail closed).
import { isAbsolute, resolve as resolvePath, basename } from 'node:path';
import { SmurgError, fileRefKey, rootRefEquals, rootRefKey, type FileRef } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import { isPathDeniedError } from '../core/errors.ts';
import type { AgentLockResult, HookSessionRegistration, Principal } from '../core/interfaces.ts';
import { HOOK_DENY_REASONS, pathCheckFailedReason, pathDeniedReason } from './deny-text.ts';
import type { HookInput } from './schemas.ts';
import { BASH_TOOL_NAME, EDIT_TOOL_NAMES, preToolUseDeny, type JsonObject } from './wire.ts';

/** Per-session state the event handlers keep (owned by the HookServer's session entry). */
export interface HookSessionState {
  readonly registration: HookSessionRegistration;
  /** Agent locks this session was granted through PreToolUse and has not released yet (fileRefKey → file). */
  readonly held: Map<string, FileRef>;
  /** Bash commands of this session that started and have not finished (tool_use_id → start time), §11 D-13. */
  readonly bashOpen: Map<string, number>;
}

/** Bash commands one session may have open at once (Claude Code runs a few tool calls in parallel at most). */
export const BASH_OPEN_MAX = 8;
/** A Bash command without its PostToolUse is forgotten after this (Claude Code's longest Bash timeout, 10 minutes). */
export const BASH_OPEN_MAX_MS = 10 * 60_000;

/** A Bash tool event the Bash activity hook reports: PreToolUse / PostToolUse / PostToolUseFailure of `Bash`. */
export function isBashActivityEvent(input: HookInput): boolean {
  const event = input.hook_event_name;
  return input.tool_name === BASH_TOOL_NAME && (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure');
}

/**
 * A Bash command started or finished (§11 D-13). Only a time window is recorded, never a lock or a decision: the result
 * is always null (the Bash activity hook prints nothing anyway). The window is announced on the bus as
 * agent.tool.pre / agent.tool.post with tool 'Bash' and file null (granted = "the command runs"; no lock exists); the
 * activity module decides from those windows who wrote a change nobody announced. Pre and Post are paired by
 * tool_use_id, so a forged Post cannot close another command's window and a forged Pre opens at most BASH_OPEN_MAX.
 * The caller (HookServer) has applied the switch (config.activity.attributeBashEdits) and the per-session rate limit.
 */
export function handleBashEvent(ctx: DaemonContext, state: HookSessionState, input: HookInput): null {
  const session = state.registration;
  const id = input.tool_use_id;
  if (id === undefined || id.length === 0) return null;
  const now = ctx.clock.now();
  if (input.hook_event_name === 'PreToolUse') {
    for (const [openId, at] of state.bashOpen) if (now - at > BASH_OPEN_MAX_MS) state.bashOpen.delete(openId);
    if (state.bashOpen.has(id) || state.bashOpen.size >= BASH_OPEN_MAX) return null;
    state.bashOpen.set(id, now);
    ctx.bus.emit('agent.tool.pre', { sessionId: session.sessionId, ownerUserId: session.ownerUserId, tool: BASH_TOOL_NAME, file: null, outcome: 'granted' });
    return null;
  }
  if (!state.bashOpen.delete(id)) return null;
  ctx.bus.emit('agent.tool.post', { sessionId: session.sessionId, ownerUserId: session.ownerUserId, tool: BASH_TOOL_NAME, file: null, ok: input.hook_event_name === 'PostToolUse' });
  return null;
}

/** Ends every open Bash window of the session (the prompt was interrupted, the turn stopped, the session ended). */
export function closeBashWindows(ctx: DaemonContext, state: HookSessionState): void {
  const session = state.registration;
  const open = state.bashOpen.size;
  state.bashOpen.clear();
  for (let i = 0; i < open; i++) {
    ctx.bus.emit('agent.tool.post', { sessionId: session.sessionId, ownerUserId: session.ownerUserId, tool: BASH_TOOL_NAME, file: null, ok: false });
  }
}

export type LocateResult =
  | { readonly ok: true; readonly ref: FileRef }
  | { readonly ok: false; readonly why: 'no-target' | 'relative' | 'outside' | 'other-root'; readonly ref?: FileRef };

/**
 * Maps a path claimed by the session to a FileRef in the session's root: absolute (or relative to the claimed cwd,
 * which does not matter because the result must still lie in the session root), symlinks resolved (hook paths are
 * not realpath-resolved, and macOS /tmp is /private/tmp), then the most specific root must be the session's own.
 */
export async function locateInSessionRoot(ctx: DaemonContext, session: HookSessionRegistration, raw: string | undefined, cwd: string | undefined): Promise<LocateResult> {
  if (raw === undefined || raw.length === 0) return { ok: false, why: 'no-target' };
  const absolute = isAbsolute(raw) ? raw : cwd !== undefined && isAbsolute(cwd) ? resolvePath(cwd, raw) : null;
  if (absolute === null) return { ok: false, why: 'relative' };
  let ref: FileRef | null;
  try {
    ref = await ctx.paths.toFileRef(absolute);
  } catch {
    ref = null;
  }
  if (ref === null) return { ok: false, why: 'outside' };
  if (!rootRefEquals(ref.root, session.root)) return { ok: false, why: 'other-root', ref };
  return { ok: true, ref };
}

function targetOf(input: HookInput): string | undefined {
  return input.tool_input?.file_path ?? input.tool_input?.notebook_path;
}

function isEditTool(name: string | undefined): name is string {
  return name !== undefined && EDIT_TOOL_NAMES.includes(name);
}

/** Audits a hook path that is outside the session root (PathGuard audits its own refusals). */
function auditOutside(ctx: DaemonContext, principal: Principal, located: Extract<LocateResult, { ok: false }>, raw: string | undefined, tool: string): void {
  // Never an absolute host path in the audit log (errors.ts PathDeniedError.target): the root-relative path when the
  // target is in another root, else only the last segment.
  const target = located.ref ? `${rootRefKey(located.ref.root)}:${located.ref.path}` : `outside:${basename(raw ?? '').slice(0, 256)}`;
  ctx.audit.record({
    actor: principal.actor,
    action: 'path.denied',
    outcome: 'denied',
    target,
    detail: { reason: located.why === 'other-root' ? 'other-root' : 'outside-root', source: 'hook', tool, write: true },
  });
}

/** The outcome of a PreToolUse: the hook output, and the lock taken (so a late decision can be undone). */
export interface PreToolUseOutcome {
  readonly output: JsonObject | null;
  readonly granted: FileRef | null;
}

const deny = (reason: string): PreToolUseOutcome => ({ output: preToolUseDeny(reason), granted: null });

/**
 * "The session's next PreToolUse" releases what the session still holds: a permission prompt the owner rejected fires
 * no Post event (claude-hooks.md §8.2). The file asked for again (`keepKey`) is kept: requestAgent refreshes it.
 */
function releaseHeld(ctx: DaemonContext, state: HookSessionState, keepKey: string | null): void {
  for (const [heldKey, heldFile] of state.held) {
    if (heldKey === keepKey) continue;
    state.held.delete(heldKey);
    try {
      ctx.services.locks.releaseAgent(state.registration.sessionId, heldFile);
    } catch (err) {
      ctx.log.debug('agent lock release failed', { session: state.registration.sessionId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

export async function handlePreToolUse(ctx: DaemonContext, state: HookSessionState, principal: Principal, input: HookInput): Promise<PreToolUseOutcome> {
  const session = state.registration;
  const tool = input.tool_name;
  // The matcher only sends the edit tools; anything else takes no lock and gets no decision (normal permissions).
  if (!isEditTool(tool)) return { output: null, granted: null };
  const raw = targetOf(input);
  const located = await locateInSessionRoot(ctx, session, raw, input.cwd);
  if (!located.ok) {
    releaseHeld(ctx, state, null);
    if (located.why === 'no-target' || located.why === 'relative') return deny(HOOK_DENY_REASONS.noTarget);
    auditOutside(ctx, principal, located, raw, tool);
    return deny(located.why === 'other-root' ? HOOK_DENY_REASONS.otherRoot : HOOK_DENY_REASONS.outsideRoot);
  }
  let file: FileRef;
  try {
    // Host-only paths for members other than the host, the hidden .smurg, read-only shared dirs, special files, hard
    // links (audited): an agent is its owner (the member who opened the session).
    file = (await ctx.paths.resolve(located.ref, { principal, forWrite: true })).ref;
  } catch (err) {
    releaseHeld(ctx, state, null);
    if (isPathDeniedError(err)) return deny(pathDeniedReason(err.reason));
    if (err instanceof SmurgError) return deny(pathCheckFailedReason(err.code));
    ctx.log.warn('hook path check failed', { session: session.sessionId, error: err instanceof Error ? err.name : 'unknown' });
    return deny(HOOK_DENY_REASONS.locksUnavailable);
  }
  const key = fileRefKey(file);
  let result: AgentLockResult;
  try {
    releaseHeld(ctx, state, key);
    result = ctx.services.locks.requestAgent({ file, sessionId: session.sessionId, ownerUserId: session.ownerUserId, agentName: session.agentName, sessionRoot: session.root });
  } catch (err) {
    ctx.log.warn('agent lock request failed', { session: session.sessionId, error: err instanceof Error ? err.name : 'unknown' });
    return deny(HOOK_DENY_REASONS.locksUnavailable);
  }
  if (result.granted) {
    state.held.set(key, file);
    ctx.bus.emit('agent.tool.pre', { sessionId: session.sessionId, ownerUserId: session.ownerUserId, tool, file, outcome: 'granted' });
    try {
      // Attribute the upcoming disk change to the agent (tree badge, activity). The edit runs after the owner's
      // permission prompt, so the window is the lock's TTL.
      ctx.services.files.expectChange(file, principal.actor, ctx.settings.get().agentLockTimeoutMs);
    } catch {
      // best effort (the file service may not be there)
    }
    return { output: null, granted: file };
  }
  state.held.delete(key);
  ctx.bus.emit('agent.tool.pre', {
    sessionId: session.sessionId,
    ownerUserId: session.ownerUserId,
    tool,
    file,
    outcome: 'denied',
    ...(result.holder ? { holder: result.holder } : {}),
  });
  return deny(result.reason);
}

/** Releases one lock of the session (or its current one when the file cannot be located), never throws. */
function releaseOne(ctx: DaemonContext, state: HookSessionState, file: FileRef | null): void {
  const sessionId = state.registration.sessionId;
  try {
    if (file !== null) {
      ctx.services.locks.releaseAgent(sessionId, file);
      state.held.delete(fileRefKey(file));
    } else {
      ctx.services.locks.releaseAgent(sessionId);
      state.held.clear();
    }
  } catch (err) {
    ctx.log.debug('agent lock release failed', { session: sessionId, error: err instanceof Error ? err.name : 'unknown' });
  }
}

export function releaseAllForSession(ctx: DaemonContext, state: HookSessionState, reason: 'prompt' | 'stop' | 'session-ended'): void {
  state.held.clear();
  try {
    ctx.services.locks.releaseAllForSession(state.registration.sessionId, reason);
  } catch (err) {
    ctx.log.debug('agent lock release failed', { session: state.registration.sessionId, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/**
 * Every event other than PreToolUse. None of them returns a decision (null ⇒ the hook prints nothing): they only
 * release locks and feed the bus (activity feed, lock state).
 */
export async function handleOtherEvent(ctx: DaemonContext, state: HookSessionState, input: HookInput): Promise<null> {
  const session = state.registration;
  const event = input.hook_event_name;
  switch (event) {
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied': {
      if (!isEditTool(input.tool_name)) return null;
      const located = await locateInSessionRoot(ctx, session, targetOf(input), input.cwd);
      const file = located.ok ? located.ref : null;
      releaseOne(ctx, state, file);
      if (event !== 'PermissionDenied') {
        ctx.bus.emit('agent.tool.post', { sessionId: session.sessionId, ownerUserId: session.ownerUserId, tool: input.tool_name, file, ok: event === 'PostToolUse' });
      }
      return null;
    }
    case 'PermissionRequest': {
      if (!isEditTool(input.tool_name)) return null;
      const located = await locateInSessionRoot(ctx, session, targetOf(input), input.cwd);
      if (!located.ok) return null;
      try {
        ctx.services.locks.markAwaitingApproval(session.sessionId, located.ref);
      } catch {
        // informational only; the TTL still applies
      }
      return null;
    }
    case 'UserPromptSubmit':
      // The first event after the owner REJECTS a permission prompt (no Post event, no Stop): release here. A Bash
      // command the owner interrupted fires no PostToolUse either: its window ends too.
      releaseAllForSession(ctx, state, 'prompt');
      closeBashWindows(ctx, state);
      return null;
    case 'Stop':
      releaseAllForSession(ctx, state, 'stop');
      closeBashWindows(ctx, state);
      return null;
    case 'SessionEnd':
      releaseAllForSession(ctx, state, 'session-ended');
      closeBashWindows(ctx, state);
      return null;
    case 'FileChanged': {
      const change = input.event;
      if (change !== 'add' && change !== 'change' && change !== 'unlink') return null;
      const located = await locateInSessionRoot(ctx, session, input.file_path, input.cwd);
      if (!located.ok) return null;
      ctx.bus.emit('agent.file-changed', { sessionId: session.sessionId, ownerUserId: session.ownerUserId, file: located.ref, change });
      return null;
    }
    case 'SessionStart':
      // No bus event exists for it (DaemonEvents); liveness is the session manager's PTY.
      ctx.log.debug('agent session started', { session: session.sessionId, source: input.source ?? null });
      return null;
    default:
      return null;
  }
}
