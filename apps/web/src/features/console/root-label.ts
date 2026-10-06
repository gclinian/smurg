// How the console names a root: the main workspace, or whose worktree it is and what for (never its branch id).
import type { RootRef, SessionInfo, WorktreeInfo } from '@smurg/protocol';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';
import { worktreeLabel } from '../../lib/stores/worktrees.ts';
import { t } from './strings.ts';

export interface RootLabelContext {
  readonly worktrees: ReadonlyMap<string, WorktreeInfo>;
  readonly sessions?: ReadonlyMap<string, SessionInfo>;
  readonly selfUserId?: string | null;
}

export function rootLabel(root: RootRef, ctx: RootLabelContext): string {
  if (root.kind === 'main') return t('sessions.where.main');
  const worktree = ctx.worktrees.get(root.worktreeId);
  if (!worktree) return t('sessions.where.worktreeGone');
  return worktreeLabel(worktree, { selfUserId: ctx.selfUserId ?? null, ...(ctx.sessions === undefined ? {} : { sessions: ctx.sessions }) });
}

/** Where a session runs: the same wording, named after the session itself when it works in a worktree. */
export function whereLabel(session: SessionInfo, worktrees: ReadonlyMap<string, WorktreeInfo>, selfUserId: string | null = null): string {
  if (session.root.kind === 'main') return t('sessions.where.main');
  const worktree = worktrees.get(session.root.worktreeId);
  return worktree ? worktreeLabel(worktree, { selfUserId, name: plainSessionTitle(session) }) : t('sessions.where.worktreeGone');
}
