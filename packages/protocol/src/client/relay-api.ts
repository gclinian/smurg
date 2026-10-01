// HTTP API of the relay (ARCHITECTURE §6) as the web app, the CLI and tests use it.
//
//  - cookie mode (browser): the HttpOnly session cookie travels by itself on same-origin requests (the SPA is served
//    by the relay, or proxied by Vite in dev). The browser adds Origin, which the relay checks.
//  - bearer mode (CLI, daemon, tests): `Authorization: Bearer <session token>`; WebSockets carry the same header
//    (undici's `{ headers }` extension), since there is no cookie.
//
// The relay is trusted to say who logged in, nothing else: nothing returned here is ever used as a key.
import { z } from 'zod';
import { DEVICE_CODE_PATTERN, relayDeviceStartSchema, type RelayDeviceStart } from '../relay/device-login.ts';
import { RELAY_USER_ID_PATTERN, relayAvatarUrlSchema, relayDisplayNameSchema } from '../relay/frames.ts';
import { RELAY_PATHS, isWorkspaceId, relayHttpUrl, relayOrigin, wsClientUrl, xferClientUrl } from '../relay/routes.ts';
import { identityTokenSchema } from '../schema/primitives.ts';
import { RelayApiError } from './errors.ts';
import {
  globalWebSocketConstructor,
  type ClientWebSocket,
  type ClientWebSocketConstructor,
  type HeaderWebSocketConstructor,
} from './websocket.ts';

export type RelayAuth = { readonly kind: 'cookie' } | { readonly kind: 'bearer'; readonly token: string };

/** The subset of fetch() the API needs (injectable for tests). */
export type RelayFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    credentials: 'same-origin' | 'omit';
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface RelayApiOptions {
  /** The relay origin, e.g. `https://smurg.app` (http only for localhost). In the browser: `location.origin`. */
  relayUrl: string | URL;
  auth: RelayAuth;
  /** Default: globalThis.fetch. */
  fetch?: RelayFetch;
  /** Default: globalThis.WebSocket. */
  WebSocket?: ClientWebSocketConstructor;
  /** Per HTTP request; default 15 s. */
  timeoutMs?: number;
}

const RELAY_PROVIDERS = ['github', 'google', 'dev'] as const;

const relayUserSchema = z.object({
  userId: z.string().regex(RELAY_USER_ID_PATTERN),
  displayName: relayDisplayNameSchema,
  provider: z.enum(RELAY_PROVIDERS),
  avatarUrl: relayAvatarUrlSchema.optional(),
});
export type RelayUser = z.infer<typeof relayUserSchema>;

const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,8192}$/;

const sessionSchema = z.object({
  token: z.string().regex(BEARER_TOKEN_PATTERN),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: relayUserSchema,
});
export type RelaySession = z.infer<typeof sessionSchema>;

const meSchema = z.object({ user: relayUserSchema });
const identityGrantSchema = z.object({ token: identityTokenSchema, expiresIn: z.number().int().positive() });
export type IdentityTokenGrant = z.infer<typeof identityGrantSchema>;

const claimSchema = z.object({ workspaceId: z.string().refine(isWorkspaceId), created: z.boolean() });
export type WorkspaceClaim = z.infer<typeof claimSchema>;

const errorBodySchema = z.object({ error: z.string().max(64), message: z.string().max(1000).optional() });

/** base64url(SHA-256(...)) without padding, as identityCnf() produces. */
const CNF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEV_USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 15_000;

/** What a Connection needs from the relay. RelayApi implements it; tests substitute a fake. */
export interface ConnectionRelay {
  /** The relay origin (http(s)). */
  readonly origin: URL;
  identityToken(workspaceId: string, cnf: string): Promise<{ readonly token: string }>;
  /** Used to tell "logged out" from "relay down" when a socket cannot be opened (browsers hide the HTTP status). */
  me(): Promise<unknown>;
  createWebSocket(url: string): ClientWebSocket;
}

export class RelayApi implements ConnectionRelay {
  readonly origin: URL;
  readonly auth: RelayAuth;
  private readonly fetchImpl: RelayFetch | undefined;
  private readonly webSocketCtor: ClientWebSocketConstructor | undefined;
  private readonly timeoutMs: number;

  constructor(options: RelayApiOptions) {
    this.origin = relayOrigin(options.relayUrl);
    if (options.auth.kind === 'bearer') {
      if (typeof options.auth.token !== 'string' || !BEARER_TOKEN_PATTERN.test(options.auth.token)) {
        throw new TypeError('bearer token is malformed');
      }
      this.auth = Object.freeze({ kind: 'bearer', token: options.auth.token });
    } else if (options.auth.kind === 'cookie') {
      this.auth = Object.freeze({ kind: 'cookie' });
    } else {
      throw new TypeError('unknown relay auth kind');
    }
    this.fetchImpl = options.fetch;
    this.webSocketCtor = options.WebSocket;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new RangeError('timeoutMs must be positive');
    this.timeoutMs = timeoutMs;
  }

  /** The same relay with a bearer session (e.g. right after devLogin / pollDeviceLogin). */
  withBearer(token: string): RelayApi {
    return new RelayApi({
      relayUrl: this.origin,
      auth: { kind: 'bearer', token },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(this.webSocketCtor ? { WebSocket: this.webSocketCtor } : {}),
      timeoutMs: this.timeoutMs,
    });
  }

  /** GET /api/me: who is logged in. Rejects with RelayApiError status 401 when nobody is. */
  async me(): Promise<RelayUser> {
    return (await this.call('GET', RELAY_PATHS.me, undefined, meSchema)).user;
  }

  /**
   * POST /api/identity-token: a 5-minute relay-signed JWT for the daemon of `workspaceId`, bound to the device key
   * through the blinded commitment `cnf` (identityCnf). Fetch a fresh one per handshake; never log it.
   */
  async identityToken(workspaceId: string, cnf: string): Promise<IdentityTokenGrant> {
    if (!isWorkspaceId(workspaceId)) throw new TypeError('invalid workspace id');
    if (typeof cnf !== 'string' || !CNF_PATTERN.test(cnf)) throw new TypeError('cnf must be the 43-character identityCnf() value');
    return this.call('POST', RELAY_PATHS.identityToken, { workspaceId, cnf }, identityGrantSchema);
  }

  /**
   * POST /api/workspaces: the host claims `workspaceId` (or a random one) and becomes its owner. Claiming an id you
   * already own is idempotent (`created: false`); someone else's id rejects with status 409 'workspace_taken'.
   */
  async claimWorkspace(workspaceId?: string): Promise<WorkspaceClaim> {
    if (workspaceId !== undefined && !isWorkspaceId(workspaceId)) throw new TypeError('invalid workspace id');
    return this.call('POST', RELAY_PATHS.workspaces, workspaceId === undefined ? {} : { workspaceId }, claimSchema);
  }

  /**
   * POST /auth/dev/token: DEV-ONLY login for tests and local development (the relay answers 404 unless DEV_LOGIN=1 and
   * the hostname is local). Returns a bearer session; use `withBearer(session.token)`.
   */
  async devLogin(user: string, displayName?: string): Promise<RelaySession> {
    if (!DEV_USER_PATTERN.test(user)) throw new TypeError('dev user must match [A-Za-z0-9._-]{1,64}');
    return this.call('POST', RELAY_PATHS.devToken, displayName === undefined ? { user } : { user, displayName }, sessionSchema, {
      anonymous: true,
    });
  }

  /**
   * POST /auth/device/start: the first step of the CLI's device-code login (@smurg/protocol/relay device-login.ts).
   * Show the person `verificationUri` and `userCode`; keep `deviceCode` in memory only and poll with it.
   */
  async startDeviceLogin(): Promise<RelayDeviceStart> {
    return this.call('POST', RELAY_PATHS.deviceStart, {}, relayDeviceStartSchema, { anonymous: true });
  }

  /**
   * POST /auth/device/token: the session once the person allowed the login in their browser (issued once). Until then
   * it rejects with RelayApiError status 400 and `code` one of DEVICE_TOKEN_ERRORS: `authorization_pending` (ask
   * again after the interval), `slow_down` (and from now on 5 s more slowly), `access_denied`, `expired_token`.
   */
  async pollDeviceLogin(deviceCode: string): Promise<RelaySession> {
    if (typeof deviceCode !== 'string' || !DEVICE_CODE_PATTERN.test(deviceCode)) throw new TypeError('invalid device code');
    return this.call('POST', RELAY_PATHS.deviceToken, { deviceCode }, sessionSchema, { anonymous: true });
  }

  /** POST /auth/logout: clears the browser cookie. Bearer tokens are stateless; the CLI just forgets its token. */
  async logout(): Promise<void> {
    await this.call('POST', RELAY_PATHS.logout, undefined, null);
  }

  /** wss://…/ws/<id>/client (interactive) or wss://…/xfer/<id>/client (transfer). */
  socketUrl(kind: 'ws' | 'xfer', workspaceId: string): string {
    return kind === 'ws' ? wsClientUrl(this.origin, workspaceId) : xferClientUrl(this.origin, workspaceId);
  }

  /** Opens a relay WebSocket with this API's credentials. */
  createWebSocket(url: string): ClientWebSocket {
    const target = new URL(url);
    const expected = new URL(this.origin);
    expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
    // Credentials only ever go to our own relay.
    if (target.origin !== expected.origin) throw new TypeError('socket URL is not on this relay');
    const Ctor = this.webSocketCtor ?? globalWebSocketConstructor();
    if (this.auth.kind === 'bearer') {
      // Node (undici) only: a browser would read the object as a sub-protocol and fail, but browsers use cookies.
      const WithHeaders = Ctor as unknown as HeaderWebSocketConstructor;
      return new WithHeaders(target.toString(), { headers: { authorization: `Bearer ${this.auth.token}` } });
    }
    return new Ctor(target.toString());
  }

  // ---- plumbing

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T> | null,
    options: { anonymous?: boolean } = {},
  ): Promise<T> {
    const fetchImpl = this.fetchImpl ?? defaultFetch();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.auth.kind === 'bearer' && !options.anonymous) headers['authorization'] = `Bearer ${this.auth.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let status: number;
    let text: string;
    try {
      const response = await fetchImpl(relayHttpUrl(this.origin, path), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: this.auth.kind === 'cookie' ? 'same-origin' : 'omit',
        signal: controller.signal,
        // A redirect would mean we talk to something that is not the relay API.
        redirect: 'error',
      });
      status = response.status;
      text = await response.text();
    } catch (cause) {
      throw new RelayApiError(0, 'network', `relay request ${method} ${path} failed`, { cause });
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) {
      let code = `http_${status}`;
      let message = `relay answered ${status} to ${method} ${path}`;
      const parsed = errorBodySchema.safeParse(safeJson(text));
      if (parsed.success) {
        code = parsed.data.error;
        if (parsed.data.message) message = `${message}: ${parsed.data.message}`;
      }
      throw new RelayApiError(status, code, message);
    }
    if (schema === null) return undefined as T;
    const parsed = schema.safeParse(safeJson(text));
    if (!parsed.success) throw new RelayApiError(0, 'bad_response', `unexpected response to ${method} ${path}`);
    return parsed.data;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function defaultFetch(): RelayFetch {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') throw new TypeError('no global fetch in this runtime; pass one explicitly');
  return f.bind(globalThis) as RelayFetch;
}
