// A page that the host's smurg refuses for its version (0.5.1, DESIGN D3): the BUILT app served by the real relay,
// system Chrome driven headless, and a daemon that speaks ANOTHER protocol number than the page.
//
// The refusal says nothing but `version`: the page cannot know which side is the older one. It asks the relay for `/`
// past every cache and compares the entry script named there with the one it runs:
//   - the same: this tab IS the page the relay serves, so the host's smurg has to change (or, for a host who runs
//     their own relay, the relay has to be deployed again); the page says so, and that it is reloaded afterwards;
//   - another one: the web app was deployed again while this tab was open; the page says "Reload".
// The unit tests cover the decision with given answers (src/lib/page-build.test.ts) and the screen with a given
// decision; only a browser proves the request the page really makes (no cache, no cookie, allowed by the page's own
// Content-Security-Policy) against the index.html the relay really serves.
//
// How the two sides get different numbers: the e2e harness has no switch for it, so THIS FILE's copy of the protocol
// package says one more than the real one. The daemon runs in this process and reads it; the page is the built app
// (built by globalSetup, in another process) and the relay is workerd: both speak the real number.
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STEP_MS, confirmJoin, explainFailures, startSmoke, systemChrome, wordsOf, type SmokeEnv } from './helpers.ts';

vi.mock('../../../../packages/protocol/src/constants.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../packages/protocol/src/constants.ts')>();
  return { ...real, PROTOCOL_VERSION: real.PROTOCOL_VERSION + 1 };
});

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

describe.skipIf(chrome === null)("a page the host's smurg refuses for its version says which side has to act (built app, real relay, system Chrome)", () => {
  let env: SmokeEnv;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# Class project\n' } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  /** Through an invite link up to the handshake, which the daemon refuses: resolves on the screen that says so. */
  async function joinAndBeRefused(page: Page, name: string) {
    await page.goto(await env.invite('editor'));
    await page.getByTestId('join-login').waitFor({ timeout: STEP_MS });
    await page.getByLabel(wordsOf(page).accountName).fill(name);
    await page.getByRole('button', { name: wordsOf(page).devLogin }).click();
    await confirmJoin(page);
    const ended = page.getByTestId('connection-ended-screen');
    await ended.waitFor({ timeout: STEP_MS });
    return ended;
  }

  /** The page's questions to the relay about the page itself: `/`, asked by script. */
  function watchQuestions(page: Page): { readonly headers: Record<string, string>[] } {
    const seen: Record<string, string>[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'fetch' && request.url() === `${env.origin}/`) void request.allHeaders().then((headers) => seen.push(headers));
    });
    return { headers: seen };
  }

  it("the daemon of this file refuses the page's protocol number (the premise)", async () => {
    const { PROTOCOL_VERSION } = await import('@smurg/protocol');
    const real = await vi.importActual<typeof import('../../../../packages/protocol/src/constants.ts')>('../../../../packages/protocol/src/constants.ts');
    expect(PROTOCOL_VERSION).toBe(real.PROTOCOL_VERSION + 1);
  });

  it("this tab runs the page the relay serves: the host's smurg is the older side; what the host does, then a reload of this page", async () => {
    const page = await env.newPage();
    const questions = watchQuestions(page);
    const ended = await joinAndBeRefused(page, 'amy');
    await ended.getByRole('heading', { name: "The host's smurg is older than this page" }).waitFor({ timeout: STEP_MS });
    expect(await ended.locator('.app-fullpage__body').textContent()).toBe('The host stops sharing, runs smurg update and shares again (a host who runs their own relay deploys the relay again). Then reload this page.');
    await ended.getByRole('button', { name: 'Reload the page' }).waitFor({ timeout: STEP_MS });
    // Nobody was let in.
    expect(env.stack.daemon.ctx.members.active('dev:amy')).toBeNull();
    // Asked once, past every cache, without the login cookie.
    expect(questions.headers).toHaveLength(1);
    expect(questions.headers[0]?.['cache-control']).toBe('no-cache');
    expect(questions.headers[0]?.['cookie']).toBeUndefined();
    expect(env.problemsOf(page).console.filter((line) => /Content Security Policy/.test(line))).toEqual([]);
  });

  it('the relay serves another page by now: this tab is from before an update, and Reload is the way out', async () => {
    const page = await env.newPage();
    // "A deploy" while this tab is open: what the relay answers the page's question with names another entry script.
    const index = await (await fetch(`${env.origin}/`, { headers: { 'accept-language': 'en' } })).text();
    const entry = /<script type="module" crossorigin src="(\/assets\/index-[\w-]+\.js)"><\/script>/.exec(index)?.[1];
    expect(entry).toBeDefined();
    await page.route(`${env.origin}/`, (route) => {
      if (route.request().resourceType() !== 'fetch') return void route.continue();
      void route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: index.replace(entry as string, '/assets/index-AfterTheDeploy.js') });
    });
    const ended = await joinAndBeRefused(page, 'bob');
    await ended.getByRole('heading', { name: 'This tab is from before an update' }).waitFor({ timeout: STEP_MS });
    const body = (await ended.locator('.app-fullpage__body').textContent()) ?? '';
    expect(body).toBe('smurg was updated while this tab was open, and the tab still runs the page from before. Reload the page to get the new one.');
    expect(body).not.toContain('smurg update');
    await ended.getByRole('button', { name: 'Reload the page' }).waitFor({ timeout: STEP_MS });
  });

  it('the same in Traditional Chinese', async () => {
    const page = await env.newPage({ locale: 'zh-TW' });
    const ended = await joinAndBeRefused(page, 'mei');
    await ended.getByRole('heading', { name: '主人的 smurg 比這個網頁舊' }).waitFor({ timeout: STEP_MS });
    expect(await ended.locator('.app-fullpage__body').textContent()).toBe('請主人停止分享、執行 smurg update，再重新開始分享（自己架設 relay 的主人要重新部署 relay）。然後重新整理這個頁面。');
    await ended.getByRole('button', { name: '重新整理頁面' }).waitFor({ timeout: STEP_MS });
  });
});
