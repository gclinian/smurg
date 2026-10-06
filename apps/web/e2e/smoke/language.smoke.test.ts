// The language of the app in a real browser (the built app, the real relay, a daemon with every module, system
// Chrome):
//  - an English browser (`en-US`) sees English everywhere a person goes: landing, join, the sessions view, code mode
//    with the activity feed (sentences the HOST wrote: they arrive as message references, not as text), the host
//    console and its audit log, an error. The whole document is scanned for CJK characters after each step, visible
//    text and accessible names alike, so a sentence of the daemon that came through untranslated fails the test;
//  - the language menu switches to Traditional Chinese without a reload; <html lang>, the stored choice and the
//    cookie follow; the choice survives a reload, and the relay's own page (/device) follows the cookie;
//  - detection: the first supported entry of the browser's languages decides (zh-HK is Traditional Chinese; zh-CN and
//    Japanese are not supported and get English).
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, chooseLanguage, cjkTexts, explainFailures, joinAs, openDrawer, startSmoke, systemChrome, toCodeMode, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** The one Chinese text an English page may show: the other language's own name, in the open language menu. */
const OTHER_LANGUAGE = '繁體中文';

describe.skipIf(chrome === null)('the language of the app (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;
  let host: Page;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# Class project\n', 'src/app.ts': 'export const x = 1;\n' } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  /** No CJK anywhere in the page: text, accessible names, titles, placeholders. */
  async function expectEnglishOnly(page: Page, where: string, allowed: readonly string[] = []): Promise<void> {
    expect(await cjkTexts(page, allowed), `Chinese text on an English page (${where})`).toEqual([]);
    expect(await page.locator('html').getAttribute('lang'), where).toBe('en');
  }

  it('an English browser sees English everywhere: landing, join, the sessions view, code mode with the activity feed, the console and an error (the whole document is scanned for CJK)', async () => {
    // Landing, logged out.
    host = await env.newPage();
    await host.goto(`${env.origin}/`);
    await host.getByTestId('dev-login-form').waitFor({ timeout: STEP_MS });
    await host.getByRole('heading', { level: 1, name: 'A live workspace for people and agents' }).waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'landing');
    // The language menu names each language in itself: the only Chinese on the page, and only while it is open.
    await host.getByRole('button', { name: 'Language' }).click();
    const items = host.getByRole('menu', { name: 'Language' }).getByRole('menuitemradio');
    expect(await items.allTextContents()).toEqual(['English', OTHER_LANGUAGE]);
    expect(await items.nth(1).locator('[lang]').getAttribute('lang')).toBe('zh-Hant-TW');
    await expectEnglishOnly(host, 'landing with the language menu open', [OTHER_LANGUAGE]);
    await host.keyboard.press('Escape');

    // Join (login, the confirmation), the sessions view, then code mode.
    await host.goto(env.hostLink());
    await host.getByTestId('join-login').waitFor({ timeout: STEP_MS });
    await host.getByRole('heading', { name: 'Log in to join the workspace' }).waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'join: login');
    await host.getByLabel('Account name').fill('host');
    await host.getByRole('button', { name: 'Log in with a development account' }).click();
    await host.getByTestId('join-confirm').waitFor({ timeout: STEP_MS });
    await host.getByRole('heading', { name: 'Join this workspace?' }).waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'join: confirmation');
    await host.getByRole('button', { name: 'Join', exact: true }).click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}`, { timeout: STEP_MS });
    await workspaceOnline(host);
    const topbar = host.getByRole('banner', { name: 'Workspace' });
    expect(await topbar.locator('.ui-badge').first().textContent()).toContain('Host');
    await host.getByRole('complementary', { name: 'Inbox and sessions' }).waitFor({ timeout: STEP_MS });
    await host.getByRole('heading', { level: 2, name: 'Start with a topic' }).waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'the sessions view');
    await toCodeMode(host);
    await host.getByRole('treeitem', { name: 'README.md' }).first().waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'code mode');

    // Something happens on the host: a new file. The feed's sentence is written by the daemon and rendered here.
    // (A new file goes next to the row that has the focus in the tree: README.md, in the root folder.)
    await host.getByRole('treeitem', { name: 'README.md' }).first().click();
    await host.locator('.editor-doc__monaco[data-bound]').waitFor({ timeout: STEP_MS });
    await host.getByRole('button', { name: 'New file' }).first().click();
    const dialog = host.getByRole('dialog', { name: 'New file' });
    await dialog.getByText('Location: root folder').waitFor({ timeout: STEP_MS });
    await dialog.getByLabel('File name').fill('notes.txt');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    await host.getByRole('treeitem', { name: 'notes.txt' }).first().waitFor({ timeout: STEP_MS });
    // The drawer starts collapsed on its first tab, the activity feed: its own button opens it.
    await openDrawer(host);
    const feed = host.locator('.activity-feed');
    await feed.getByText('Created the file notes.txt', { exact: true }).first().waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'code mode with the activity feed');

    // An error: the same name again is refused, in English, whoever notices first (the page or the host's computer).
    await host.getByRole('button', { name: 'New file' }).first().click();
    const again = host.getByRole('dialog', { name: 'New file' });
    await again.getByLabel('File name').fill('notes.txt');
    await again.getByRole('button', { name: 'Create' }).click().catch(() => {});
    const problem = again.getByRole('alert').first();
    await problem.waitFor({ timeout: STEP_MS });
    expect(((await problem.textContent()) ?? '').trim()).not.toBe('');
    await expectEnglishOnly(host, 'an error in the new-file dialog');
    await again.getByRole('button', { name: 'Cancel' }).click();
    await again.waitFor({ state: 'detached', timeout: STEP_MS });

    // A guest: their own role, the sessions view, and in code mode the same feed.
    const guest = await env.newPage();
    await joinAs(guest, env, 'gwen', 'editor');
    expect(await guest.getByRole('banner', { name: 'Workspace' }).locator('.ui-badge').first().textContent()).toContain('Editor');
    await expectEnglishOnly(guest, "the guest's sessions view");
    await toCodeMode(guest);
    await openDrawer(guest);
    await guest.locator('.activity-feed').getByText('Created the file notes.txt', { exact: true }).first().waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(guest, "the guest's code mode");

    // The host console: members, invites, the audit log (action names and outcomes come from codes).
    await host.getByRole('link', { name: 'Host console' }).click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/console`, { timeout: STEP_MS });
    const audit = host.locator('section').filter({ has: host.getByRole('heading', { level: 2, name: 'Audit log' }) });
    await audit.locator('tbody tr').first().waitFor({ timeout: STEP_MS });
    await host.getByText('gwen').first().waitFor({ timeout: STEP_MS });
    await expectEnglishOnly(host, 'the host console');

    for (const page of [host, guest]) expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 300_000);

  it('the language menu switches to Traditional Chinese without a reload; <html lang>, the stored choice and the cookie follow; the choice survives a reload and the relay page /device follows it', async () => {
    // Code mode, where the first test left the drawer open on the activity feed (the layout is remembered).
    await host.goto(`${env.origin}/w/${env.stack.workspaceId}/code`);
    await workspaceOnline(host);
    let navigations = 0;
    host.on('framenavigated', (frame) => {
      if (frame === host.mainFrame()) navigations += 1;
    });
    await chooseLanguage(host, 'zh-TW');
    // The same page, re-rendered: no navigation, the connection is the one it had.
    expect(navigations).toBe(0);
    await workspaceOnline(host);
    expect(await host.locator('html').getAttribute('lang')).toBe('zh-Hant-TW');
    const topbar = host.getByRole('banner', { name: '工作區' });
    expect(await topbar.locator('.ui-badge').first().textContent()).toContain('主人');
    await host.getByRole('button', { name: '離開' }).waitFor({ timeout: STEP_MS });
    // The mode switch and the feed (the drawer is still open): the same event of the host, now in Chinese.
    expect(await topbar.getByRole('group', { name: '模式' }).getByRole('link').allTextContents()).toEqual(['session', '手寫 code 模式']);
    expect(await host.getByRole('tab', { name: '活動', exact: true }).getAttribute('aria-selected')).toBe('true');
    await host.locator('.activity-feed').getByText('新增檔案 notes.txt', { exact: true }).first().waitFor({ timeout: STEP_MS });
    expect(await host.evaluate(() => window.localStorage.getItem('smurg.lang'))).toBe('zh-TW');
    const cookie = (await host.context().cookies(env.origin)).find((c) => c.name === 'smurg_lang');
    expect(cookie).toMatchObject({ value: 'zh-TW', path: '/', httpOnly: false, sameSite: 'Lax' });
    expect((cookie?.expires ?? 0) * 1000).toBeGreaterThan(Date.now() + 300 * 86_400_000);

    // A reload starts in the chosen language (the browser itself still says en-US).
    await host.reload();
    await workspaceOnline(host);
    expect(await host.locator('html').getAttribute('lang')).toBe('zh-Hant-TW');
    expect(await host.evaluate(() => navigator.languages[0])).toBe('en-US');

    // The relay's own page reads the cookie: /device is Chinese for this browser.
    const device = await host.context().newPage();
    await device.goto(`${env.origin}/device`);
    await device.locator('body[data-state]').waitFor({ timeout: STEP_MS });
    expect(await device.locator('html').getAttribute('lang')).toBe('zh-Hant-TW');
    expect(await cjkTexts(device)).not.toEqual([]);
    await device.close();

    // And back: English again, in the app and on /device.
    await chooseLanguage(host, 'en-US');
    await workspaceOnline(host);
    expect(await host.locator('html').getAttribute('lang')).toBe('en');
    expect((await host.context().cookies(env.origin)).find((c) => c.name === 'smurg_lang')?.value).toBe('en');
    const deviceEnglish = await host.context().newPage();
    await deviceEnglish.goto(`${env.origin}/device`);
    await deviceEnglish.locator('body[data-state]').waitFor({ timeout: STEP_MS });
    expect(await deviceEnglish.locator('html').getAttribute('lang')).toBe('en');
    await deviceEnglish.close();
    expect(env.problemsOf(host).pageErrors).toEqual([]);
  }, 240_000);

  it('detection: the first supported language of the browser decides (zh-HK: Traditional Chinese; zh-CN and ja: English), and the language link of /device is followed by the app', async () => {
    const landingLang = async (locale: string): Promise<{ lang: string | null; heading: string }> => {
      const context = await env.browser.newContext({ locale });
      try {
        const page = await context.newPage();
        await page.goto(`${env.origin}/`);
        await page.getByTestId('dev-login-form').waitFor({ timeout: STEP_MS });
        return { lang: await page.locator('html').getAttribute('lang'), heading: (await page.getByRole('heading', { level: 1 }).textContent()) ?? '' };
      } finally {
        await context.close();
      }
    };
    expect(await landingLang('zh-HK')).toEqual({ lang: 'zh-Hant-TW', heading: '多人 × 多 agent 即時協作工作區' });
    expect(await landingLang('zh-TW')).toEqual({ lang: 'zh-Hant-TW', heading: '多人 × 多 agent 即時協作工作區' });
    expect(await landingLang('zh-CN')).toEqual({ lang: 'en', heading: 'A live workspace for people and agents' });
    expect(await landingLang('ja-JP')).toEqual({ lang: 'en', heading: 'A live workspace for people and agents' });
    expect(await landingLang('en-GB')).toEqual({ lang: 'en', heading: 'A live workspace for people and agents' });

    // The other way round: a language chosen on the relay's page (its link sets the cookie) is the app's language.
    const context = await env.browser.newContext({ locale: 'en-US' });
    try {
      const page = await context.newPage();
      await page.goto(`${env.origin}/device?lang=zh-TW`);
      await page.locator('body[data-state]').waitFor({ timeout: STEP_MS });
      expect(new URL(page.url()).search).toBe('');
      await page.goto(`${env.origin}/`);
      await page.getByTestId('dev-login-form').waitFor({ timeout: STEP_MS });
      expect(await page.locator('html').getAttribute('lang')).toBe('zh-Hant-TW');
    } finally {
      await context.close();
    }
  }, 180_000);
});
