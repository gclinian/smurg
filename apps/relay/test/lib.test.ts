// Unit tests of the relay's pure modules (they run unchanged in Node): configuration parsing and its fail-closed
// defaults, cookies, input validation, signing keys and tokens, the device-code login's helpers.
import { RELAY_CLIENT_SWEEP_MS, RELAY_HOST_TIMEOUT_MS, relayLoginOptionsSchema } from '@smurg/protocol/relay';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { makeIdentity, identityClaims, identityFromClaims } from '../src/auth/identity.ts';
import { parseSigningKeys, SigningKeyError } from '../src/auth/keys.ts';
import { OAUTH_TX_TOKEN, SESSION_TOKEN, TokenError, signToken, verifyToken } from '../src/auth/tokens.ts';
import { sha256Base64url, timingSafeEqualString } from '../src/lib/base64url.ts';
import {
  DEFAULT_MAX_CLIENT_SOCKETS_PER_WORKSPACE,
  DEFAULT_MAX_SOCKETS_PER_ACCOUNT,
  RelayConfigError,
  devLoginEnabled,
  isAllowedOrigin,
  loginOptionsFor,
  parseRelayConfig,
  parseRoomConfig,
  tapTarget,
} from '../src/lib/config.ts';
import { clearCookie, cookieNames, readCookie, serializeCookie } from '../src/lib/cookies.ts';
import { ageText, minutesUntil, placeText, randomUserCode, requestPlace } from '../src/lib/device.ts';
import { escapeHtml } from '../src/lib/html.ts';
import { resolveReturnTo } from '../src/lib/validate.ts';
import { generateSigningKey } from '../test-support/index.ts';

const GITHUB = {
  GITHUB_CLIENT_ID: 'Ov23liTest',
  GITHUB_CLIENT_SECRET: 'secret-value',
  GITHUB_AUTHORIZE_URL: 'https://github.com/login/oauth/authorize',
  GITHUB_TOKEN_URL: 'https://github.com/login/oauth/access_token',
  GITHUB_API_URL: 'https://api.github.com/',
};
const GOOGLE = {
  GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret-value',
  GOOGLE_AUTHORIZE_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_JWKS_URL: 'https://www.googleapis.com/oauth2/v3/certs',
  GOOGLE_ISSUER: 'https://accounts.google.com',
};

describe('configuration', () => {
  it('parses a production configuration', () => {
    const config = parseRelayConfig({
      RELAY_ISSUER: 'https://smurg.app',
      ALLOWED_ORIGINS: 'https://smurg.app, https://www.smurg.app',
      DEV_LOGIN: '0',
      ...GITHUB,
      ...GOOGLE,
    });
    expect(config.issuer).toBe('https://smurg.app');
    expect(config.secureCookies).toBe(true);
    expect([...config.allowedOrigins]).toEqual(['https://smurg.app', 'https://www.smurg.app']);
    expect(config.github?.apiUrl).toBe('https://api.github.com');
    expect(config.google?.issuers).toEqual(['https://accounts.google.com', 'accounts.google.com']);
    expect(config.hostTimeoutMs).toBe(RELAY_HOST_TIMEOUT_MS);
    expect(config.clientSweepMs).toBe(RELAY_CLIENT_SWEEP_MS);
    expect(config.maxClientSocketsPerWorkspace).toBe(DEFAULT_MAX_CLIENT_SOCKETS_PER_WORKSPACE);
    expect(config.maxSocketsPerAccount).toBe(DEFAULT_MAX_SOCKETS_PER_ACCOUNT);
    expect(config.tapUrl).toBeNull();
  });

  it('fails closed on a bad issuer', () => {
    for (const issuer of [undefined, '', 'http://smurg.app', 'https://smurg.app/path', 'https://user:pw@smurg.app', 'nope']) {
      expect(() => parseRelayConfig({ RELAY_ISSUER: issuer }), String(issuer)).toThrow(RelayConfigError);
    }
    expect(parseRelayConfig({ RELAY_ISSUER: 'http://localhost:8787' }).secureCookies).toBe(false);
  });

  it('drops malformed or insecure allowed origins', () => {
    const config = parseRelayConfig({
      RELAY_ISSUER: 'https://smurg.app',
      ALLOWED_ORIGINS: 'http://evil.example, https://ok.example/, https://ok.example/path, *, null, http://localhost:5173',
    });
    expect([...config.allowedOrigins]).toEqual(['https://ok.example', 'http://localhost:5173']);
    expect(isAllowedOrigin(config, 'https://ok.example')).toBe(true);
    expect(isAllowedOrigin(config, 'https://ok.example.evil')).toBe(false);
    expect(isAllowedOrigin(config, 'null')).toBe(false);
    expect(isAllowedOrigin(config, null)).toBe(false);
  });

  it('disables a provider when anything about it is missing or unsafe', () => {
    const base = { RELAY_ISSUER: 'https://smurg.app' };
    expect(parseRelayConfig({ ...base, ...GITHUB, GITHUB_CLIENT_SECRET: '' }).github).toBeNull();
    expect(parseRelayConfig({ ...base, ...GITHUB, GITHUB_CLIENT_ID: 'has space' }).github).toBeNull();
    expect(parseRelayConfig({ ...base, ...GITHUB, GITHUB_TOKEN_URL: 'http://github.example/token' }).github).toBeNull();
    expect(parseRelayConfig({ ...base, ...GITHUB, GITHUB_TOKEN_URL: 'http://127.0.0.1:9/token' }).github).not.toBeNull();
    expect(parseRelayConfig({ ...base, ...GOOGLE, GOOGLE_ISSUER: '' }).google).toBeNull();
    expect(parseRelayConfig({ ...base, ...GOOGLE, GOOGLE_ISSUER: 'http://127.0.0.1:9' }).google?.issuers).toEqual(['http://127.0.0.1:9']);
  });

  it('gates the dev provider on DEV_LOGIN=1 AND a local request hostname', () => {
    const on = parseRelayConfig({ RELAY_ISSUER: 'https://smurg.app', DEV_LOGIN: '1' });
    const off = parseRelayConfig({ RELAY_ISSUER: 'https://smurg.app', DEV_LOGIN: 'true' });
    for (const local of ['http://localhost:8787/', 'http://127.0.0.1/', 'http://[::1]:1/', 'http://app.localhost/']) {
      expect(devLoginEnabled(on, new URL(local)), local).toBe(true);
      expect(devLoginEnabled(off, new URL(local)), local).toBe(false);
    }
    for (const remote of ['https://smurg.app/', 'http://localhost.evil.example/', 'http://127.0.0.2/', 'http://10.0.0.1/']) {
      expect(devLoginEnabled(on, new URL(remote)), remote).toBe(false);
    }
  });

  it('login options: one boolean per usable provider, dev only through the dev gate, nothing else', () => {
    const hosts: [string, boolean][] = [
      ['http://localhost:8787/api/login-options', true],
      ['http://127.0.0.1/api/login-options', true],
      ['http://[::1]:1/api/login-options', true],
      ['http://app.localhost/api/login-options', true],
      ['https://smurg.app/api/login-options', false],
      ['http://localhost.evil.example/api/login-options', false],
      ['http://127.0.0.2/api/login-options', false],
    ];
    for (const github of [false, true]) {
      for (const google of [false, true]) {
        for (const flag of [undefined, '0', '1', 'true']) {
          const config = parseRelayConfig({
            RELAY_ISSUER: 'https://smurg.app',
            ...(github ? GITHUB : {}),
            ...(google ? GOOGLE : {}),
            ...(flag === undefined ? {} : { DEV_LOGIN: flag }),
          });
          for (const [url, local] of hosts) {
            const label = `github=${github} google=${google} DEV_LOGIN=${flag} ${url}`;
            const options = loginOptionsFor(config, new URL(url));
            expect(options, label).toEqual({ providers: { github, google }, dev: flag === '1' && local });
            expect(Object.keys(options).sort(), label).toEqual(['dev', 'providers']);
            expect(Object.keys(options.providers).sort(), label).toEqual(['github', 'google']);
            expect(relayLoginOptionsSchema.safeParse(options).success, label).toBe(true);
            const json = JSON.stringify(options);
            for (const secret of [GITHUB.GITHUB_CLIENT_ID, GOOGLE.GOOGLE_CLIENT_ID, 'secret-value', 'https://']) {
              expect(json, label).not.toContain(secret);
            }
          }
        }
      }
    }
    // A provider whose configuration is incomplete is off here exactly as it is for its login route (503).
    const partial = parseRelayConfig({ RELAY_ISSUER: 'https://smurg.app', ...GITHUB, GITHUB_CLIENT_SECRET: '', ...GOOGLE, GOOGLE_ISSUER: '' });
    expect(loginOptionsFor(partial, new URL('https://smurg.app/'))).toEqual({ providers: { github: false, google: false }, dev: false });
  });

  it('only ever taps to a collector on this machine', () => {
    expect(tapTarget(undefined)).toBeNull();
    expect(tapTarget('')).toBeNull();
    expect(tapTarget('http://127.0.0.1:4000/tap')).toBe('http://127.0.0.1:4000/tap');
    expect(tapTarget('http://localhost:4000/tap')).toBe('http://localhost:4000/tap');
    for (const bad of ['https://collector.example/tap', 'http://127.0.0.1.nip.io/tap', 'ftp://127.0.0.1/', 'http://u:p@127.0.0.1/', 'garbage']) {
      expect(tapTarget(bad), bad).toBeNull();
    }
    expect(parseRoomConfig({ RELAY_TAP_URL: 'https://collector.example/tap' }).tapUrl).toBeNull();
  });

  it('falls back to the defaults for out-of-range numbers', () => {
    const room = parseRoomConfig({ HOST_TIMEOUT_MS: '-1', CLIENT_SWEEP_MS: '1e3', MAX_SOCKETS_PER_ACCOUNT: '0', MAX_CLIENT_SOCKETS_PER_WORKSPACE: '999999' });
    expect(room).toMatchObject({
      hostTimeoutMs: RELAY_HOST_TIMEOUT_MS,
      clientSweepMs: RELAY_CLIENT_SWEEP_MS,
      maxSocketsPerAccount: DEFAULT_MAX_SOCKETS_PER_ACCOUNT,
      maxClientSocketsPerWorkspace: DEFAULT_MAX_CLIENT_SOCKETS_PER_WORKSPACE,
    });
    expect(parseRoomConfig({ HOST_TIMEOUT_MS: '3000' }).hostTimeoutMs).toBe(3000);
  });
});

describe('cookies', () => {
  it('uses __Host- names on https and plain names on local http', () => {
    expect(cookieNames(true)).toEqual({ session: '__Host-smurg_session', tx: '__Host-smurg_tx' });
    expect(cookieNames(false)).toEqual({ session: 'smurg_session', tx: 'smurg_tx' });
    expect(serializeCookie('__Host-smurg_session', 'a.b.c', 60, true)).toBe('__Host-smurg_session=a.b.c; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure');
    expect(clearCookie('smurg_tx', false)).toBe('smurg_tx=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect(() => serializeCookie('x', 'a;b', 1, false)).toThrow(TypeError);
  });

  it('treats absent, malformed or ambiguous cookies as no cookie', () => {
    expect(readCookie('a=1; smurg_session=x.y.z; b=2', 'smurg_session')).toBe('x.y.z');
    expect(readCookie(null, 'smurg_session')).toBeNull();
    expect(readCookie('smurg_session=', 'smurg_session')).toBeNull();
    expect(readCookie('smurg_session=a%20b', 'smurg_session')).toBeNull();
    expect(readCookie('smurg_session=a.b; smurg_session=c.d', 'smurg_session')).toBeNull();
    expect(readCookie('smurg_session=a.b; smurg_session=a.b', 'smurg_session')).toBe('a.b');
    expect(readCookie('xsmurg_session=a.b', 'smurg_session')).toBeNull();
  });
});

describe('input validation', () => {
  const issuer = 'https://smurg.app';
  const allowed = new Set(['http://localhost:5173']);

  it('resolves return_to only to the relay or an allow-listed origin', () => {
    expect(resolveReturnTo(null, issuer, allowed)).toBe('https://smurg.app/');
    expect(resolveReturnTo('/join/abc?x=1#k=frag', issuer, allowed)).toBe('https://smurg.app/join/abc?x=1#k=frag');
    expect(resolveReturnTo('http://localhost:5173/w/1', issuer, allowed)).toBe('http://localhost:5173/w/1');
    expect(resolveReturnTo('https://smurg.app/x', issuer, allowed)).toBe('https://smurg.app/x');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', 'http://localhost:5174/', '/a\nb', 'x'.repeat(3000)]) {
      expect(resolveReturnTo(bad, issuer, allowed), bad).toBeNull();
    }
  });

  it('computes S256 like RFC 7636 appendix B and compares in constant time', async () => {
    expect(await sha256Base64url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('identities', () => {
  it('builds valid identities and drops unusable provider data', () => {
    expect(makeIdentity({ provider: 'github', subject: '42', displayName: 'Octo‮Cat', fallbackName: 'octo' })).toEqual({
      userId: 'github:42',
      displayName: 'OctoCat',
      provider: 'github',
    });
    expect(makeIdentity({ provider: 'github', subject: 'abc', displayName: 'x', fallbackName: 'x' })).toBeNull();
    expect(makeIdentity({ provider: 'dev', subject: 'a b', displayName: 'x', fallbackName: 'x' })).toBeNull();
    const withAvatar = makeIdentity({ provider: 'google', subject: '1', displayName: '', fallbackName: 'Google 使用者', avatarUrl: 'http://insecure.example/a.png' });
    expect(withAvatar).toEqual({ userId: 'google:1', displayName: 'Google 使用者', provider: 'google' });
  });

  it('round-trips through claims and rejects inconsistent claims', () => {
    const identity = { userId: 'google:abc', displayName: 'Ada', provider: 'google' as const, avatarUrl: 'https://img.example/a.png' };
    expect(identityFromClaims(identityClaims(identity))).toEqual(identity);
    expect(identityFromClaims({ sub: 'github:1', name: 'x', provider: 'google' })).toBeNull();
    expect(identityFromClaims({ sub: 'dev:x', name: '', provider: 'dev' })).toBeNull();
    expect(identityFromClaims({ sub: 'dev:x', name: 'x', provider: 'dev', picture: 'javascript:1' })).toBeNull();
    expect(identityFromClaims({ sub: 'root', name: 'x', provider: 'dev' })).toBeNull();
  });
});

describe('signing keys and tokens', () => {
  it('publishes only public keys with RFC 7638 kids, and signs with the first key', async () => {
    const active = JSON.parse(await generateSigningKey()) as Record<string, string>;
    const previous = JSON.parse(await generateSigningKey()) as Record<string, string>;
    const { d: _unused, ...previousPublic } = previous;
    const keys = await parseSigningKeys(JSON.stringify({ keys: [active, previousPublic] }));
    expect(keys.kid).toBe(active['kid']);
    expect(keys.jwks.keys.map((k) => k.kid)).toEqual([active['kid'], previous['kid']]);
    expect(JSON.stringify(keys.jwks)).not.toContain('"d"');

    const token = await signToken(keys, 'https://smurg.app', SESSION_TOKEN, { sub: 'dev:x' });
    expect((await verifyToken(keys, 'https://smurg.app', token, SESSION_TOKEN)).sub).toBe('dev:x');
    await expect(verifyToken(keys, 'https://other.example', token, SESSION_TOKEN)).rejects.toThrow(TokenError);
    await expect(verifyToken(keys, 'https://smurg.app', token, OAUTH_TX_TOKEN)).rejects.toThrow(TokenError);

    // A token signed by the previous key (rotation) still verifies.
    const previousKeys = await parseSigningKeys(JSON.stringify(previous));
    const old = await signToken(previousKeys, 'https://smurg.app', SESSION_TOKEN, { sub: 'dev:y' });
    expect((await verifyToken(keys, 'https://smurg.app', old, SESSION_TOKEN)).sub).toBe('dev:y');
  });

  it('refuses unusable key material', async () => {
    const good = JSON.parse(await generateSigningKey()) as Record<string, string>;
    const other = JSON.parse(await generateSigningKey()) as Record<string, string>;
    const { d: _unused, ...publicOnly } = good;
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    for (const bad of [
      'not json',
      JSON.stringify(publicOnly),
      JSON.stringify({ ...good, d: other['d'] }), // d does not belong to x
      JSON.stringify(await exportJWK(privateKey)),
      JSON.stringify({ keys: [] }),
      JSON.stringify({ keys: [good, good] }),
    ]) {
      await expect(parseSigningKeys(bad)).rejects.toThrow(SigningKeyError);
    }
  });
});

describe('device-code login helpers (src/lib/device.ts)', () => {
  it('draws user codes of eight letters from the RFC 8628 alphabet, every letter about equally often', () => {
    const counts = new Map<string, number>();
    const codes = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const code = randomUserCode();
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
      codes.add(code);
      for (const c of code) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(codes.size).toBe(2_000);
    expect(counts.size).toBe(20);
    // 16,000 letters, 800 expected each: rejection sampling keeps the alphabet uniform (no modulo bias).
    for (const [letter, count] of counts) expect(Math.abs(count - 800), letter).toBeLessThan(200);
  });

  it('reads the client address and Cloudflare\'s place, and drops what is not plausible', () => {
    const at = (headers: Record<string, string>, cf?: Record<string, unknown>) =>
      requestPlace(Object.assign(new Request('https://relay.example/auth/device/start', { headers }), cf ? { cf } : {}));
    expect(at({ 'cf-connecting-ip': '203.0.113.7' }, { country: 'TW', city: 'Taipei' })).toEqual({ ip: '203.0.113.7', country: 'TW', city: 'Taipei' });
    expect(at({ 'cf-connecting-ip': '2001:db8::1' })).toEqual({ ip: '2001:db8::1', country: null, city: null });
    expect(at({ 'cf-connecting-ip': '<script>' }, { country: 'taiwan', city: 42 })).toEqual({ ip: null, country: null, city: null });
    expect(at({}, { country: 'TW', city: ` Tai\u0000pei${'x'.repeat(200)}` })).toEqual({ ip: null, country: 'TW', city: `Taipei${'x'.repeat(74)}` });
  });

  it('words the place and the age for the confirmation screen', () => {
    expect(placeText('TW', 'Taipei')).toBe('Taipei，台灣');
    expect(placeText('US', null)).toBe('美國');
    expect(placeText('T1', null)).toBe('Tor 網路');
    expect(placeText('XX', 'Somewhere')).toBe('Somewhere');
    expect(placeText(null, null)).toBe('不明');
    const created = Date.parse('2026-10-01T08:15:30Z');
    expect(ageText(created, created + 59_000)).toBe('不到 1 分鐘前（2026-10-01 08:15 UTC）');
    expect(ageText(created, created + 3 * 60_000 + 1)).toBe('3 分鐘前（2026-10-01 08:15 UTC）');
    expect(minutesUntil(created + 9 * 60_000 + 1, created)).toBe('10 分鐘');
    expect(minutesUntil(created, created)).toBe('1 分鐘');
  });
});
