// CLI login in a real browser (system Chrome, headless, a fresh temporary profile). Skipped when no system Chrome is
// installed.
//
// The device-code login: the REAL smurg CLI prints /device and a code; the browser logs in with the relay's dev login,
// enters the code, sees who and where, presses 允許; a form on another site can neither enter a code nor allow a login.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RELAY_PATHS, relayDeviceStartSchema, relayHttpUrl } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_DEBUG_PATH, type DeviceLoginInspection } from '../src/lib/device.ts';
import { startLocalRelay, type LocalRelay } from '../test-support/index.ts';
import { launchChrome, systemChrome, type Browser } from './chrome.ts';

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

describe.skipIf(chrome === null)('CLI login in a real browser (system Chrome): the device code', () => {
  let relay: LocalRelay;
  let browser: Browser;

  beforeAll(async () => {
    relay = await startLocalRelay();
    browser = await launchChrome(chrome as string);
  });

  afterAll(async () => {
    await browser?.close();
    await relay?.stop();
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
});
