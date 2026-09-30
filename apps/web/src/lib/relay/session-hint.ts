// Whether this browser may have a relay session at all — so that a logged-out visitor's page load asks nothing that
// fails. The relay's session is an HttpOnly cookie (script cannot see it), and `GET /api/me` answers 401 without one,
// which the browser prints as a console error that no script can suppress. The relay keeps that 401 (the client SDK,
// the CLI and the relay's own tests rely on it), so the app asks only when a session CAN exist: once this browser
// started a login (it is set just before the navigation to the relay), was seen logged in, or connected to a
// workspace (which needs a session). A 401 or a logout clears it.
//
// It is a cookie of its own (`smurg_hint=1`, readable by script, carrying nothing else): cookies are scoped to the
// HOST like the relay's session cookie, not to the origin like localStorage — a session cookie set through one port of
// a host is sent to every port of it (a dev front end on another port, the relay itself), and so is the hint.
//
// Not a security decision: the relay and the daemon check every request. Wrong in either direction, it costs at most one
// extra login click (a session this app never saw, e.g. from the relay's own CLI-login page) or one 401 in the console
// (a session that expired). Where cookies cannot be read or written it always answers "maybe" (ask, as before).

export const SESSION_HINT_COOKIE = 'smurg_hint';
/** As long as a relay session lives (7 days, ARCHITECTURE §12); renewed whenever a session is seen. */
export const SESSION_HINT_MAX_AGE_S = 7 * 24 * 60 * 60;

export interface SessionHint {
  /** false only when this browser certainly has no relay session. */
  maybe(): boolean;
  /** A login is starting, or a session was seen. */
  set(): void;
  /** The relay said there is no session (401), or the person logged out. */
  clear(): void;
}

/** `document`, or what tests use instead: the cookie string and whether cookies work at all. */
export interface CookieDocument {
  cookie: string;
}

export function createSessionHint(doc: CookieDocument | null, options: { readonly secure: boolean; readonly enabled?: boolean } = { secure: false }): SessionHint {
  const usable = doc !== null && options.enabled !== false;
  const attributes = `Path=/; SameSite=Lax${options.secure ? '; Secure' : ''}`;
  const read = (): boolean | null => {
    if (!usable) return null;
    try {
      return doc.cookie.split(';').some((part) => part.trim() === `${SESSION_HINT_COOKIE}=1`);
    } catch {
      return null;
    }
  };
  const write = (value: string, maxAge: number): void => {
    if (!usable) return;
    try {
      doc.cookie = `${SESSION_HINT_COOKIE}=${value}; Max-Age=${maxAge}; ${attributes}`;
    } catch {
      // cookies refused: maybe() keeps answering from what it can read
    }
  };
  return {
    maybe() {
      return read() ?? true;
    },
    set() {
      write('1', SESSION_HINT_MAX_AGE_S);
    },
    clear() {
      write('', 0);
    },
  };
}

/** The browser's: `document.cookie`, Secure on https. */
export function browserSessionHint(): SessionHint {
  if (typeof document === 'undefined') return ALWAYS_ASK;
  return createSessionHint(document, { secure: window.location.protocol === 'https:', enabled: navigator.cookieEnabled !== false });
}

/** For tests and previews: always "maybe" (every page asks, as without a hint). */
export const ALWAYS_ASK: SessionHint = Object.freeze({ maybe: () => true, set: () => {}, clear: () => {} });
