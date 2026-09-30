// GET /api/login-options on the real Worker (local workerd): the web app asks it which login buttons to show instead of
// probing the login routes. Every combination of configured providers; `dev` only for a local hostname with
// DEV_LOGIN=1 (checked against the dev login itself on the same relay and hostname); exactly the documented fields
// and nothing from the configuration; no session needed; the same no-CORS rules as the other public GET routes.
import { randomBytes } from 'node:crypto';
import { RELAY_AUTH_PROVIDERS, RELAY_PATHS, authLoginPath, loginOptionsUrl, relayLoginOptionsSchema } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';

// Nothing listens on port 9 (discard) and nothing here ever calls a provider: a login route only builds the URL.
const IDP = 'http://127.0.0.1:9';
const GITHUB_CLIENT_ID = `gh-login-options-${randomBytes(6).toString('hex')}`;
const GOOGLE_CLIENT_ID = `google-login-options-${randomBytes(6).toString('hex')}.apps.googleusercontent.com`;
const GITHUB_SECRET = `gh-secret-${randomBytes(12).toString('hex')}`;
const GOOGLE_SECRET = `google-secret-${randomBytes(12).toString('hex')}`;
const GITHUB_VARS = {
  GITHUB_CLIENT_ID,
  GITHUB_AUTHORIZE_URL: `${IDP}/login/oauth/authorize`,
  GITHUB_TOKEN_URL: `${IDP}/login/oauth/access_token`,
  GITHUB_API_URL: `${IDP}/github-api`,
};
const GOOGLE_VARS = {
  GOOGLE_CLIENT_ID,
  GOOGLE_AUTHORIZE_URL: `${IDP}/o/oauth2/v2/auth`,
  GOOGLE_TOKEN_URL: `${IDP}/token`,
  GOOGLE_JWKS_URL: `${IDP}/certs`,
  GOOGLE_ISSUER: IDP,
};
/** Strings of the configuration that must never appear in the answer. */
const CONFIG_STRINGS = [GITHUB_CLIENT_ID, GOOGLE_CLIENT_ID, GITHUB_SECRET, GOOGLE_SECRET, IDP, '127.0.0.1:9'];

const LOCAL_HOSTS = ['http://localhost', 'http://[::1]', 'http://relay.localhost'];
const REMOTE_HOSTS = ['http://relay.example.com', 'https://smurg.app', 'http://localhost.evil.example', 'http://127.0.0.2'];

type Answer = { status: number; headers: Headers; text: string; body: unknown };

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, text, body };
}

/** The request the web app makes: a plain same-origin GET (no Authorization header; cookies travel on their own). */
async function loginOptions(relay: LocalRelay, headers: Record<string, string> = {}): Promise<Answer> {
  return answer(await fetch(loginOptionsUrl(relay.origin), { headers }));
}

/** The same request as the Worker would see it for another hostname. */
async function loginOptionsAt(relay: LocalRelay, host: string, query = ''): Promise<Answer> {
  return answer(await relay.fetch(`${host}${RELAY_PATHS.loginOptions}${query}`));
}

function expectPublicJson(result: Answer, label: string): void {
  expect(result.status, label).toBe(200);
  expect(result.headers.get('content-type'), label).toBe('application/json; charset=utf-8');
  expect(result.headers.get('cache-control'), label).toBe('no-store');
  expect(result.headers.get('x-content-type-options'), label).toBe('nosniff');
  expect(result.headers.get('set-cookie'), label).toBeNull();
  expect(corsHeaders(result.headers), label).toEqual([]);
}

/** Exactly `{ providers: { github, google }, dev }`, every value a boolean, and nothing of the configuration. */
function expectExactShape(result: Answer, label: string): void {
  const body = result.body as Record<string, unknown>;
  expect(Object.keys(body).sort(), label).toEqual(['dev', 'providers']);
  expect(Object.keys(body['providers'] as object).sort(), label).toEqual([...RELAY_AUTH_PROVIDERS].sort());
  expect(relayLoginOptionsSchema.safeParse(body).success, label).toBe(true);
  for (const secret of CONFIG_STRINGS) expect(result.text, label).not.toContain(secret);
}

function corsHeaders(headers: Headers): string[] {
  return [...headers.keys()].filter((name) => name.startsWith('access-control-') || name === 'timing-allow-origin');
}

describe('GET /api/login-options: every combination of configured providers', () => {
  const combinations = [
    { github: false, google: false },
    { github: true, google: false },
    { github: false, google: true },
    { github: true, google: true },
  ];

  it.each(combinations)('github=$github google=$google', async ({ github, google }) => {
    const relay = await startLocalRelay({
      vars: { ...(github ? GITHUB_VARS : {}), ...(google ? GOOGLE_VARS : {}) },
      secrets: { ...(github ? { GITHUB_CLIENT_SECRET: GITHUB_SECRET } : {}), ...(google ? { GOOGLE_CLIENT_SECRET: GOOGLE_SECRET } : {}) },
    });
    try {
      const local = await loginOptions(relay);
      expectPublicJson(local, 'local');
      expect(local.body).toEqual({ providers: { github, google }, dev: true });
      expectExactShape(local, 'local');

      const remote = await loginOptionsAt(relay, 'https://smurg.app');
      expectPublicJson(remote, 'remote');
      expect(remote.body).toEqual({ providers: { github, google }, dev: false });
      expectExactShape(remote, 'remote');

      // It says what the login routes would do: a configured provider starts a login (302 to the IdP, not followed),
      // an unconfigured one refuses with 503.
      for (const provider of RELAY_AUTH_PROVIDERS) {
        const expected = { github, google }[provider] ? 302 : 503;
        const res = await fetch(new URL(authLoginPath(provider), relay.origin), { redirect: 'manual' });
        await res.body?.cancel();
        expect(res.status, provider).toBe(expected);
      }
    } finally {
      await relay.stop();
    }
  });
});

describe('GET /api/login-options: the dev login', () => {
  let devOn: LocalRelay;
  let devOff: LocalRelay;
  const devToken = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'mallory' }) };

  beforeAll(async () => {
    devOn = await startLocalRelay({ vars: { DEV_LOGIN: '1' } });
    devOff = await startLocalRelay({ vars: { DEV_LOGIN: '0' } });
  });

  afterAll(async () => {
    await devOn?.stop();
    await devOff?.stop();
  });

  it('is true only for a local hostname with DEV_LOGIN=1, exactly where the dev login answers', async () => {
    const direct = await loginOptions(devOn);
    expect(direct.body).toEqual({ providers: { github: false, google: false }, dev: true });
    for (const host of LOCAL_HOSTS) {
      const result = await loginOptionsAt(devOn, host);
      expectPublicJson(result, host);
      expect(result.body, host).toEqual({ providers: { github: false, google: false }, dev: true });
      expect((await devOn.fetch(`${host}${RELAY_PATHS.devToken}`, devToken)).status, host).toBe(200);
    }
    for (const host of REMOTE_HOSTS) {
      const result = await loginOptionsAt(devOn, host);
      expectPublicJson(result, host);
      expect(result.body, host).toEqual({ providers: { github: false, google: false }, dev: false });
      expectExactShape(result, host);
      expect((await devOn.fetch(`${host}${RELAY_PATHS.devToken}`, devToken)).status, host).toBe(404);
    }
    // Nothing in the request can switch it on.
    const asked = await loginOptionsAt(devOn, 'https://smurg.app', '?dev=1&provider=dev&DEV_LOGIN=1');
    expect(asked.body).toEqual({ providers: { github: false, google: false }, dev: false });
  });

  it('is false on every hostname with DEV_LOGIN=0', async () => {
    const direct = await loginOptions(devOff);
    expectPublicJson(direct, 'direct');
    expect(direct.body).toEqual({ providers: { github: false, google: false }, dev: false });
    expectExactShape(direct, 'direct');
    expect((await fetch(new URL(RELAY_PATHS.devToken, devOff.origin), devToken)).status).toBe(404);
    for (const host of [...LOCAL_HOSTS, ...REMOTE_HOSTS]) {
      const result = await loginOptionsAt(devOff, host);
      expectPublicJson(result, host);
      expect(result.body, host).toEqual({ providers: { github: false, google: false }, dev: false });
    }
  });
});

describe('GET /api/login-options: a public GET route', () => {
  let relay: LocalRelay;
  const expected = { providers: { github: true, google: false }, dev: true };

  beforeAll(async () => {
    relay = await startLocalRelay({ vars: GITHUB_VARS, secrets: { GITHUB_CLIENT_SECRET: GITHUB_SECRET } });
  });

  afterAll(async () => {
    await relay?.stop();
  });

  it('needs no session and reads none: logged out, logged in, or with a bad credential, the answer is the same', async () => {
    const alice = await relay.devLogin('alice');
    for (const [label, headers] of [
      ['anonymous', {}],
      ['bearer', { authorization: `Bearer ${alice.token}` }],
      ['bad bearer', { authorization: 'Bearer not-a-token' }],
      ['malformed authorization', { authorization: 'Basic Zm9vOmJhcg==' }],
      ['bad cookie', { cookie: 'smurg_session=forged' }],
    ] as const) {
      const result = await loginOptions(relay, headers);
      expectPublicJson(result, label);
      expect(result.body, label).toEqual(expected);
    }
  });

  it('sends no CORS headers to another origin, like jwks, healthz and /api/me', async () => {
    const evil = { origin: 'https://evil.example' };
    const result = await loginOptions(relay, evil);
    expectPublicJson(result, 'login-options');
    expect(result.body).toEqual(expected);
    for (const path of [RELAY_PATHS.jwks, RELAY_PATHS.healthz, RELAY_PATHS.me]) {
      const res = await fetch(new URL(path, relay.origin), { headers: evil });
      await res.body?.cancel();
      expect(corsHeaders(res.headers), path).toEqual([]);
    }
    // A CORS preflight is refused like any other method, and grants nothing.
    const preflight = await fetch(loginOptionsUrl(relay.origin), {
      method: 'OPTIONS',
      headers: { ...evil, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.status).toBe(405);
    expect(await preflight.json()).toEqual({ error: 'method_not_allowed' });
    expect(corsHeaders(preflight.headers)).toEqual([]);
  });

  it('answers GET only, at exactly its path', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const res = await fetch(loginOptionsUrl(relay.origin), { method });
      expect(res.status, method).toBe(405);
      if (method !== 'HEAD') expect(await res.json(), method).toEqual({ error: 'method_not_allowed' });
      else await res.body?.cancel();
    }
    const slash = await fetch(new URL(`${RELAY_PATHS.loginOptions}/`, relay.origin));
    expect(slash.status).toBe(404);
    expect(await slash.json()).toEqual({ error: 'not_found' });
  });
});
