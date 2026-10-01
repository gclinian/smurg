// Shared harness of the built-app smoke tests (apps/web/e2e/smoke): the web app as BUILT for production (the output of
// globalSetup), served by the REAL relay (local workerd, its Worker serving the SPA exactly as in production), a REAL
// daemon composing every module (tests/e2e startStack) and system Chrome driven headless by playwright-core in fresh
// contexts (no profile, no cookies imported; login is the relay's dev login). Nothing here waits for a fixed time:
// every step waits for a condition.
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { beforeEach } from 'vitest';
import { startLocalRelay, type LocalRelay, type StartLocalRelayOptions } from '../../../relay/test-support/index.ts';
import { bufferedLogger, startStack, type Stack, type StackOptions } from '../../../../tests/e2e/src/harness.ts';
import { chromeLaunchOptions, systemChrome } from '../chrome.ts';

export { waitUntil } from '../../../../tests/e2e/src/harness.ts';
export { systemChrome } from '../chrome.ts';

/** Generous per-step bound: a shared, loaded machine (the gate runs every project at once). */
export const STEP_MS = 60_000;

/** What went wrong in one page: console errors, uncaught errors, failed requests, HTTP errors. */
export interface PageProblems {
  readonly console: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly httpErrors: string[];
}

export interface SmokeEnv {
  readonly relay: LocalRelay;
  readonly stack: Stack;
  readonly browser: Browser;
  /** Where the pages load the app from (the relay itself unless a front origin was given). */
  readonly origin: string;
  /** Every problem of every page of this env (the CSP check reads them all). */
  readonly allProblems: string[];
  newPage(options?: { readonly width?: number; readonly height?: number }): Promise<Page>;
  problemsOf(page: Page): PageProblems;
  /** A fresh invite of the host (through admin.invite.create), pointing at `origin`. */
  invite(role: 'editor' | 'runner' | 'viewer'): Promise<string>;
  /** A fresh host link of the host themself (a new device of the host's account), pointing at `origin`. */
  hostLink(): string;
  /** The daemon's last log lines and audit entries, and every session's state: what a failed test prints. */
  diagnostics(): Promise<string>;
  stop(): Promise<void>;
}

/** Daemon log lines a failed test prints (the daemon keeps more; a CI log must stay readable). */
const DIAGNOSTIC_LOG_LINES = 300;
/** Audit entries a failed test prints. */
const DIAGNOSTIC_AUDIT_ENTRIES = 150;

/**
 * Registers, for every test of the calling suite, a dump of `env().diagnostics()` on stderr when the test fails: a
 * browser test that times out says only what the page did not show, and the daemon behind it is silent otherwise.
 */
export function explainFailures(env: () => SmokeEnv | undefined): void {
  beforeEach(({ onTestFailed }) => {
    onTestFailed(async () => {
      const current = env();
      if (current === undefined) return;
      const text = await current.diagnostics().catch((error: unknown) => `diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[web smoke] the daemon behind the failed test:\n${text}`);
    });
  });
}

export interface SmokeOptions {
  readonly stack?: Omit<StackOptions, 'relay'>;
  readonly relayVars?: StartLocalRelayOptions['vars'];
  /** The pages use this origin instead of the relay's (a proxy in front of the relay); the relay must allow it. */
  readonly frontOrigin?: string;
}

export async function startSmoke(options: SmokeOptions = {}): Promise<SmokeEnv> {
  const chrome = systemChrome();
  if (chrome === null) throw new Error('no system Chrome');
  const webDist = join(process.env['TMPDIR'] as string, 'web-dist');
  const stops: (() => Promise<void>)[] = [];
  try {
    const relay = await startLocalRelay({ tap: false, webDist, ...(options.relayVars ? { vars: options.relayVars } : {}) });
    stops.push(() => relay.stop());
    const daemonLog = bufferedLogger();
    const stack = await startStack({ log: daemonLog.log, ...options.stack, relay });
    stops.push(() => stack.stop());
    // Real scrollbars (playwright hides them in headless Chrome): the terminal tests measure what they cost.
    const browser = await chromium.launch({ ...chromeLaunchOptions(chrome), ignoreDefaultArgs: ['--hide-scrollbars'] });
    stops.push(() => browser.close());
    const origin = options.frontOrigin ?? relay.origin;
    const allProblems: string[] = [];
    const problems = new Map<Page, PageProblems>();
    const contexts: BrowserContext[] = [];
    const retarget = (url: string): string => url.replace(relay.origin, origin);
    return {
      relay,
      stack,
      browser,
      origin,
      allProblems,
      async newPage(size = {}) {
        const context = await browser.newContext({ locale: 'zh-TW', viewport: { width: size.width ?? 1440, height: size.height ?? 900 } });
        contexts.push(context);
        const page = await context.newPage();
        const own: PageProblems = { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
        problems.set(page, own);
        page.on('pageerror', (error) => {
          own.pageErrors.push(error.message);
          allProblems.push(`pageerror: ${error.message}`);
        });
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          own.console.push(message.text());
          allProblems.push(`console: ${message.text()}`);
        });
        page.on('requestfailed', (request) => {
          own.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
        });
        page.on('response', (response) => {
          if (response.status() >= 400) own.httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
        });
        return page;
      },
      problemsOf(page) {
        return problems.get(page) ?? { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
      },
      async invite(role) {
        return retarget(await stack.createInvite(role));
      },
      hostLink() {
        return retarget(stack.daemon.internals.invites.createHostInvite().url);
      },
      async diagnostics() {
        const sessions = stack.daemon.ctx.services.sessions
          .list()
          .map((s) => `${s.id} ${s.kind} owner=${s.ownerUserId} sandboxed=${s.sandboxed} status=${s.status}${s.endReason === undefined ? '' : ` endReason=${s.endReason}`}`);
        const audit = await stack.audit(DIAGNOSTIC_AUDIT_ENTRIES).catch(() => []);
        const lines = daemonLog.lines();
        return [
          `--- sessions (${sessions.length})`,
          ...sessions,
          `--- audit (last ${audit.length}, oldest first)`,
          ...[...audit].reverse().map((e) => `${new Date(e.at).toISOString()} ${e.action} ${e.outcome} ${e.target ?? ''} ${JSON.stringify(e.detail ?? {})}`),
          `--- daemon log (last ${Math.min(lines.length, DIAGNOSTIC_LOG_LINES)} of ${lines.length} lines kept)`,
          ...lines.slice(-DIAGNOSTIC_LOG_LINES),
        ].join('\n');
      },
      async stop() {
        for (const context of contexts.splice(0)) await context.close().catch(() => {});
        for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
      },
    };
  } catch (error) {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
    throw error;
  }
}

/** The join page's explicit 「加入」 (SEC-E-02: an invite link never joins on page load). */
export async function confirmJoin(page: Page): Promise<void> {
  await page.getByTestId('join-confirm').waitFor({ timeout: STEP_MS });
  await page.getByRole('button', { name: '加入', exact: true }).click();
}

/** Opens `link` logged out, logs in with the relay's dev login as `name`, joins; resolves on the connected workbench. */
export async function joinWith(page: Page, env: SmokeEnv, link: string, name: string): Promise<void> {
  await page.goto(link);
  await page.getByTestId('join-login').waitFor({ timeout: STEP_MS });
  await page.getByLabel('帳號名稱').fill(name);
  await page.getByRole('button', { name: '以開發用帳號登入' }).click();
  await confirmJoin(page);
  await page.waitForURL(`${env.origin}/w/${env.stack.workspaceId}`, { timeout: STEP_MS });
  await workspaceOnline(page);
}

export async function workspaceOnline(page: Page): Promise<void> {
  await page.getByRole('banner', { name: '工作區' }).getByText('已連線').waitFor({ timeout: STEP_MS });
}

/** A guest through a fresh invite of `role`. */
export async function joinAs(page: Page, env: SmokeEnv, name: string, role: 'editor' | 'runner' | 'viewer' = 'editor'): Promise<void> {
  await joinWith(page, env, await env.invite(role), name);
}

/** The host themself, in the browser (their own host link; the dev account `host` is the stack's host). */
export async function joinAsHost(page: Page, env: SmokeEnv): Promise<void> {
  await joinWith(page, env, env.hostLink(), 'host');
}

/** Opens a session of `kind` from the agents panel's 「新增 session」 dialog; resolves with its id once its terminal is live. */
export async function openSession(page: Page, kind: 'terminal' | 'agent', title: string, options: { readonly worktree?: boolean } = {}): Promise<string> {
  await page.getByRole('button', { name: '新增 session' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增 session' });
  await dialog.waitFor({ timeout: STEP_MS });
  if (kind === 'terminal') await dialog.getByText('一般終端機').click();
  if (options.worktree) await dialog.getByText('我的新 worktree').click();
  await dialog.getByLabel('名稱（選填）').fill(title);
  await dialog.getByRole('button', { name: '開啟' }).click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
  // The new session's tab is selected: its panel is the visible one, with a live terminal.
  const session = page.getByRole('tabpanel').locator('.agents-session', { has: page.locator('.agents-term__viewport[data-phase="live"]') });
  await session.first().waitFor({ timeout: STEP_MS });
  const id = await session.first().getAttribute('data-session-id');
  if (!id) throw new Error('no session id on the live terminal');
  return id;
}

/** The text of every row of the terminal of session `id`, one row per line. */
export async function terminalText(page: Page, id: string): Promise<string> {
  return terminalOf(page, id).evaluate((viewport) =>
    [...viewport.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()).join('\n'),
  );
}

/**
 * Whether the terminal of session `id` shows `text` somewhere, also where the terminal wrapped it across rows. The DOM
 * rows do not say which row continues the previous one, so the check also runs on all rows concatenated with every
 * space removed (from the text too). That matters on Linux: the host's shell prompt there is Debian's
 * `user@host:/full/path$ ` (/etc/bash.bashrc), longer than a 50-column panel, so a command typed after it often
 * starts on one row and ends on the next.
 */
export async function terminalShows(page: Page, id: string, text: string): Promise<boolean> {
  // The terminal must be there: "not shown" by a terminal that is missing would prove nothing.
  await terminalOf(page, id).waitFor({ timeout: STEP_MS });
  return page.evaluate(terminalShowsIn, { id, text });
}

/** Waits until the terminal of session `id` shows `text` somewhere (see terminalShows). */
export async function waitForTerminalText(page: Page, id: string, text: string, timeoutMs = STEP_MS): Promise<void> {
  await page.waitForFunction(terminalShowsIn, { id, text }, { timeout: timeoutMs });
}

/** Runs in the page: terminalShows. Self-contained (serialised into the page). */
function terminalShowsIn({ id, text }: { readonly id: string; readonly text: string }): boolean {
  const rows = [...document.querySelectorAll(`.agents-session[data-session-id="${id}"] .xterm-rows > div`)].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' '));
  if (rows.join('\n').includes(text)) return true;
  const squeezed = text.replace(/\s+/g, '');
  return squeezed.length > 0 && rows.join('').replace(/\s+/g, '').includes(squeezed);
}

/** The visible terminal viewport of session `id`. */
export function terminalOf(page: Page, id: string) {
  return page.locator(`.agents-session[data-session-id="${id}"] .agents-term__viewport`);
}

/** Types a line into the (owner's) terminal of session `id`. */
export async function typeInTerminal(page: Page, id: string, line: string): Promise<void> {
  await terminalOf(page, id).click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}
