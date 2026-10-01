// Login and session tests against a mock IdP: GitHub (state + PKCE), Google OIDC (state + nonce + PKCE), cookie vs
// bearer sessions with the Origin allow-list, workspace ownership, the dev-login gate (both halves), and the removed
// CLI loopback routes. The CLI's device-code login: device.test.ts. Every negative case asserts the exact outcome.
import { createHash, randomBytes } from 'node:crypto';
import { RELAY_PATHS, authCallbackPath, authLoginPath, relayHttpUrl } from '@smurg/protocol/relay';
import { SignJWT, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayUpgradeError, startLocalRelay, type DevSession, type LocalRelay, type RelaySocket } from '../test-support/index.ts';
import { CookieBrowser } from './browser.ts';
import { closeAll, open, openClient, randomWorkspaceId, tunnelUrl } from './helpers.ts';
import { GITHUB_USER, GOOGLE_USER, startMockIdp, type MockIdp } from './mock-idp.ts';

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const EVIL_ORIGIN = 'https://evil.example';

let idp: MockIdp;
let relay: LocalRelay;
let alice: DevSession;
let bob: DevSession;

beforeAll(async () => {
  idp = await startMockIdp();
  relay = await startLocalRelay({ vars: idp.vars, secrets: idp.secrets });
  alice = await relay.devLogin('alice');
  bob = await relay.devLogin('bob');
});

afterAll(async () => {
  await relay?.stop();
  await idp?.close();
});

const url = (path: string) => relayHttpUrl(relay.origin, path);

async function me(headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url(RELAY_PATHS.me), { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function browserLogin(provider: 'github' | 'google', returnTo?: string): Promise<CookieBrowser> {
  const browser = new CookieBrowser();
  const start = new URL(url(authLoginPath(provider)));
  if (returnTo !== undefined) start.searchParams.set('return_to', returnTo);
  await browser.get(start.href);
  return browser;
}

describe('GitHub OAuth App flow (browser)', () => {
  it('uses state + PKCE S256 without scope, and sets an HttpOnly SameSite=Lax session cookie', async () => {
    const browser = await browserLogin('github', '/w/abc');
    const authorize = idp.seen.authorize.at(-1);
    expect(authorize?.get('code_challenge_method')).toBe('S256');
    expect(authorize?.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize?.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize?.get('redirect_uri')).toBe(`${relay.origin}${authCallbackPath('github')}`);
    expect(authorize?.has('scope')).toBe(false);

    const [first, , callback] = browser.hops;
    expect(first?.setCookies[0]).toMatch(/^smurg_tx=[^;]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/);
    expect(callback?.url.startsWith(`${relay.origin}${authCallbackPath('github')}?`)).toBe(true);
    expect(callback?.status).toBe(302);
    expect(callback?.location).toBe(`${relay.origin}/w/abc`);
    const session = callback?.setCookies.find((c) => c.startsWith('smurg_session='));
    expect(session).toMatch(/; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/);
    expect(callback?.setCookies.some((c) => c.startsWith('smurg_tx=; ') && c.includes('Max-Age=0'))).toBe(true);
    expect(idp.seen.userAgents.at(-1)).toBe('smurg-relay');

    const result = await me({ cookie: browser.cookieHeader() });
    expect(result.status).toBe(200);
    expect(result.body['user']).toEqual({
      userId: `github:${GITHUB_USER.id}`,
      displayName: GITHUB_USER.name,
      provider: 'github',
      avatarUrl: GITHUB_USER.avatar_url,
    });
  });

  it('rejects a callback with a wrong state, without a transaction cookie, or for another provider', async () => {
    const browser = new CookieBrowser();
    await browser.get(url(authLoginPath('github')), { follow: false });
    expect(browser.jar.has('smurg_tx')).toBe(true);
    const wrongState = new URL(url(authCallbackPath('github')));
    wrongState.searchParams.set('code', 'x');
    wrongState.searchParams.set('state', 'attacker-chosen-state');
    const { res: mismatch, body: mismatchBody } = await browser.get(wrongState.href, { follow: false });
    expect(mismatch.status).toBe(400);
    expect(mismatchBody).toContain('state');
    expect(browser.jar.has('smurg_session')).toBe(false);

    const noTx = await fetch(wrongState, { redirect: 'manual' });
    expect(noTx.status).toBe(400);

    const other = new CookieBrowser();
    await other.get(url(authLoginPath('google')), { follow: false });
    const crossed = await fetch(url(`${authCallbackPath('github')}?code=x&state=y`), {
      redirect: 'manual',
      headers: { cookie: other.cookieHeader() },
    });
    expect(crossed.status).toBe(400);
  });

  it('shows an error when the provider reports one (e.g. the user cancelled)', async () => {
    const browser = new CookieBrowser();
    const { res } = await browser.get(url(authLoginPath('github')), { follow: false });
    const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const denied = new URL(url(authCallbackPath('github')));
    denied.searchParams.set('error', 'access_denied');
    denied.searchParams.set('state', state);
    const { res: result } = await browser.get(denied.href, { follow: false });
    expect(result.status).toBe(400);
    expect(result.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(browser.jar.has('smurg_session')).toBe(false);
  });

  it('refuses return_to values that would redirect off the relay', async () => {
    for (const bad of ['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', '/\\evil.example']) {
      const target = new URL(url(authLoginPath('github')));
      target.searchParams.set('return_to', bad);
      const res = await fetch(target, { redirect: 'manual' });
      expect(res.status, bad).toBe(400);
    }
    const ok = new URL(url(authLoginPath('github')));
    ok.searchParams.set('return_to', `${relay.origin}/join/x`);
    expect((await fetch(ok, { redirect: 'manual' })).status).toBe(302);
  });
});

describe('Google OIDC flow (browser)', () => {
  it('uses state + nonce + PKCE and verifies the id_token against the JWKS', async () => {
    const browser = await browserLogin('google');
    const authorize = idp.seen.authorize.at(-1);
    expect(authorize?.get('scope')).toBe('openid email profile');
    expect(authorize?.get('response_type')).toBe('code');
    expect(authorize?.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize?.get('code_challenge_method')).toBe('S256');
    const result = await me({ cookie: browser.cookieHeader() });
    expect(result.status).toBe(200);
    expect(result.body['user']).toEqual({
      userId: `google:${GOOGLE_USER.sub}`,
      displayName: GOOGLE_USER.name,
      provider: 'google',
      avatarUrl: GOOGLE_USER.picture,
    });
  });

  it.each([
    ['a wrong nonce', { googleNonce: 'replayed-nonce-value' }],
    ['a wrong audience', { googleAudience: 'someone-else.apps.googleusercontent.com' }],
  ])('refuses an id_token with %s', async (_label, behaviour) => {
    Object.assign(idp.behaviour, behaviour);
    try {
      const browser = await browserLogin('google');
      const callback = browser.hops.find((h) => h.url.includes(authCallbackPath('google')));
      expect(callback?.status).toBe(502);
      expect(browser.jar.has('smurg_session')).toBe(false);
    } finally {
      for (const key of Object.keys(behaviour)) delete idp.behaviour[key as keyof typeof idp.behaviour];
    }
  });
});

describe('the removed CLI loopback login (smurg 0.1.0)', () => {
  it('answers 404 on /auth/cli/start and /auth/cli/token, whatever the method, and sets nothing', async () => {
    const authorizeBefore = idp.seen.authorize.length;
    const query = `port=43210&state=${'s'.repeat(20)}&code_challenge=${'A'.repeat(43)}`;
    const form = { 'content-type': 'application/x-www-form-urlencoded', origin: relay.origin, 'sec-fetch-site': 'same-origin' };
    const requests: [string, RequestInit][] = [
      [`/auth/cli/start?${query}&provider=github`, {}],
      [`/auth/cli/start?${query}&provider=dev&user=mallory`, {}],
      ['/auth/cli/start', { method: 'POST', headers: form, body: `${query}&provider=dev&user=mallory` }],
      ['/auth/cli/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x', codeVerifier: 'y'.repeat(43) }) }],
    ];
    for (const [path, init] of requests) {
      const res = await fetch(url(path), { redirect: 'manual', ...init });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'not_found' });
      expect(res.headers.getSetCookie(), path).toEqual([]);
    }
    expect(idp.seen.authorize.length).toBe(authorizeBefore);
    expect(Object.values(RELAY_PATHS).filter((path) => path.startsWith('/auth/cli'))).toEqual([]);
  });
});

describe('sessions and the Origin allow-list', () => {
  async function cookieFor(user: string): Promise<string> {
    const browser = new CookieBrowser();
    await browser.get(url(`${RELAY_PATHS.devStart}?user=${user}`));
    const cookie = browser.cookieHeader();
    expect(cookie).toMatch(/^smurg_session=/);
    return cookie;
  }

  it('accepts cookie WebSockets only from allowed origins, and bearer WebSockets without Origin', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const cookie = await cookieFor('bob');
    const clientUrl = tunnelUrl(relay, 'ws', 'client', workspaceId);
    const sockets: RelaySocket[] = [];
    try {
      sockets.push(await open(clientUrl, { cookie, origin: relay.origin }));
      await expect(open(clientUrl, { cookie, origin: EVIL_ORIGIN })).rejects.toMatchObject({ status: 403 });
      await expect(open(clientUrl, { cookie })).rejects.toMatchObject({ status: 403 });
      await expect(open(clientUrl, { cookie, origin: 'null' })).rejects.toMatchObject({ status: 403 });
      sockets.push(await open(clientUrl, { token: bob.token }));
      sockets.push(await open(clientUrl, { token: bob.token, origin: EVIL_ORIGIN })); // not an ambient credential
    } finally {
      closeAll(...sockets);
    }
  });

  it('refuses sockets without a valid session (401) and never falls back from a bad bearer to the cookie', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const clientUrl = tunnelUrl(relay, 'ws', 'client', workspaceId);
    const keyJwk = JSON.parse(relay.signingKey) as Record<string, string>;
    const key = await importJWK(keyJwk, 'EdDSA');
    const sign = (claims: Record<string, unknown>, opts: { typ?: string; aud?: string; exp?: number; iss?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', kid: keyJwk['kid'] ?? '', typ: opts.typ ?? 'smurg-session+jwt' })
        .setIssuer(opts.iss ?? relay.issuer)
        .setAudience(opts.aud ?? 'smurg-relay')
        .setIssuedAt(opts.exp !== undefined ? opts.exp - 60 : undefined)
        .setExpirationTime(opts.exp ?? '1h')
        .setJti('test')
        .sign(key);
    const claims = { sub: 'dev:bob', name: 'bob', provider: 'dev' };
    // Positive control: the same helper with valid claims is accepted.
    expect((await me({ authorization: `Bearer ${await sign(claims)}` })).status).toBe(200);

    const [header, payload, signature] = bob.token.split('.');
    const tampered = [header, b64url(Buffer.from(JSON.stringify({ ...claims, sub: 'dev:alice' }))), signature].join('.');
    const expired = await sign(claims, { exp: Math.floor(Date.now() / 1000) - 120 });
    const wrongType = await sign(claims, { typ: 'smurg-identity+jwt' });
    const wrongAudience = await sign(claims, { aud: 'smurg-daemon:whatever' });
    const wrongIssuer = await sign(claims, { iss: 'https://other-relay.example' });
    const mismatchedProvider = await sign({ ...claims, provider: 'github' });
    const identity = await relay.identityToken(bob.token, workspaceId, b64url(randomBytes(32)));

    const cases: [string, Record<string, string>][] = [
      ['no credentials', {}],
      ['garbage bearer', { authorization: 'Bearer not.a.jwt' }],
      ['tampered payload', { authorization: `Bearer ${tampered}` }],
      ['expired session', { authorization: `Bearer ${expired}` }],
      ['wrong typ', { authorization: `Bearer ${wrongType}` }],
      ['wrong audience', { authorization: `Bearer ${wrongAudience}` }],
      ['wrong issuer', { authorization: `Bearer ${wrongIssuer}` }],
      ['provider/sub mismatch', { authorization: `Bearer ${mismatchedProvider}` }],
      ['identity token as session', { authorization: `Bearer ${identity}` }],
      ['not a bearer scheme', { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }],
      ['bad bearer next to a good cookie', { authorization: 'Bearer nope', cookie: await cookieFor('bob'), origin: relay.origin }],
    ];
    for (const [label, headers] of cases) {
      const error = await open(clientUrl, { headers, heartbeatMs: false }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(RelayUpgradeError);
      expect((error as RelayUpgradeError).status, label).toBe(401);
      expect((await me(headers)).status, label).toBe(401);
    }
  });

  it('applies the Origin check to cookie-authenticated state changes, and logout clears the cookie', async () => {
    const cookie = await cookieFor('dana');
    const post = (path: string, headers: Record<string, string>, body = '{}') =>
      fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    expect((await post(RELAY_PATHS.workspaces, { cookie, origin: EVIL_ORIGIN })).status).toBe(403);
    expect((await post(RELAY_PATHS.workspaces, { cookie })).status).toBe(403);
    expect((await post(RELAY_PATHS.workspaces, { cookie, origin: relay.origin })).status).toBe(201);
    const cnf = b64url(createHash('sha256').update('x').digest());
    const body = JSON.stringify({ workspaceId: randomWorkspaceId(), cnf });
    expect((await post(RELAY_PATHS.identityToken, { cookie, origin: EVIL_ORIGIN }, body)).status).toBe(403);
    expect((await post(RELAY_PATHS.identityToken, { cookie, origin: relay.origin }, body)).status).toBe(200);

    expect((await post(RELAY_PATHS.logout, { cookie, origin: EVIL_ORIGIN })).status).toBe(403);
    const logout = await post(RELAY_PATHS.logout, { cookie, origin: relay.origin });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()).toEqual(['smurg_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
  });
});

describe('workspace ownership', () => {
  it('lets the first caller claim an id, is idempotent for the owner, and refuses others', async () => {
    const post = (token: string | undefined, body: string, type = 'application/json') =>
      fetch(url(RELAY_PATHS.workspaces), {
        method: 'POST',
        headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body,
      });
    const id = randomWorkspaceId();
    expect((await post(undefined, JSON.stringify({ workspaceId: id }))).status).toBe(401);
    const created = await post(alice.token, JSON.stringify({ workspaceId: id }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ workspaceId: id, created: true });
    const again = await post(alice.token, JSON.stringify({ workspaceId: id }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ workspaceId: id, created: false });
    expect((await post(bob.token, JSON.stringify({ workspaceId: id }))).status).toBe(409);
    expect((await post(alice.token, JSON.stringify({ workspaceId: 'short' }))).status).toBe(400);
    expect((await post(alice.token, JSON.stringify({ workspaceId: id }), 'text/plain')).status).toBe(415);
    const generated = (await (await post(alice.token, '')).json()) as { workspaceId: string };
    expect(generated.workspaceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('allows host sockets (ws and xfer) for the owner only, and no sockets for unclaimed ids', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const sockets: RelaySocket[] = [];
    try {
      for (const kind of ['ws', 'xfer'] as const) {
        await expect(open(tunnelUrl(relay, kind, 'host', workspaceId), { token: bob.token })).rejects.toMatchObject({ status: 403 });
        sockets.push(await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token }));
        sockets.push((await openClient(relay, kind, workspaceId, { token: bob.token })).socket);
        const unclaimed = randomWorkspaceId();
        await expect(open(tunnelUrl(relay, kind, 'client', unclaimed), { token: bob.token })).rejects.toMatchObject({ status: 404 });
        await expect(open(tunnelUrl(relay, kind, 'host', unclaimed), { token: alice.token })).rejects.toMatchObject({ status: 404 });
      }
      // A plain GET on a tunnel route is not an upgrade.
      expect((await fetch(url(`/ws/${workspaceId}/client`), { headers: { authorization: `Bearer ${bob.token}` } })).status).toBe(426);
    } finally {
      closeAll(...sockets);
    }
  });
});

describe('dev-only login gate', () => {
  it('is off on a non-local hostname even with DEV_LOGIN=1 (positive controls on the same relay)', async () => {
    const remote = 'http://relay.example.com';
    const devToken = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'mallory' }) };
    expect((await relay.fetch(`${remote}${RELAY_PATHS.jwks}`)).status).toBe(200);
    expect((await relay.fetch(`${remote}${RELAY_PATHS.devToken}`, devToken)).status).toBe(404);
    expect((await relay.fetch(`${remote}${RELAY_PATHS.devStart}?user=mallory`)).status).toBe(404);
    expect((await relay.fetch(`${remote}/api/debug/room?kind=ws&workspaceId=${randomWorkspaceId()}`)).status).toBe(404);
    // A dev session is not honoured on that hostname either.
    expect((await relay.fetch(`${remote}${RELAY_PATHS.me}`, { headers: { authorization: `Bearer ${alice.token}` } })).status).toBe(401);
    expect((await relay.fetch(`http://localhost${RELAY_PATHS.devToken}`, devToken)).status).toBe(200);
    expect((await relay.fetch(`http://localhost${RELAY_PATHS.me}`, { headers: { authorization: `Bearer ${alice.token}` } })).status).toBe(200);
  });

  it('is off with DEV_LOGIN=0 on a local hostname, and dev tokens signed with the same key are refused there', async () => {
    // Same key and issuer as the dev-enabled relay, so a dev token only fails because of the gate.
    const prodLike = await startLocalRelay({
      vars: { ...idp.vars, DEV_LOGIN: '0', RELAY_ISSUER: relay.origin },
      secrets: { ...idp.secrets, RELAY_SIGNING_KEY: relay.signingKey },
    });
    try {
      const at = (path: string) => relayHttpUrl(prodLike.origin, path);
      const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'mallory' }) };
      expect((await fetch(at(RELAY_PATHS.jwks))).status).toBe(200);
      expect((await fetch(at(RELAY_PATHS.devToken), post)).status).toBe(404);
      expect((await fetch(at(`${RELAY_PATHS.devStart}?user=mallory`), { redirect: 'manual' })).status).toBe(404);
      const chooser = await (await fetch(at(RELAY_PATHS.device))).text();
      expect(chooser).toContain('data-provider="github"');
      expect(chooser).not.toContain('data-provider="dev"');
      await expect(prodLike.devLogin('mallory')).rejects.toThrow(/HTTP 404/);
      expect((await fetch(at(`/api/debug/room?kind=ws&workspaceId=${randomWorkspaceId()}`))).status).toBe(404);

      const devSession = { authorization: `Bearer ${alice.token}` };
      expect((await fetch(at(RELAY_PATHS.me), { headers: devSession })).status).toBe(401);
      // Positive control: a GitHub session from the other relay (same key and issuer) is accepted.
      const github = (await browserLogin('github')).jar.get('smurg_session');
      expect(github).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect((await fetch(at(RELAY_PATHS.me), { headers: { authorization: `Bearer ${github}` } })).status).toBe(200);
    } finally {
      await prodLike.stop();
    }
  });

  it('answers 503 for providers that are not configured', async () => {
    const bare = await startLocalRelay();
    try {
      for (const provider of ['github', 'google'] as const) {
        expect((await fetch(relayHttpUrl(bare.origin, authLoginPath(provider)), { redirect: 'manual' })).status).toBe(503);
      }
    } finally {
      await bare.stop();
    }
  });
});
