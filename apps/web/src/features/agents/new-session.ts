// What the "New session" / "New terminal" dialog offers, per role (ARCHITECTURE §3, §5.5): pure, so it is tested
// without React. Every session runs as the HOST (the host's computer, the host's Claude account, no sandbox),
// whoever opens it:
//   host, agent access → may open one (session.create), in the main workspace or a worktree;
//   editor / viewer → no session; the dialog says why.
// An agent session also gets a model (the host's default unless one is chosen) and a permission mode (it follows the
// workspace unless one is chosen): DESIGN 0.6.0 D18. The daemon enforces all of this again.
//
// Worktrees (R9) come from the shared folder's own git repository, or, when the folder has no `.git`, from smurg's
// own history of it (protocol 5, DESIGN 0.6.0 D14). How work items run here is `HostState.work.history`, which the
// host's smurg keeps current (the `session.host` event):
//   folder, smurg   → new worktrees are offered (a repository without a commit yet, say, is the host's refusal);
//   direct          → none: the git program cannot be used on the host's computer; its sentence is the note;
//   unchecked       → the host's smurg has not looked for git yet. The host is offered a worktree (the answer settles
//                     it); a teammate is not: a teammate's request never makes the host's smurg run git for the first
//                     time (on a Mac without the developer tools that puts a prompt on the host's screen), and the
//                     note says when it can be asked.
// A kept worktree of one's own can be continued (R9.4) unless git cannot be used at all. Why a repository cannot hold
// a worktree (no commit yet, a `.git` that is no ordinary folder) only the host knows: its refusal of session.create
// says so, in the same words as the Start dialog, and while the dialog shows such a refusal the page's own note is not
// shown beside it (`isWorktreeRefusal`).
import { isSmurgError, type MessageRef, type PayloadInputOf, type Role, type SessionInfo, type SessionModeChoice, type WireText, type WorkState, type WorktreeInfo } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { canRole } from '../../lib/capabilities.ts';
import { renderWireText } from '../../lib/errors.ts';

export type SessionKind = 'agent' | 'terminal';

export type CreateBlockReason = 'role-editor' | 'role-viewer' | 'not-admitted';

export interface NewSessionOptions {
  readonly canCreate: boolean;
  readonly blockedBy: CreateBlockReason | null;
  readonly worktree: {
    /** A new worktree is offered. */
    readonly available: boolean;
    /**
     * Why it is not: the git program cannot be used on the host's computer (the host's own sentence), or the host's
     * smurg has not looked for git yet and the viewer is not the host. A note under the choices.
     */
    readonly unavailable: WireText | null;
    /** The member's own kept worktrees that no running session uses, newest first. */
    readonly kept: readonly WorktreeInfo[];
  };
}

const UNCHECKED: MessageRef = msg('worktree.unavailable.unchecked');

export function newSessionOptions(input: {
  readonly role: Role | null;
  readonly userId: string | null;
  /** `HostState.work`; null before the host's first answer (worktrees are offered: the answer settles it). */
  readonly work: WorkState | null;
  readonly worktrees: readonly WorktreeInfo[];
  readonly sessions: ReadonlyMap<string, SessionInfo>;
}): NewSessionOptions {
  const { role, userId, work } = input;
  const canCreate = canRole(role, 'session.create') && userId !== null;
  const blockedBy: CreateBlockReason | null = canCreate ? null : role === 'editor' ? 'role-editor' : role === 'viewer' ? 'role-viewer' : 'not-admitted';
  const history = work?.history ?? null;
  let unavailable: WireText | null = null;
  if (history === 'direct') unavailable = work?.reason ?? { text: msg('worktree.unavailable.gitCannotRun'), fallback: renderEnglish(msg('worktree.unavailable.gitCannotRun')) };
  else if (history === 'unchecked' && role !== 'host') unavailable = { text: UNCHECKED, fallback: renderEnglish(UNCHECKED) };
  const kept =
    history === 'direct'
      ? []
      : input.worktrees
          .filter((worktree) => {
            if (worktree.ownerUserId !== userId || !worktree.kept) return false;
            if (worktree.sessionId === undefined) return true;
            const using = input.sessions.get(worktree.sessionId);
            return using === undefined || using.status === 'exited';
          })
          .sort((a, b) => b.createdAt - a.createdAt);
  return { canCreate, blockedBy, worktree: { available: unavailable === null, unavailable, kept } };
}

/** Why the worktree choices are off, in the viewer's language: the host's own sentence, saying what can be done. */
export function worktreeUnavailableNote(reason: WireText): string {
  return renderWireText(reason.text, reason.fallback);
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
 * commit yet, a `.git` that is no ordinary folder, the worktrees folder). The page notes it (`WorkspaceInfo.isGitRepo`,
 * which the wire still carries). Every other reason says nothing about the folder: git itself (not found, too old, not
 * running) is named first whatever the folder is, and a look that failed did not see the folder.
 */
export function refusalNamesRepository(failure: unknown): boolean {
  if (!isSmurgError(failure)) return false;
  const id = failure.text?.id;
  return id !== undefined && NAMES_A_REPOSITORY.has(id);
}

/**
 * A refusal of the host about worktrees (any `worktree.unavailable.*`): its sentence says why and what the host can
 * do. While the dialog shows it, the page's own note is not shown beside it: one sentence on screen, the host's (the
 * same words a second time, or the page's older belief).
 */
export function isWorktreeRefusal(failure: unknown): boolean {
  return isSmurgError(failure) && failure.text?.id.startsWith('worktree.unavailable.') === true;
}

/** 'main' | 'worktree:new' | 'worktree:<id>' — the value of the "Where to work" choice. */
export type WhereChoice = 'main' | 'worktree:new' | `worktree:${string}`;

/** `where` if the options still offer it (the worktree list may change while the dialog is open), else the main workspace. */
export function effectiveWhere(options: NewSessionOptions, where: WhereChoice): WhereChoice {
  if (where === 'main') return where;
  if (where === 'worktree:new') return options.worktree.available ? where : 'main';
  return options.worktree.kept.some((worktree) => where === `worktree:${worktree.id}`) ? where : 'main';
}

export interface NewSessionForm {
  readonly kind: SessionKind;
  readonly where: WhereChoice;
  readonly title: string;
  /** An agent session: what it should do first (optional; a terminal has none). */
  readonly firstMessage?: string;
  /** An agent session: a model of the host's list; null or absent: the host's default. */
  readonly model?: string | null;
  /** An agent session: its own permission mode; null or absent: it follows the workspace. */
  readonly permissionMode?: SessionModeChoice | null;
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
  // sent as the member wrote it (the daemon cleans it); a blank one is none. The model and the mode only when chosen
  // (protocol 5): absent, the session runs on the host's default and follows the workspace.
  if (form.kind === 'agent') {
    const first = form.firstMessage ?? '';
    const model = form.model ?? null;
    const mode = form.permissionMode ?? null;
    return {
      kind: 'agent',
      workspace,
      ...(title !== '' ? { title } : {}),
      ...(first.trim() !== '' ? { firstMessage: first } : {}),
      ...(model === null ? {} : { model }),
      ...(mode === null ? {} : { permissionMode: mode }),
    };
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
