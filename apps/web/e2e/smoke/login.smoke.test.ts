// Logging in, in a real browser (the built app served by the real relay, a daemon with every module, system Chrome):
//  - a logged-out visitor's page load is clean: ONE request says which login methods exist (GET /api/login-options),
//    nothing probes the login routes, and /api/me (401 without a session) is not asked when no session can exist;
//  - the CLI's device-code login (2026-10-01): the REAL `smurg login` prints /device and a code; in a phone-sized
//    window the relay's dev login, the code and 「允許」; the CLI saves the session; nothing fails on the way.
// (The guest's own Claude subscription login of §11 D-12 is gone with the guest sandbox: every session uses the host's
// Claude login, protocol v2.)
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, registerTestProcess, removeTempDir, waitFor } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, startSmoke, systemChrome, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** The `smurg` command of this repository (the device-code login test runs the real CLI). */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

/** Every request path the page made (method and path), from the moment this is called. */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    seen.push(`${request.method()} ${url.pathname}`);
  });
  return seen;
}

describe.skipIf(chrome === null)('logging in, in a real browser (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# 班級專案\n' } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  it('a page load of "/" and of "/join/<id>" by a logged-out browser produces zero console errors and zero failed requests (GET /api/login-options, no probes, no /api/me)', async () => {
    // "/": the login card, with the dev login the relay offers on this local hostname.
    const landing = await env.newPage();
    const landingRequests = recordRequests(landing);
    await landing.goto(`${env.origin}/`);
    // Shown once the login state (no request: no session can exist) and the login options (one request) are known.
    await landing.getByTestId('dev-login-form').waitFor({ timeout: STEP_MS });
    expect(landingRequests).toContain('GET /api/login-options');
    expect(landingRequests.filter((line) => line.includes('/api/me') || line.includes('/auth/'))).toEqual([]);
    expect(env.problemsOf(landing)).toEqual({ console: [], pageErrors: [], failedRequests: [], httpErrors: [] });

    // "/join/<id>" through a real invite link: the join page asks the visitor to log in, and nothing fails.
    const join = await env.newPage();
    const joinRequests = recordRequests(join);
    await join.goto(await env.invite('editor'));
    await join.getByTestId('join-login').waitFor({ timeout: STEP_MS });
    await join.getByTestId('dev-login-form').waitFor({ timeout: STEP_MS });
    expect(joinRequests).toContain('GET /api/login-options');
    expect(joinRequests.filter((line) => line.includes('/api/me') || line.includes('/auth/'))).toEqual([]);
    expect(env.problemsOf(join)).toEqual({ console: [], pageErrors: [], failedRequests: [], httpErrors: [] });

    // "/join/<id>" without an invite: the page explains, and nothing fails either.
    const bare = await env.newPage();
    await bare.goto(`${env.origin}/join/${env.stack.workspaceId}`);
    await bare.getByRole('heading', { name: '邀請連結不完整' }).waitFor({ timeout: STEP_MS });
    expect(env.problemsOf(bare)).toEqual({ console: [], pageErrors: [], failedRequests: [], httpErrors: [] });

    // Positive control: once this browser logged in, "/" does ask who it is (200) — still without an error.
    await landing.getByLabel('帳號名稱').fill('olga');
    await landing.getByRole('button', { name: '以開發用帳號登入' }).click();
    await landing.getByRole('button', { name: '登出' }).waitFor({ timeout: STEP_MS });
    const afterLogin = recordRequests(landing);
    await landing.reload();
    await landing.getByRole('button', { name: '登出' }).waitFor({ timeout: STEP_MS });
    expect(afterLogin).toContain('GET /api/me');
    expect(env.problemsOf(landing).console).toEqual([]);
    expect(env.problemsOf(landing).httpErrors).toEqual([]);
  }, 180_000);

  it('smurg login by device code: the real CLI prints /device and a code; in Chrome the dev login, the code and 「允許」 sign it in, with zero console errors and zero failed requests', async () => {
    const home = await createTempDir('web-smoke-device-login');
    const smurgHome = join(home, '.smurg');
    // The CLI of this repository in a process of its own: a temporary HOME, never the person's ~/.smurg, never a browser.
    const cli = spawn(process.execPath, [CLI_MAIN, 'login', '--relay', env.relay.origin], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', HOME: home, SMURG_HOME: smurgHome, SMURG_NO_BROWSER: '1', TMPDIR: process.env['TMPDIR'] ?? '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = cli.pid as number;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('the CLI did not start');
    registerTestProcess(pid, CLI_MAIN);
    let out = '';
    cli.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    cli.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => cli.once('exit', (code) => resolve(code)));
    try {
      await waitFor(() => out.includes('等待你在瀏覽器裡按「允許」') || cli.exitCode !== null, { timeoutMs: STEP_MS, what: 'the CLI to print the page and the code' });
      const printed = /\n {2}(\S+\/device)\n輸入代碼：([A-Z]{4}-[A-Z]{4}) /.exec(out);
      expect(printed, out).not.toBeNull();
      const [, pageUrl = '', code = ''] = printed as RegExpExecArray;
      // A phone-sized window: the page is short and typed on a phone as often as not.
      const page = await env.newPage({ width: 390, height: 844 });
      await page.goto(pageUrl);
      await page.getByLabel('開發用帳號（僅限本機）').fill('quinn');
      await page.getByRole('button', { name: '以開發用帳號登入' }).click();
      await page.getByLabel('終端機顯示的代碼').fill(code.toLowerCase());
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByRole('heading', { name: '允許 smurg CLI 登入嗎？' }).waitFor({ timeout: STEP_MS });
      expect(await page.getByTestId('device-user-code').textContent()).toBe(code);
      expect(await page.getByTestId('device-account').textContent()).toBe('quinn（dev:quinn）');
      await page.getByRole('button', { name: '允許', exact: true }).click();
      await page.getByRole('heading', { name: '已允許' }).waitFor({ timeout: STEP_MS });
      // The CLI polls every 5 s.
      await waitFor(() => cli.exitCode !== null, { timeoutMs: STEP_MS, what: 'the CLI to finish the login' });
      expect(await exited, out).toBe(0);
      expect(out).toContain(`已登入 ${env.relay.origin}：quinn（dev:quinn）`);
      expect((await stat(join(smurgHome, 'credentials.json'))).mode & 0o777).toBe(0o600);
      expect(env.problemsOf(page)).toEqual({ console: [], pageErrors: [], failedRequests: [], httpErrors: [] });
    } finally {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM'); // only the child this test started
      await exited;
      await removeTempDir(home);
    }
  }, 180_000);
});
