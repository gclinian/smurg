// CLI loopback login (relay.md §1.4): the CLI listens on 127.0.0.1:<port>, opens the relay's /auth/cli/start in a
// browser, and the relay shows a confirmation page (the relay origin, the local port and a confirmation code the CLI
// prints too: cliLoginConfirmCode). Only a same-origin form POST from that page continues (reviews SEC-E-03,
// OWNER-01); after the provider flow a relay page (meta refresh + link, never a 302) continues to
// http://127.0.0.1:<port>/callback?code=…&state=…, and the CLI exchanges code + PKCE verifier for a bearer session
// token (RelayApi.exchangeCliCode). The HTTP listener itself is Node-only and lives in the CLI; these helpers are pure
// so they stay browser-safe and testable.
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, randomBytes, toBase64Url, utf8Encode } from '../bytes.ts';
import { RELAY_PATHS, relayHttpUrl } from '../relay/routes.ts';

export const CLI_LOGIN_CALLBACK_PATH = '/callback';
export const CLI_LOGIN_PROVIDERS = ['github', 'google', 'dev'] as const;
export type CliLoginProvider = (typeof CLI_LOGIN_PROVIDERS)[number];

/** RFC 7636 verifier alphabet and length; the relay checks the same pattern. */
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** The relay's CLI_STATE_PATTERN. */
const CLI_STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DEV_USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CODE_MAX_CHARS = 4096;

/** A fresh PKCE verifier: 48 random bytes as base64url (64 characters). */
export function createPkceVerifier(): string {
  return toBase64Url(randomBytes(48));
}

/** S256 challenge: base64url(SHA-256(ASCII verifier)), 43 characters. */
export function pkceChallenge(verifier: string): string {
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new RangeError('invalid PKCE verifier');
  return toBase64Url(sha256(utf8Encode(verifier)));
}

export interface CliLoginRequestOptions {
  relayUrl: string | URL;
  /** The loopback port the CLI listens on (127.0.0.1 only). The relay accepts 1024..65535. */
  port: number;
  /** Without a provider the relay shows a chooser page. */
  provider?: CliLoginProvider;
  /** Dev provider only: the account name (`dev:<user>`). */
  user?: string;
}

export interface CliLoginRequest {
  /** Open this in the person's browser. */
  readonly url: string;
  /** Anti-CSRF value the callback must echo; check it with parseCliCallback. */
  readonly state: string;
  /** Keep in memory only; send it with the code to RelayApi.exchangeCliCode. */
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  /** Where the relay will redirect: http://127.0.0.1:<port>/callback */
  readonly redirectUri: string;
  /** The code the relay's confirmation page shows for this login (cliLoginConfirmCode(state)): print it next to the URL. */
  readonly confirmCode: string;
}

/** CONFIRM_ALPHABET of the relay (apps/relay/src/lib/validate.ts): base32 without I, O, 0, 1. */
const CONFIRM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The confirmation code of a CLI login, as the relay computes it (cliConfirmCode): the first 40 bits of
 * SHA-256(UTF-8 "smurg-cli-login:" ‖ state), 8 groups of 5 bits (most significant first) in CONFIRM_ALPHABET, as
 * `XXXX-XXXX`. Not a secret (the state is in the URL); it lets the person see that the page in the browser belongs to
 * the login they just started in the terminal (review SEC-E-03).
 */
export function cliLoginConfirmCode(state: string): string {
  const digest = sha256(utf8Encode(`smurg-cli-login:${state}`));
  let bits = 0;
  for (let i = 0; i < 5; i++) bits = bits * 256 + (digest[i] as number);
  let code = '';
  for (let i = 7; i >= 0; i--) code += CONFIRM_ALPHABET[Math.floor(bits / 2 ** (i * 5)) % 32];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function createCliLoginRequest(options: CliLoginRequestOptions): CliLoginRequest {
  const { port, provider, user } = options;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError('loopback port must be in 1024..65535');
  if (provider !== undefined && !(CLI_LOGIN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new RangeError('unknown login provider');
  }
  if (user !== undefined && (provider !== 'dev' || !DEV_USER_PATTERN.test(user))) {
    throw new RangeError('user is only valid for the dev provider and must match [A-Za-z0-9._-]{1,64}');
  }
  const codeVerifier = createPkceVerifier();
  const codeChallenge = pkceChallenge(codeVerifier);
  const state = toBase64Url(randomBytes(24));
  const url = new URL(relayHttpUrl(options.relayUrl, RELAY_PATHS.cliStart));
  url.searchParams.set('port', String(port));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  if (provider !== undefined) url.searchParams.set('provider', provider);
  if (user !== undefined) url.searchParams.set('user', user);
  return {
    url: url.toString(),
    state,
    codeVerifier,
    codeChallenge,
    redirectUri: `http://127.0.0.1:${port}${CLI_LOGIN_CALLBACK_PATH}`,
    confirmCode: cliLoginConfirmCode(state),
  };
}

export type CliCallbackResult =
  | { readonly ok: true; readonly code: string }
  /** `error` is the relay's code (e.g. 'access_denied', 'login_failed') or 'state_mismatch' / 'bad_callback'. */
  | { readonly ok: false; readonly error: string };

/**
 * Validates a request that reached the loopback listener. Pass the request target (e.g. `req.url`, a path with a
 * query) or an absolute URL. The state is compared in constant time BEFORE anything else is believed: without it,
 * any web page could drive the person's browser to the loopback port with a code of its choosing.
 */
export function parseCliCallback(target: string | URL, expectedState: string): CliCallbackResult {
  if (!CLI_STATE_PATTERN.test(expectedState)) throw new RangeError('invalid expected state');
  let url: URL;
  try {
    url = new URL(target, 'http://127.0.0.1');
  } catch {
    return { ok: false, error: 'bad_callback' };
  }
  if (url.pathname !== CLI_LOGIN_CALLBACK_PATH) return { ok: false, error: 'bad_callback' };
  const params = url.searchParams;
  const state = params.getAll('state');
  if (state.length !== 1 || !equalBytes(utf8Encode(state[0] as string), utf8Encode(expectedState))) {
    return { ok: false, error: 'state_mismatch' };
  }
  const errors = params.getAll('error');
  const codes = params.getAll('code');
  if (errors.length > 0) {
    const error = errors[0] as string;
    return { ok: false, error: /^[a-z_]{1,64}$/.test(error) ? error : 'login_failed' };
  }
  if (codes.length !== 1) return { ok: false, error: 'bad_callback' };
  const code = codes[0] as string;
  if (code.length === 0 || code.length > CODE_MAX_CHARS || !/^[A-Za-z0-9._-]+$/.test(code)) return { ok: false, error: 'bad_callback' };
  return { ok: true, code };
}

/** Constant-time comparison of two ASCII strings (exported for the CLI's own checks). */
export function timingSafeEqualAscii(a: string, b: string): boolean {
  return equalBytes(utf8Encode(a), utf8Encode(b));
}
