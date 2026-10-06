// Shared harness of the built-app smoke tests (apps/web/e2e/smoke): the web app as BUILT for production (the output of
// globalSetup), served by the REAL relay (local workerd, its Worker serving the SPA exactly as in production), a REAL
// daemon composing every module (tests/e2e startStack) and system Chrome driven headless by playwright-core in fresh
// contexts (no profile, no cookies imported; login is the relay's dev login). Nothing here waits for a fixed time:
// every step waits for a condition.
//
// Language: every context sets its `locale` explicitly, English (`en-US`) unless a test asks for another one, so the
// app's detection (navigator.languages) never depends on the machine that runs the tests. The helpers below click
// through the app by its visible labels; WORDS holds those labels for the two languages a page can be in.
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
  newPage(options?: { readonly width?: number; readonly height?: number; readonly locale?: SmokeLocale }): Promise<Page>;
  problemsOf(page: Page): PageProblems;
  /** A fresh invite of the host (through admin.invite.create), pointing at `origin`. */
  invite(role: 'agent' | 'editor' | 'viewer'): Promise<string>;
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

/** The browser languages the smoke tests use: the app shows English for `en-US`, Traditional Chinese for `zh-TW`. */
export type SmokeLocale = 'en-US' | 'zh-TW';
export const DEFAULT_SMOKE_LOCALE: SmokeLocale = 'en-US';

/** The labels the helpers click and wait for, in the language of the page (the app's catalogues are the source). */
const WORDS = {
  'en-US': {
    join: 'Join',
    accountName: 'Account name',
    devLogin: 'Log in with a development account',
    workspace: 'Workspace',
    connected: 'Connected',
    newSession: 'New session',
    plainTerminal: 'Plain terminal',
    newWorktree: 'A new worktree of my own',
    sessionName: 'Name (optional)',
    open: 'Open',
    language: 'Language',
  },
  'zh-TW': {
    join: '加入',
    accountName: '帳號名稱',
    devLogin: '以開發用帳號登入',
    workspace: '工作區',
    connected: '已連線',
    newSession: '新增 session',
    plainTerminal: '一般終端機',
    newWorktree: '我的新 worktree',
    sessionName: '名稱（選填）',
    open: '開啟',
    language: '語言',
  },
} as const satisfies Record<SmokeLocale, Record<string, string>>;

const pageLocales = new WeakMap<Page, SmokeLocale>();

/** The labels of `page` in the language it was opened in (see `useLanguage` after a switch inside the app). */
export function wordsOf(page: Page): (typeof WORDS)[SmokeLocale] {
  return WORDS[pageLocales.get(page) ?? DEFAULT_SMOKE_LOCALE];
}

/** Tells the helpers that `page` shows another language now (the test switched it with the language menu). */
export function useLanguage(page: Page, locale: SmokeLocale): void {
  pageLocales.set(page, locale);
}

/** Han characters, Bopomofo, CJK punctuation and full-width forms: what an English page never shows on its own. */
export const CJK_PATTERN = '[\\u3000-\\u303f\\u3100-\\u312f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]';

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
        const locale = size.locale ?? DEFAULT_SMOKE_LOCALE;
        const context = await browser.newContext({ locale, viewport: { width: size.width ?? 1440, height: size.height ?? 900 } });
        contexts.push(context);
        const page = await context.newPage();
        pageLocales.set(page, locale);
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
          .map((s) => `${s.id} ${s.kind} owner=${s.openedBy.userId} root=${s.root.kind} status=${s.status}${s.endReason === undefined ? '' : ` endReason=${s.endReason}`}`);
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

/** The join page's explicit "Join" (an invite link never joins on page load). */
export async function confirmJoin(page: Page): Promise<void> {
  await page.getByTestId('join-confirm').waitFor({ timeout: STEP_MS });
  await page.getByRole('button', { name: wordsOf(page).join, exact: true }).click();
}

/** Opens `link` logged out, logs in with the relay's dev login as `name`, joins; resolves on the connected workbench. */
export async function joinWith(page: Page, env: SmokeEnv, link: string, name: string): Promise<void> {
  await page.goto(link);
  await page.getByTestId('join-login').waitFor({ timeout: STEP_MS });
  await page.getByLabel(wordsOf(page).accountName).fill(name);
  await page.getByRole('button', { name: wordsOf(page).devLogin }).click();
  await confirmJoin(page);
  await page.waitForURL(`${env.origin}/w/${env.stack.workspaceId}`, { timeout: STEP_MS });
  await workspaceOnline(page);
}

export async function workspaceOnline(page: Page): Promise<void> {
  // The pill by its state, then its label: "Connected" alone would also be found inside "Not connected".
  const pill = page.getByRole('banner', { name: wordsOf(page).workspace }).locator('[data-connection-view="online"]');
  await pill.filter({ hasText: wordsOf(page).connected }).waitFor({ timeout: STEP_MS });
}

/** A guest through a fresh invite of `role` (`agent`: "Agent access"). */
export async function joinAs(page: Page, env: SmokeEnv, name: string, role: 'agent' | 'editor' | 'viewer' = 'editor'): Promise<void> {
  await joinWith(page, env, await env.invite(role), name);
}

/** The host themself, in the browser (their own host link; the dev account `host` is the stack's host). */
export async function joinAsHost(page: Page, env: SmokeEnv): Promise<void> {
  await joinWith(page, env, env.hostLink(), 'host');
}

/** Opens a session of `kind` from the agents panel's "New session" dialog; resolves with its id once its terminal is live. */
export async function openSession(page: Page, kind: 'terminal' | 'agent', title: string, options: { readonly worktree?: boolean } = {}): Promise<string> {
  const words = wordsOf(page);
  await page.getByRole('button', { name: words.newSession }).first().click();
  const dialog = page.getByRole('dialog', { name: words.newSession });
  await dialog.waitFor({ timeout: STEP_MS });
  if (kind === 'terminal') await dialog.getByText(words.plainTerminal).click();
  if (options.worktree) await dialog.getByText(words.newWorktree).click();
  await dialog.getByLabel(words.sessionName).fill(title);
  await dialog.getByRole('button', { name: words.open }).click();
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

/** Picks a language in the app's language menu (each language is listed under its own name) and waits for it. */
export async function chooseLanguage(page: Page, locale: SmokeLocale): Promise<void> {
  await page.getByTestId('language-menu').first().click();
  await page.getByTestId('language-menu-menu').locator(`[data-menu-item="${locale === 'zh-TW' ? 'zh-TW' : 'en'}"]`).click();
  await page.waitForFunction((lang) => document.documentElement.lang === lang, locale === 'zh-TW' ? 'zh-Hant-TW' : 'en', { timeout: STEP_MS });
  useLanguage(page, locale);
}

/**
 * Every piece of visible text of the page that holds a CJK character, with the element it is in: what an English
 * page must not show. `allowed` lists texts that are legitimately Chinese there (the language's own name in the menu,
 * names and file names the test itself made).
 */
export async function cjkTexts(page: Page, allowed: readonly string[] = []): Promise<string[]> {
  return page.evaluate(
    ({ pattern, allow }) => {
      const cjk = new RegExp(pattern, 'u');
      const found: string[] = [];
      const visit = (text: string | null, where: Element | null, kind: string): void => {
        if (text === null || !cjk.test(text)) return;
        let rest = text;
        for (const ok of allow) rest = rest.split(ok).join('');
        if (!cjk.test(rest)) return;
        found.push(`${kind} <${where?.tagName.toLowerCase() ?? '?'} class="${where?.getAttribute('class') ?? ''}">: ${text.trim().slice(0, 120)}`);
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) visit(node.textContent, node.parentElement, 'text');
      for (const element of document.querySelectorAll('[aria-label], [title], [placeholder], [aria-description], [alt]')) {
        for (const attribute of ['aria-label', 'title', 'placeholder', 'aria-description', 'alt']) visit(element.getAttribute(attribute), element, attribute);
      }
      visit(document.title, document.head, 'document.title');
      return found;
    },
    { pattern: CJK_PATTERN, allow: [...allowed] },
  );
}
