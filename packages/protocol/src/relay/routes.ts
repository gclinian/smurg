import { WORKSPACE_ID_MAX_LENGTH, WORKSPACE_ID_MIN_LENGTH } from '../constants.ts';

// Relay HTTP and WebSocket routes (ARCHITECTURE §6). The Worker, the daemon, the CLI, the web app and its dev proxy all
// build or match paths through this module, so a route is spelled exactly once.

export const RELAY_AUTH_PROVIDERS = ['github', 'google'] as const;
export type RelayAuthProvider = (typeof RELAY_AUTH_PROVIDERS)[number];

export const RELAY_TUNNEL_KINDS = ['ws', 'xfer'] as const;
/** `ws` → WorkspaceDO (interactive traffic, host liveness); `xfer` → TransferDO (file chunks). */
export type RelayTunnelKind = (typeof RELAY_TUNNEL_KINDS)[number];

export const RELAY_TUNNEL_ROLES = ['host', 'client'] as const;
export type RelayTunnelRole = (typeof RELAY_TUNNEL_ROLES)[number];

/** Fixed paths. Methods are listed for documentation; the Worker enforces them. */
export const RELAY_PATHS = {
  /** GET: liveness of the Worker itself (no Durable Object involved). */
  healthz: '/healthz',
  /** GET `?user=<name>`: dev-only login (DEV_LOGIN=1 and a local hostname). */
  devStart: '/auth/dev/start',
  /** POST `{ user }` → bearer token: dev-only login for automated tests. */
  devToken: '/auth/dev/token',
  /**
   * GET / POST (same-origin form): the page where a person logged in to the relay enters the CLI's user code and
   * allows or denies the login (./device-login.ts). Short on purpose: it is typed on a phone.
   */
  device: '/device',
  /** POST → `{ deviceCode, userCode, verificationUri, expiresIn, interval }` (`relayDeviceStartSchema`). */
  deviceStart: '/auth/device/start',
  /** POST `{ deviceCode }` → bearer session once approved; until then 400 with a DEVICE_TOKEN_ERRORS code. */
  deviceToken: '/auth/device/token',
  /** POST: clears the browser session cookie. */
  logout: '/auth/logout',
  /** GET: the current session's identity. */
  me: '/api/me',
  /**
   * GET (no session needed): which login methods this relay offers for this request, as booleans only
   * (`relayLoginOptionsSchema` in ./http.ts).
   */
  loginOptions: '/api/login-options',
  /** POST: the caller claims a workspace id and becomes its owner (only the owner may open host sockets). */
  workspaces: '/api/workspaces',
  /** POST `{ workspaceId, cnf }` → EdDSA identity token for the daemon (ARCHITECTURE §4.2). */
  identityToken: '/api/identity-token',
  /** GET: relay public keys used to verify identity tokens. */
  jwks: '/.well-known/jwks.json',
} as const;

/**
 * Path patterns the Worker must see before static assets (wrangler.jsonc `assets.run_worker_first`). Everything
 * else is the web SPA. Kept here so the relay config, its tests and the Vite dev proxy cannot drift apart.
 */
export const RELAY_WORKER_FIRST_PATTERNS = ['/healthz', '/device', '/auth/*', '/api/*', '/ws/*', '/xfer/*', '/.well-known/*'] as const;

/** Path prefixes the web dev server proxies to the relay dev server (apps/web/vite.config.ts). */
export const RELAY_DEV_PROXY_PREFIXES = ['/healthz', '/device', '/auth/', '/api/', '/ws/', '/xfer/', '/.well-known/'] as const;

export function authLoginPath(provider: RelayAuthProvider): string {
  assertProvider(provider);
  return `/auth/${provider}/login`;
}

export function authCallbackPath(provider: RelayAuthProvider): string {
  assertProvider(provider);
  return `/auth/${provider}/callback`;
}

function assertProvider(provider: string): void {
  if (!(RELAY_AUTH_PROVIDERS as readonly string[]).includes(provider)) throw new RelayUrlError(`unknown auth provider: ${provider}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace ids
// ---------------------------------------------------------------------------------------------------------------

export const WORKSPACE_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${WORKSPACE_ID_MIN_LENGTH},${WORKSPACE_ID_MAX_LENGTH}}$`);

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_ID_PATTERN.test(value);
}

function assertWorkspaceId(workspaceId: string): void {
  if (!isWorkspaceId(workspaceId)) throw new RelayUrlError('invalid workspace id');
}

// ---------------------------------------------------------------------------------------------------------------
// Tunnel routes: /(ws|xfer)/<workspaceId>/(host|client)
// ---------------------------------------------------------------------------------------------------------------

export function tunnelPath(kind: RelayTunnelKind, workspaceId: string, role: RelayTunnelRole): string {
  if (!(RELAY_TUNNEL_KINDS as readonly string[]).includes(kind)) throw new RelayUrlError(`unknown tunnel kind: ${kind}`);
  if (!(RELAY_TUNNEL_ROLES as readonly string[]).includes(role)) throw new RelayUrlError(`unknown tunnel role: ${role}`);
  assertWorkspaceId(workspaceId);
  return `/${kind}/${workspaceId}/${role}`;
}

const TUNNEL_PATH_RE = new RegExp(
  `^/(ws|xfer)/([A-Za-z0-9_-]{${WORKSPACE_ID_MIN_LENGTH},${WORKSPACE_ID_MAX_LENGTH}})/(host|client)$`,
);

export type RelayTunnelRoute = { kind: RelayTunnelKind; workspaceId: string; role: RelayTunnelRole };

/** Worker side: match a request pathname against the tunnel routes (exact match, no trailing slash, no decoding). */
export function matchTunnelPath(pathname: string): RelayTunnelRoute | null {
  const m = TUNNEL_PATH_RE.exec(pathname);
  if (!m) return null;
  return { kind: m[1] as RelayTunnelKind, workspaceId: m[2] as string, role: m[3] as RelayTunnelRole };
}

// ---------------------------------------------------------------------------------------------------------------
// Absolute URLs
// ---------------------------------------------------------------------------------------------------------------

export class RelayUrlError extends Error {
  override readonly name = 'RelayUrlError';
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Hostnames that count as "this machine": gates the dev-only login and the R3 byte tap on the relay, and plain-http
 * relay URLs on the clients. Anything else must use https.
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(h) || h.endsWith('.localhost');
}

/**
 * Validates a relay base URL and returns its origin. Fails closed: only `https:` (or `http:` for a local hostname),
 * no credentials, and no path, query or fragment (the relay serves from the origin root; a silently dropped path
 * would point clients somewhere else).
 */
export function relayOrigin(base: string | URL): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RelayUrlError('relay URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname))) {
    throw new RelayUrlError('relay URL must use https (http only for localhost)');
  }
  if (url.username !== '' || url.password !== '') throw new RelayUrlError('relay URL must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new RelayUrlError('relay URL must be an origin without path, query or fragment');
  }
  return new URL(url.origin);
}

/** Absolute http(s) URL of a relay path, e.g. `relayHttpUrl(base, RELAY_PATHS.me)`. */
export function relayHttpUrl(base: string | URL, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new RelayUrlError('relay path must start with a single "/"');
  return new URL(path, relayOrigin(base)).toString();
}

/** `GET <relay>/api/login-options`: the login methods to offer (response: `relayLoginOptionsSchema`). */
export function loginOptionsUrl(base: string | URL): string {
  return relayHttpUrl(base, RELAY_PATHS.loginOptions);
}

/** `<relay>/device`: where a person enters the CLI's user code. Never with the code in it (phishing). */
export function deviceLoginPageUrl(base: string | URL): string {
  return relayHttpUrl(base, RELAY_PATHS.device);
}

function relayWsUrl(base: string | URL, kind: RelayTunnelKind, workspaceId: string, role: RelayTunnelRole): string {
  const origin = relayOrigin(base);
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  origin.pathname = tunnelPath(kind, workspaceId, role);
  return origin.toString();
}

/** Daemon → WorkspaceDO (interactive traffic and liveness). */
export function wsHostUrl(base: string | URL, workspaceId: string): string {
  return relayWsUrl(base, 'ws', workspaceId, 'host');
}

/** Web / CLI → WorkspaceDO. */
export function wsClientUrl(base: string | URL, workspaceId: string): string {
  return relayWsUrl(base, 'ws', workspaceId, 'client');
}

/** Daemon → TransferDO (file chunks; owner-only, like the host socket). */
export function xferHostUrl(base: string | URL, workspaceId: string): string {
  return relayWsUrl(base, 'xfer', workspaceId, 'host');
}

/** Web / CLI → TransferDO. */
export function xferClientUrl(base: string | URL, workspaceId: string): string {
  return relayWsUrl(base, 'xfer', workspaceId, 'client');
}
