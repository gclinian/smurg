// How a session is described in the panel: owner, kind, status, where it runs and whether it is sandboxed
// (SPEC R11 「狀態、擁有者、所在 worktree」, R5), plus the zh-TW explanation of a failed session request.
import { errorReasonOf, isSmurgError, type SessionInfo, type WorktreeInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';
import { worktreeLabel } from '../../lib/stores/worktrees.ts';
import { t } from './strings.ts';

/** 「終端機（王小明）」: the name, then the owner once. */
export function tabLabel(session: Pick<SessionInfo, 'title' | 'ownerName'>): string {
  return t('tab.label', { title: plainSessionTitle(session), owner: session.ownerName });
}

export function kindLabel(session: Pick<SessionInfo, 'kind'>): string {
  switch (session.kind) {
    case 'agent':
      return t('kind.agent');
    case 'login':
      return t('kind.login');
    case 'terminal':
      return t('kind.terminal');
  }
}

export function statusLabel(session: Pick<SessionInfo, 'status' | 'exitCode' | 'endReason' | 'endedBy'>): string {
  switch (session.status) {
    case 'starting':
      return t('status.starting');
    case 'running':
      return t('status.running');
    case 'exited':
      // Review WEB-12: a session the host terminated (or that ended because its owner was removed, left, lost the right
      // to run sessions, or the host stopped sharing) must not read like a normal exit.
      switch (session.endReason) {
        case 'terminated':
          return session.endedBy ? t('status.terminatedBy', { name: session.endedBy.displayName }) : t('status.terminated');
        case 'kicked':
          return t('status.kicked');
        case 'left':
          return t('status.left');
        case 'role-changed':
          return t('status.roleChanged');
        case 'stopped':
          return t('status.stopped');
        default:
          return session.exitCode === undefined ? t('status.exited') : t('status.exitedCode', { code: session.exitCode });
      }
  }
}

/**
 * 「主工作區」 or 「王小明的 worktree（加測試）」 (review WEB-18: not the branch id; `branchOf` gives it for a tooltip). The
 * id only when the worktree is not known to this client.
 */
export function whereLabel(session: Pick<SessionInfo, 'root' | 'title' | 'ownerName'>, worktrees: ReadonlyMap<string, WorktreeInfo>, selfUserId: string | null = null): string {
  if (session.root.kind === 'main') return t('where.main');
  const worktree = worktrees.get(session.root.worktreeId);
  return worktree ? worktreeLabel(worktree, { selfUserId, name: plainSessionTitle(session) }) : t('where.worktree', { branch: session.root.worktreeId });
}

/** The worktree's branch (for a tooltip), when the session runs in one this client knows. */
export function branchOf(session: Pick<SessionInfo, 'root'>, worktrees: ReadonlyMap<string, WorktreeInfo>): string | undefined {
  return session.root.kind === 'worktree' ? worktrees.get(session.root.worktreeId)?.branch : undefined;
}

export function sandboxLabel(session: Pick<SessionInfo, 'sandboxed'>): string {
  return session.sandboxed ? t('sandbox.on') : t('sandbox.off');
}

export function ownerLabel(session: Pick<SessionInfo, 'ownerName' | 'ownerUserId'>, selfUserId: string | null): string {
  return session.ownerUserId === selfUserId ? t('owner.you', { name: session.ownerName }) : session.ownerName;
}

/** What to do about the session module's refusals (`detail.reason`; the daemon's message says what happened). */
const REASON_HINTS: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  'session-limit': 'error.hint.limit',
  'claude-not-found': 'error.hint.claudeMissing',
  'hooks-unavailable': 'error.hint.hooks',
  'sessions-running': 'error.hint.sessionsRunning',
  'session-exited': 'error.hint.exited',
  'login-running': 'error.hint.loginRunning',
};

export interface SessionErrorView {
  readonly title: string;
  /** The daemon's own zh-TW message (actionable for sandbox refusals) or a generic one. */
  readonly message: string;
  /** What to do next, when we know more than the message says. */
  readonly hint?: string;
}

/**
 * A failed session.create (or another session request) in plain zh-TW. sandbox_unavailable carries the daemon's
 * actionable message (which component is missing and how to install it); it is shown as is, and the person is told
 * there is no unsandboxed fallback (R5).
 */
export function describeSessionError(error: unknown): SessionErrorView {
  if (isSmurgError(error)) {
    if (error.code === 'sandbox_unavailable') {
      const versionProblem = errorReasonOf(error) === 'claude-version';
      return {
        title: t('error.sandbox'),
        message: describeError(error),
        hint: versionProblem ? t('error.claudeVersion') : t('error.sandboxNoFallback'),
      };
    }
    // The host switched guest subscription logins off: the daemon's own sentence says so (ARCHITECTURE §11 D-12).
    if (error.code === 'forbidden' && errorReasonOf(error) === 'guest-subscription-login-off') {
      return { title: t('error.create'), message: describeError(error), hint: t('error.hint.loginOff') };
    }
    if (error.code === 'forbidden') return { title: t('error.create'), message: t('error.forbidden') };
    const hint = REASON_HINTS[errorReasonOf(error) ?? ''];
    if (hint !== undefined) return { title: t('error.create'), message: describeError(error), hint: t(hint) };
  }
  return { title: t('error.create'), message: describeError(error) };
}
