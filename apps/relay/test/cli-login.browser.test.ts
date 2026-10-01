// CLI login in a real browser (system Chrome, headless, a fresh temporary profile). Skipped when no system Chrome is
// installed.
//
// The device-code login (the CLI's since 2026-10-01): the REAL smurg CLI prints /device and a code; the browser logs in
// with the relay's dev login, enters the code, sees who and where, presses 允許; a form on another site can neither
// enter a code nor allow a login.
//
// The DEPRECATED loopback login (smurg 0.1.0 still uses it, so the relay keeps it): the relay, the mock IdP in its
// "login form" mode (its page submits a form, like GitHub's and Google's), and a stand-in for the CLI's 127.0.0.1
// listener. OWNER-01: the relay's fetch-based tests passed while the dev-login button did nothing in a browser: Chromium
// applies the submitting page's CSP form-action to every redirect of a form submission, and the relay answered with a
// 302 to http://127.0.0.1:<port>. SEC-E-03: a link alone must never sign anyone in.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RELAY_PATHS, relayDeviceStartSchema, relayHttpUrl } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_DEBUG_PATH, type DeviceLoginInspection } from '../src/lib/device.ts';
import { cliConfirmCode } from '../src/lib/validate.ts';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';
import { loopbackListener, type LoopbackListener } from './browser.ts';
import { launchChrome, systemChrome, type Browser, type Page } from './chrome.ts';
import { GITHUB_USER, GOOGLE_USER, startMockIdp, type MockIdp } from './mock-idp.ts';

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const chrome = systemChrome();
/** The smurg CLI of this repository (run from source by Node; test only). */
const CLI_MAIN = fileURLToPath(new URL('../../../packages/cli/src/main.ts', import.meta.url));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms);
    }),
  ]);
}

describe.skipIf(chrome === null)('CLI login in a real browser (system Chrome): the device code, and the deprecated loopback', () => {
  let idp: MockIdp;
  let relay: LocalRelay;
  let browser: Browser;

  beforeAll(async () => {
    idp = await startMockIdp();
    idp.behaviour.loginForm = true;
    relay = await startLocalRelay({ vars: idp.vars, secrets: idp.secrets });
    browser = await launchChrome(chrome as string);
  });

  afterAll(async () => {
    await browser?.close();
    await relay?.stop();
    await idp?.close();
  });

  /** A fresh browser context (no cookies) with a record of CSP violations; the listener stands in for the CLI's. */
  async function session(run: (page: Page, cli: CliLogin, cspErrors: string[]) => Promise<void>): Promise<void> {
    const listener = await loopbackListener();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const cspErrors: string[] = [];
      page.on('console', (message) => {
        if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text());
      });
      await run(page, cliLogin(listener), cspErrors);
    } finally {
      await context.close();
      await listener.close();
    }
  }

  type CliLogin = { listener: LoopbackListener; state: string; verifier: string; url(provider?: string): string };

  /** What `smurg login` does: a fresh state and PKCE pair, and the relay's /auth/cli/start URL for them. */
  function cliLogin(listener: LoopbackListener): CliLogin {
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    return {
      listener,
      state,
      verifier,
      url(provider) {
        const start = new URL(relayHttpUrl(relay.origin, RELAY_PATHS.cliStart));
        start.searchParams.set('port', String(listener.port));
        start.searchParams.set('state', state);
        start.searchParams.set('code_challenge', s256(verifier));
        if (provider !== undefined) start.searchParams.set('provider', provider);
        return start.href;
      },
    };
  }

  /** The listener got the callback: exchange the code like the CLI and return the account it signs in. */
  async function finish(cli: CliLogin): Promise<string> {
    const params = await within(cli.listener.callback, 20_000, 'the CLI listener');
    expect(params.get('state')).toBe(cli.state);
    const res = await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.cliToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: params.get('code'), codeVerifier: cli.verifier }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { userId: string } };
    const me = await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.me), { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    return body.user.userId;
  }

  it('dev login from the confirmation page reaches the CLI listener, and its code signs the CLI in (OWNER-01)', async () => {
    await session(async (page, cli, cspErrors) => {
      await page.goto(cli.url());
      expect(await page.textContent('[data-testid="cli-confirm-code"]')).toBe(await cliConfirmCode(cli.state));
      await page.fill('form[data-provider="dev"] input[name="user"]', 'erin');
      await page.click('form[data-provider="dev"] button[type="submit"]');
      expect(await finish(cli)).toBe('dev:erin');
      expect(cspErrors).toEqual([]);
    });
  });

  it.each([
    ['github', `github:${GITHUB_USER.id}`],
    ['google', `google:${GOOGLE_USER.sub}`],
  ])('%s login through an IdP page that submits a form reaches the CLI listener (OWNER-01)', async (provider, userId) => {
    await session(async (page, cli, cspErrors) => {
      await page.goto(cli.url(provider));
      await page.click(`form[data-provider="${provider}"] button[type="submit"]`);
      await page.waitForURL((url) => url.origin === idp.base, { timeout: 20_000 });
      await page.click('button[type="submit"]');
      expect(await finish(cli)).toBe(userId);
      expect(cspErrors).toEqual([]);
    });
  });

  it('the REAL smurg CLI by device code: `smurg login --no-browser` prints /device and a code; the dev login, the code and 「允許」 in the browser sign it in (the owner\'s scenario)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'smurg-cli-login-'));
    const smurgHome = join(home, '.smurg-test');
    // The CLI of this repository, from source, with a fake home: never the person's real ~/.smurg, never a browser.
    const cli: ChildProcess = spawn(process.execPath, [CLI_MAIN, 'login', '--no-browser', '--relay', relay.origin], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', HOME: home, SMURG_HOME: smurgHome, SMURG_NO_BROWSER: '1', TMPDIR: tmpdir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    cli.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    cli.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((resolve) => cli.on('exit', (code) => resolve(code)));
    const context = await browser.newContext();
    try {
      let printed: RegExpExecArray | null = null;
      for (let i = 0; i < 300 && printed === null; i++) {
        printed = /\n {2}(http:\/\/127\.0\.0\.1:\d+\/device)\n輸入代碼：([A-Z]{4}-[A-Z]{4}) {3}（10 分鐘內有效）\n/.exec(out);
        if (printed === null) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(printed, out).not.toBeNull();
      const [, pageUrl = '', code = ''] = printed as RegExpExecArray;
      expect(pageUrl).toBe(relayHttpUrl(relay.origin, RELAY_PATHS.device));
      const page = await context.newPage();
      const cspErrors: string[] = [];
      page.on('console', (message) => {
        if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text());
      });
      // The page from the terminal (it carries no code): log in first; the relay brings the browser back to /device.
      await page.goto(pageUrl);
      await page.fill('form[data-provider="dev"] input[name="user"]', 'owner');
      await page.click('form[data-provider="dev"] button[type="submit"]');
      await page.waitForSelector('form[data-testid="device-code-form"]', { timeout: 20_000 });
      expect(page.url()).toBe(pageUrl);
      // Typed as a person might: lower case, a space instead of the hyphen.
      await page.fill('input[name="code"]', code.toLowerCase().replace('-', ' '));
      await page.click('form[data-testid="device-code-form"] button[type="submit"]');
      await page.waitForSelector('[data-testid="device-user-code"]', { timeout: 20_000 });
      expect(await page.textContent('[data-testid="device-user-code"]')).toBe(code);
      expect(await page.textContent('[data-testid="device-account"]')).toBe('owner（dev:owner）');
      expect(await page.textContent('[data-testid="device-origin"]')).toMatch(/^IP 位址 \S+，位置大約在 /);
      expect(await page.textContent('body')).toContain('只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。');
      await page.click('button[value="allow"]');
      await page.waitForSelector('h1', { timeout: 20_000 });
      expect(await page.textContent('h1')).toBe('已允許');
      // The CLI polls every 5 s.
      expect(await within(exited, 30_000, 'the CLI to finish the login'), out).toBe(0);
      expect(out).toContain('已登入');
      expect(out).toContain('dev:owner');
      expect((await stat(join(smurgHome, 'credentials.json'))).mode & 0o777).toBe(0o600);
      expect(cspErrors).toEqual([]);
    } finally {
      await context.close();
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM'); // only the child this test started
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a form on another site can neither enter a code on /device nor allow a login there', async () => {
    const start = await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.deviceStart), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const login = relayDeviceStartSchema.parse(await start.json());
    const code = login.userCode.replace('-', '');
    const context = await browser.newContext();
    const action = relayHttpUrl(relay.origin, RELAY_PATHS.device);
    const attacker: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>prize</title>
<form id="enter" method="post" action="${action}"><input type="hidden" name="code" value="${code}"><button type="submit">Claim your prize</button></form>
<form id="allow" method="post" action="${action}"><input type="hidden" name="code" value="${code}"><input type="hidden" name="account" value="dev:victim"><button type="submit" name="decision" value="allow">Claim your other prize</button></form>`);
    });
    await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', () => resolve()));
    try {
      const page = await context.newPage();
      // The victim is logged in to the relay in this browser.
      await page.goto(relayHttpUrl(relay.origin, `${RELAY_PATHS.devStart}?user=victim&return_to=%2Fdevice`));
      await page.waitForSelector('form[data-testid="device-code-form"]', { timeout: 20_000 });
      const attackerUrl = `http://localhost:${(attacker.address() as AddressInfo).port}/`;
      for (const form of ['enter', 'allow']) {
        await page.goto(attackerUrl);
        await page.click(`#${form} button[type="submit"]`);
        await page.waitForURL((url) => url.href === action, { timeout: 20_000 });
        await page.waitForSelector('h1', { timeout: 20_000 });
        expect(await page.textContent('body')).toContain('這個要求不是從 relay 的 /device 頁面送出的');
      }
      const stored = (await (await fetch(relayHttpUrl(relay.origin, `${DEVICE_DEBUG_PATH}?code=${code}`))).json()) as DeviceLoginInspection;
      expect(stored.login?.status).toBe('pending');
    } finally {
      await context.close();
      await new Promise<void>((resolve) => {
        attacker.close(() => resolve());
        attacker.closeAllConnections();
      });
    }
  });

  it('a link with provider=github stops at the confirmation page: no IdP, no code (SEC-E-03)', async () => {
    await session(async (page, cli) => {
      const authorizeBefore = idp.seen.authorize.length;
      await page.goto(cli.url('github'));
      // Give a redirect or refresh, if there were one, time to happen.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(page.url()).toBe(cli.url('github'));
      expect(await page.textContent('[data-testid="cli-confirm-code"]')).toBe(await cliConfirmCode(cli.state));
      expect(idp.seen.authorize.length).toBe(authorizeBefore);
      expect(cli.listener.requests).toEqual([]);
    });
  });

  it('a form on another site cannot skip the confirmation (SEC-E-03)', async () => {
    await session(async (page, cli) => {
      const fields = new URL(cli.url()).searchParams;
      const hidden = (provider: string, extra: Record<string, string> = {}) =>
        [...fields, ['provider', provider], ...Object.entries(extra)].map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('');
      const action = relayHttpUrl(relay.origin, RELAY_PATHS.cliStart);
      const attacker: Server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>prize</title>
<form id="github" method="post" action="${action}">${hidden('github')}<button type="submit">Claim your prize</button></form>
<form id="dev" method="post" action="${action}">${hidden('dev', { user: 'erin' })}<button type="submit">Claim your other prize</button></form>`);
      });
      await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', () => resolve()));
      try {
        const attackerUrl = `http://localhost:${(attacker.address() as AddressInfo).port}/`;
        const authorizeBefore = idp.seen.authorize.length;
        for (const form of ['github', 'dev']) {
          await page.goto(attackerUrl);
          await page.click(`#${form} button[type="submit"]`);
          await page.waitForURL((url) => url.href === action, { timeout: 20_000 });
          await page.waitForSelector('h1', { timeout: 20_000 });
          expect(await page.textContent('body')).toContain('不是從 relay 的確認頁面送出的');
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(idp.seen.authorize.length).toBe(authorizeBefore);
        expect(cli.listener.requests).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => {
          attacker.close(() => resolve());
          attacker.closeAllConnections();
        });
      }
    });
  });
});
