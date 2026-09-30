// Login and session tests against a mock IdP: GitHub (state + PKCE), Google OIDC (state + nonce + PKCE), the CLI
// loopback flow, cookie vs bearer sessions with the Origin allow-list, workspace ownership, and the dev-login gate
// (both halves). Every negative case asserts the exact outcome.
import { createHash, randomBytes } from 'node:crypto';
import { RELAY_PATHS, authCallbackPath, authLoginPath, relayHttpUrl } from '@smurg/protocol/relay';
import { SignJWT, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayUpgradeError, startLocalRelay, type DevSession, type LocalRelay, type RelaySocket } from '../test-support/index.ts';
import { cliConfirmCode } from '../src/lib/validate.ts';
import { CookieBrowser, loopbackListener, metaRefreshTarget, type Hop } from './browser.ts';
import { closeAll, open, openClient, randomWorkspaceId, tunnelUrl } from './helpers.ts';
import { GITHUB_USER, GOOGLE_USER, startMockIdp, type MockIdp } from './mock-idp.ts';

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
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

function cliStartUrl(fields: Record<string, string>): string {
  const start = new URL(url(RELAY_PATHS.cliStart));
  for (const [k, v] of Object.entries(fields)) start.searchParams.set(k, v);
  return start.href;
}

/**
 * Runs the CLI loopback flow like a browser: the link only shows the confirmation page (nothing reaches the IdP or
 * the listener), the person continues with the page's same-origin form, and the relay's pages lead on to the
 * listener. Returns the loopback parameters, the listener's PKCE verifier and every hop.
 */
async function cliFlow(query: Record<string, string>): Promise<{ params: URLSearchParams; verifier: string; state: string; hops: Hop[]; port: number }> {
  const listener = await loopbackListener();
  try {
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(24));
    const fields = { port: String(listener.port), state, code_challenge: s256(verifier), ...query };
    const browser = new CookieBrowser();
    const authorizeBefore = idp.seen.authorize.length;
    const confirm = await browser.get(cliStartUrl(fields), { meta: true });
    expect(confirm.res.status).toBe(200);
    expect(confirm.body).toContain('<form method="post" action="/auth/cli/start"');
    expect(listener.requests).toEqual([]);
    expect(idp.seen.authorize.length).toBe(authorizeBefore);
    await browser.submit(url(RELAY_PATHS.cliStart), fields, { origin: relay.origin, meta: true });
    return { params: await listener.callback, verifier, state, hops: browser.hops, port: listener.port };
  } finally {
    await listener.close();
  }
}

async function cliToken(code: string, codeVerifier: string): Promise<Response> {
  return fetch(url(RELAY_PATHS.cliToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier }),
  });
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

describe('CLI loopback login', () => {
  it('returns a PKCE-bound code to 127.0.0.1 that only the verifier holder can exchange (GitHub)', async () => {
    const { params, verifier, state } = await cliFlow({ provider: 'github' });
    expect(params.get('state')).toBe(state);
    const code = params.get('code') ?? '';
    expect(code).not.toBe('');

    const wrong = await cliToken(code, b64url(randomBytes(48)));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'pkce_mismatch' });
    const garbage = await cliToken('not-a-code', verifier);
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: 'invalid_code' });

    const ok = await cliToken(code, verifier);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; tokenType: string; user: { userId: string } };
    expect(body.tokenType).toBe('Bearer');
    expect(body.user.userId).toBe(`github:${GITHUB_USER.id}`);
    expect((await me({ authorization: `Bearer ${body.token}` })).body['user']).toMatchObject({ userId: `github:${GITHUB_USER.id}` });
  });

  it('works with the dev provider and shows every configured choice without a provider', async () => {
    const { params, verifier } = await cliFlow({ provider: 'dev', user: 'carol' });
    const ok = await cliToken(params.get('code') ?? '', verifier);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { userId: string } }).user.userId).toBe('dev:carol');

    const state = b64url(randomBytes(24));
    const page = await fetch(cliStartUrl({ port: '43210', state, code_challenge: s256('x'.repeat(43)) }));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('name="provider" value="github"');
    expect(html).toContain('name="provider" value="google"');
    expect(html).toContain('name="provider" value="dev"');
    expect(html).toContain(await cliConfirmCode(state));
  });

  it('ends at a relay page that continues to 127.0.0.1, never a redirect to it (OWNER-01)', async () => {
    // Chromium applies the submitting page's CSP form-action to every redirect of a form submission, so a 302 to the
    // loopback after the dev form (or after an IdP's consent form) is blocked. cli-login.browser.test.ts proves the
    // flow in a real browser; here the exact responses.
    const queries: Record<string, string>[] = [{ provider: 'dev', user: 'carol' }, { provider: 'github' }, { provider: 'google' }];
    for (const query of queries) {
      const { hops, port } = await cliFlow(query);
      const loopback = `http://127.0.0.1:${port}/`;
      const reached = hops.findIndex((hop) => hop.url.startsWith(loopback));
      expect(reached, JSON.stringify(query)).toBe(hops.length - 1);
      expect(hops.filter((hop) => hop.location?.startsWith(loopback)), JSON.stringify(query)).toEqual([]);
      const last = hops[reached - 1];
      expect(last?.url.startsWith(relay.origin), JSON.stringify(query)).toBe(true);
      expect(last?.status, JSON.stringify(query)).toBe(200);
    }

    const listenerPort = '43210';
    const state = b64url(randomBytes(24));
    const fields = { port: listenerPort, state, code_challenge: s256('x'.repeat(43)), provider: 'dev', user: 'carol' };
    const { res, body } = await new CookieBrowser().submit(url(RELAY_PATHS.cliStart), fields, { origin: relay.origin, follow: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const target = new URL(metaRefreshTarget(body) ?? '');
    expect(`${target.origin}${target.pathname}`).toBe(`http://127.0.0.1:${listenerPort}/callback`);
    expect(target.searchParams.get('state')).toBe(state);
    expect(target.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body).toContain(`href="${target.href.replace(/&/g, '&amp;')}"`);
  });

  it('forwards a provider error to the CLI listener instead of a code', async () => {
    const listener = await loopbackListener();
    try {
      const verifier = b64url(randomBytes(48));
      const fields = { port: String(listener.port), state: 'cli-state-0123456789', code_challenge: s256(verifier), provider: 'github' };
      const browser = new CookieBrowser();
      const { res, body } = await browser.submit(url(RELAY_PATHS.cliStart), fields, { origin: relay.origin, follow: false });
      expect(res.status).toBe(200);
      expect(browser.jar.has('smurg_tx')).toBe(true);
      const providerState = new URL(metaRefreshTarget(body) ?? '').searchParams.get('state') ?? '';
      expect(providerState).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await browser.get(url(`${authCallbackPath('github')}?error=access_denied&state=${providerState}`), { meta: true });
      const params = await listener.callback;
      expect(params.get('error')).toBe('access_denied');
      expect(params.get('state')).toBe('cli-state-0123456789');
      expect(params.has('code')).toBe(false);
    } finally {
      await listener.close();
    }
  });

  it('rejects malformed CLI parameters', async () => {
    const challenge = s256('y'.repeat(43));
    const cases = [
      `port=80&state=${'s'.repeat(20)}&code_challenge=${challenge}`,
      `port=70000&state=${'s'.repeat(20)}&code_challenge=${challenge}`,
      `port=43210&state=short&code_challenge=${challenge}`,
      `port=43210&state=${'s'.repeat(20)}&code_challenge=plain-challenge`,
      `state=${'s'.repeat(20)}&code_challenge=${challenge}`,
      `port=43210&state=${'s'.repeat(20)}&code_challenge=${challenge}&provider=gitlab`,
      `port=43210&state=${'s'.repeat(20)}&code_challenge=${challenge}&provider=dev&user=bad%20name`,
    ];
    for (const query of cases) {
      const res = await fetch(url(`${RELAY_PATHS.cliStart}?${query}`), { redirect: 'manual' });
      expect(res.status, query).toBe(400);
      const posted = await new CookieBrowser().submit(url(RELAY_PATHS.cliStart), Object.fromEntries(new URLSearchParams(query)), {
        origin: relay.origin,
        follow: false,
      });
      expect(posted.res.status, `POST ${query}`).toBe(400);
    }
  });
});

describe('CLI login confirmation (SEC-E-03)', () => {
  it('never signs in from a link: GET with any provider only shows the confirmation page', async () => {
    const listener = await loopbackListener();
    try {
      for (const provider of ['github', 'google', 'dev']) {
        const state = b64url(randomBytes(24));
        const fields: Record<string, string> = { port: String(listener.port), state, code_challenge: s256(b64url(randomBytes(48))), provider };
        if (provider === 'dev') fields['user'] = 'mallory';
        const authorizeBefore = idp.seen.authorize.length;
        const browser = new CookieBrowser();
        const { res, body, url: landed } = await browser.get(cliStartUrl(fields), { meta: true });
        expect(res.status, provider).toBe(200);
        expect(landed, provider).toBe(cliStartUrl(fields));
        expect(res.headers.getSetCookie(), provider).toEqual([]);
        expect(res.headers.get('content-security-policy'), provider).toContain("frame-ancestors 'none'");
        expect(res.headers.get('referrer-policy'), provider).toBe('same-origin');
        expect(idp.seen.authorize.length, provider).toBe(authorizeBefore);
        expect(body, provider).toContain(await cliConfirmCode(state));
        expect(body, provider).toContain('只有在你剛剛自己在終端機執行了 <code>smurg login</code>');
        // Only the requested provider is offered, and only as a POST form.
        expect(body.match(/<form /g)?.length, provider).toBe(1);
        expect(body, provider).toContain(`<form method="post" action="/auth/cli/start" data-provider="${provider}">`);
        expect(body, provider).not.toMatch(/href="[^"]*provider=/);
      }
      expect(listener.requests).toEqual([]);
    } finally {
      await listener.close();
    }
  });

  it('continues only from a same-origin form POST of the confirmation page', async () => {
    const listener = await loopbackListener();
    try {
      const verifier = b64url(randomBytes(48));
      const fields = { port: String(listener.port), state: b64url(randomBytes(24)), code_challenge: s256(verifier) };
      const refused: [string, { origin: string | null; site?: string | null }, Record<string, string>][] = [
        ['no Origin', { origin: null, site: null }, { provider: 'github' }],
        ['Origin null', { origin: 'null', site: null }, { provider: 'github' }],
        ['another site', { origin: EVIL_ORIGIN, site: 'cross-site' }, { provider: 'github' }],
        ['another site without Sec-Fetch-Site', { origin: EVIL_ORIGIN, site: null }, { provider: 'dev', user: 'mallory' }],
        ['a sibling origin', { origin: 'http://127.0.0.1:1', site: 'same-site' }, { provider: 'dev', user: 'mallory' }],
        ['a forged Origin but cross-site fetch metadata', { origin: relay.origin, site: 'cross-site' }, { provider: 'google' }],
        ['a forged Origin but same-site fetch metadata', { origin: relay.origin, site: 'same-site' }, { provider: 'dev', user: 'mallory' }],
      ];
      const authorizeBefore = idp.seen.authorize.length;
      for (const [label, how, extra] of refused) {
        const browser = new CookieBrowser();
        const { res, body } = await browser.submit(url(RELAY_PATHS.cliStart), { ...fields, ...extra }, { ...how, meta: true });
        expect(res.status, label).toBe(403);
        expect(body, label).toContain('不是從 relay 的確認頁面送出的');
        expect(browser.jar.size, label).toBe(0);
      }
      const json = await fetch(url(RELAY_PATHS.cliStart), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: relay.origin, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ ...fields, provider: 'dev', user: 'mallory' }),
      });
      expect(json.status).toBe(415);
      expect(idp.seen.authorize.length).toBe(authorizeBefore);
      expect(listener.requests).toEqual([]);

      // Positive control: the same request from the page itself goes on to the IdP through a relay page.
      const browser = new CookieBrowser();
      const { res, body } = await browser.submit(url(RELAY_PATHS.cliStart), { ...fields, provider: 'github' }, { origin: relay.origin, follow: false });
      expect(res.status).toBe(200);
      expect(metaRefreshTarget(body)?.startsWith(`${idp.base}/login/oauth/authorize?`)).toBe(true);
      expect(browser.jar.has('smurg_tx')).toBe(true);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    } finally {
      await listener.close();
    }
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
    const cli = `port=43210&state=${'s'.repeat(20)}&code_challenge=${s256('z'.repeat(43))}&provider=dev&user=mallory`;
    expect((await relay.fetch(`${remote}${RELAY_PATHS.cliStart}?${cli}`)).status).toBe(404);
    const confirm = (host: string) =>
      relay.fetch(`${host}${RELAY_PATHS.cliStart}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: relay.origin, 'sec-fetch-site': 'same-origin' },
        body: cli,
      });
    expect((await confirm(remote)).status).toBe(404);
    expect((await confirm('http://localhost')).status).toBe(200);
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
      const cli = `port=43210&state=${'s'.repeat(20)}&code_challenge=${s256('z'.repeat(43))}`;
      expect((await fetch(at(`${RELAY_PATHS.cliStart}?${cli}&provider=dev&user=mallory`))).status).toBe(404);
      const confirm = await new CookieBrowser().submit(at(RELAY_PATHS.cliStart), Object.fromEntries(new URLSearchParams(`${cli}&provider=dev&user=mallory`)), {
        origin: prodLike.origin,
        follow: false,
      });
      expect(confirm.res.status).toBe(404);
      const chooser = await (await fetch(at(`${RELAY_PATHS.cliStart}?${cli}`))).text();
      expect(chooser).not.toContain('value="dev"');
      await expect(prodLike.devLogin('mallory')).rejects.toThrow(/HTTP 404/);
      expect((await fetch(at(`/api/debug/room?kind=ws&workspaceId=${randomWorkspaceId()}`))).status).toBe(404);

      const devSession = { authorization: `Bearer ${alice.token}` };
      expect((await fetch(at(RELAY_PATHS.me), { headers: devSession })).status).toBe(401);
      // Positive control: a GitHub session from the other relay (same key and issuer) is accepted.
      const { params, verifier } = await cliFlow({ provider: 'github' });
      const github = (await (await cliToken(params.get('code') ?? '', verifier)).json()) as { token: string };
      expect((await fetch(at(RELAY_PATHS.me), { headers: { authorization: `Bearer ${github.token}` } })).status).toBe(200);
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
