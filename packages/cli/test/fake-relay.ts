// TEST ONLY: the relay's HTTP API as far as the CLI uses it (the routes in the relay README), on 127.0.0.1: dev login, the
// device-code login (start, the token endpoint, and /device standing in for the person in the browser), /api/me and the
// workspace claim. Every request is recorded. Tokens are made up; nothing here is a real credential.
// tunnel(): for a daemon in ANOTHER process (the single executable), the host sockets (/ws/host/…, /xfer/host/…) are
// bridged to an in-memory relay of @smurg/daemon/testing and the JWKS serves its test issuer's key, so a test can
// reach that daemon as a relay client (MemoryRelay.apiFor) — the way the host's web app does.
import { randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_RELAY_FRAME } from '@smurg/protocol';
import type { MemoryRelay, TestIdentityIssuer } from '@smurg/daemon/testing';

type User = { userId: string; displayName: string; provider: 'github' | 'google' | 'dev' };

export interface FakeDeviceLogin {
  readonly deviceCode: string;
  /** `XXXX-XXXX`, as the CLI prints it. */
  readonly userCode: string;
  status: 'pending' | 'approved' | 'denied';
  user?: User;
}

export interface FakeRelay {
  readonly origin: string;
  readonly requests: { method: string; path: string; authorization: string | null; at: number }[];
  /** userId → token of every session issued. */
  readonly tokens: Map<string, User>;
  /** Workspaces claimed, by owner. */
  readonly workspaces: Map<string, string>;
  /** Device-code logins started, by normalised user code. */
  readonly logins: Map<string, FakeDeviceLogin>;
  /** The account a login is allowed as (by /device, the person). */
  loginAs: User;
  /** The person denies the request instead of allowing it on /device (any value). */
  loginError: string | null;
  /** What POST /auth/device/start tells the CLI (seconds). */
  device: { interval: number; expiresIn: number };
  /** POST /auth/device/start answers this instead of a login. */
  startError: { status: number; error: string } | null;
  /**
   * Answers the token endpoint gives before it looks at the login, one per poll: an error code (400), `http_503`, or
   * `network` (the connection is dropped).
   */
  pollScript: string[];
  /** Bridges host sockets to `memory` and serves `issuer`'s key at /.well-known/jwks.json (see the header). */
  tunnel(memory: MemoryRelay, issuer: TestIdentityIssuer): void;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>fake relay</title><p>${text}</p>`);
}

async function text(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await text(req)) || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export async function startFakeRelay(): Promise<FakeRelay> {
  const relay: FakeRelay = {
    origin: '',
    requests: [],
    tokens: new Map(),
    workspaces: new Map(),
    logins: new Map(),
    loginAs: { userId: 'github:4242', displayName: 'Ian', provider: 'github' },
    loginError: null,
    // 1 s (the relay says 5): keeps every test that logs in quick.
    device: { interval: 1, expiresIn: 600 },
    startError: null,
    pollScript: [],
    tunnel: () => {},
    close: async () => {},
  };
  let tunnel: { readonly memory: MemoryRelay; readonly issuer: TestIdentityIssuer } | null = null;
  relay.tunnel = (memory, issuer) => {
    tunnel = { memory, issuer };
  };
  const issue = (user: User): Record<string, unknown> => {
    const token = `fake.${b64url(randomBytes(24))}`;
    relay.tokens.set(token, user);
    return { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user };
  };
  /** What the person does on /device for one login: allow (as loginAs) or, with loginError, deny. */
  const decide = (login: FakeDeviceLogin, decision?: 'allow' | 'deny'): void => {
    if (login.status !== 'pending') return;
    if ((decision ?? (relay.loginError === null ? 'allow' : 'deny')) === 'allow') {
      login.status = 'approved';
      login.user = relay.loginAs;
    } else {
      login.status = 'denied';
    }
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers['authorization'] ?? null;
      relay.requests.push({ method: req.method ?? 'GET', path: url.pathname, authorization: typeof auth === 'string' ? auth : null, at: Date.now() });
      const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? relay.tokens.get(auth.slice(7)) : undefined;
      if (req.method === 'POST' && url.pathname === '/auth/dev/token') {
        const b = await body(req);
        const user = String(b['user'] ?? '');
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) return json(res, 400, { error: 'bad_request' });
        return json(res, 200, issue({ userId: `dev:${user}`, displayName: user, provider: 'dev' }));
      }
      if (req.method === 'POST' && url.pathname === '/auth/device/start') {
        await text(req);
        if (relay.startError) return json(res, relay.startError.status, { error: relay.startError.error });
        let code = '';
        for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
        const login: FakeDeviceLogin = { deviceCode: `${code}.${b64url(randomBytes(32))}`, userCode: `${code.slice(0, 4)}-${code.slice(4)}`, status: 'pending' };
        relay.logins.set(code, login);
        return json(res, 200, { deviceCode: login.deviceCode, userCode: login.userCode, verificationUri: `${relay.origin}/device`, ...relay.device });
      }
      if (req.method === 'POST' && url.pathname === '/auth/device/token') {
        const deviceCode = String((await body(req))['deviceCode'] ?? '');
        const scripted = relay.pollScript.shift();
        if (scripted === 'network') return req.socket.destroy();
        if (scripted === 'http_503') return json(res, 503, { error: 'unavailable' });
        if (scripted !== undefined) return json(res, 400, { error: scripted });
        const code = deviceCode.split('.')[0] ?? '';
        const login = relay.logins.get(code);
        if (!login || login.deviceCode !== deviceCode) return json(res, 400, { error: 'expired_token' });
        if (login.status === 'pending') return json(res, 400, { error: 'authorization_pending' });
        relay.logins.delete(code);
        if (login.status === 'denied' || !login.user) return json(res, 400, { error: 'access_denied' });
        return json(res, 200, issue(login.user));
      }
      // The person's browser on /device: GET stands in for "log in, enter the code shown in the terminal, allow"
      // for every pending login; POST (code, decision) for one login.
      if (req.method === 'GET' && url.pathname === '/device') {
        for (const login of relay.logins.values()) decide(login);
        return html(res, 200, 'ok');
      }
      if (req.method === 'POST' && url.pathname === '/device') {
        const form = new URLSearchParams(await text(req));
        const login = relay.logins.get((form.get('code') ?? '').toUpperCase().replace(/[\s-]/g, ''));
        if (!login || login.status !== 'pending') return html(res, 400, 'wrong code');
        decide(login, form.get('decision') === 'deny' ? 'deny' : 'allow');
        return html(res, 200, 'decided');
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
      if (url.pathname === '/.well-known/jwks.json') {
        if (!tunnel) return json(res, 200, { keys: [] });
        const jwk = tunnel.issuer.publicKey.export({ format: 'jwk' });
        return json(res, 200, { keys: [{ ...jwk, kid: tunnel.issuer.kid, alg: 'EdDSA', use: 'sig' }] });
      }
      return json(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  // Host sockets of a tunnelled workspace: every frame both ways between the remote daemon and the in-memory relay.
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_RELAY_FRAME + 1024 });
  server.on('upgrade', (req, socket, head) => {
    const current = tunnel;
    if (!current) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      const authorization = req.headers['authorization'];
      // Frames the daemon sends before the in-memory relay accepted the socket wait here.
      let early: (string | Uint8Array)[] | null = [];
      const host = current.memory.hostSocketFactory()(`http://memory.invalid${req.url ?? '/'}`, typeof authorization === 'string' ? { authorization } : {}, {
        open: () => {
          const queued = early ?? [];
          early = null;
          for (const frame of queued) host.send(frame);
        },
        message: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            ws.terminate(); // 1005 / 1006 cannot be sent
          }
        },
        error: () => ws.terminate(),
      });
      ws.on('message', (data, isBinary) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        const frame = isBinary ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice() : buffer.toString('utf8');
        if (early) early.push(frame);
        else host.send(frame);
      });
      ws.on('close', () => {
        sockets.delete(ws);
        host.terminate();
      });
      ws.on('error', () => undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const port = (server.address() as AddressInfo).port;
  (relay as { origin: string }).origin = `http://127.0.0.1:${port}`;
  relay.close = () =>
    new Promise<void>((resolve) => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return relay;
}

/**
 * A stand-in for the person's browser opened at the relay's /device: logs in, enters the code from the terminal and
 * allows the request (or denies it, with the fake relay's `loginError`).
 */
export async function browserOpening(url: string): Promise<boolean> {
  const res = await fetch(url);
  await res.text();
  return res.ok;
}
