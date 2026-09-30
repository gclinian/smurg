// Input validation for the auth routes. Pure functions, unit-tested in Node.

/** Dev-only user names; `dev:<name>` must match RELAY_USER_ID_PATTERN in @smurg/protocol/relay. */
export const DEV_USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** RFC 7636 code_verifier: 43-128 characters of [A-Za-z0-9-._~]. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** S256 code_challenge: base64url(SHA-256) without padding = 43 characters. */
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Identity-binding commitment `base64url(SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey))` = 43 characters. */
export const CNF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The CLI's own anti-CSRF value for its loopback listener. */
export const CLI_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

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

export type CliParams = { port: number; state: string; codeChallenge: string };

/**
 * Parameters of `GET /auth/cli/start`: the CLI's loopback port, its state and its PKCE challenge. Returns null
 * when any of them is missing or malformed.
 */
export function parseCliParams(search: URLSearchParams): CliParams | null {
  const port = search.get('port') ?? '';
  const state = search.get('state') ?? '';
  const codeChallenge = search.get('code_challenge') ?? '';
  if (!/^\d{4,5}$/.test(port)) return null;
  const portNumber = Number(port);
  if (portNumber < 1024 || portNumber > 65535) return null;
  if (!CLI_STATE_PATTERN.test(state) || !PKCE_CHALLENGE_PATTERN.test(codeChallenge)) return null;
  return { port: portNumber, state, codeChallenge };
}

/** Unambiguous base32 alphabet (no I, O, 0, 1) of the CLI confirmation code. */
const CONFIRM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The short code the CLI login confirmation page shows and the `smurg` CLI prints in the terminal, so the person can
 * see that the page belongs to the login they just started: the first 40 bits of SHA-256("smurg-cli-login:" ‖ state)
 * in CONFIRM_ALPHABET, as `XXXX-XXXX`. Not a secret (the state is in the URL); the CLI computes the same function.
 */
export async function cliConfirmCode(state: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`smurg-cli-login:${state}`)));
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i] ?? 0);
  let code = '';
  for (let i = 7; i >= 0; i--) code += CONFIRM_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Where the relay sends the CLI's one-time code (RFC 8252 loopback redirect; the CLI binds 127.0.0.1 only). */
export function cliLoopbackUrl(cli: CliParams, result: { code: string } | { error: string }): string {
  const url = new URL(`http://127.0.0.1:${cli.port}/callback`);
  if ('code' in result) url.searchParams.set('code', result.code);
  else url.searchParams.set('error', result.error);
  url.searchParams.set('state', cli.state);
  return url.href;
}
