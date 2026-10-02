// The relay's own HTML pages in both languages (src/lib/strings.ts, src/lib/locale.ts):
//   · which language a request gets: the smurg_lang cookie, then Accept-Language, then English;
//   · the visible switch: `?lang=` stores the choice in the cookie and comes back to the same page (303);
//   · every page, in English and in zh-TW, compared with the catalog (and a handful of literal sentences per language,
//     so a wrong catalog entry is caught too);
//   · the JSON API keeps answering codes with English messages whatever the language.
// Every request names its language explicitly.
import { LOCALES, intlTag, type Locale } from '@smurg/protocol/locale';
import { RELAY_PATHS, authCallbackPath, authLoginPath, normalizeDeviceUserCode, relayDeviceStartSchema, relayHttpUrl } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_LIMITS } from '../src/lib/device.ts';
import { deviceResultPage, errorPage, escapeHtml } from '../src/lib/html.ts';
import { languageLinks, localeCookie, pageLocale } from '../src/lib/locale.ts';
import { STRINGS } from '../src/lib/strings.ts';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';
import { ACCEPT_ENGLISH, ACCEPT_ZH_TW, CookieBrowser } from './browser.ts';
import { GOOGLE_USER, startMockIdp, type MockIdp } from './mock-idp.ts';

const ACCEPT: Record<Locale, { 'accept-language': string }> = { en: ACCEPT_ENGLISH, 'zh-TW': ACCEPT_ZH_TW };
const PAGE_VARY = 'Accept-Language, Cookie';

let idp: MockIdp;
let relay: LocalRelay;
/** A relay without any provider (the login routes answer their "not set up" page). */
let bare: LocalRelay;

beforeAll(async () => {
  idp = await startMockIdp();
  [relay, bare] = await Promise.all([startLocalRelay({ vars: idp.vars, secrets: idp.secrets }), startLocalRelay()]);
});

afterAll(async () => {
  await Promise.all([relay?.stop(), bare?.stop()]);
  await idp?.close();
});

const url = (path: string) => relayHttpUrl(relay.origin, path);

let lastIp = 0;
const freshIp = () => `198.51.100.${100 + ++lastIp}`;

async function startLogin(ip = freshIp()): Promise<{ userCode: string; normalized: string; ip: string }> {
  const res = await fetch(url(RELAY_PATHS.deviceStart), { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '{}' });
  const body = relayDeviceStartSchema.parse(await res.json());
  return { userCode: body.userCode, normalized: normalizeDeviceUserCode(body.userCode) as string, ip };
}

/** A browser of `locale`, logged in with the dev login. */
async function browserAs(user: string, locale: Locale, extra: Record<string, string> = {}): Promise<CookieBrowser> {
  const browser = new CookieBrowser({ ...ACCEPT[locale], 'cf-connecting-ip': freshIp(), ...extra });
  const { url: landed } = await browser.get(url(`${RELAY_PATHS.devStart}?user=${user}&return_to=%2Fdevice`));
  expect(landed).toBe(url(RELAY_PATHS.device));
  return browser;
}

const submit = (browser: CookieBrowser, fields: Record<string, string>, how: { origin?: string | null } = {}) =>
  browser.submit(url(RELAY_PATHS.device), fields, { origin: relay.origin, ...how, follow: false });

function expectPage(html: string, locale: Locale, state: string, title: string): void {
  expect(html).toContain(`<html lang="${intlTag(locale)}">`);
  expect(html).toContain(`<body data-state="${state}">`);
  expect(html).toContain(`<title>${escapeHtml(title)}</title>`);
  expect(html).toContain(`<h1>${escapeHtml(title)}</h1>`);
}

const SWITCH = (path: string, current: Locale, label: string) =>
  `<nav class="lang" aria-label="${label}">` +
  `<a href="${path}lang=en" lang="en" hreflang="en" data-lang="en"${current === 'en' ? ' aria-current="true"' : ''}>English</a> · ` +
  `<a href="${path}lang=zh-TW" lang="zh-Hant-TW" hreflang="zh-Hant-TW" data-lang="zh-TW"${current === 'zh-TW' ? ' aria-current="true"' : ''}>繁體中文</a></nav>`;

describe('which language a page is in', () => {
  it('the smurg_lang cookie first, then the first supported Accept-Language entry in q order, then English', async () => {
    const cases: [label: string, headers: Record<string, string>, expected: Locale][] = [
      ['no Accept-Language at all', { 'accept-language': '' }, 'en'],
      ['en-US', { 'accept-language': 'en-US,en;q=0.9' }, 'en'],
      ['zh-TW', { 'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8' }, 'zh-TW'],
      ['zh-HK is Traditional Chinese', { 'accept-language': 'zh-HK' }, 'zh-TW'],
      ['zh-Hant', { 'accept-language': 'zh-Hant' }, 'zh-TW'],
      ['zh-CN is not', { 'accept-language': 'zh-CN,zh;q=0.9' }, 'en'],
      ['bare zh is not', { 'accept-language': 'zh' }, 'en'],
      ['zh-Hans-TW is not', { 'accept-language': 'zh-Hans-TW' }, 'en'],
      ['English before Chinese', { 'accept-language': 'en-US,zh-TW;q=0.9' }, 'en'],
      ['an unsupported language first', { 'accept-language': 'ja,zh-TW;q=0.9,en;q=0.8' }, 'zh-TW'],
      ['q order, not header order', { 'accept-language': 'en;q=0.5,zh-TW;q=0.9' }, 'zh-TW'],
      ['q=0 is not acceptable', { 'accept-language': 'zh-TW;q=0,en;q=0.1' }, 'en'],
      ['only unsupported languages', { 'accept-language': 'ja,fr;q=0.8' }, 'en'],
      ['the cookie beats Accept-Language (zh-TW)', { 'accept-language': 'en-US', cookie: 'smurg_lang=zh-TW' }, 'zh-TW'],
      ['the cookie beats Accept-Language (en)', { 'accept-language': 'zh-TW', cookie: 'smurg_lang=en' }, 'en'],
      ['a cookie that is not one of the two ids is ignored', { 'accept-language': 'zh-TW', cookie: 'smurg_lang=fr' }, 'zh-TW'],
      ['a language tag is not a stored choice', { 'accept-language': 'en', cookie: 'smurg_lang=zh-Hant' }, 'en'],
      ['an ambiguous cookie is ignored', { 'accept-language': 'en', cookie: 'smurg_lang=zh-TW; smurg_lang=en' }, 'en'],
    ];
    for (const [label, headers, expected] of cases) {
      expect(pageLocale(new Request('https://relay.example/device', { headers })), label).toBe(expected);
      const res = await fetch(url(RELAY_PATHS.device), { headers });
      expect(res.status, label).toBe(200);
      expect(res.headers.get('vary'), label).toBe(PAGE_VARY);
      expect(res.headers.get('cache-control'), label).toBe('no-store');
      expectPage(await res.text(), expected, 'login', STRINGS[expected].loginTitle);
    }
  });

  it('the JSON API never picks a language: codes and English messages for a zh-TW client', async () => {
    const headers = { ...ACCEPT_ZH_TW, cookie: 'smurg_lang=zh-TW' };
    const me = await fetch(url(RELAY_PATHS.me), { headers });
    expect(me.status).toBe(401);
    expect(me.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await me.json()).toEqual({ error: 'unauthorized', message: 'login required' });
    const token = await fetch(url(RELAY_PATHS.deviceToken), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    expect(await token.json()).toEqual({ error: 'invalid_request', message: 'expected { deviceCode } as JSON' });
    const missing = await fetch(url('/auth/nothing'), { headers });
    expect(await missing.json()).toEqual({ error: 'not_found' });
    // A form that is not a form: the error is JSON, also on the page route.
    const notForm = await fetch(url(RELAY_PATHS.device), { method: 'POST', headers: { ...headers, origin: relay.origin, 'content-type': 'text/plain' }, body: 'x' });
    expect(await notForm.json()).toEqual({ error: 'unsupported_media_type', message: 'expected a form' });
  });
});

describe('the language switch', () => {
  it('every page that answers a GET shows both languages as plain links; the current one is marked', async () => {
    for (const locale of LOCALES) {
      const label = STRINGS[locale].languageSwitchLabel;
      const login = await (await fetch(url(RELAY_PATHS.device), { headers: ACCEPT[locale] })).text();
      expect(login).toContain(SWITCH('/device?', locale, label));
      const browser = await browserAs(`switch-${locale.toLowerCase()}`, locale);
      const code = (await browser.get(url(RELAY_PATHS.device))).body;
      expect(code).toContain(SWITCH('/device?', locale, label));
      // A login route's error page keeps its own query in the links.
      const badLink = await (await fetch(url(`${authLoginPath('google')}?return_to=${encodeURIComponent('https://evil.example/')}`), { headers: ACCEPT[locale], redirect: 'manual' })).text();
      expect(badLink).toContain(SWITCH('/auth/google/login?return_to=https%3A%2F%2Fevil.example%2F&amp;', locale, label));
    }
    expect(languageLinks(new URL('https://relay.example/device?code=WDJB-MJHT&lang=en'), { keepQuery: false })).toEqual({
      en: '/device?lang=en',
      'zh-TW': '/device?lang=zh-TW',
    });
    expect(languageLinks(new URL('https://relay.example/auth/dev/start?user=a%20b&lang=en&lang=fr'), { keepQuery: true })).toEqual({
      en: '/auth/dev/start?user=a+b&lang=en',
      'zh-TW': '/auth/dev/start?user=a+b&lang=zh-TW',
    });
  });

  it('GET <page>?lang= stores the choice in the cookie and answers 303 to the same path, every other parameter kept', async () => {
    const cookie = (locale: Locale) => `smurg_lang=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const cases: [path: string, location: string, locale: Locale][] = [
      ['/device?lang=zh-TW', '/device', 'zh-TW'],
      ['/device?lang=en', '/device', 'en'],
      ['/device?lang=ZH_tw', '/device', 'zh-TW'],
      ['/device?a=1&lang=en&b=%2Fx', '/device?a=1&b=%2Fx', 'en'],
      ['/auth/google/login?return_to=%2Fdevice&lang=zh-TW', '/auth/google/login?return_to=%2Fdevice', 'zh-TW'],
      ['/auth/dev/start?user=amy&lang=en&return_to=%2Fdevice', '/auth/dev/start?user=amy&return_to=%2Fdevice', 'en'],
    ];
    for (const [path, location, locale] of cases) {
      const res = await fetch(url(path), { redirect: 'manual', headers: ACCEPT_ENGLISH });
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe(location);
      expect(res.headers.getSetCookie(), path).toEqual([cookie(locale)]);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('vary'), path).toBe(PAGE_VARY);
      expect(await res.text(), path).toBe('');
    }
    // On https the cookie is Secure; it is never HttpOnly (the web app reads the same cookie).
    expect(localeCookie('zh-TW', true)).toBe('smurg_lang=zh-TW; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
    expect(localeCookie('en', false)).toBe(cookie('en'));
  });

  it('a browser that follows the switch gets the page in the chosen language, and keeps it', async () => {
    const browser = new CookieBrowser(ACCEPT_ENGLISH);
    const first = await browser.get(url(RELAY_PATHS.device));
    expectPage(first.body, 'en', 'login', 'Log in to the smurg CLI');
    const switched = await browser.get(url('/device?lang=zh-TW'));
    expect(switched.url).toBe(url(RELAY_PATHS.device));
    expectPage(switched.body, 'zh-TW', 'login', '登入 smurg CLI');
    expect(browser.jar.get('smurg_lang')).toBe('zh-TW');
    // Logging in keeps it: the code form is Chinese although the browser asks for English.
    const code = await browser.get(url(`${RELAY_PATHS.devStart}?user=kept&return_to=%2Fdevice`));
    expectPage(code.body, 'zh-TW', 'code', '輸入代碼');
    const back = await browser.get(url('/device?lang=en'));
    expectPage(back.body, 'en', 'code', 'Enter the code');
  });

  it('ignores any other value of lang, lang on a POST, and lang on routes that are not pages', async () => {
    for (const path of ['/device?lang=fr', '/device?lang=', '/device?lang=zh-Hant', '/device?lang=en-US']) {
      const res = await fetch(url(path), { redirect: 'manual', headers: ACCEPT_ZH_TW });
      expect(res.status, path).toBe(200);
      expect(res.headers.getSetCookie(), path).toEqual([]);
      const html = await res.text();
      expectPage(html, 'zh-TW', 'login', STRINGS['zh-TW'].loginTitle);
      // The page's links carry nothing from its URL.
      expect(html, path).toContain(SWITCH('/device?', 'zh-TW', STRINGS['zh-TW'].languageSwitchLabel));
    }
    const login = await startLogin();
    const browser = await browserAs('poster', 'en');
    const posted = await browser.submit(url('/device?lang=zh-TW'), { code: login.userCode }, { origin: relay.origin, follow: false });
    expect(posted.res.status).toBe(200);
    expect(posted.res.headers.getSetCookie()).toEqual([]);
    expectPage(posted.body, 'en', 'confirm', 'Allow the smurg CLI to log in?');
    // The answer to a POST shows no switch.
    expect(posted.body).not.toContain('nav class="lang"');
    expect(posted.body).not.toContain('?lang=');

    const json = await fetch(url(`${RELAY_PATHS.me}?lang=zh-TW`), { redirect: 'manual', headers: ACCEPT_ENGLISH });
    expect(json.status).toBe(401);
    expect(json.headers.getSetCookie()).toEqual([]);
    // The dev login does not exist on a hostname that is not local: 404 as before, no cookie, no redirect.
    const remote = await relay.fetch(`http://relay.example.com${RELAY_PATHS.devStart}?user=amy&lang=en`, { redirect: 'manual', headers: ACCEPT_ENGLISH });
    expect(remote.status).toBe(404);
    expect(remote.headers.getSetCookie()).toEqual([]);
  });
});

describe.each(LOCALES)('every page in %s, compared with the catalog', (locale) => {
  const s = STRINGS[locale];
  const tag = locale.toLowerCase();

  it('the login page: every login method, the relay it belongs to', async () => {
    const html = await (await fetch(url(RELAY_PATHS.device), { headers: ACCEPT[locale] })).text();
    expectPage(html, locale, 'login', s.loginTitle);
    expect(html).toContain(`<p>${s.loginIntroHtml}</p>`);
    expect(html).toContain(`data-provider="google" href="/auth/google/login?return_to=%2Fdevice">${s.loginWith('Google')}</a>`);
    expect(html).toContain(`data-provider="github" href="/auth/github/login?return_to=%2Fdevice">${s.loginWith('GitHub')}</a>`);
    expect(html).toContain(`<label>${s.devAccountLabel}<input name="user"`);
    expect(html).toContain(`<button type="submit">${s.devLoginButton}</button>`);
    expect(html).toContain(`<p class="note">${escapeHtml(s.relayNote(relay.origin))}</p>`);
    // No login method at all (not on a local hostname, no provider): the page says so.
    const none = await (await bare.fetch(`http://relay.example.com${RELAY_PATHS.device}`, { headers: ACCEPT[locale] })).text();
    expectPage(none, locale, 'login', s.loginTitle);
    expect(none).toContain(`<p>${s.noLoginMethods}</p>`);
  });

  it('the code form, a wrong code, and an account that changed', async () => {
    const google = new CookieBrowser(ACCEPT[locale]);
    const form = await google.get(url('/auth/google/login?return_to=%2Fdevice'));
    expectPage(form.body, locale, 'code', s.codeTitle);
    expect(form.body).toContain(`<p>${s.loggedInAsHtml(s.accountHtml(GOOGLE_USER.name, `google:${GOOGLE_USER.sub}`))}</p>`);
    expect(form.body).toContain(`<label for="code">${s.codeLabel}</label>`);
    expect(form.body).toContain(`<button type="submit">${s.next}</button>`);
    expect(form.body).toContain(`<p class="note">${s.codeNoteHtml}</p>`);
    expect(form.body).toContain(`<p class="note">${s.wrongAccountHtml}</p>`);

    const browser = await browserAs(`code-${tag}`, locale);
    const wrong = await submit(browser, { code: 'BCDF-GHJK' });
    expect(wrong.res.status).toBe(400);
    expectPage(wrong.body, locale, 'wrong-code', s.codeTitle);
    expect(wrong.body).toContain(`<p class="error" role="alert">${escapeHtml(s.wrongCode)}</p>`);

    const login = await startLogin();
    const changed = await submit(browser, { code: login.normalized, account: 'dev:someone-else', decision: 'allow' });
    expect(changed.res.status).toBe(409);
    expectPage(changed.body, locale, 'account-changed', s.codeTitle);
    expect(changed.body).toContain(`<p class="error" role="alert">${escapeHtml(s.accountChanged)}</p>`);
  });

  it('the confirmation screen, then "allowed" and "denied"', async () => {
    const login = await startLogin();
    const user = `confirm-${tag}`;
    const browser = await browserAs(user, locale);
    const confirm = await submit(browser, { code: login.userCode });
    expect(confirm.res.status).toBe(200);
    expectPage(confirm.body, locale, 'confirm', s.confirmTitle);
    expect(confirm.body).toContain(`<p>${s.confirmIntroHtml(escapeHtml(relay.origin))}</p>`);
    expect(confirm.body).toContain(`<dt>${s.account}</dt><dd data-testid="device-account">${s.accountHtml(user, `dev:${user}`)}</dd>`);
    expect(confirm.body).toContain(`<dt>${s.code}</dt><dd class="code" data-testid="device-user-code">${login.userCode}</dd>`);
    const country = new Intl.DisplayNames([intlTag(locale)], { type: 'region' }).of('US') as string;
    expect(confirm.body).toContain(`<dt>${s.requestFrom}</dt><dd data-testid="device-origin">${escapeHtml(s.requestOrigin(login.ip, s.placeCityCountry('Austin', country)))}</dd>`);
    const age = /<dd data-testid="device-age">([^<]+)<\/dd>/.exec(confirm.body)?.[1] ?? '';
    const utc = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.exec(age)?.[0] ?? '';
    expect(age).toBe(escapeHtml(s.age(0, utc)));
    expect(confirm.body).toContain(`<dt>${s.requestTime}</dt>`);
    expect(confirm.body).toContain(`<p><strong>${escapeHtml(s.warningMain)}</strong></p>`);
    expect(confirm.body).toContain(`<p>${escapeHtml(s.warningNote)}</p>`);
    expect(confirm.body).toContain(`<button type="submit" name="decision" value="allow">${s.allow}</button>`);
    expect(confirm.body).toContain(`<button type="submit" name="decision" value="deny">${s.deny}</button>`);

    const allowed = await submit(browser, { code: login.normalized, account: `dev:${user}`, decision: 'allow' });
    expectPage(allowed.body, locale, 'allowed', s.allowedTitle);
    expect(allowed.body).toContain(`<p>${escapeHtml(s.allowedText)}</p>`);

    const other = await startLogin();
    const denied = await submit(browser, { code: other.normalized, account: `dev:${user}`, decision: 'deny' });
    expectPage(denied.body, locale, 'denied', s.deniedTitle);
    expect(denied.body).toContain(`<p>${escapeHtml(s.deniedText)}</p>\n<p>${escapeHtml(s.deniedWarning)}</p>`);
  });

  it('too many wrong codes, with the minutes left', async () => {
    const browser = await browserAs(`blocked-${tag}`, locale);
    for (let i = 0; i < DEVICE_LIMITS.wrongCodesPerAccount; i++) expect((await submit(browser, { code: 'BCDF-GHJK' })).res.status).toBe(400);
    const blocked = await submit(browser, { code: 'BCDF-GHJK' });
    expect(blocked.res.status).toBe(429);
    expectPage(blocked.body, locale, 'blocked', s.codeTitle);
    const shown = /<p class="error" role="alert">([^<]+)<\/p>/.exec(blocked.body)?.[1];
    expect([s.tooManyWrongCodes(10), s.tooManyWrongCodes(9)]).toContain(shown);
  });

  it('a code that is no longer valid (the page builder: over HTTP it needs a race between two decisions)', () => {
    const html = deviceResultPage({ locale }, 'gone');
    expectPage(html, locale, 'gone', s.goneTitle);
    expect(html).toContain(`<p>${escapeHtml(s.goneText)}</p>\n<p class="note"><a href="/device">${escapeHtml(s.enterAnotherCode)}</a></p>`);
    expect(html).not.toContain('nav class="lang"');
  });

  it('the error pages of /device and of the login routes', async () => {
    const error = (html: string, title: string, message: string) => {
      expectPage(html, locale, 'error', title);
      expect(html).toContain(`<p>${escapeHtml(message)}</p>`);
    };
    const browser = await browserAs(`errors-${tag}`, locale);
    const crossSite = await submit(browser, { code: 'BCDF-GHJK' }, { origin: 'https://evil.example' });
    expect(crossSite.res.status).toBe(403);
    error(crossSite.body, s.cannotContinueTitle, s.notFromDevicePage);
    const login = await startLogin();
    const unknown = await submit(browser, { code: login.normalized, account: `dev:errors-${tag}`, decision: 'maybe' });
    expect(unknown.res.status).toBe(400);
    error(unknown.body, s.cannotContinueTitle, s.unknownDecision);

    const get = async (target: string, base: LocalRelay = relay, headers: Record<string, string> = {}) => {
      const res = await fetch(relayHttpUrl(base.origin, target), { redirect: 'manual', headers: { ...ACCEPT[locale], ...headers } });
      return { status: res.status, html: await res.text() };
    };
    const badLink = await get(`${authLoginPath('github')}?return_to=${encodeURIComponent('//evil.example/x')}`);
    expect(badLink.status).toBe(400);
    error(badLink.html, s.cannotLogInTitle, s.badLoginLink);
    const devName = await get(`${RELAY_PATHS.devStart}?user=${encodeURIComponent('a b')}`);
    expect(devName.status).toBe(400);
    error(devName.html, s.cannotLogInTitle, s.devNameRule);
    for (const [provider, name] of [['github', 'GitHub'], ['google', 'Google']] as const) {
      const off = await get(authLoginPath(provider), bare);
      expect(off.status).toBe(503);
      error(off.html, s.cannotLogInTitle, s.providerNotConfigured(name));
    }

    // The callback's pages (no language switch: the URL is one-time).
    const noTx = await get(`${authCallbackPath('github')}?code=x&state=y`);
    expect(noTx.status).toBe(400);
    error(noTx.html, s.cannotLogInTitle, s.loginTimedOutOrDone);
    expect(noTx.html).not.toContain('nav class="lang"');
    const oauth = new CookieBrowser(ACCEPT[locale]);
    const started = await oauth.get(url(authLoginPath('github')), { follow: false });
    const state = new URL(started.res.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const tx = oauth.cookieHeader();
    const callback = (query: string, provider: 'github' | 'google' = 'github') => get(`${authCallbackPath(provider)}?${query}`, relay, { cookie: tx });
    error((await callback('code=x&state=wrong')).html, s.cannotLogInTitle, s.stateMismatch);
    error((await callback(`code=x&state=${state}`, 'google')).html, s.cannotLogInTitle, s.loginTimedOut);
    error((await callback(`error=access_denied&state=${state}`)).html, s.cannotLogInTitle, s.loginCancelled);
    error((await callback(`state=${state}`)).html, s.cannotLogInTitle, s.noAuthorizationCode);
    // The provider refuses the code: a generic sentence for the person (the reason goes to the relay's log).
    const refused = await callback(`code=not-a-code-the-idp-issued&state=${state}`);
    expect(refused.status).toBe(502);
    error(refused.html, s.cannotLogInTitle, s.cannotConfirmIdentity('GitHub'));
  });

  it('escapes what a page is given and marks its language for the browser', () => {
    const html = errorPage({ locale, languageLinks: { en: '/x?a="1"&lang=en', 'zh-TW': '/x?a="1"&lang=zh-TW' } }, '<b>', 'a & "b"');
    expect(html).toContain(`<html lang="${intlTag(locale)}">`);
    expect(html).toContain('<title>&lt;b&gt;</title>');
    expect(html).toContain('<h1>&lt;b&gt;</h1>\n<p>a &amp; &quot;b&quot;</p>');
    expect(html).toContain('href="/x?a=&quot;1&quot;&amp;lang=zh-TW"');
    expect(html).not.toContain('<script');
  });
});

describe('zh-TW pages, word for word', () => {
  it('the sentences a Traditional Chinese reader sees on the way through /device', async () => {
    const anonymous = await (await fetch(url(RELAY_PATHS.device), { headers: ACCEPT_ZH_TW })).text();
    expect(anonymous).toContain('<html lang="zh-Hant-TW">');
    expect(anonymous).toContain('<h1>登入 smurg CLI</h1>');
    expect(anonymous).toContain('>使用 Google 登入</a>');
    expect(anonymous).toContain('>使用 GitHub 登入</a>');
    expect(anonymous).toContain('開發用帳號（僅限本機）');

    const login = await startLogin();
    const browser = await browserAs('lin', 'zh-TW');
    const form = (await browser.get(url(RELAY_PATHS.device))).body;
    expect(form).toContain('<h1>輸入代碼</h1>');
    expect(form).toContain('<p>登入的帳號：<strong>lin</strong>（dev:lin）</p>');
    expect(form).toContain('<button type="submit">下一步</button>');
    const wrong = await submit(browser, { code: 'BCDF-GHJK' });
    expect(wrong.body).toContain('代碼不正確或已失效。請確認終端機上的代碼（8 個英文字母，10 分鐘內有效）。');
    const confirm = await submit(browser, { code: login.userCode });
    expect(confirm.body).toContain('<h1>允許 smurg CLI 登入嗎？</h1>');
    expect(confirm.body).toMatch(new RegExp(`IP 位址 ${login.ip.replace(/\./g, '\\.')}，位置大約在 Austin，(美國|US)<`));
    expect(confirm.body).toMatch(/不到 1 分鐘前（\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC）/);
    expect(confirm.body).toContain('只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。');
    expect(confirm.body).toContain('value="allow">允許</button>');
    expect(confirm.body).toContain('value="deny">拒絕</button>');
    const allowed = await submit(browser, { code: login.normalized, account: 'dev:lin', decision: 'allow' });
    expect(allowed.body).toContain('<h1>已允許</h1>');
    const other = await startLogin();
    const denied = await submit(browser, { code: other.normalized, account: 'dev:lin', decision: 'deny' });
    expect(denied.body).toContain('<h1>已拒絕</h1>');
    const crossSite = await submit(browser, { code: 'BCDF-GHJK' }, { origin: 'https://evil.example' });
    expect(crossSite.body).toContain('<h1>無法繼續</h1>');
    expect(crossSite.body).toContain('這個要求不是從 relay 的 /device 頁面送出的，已經拒絕。');
  });
});
