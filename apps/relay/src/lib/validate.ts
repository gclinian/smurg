// Input validation for the auth routes. Pure functions, unit-tested in Node.

/** Dev-only user names; `dev:<name>` must match RELAY_USER_ID_PATTERN in @smurg/protocol/relay. */
export const DEV_USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** RFC 7636 code_verifier (the relay's own, for GitHub / Google): 43-128 characters of [A-Za-z0-9-._~]. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** Identity-binding commitment `base64url(SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey))` = 43 characters. */
export const CNF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const MAX_RETURN_TO = 2048;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Where the browser goes after login. Accepts a path on the relay itself, or an absolute URL whose origin is on the
 * allow-list (the Vite dev server in development). Everything else is refused instead of silently replaced, so an
 * open-redirect attempt is visible. Returns the absolute URL, or null when refused.
 */
export function resolveReturnTo(raw: string | null, issuer: string, allowedOrigins: ReadonlySet<string>): string | null {
  if (raw === null || raw === '') return `${issuer}/`;
  if (raw.length > MAX_RETURN_TO || CONTROL_CHARS.test(raw)) return null;
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return null;
    let url: URL;
    try {
      url = new URL(raw, issuer);
    } catch {
      return null;
    }
    return url.origin === issuer ? url.href : null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.origin !== issuer && !allowedOrigins.has(url.origin)) return null;
  return url.href;
}
