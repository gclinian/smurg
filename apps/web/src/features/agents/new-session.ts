// What the 「新增 session」 dialog offers, per role (SPEC §8, ARCHITECTURE §5.5) — pure, so it is tested without React.
// The role decides the sandbox; the client never chooses it (the daemon enforces all of this again):
//   host   → an unsandboxed host session (session.create.host);
//   runner → a sandboxed session (session.create.sandboxed), and may bring their own API key for an agent;
//   editor / viewer → no session; the dialog says why.
// Worktrees (R9) need a git repository; a kept worktree of one's own can be continued (R9.4).
// The shared main workspace is open to sandboxed (guest) sessions unless the host's daemon says otherwise
// (PublicSettings.guestMainWorkspace false, ARCHITECTURE §11 D-14: the default on a Linux host): then guests work in a
// worktree only, and on a share that is not a git repository they cannot open sessions at all (their subscription
// login, a `login` session that touches nothing of the share, is not affected). The host's own sessions never are.
import { API_KEY_MAX_CHARS, apiKeySchema, type PayloadInputOf, type Role, type SessionInfo, type WorkspaceInfo, type WorktreeInfo } from '@smurg/protocol';
import { canRole } from '../../lib/capabilities.ts';

export type SessionKind = 'agent' | 'terminal';

/** guest-sessions-off: a guest on a host that keeps guests out of the main workspace, in a share that is not git. */
export type CreateBlockReason = 'role-editor' | 'role-viewer' | 'not-admitted' | 'guest-sessions-off';

export interface NewSessionOptions {
  readonly canCreate: boolean;
  readonly blockedBy: CreateBlockReason | null;
  /** true: runner (sandboxed guest session); false: host session; null: cannot create. */
  readonly sandboxed: boolean | null;
  readonly main: {
    readonly available: boolean;
    /** host-off: the host did not open the main workspace to guests (PublicSettings.guestMainWorkspace false). */
    readonly unavailableReason: 'host-off' | null;
  };
  readonly worktree: {
    readonly available: boolean;
    readonly unavailableReason: 'not-git' | null;
    /** The member's own kept worktrees that no running session uses, newest first. */
    readonly kept: readonly WorktreeInfo[];
  };
}

/** Whether `role` opens sandboxed sessions and the host keeps those out of the main workspace. */
export function keptOutOfMain(role: Role | null, guestMainWorkspace: boolean | undefined): boolean {
  return canRole(role, 'session.create.sandboxed') && !canRole(role, 'session.create.host') && guestMainWorkspace === false;
}

/** No session of one's own at all: kept out of the main workspace, and the share has no worktrees (not git). */
export function guestSessionsOff(role: Role | null, workspace: WorkspaceInfo | null, guestMainWorkspace: boolean | undefined): boolean {
  return keptOutOfMain(role, guestMainWorkspace) && workspace?.isGitRepo !== true;
}

export function newSessionOptions(input: {
  readonly role: Role | null;
  readonly userId: string | null;
  readonly workspace: WorkspaceInfo | null;
  readonly worktrees: readonly WorktreeInfo[];
  readonly sessions: ReadonlyMap<string, SessionInfo>;
  /** PublicSettings.guestMainWorkspace; undefined (an older daemon, or no Welcome yet) ⇒ open, as before. */
  readonly guestMainWorkspace?: boolean | undefined;
}): NewSessionOptions {
  const { role, userId, workspace } = input;
  const host = canRole(role, 'session.create.host');
  const sandboxed = canRole(role, 'session.create.sandboxed');
  const isGit = workspace?.isGitRepo === true;
  const mainOff = keptOutOfMain(role, input.guestMainWorkspace);
  const allowed = (host || sandboxed) && userId !== null;
  const canCreate = allowed && !guestSessionsOff(role, workspace, input.guestMainWorkspace);
  const blockedBy: CreateBlockReason | null = canCreate
    ? null
    : allowed
      ? 'guest-sessions-off'
      : role === 'editor'
        ? 'role-editor'
        : role === 'viewer'
          ? 'role-viewer'
          : 'not-admitted';
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
    sandboxed: canCreate ? !host : null,
    main: { available: !mainOff, unavailableReason: mainOff ? 'host-off' : null },
    worktree: { available: isGit, unavailableReason: isGit ? null : 'not-git', kept },
  };
}

/** 'main' | 'worktree:new' | 'worktree:<id>' — the value of the 「工作位置」 choice. */
export type WhereChoice = 'main' | 'worktree:new' | `worktree:${string}`;

/** The preselected 「工作位置」: the shared main workspace, or a new worktree of one's own when guests are kept out of it. */
export function defaultWhere(options: NewSessionOptions): WhereChoice {
  return !options.main.available && options.worktree.available ? 'worktree:new' : 'main';
}

/** `where` if the options still offer it (the settings or the worktree list may change while the dialog is open). */
export function effectiveWhere(options: NewSessionOptions, where: WhereChoice): WhereChoice {
  if (where === 'main') return options.main.available ? 'main' : defaultWhere(options);
  if (!options.worktree.available) return defaultWhere(options);
  if (where === 'worktree:new' || options.worktree.kept.some((worktree) => where === `worktree:${worktree.id}`)) return where;
  return defaultWhere(options);
}

export interface NewSessionForm {
  readonly kind: SessionKind;
  readonly where: WhereChoice;
  readonly title: string;
  /** Only used for a runner's agent session; never stored anywhere but the dialog's state until it is sent. */
  readonly apiKey: string;
}

/** Whether the API key field applies (a guest's own key, sandboxed agent sessions only). */
export function apiKeyApplies(options: NewSessionOptions, kind: SessionKind): boolean {
  return options.sandboxed === true && kind === 'agent';
}

/** '' is "no key"; otherwise the key must be one token of printable ASCII (the protocol's apiKey rule). */
export function apiKeyProblem(apiKey: string): 'invalid' | null {
  if (apiKey === '') return null;
  return apiKey.length <= API_KEY_MAX_CHARS && apiKeySchema.safeParse(apiKey).success ? null : 'invalid';
}

/** The session.create payload for `form` (the size is the viewer's best guess; the owner's viewport corrects it). */
export function buildCreatePayload(
  options: NewSessionOptions,
  form: NewSessionForm,
  size: { readonly cols: number; readonly rows: number },
): PayloadInputOf<'session.create'> {
  // A guest kept out of the main workspace never asks for it: their own new worktree instead (the daemon would refuse).
  const where = form.where === 'main' && !options.main.available ? defaultWhere(options) : form.where;
  let workspace: PayloadInputOf<'session.create'>['workspace'] = { mode: 'main' };
  if (where !== 'main' && options.worktree.available) {
    const id = where.slice('worktree:'.length);
    workspace = id === 'new' ? { mode: 'worktree' } : { mode: 'worktree', worktreeId: id };
  }
  const title = form.title.trim();
  const apiKey = apiKeyApplies(options, form.kind) ? form.apiKey.trim() : '';
  return {
    kind: form.kind,
    workspace,
    cols: size.cols,
    rows: size.rows,
    ...(title !== '' ? { title } : {}),
    ...(apiKey !== '' ? { apiKey } : {}),
  };
}

/**
 * A sensible PTY size before any viewer measured one: the owner's panel replaces it as soon as the session's terminal
 * attaches (terminal-fit.ts).
 */
export const DEFAULT_TERMINAL_SIZE = Object.freeze({ cols: 100, rows: 30 });
