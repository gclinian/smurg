// A tab that stays open across a deploy of the web app, and a tab that loses its network (0.5.1, DESIGN D2): the
// BUILT app served by the real relay, a daemon composing the release's modules, system Chrome driven headless.
//
// The relay serves the app as files named after their content, and it answers an address it has no file for with the
// page itself (`not_found_handling: single-page-application`). So after a deploy, a tab of the build before asks, the
// first time it shows a column, code mode or the editor, for a file that is gone, gets HTML, and the browser refuses
// it as a script. Before 0.5.1 that was an empty page (a route), a column that "cannot be shown" with a "Show again"
// that could not work, or nothing at all. The unit tests cover the decision with given answers (src/lib/chunks.test.tsx);
// only a browser proves what a real import does with the relay's real answer, and what the person then sees.
//
// "A deploy" here: every request of the page under /assets/ is sent on to the relay under a name it has no file for,
// so the answer IS the relay's own answer for a file that is gone. "The new page" after the reload: the same files
// again (the relay has one build; what matters is that the reload loads a whole page and the workspace is back).
//
// The two Workers of the app (the file transfer's, the editor's) are files of the build too, loaded when code mode
// starts. Their load is not an import: the browser fires an `error` event at the Worker. A step below takes only
// those two files away (the deploy came between code mode's chunk and its Workers) and reads what the page says.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, columnOf, explainFailures, joinAs, joinAsHost, openTerminal, rowOf, startSmoke, systemChrome, terminalOf, toCodeMode, typeInTerminal, waitForTerminalText, waitUntil, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** The terminal the host opened before anyone else came: its column's code is a chunk no other page has asked for. */
const TERMINAL = 'build log';
/** A Worker's file in the build: `transfer.worker-<hash>.js`, `editor.worker-<hash>.js`. */
const WORKER_FILE = /\.worker-[\w-]+\.js$/;

describe.skipIf(chrome === null)('a tab across a deploy of the web app, and a tab without its network (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;
  let sessionId: string;

  beforeAll(async () => {
    env = await startSmoke({
      stack: {
        projectFiles: { 'README.md': '# Class project\n', 'src/app.ts': 'export const x = 1;\n' },
        // This machine's disk may be nearly full: the default reserve would refuse the small upload of the Workers' step.
        settings: { diskReserveBytes: 0, diskReservePercent: 0 },
      },
    });
    const host = await env.newPage();
    await joinAsHost(host, env);
    sessionId = await openTerminal(host, TERMINAL);
    await typeInTerminal(host, sessionId, 'echo deploy-$((6*7))');
    await waitForTerminalText(host, sessionId, 'deploy-42');
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  /** Which files of the app this page has asked the relay for (by their path). */
  function watchAssets(page: Page): Set<string> {
    const asked = new Set<string>();
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === env.origin && url.pathname.startsWith('/assets/')) asked.add(url.pathname);
    });
    return asked;
  }

  /** From now on the relay has none of the files this page asks for: what a deploy leaves a tab of the build before. */
  async function deploy(page: Page): Promise<() => Promise<void>> {
    const pattern = `${env.origin}/assets/**`;
    await page.route(pattern, (route) => {
      const name = new URL(route.request().url()).pathname.slice('/assets/'.length);
      void route.continue({ url: `${env.origin}/assets/gone-with-the-deploy/${name}` });
    });
    return () => page.unroute(pattern);
  }

  it('the relay answers a file it does not have with the page itself (what the app tells "gone" from "offline" by)', async () => {
    const index = await fetch(`${env.origin}/`, { headers: { 'accept-language': 'en' } });
    const gone = await fetch(`${env.origin}/assets/gone-with-the-deploy/TerminalColumn-00000000.js`, { headers: { 'accept-language': 'en', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script' } });
    expect(gone.status).toBe(200);
    expect(gone.headers.get('content-type')).toMatch(/^text\/html/);
    expect(gone.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await gone.text()).toBe(await index.text());
  });

  it('after a deploy, a column and code mode whose files are gone say "smurg was updated" with Reload; the reload brings the page back', async () => {
    const page = await env.newPage();
    const asked = watchAssets(page);
    await joinAs(page, env, 'amy', 'editor');
    await rowOf(page, TERMINAL).waitFor({ timeout: STEP_MS });
    // The premise: this page has not loaded the terminal column's code, nor code mode's.
    const before = [...asked];
    expect(before.some((path) => /\/TerminalColumn-/.test(path))).toBe(false);
    expect(before.some((path) => /\/Workbench-/.test(path))).toBe(false);

    const undeploy = await deploy(page);

    // A column whose chunk was not loaded yet.
    await rowOf(page, TERMINAL).click();
    const column = columnOf(page, TERMINAL);
    const notice = column.getByRole('alert');
    await notice.waitFor({ timeout: STEP_MS });
    expect(await notice.getAttribute('data-chunk-failure')).toBe('gone');
    expect(await notice.textContent()).toBe('smurg was updatedReload to get the new page; if the host has not updated yet, the page will say so.Reload the page');
    await notice.getByRole('button', { name: 'Reload the page' }).waitFor({ timeout: STEP_MS });
    // Not the words of a crash, and no retry that cannot work.
    expect(await column.textContent()).not.toContain('cannot be shown');
    expect(await page.getByRole('button', { name: 'Show again' }).count()).toBe(0);
    expect([...asked].some((path) => /\/TerminalColumn-/.test(path))).toBe(true);
    // The rest of the page is as it was: connected, the list there, the column closable.
    await workspaceOnline(page);
    await rowOf(page, TERMINAL).waitFor({ timeout: STEP_MS });

    // Code mode is a route's chunk: the whole page says it, instead of going empty; going back shows the sessions view.
    await page.locator('.app-topbar__mode a[href$="/code"]').click();
    const whole = page.getByTestId('page-not-loaded');
    await whole.waitFor({ timeout: STEP_MS });
    expect(await whole.getByRole('heading').textContent()).toBe('smurg was updated');
    expect(await whole.textContent()).toContain('Reload to get the new page; if the host has not updated yet, the page will say so.');
    await whole.getByRole('button', { name: 'Reload the page' }).waitFor({ timeout: STEP_MS });
    await page.goBack();
    await whole.waitFor({ state: 'detached', timeout: STEP_MS });
    await workspaceOnline(page);
    await columnOf(page, TERMINAL).getByRole('alert').waitFor({ timeout: STEP_MS });

    // Reload: the page that is served now loads whole, the workspace is back, and the column shows the terminal.
    await undeploy();
    await Promise.all([page.waitForEvent('load', { timeout: STEP_MS }), columnOf(page, TERMINAL).getByRole('button', { name: 'Reload the page' }).click()]);
    await workspaceOnline(page);
    await terminalOf(page, sessionId).and(page.locator('[data-phase="live"]')).waitFor({ timeout: STEP_MS });
    await waitForTerminalText(page, sessionId, 'deploy-42');
    expect(await page.getByRole('alert').filter({ hasText: 'smurg was updated' }).count()).toBe(0);
    // The page never ran into the Content-Security-Policy on the way (asking the relay why a file did not come is a fetch).
    expect(env.problemsOf(page).console.filter((line) => /Content Security Policy/.test(line))).toEqual([]);
  });

  it('the same in Traditional Chinese: the notice and its Reload are in the language of the page', async () => {
    const page = await env.newPage({ locale: 'zh-TW' });
    await joinAs(page, env, 'mei', 'editor');
    await rowOf(page, TERMINAL).waitFor({ timeout: STEP_MS });
    const undeploy = await deploy(page);
    await rowOf(page, TERMINAL).click();
    const notice = columnOf(page, TERMINAL).getByRole('alert');
    await notice.waitFor({ timeout: STEP_MS });
    expect(await notice.getAttribute('data-chunk-failure')).toBe('gone');
    expect(await notice.textContent()).toBe('smurg 已經更新重新整理頁面就會換成新的網頁；如果主人還沒更新，頁面會告訴你。重新整理頁面');
    await undeploy();
    await Promise.all([page.waitForEvent('load', { timeout: STEP_MS }), notice.getByRole('button', { name: '重新整理頁面' }).click()]);
    await workspaceOnline(page);
    await waitForTerminalText(page, sessionId, 'deploy-42');
  });

  it('an error page for the file (what a proxy in front of the relay sends: a 503 in HTML) is not "smurg was updated"; the reload brings the column', async () => {
    const page = await env.newPage();
    await joinAs(page, env, 'cho', 'editor');
    await rowOf(page, TERMINAL).waitFor({ timeout: STEP_MS });
    // The import and the page's own question about the file both get the proxy's page: HTML, but with an error status.
    const pattern = `${env.origin}/assets/TerminalColumn-*`;
    const asked: string[] = [];
    await page.route(pattern, (route) => {
      asked.push(route.request().resourceType());
      void route.fulfill({ status: 503, contentType: 'text/html; charset=utf-8', body: '<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>' });
    });
    await rowOf(page, TERMINAL).click();
    const notice = columnOf(page, TERMINAL).getByRole('alert');
    await notice.waitFor({ timeout: STEP_MS });
    expect(await notice.getAttribute('data-chunk-failure')).toBe('failed');
    expect(await notice.textContent()).toBe('This part of the page could not be loadedReload the page to load it again.Reload the page');
    expect(await page.getByText('smurg was updated').count()).toBe(0);
    // The page did ask about the file itself (a fetch), and that answer was the error page too.
    expect(asked).toContain('fetch');

    await page.unroute(pattern);
    await Promise.all([page.waitForEvent('load', { timeout: STEP_MS }), notice.getByRole('button', { name: 'Reload the page' }).click()]);
    await workspaceOnline(page);
    await waitForTerminalText(page, sessionId, 'deploy-42');
  });

  it("the Workers' files are gone: the transfers panel and a tried upload say \"smurg was updated\" with Reload, the editor goes on and the banner says it; after the reload the upload arrives", async () => {
    const page = await env.newPage();
    await joinAs(page, env, 'dee', 'editor');
    const source = join(process.env['TMPDIR'] as string, 'after-the-deploy.txt');
    const onHost = join(env.stack.root, 'after-the-deploy.txt');
    await writeFile(source, 'uploaded after the reload\n');
    try {
      // The deploy took every file of this tab's build. The tab had loaded all that code mode needs except the two
      // Workers' files: they get the relay's answer for a file that is gone, and so does the page's own question about
      // its build (a fetch; a Worker's failed load names no file, so the page asks for its entry script).
      const pattern = `${env.origin}/assets/**`;
      const workerAnswers: string[] = [];
      page.on('response', (response) => {
        const name = new URL(response.url()).pathname.split('/').pop() ?? '';
        if (WORKER_FILE.test(name)) workerAnswers.push(`${name.split('.')[0]}: ${response.status()} ${response.headers()['content-type'] ?? ''}`);
      });
      await page.context().route(pattern, (route) => {
        const request = route.request();
        const name = new URL(request.url()).pathname.slice('/assets/'.length);
        if (!WORKER_FILE.test(name) && request.resourceType() !== 'fetch') return void route.continue();
        void route.continue({ url: `${env.origin}/assets/gone-with-the-deploy/${name}` });
      });

      await toCodeMode(page);
      // The editor works without its Worker (Monaco runs that code in the page), and what happened is said where a
      // failure without a place of its own is said: the workspace's banner.
      await page.getByRole('treeitem', { name: 'README.md' }).first().click();
      await page.locator('.monaco-editor .view-lines', { hasText: 'Class project' }).first().waitFor({ timeout: STEP_MS });
      const banner = page.locator('.app-banners [data-chunk-failure]');
      await banner.waitFor({ timeout: STEP_MS });
      expect(await banner.getAttribute('data-chunk-failure')).toBe('gone');
      expect(await page.locator('.app-banners [role="alert"]').filter({ has: page.locator('[data-chunk-failure]') }).textContent()).toBe('smurg was updatedReload to get the new page; if the host has not updated yet, the page will say so.Reload the page');

      // The transfers panel: the notice in its place, and never "worker error".
      await page.getByRole('tab', { name: 'Transfers' }).click();
      const notice = page.getByRole('region', { name: 'Uploads and downloads' }).getByRole('alert');
      await notice.waitFor({ timeout: STEP_MS });
      expect(await notice.getAttribute('data-chunk-failure')).toBe('gone');
      expect(await notice.textContent()).toBe('smurg was updatedReload to get the new page; if the host has not updated yet, the page will say so.Reload the page');
      expect(await page.getByText('worker error').count()).toBe(0);
      expect(await page.getByText('The transfer component could not start').count()).toBe(0);

      // A file handed over all the same: the same words where the person is looking, with the same way out; nothing arrives.
      await page.locator('input[type=file][multiple][hidden]').first().setInputFiles(source);
      const toast = page.locator('.ui-toast').filter({ hasText: 'smurg was updated' });
      await toast.waitFor({ timeout: STEP_MS });
      expect(await toast.textContent()).toContain('Reload to get the new page; if the host has not updated yet, the page will say so.');
      await toast.getByRole('button', { name: 'Reload the page' }).waitFor({ timeout: STEP_MS });
      expect(await page.getByTestId('transfer-item').count()).toBe(0);
      expect(await readFile(onHost, 'utf8').catch(() => null)).toBeNull();
      // Nothing of the app's own threw. ("Event" is Monaco's: it throws what the Worker's `error` event handed it, from
      // a timer, as its way of reporting; it reaches the console and nothing else.)
      expect(env.problemsOf(page).pageErrors.filter((message) => message !== 'Event')).toEqual([]);
      // The premise: both Workers were asked for, and both got the page itself.
      expect(workerAnswers.sort()).toEqual(['editor: 200 text/html; charset=utf-8', 'transfer: 200 text/html; charset=utf-8']);

      // Reload: the page that is served now, with its Workers; the same file arrives.
      await page.context().unroute(pattern);
      await Promise.all([page.waitForEvent('load', { timeout: STEP_MS }), notice.getByRole('button', { name: 'Reload the page' }).click()]);
      await workspaceOnline(page);
      await toCodeMode(page);
      await page.getByRole('tab', { name: 'Transfers' }).click();
      await page.locator('input[type=file][multiple][hidden]').first().setInputFiles(source);
      await page.getByTestId('transfer-item').filter({ hasText: 'after-the-deploy.txt' }).first().and(page.locator('[data-status=done]')).waitFor({ timeout: STEP_MS });
      await waitUntil(async () => (await readFile(onHost, 'utf8').catch(() => null)) === 'uploaded after the reload\n', STEP_MS, 'the upload on the host');
      expect(await page.locator('[data-chunk-failure]').count()).toBe(0);
    } finally {
      await rm(source, { force: true });
    }
  });

  it('without the network the same column says offline, not updated; with the network back, the reload brings it', async () => {
    const page = await env.newPage();
    await joinAs(page, env, 'bob', 'editor');
    await rowOf(page, TERMINAL).waitFor({ timeout: STEP_MS });
    await page.context().setOffline(true);
    await rowOf(page, TERMINAL).click();
    const notice = columnOf(page, TERMINAL).getByRole('alert');
    await notice.waitFor({ timeout: STEP_MS });
    expect(await notice.getAttribute('data-chunk-failure')).toBe('offline');
    const text = (await notice.textContent()) ?? '';
    expect(text).toBe('This part of the page could not be loadedThe browser is offline or cannot reach the smurg server. When the connection is back, reload the page.Reload the page');
    expect(text).not.toMatch(/updated/);
    expect(await page.getByText('smurg was updated').count()).toBe(0);

    await page.context().setOffline(false);
    await Promise.all([page.waitForEvent('load', { timeout: STEP_MS }), notice.getByRole('button', { name: 'Reload the page' }).click()]);
    await workspaceOnline(page);
    await waitForTerminalText(page, sessionId, 'deploy-42');
  });
});
