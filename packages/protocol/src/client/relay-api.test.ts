import { describe, expect, it } from 'vitest';
import { RelayApiError } from './errors.ts';
import { RelayApi, type RelayFetch } from './relay-api.ts';
import type { ClientWebSocket, ClientWebSocketConstructor } from './websocket.ts';

type Call = Parameters<RelayFetch>[1] & { url: string };

function fakeFetch(respond: (call: Call) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const fetch: RelayFetch = async (url, init) => {
    const call = { url, ...init };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    const text = result.body === undefined ? '' : typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return { status: result.status, text: async () => text };
  };
  return { fetch, calls };
}

const USER = { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' };
const SESSION = { token: 'aaa.bbb.ccc', tokenType: 'Bearer', expiresIn: 604800, user: USER };
const WS = 'ws_relay_api_test1';
const CNF = 'A'.repeat(43);

describe('RelayApi, cookie mode (browser)', () => {
  it('GET /api/me with same-origin credentials and no Authorization header', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { user: USER } }));
    const api = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch });
    expect(await api.me()).toEqual(USER);
    expect(calls[0]).toMatchObject({ url: 'https://smurg.app/api/me', method: 'GET', credentials: 'same-origin', redirect: 'error' });
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('POST /api/identity-token with a JSON body; returns the token', async () => {
    const token = 'eyJh.eyJz.c2ln';
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { token, expiresIn: 300 } }));
    const api = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch });
    expect(await api.identityToken(WS, CNF)).toEqual({ token, expiresIn: 300 });
    expect(calls[0]).toMatchObject({ url: 'https://smurg.app/api/identity-token', method: 'POST' });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ workspaceId: WS, cnf: CNF });
  });

  it('validates arguments before calling the relay', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const api = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch });
    await expect(api.identityToken('bad', CNF)).rejects.toThrow(TypeError);
    await expect(api.identityToken(WS, 'raw-device-key')).rejects.toThrow(TypeError);
    await expect(api.claimWorkspace('../x')).rejects.toThrow(TypeError);
    await expect(api.devLogin('a b')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP errors to RelayApiError with the relay error code', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: 'invalid_session', message: 'session is invalid or expired' } }));
    const api = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch });
    const error = await api.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayApiError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_session', isUnauthorized: true });
  });

  it('network failures and unexpected bodies are status 0', async () => {
    const down = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch: fakeFetch(() => new TypeError('fetch failed')).fetch });
    await expect(down.me()).rejects.toMatchObject({ status: 0, code: 'network' });
    const odd = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch: fakeFetch(() => ({ status: 200, body: '<html>' })).fetch });
    await expect(odd.me()).rejects.toMatchObject({ status: 0, code: 'bad_response' });
    const badToken = new RelayApi({
      relayUrl: 'https://smurg.app',
      auth: { kind: 'cookie' },
      fetch: fakeFetch(() => ({ status: 200, body: { token: 'not a jwt', expiresIn: 300 } })).fetch,
    });
    await expect(badToken.identityToken(WS, CNF)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('claims a workspace (409 when someone else owns it)', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      JSON.parse(call.body ?? '{}').workspaceId === 'taken_workspace_01'
        ? { status: 409, body: { error: 'workspace_taken' } }
        : { status: 201, body: { workspaceId: 'random_workspace_1', created: true } },
    );
    const api = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch });
    expect(await api.claimWorkspace()).toEqual({ workspaceId: 'random_workspace_1', created: true });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({});
    await expect(api.claimWorkspace('taken_workspace_01')).rejects.toMatchObject({ status: 409, code: 'workspace_taken' });
  });

  it('logout posts to /auth/logout', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
    await new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, fetch }).logout();
    expect(calls[0]).toMatchObject({ url: 'https://smurg.app/auth/logout', method: 'POST' });
  });

  it('opens WebSockets without headers (the cookie travels by itself)', () => {
    const created: unknown[][] = [];
    const Ctor = function (this: unknown, ...args: unknown[]) {
      created.push(args);
      return { binaryType: 'blob' } as unknown as ClientWebSocket;
    } as unknown as ClientWebSocketConstructor;
    const api = new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'cookie' }, WebSocket: Ctor });
    api.createWebSocket(api.socketUrl('ws', WS));
    expect(created).toEqual([[`wss://smurg.app/ws/${WS}/client`]]);
    expect(api.socketUrl('xfer', WS)).toBe(`wss://smurg.app/xfer/${WS}/client`);
    // Never to another host.
    expect(() => api.createWebSocket(`wss://evil.example/ws/${WS}/client`)).toThrow(TypeError);
  });
});

describe('RelayApi, bearer mode (CLI, tests)', () => {
  it('sends Authorization on API calls and on WebSockets (undici headers), never cookies', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { user: USER } }));
    const created: unknown[][] = [];
    const Ctor = function (this: unknown, ...args: unknown[]) {
      created.push(args);
      return {} as ClientWebSocket;
    } as unknown as ClientWebSocketConstructor;
    const api = new RelayApi({ relayUrl: 'http://127.0.0.1:8787', auth: { kind: 'bearer', token: 'abc.def.ghi' }, fetch, WebSocket: Ctor });
    await api.me();
    expect(calls[0]).toMatchObject({ credentials: 'omit', headers: { authorization: 'Bearer abc.def.ghi' } });
    api.createWebSocket(api.socketUrl('ws', WS));
    expect(created).toEqual([[`ws://127.0.0.1:8787/ws/${WS}/client`, { headers: { authorization: 'Bearer abc.def.ghi' } }]]);
  });

  it('dev login and CLI code exchange are anonymous calls that return a bearer session', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: SESSION }));
    const anonymous = new RelayApi({ relayUrl: 'http://localhost:8787', auth: { kind: 'cookie' }, fetch });
    const session = await anonymous.devLogin('amy', 'Amy');
    expect(session).toEqual(SESSION);
    expect(calls[0]).toMatchObject({ url: 'http://localhost:8787/auth/dev/token', method: 'POST' });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ user: 'amy', displayName: 'Amy' });
    const bearer = anonymous.withBearer(session.token);
    expect(bearer.auth).toEqual({ kind: 'bearer', token: 'aaa.bbb.ccc' });
    await bearer.exchangeCliCode('code.jwt.x', 'v'.repeat(43));
    expect(calls[1]).toMatchObject({ url: 'http://localhost:8787/auth/cli/token' });
    expect(calls[1]?.headers['authorization']).toBeUndefined();
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ code: 'code.jwt.x', codeVerifier: 'v'.repeat(43) });
  });

  it('refuses malformed tokens and non-https remote relays', () => {
    expect(() => new RelayApi({ relayUrl: 'https://smurg.app', auth: { kind: 'bearer', token: 'a b' } })).toThrow(TypeError);
    expect(() => new RelayApi({ relayUrl: 'http://smurg.app', auth: { kind: 'cookie' } })).toThrow();
    expect(() => new RelayApi({ relayUrl: 'https://smurg.app/path', auth: { kind: 'cookie' } })).toThrow();
  });
});
