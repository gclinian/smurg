// Smoke test of the whole product as a person meets it: the web app as BUILT for production (vite build, the output
// of globalSetup) served by the REAL relay (local workerd, its Worker serving the SPA assets exactly like production,
// one origin for app, auth and WebSockets), a REAL daemon composing every module (tests/e2e startStack), and system
// Chrome driven headless by playwright-core in a fresh context (no profile, no cookies imported; login is the relay's
// dev login). Join with an invite link → the workspace is visible → open a file → type → the file on disk changes.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '../../../relay/test-support/index.ts';
import { startStack, waitUntil, type Stack } from '../../../../tests/e2e/src/harness.ts';
import { chromeLaunchOptions, systemChrome } from '../chrome.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const ORIGINAL = 'export const x = 1;\n';
/** The join test's own file: the co-editing test types into src/app.ts, and the tests must not depend on their order. */
const JOIN_ORIGINAL = 'export const joined = 1;\n';

describe.skipIf(chrome === null)('the built web app, served by the real relay, against a daemon with every module (system Chrome)', () => {
  let relay: LocalRelay;
  let stack: Stack;
  let browser: Browser;
  /** Errors of every page of this file (the CSP check covers them all, whatever order the tests ran in)… */
  const errors: string[] = [];
  /** …and of each page on its own (a test checks only its own pages). */
  const pageErrors = new Map<Page, string[]>();

  beforeAll(async () => {
    const webDist = join(process.env['TMPDIR'] as string, 'web-dist');
    relay = await startLocalRelay({ tap: false, webDist });
    stack = await startStack({ relay, projectFiles: { 'README.md': '# 班級專案\n', 'src/app.ts': ORIGINAL, 'src/join.ts': JOIN_ORIGINAL } });
    browser = await chromium.launch(chromeLaunchOptions(chrome as string));
  }, 180_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await stack?.stop().catch(() => {});
    await relay?.stop().catch(() => {});
    // SEC-E-04, independent of the order of the tests: no page of this file hit the Content-Security-Policy.
    expect(errors.filter((line) => /Content Security Policy|Refused to/.test(line))).toEqual([]);
  }, 60_000);

  async function freshPage(): Promise<Page> {
    const context = await browser.newContext({ locale: 'zh-TW' });
    const page = await context.newPage();
    const own: string[] = [];
    pageErrors.set(page, own);
    const record = (line: string): void => {
      errors.push(line);
      own.push(line);
    };
    page.on('pageerror', (error) => record(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') record(`console: ${message.text()}`);
    });
    return page;
  }

  it('serves the production build (not the stand-in page) from the relay origin', async () => {
    const index = await (await fetch(`${relay.origin}/`)).text();
    expect(index).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(index).not.toContain('尚未建置網頁介面');
    // An app route is the SPA too (not_found_handling: single-page-application); relay routes stay the Worker's.
    expect(await (await fetch(`${relay.origin}/w/${stack.workspaceId}`)).text()).toBe(index);
    expect((await fetch(`${relay.origin}/healthz`)).ok).toBe(true);
  });

  /** The join page's explicit 「加入」 (SEC-E-02: an invite link never joins on page load). */
  async function confirmJoin(page: Page): Promise<void> {
    await page.getByTestId('join-confirm').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: '加入', exact: true }).click();
  }

  /** Joins through a fresh invite with the relay's dev login; resolves on the connected workspace. */
  async function joinWorkspace(page: Page, name: string, role: 'editor' | 'runner' = 'editor'): Promise<void> {
    await page.goto(await stack.createInvite(role));
    await page.getByTestId('join-login').waitFor({ timeout: 60_000 });
    await page.getByLabel('帳號名稱').fill(name);
    await page.getByRole('button', { name: '以開發用帳號登入' }).click();
    await confirmJoin(page);
    await page.waitForURL(`${relay.origin}/w/${stack.workspaceId}`, { timeout: 60_000 });
    await page.getByRole('banner', { name: '工作區' }).getByText('已連線').waitFor({ timeout: 60_000 });
  }

  /** Clicks through the file tree (folders, then the file) and waits for the bound editor. */
  async function openInEditor(page: Page, ...items: string[]): Promise<void> {
    for (const name of items) await page.getByRole('treeitem', { name }).first().click();
    await page.locator('.editor-doc__monaco[data-bound]').waitFor({ timeout: 60_000 });
  }

  /** What Monaco shows (it renders spaces as U+00A0). */
  async function shown(page: Page): Promise<string> {
    return ((await page.locator('.editor-doc__monaco .view-lines').textContent()) ?? '').replace(/\u00a0/g, ' ');
  }

  it('join with an invite link → workspace visible → open a file → type → the file on disk changes', async () => {
    const page = await freshPage();
    // The daemon prints links on its web origin: here the relay itself, which serves the app.
    const invite = await stack.createInvite('editor');
    expect(invite.startsWith(`${relay.origin}/join/${stack.workspaceId}#k=`)).toBe(true);

    await page.goto(invite);
    await page.getByTestId('join-login').waitFor({ timeout: 60_000 });
    expect(page.url()).not.toContain('#');
    await page.getByLabel('帳號名稱').fill('amy');
    await page.getByRole('button', { name: '以開發用帳號登入' }).click();
    await confirmJoin(page);
    await page.waitForURL(`${relay.origin}/w/${stack.workspaceId}`, { timeout: 60_000 });
    const banner = page.getByRole('banner', { name: '工作區' });
    await banner.getByText('已連線').waitFor({ timeout: 60_000 });
    // The daemon admitted Amy as an editor through the invite.
    expect(stack.daemon.ctx.members.active('dev:amy')?.role).toBe('editor');

    // The file tree (files module) → open src/join.ts in the editor (docs module, Monaco + Yjs, lazy chunks).
    await page.getByRole('treeitem', { name: 'src' }).first().click();
    await page.getByRole('treeitem', { name: 'join.ts' }).first().click();
    const editor = page.locator('.editor-doc__monaco[data-bound]');
    await editor.waitFor({ timeout: 60_000 });
    await page.locator('.editor-doc__monaco .view-lines').getByText('export const joined = 1;').waitFor({ timeout: 30_000 });

    // Type at the end of the first line; autosave (D13) writes it to the host's disk.
    await page.locator('.editor-doc__monaco .view-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' // 從 Chrome 輸入');
    const onDisk = join(stack.root, 'src', 'join.ts');
    await waitUntil(async () => (await readFile(onDisk, 'utf8')).includes('// 從 Chrome 輸入'), 30_000, 'the typed text on disk');
    expect(await readFile(onDisk, 'utf8')).toBe('export const joined = 1; // 從 Chrome 輸入\n');
    // The edit is the human's: the daemon holds Amy's edit lock while she types.
    expect(stack.daemon.ctx.services.locks.get({ root: { kind: 'main' }, path: 'src/join.ts' })).toMatchObject({ kind: 'human', holders: [{ userId: 'dev:amy' }] });
    expect((pageErrors.get(page) ?? []).filter((line) => !/Failed to load resource/.test(line))).toEqual([]);
  });

  it('兩個人同時編輯同一個檔案，雙方 1 秒內看到對方的修改，不遺失任何字元 — two browsers on the built app', async () => {
    const [cleo, dave] = [await freshPage(), await freshPage()];
    await joinWorkspace(cleo, 'cleo');
    await joinWorkspace(dave, 'dave');
    await openInEditor(cleo, 'src', 'app.ts');
    await openInEditor(dave, 'src', 'app.ts');
    const before = await shown(dave);
    await cleo.locator('.editor-doc__monaco .view-line').last().click();
    await dave.locator('.editor-doc__monaco .view-line').first().click();
    await cleo.keyboard.press('End');
    await dave.keyboard.press('Home');
    // Both type at the same time, CJK and emoji included.
    const t0 = Date.now();
    await Promise.all([cleo.keyboard.type('/*克里歐✨*/'), dave.keyboard.type('/*戴夫🚀*/')]);
    await dave.waitForFunction(() => (document.querySelector('.editor-doc__monaco .view-lines')?.textContent ?? '').includes('克里歐✨'), undefined, { timeout: 10_000 });
    const seenAfter = Date.now() - t0;
    console.info(`[R7.1 web] the other browser showed the text ${seenAfter} ms after typing started (typing itself included)`);
    for (const page of [cleo, dave]) {
      await page.waitForFunction(() => {
        const text = document.querySelector('.editor-doc__monaco .view-lines')?.textContent ?? '';
        return text.includes('/*克里歐✨*/') && text.includes('/*戴夫🚀*/');
      }, undefined, { timeout: 10_000 });
    }
    expect(await shown(cleo)).toBe(await shown(dave));
    expect((await shown(cleo)).length).toBe(before.length + '/*克里歐✨*/'.length + '/*戴夫🚀*/'.length);
    // …and the disk gets both (autosave).
    const onDisk = join(stack.root, 'src', 'app.ts');
    await waitUntil(async () => {
      const text = await readFile(onDisk, 'utf8');
      return text.includes('/*克里歐✨*/') && text.includes('/*戴夫🚀*/');
    }, 30_000, 'both edits on disk');
  });

  it('agent 正在修改的檔案，所有人的編輯器暫時唯讀並顯示提示；完成後自動恢復可編輯 — the banner in two browsers on the built app', async () => {
    const [erin, finn] = [await freshPage(), await freshPage()];
    await joinWorkspace(erin, 'erin');
    await joinWorkspace(finn, 'finn');
    // A file nobody else types in (the other tests hold human locks on src/app.ts and src/join.ts for 30 s of idle time).
    await openInEditor(erin, 'README.md');
    await openInEditor(finn, 'README.md');
    const file = { root: { kind: 'main' as const }, path: 'README.md' };
    const onDisk = join(stack.root, 'README.md');
    const locks = stack.daemon.ctx.services.locks;
    expect(locks.get(file)).toBeNull();
    // The agent asks through the lock manager, as the hook socket does for PreToolUse.
    const granted = locks.requestAgent({ file, sessionId: 'ses_smoke_agent', ownerUserId: stack.host.userId, agentName: 'Claude（Host）', sessionRoot: { kind: 'main' } });
    expect(granted.granted).toBe(true);
    for (const page of [erin, finn]) {
      const banner = page.locator('.editor-doc__lock');
      await banner.waitFor({ timeout: 15_000 });
      expect(await banner.textContent()).toContain('Claude（Host）');
    }
    // Typing is ignored while the agent holds the file.
    const before = await shown(erin);
    await erin.locator('.editor-doc__monaco .view-line').first().click();
    await erin.keyboard.type('blocked');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await shown(erin)).toBe(before);
    expect(await readFile(onDisk, 'utf8')).not.toContain('blocked');
    // The agent is done (PostToolUse): the banner goes away and typing works again.
    locks.releaseAgent('ses_smoke_agent');
    for (const page of [erin, finn]) await page.locator('.editor-doc__lock').waitFor({ state: 'detached', timeout: 15_000 });
    await finn.locator('.editor-doc__monaco .view-line').first().click();
    await finn.keyboard.press('Home');
    await finn.keyboard.type('<!-- again -->');
    await waitUntil(async () => (await readFile(onDisk, 'utf8')).includes('<!-- again -->'), 30_000, 'the edit after the release on disk');
  });

  it('a runner opens a sandboxed terminal from the agents panel and runs a command in it (the built app, real PTY, real srt)', async () => {
    const page = await freshPage();
    await joinWorkspace(page, 'gina', 'runner');
    await page.getByRole('button', { name: '新增 session' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新增 session' });
    await dialog.waitFor({ timeout: 15_000 });
    await dialog.getByText('一般終端機').click();
    await dialog.getByRole('button', { name: '開啟' }).click();
    const viewport = page.locator('.agents-term__viewport[data-phase="live"]');
    await viewport.waitFor({ timeout: 60_000 });
    const sessions = stack.daemon.ctx.services.sessions.list();
    expect(sessions.find((session) => session.ownerUserId === 'dev:gina')).toMatchObject({ kind: 'terminal', sandboxed: true, status: 'running' });
    await viewport.click();
    await page.keyboard.type('echo web-$((5*5))');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('.agents-term__viewport')?.textContent ?? '').includes('web-25'), undefined, { timeout: 30_000 });
  });

  it('the app is served with a Content-Security-Policy, frame and sniffing protections; the build manifest is not served (SEC-E-04)', async () => {
    for (const path of ['/', `/join/${stack.workspaceId}`, `/w/${stack.workspaceId}/console`]) {
      const res = await fetch(`${relay.origin}${path}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("object-src 'none'");
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
    }
    const manifest = await fetch(`${relay.origin}/.vite/manifest.json`);
    expect(await manifest.text()).not.toMatch(/"isEntry"/);
    // Everything that ran so far (join, Monaco, co-editing, the lock banner, xterm, the transfer worker) ran under that
    // policy: not one violation in any browser of this file (afterAll checks the same once every test ran).
    expect(errors.filter((line) => /Content Security Policy|Refused to/.test(line))).toEqual([]);
  });
});
