// The very first code the app runs (imported first by main.tsx; ARCHITECTURE §4.1, noise.md gotcha 14).
//
// An invite link is `https://<origin>/join/<workspaceId>#k=<fingerprint>&s=<secret>`. The fragment never reaches a
// server, but it does sit in the address bar, in the tab's history entry and in anything that reads `location.href`.
// So before any other module runs (and long before the OAuth redirect of the login step), this module copies the
// fragment into sessionStorage — per tab, gone when the tab closes, surviving the same-tab login redirect — and removes
// it from the address bar with history.replaceState.
//
// What this does NOT undo (review SEC-E-05): the browser commits the full URL, fragment included, to its GLOBAL history
// (the profile's History database, and synced history when sync is on) before any script runs; replaceState only
// rewrites the tab's session entry. No page code can remove that copy. So an invite link stays a working credential
// wherever the browser profile or its sync can be read, until it is used up, expires or is revoked: single-use links
// limit that to one join, and the host sees each use (auth.join) and can revoke a link in the console.
//
// It has NO imports on purpose: an ES module's dependencies evaluate before its body, so importing anything here
// would run that code first. Parsing (strict) happens later, in lib/invite/pending-invite.ts.

/** sessionStorage key prefix; the workspace id follows. */
export const PENDING_INVITE_KEY_PREFIX = 'smurg.pendingInvite.';

/**
 * `/join/<workspaceId>` with the workspace id rule of @smurg/protocol (WORKSPACE_ID_PATTERN: 16–64 of
 * [A-Za-z0-9_-]). Duplicated because this module may not import; a unit test keeps both in step.
 */
export const JOIN_PATH_PATTERN = /^\/join\/([A-Za-z0-9_-]{16,64})$/;

/** A fragment longer than this is not an invite (a real one is 90 characters); it is dropped, never stored. */
export const MAX_CAPTURED_FRAGMENT_CHARS = 512;

export interface CaptureEnvironment {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string };
  readonly history: { readonly state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  /** null when the browser refuses storage (some privacy modes). */
  readonly sessionStorage: Pick<Storage, 'setItem'> | null;
}

export type CaptureResult =
  /** No fragment in the URL. */
  | { readonly kind: 'none' }
  /** A fragment on a /join/ route: stored (or kept in memory when storage is unavailable) and removed from the URL. */
  | { readonly kind: 'captured'; readonly workspaceId: string; readonly persisted: boolean }
  /** A fragment anywhere else (or too long to be an invite): removed from the URL and not kept. */
  | { readonly kind: 'stripped' };

/** Fallback when sessionStorage is unavailable: lives for this page load only (lost on the login redirect). */
const memoryFallback = new Map<string, string>();

/** The captured fragment of `workspaceId` if storage was unavailable. */
export function peekInMemoryInvite(workspaceId: string): string | null {
  return memoryFallback.get(workspaceId) ?? null;
}

export function clearInMemoryInvite(workspaceId: string): void {
  memoryFallback.delete(workspaceId);
}

export function captureInviteFragment(env: CaptureEnvironment): CaptureResult {
  const { pathname, search, hash } = env.location;
  if (hash === '') return { kind: 'none' };
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const match = JOIN_PATH_PATTERN.exec(pathname);
  let result: CaptureResult = { kind: 'stripped' };
  if (match && fragment !== '' && fragment.length <= MAX_CAPTURED_FRAGMENT_CHARS) {
    const workspaceId = match[1] as string;
    let persisted = false;
    try {
      env.sessionStorage?.setItem(PENDING_INVITE_KEY_PREFIX + workspaceId, fragment);
      persisted = env.sessionStorage !== null;
    } catch {
      persisted = false;
    }
    if (!persisted) memoryFallback.set(workspaceId, fragment);
    result = { kind: 'captured', workspaceId, persisted };
  }
  // Every fragment goes: the app has no in-page anchors, and a secret pasted onto another path must not linger either.
  try {
    env.history.replaceState(env.history.state, '', `${pathname}${search}`);
  } catch {
    // Nothing else can be done; the join page still consumes the stored copy.
  }
  return result;
}

/** Guarded so tests can import the module without a browser window. */
function browserEnvironment(): CaptureEnvironment | null {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return null;
  let sessionStorage: Storage | null = null;
  try {
    sessionStorage = window.sessionStorage;
  } catch {
    sessionStorage = null;
  }
  return { location: window.location, history: window.history, sessionStorage };
}

/** What happened at startup (the join page reads it to tell "stored" from "kept in memory only"). */
export const bootCapture: CaptureResult = (() => {
  const env = browserEnvironment();
  return env ? captureInviteFragment(env) : { kind: 'none' };
})();
