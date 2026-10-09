// What the "New session" / "New terminal" dialog offers, per role (ARCHITECTURE §3, §5.5): pure, so it is tested
// without React. Every session runs as the HOST (the host's computer, the host's Claude account, no sandbox),
// whoever opens it:
//   host, agent access → may open one (session.create), in the main workspace or a worktree;
//   editor / viewer → no session; the dialog says why.
// Worktrees (R9) need a git repository; a kept worktree of one's own can be continued (R9.4). The daemon enforces all
// of this again.
//
// Whether the folder is a git repository is `WorkspaceInfo.isGitRepo`, which follows the folder while it is shared
// (the Welcome, then every topic.updated: lib/stores/workspace.ts). No event tells a workspace without a topic, so a
// new worktree is offered either way, with the reason as a note while the page believes the folder is none: the
// host's daemon looks at the folder again before it answers, and the page learns from that answer (a session opened
// in a worktree, or a refusal that names what a repository lacks: `opensInWorktree`, `refusalNamesRepository`). Why a
// repository cannot hold a worktree (no commit yet, git missing or too old, a `.git` that is no ordinary folder) only
// the host knows: its refusal of session.create says so, in the same words as the Start dialog, and while the dialog
// shows such a refusal the page's own note is not shown beside it (`isWorktreeRefusal`).
import { isSmurgError, type MessageRef, type PayloadInputOf, type Role, type SessionInfo, type WorkspaceInfo, type WorktreeInfo } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { canRole } from '../../lib/capabilities.ts';
import { renderWireText } from '../../lib/errors.ts';

export type SessionKind = 'agent' | 'terminal';

export type CreateBlockReason = 'role-editor' | 'role-viewer' | 'not-admitted';

export interface NewSessionOptions {
  readonly canCreate: boolean;
  readonly blockedBy: CreateBlockReason | null;
  readonly worktree: {
    /** The folder is a git repository as far as this page knows (a new worktree is offered either way). */
    readonly available: boolean;
    /**
     * Why the page believes worktrees cannot be used: a note under the choices, which says to run `git init`. Never
     * while a worktree or an open merge request exists: the folder is then a repository the page has not heard of
     * yet, or one whose `.git` went, and `git init` is wrong for both (the host's refusal says "put it back" for the
     * second).
     */
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
  /** A worktree or an open merge request exists (lib/stores/worktrees.ts selectHasWorktreeRecords). Default: `worktrees` has one. */
  readonly records?: boolean;
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
    worktree: { available: isGit, unavailableReason: isGit || (input.records ?? input.worktrees.length > 0) ? null : 'not-git', kept },
  };
}

const UNAVAILABLE: Readonly<Record<NonNullable<NewSessionOptions['worktree']['unavailableReason']>, MessageRef>> = {
  'not-git': msg('worktree.unavailable.notAGitRepo'),
};

/**
 * Why the worktree choices are off, in the viewer's language: the host's own sentence for the reason (the Start
 * dialog's blocker, a worktree refusal), saying what the host can do.
 */
export function worktreeUnavailableNote(reason: NonNullable<NewSessionOptions['worktree']['unavailableReason']>): string {
  const ref = UNAVAILABLE[reason];
  return renderWireText(ref, renderEnglish(ref));
}

/** A session the host opened in a worktree: the shared folder is a git repository. */
export function opensInWorktree(session: Pick<SessionInfo, 'root'>): boolean {
  return session.root.kind === 'worktree';
}

/** The refusals that name what a REPOSITORY lacks: a first commit, a `.git` that is an ordinary folder, the worktrees folder. */
const NAMES_A_REPOSITORY: ReadonlySet<string> = new Set([
  'worktree.unavailable.noCommit',
  'worktree.unavailable.gitDirNotDirectory',
  'worktree.unavailable.worktreesDirUnusable',
]);

/**
 * A refusal of the host that says the shared folder is a git repository: it names what the repository lacks (no
 * commit yet, a `.git` that is no ordinary folder, the worktrees folder). The page then stops saying "run git init".
 * Every other reason says nothing about the folder, and the page keeps what it believed: git itself (not found, too
 * old, not running) is named first whatever the folder is, a look that failed and a host that is still starting did
 * not see the folder, and "not a git repository" and "the .git is gone" say it is none. The next Welcome or
 * topic.updated says what the folder is.
 */
export function refusalNamesRepository(failure: unknown): boolean {
  if (!isSmurgError(failure)) return false;
  const id = failure.text?.id;
  return id !== undefined && NAMES_A_REPOSITORY.has(id);
}

/**
 * A refusal of the host about worktrees (any `worktree.unavailable.*`): its sentence says why and what the host can
 * do. While the dialog shows it, the page's own note is not shown beside it: one sentence on screen, the host's (the
 * note may say "run git init" where the host says git itself is missing, or the same words a second time).
 */
export function isWorktreeRefusal(failure: unknown): boolean {
  return isSmurgError(failure) && failure.text?.id.startsWith('worktree.unavailable.') === true;
}

/** 'main' | 'worktree:new' | 'worktree:<id>' — the value of the "Where to work" choice. */
export type WhereChoice = 'main' | 'worktree:new' | `worktree:${string}`;

/** `where` if the options still offer it (the worktree list may change while the dialog is open), else the main workspace. */
export function effectiveWhere(options: NewSessionOptions, where: WhereChoice): WhereChoice {
  if (where === 'main' || where === 'worktree:new') return where;
  return options.worktree.kept.some((worktree) => where === `worktree:${worktree.id}`) ? where : 'main';
}

export interface NewSessionForm {
  readonly kind: SessionKind;
  readonly where: WhereChoice;
  readonly title: string;
  /** An agent session: what it should do first (optional; a terminal has none). */
  readonly firstMessage?: string;
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
  // An agent session is a conversation (protocol 4): it has no PTY size. Its first message, when there is one, is
  // sent as the member wrote it (the daemon cleans it); a blank one is none.
  if (form.kind === 'agent') {
    const first = form.firstMessage ?? '';
    return { kind: 'agent', workspace, ...(title !== '' ? { title } : {}), ...(first.trim() !== '' ? { firstMessage: first } : {}) };
  }
  return {
    kind: 'terminal',
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
