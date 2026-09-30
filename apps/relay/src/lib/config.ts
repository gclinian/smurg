// Typed, validated view of the relay's vars and secrets. Pure (no Worker globals) so it is unit-tested in Node.
// Everything here fails closed: an invalid issuer makes every auth route answer 500, an invalid provider setting
// disables that provider, and an invalid tap URL disables the tap.
import {
  RELAY_CLIENT_SWEEP_MS,
  RELAY_HOST_TIMEOUT_MS,
  RelayUrlError,
  isLocalHostname,
  relayOrigin,
  type RelayLoginOptions,
} from '@smurg/protocol/relay';

/** Defaults for the socket caps (relay.md gotcha 24: relay sessions cannot be revoked, so cap what they can open). */
export const DEFAULT_MAX_CLIENT_SOCKETS_PER_WORKSPACE = 64;
export const DEFAULT_MAX_SOCKETS_PER_ACCOUNT = 8;

/** Every var and secret the relay reads. The Worker's generated `Env` satisfies this structurally. */
export interface RelayVars {
  RELAY_ISSUER?: string;
  ALLOWED_ORIGINS?: string;
  DEV_LOGIN?: string;
  RELAY_TAP_URL?: string;
  HOST_TIMEOUT_MS?: string;
  CLIENT_SWEEP_MS?: string;
  MAX_CLIENT_SOCKETS_PER_WORKSPACE?: string;
  MAX_SOCKETS_PER_ACCOUNT?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_AUTHORIZE_URL?: string;
  GITHUB_TOKEN_URL?: string;
  GITHUB_API_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_AUTHORIZE_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_JWKS_URL?: string;
  GOOGLE_ISSUER?: string;
  RELAY_SIGNING_KEY?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/** What a Durable Object needs; parsed without the issuer so a misconfigured issuer never breaks forwarding. */
export type RoomConfig = {
  hostTimeoutMs: number;
  clientSweepMs: number;
  maxClientSocketsPerWorkspace: number;
  maxSocketsPerAccount: number;
  /** R3 byte tap target, only ever a local URL (test-only). */
  tapUrl: string | null;
};

export type GithubConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
};

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** Accepted `iss` values of id_tokens. */
  issuers: string[];
};

export type RelayConfig = RoomConfig & {
  /** Origin of the relay, e.g. `https://smurg.app` (no trailing slash): JWT `iss` and base of OAuth redirect URIs. */
  issuer: string;
  /** Cookies get `Secure` and the `__Host-` prefix when the issuer is https. */
  secureCookies: boolean;
  /** Browser origins allowed to use cookie sessions for WebSocket upgrades and state-changing requests. */
  allowedOrigins: ReadonlySet<string>;
  /** DEV_LOGIN === "1". The dev provider additionally needs a local request hostname (devLoginEnabled). */
  devLoginFlag: boolean;
  github: GithubConfig | null;
  google: GoogleConfig | null;
};

export class RelayConfigError extends Error {
  override readonly name = 'RelayConfigError';
}

const GOOGLE_CANONICAL_ISSUER = 'https://accounts.google.com';

export function parseRoomConfig(vars: RelayVars): RoomConfig {
  return {
    hostTimeoutMs: intVar(vars.HOST_TIMEOUT_MS, RELAY_HOST_TIMEOUT_MS, 500, 60_000),
    clientSweepMs: intVar(vars.CLIENT_SWEEP_MS, RELAY_CLIENT_SWEEP_MS, 500, 600_000),
    maxClientSocketsPerWorkspace: intVar(
      vars.MAX_CLIENT_SOCKETS_PER_WORKSPACE,
      DEFAULT_MAX_CLIENT_SOCKETS_PER_WORKSPACE,
      1,
      10_000,
    ),
    maxSocketsPerAccount: intVar(vars.MAX_SOCKETS_PER_ACCOUNT, DEFAULT_MAX_SOCKETS_PER_ACCOUNT, 1, 1_000),
    tapUrl: tapTarget(vars.RELAY_TAP_URL),
  };
}

export function parseRelayConfig(vars: RelayVars): RelayConfig {
  let issuerUrl: URL;
  try {
    issuerUrl = relayOrigin(vars.RELAY_ISSUER ?? '');
  } catch (error) {
    const detail = error instanceof RelayUrlError ? error.message : 'invalid';
    throw new RelayConfigError(`RELAY_ISSUER: ${detail}`);
  }
  return {
    ...parseRoomConfig(vars),
    issuer: issuerUrl.origin,
    secureCookies: issuerUrl.protocol === 'https:',
    allowedOrigins: parseOrigins(vars.ALLOWED_ORIGINS),
    devLoginFlag: vars.DEV_LOGIN === '1',
    github: parseGithub(vars),
    google: parseGoogle(vars),
  };
}

/** The dev-only provider: DEV_LOGIN must be "1" AND the request must address a local hostname (both halves). */
export function devLoginEnabled(config: Pick<RelayConfig, 'devLoginFlag'>, requestUrl: URL): boolean {
  return config.devLoginFlag && isLocalHostname(requestUrl.hostname);
}

/**
 * GET /api/login-options: the login methods open for this request, derived exactly as the login routes decide
 * (a provider is on when its configuration parsed, the dev login through devLoginEnabled). Booleans only: nothing
 * from the configuration itself (client ids, endpoints) ever leaves through here.
 */
export function loginOptionsFor(config: Pick<RelayConfig, 'github' | 'google' | 'devLoginFlag'>, requestUrl: URL): RelayLoginOptions {
  return {
    providers: { github: config.github !== null, google: config.google !== null },
    dev: devLoginEnabled(config, requestUrl),
  };
}

export function isAllowedOrigin(config: Pick<RelayConfig, 'allowedOrigins'>, origin: string | null): boolean {
  return origin !== null && origin !== 'null' && config.allowedOrigins.has(origin);
}

/**
 * The R3 byte tap may only ever post to a collector on this machine: anything else (including a malformed value)
 * disables it. Production keeps RELAY_TAP_URL empty.
 */
export function tapTarget(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!isLocalHostname(url.hostname)) return null;
  return url.href;
}

function intVar(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) return fallback;
  const value = Number(raw);
  return value >= min && value <= max ? value : fallback;
}

function parseOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const candidate = part.trim();
    if (candidate === '') continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const secureEnough = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname));
    // An entry with a path or credentials is a configuration mistake: skip it rather than guess.
    if (!secureEnough || url.origin !== candidate.replace(/\/$/, '')) continue;
    origins.add(url.origin);
  }
  return origins;
}

/** Provider endpoints: https, or plain http only on this machine (the mock IdP in tests). */
function endpoint(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname))) return url.href;
  return null;
}

function clientCredential(raw: string | undefined): string | null {
  if (!raw || raw.length > 512 || /[\s\p{Cc}]/u.test(raw)) return null;
  return raw;
}

function parseGithub(vars: RelayVars): GithubConfig | null {
  const clientId = clientCredential(vars.GITHUB_CLIENT_ID);
  const clientSecret = clientCredential(vars.GITHUB_CLIENT_SECRET);
  const authorizeUrl = endpoint(vars.GITHUB_AUTHORIZE_URL);
  const tokenUrl = endpoint(vars.GITHUB_TOKEN_URL);
  const apiUrl = endpoint(vars.GITHUB_API_URL);
  if (!clientId || !clientSecret || !authorizeUrl || !tokenUrl || !apiUrl) return null;
  return { clientId, clientSecret, authorizeUrl, tokenUrl, apiUrl: apiUrl.replace(/\/$/, '') };
}

function parseGoogle(vars: RelayVars): GoogleConfig | null {
  const clientId = clientCredential(vars.GOOGLE_CLIENT_ID);
  const clientSecret = clientCredential(vars.GOOGLE_CLIENT_SECRET);
  const authorizeUrl = endpoint(vars.GOOGLE_AUTHORIZE_URL);
  const tokenUrl = endpoint(vars.GOOGLE_TOKEN_URL);
  const jwksUrl = endpoint(vars.GOOGLE_JWKS_URL);
  const issuer = vars.GOOGLE_ISSUER?.trim() ?? '';
  if (!clientId || !clientSecret || !authorizeUrl || !tokenUrl || !jwksUrl || issuer === '') return null;
  // Google documents both spellings of its issuer (relay.md gotcha 19); any other issuer is taken literally.
  const issuers = issuer === GOOGLE_CANONICAL_ISSUER ? [GOOGLE_CANONICAL_ISSUER, 'accounts.google.com'] : [issuer];
  return { clientId, clientSecret, authorizeUrl, tokenUrl, jwksUrl, issuers };
}
