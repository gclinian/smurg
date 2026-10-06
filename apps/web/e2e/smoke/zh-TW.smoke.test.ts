// The product in Traditional Chinese, in real browsers (the built app, the real relay, a daemon with every module,
// system Chrome with `locale: 'zh-TW'`): the join through an invite link, the sessions view, a terminal in a column,
// code mode with the daemon's sentences in the activity feed, and the relay's /device page. Most other smoke tests
// run in English; this one keeps the second language working end to end. (A suggestion accepted on a zh-TW page is in
// conversation.smoke.test.ts: it goes to an agent session, never into a terminal.)
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, columnOf, explainFailures, joinAs, openDrawer, openTerminal, rowOf, startSmoke, systemChrome, terminalOf, toCodeMode, typeInTerminal, waitForTerminalText, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

describe.skipIf(chrome === null)('the app in zh-TW (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# 班級專案\n', 'src/app.ts': 'export const x = 1;\n' } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  const lang = (page: Page): Promise<string | null> => page.locator('html').getAttribute('lang');

  it('join, the sessions view, a terminal in a column, code mode with the activity feed, and /device, all in Traditional Chinese', async () => {
    const host = await env.newPage({ locale: 'zh-TW' });
    // The join, step by step: Chinese from the first paint, through the login and the confirmation.
    await host.goto(env.hostLink());
    await host.getByRole('heading', { name: '登入後加入工作區' }).waitFor({ timeout: STEP_MS });
    expect(await lang(host)).toBe('zh-Hant-TW');
    await host.getByLabel('帳號名稱').fill('host');
    await host.getByRole('button', { name: '以開發用帳號登入' }).click();
    await host.getByRole('heading', { name: '要加入這個工作區嗎？' }).waitFor({ timeout: STEP_MS });
    await host.getByRole('button', { name: '加入', exact: true }).click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}`, { timeout: STEP_MS });
    await workspaceOnline(host);
    const topbar = host.getByRole('banner', { name: '工作區' });
    expect(await topbar.locator('.ui-badge').first().textContent()).toContain('主人');
    expect(await topbar.textContent()).toContain('主人：');

    // The sessions view in Chinese: the mode switch, the inbox, the session list and its "New" control.
    const mode = topbar.getByRole('group', { name: '模式' });
    expect(await mode.getByRole('link').allTextContents()).toEqual(['session', '手寫 code 模式']);
    await host.getByRole('complementary', { name: '收件夾與 session' }).waitFor({ timeout: STEP_MS });
    await host.getByRole('button', { name: '新增', exact: true }).waitFor({ timeout: STEP_MS });

    // A terminal, opened through the zh-TW menu and dialog; it is a column named by its title, and the host types into it.
    const sessionId = await openTerminal(host, 'shell');
    await columnOf(host, 'shell').locator('.agents-summary').getByText('你開的', { exact: true }).waitFor({ timeout: STEP_MS });
    await typeInTerminal(host, sessionId, 'echo ZH-$((6*7))');
    await waitForTerminalText(host, sessionId, 'ZH-42');

    // A guest (editor) joins, sees the terminal in the list and watches it: who opened it, and that it is watch-only.
    const guest = await env.newPage({ locale: 'zh-TW' });
    await joinAs(guest, env, 'mei', 'editor');
    expect(await guest.getByRole('banner', { name: '工作區' }).locator('.ui-badge').first().textContent()).toContain('可編輯');
    await rowOf(guest, 'shell').click();
    const watched = columnOf(guest, 'shell');
    await watched.locator('.agents-summary').getByText('host 開的', { exact: true }).waitFor({ timeout: STEP_MS });
    await watched.getByText('只能觀看').waitFor({ timeout: STEP_MS });
    expect(await terminalOf(guest, sessionId).getAttribute('data-readonly')).toBe('true');
    await waitForTerminalText(guest, sessionId, 'ZH-42');

    // Code mode. The daemon's own sentence in the feed, in the viewer's language: a file with a Chinese name.
    // (A new file goes next to the row that has the focus in the tree: README.md, in the root folder.)
    for (const page of [host, guest]) await toCodeMode(page);
    await host.getByRole('treeitem', { name: 'README.md' }).first().click();
    await host.locator('.editor-doc__monaco[data-bound]').waitFor({ timeout: STEP_MS });
    await host.getByRole('button', { name: '新增檔案' }).first().click();
    const dialog = host.getByRole('dialog', { name: '新增檔案' });
    await dialog.getByText('位置：根目錄').waitFor({ timeout: STEP_MS });
    await dialog.getByLabel('檔案名稱').fill('待辦清單.md');
    await dialog.getByRole('button', { name: '建立' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    for (const page of [host, guest]) {
      await openDrawer(page);
      await page.locator('.activity-feed').getByText('新增檔案 待辦清單.md', { exact: true }).first().waitFor({ timeout: STEP_MS });
    }

    // The relay's page for the CLI login, in the same browser: Chinese from Accept-Language alone (no cookie was set).
    expect((await host.context().cookies(env.origin)).some((c) => c.name === 'smurg_lang')).toBe(false);
    const device = await host.context().newPage();
    await device.goto(`${env.origin}/device`);
    await device.locator('body[data-state]').waitFor({ timeout: STEP_MS });
    expect(await lang(device)).toBe('zh-Hant-TW');
    await device.close();

    for (const page of [host, guest]) {
      expect(await lang(page)).toBe('zh-Hant-TW');
      expect(env.problemsOf(page).pageErrors).toEqual([]);
    }
  }, 300_000);
});
