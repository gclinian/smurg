// What the 「新增 session」 dialog offers, per role (SPEC §8, ARCHITECTURE §5.5) — pure, so it is tested without React.
// The role decides the sandbox; the client never chooses it (the daemon enforces all of this again):
//   host   → an unsandboxed host session (session.create.host);
//   runner → a sandboxed session (session.create.sandboxed), and may bring their own API key for an agent;
//   editor / viewer → no session; the dialog says why.
// Worktrees (R9) need a git repository; a kept worktree of one's own can be continued (R9.4).
import { API_KEY_MAX_CHARS, apiKeySchema, type PayloadInputOf, type Role, type SessionInfo, type WorkspaceInfo, type WorktreeInfo } from '@smurg/protocol';
import { canRole } from '../../lib/capabilities.ts';

export type SessionKind = 'agent' | 'terminal';

export type CreateBlockReason = 'role-editor' | 'role-viewer' | 'not-admitted';

export interface NewSessionOptions {
  readonly canCreate: boolean;
  readonly blockedBy: CreateBlockReason | null;
  /** true: runner (sandboxed guest session); false: host session; null: cannot create. */
  readonly sandboxed: boolean | null;
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
  const host = canRole(role, 'session.create.host');
  const sandboxed = canRole(role, 'session.create.sandboxed');
  const canCreate = (host || sandboxed) && userId !== null;
  const blockedBy: CreateBlockReason | null = canCreate
    ? null
    : role === 'editor'
      ? 'role-editor'
      : role === 'viewer'
        ? 'role-viewer'
        : 'not-admitted';
  const isGit = workspace?.isGitRepo === true;
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
    worktree: { available: isGit, unavailableReason: isGit ? null : 'not-git', kept },
  };
}

/** 'main' | 'worktree:new' | 'worktree:<id>' — the value of the 「工作位置」 choice. */
export type WhereChoice = 'main' | 'worktree:new' | `worktree:${string}`;

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
  let workspace: PayloadInputOf<'session.create'>['workspace'] = { mode: 'main' };
  if (form.where !== 'main' && options.worktree.available) {
    const id = form.where.slice('worktree:'.length);
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
