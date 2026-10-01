// The CLI's device-code login against the real relay (local workerd) and the mock IdP: start → /device needs a login
// (and comes back) → the code, wrong and right, as people type it → the confirmation screen → allow / deny, bound to
// the browser's account → the session, once. Expiry (through the dev-only debug route: nobody waits ten minutes), the
// alarm that deletes it, the rate limits, CSRF, framing, slow_down and the token endpoint's errors. Every negative case
// asserts the exact outcome.
import {
  DEVICE_LOGIN_INTERVAL_SECONDS,
  DEVICE_LOGIN_TTL_SECONDS,
  RELAY_PATHS,
  normalizeDeviceUserCode,
  relayDeviceStartSchema,
  relayHttpUrl,
  type RelayDeviceStart,
} from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_DEBUG_PATH, DEVICE_LIMITS, type DeviceLoginInspection } from '../src/lib/device.ts';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';
import { CookieBrowser } from './browser.ts';
import { sleep } from './helpers.ts';
import { GOOGLE_USER, startMockIdp, type MockIdp } from './mock-idp.ts';

const EVIL_ORIGIN = 'https://evil.example';
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const WARNING = '只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。';
const WRONG_CODE = '代碼不正確或已失效';
const CSRF_REFUSED = '這個要求不是從 relay 的 /device 頁面送出的';

let idp: MockIdp;
let relay: LocalRelay;

beforeAll(async () => {
  idp = await startMockIdp();
  relay = await startLocalRelay({ vars: idp.vars, secrets: idp.secrets });
});

afterAll(async () => {
  await relay?.stop();
  await idp?.close();
});

const url = (path: string) => relayHttpUrl(relay.origin, path);

// Every limit counts per address: each test gets addresses of its own (local workerd keeps a client's CF-Connecting-IP).
let lastIp = 0;
const freshIp = () => `198.51.100.${++lastIp}`;

async function start(ip = freshIp()): Promise<RelayDeviceStart & { userCodeNormalized: string }> {
  const res = await fetch(url(RELAY_PATHS.deviceStart), { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '{}' });
  expect(res.status).toBe(200);
  const body = relayDeviceStartSchema.parse(await res.json());
  return { ...body, userCodeNormalized: normalizeDeviceUserCode(body.userCode) as string };
}

async function poll(deviceCode: string, base = relay.origin): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.fetch(`${base}${RELAY_PATHS.deviceToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function inspect(query: string): Promise<DeviceLoginInspection> {
  const res = await fetch(url(`${DEVICE_DEBUG_PATH}?${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as DeviceLoginInspection;
}

/** A browser at `ip`, logged in to the relay with the dev login, back on /device. */
async function browserAs(user: string, ip = freshIp()): Promise<CookieBrowser> {
  const browser = new CookieBrowser({ 'cf-connecting-ip': ip });
  const { url: landed, body } = await browser.get(url(`${RELAY_PATHS.devStart}?user=${user}&return_to=%2Fdevice`));
  expect(landed).toBe(url(RELAY_PATHS.device));
  expect(body).toContain(`（dev:${user}）`);
  return browser;
}

/** Submits the /device form from the /device page itself (or as told by `how`). */
function submit(browser: CookieBrowser, fields: Record<string, string>, how: { origin?: string | null; site?: string | null } = {}) {
  return browser.submit(url(RELAY_PATHS.device), fields, { origin: relay.origin, ...how, follow: false });
}

function expectDevicePageHeaders(res: Response): void {
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(res.headers.get('content-security-policy')).toBe(HTML_CSP);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('same-origin');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('POST /auth/device/start', () => {
  it('returns a device code, a user code of the RFC 8628 alphabet, the /device URL without the code, 10 minutes, every 5 s', async () => {
    const ip = freshIp();
    const res = await fetch(url(RELAY_PATHS.deviceStart), { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = relayDeviceStartSchema.parse(await res.json());
    expect(body.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.deviceCode.startsWith(`${body.userCode.replace('-', '')}.`)).toBe(true);
    expect(body.verificationUri).toBe(url(RELAY_PATHS.device));
    expect(body.expiresIn).toBe(DEVICE_LOGIN_TTL_SECONDS);
    expect(body.interval).toBe(DEVICE_LOGIN_INTERVAL_SECONDS);
    // Stored under its user code with where it came from (CF-Connecting-IP, request.cf), and an alarm at its expiry.
    const stored = await inspect(`code=${body.userCode}`);
    expect(stored.login).toMatchObject({ userCode: body.userCode.replace('-', ''), status: 'pending', ip, country: 'US', city: 'Austin', userId: null });
    expect((stored.login?.expiresAt ?? 0) - (stored.login?.createdAt ?? 0)).toBe(DEVICE_LOGIN_TTL_SECONDS * 1000);
    expect(stored.alarm).toBe(stored.login?.expiresAt);
    expect(JSON.stringify(stored)).not.toContain(body.deviceCode.split('.')[1] as string);

    const other = await start();
    expect(other.userCode).not.toBe(body.userCode);
    expect(other.deviceCode).not.toBe(body.deviceCode);
  });

  it('answers 405 to anything but POST and 415 to a body that is not JSON', async () => {
    expect((await fetch(url(RELAY_PATHS.deviceStart))).status).toBe(405);
    const form = await fetch(url(RELAY_PATHS.deviceStart), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
    expect(form.status).toBe(415);
  });
});

describe('GET /device', () => {
  it('without a session offers the relay login, which comes back to /device; then the code form names the account', async () => {
    const res = await fetch(url(RELAY_PATHS.device));
    expect(res.status).toBe(200);
    expectDevicePageHeaders(res);
    const html = await res.text();
    expect(html).toContain('<h1>登入 smurg CLI</h1>');
    expect(html).toContain('href="/auth/google/login?return_to=%2Fdevice"');
    expect(html).toContain('href="/auth/github/login?return_to=%2Fdevice"');
    expect(html).toContain('<form method="get" action="/auth/dev/start" data-provider="dev"><input type="hidden" name="return_to" value="/device">');
    expect(html).not.toContain('name="code"');

    // The dev login (its GET form) and Google (through the mock IdP) both land on /device with a session.
    const dev = new CookieBrowser();
    const { url: landed, body } = await dev.get(url(`${RELAY_PATHS.devStart}?return_to=%2Fdevice&user=erin`));
    expect(landed).toBe(url(RELAY_PATHS.device));
    expect(body).toContain('<strong>erin</strong>（dev:erin）');
    expect(body).toContain('<form method="post" action="/device" data-testid="device-code-form">');
    const google = new CookieBrowser();
    const viaGoogle = await google.get(url('/auth/google/login?return_to=%2Fdevice'));
    expect(viaGoogle.url).toBe(url(RELAY_PATHS.device));
    expect(viaGoogle.body).toContain(`<strong>${GOOGLE_USER.name}</strong>（google:${GOOGLE_USER.sub}）`);
    expectDevicePageHeaders(viaGoogle.res);

    // Not on a local hostname: no dev login offered.
    const remote = await (await relay.fetch(`http://relay.example.com${RELAY_PATHS.device}`)).text();
    expect(remote).toContain('使用 Google 登入');
    expect(remote).not.toContain('/auth/dev/start');
    expect((await fetch(url(RELAY_PATHS.device), { method: 'PUT' })).status).toBe(405);
  });

  it('never takes a code from its URL (a prefilled link would serve phishing)', async () => {
    const login = await start();
    const browser = await browserAs('fay');
    const { res, body } = await browser.get(url(`${RELAY_PATHS.device}?code=${login.userCode}&user_code=${login.userCode}`));
    expect(res.status).toBe(200);
    expect(body).not.toContain(login.userCode);
    expect(body).not.toContain(login.userCodeNormalized);
    expect((await inspect(`code=${login.userCode}`)).login?.status).toBe('pending');
  });
});

describe('entering the code', () => {
  it('a wrong code is refused with a clear message; the right one, typed any way, opens the confirmation screen', async () => {
    const ip = freshIp();
    const login = await start(ip);
    const browser = await browserAs('frank');
    const wrongCode = login.userCodeNormalized === 'BCDFGHJK' ? 'BCDFGHJL' : 'BCDFGHJK';
    const wrong = await submit(browser, { code: wrongCode });
    expect(wrong.res.status).toBe(400);
    expectDevicePageHeaders(wrong.res);
    expect(wrong.body).toContain(WRONG_CODE);
    expect(wrong.body).toContain(`value="${wrongCode}"`);
    const garbage = await submit(browser, { code: '<script>x</script>' });
    expect(garbage.res.status).toBe(400);
    expect(garbage.body).toContain('value="&lt;script&gt;x&lt;/script&gt;"');

    const typed = ` ${login.userCode.toLowerCase().replace('-', ' ')} `;
    const confirm = await submit(browser, { code: typed });
    expect(confirm.res.status).toBe(200);
    expectDevicePageHeaders(confirm.res);
    expect(confirm.body).toContain('<h1>允許 smurg CLI 登入嗎？</h1>');
    expect(confirm.body).toContain('<dd data-testid="device-account"><strong>frank</strong>（dev:frank）</dd>');
    expect(confirm.body).toContain(`<dd class="code" data-testid="device-user-code">${login.userCode}</dd>`);
    expect(confirm.body).toMatch(new RegExp(`IP 位址 ${ip.replace(/\./g, '\\.')}，位置大約在 Austin，(美國|US)`));
    expect(confirm.body).toMatch(/不到 1 分鐘前（\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC）/);
    expect(confirm.body).toContain(WARNING);
    expect(confirm.body).toContain(`<input type="hidden" name="code" value="${login.userCodeNormalized}">`);
    expect(confirm.body).toContain('<input type="hidden" name="account" value="dev:frank">');
    expect(confirm.body).toContain('<button type="submit" name="decision" value="allow">允許</button>');
    expect(confirm.body).toContain('<button type="submit" name="decision" value="deny">拒絕</button>');
    // Seeing the screen decides nothing.
    expect((await poll(login.deviceCode)).body).toEqual({ error: 'authorization_pending' });
    // Full-width input from an input method works too.
    const fullWidth = login.userCode.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace('-', '－');
    expect((await submit(browser, { code: fullWidth })).res.status).toBe(200);
  });

  it('allow: the CLI gets a session of the account that allowed it, once; afterwards the code is gone for everybody', async () => {
    const login = await start();
    const gina = await browserAs('gina');
    expect((await submit(gina, { code: login.userCode })).res.status).toBe(200);
    const allowed = await submit(gina, { code: login.userCodeNormalized, account: 'dev:gina', decision: 'allow' });
    expect(allowed.res.status).toBe(200);
    expectDevicePageHeaders(allowed.res);
    expect(allowed.body).toContain('<h1>已允許</h1>');
    expect((await inspect(`code=${login.userCode}`)).login).toMatchObject({ status: 'approved', userId: 'dev:gina' });

    // Another account cannot take it over before the CLI collects it: a wrong code for them, decision or not.
    const mallory = await browserAs('mallory');
    const seen = await submit(mallory, { code: login.userCode });
    expect(seen.res.status).toBe(400);
    expect(seen.body).toContain(WRONG_CODE);
    const forced = await submit(mallory, { code: login.userCodeNormalized, account: 'dev:mallory', decision: 'allow' });
    expect(forced.res.status).toBe(400);
    expect(forced.body).toContain(WRONG_CODE);
    // Nor can the same account decide twice.
    const again = await submit(gina, { code: login.userCodeNormalized, account: 'dev:gina', decision: 'deny' });
    expect(again.res.status).toBe(400);

    const issued = await poll(login.deviceCode);
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: { userId: 'dev:gina', displayName: 'gina', provider: 'dev' } });
    const me = await fetch(url(RELAY_PATHS.me), { headers: { authorization: `Bearer ${String(issued.body['token'])}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { userId: string } }).user.userId).toBe('dev:gina');
    // One-time: the record and its alarm are gone, the next poll is expired_token.
    expect(await inspect(`code=${login.userCode}`)).toEqual({ login: null, window: null, alarm: null });
    expect(await poll(login.deviceCode)).toEqual({ status: 400, body: { error: 'expired_token' } });
  });

  it('deny: the CLI is told access_denied once, then the login is gone', async () => {
    const login = await start();
    const hank = await browserAs('hank');
    const denied = await submit(hank, { code: login.userCodeNormalized, account: 'dev:hank', decision: 'deny' });
    expect(denied.res.status).toBe(200);
    expect(denied.body).toContain('<h1>已拒絕</h1>');
    expect(await poll(login.deviceCode)).toEqual({ status: 400, body: { error: 'access_denied' } });
    expect(await poll(login.deviceCode)).toEqual({ status: 400, body: { error: 'expired_token' } });
    expect((await inspect(`code=${login.userCode}`)).login).toBeNull();
  });

  it('a decision counts only for the account the confirmation screen named; anything else changes nothing', async () => {
    const login = await start();
    const ivy = await browserAs('ivy');
    const switched = await submit(ivy, { code: login.userCodeNormalized, account: 'dev:someone-else', decision: 'allow' });
    expect(switched.res.status).toBe(409);
    expect(switched.body).toContain('帳號在這段時間內換過了');
    const unknown = await submit(ivy, { code: login.userCodeNormalized, account: 'dev:ivy', decision: 'maybe' });
    expect(unknown.res.status).toBe(400);
    // Logged out (no cookie): the login page again, nothing decided.
    const anonymous = new CookieBrowser();
    const loggedOut = await submit(anonymous, { code: login.userCodeNormalized, account: 'dev:ivy', decision: 'allow' });
    expect(loggedOut.res.status).toBe(200);
    expect(loggedOut.body).toContain('<h1>登入 smurg CLI</h1>');
    expect((await inspect(`code=${login.userCode}`)).login?.status).toBe('pending');
  });
});

describe('expiry and one-time use', () => {
  it('an expired login answers expired_token, is unknown to /device, and its alarm deletes it', async () => {
    const login = await start();
    const res = await fetch(url(`${DEVICE_DEBUG_PATH}?code=${login.userCode}&expire=1`), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await poll(login.deviceCode)).toEqual({ status: 400, body: { error: 'expired_token' } });
    const jack = await browserAs('jack');
    const late = await submit(jack, { code: login.userCode });
    expect(late.res.status).toBe(400);
    expect(late.body).toContain(WRONG_CODE);
    const deadline = Date.now() + 10_000;
    let stored = await inspect(`code=${login.userCode}`);
    while (stored.login !== null && Date.now() < deadline) {
      await sleep(100);
      stored = await inspect(`code=${login.userCode}`);
    }
    expect(stored).toEqual({ login: null, window: null, alarm: null });
  });

  it('the debug route is dev-only: 404 on a hostname that is not local', async () => {
    const login = await start();
    expect((await relay.fetch(`http://relay.example.com${DEVICE_DEBUG_PATH}?code=${login.userCode}`)).status).toBe(404);
    expect((await relay.fetch(`http://relay.example.com${DEVICE_DEBUG_PATH}?code=${login.userCode}&expire=1`, { method: 'POST' })).status).toBe(404);
  });
});

describe('the token endpoint', () => {
  it('slow_down for polls faster than the interval (5 s more each time); a forged device code changes nothing', async () => {
    const login = await start();
    expect((await poll(login.deviceCode)).body).toEqual({ error: 'authorization_pending' });
    expect((await poll(login.deviceCode)).body).toMatchObject({ error: 'slow_down' });
    expect((await poll(login.deviceCode)).body).toMatchObject({ error: 'slow_down' });

    const other = await start();
    const forged = `${other.userCodeNormalized}.${'A'.repeat(43)}`;
    expect(await poll(forged)).toEqual({ status: 400, body: { error: 'expired_token' } });
    expect(await poll(forged)).toEqual({ status: 400, body: { error: 'expired_token' } });
    // The real CLI's first poll is not "too fast" because of the forged ones, and one after the interval is on time.
    expect((await poll(other.deviceCode)).body).toEqual({ error: 'authorization_pending' });
    await sleep((DEVICE_LOGIN_INTERVAL_SECONDS - 1) * 1000 + 200);
    expect((await poll(other.deviceCode)).body).toEqual({ error: 'authorization_pending' });
  });

  it('answers invalid_request to malformed requests and 405 to anything but POST', async () => {
    const post = (body: string, type = 'application/json') =>
      fetch(url(RELAY_PATHS.deviceToken), { method: 'POST', headers: { 'content-type': type }, body }).then(async (res) => ({ status: res.status, body: await res.json() }));
    const invalid = { status: 400, body: { error: 'invalid_request', message: 'expected { deviceCode } as JSON' } };
    expect(await post('{}')).toEqual(invalid);
    expect(await post('not json')).toEqual(invalid);
    expect(await post(JSON.stringify({ deviceCode: 'WDJB-MJHT' }))).toEqual(invalid);
    expect(await post(JSON.stringify({ deviceCode: `WDJBMJHT.${'a'.repeat(43)}` }), 'text/plain')).toEqual(invalid);
    expect(await post(JSON.stringify({ deviceCode: `wdjbmjht.${'a'.repeat(43)}` }))).toEqual(invalid);
    expect((await fetch(url(RELAY_PATHS.deviceToken))).status).toBe(405);
    // A well-formed code nobody started: indistinguishable from an expired one.
    expect(await post(JSON.stringify({ deviceCode: `WDJBMJHT.${'a'.repeat(43)}` }))).toEqual({ status: 400, body: { error: 'expired_token' } });
  });

  it('a session of a dev account is only issued where the dev login itself is open', async () => {
    const login = await start();
    const kim = await browserAs('kim');
    expect((await submit(kim, { code: login.userCodeNormalized, account: 'dev:kim', decision: 'allow' })).res.status).toBe(200);
    expect(await poll(login.deviceCode, 'http://relay.example.com')).toEqual({ status: 400, body: { error: 'access_denied' } });
  });
});

describe('rate limits', () => {
  it(`wrong codes: ${DEVICE_LIMITS.wrongCodesPerAccount} per account, then a clear message (even for the right code); another account still gets in`, async () => {
    const login = await start();
    const leo = await browserAs('leo');
    const wrongCode = login.userCodeNormalized === 'BCDFGHJK' ? 'BCDFGHJL' : 'BCDFGHJK';
    for (let i = 0; i < DEVICE_LIMITS.wrongCodesPerAccount; i++) expect((await submit(leo, { code: wrongCode })).res.status, `attempt ${i + 1}`).toBe(400);
    const blocked = await submit(leo, { code: login.userCode });
    expect(blocked.res.status).toBe(429);
    expect(blocked.body).toMatch(/輸入錯誤的次數太多，請在 (9|10) 分鐘後再試。/);
    expect(blocked.body).not.toContain('允許 smurg CLI 登入嗎？');
    // Refused without being counted (no write), and the window is the account's: another account gets in.
    expect((await inspect('limit=code-account&key=dev:leo')).window?.count).toBe(DEVICE_LIMITS.wrongCodesPerAccount);
    const mia = await browserAs('mia');
    expect((await submit(mia, { code: login.userCode })).res.status).toBe(200);
  });

  it(`wrong codes: ${DEVICE_LIMITS.wrongCodesPerIp} per address, whichever accounts enter them`, async () => {
    const login = await start();
    const ip = freshIp();
    const wrongCode = login.userCodeNormalized === 'BCDFGHJK' ? 'BCDFGHJL' : 'BCDFGHJK';
    const perAccount = DEVICE_LIMITS.wrongCodesPerAccount;
    for (let account = 0; account * perAccount < DEVICE_LIMITS.wrongCodesPerIp; account++) {
      const browser = await browserAs(`nat${account}`, ip);
      for (let i = 0; i < perAccount; i++) expect((await submit(browser, { code: wrongCode })).res.status).toBe(400);
    }
    const sameAddress = await browserAs('ned', ip);
    const blocked = await submit(sameAddress, { code: login.userCode });
    expect(blocked.res.status).toBe(429);
    expect(blocked.body).toContain('輸入錯誤的次數太多');
    const elsewhere = await browserAs('ned');
    expect((await submit(elsewhere, { code: login.userCode })).res.status).toBe(200);
  });

  it(`logins started: ${DEVICE_LIMITS.startsPerIp} per address, then 429 with Retry-After`, async () => {
    const ip = freshIp();
    for (let i = 0; i < DEVICE_LIMITS.startsPerIp; i++) await start(ip);
    const res = await fetch(url(RELAY_PATHS.deviceStart), { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '{}' });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'too_many_requests' });
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(DEVICE_LIMITS.windowMs / 1000 - 60);
    expect(retryAfter).toBeLessThanOrEqual(DEVICE_LIMITS.windowMs / 1000);
    expect((await inspect(`limit=start-ip&key=${ip}`)).window?.count).toBe(DEVICE_LIMITS.startsPerIp);
    await start(); // another address
  });
});

describe('CSRF and clickjacking', () => {
  it('only the /device page itself can submit a code or a decision', async () => {
    const login = await start();
    const olga = await browserAs('olga');
    const fields = { code: login.userCodeNormalized, account: 'dev:olga', decision: 'allow' };
    const refused: [string, { origin: string | null; site?: string | null }][] = [
      ['no Origin', { origin: null, site: null }],
      ['Origin null', { origin: 'null', site: null }],
      ['another site', { origin: EVIL_ORIGIN, site: 'cross-site' }],
      ['another site without Sec-Fetch-Site', { origin: EVIL_ORIGIN, site: null }],
      ['a sibling origin', { origin: 'http://127.0.0.1:1', site: 'same-site' }],
      ['a forged Origin but cross-site fetch metadata', { origin: relay.origin, site: 'cross-site' }],
    ];
    for (const [label, how] of refused) {
      const { res, body } = await submit(olga, fields, how);
      expect(res.status, label).toBe(403);
      expect(body, label).toContain(CSRF_REFUSED);
      expect(res.headers.get('x-frame-options'), label).toBe('DENY');
    }
    const json = await fetch(url(RELAY_PATHS.device), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: relay.origin, 'sec-fetch-site': 'same-origin', cookie: olga.cookieHeader() },
      body: JSON.stringify(fields),
    });
    expect(json.status).toBe(415);
    expect((await inspect(`code=${login.userCode}`)).login?.status).toBe('pending');
    // Positive control: the same request from the page itself.
    expect((await submit(olga, fields)).body).toContain('<h1>已允許</h1>');
  });

  it('no /device page may be framed: CSP frame-ancestors and X-Frame-Options on every one', async () => {
    const login = await start();
    const pat = await browserAs('pat');
    const pages = [
      await fetch(url(RELAY_PATHS.device)),
      (await pat.get(url(RELAY_PATHS.device))).res,
      (await submit(pat, { code: login.userCode })).res,
      (await submit(pat, { code: login.userCodeNormalized, account: 'dev:pat', decision: 'deny' })).res,
    ];
    for (const res of pages) expectDevicePageHeaders(res);
  });
});
