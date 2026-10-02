// Daemon-side errors. Everything that reaches a client is a SmurgError (@smurg/protocol); these subclasses add the
// facts the router needs to audit correctly without re-deriving them.
import { SmurgError, type ErrorDetail } from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';

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
  'host-private', // the host's private data (.git, .envrc, the host's personal Claude Code files) for a non-host
  'hard-link', // a regular file with more than one link: it could alias a file outside the share
  'special-file', // FIFO, socket or device
  'changed', // the object changed between the check and the use (a swapped parent, a replaced file)
  'not-directory', // a file used as a directory
] as const;
export type PathDeniedReason = (typeof PATH_DENIED_REASONS)[number];

/** What a member reads for each reason (`path.*` of `@smurg/protocol/i18n`). An agent reads ../hooks/deny-text.ts. */
const PATH_DENIED_TEXTS: Readonly<Record<PathDeniedReason, MessageRef>> = {
  lexical: msg('path.lexical'),
  'too-long': msg('path.tooLong'),
  'unknown-root': msg('path.unknownRoot'),
  'root-changed': msg('path.rootChanged'),
  'outside-root': msg('path.outsideRoot'),
  symlink: msg('path.symlink'),
  'shared-link-tampered': msg('path.sharedLinkTampered'),
  'read-only': msg('path.readOnly'),
  'host-only': msg('path.hostOnly'),
  hidden: msg('path.hidden'),
  'host-private': msg('path.hostPrivate'),
  'hard-link': msg('path.hardLink'),
  'special-file': msg('path.specialFile'),
  changed: msg('path.changed'),
  'not-directory': msg('path.notDirectory'),
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
    super(reason === 'host-only' ? 'host_only' : 'path_denied', PATH_DENIED_TEXTS[reason], detail, options);
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

  constructor(message?: MessageRef, detail?: ErrorDetail, code: 'forbidden' | 'host_only' = 'forbidden') {
    super(code, message, detail);
    this.name = 'AuthorizationError';
  }
}

export function isAuthorizationError(value: unknown): value is AuthorizationError {
  return value instanceof AuthorizationError;
}

/** What every stub of a not-yet-implemented service throws (ARCHITECTURE §7.2 composition). */
export function notImplemented(service: string): SmurgError {
  return new SmurgError('internal', undefined, { reason: 'not-implemented', service });
}
