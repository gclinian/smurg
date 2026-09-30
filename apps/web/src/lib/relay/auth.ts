// Login against the relay (ARCHITECTURE §6, relay.md §1.4). The browser session is an HttpOnly cookie set by the
// relay on the same origin (in development Vite proxies the relay routes, so it is the same origin there too).
//
// Login is a full-page navigation to /auth/<provider>/login?return_to=<absolute URL of this app>. The return URL never
// carries a fragment: by the time anyone logs in, boot/capture-invite.ts has moved the invite into sessionStorage.
//
// A logged-out page load asks nothing that fails (a clean console): which login buttons to show is ONE request,
// `GET /api/login-options` (200, booleans only), and `/api/me` is asked only when a session can exist at all
// (session-hint.ts) — the relay keeps answering 401 without one, which the browser would print as an error.
import { isRelayApiError, type RelayApi, type RelayUser } from '@smurg/protocol/client';
import { RELAY_PATHS, authLoginPath, loginOptionsUrl, relayLoginOptionsSchema, type RelayAuthProvider } from '@smurg/protocol/relay';
import { ALWAYS_ASK, type SessionHint } from './session-hint.ts';

export interface LoginOptions {
  /** OAuth providers the relay has configured (only those are offered). */
  readonly providers: readonly RelayAuthProvider[];
  /** The relay's dev-only login is available (DEV_LOGIN=1 on a local hostname). */
  readonly dev: boolean;
}

export interface RelayAuthClient {
  /**
   * Who is logged in; null when nobody is (401, or no session can exist in this browser: then nothing is asked).
   * Rejects on network / server errors.
   */
  me(): Promise<RelayUser | null>;
  logout(): Promise<void>;
  /** Absolute URL to navigate to for an OAuth login that comes back to `returnPath` (an in-app path). The caller navigates. */
  loginUrl(provider: RelayAuthProvider, returnPath: string): string;
  /** Dev-only login URL (see loginOptions().dev). The caller navigates. */
  devLoginUrl(user: string, displayName: string | undefined, returnPath: string): string;
  /** The relay's login methods (GET /api/login-options). Rejects when the relay cannot say. */
  loginOptions(): Promise<LoginOptions>;
  /** A workspace connection was admitted, so this browser has a relay session (the next page asks /api/me). */
  sessionSeen(): void;
}

/** The OAuth providers the web app knows how to offer. */
export const OAUTH_PROVIDERS: readonly RelayAuthProvider[] = ['github', 'google'];

/** Same rule as the relay's dev user names. */
export const DEV_USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type OptionsFetch = (
  url: string,
  init: { method: 'GET'; credentials: 'same-origin'; redirect: 'error'; cache: 'no-store'; headers: { accept: string } },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export function createRelayAuthClient(options: { relay: RelayApi; origin: string; fetch?: OptionsFetch; hint?: SessionHint }): RelayAuthClient {
  const origin = new URL(options.origin).origin;
  const get: OptionsFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const hint = options.hint ?? ALWAYS_ASK;

  const returnTo = (returnPath: string): string => {
    if (!returnPath.startsWith('/') || returnPath.startsWith('//') || returnPath.includes('#')) {
      throw new TypeError('returnPath must be an in-app path without a fragment');
    }
    // Absolute: in development the relay's own origin (8787) differs from the app's (5173), and a bare path would
    // bring the person back to the relay instead of this app. The relay only accepts allow-listed origins.
    return `${origin}${returnPath}`;
  };

  return {
    async me() {
      if (!hint.maybe()) return null;
      try {
        const user = await options.relay.me();
        hint.set();
        return user;
      } catch (error) {
        if (isRelayApiError(error, 401)) {
          hint.clear();
          return null;
        }
        throw error;
      }
    },
    async logout() {
      await options.relay.logout();
      hint.clear();
    },
    loginUrl(provider, returnPath) {
      const url = new URL(authLoginPath(provider), origin);
      url.searchParams.set('return_to', returnTo(returnPath));
      // The page is about to leave for the relay's login: from now on a session may exist.
      hint.set();
      return url.toString();
    },
    devLoginUrl(user, displayName, returnPath) {
      if (!DEV_USER_PATTERN.test(user)) throw new TypeError('invalid dev user name');
      const url = new URL(RELAY_PATHS.devStart, origin);
      url.searchParams.set('user', user);
      if (displayName !== undefined && displayName.trim() !== '') url.searchParams.set('name', displayName.trim());
      url.searchParams.set('return_to', returnTo(returnPath));
      hint.set();
      return url.toString();
    },
    async loginOptions() {
      // One request, answered 200 with booleans only (review WEB-14 used to probe the login routes: 400 / 503 / 404
      // in the console). `dev` is the relay's own verdict for THIS hostname (always false in production).
      const response = await get(loginOptionsUrl(origin), {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (response.status !== 200) throw new Error(`login options: HTTP ${response.status}`);
      const body = relayLoginOptionsSchema.parse(await response.json());
      return { providers: OAUTH_PROVIDERS.filter((provider) => body.providers[provider]), dev: body.dev };
    },
    sessionSeen() {
      hint.set();
    },
  };
}
