// How a session is described in the panel: who opened it, kind, status, where it runs (SPEC R11 「狀態、擁有者、所在
// worktree」), plus the zh-TW explanation of a failed session request. Every session runs as the host (protocol v2):
// the person shown is the one who OPENED it.
import { errorReasonOf, isSmurgError, type LoginState, type SessionInfo, type WorktreeInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';
import { worktreeLabel } from '../../lib/stores/worktrees.ts';
import { t } from './strings.ts';

/** 「Claude（Amy 開的）」: the name, then who opened it, once. */
export function tabLabel(session: Pick<SessionInfo, 'title' | 'ownerName'>): string {
  return t('tab.label', { title: plainSessionTitle(session), owner: session.ownerName });
}

export function kindLabel(session: Pick<SessionInfo, 'kind'>): string {
  switch (session.kind) {
    case 'agent':
      return t('kind.agent');
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
      // Review WEB-12: a session the host terminated (or that ended because the person who opened it was removed,
      // left, lost the right to open sessions, or the host stopped sharing) must not read like a normal exit.
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

/** 「Amy 開的」, or 「你開的」 for the member's own. */
export function openedByLabel(session: Pick<SessionInfo, 'ownerName' | 'ownerUserId'>, selfUserId: string | null): string {
  return session.ownerUserId === selfUserId ? t('owner.you') : t('owner.other', { name: session.ownerName });
}

/** What a re-check of the login says, against the session.login value it was made for. */
export interface LoginCheck {
  readonly login: LoginState;
  /** The session.login value the check was made against (a newer value from the daemon wins). */
  readonly against: LoginState;
}

/** What the panel shows: the latest re-check when the daemon has not reported anything newer since. */
export function effectiveLogin(session: Pick<SessionInfo, 'login'>, check: LoginCheck | null): LoginState {
  return check !== null && check.against === session.login ? check.login : session.login;
}

/** What to do about the session module's refusals (`detail.reason`; the daemon's message says what happened). */
const REASON_HINTS: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  'session-limit': 'error.hint.limit',
  'claude-not-found': 'error.hint.claudeMissing',
  'hooks-unavailable': 'error.hint.hooks',
  'session-exited': 'error.hint.exited',
};

export interface SessionErrorView {
  readonly title: string;
  /** The daemon's own zh-TW message or a generic one. */
  readonly message: string;
  /** What to do next, when we know more than the message says. */
  readonly hint?: string;
}

/** A failed session.create (or another session request) in plain zh-TW. */
export function describeSessionError(error: unknown): SessionErrorView {
  if (isSmurgError(error)) {
    if (error.code === 'forbidden') return { title: t('error.create'), message: t('error.forbidden') };
    const hint = REASON_HINTS[errorReasonOf(error) ?? ''];
    if (hint !== undefined) return { title: t('error.create'), message: describeError(error), hint: t(hint) };
  }
  return { title: t('error.create'), message: describeError(error) };
}
