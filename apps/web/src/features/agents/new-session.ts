// What the "New session" dialog offers, per role (ARCHITECTURE §3, §5.5) — pure, so it is tested without React.
// Protocol v2 (owner decision 2026-10-01): every session runs as the HOST — the host's computer, the host's Claude
// account, no sandbox — whoever opens it:
//   host, agent access → may open one (session.create), in the main workspace or a worktree;
//   editor / viewer → no session; the dialog says why.
// Worktrees (R9) need a git repository; a kept worktree of one's own can be continued (R9.4). The daemon enforces all
// of this again.
import type { PayloadInputOf, Role, SessionInfo, WorkspaceInfo, WorktreeInfo } from '@smurg/protocol';
import { canRole } from '../../lib/capabilities.ts';

export type SessionKind = 'agent' | 'terminal';

export type CreateBlockReason = 'role-editor' | 'role-viewer' | 'not-admitted';

export interface NewSessionOptions {
  readonly canCreate: boolean;
  readonly blockedBy: CreateBlockReason | null;
  readonly worktree: {
    readonly available: boolean;
    readonly unavailableReason: 'not-git' | null;
    /** The member's own kept worktrees that no running session uses, newest first. */
    readonly kept: readonly WorktreeInfo[];
  };
}

export function newSessionOptions(input: {
  readonly role: Role | null;
  readonly userId: string | null;
  readonly workspace: WorkspaceInfo | null;
  readonly worktrees: readonly WorktreeInfo[];
  readonly sessions: ReadonlyMap<string, SessionInfo>;
}): NewSessionOptions {
  const { role, userId, workspace } = input;
  const isGit = workspace?.isGitRepo === true;
  const canCreate = canRole(role, 'session.create') && userId !== null;
  const blockedBy: CreateBlockReason | null = canCreate ? null : role === 'editor' ? 'role-editor' : role === 'viewer' ? 'role-viewer' : 'not-admitted';
  const kept = isGit
    ? input.worktrees
        .filter((worktree) => {
          if (worktree.ownerUserId !== userId || !worktree.kept) return false;
          if (worktree.sessionId === undefined) return true;
          const using = input.sessions.get(worktree.sessionId);
          return using === undefined || using.status === 'exited';
        })
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  return {
    canCreate,
    blockedBy,
    worktree: { available: isGit, unavailableReason: isGit ? null : 'not-git', kept },
  };
}

/** 'main' | 'worktree:new' | 'worktree:<id>' — the value of the "Where to work" choice. */
export type WhereChoice = 'main' | 'worktree:new' | `worktree:${string}`;

/** `where` if the options still offer it (the worktree list may change while the dialog is open), else the main workspace. */
export function effectiveWhere(options: NewSessionOptions, where: WhereChoice): WhereChoice {
  if (where === 'main' || !options.worktree.available) return 'main';
  if (where === 'worktree:new' || options.worktree.kept.some((worktree) => where === `worktree:${worktree.id}`)) return where;
  return 'main';
}

export interface NewSessionForm {
  readonly kind: SessionKind;
  readonly where: WhereChoice;
  readonly title: string;
}

/** The session.create payload for `form` (the size is the viewer's best guess; the owner's viewport corrects it). */
export function buildCreatePayload(
  options: NewSessionOptions,
  form: NewSessionForm,
  size: { readonly cols: number; readonly rows: number },
): PayloadInputOf<'session.create'> {
  const where = effectiveWhere(options, form.where);
  let workspace: PayloadInputOf<'session.create'>['workspace'] = { mode: 'main' };
  if (where !== 'main') {
    const id = where.slice('worktree:'.length);
    workspace = id === 'new' ? { mode: 'worktree' } : { mode: 'worktree', worktreeId: id };
  }
  const title = form.title.trim();
  return {
    kind: form.kind,
    workspace,
    cols: size.cols,
    rows: size.rows,
    ...(title !== '' ? { title } : {}),
  };
}

/**
 * A sensible PTY size before any viewer measured one: the owner's panel replaces it as soon as the session's terminal
 * attaches (terminal-fit.ts).
 */
export const DEFAULT_TERMINAL_SIZE = Object.freeze({ cols: 100, rows: 30 });
