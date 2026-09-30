// Daemon-side errors. Everything that reaches a client is a SmurgError (@smurg/protocol); these subclasses add the
// facts the router needs to audit correctly without re-deriving them.
import { SmurgError, type ErrorDetail } from '@smurg/protocol';

/**
 * Why PathGuard refused a path (ARCHITECTURE §7.4). Sent to the client as `detail.reason`, so every value is safe to
 * disclose: none of them says what exists outside the shared folder.
 */
export const PATH_DENIED_REASONS = [
  'lexical', // failed the lexical layer: '..', absolute, NUL/control, bidi, backslash, drive letter, lone surrogate
  'too-long', // a segment or the absolute path is longer than the host platform allows
  'unknown-root', // the RootRef names no registered root
  'root-changed', // the root directory is no longer the one registered (moved, or swapped for a symlink)
  'outside-root', // resolves, through a symlink or a swapped parent, outside the root
  'symlink', // a symlink where the operation must not follow one (writes never go through links)
  'shared-link-tampered', // a registered read-only shared link no longer points where the daemon made it point
  'read-only', // inside a shared read-only directory of a worktree (D12)
  'host-only', // a host-only path (ARCHITECTURE §5.2) written by someone who is not the host
  'hidden', // not visible to this principal (<share>/.smurg for non-hosts)
  'host-private', // the host's private data (.git, .envrc, the host's personal Claude Code files) for a non-host (SEC-D-03)
  'hard-link', // a regular file with more than one link: it could alias a file outside the share
  'special-file', // FIFO, socket or device
  'changed', // the object changed between the check and the use (a swapped parent, a replaced file)
  'not-directory', // a file used as a directory
] as const;
export type PathDeniedReason = (typeof PATH_DENIED_REASONS)[number];

const PATH_DENIED_MESSAGES: Readonly<Record<PathDeniedReason, string>> = {
  lexical: '路徑格式不正確',
  'too-long': '路徑太長',
  'unknown-root': '找不到這個工作區或 worktree',
  'root-changed': '工作區資料夾已被移動或替換',
  'outside-root': '不允許存取分享資料夾以外的路徑',
  symlink: '不允許透過符號連結寫入',
  'shared-link-tampered': '共享資料夾的連結已被竄改',
  'read-only': '這個共享資料夾是唯讀的',
  'host-only': '只有主人可以修改這個路徑',
  hidden: '不允許存取這個路徑',
  'host-private': '這是主人的私人檔案，只有主人可以存取',
  'hard-link': '不允許存取有多個硬連結的檔案',
  'special-file': '不支援這種特殊檔案',
  changed: '檔案在檢查後被變更，請再試一次',
  'not-directory': '路徑中有不是資料夾的項目',
};

/**
 * PathGuard's refusal. `code` is `host_only` for host-only paths and `path_denied` for everything else; the reason is
 * in `detail.reason`. `audited` is set by whoever wrote the `path.denied` audit entry, so the router can audit every
 * denial exactly once (a handler that forgot to pass a principal still gets its denial audited).
 */
export class PathDeniedError extends SmurgError {
  readonly reason: PathDeniedReason;
  /** The path as the client (or hook) sent it, for the audit target. Never an absolute host path. */
  readonly target: string;
  audited = false;

  constructor(reason: PathDeniedReason, target: string, options?: { cause?: unknown }) {
    const detail: ErrorDetail = { reason };
    super(reason === 'host-only' ? 'host_only' : 'path_denied', PATH_DENIED_MESSAGES[reason], detail, options);
    this.name = 'PathDeniedError';
    this.reason = reason;
    this.target = target;
  }
}

export function isPathDeniedError(value: unknown): value is PathDeniedError {
  return value instanceof PathDeniedError;
}

/**
 * A refusal the router must audit as `authz.denied` (ownership and other resource checks inside handlers). Handlers
 * create it with `ctx.deny(...)`, which audits immediately; the flag stops the router from auditing it twice.
 */
export class AuthorizationError extends SmurgError {
  audited = false;

  constructor(message?: string, detail?: ErrorDetail, code: 'forbidden' | 'host_only' = 'forbidden') {
    super(code, message, detail);
    this.name = 'AuthorizationError';
  }
}

export function isAuthorizationError(value: unknown): value is AuthorizationError {
  return value instanceof AuthorizationError;
}

/** What every stub of a not-yet-implemented service throws (ARCHITECTURE §7.2 composition). */
export function notImplemented(service: string): SmurgError {
  return new SmurgError('internal', `not implemented: ${service}`, { reason: 'not-implemented', service });
}
