// Logging in, in a real browser (the built app served by the real relay, a daemon with every module, system Chrome):
//  - a logged-out visitor's page load is clean: ONE request says which login methods exist (GET /api/login-options),
//    nothing probes the login routes, and /api/me (401 without a session) is not asked when no session can exist;
//  - ARCHITECTURE §11 D-12: a guest starts their Claude subscription login from the login guide; the daemon's login
//    process shows the login URL and the code prompt in the guest's own terminal. The REAL `claude` (a verified version
//    on PATH) against a closed mock API address; no code is ever pasted and no account is used (ARCHITECTURE §0 rule 2).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../packages/daemon/src/testing/index.ts';
import { CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict } from '../../../../packages/daemon/src/core/config.ts';
import { ClaudeVersionProbe, resolveClaude } from '../../../../packages/daemon/src/sessions/claude.ts';
import { runProcess } from '../../../../packages/daemon/src/sessions/process-run.ts';
import type { SessionManagerImpl } from '../../../../packages/daemon/src/sessions/session-manager.ts';
import { STEP_MS, joinAs, openSession, startSmoke, systemChrome, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** The `smurg` command as sessions run it in development (the hooks module needs it to start agent sessions). */
const CLI_MAIN = fileURLToPath(new URL('../../../../packages/cli/src/main.ts', import.meta.url));

/** A `claude` of a verified version on PATH (its --version read with an isolated, credential-free environment). */
async function verifiedClaude(scratch: string): Promise<{ readonly path: string; readonly version: string } | null> {
  const binary = await resolveClaude(null, process.env['PATH']);
  if (!binary) return null;
  const probe = new ClaudeVersionProbe({ scratchParent: scratch, run: runProcess });
  const verdict = claudeVersionVerdict(await probe.output(binary), { claudeMinVersion: CLAUDE_VERIFIED_VERSIONS[0] as string, claudeVerifiedVersions: CLAUDE_VERIFIED_VERSIONS });
  return verdict.ok && verdict.warning === null ? { path: binary.realPath, version: verdict.version } : null;
}

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
  let scratch: string;
  let claude: { readonly path: string; readonly version: string } | null = null;

  beforeAll(async () => {
    scratch = await createTempDir('web-smoke-claude');
    claude = await verifiedClaude(scratch);
    if (claude === null) process.stderr.write('\n*** login.smoke.test.ts: no verified Claude Code on PATH: the D-12 browser test will SKIP ***\n\n');
    env = await startSmoke({
      stack: {
        projectFiles: { 'README.md': '# 班級專案\n' },
        sessions: {
          selfCommand: { file: process.execPath, args: [CLI_MAIN] },
          // The mock API: a closed port on 127.0.0.1 (nothing leaves the machine; no account).
          testGuestEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
          ...(claude ? { claudePath: claude.path } : {}),
        },
      },
    });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
    if (scratch) await removeTempDir(scratch);
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

  it('D-12 a guest starts「用 Claude 訂閱登入」from the login guide and sees the login URL and the code prompt in the login process terminal (real claude, mock API, never completed)', async (ctx) => {
    if (claude === null) {
      console.warn('[web smoke] SKIPPED the D-12 browser test: no verified Claude Code binary on PATH');
      return ctx.skip();
    }
    const page = await env.newPage();
    await joinAs(page, env, 'lena', 'runner');
    const agentId = await openSession(page, 'agent', 'Claude');
    // The daemon reports the agent logged out (claude auth status in the guest's environment): the guide is shown.
    const guide = page.getByRole('complementary', { name: '登入 Claude' });
    await guide.waitFor({ timeout: STEP_MS });
    expect(await guide.textContent()).toContain('主人在技術上仍然可以讀取你在這裡使用的憑證');
    await guide.getByRole('button', { name: '用 Claude 訂閱登入' }).click();

    // The login process: its own tab, the steps above its terminal, only the guest sees it.
    const process_ = page.getByRole('tabpanel').filter({ has: page.getByTestId('login-process') });
    await process_.waitFor({ timeout: STEP_MS });
    const loginId = await process_.locator('.agents-session').getAttribute('data-session-id');
    expect(loginId).toBeTruthy();
    const steps = (await process_.getByTestId('login-process').textContent()) ?? '';
    expect(steps).toContain('在你自己的瀏覽器開啟');
    expect(steps).toContain('Paste code here if prompted');
    const flat = await page.waitForFunction(
      (id) => {
        const text = [...document.querySelectorAll(`.agents-session[data-session-id="${id}"] .xterm-rows > div`)].map((row) => row.textContent ?? '').join('').replace(/\s+/g, '');
        return text.includes('Pastecodehereifprompted') && text.includes('oauth/authorize') ? text : false;
      },
      loginId,
      { timeout: STEP_MS },
    );
    const shown = (await flat.jsonValue()) as string;
    console.info(`[D-12 web] claude ${claude.version}: ${shown.slice(0, 120)}…`);
    expect(shown).not.toContain('FailedtostartOAuthcallbackserver');
    const sessions = env.stack.daemon.ctx.services.sessions as SessionManagerImpl;
    expect(sessions.listFor('dev:lena').find((s) => s.id === loginId)).toMatchObject({ kind: 'login', status: 'running', sandboxed: true });
    // Nobody else sees it (the host's own list).
    const hostList = await env.stack.hostClient.conn.request('session.list', {});
    expect(hostList.sessions.some((s) => s.id === loginId)).toBe(false);

    // Cancelled, never completed: the guest is told, no credential exists.
    await process_.getByRole('button', { name: '取消登入' }).click();
    await process_.getByText('已取消登入。').waitFor({ timeout: STEP_MS });
    expect(existsSync(join(sessions.guestPaths('dev:lena').cfg, '.credentials.json'))).toBe(false);
    expect(env.problemsOf(page).pageErrors).toEqual([]);
    expect(agentId).not.toBe(loginId);
  }, 240_000);
});
