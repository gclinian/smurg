// TEST ONLY: the relay's HTTP API as far as the CLI uses it (relay README "路由"), on 127.0.0.1: dev login, the CLI
// loopback login (start → redirect to the CLI's /callback, token exchange bound to the PKCE challenge), /api/me and the
// workspace claim. Every request is recorded. Tokens are made up; nothing here is a real credential.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRelay {
  readonly origin: string;
  readonly requests: { method: string; path: string; authorization: string | null }[];
  /** userId → token of every session issued. */
  readonly tokens: Map<string, { userId: string; displayName: string; provider: string }>;
  /** Workspaces claimed, by owner. */
  readonly workspaces: Map<string, string>;
  /** The user the next CLI loopback login signs in as. */
  loginAs: { userId: string; displayName: string; provider: 'github' | 'google' | 'dev' };
  /** Answer the loopback login with ?error=… instead of a code. */
  loginError: string | null;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

export async function startFakeRelay(): Promise<FakeRelay> {
  const codes = new Map<string, { challenge: string; user: FakeRelay['loginAs'] }>();
  const relay: FakeRelay = {
    origin: '',
    requests: [],
    tokens: new Map(),
    workspaces: new Map(),
    loginAs: { userId: 'github:4242', displayName: 'Ian', provider: 'github' },
    loginError: null,
    close: async () => {},
  };
  const issue = (user: FakeRelay['loginAs']): Record<string, unknown> => {
    const token = `fake.${b64url(randomBytes(24))}`;
    relay.tokens.set(token, user);
    return { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user };
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers['authorization'] ?? null;
      relay.requests.push({ method: req.method ?? 'GET', path: url.pathname, authorization: typeof auth === 'string' ? auth : null });
      const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? relay.tokens.get(auth.slice(7)) : undefined;
      if (req.method === 'POST' && url.pathname === '/auth/dev/token') {
        const b = await body(req);
        const user = String(b['user'] ?? '');
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) return json(res, 400, { error: 'bad_request' });
        return json(res, 200, issue({ userId: `dev:${user}`, displayName: user, provider: 'dev' }));
      }
      if (req.method === 'GET' && url.pathname === '/auth/cli/start') {
        const port = url.searchParams.get('port');
        const state = url.searchParams.get('state') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        const target = new URL(`http://127.0.0.1:${port}/callback`);
        target.searchParams.set('state', state);
        if (relay.loginError) target.searchParams.set('error', relay.loginError);
        else {
          const code = b64url(randomBytes(16));
          codes.set(code, { challenge, user: relay.loginAs });
          target.searchParams.set('code', code);
        }
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/auth/cli/token') {
        const b = await body(req);
        const entry = codes.get(String(b['code'] ?? ''));
        const verifier = String(b['codeVerifier'] ?? '');
        if (!entry || b64url(createHash('sha256').update(verifier).digest()) !== entry.challenge) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(entry.user));
      }
      if (req.method === 'GET' && url.pathname === '/api/me') {
        if (!bearer) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { user: bearer });
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces') {
        if (!bearer) return json(res, 401, { error: 'unauthorized' });
        const b = await body(req);
        const id = String(b['workspaceId'] ?? `ws_${b64url(randomBytes(12))}`);
        const owner = relay.workspaces.get(id);
        if (owner !== undefined && owner !== bearer.userId) return json(res, 409, { error: 'workspace_taken' });
        relay.workspaces.set(id, bearer.userId);
        return json(res, owner === undefined ? 201 : 200, { workspaceId: id, created: owner === undefined });
      }
      if (req.method === 'POST' && url.pathname === '/api/identity-token') {
        // This fake tunnels nothing: a logged-in client is refused (the SDK ends as closed(relay-refused) at once).
        return json(res, bearer ? 403 : 401, { error: bearer ? 'forbidden' : 'unauthorized' });
      }
      if (url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [] });
      return json(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const port = (server.address() as AddressInfo).port;
  (relay as { origin: string }).origin = `http://127.0.0.1:${port}`;
  relay.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return relay;
}

/** A stand-in for the person's browser: follows the relay's redirect to the CLI's loopback callback. */
export async function browserOpening(url: string): Promise<boolean> {
  const first = await fetch(url, { redirect: 'manual' });
  const location = first.headers.get('location');
  if (!location) return false;
  const callback = await fetch(location);
  await callback.text();
  return true;
}
