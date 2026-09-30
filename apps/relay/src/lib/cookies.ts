// Cookie names and (de)serialisation. Only relay-minted JWTs are ever stored, so values are restricted to the JWT
// alphabet and never need escaping.

export type CookieNames = { session: string; tx: string };

/**
 * With an https issuer the cookies carry the `__Host-` prefix: the browser then refuses them unless they are Secure,
 * host-only and Path=/, so a sibling subdomain cannot plant a session (login CSRF / fixation). Plain http is only
 * allowed for local development, where the prefix would be rejected.
 */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: '__Host-smurg_session', tx: '__Host-smurg_tx' }
    : { session: 'smurg_session', tx: 'smurg_tx' };
}

const VALUE_RE = /^[A-Za-z0-9._-]*$/;
const MAX_COOKIE_VALUE = 4096;

/**
 * Returns the value of `name`, or null when it is absent, malformed, or present more than once with different
 * values (an ambiguous cookie is treated as no cookie).
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value.length > MAX_COOKIE_VALUE || !VALUE_RE.test(value)) return null;
    if (found !== null && found !== value) return null;
    found = value;
  }
  return found === '' ? null : found;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  if (!VALUE_RE.test(value)) throw new TypeError('cookie value outside the JWT alphabet');
  const attrs = [`${name}=${value}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', 0, secure);
}
