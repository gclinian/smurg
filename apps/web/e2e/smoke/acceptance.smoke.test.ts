// Acceptance criteria that were covered only in jsdom, now in real browsers on the BUILT app (docs/ACCEPTANCE.md
// R11.1c, R6, R9, R8.4): the production build served by the real relay, a daemon composing every module on a git
// repository, system Chrome driven headless (fresh contexts, the relay's dev login). Every step waits for a condition.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, explainFailures, joinAs, joinAsHost, openSession, startSmoke, systemChrome, terminalShows, typeInTerminal, waitForTerminalText, waitUntil, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const NOTES = 'line one\nline two\nline three\n';

describe.skipIf(chrome === null)('acceptance in real browsers: console, suggestions, worktree merge, conflicts (built app, real relay)', () => {
  let env: SmokeEnv;
  let host: Page;

  beforeAll(async () => {
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# 班級專案\n', 'src/app.ts': 'export const x = 1;\n', 'notes.md': NOTES },
        // Rita's terminal (R11.1c) runs in the main workspace: open it to guests explicitly, so the test is the same on
        // a Linux host, where it is off by default (ARCHITECTURE §11 D-14). Wes works in a worktree either way (R9).
        sessions: { guestMainWorkspace: true },
      },
    });
    host = await env.newPage();
    await joinAsHost(host, env);
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  // A failed test prints the daemon's log tail, audit and sessions (CI run 36810877157 said only "Timeout").
  explainFailures(() => env);

  /** The host's console, in the host's page. */
  async function openConsole(): Promise<void> {
    await host.getByRole('link', { name: '主人控制台' }).click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/console`, { timeout: STEP_MS });
  }

  /** Each test starts with the host on the workbench (a failed test may have left the console open). */
  async function onWorkbench(): Promise<void> {
    if (host.url() === `${env.origin}/w/${env.stack.workspaceId}`) return;
    await host.goto(`${env.origin}/w/${env.stack.workspaceId}`);
    await host.getByRole('banner', { name: '工作區' }).getByText('已連線').waitFor({ timeout: STEP_MS });
  }

  it('主人能從控制台一鍵終止任何 session 或踢掉任何成員 — one click each in the console (the kick after its confirmation), and the other browser shows the result: the session ended with the reason, the kicked screen', async () => {
    await onWorkbench();
    const rita = await env.newPage();
    await joinAs(rita, env, 'rita', 'runner');
    const sessionId = await openSession(rita, 'terminal', 'rita-shell');

    await openConsole();
    // One click: the session's row in the console.
    const terminate = host.getByRole('button', { name: /^終止.*「rita-shell」$/ });
    await terminate.waitFor({ timeout: STEP_MS });
    await terminate.click();
    // Rita's browser: the session ended, and it says who ended it.
    const summary = rita.locator(`.agents-session[data-session-id="${sessionId}"] .agents-summary`);
    await summary.getByText(/已被主人（.+）終止/).waitFor({ timeout: STEP_MS });
    expect(env.stack.daemon.ctx.services.sessions.get(sessionId)?.status).toBe('exited');

    // One click, then the confirmation that says what will happen.
    await host.getByRole('button', { name: /^踢出 rita$/i }).click();
    const dialog = host.getByRole('alertdialog', { name: /踢出 rita？/i });
    await dialog.waitFor({ timeout: STEP_MS });
    expect(await dialog.textContent()).toContain('所有裝置的金鑰被撤銷');
    await dialog.getByRole('button', { name: /^踢出 rita$/i }).click();
    // Rita's browser: the kicked screen, nothing of the workspace behind it.
    const ended = rita.getByTestId('connection-ended-screen');
    await ended.waitFor({ timeout: STEP_MS });
    expect(await ended.textContent()).toContain('你已被移出工作區');
    expect(env.stack.daemon.ctx.members.active('dev:rita')).toBeFalsy();
  }, 240_000);

  it('R6 建議流程 — a teammate suggests; the owner sees the queue, edits the text and accepts: exactly that text arrives in the owner\'s terminal; a rejected suggestion never arrives; the author sees both outcomes', async () => {
    await onWorkbench();
    const sessionId = await openSession(host, 'terminal', 'host-shell');
    const erin = await env.newPage();
    await joinAs(erin, env, 'erin', 'editor');
    await erin.getByRole('tab', { name: /host-shell/ }).first().click();

    // Erin suggests; nothing reaches the session before the owner decides.
    const composer = erin.getByRole('textbox', { name: /的「host-shell」的建議/ });
    await composer.waitFor({ timeout: STEP_MS });
    await composer.fill('echo SUGGESTED-BY-ERIN');
    await erin.getByRole('button', { name: '送出建議' }).click();
    const queue = host.getByRole('region', { name: /等待你決定的建議（1）/ }).or(host.locator('section[aria-label^="等待你決定的建議（1）"]'));
    await queue.first().waitFor({ timeout: STEP_MS });
    expect(await queue.first().textContent()).toContain('echo SUGGESTED-BY-ERIN');
    expect(await terminalShows(host, sessionId, 'SUGGESTED-BY-ERIN')).toBe(false);

    // The owner edits it before accepting: the edited text, and only it, is pasted into the owner's terminal.
    await queue.first().getByRole('button', { name: '修改後採用' }).click();
    await queue.first().getByRole('textbox', { name: '修改建議內容' }).fill('echo EDITED-BY-HOST');
    await queue.first().getByRole('button', { name: '採用修改後的內容' }).click();
    await waitForTerminalText(host, sessionId, 'echo EDITED-BY-HOST');
    expect(await terminalShows(host, sessionId, 'SUGGESTED-BY-ERIN')).toBe(false);
    // The author sees the outcome.
    await erin.getByText(/修改後採用了你的建議/).first().waitFor({ timeout: STEP_MS });

    // A second one is rejected: it never arrives; the author is told, with the reason.
    await composer.fill('echo SHOULD-NEVER-ARRIVE');
    await erin.getByRole('button', { name: '送出建議' }).click();
    const second = host.locator('section[aria-label^="等待你決定的建議（1）"]');
    await second.getByText('echo SHOULD-NEVER-ARRIVE').waitFor({ timeout: STEP_MS });
    await second.getByRole('button', { name: '拒絕' }).click();
    await second.getByRole('textbox', { name: /拒絕原因/ }).fill('先不要');
    await second.getByRole('button', { name: '確認拒絕' }).click();
    await erin.getByText(/拒絕了你的建議/).first().waitFor({ timeout: STEP_MS });
    await erin.getByText('原因：先不要').first().waitFor({ timeout: STEP_MS });
    // The owner's terminal (and the daemon's own screen of it) never got it.
    const suggestions = await env.stack.hostClient.conn.request('suggest.list', { sessionId });
    expect(suggestions.suggestions.map((s) => [s.text, s.status])).toEqual(
      expect.arrayContaining([
        ['echo SUGGESTED-BY-ERIN', 'accepted-modified'],
        ['echo SHOULD-NEVER-ARRIVE', 'rejected'],
      ]),
    );
    expect(await terminalShows(host, sessionId, 'SHOULD-NEVER-ARRIVE')).toBe(false);
    await typeInTerminal(host, sessionId, '');
    await typeInTerminal(host, sessionId, 'echo AFTER-THE-REJECTION');
    await waitForTerminalText(host, sessionId, 'AFTER-THE-REJECTION');
    expect(await terminalShows(host, sessionId, 'SHOULD-NEVER-ARRIVE')).toBe(false);
  }, 240_000);

  /** The worktree directory whose tree contains `file` (under <share>/.smurg/worktrees/). */
  async function worktreeWith(file: string): Promise<string | null> {
    const base = join(env.stack.root, '.smurg', 'worktrees');
    for (const id of await readdir(base).catch(() => [] as string[])) {
      const path = join(base, id, file);
      if (await readFile(path, 'utf8').then(() => true, () => false)) return join(base, id);
    }
    return null;
  }

  it('R9 合併 — a runner works in a worktree and requests a merge; the host reviews the complete diff and approves: the file is in the main workspace for everyone; a rejected request leaves the worktree as it was', async () => {
    await onWorkbench();
    const wes = await env.newPage();
    await joinAs(wes, env, 'wes', 'runner');
    const sessionId = await openSession(wes, 'terminal', 'wes-work', { worktree: true });
    await typeInTerminal(wes, sessionId, `printf 'from the worktree\\n' > merged-file.txt && echo WROTE-1`);
    await waitForTerminalText(wes, sessionId, 'WROTE-1');
    let worktreeDir: string | null = null;
    await waitUntil(async () => (worktreeDir = await worktreeWith('merged-file.txt')) !== null, STEP_MS, 'the file in the worktree');

    // Wes asks for the merge.
    await wes.getByRole('tab', { name: '合併請求' }).click();
    await wes.getByRole('button', { name: '請求合併' }).first().click();
    const request = wes.getByRole('dialog', { name: /請主人合併/ });
    await request.waitFor({ timeout: STEP_MS });
    await request.getByRole('textbox', { name: '說明（選填）' }).fill('新增 merged-file');
    await request.getByRole('button', { name: '送出合併請求' }).click();

    // The host reviews the whole diff and merges.
    await host.getByRole('tab', { name: '合併請求' }).click();
    await host.getByRole('button', { name: '審核' }).first().click();
    const review = host.getByRole('dialog', { name: /審核.*的合併請求/ });
    await review.waitFor({ timeout: STEP_MS });
    // The complete diff: the changed file, opened, with its added line.
    await review.getByRole('navigation', { name: '變更的檔案' }).getByText('merged-file.txt').first().click();
    await review.getByRole('region', { name: 'merged-file.txt 的差異' }).getByText('+from the worktree').waitFor({ timeout: STEP_MS });
    await review.getByRole('button', { name: '合併到主工作區' }).click();
    await review.getByRole('button', { name: '確認合併' }).click();
    await waitUntil(async () => (await readFile(join(env.stack.root, 'merged-file.txt'), 'utf8').catch(() => '')) === 'from the worktree\n', STEP_MS, 'the merged file in the main workspace');
    // Everyone sees it in the main workspace's file tree; the requester is told.
    const erin = await env.newPage();
    await joinAs(erin, env, 'fern', 'viewer');
    await erin.getByRole('treeitem', { name: 'merged-file.txt' }).first().waitFor({ timeout: STEP_MS });
    await wes.getByText('主人已把你的合併請求合併到主工作區。').first().waitFor({ timeout: STEP_MS });

    // A second change, rejected: the worktree stays exactly as it was, the main workspace does not get it.
    await typeInTerminal(wes, sessionId, `printf 'not wanted\\n' > rejected-file.txt && echo WROTE-2`);
    await waitForTerminalText(wes, sessionId, 'WROTE-2');
    await waitUntil(async () => (await readFile(join(worktreeDir as unknown as string, 'rejected-file.txt'), 'utf8').catch(() => '')) === 'not wanted\n', STEP_MS, 'the second file in the worktree');
    const before = (await readdir(worktreeDir as unknown as string)).sort();
    await wes.getByRole('button', { name: '請求合併' }).first().click();
    await wes.getByRole('dialog', { name: /請主人合併/ }).getByRole('button', { name: '送出合併請求' }).click();
    await host.getByRole('button', { name: '審核' }).first().waitFor({ timeout: STEP_MS });
    await host.getByRole('button', { name: '審核' }).first().click();
    const review2 = host.getByRole('dialog', { name: /審核.*的合併請求/ });
    await review2.getByText('rejected-file.txt').first().waitFor({ timeout: STEP_MS });
    await review2.getByRole('button', { name: '拒絕' }).click();
    await review2.getByRole('textbox', { name: /拒絕原因/ }).fill('這個不要');
    await review2.getByRole('button', { name: '確認拒絕' }).click();
    await wes.getByText('主人拒絕了你的合併請求。').first().waitFor({ timeout: STEP_MS });
    expect((await readdir(worktreeDir as unknown as string)).sort()).toEqual(before);
    expect(await readFile(join(worktreeDir as unknown as string, 'rejected-file.txt'), 'utf8')).toBe('not wanted\n');
    expect(await readFile(join(worktreeDir as unknown as string, 'merged-file.txt'), 'utf8')).toBe('from the worktree\n');
    expect(await readFile(join(env.stack.root, 'rejected-file.txt'), 'utf8').catch(() => null)).toBeNull();
  }, 300_000);

  it('R8.4 agent 透過 Bash 修改有人正在編輯的檔案時，人打的內容不會遺失；重疊部分出現在衝突面板 — a real conflict: the disk is written while a person types', async () => {
    const cara = await env.newPage();
    await joinAs(cara, env, 'cara', 'editor');
    await cara.getByRole('treeitem', { name: 'notes.md' }).first().click();
    await cara.locator('.editor-doc__monaco[data-bound]').waitFor({ timeout: STEP_MS });
    await cara.locator('.editor-doc__monaco .view-lines').getByText('line two').waitFor({ timeout: STEP_MS });
    // Cara types at the end of line two (she now holds the file's edit lock); autosave writes it.
    await cara.locator('.editor-doc__monaco .view-line').nth(1).click();
    await cara.keyboard.press('End');
    await cara.keyboard.type(' typed by cara');
    const onDisk = join(env.stack.root, 'notes.md');
    await waitUntil(async () => (await readFile(onDisk, 'utf8')).includes('line two typed by cara'), STEP_MS, 'the typed text on disk');
    expect(env.stack.daemon.ctx.services.locks.get({ root: { kind: 'main' }, path: 'notes.md' })).toMatchObject({ kind: 'human' });

    // Meanwhile something outside the editor (a shell command, e.g. an agent's sed) rewrites the same line on disk.
    await writeFile(onDisk, 'line one\nline two written on disk\nline three\n');

    // Her text is kept; the other version is in the conflict panel, side by side. (Who wrote it is the daemon's call:
    // within 5 s of her autosave the files module still names her — a known limit reported to the files owner.)
    await cara.getByRole('tab', { name: /衝突/ }).click();
    const conflict = cara.locator('article.conflict').filter({ hasText: 'notes.md' }).first();
    await conflict.waitFor({ timeout: STEP_MS });
    const text = (await conflict.textContent()) ?? '';
    expect(text).toContain('編輯中的內容（目前保留）');
    expect(text).toContain('line two typed by cara');
    expect(text).toContain('line two written on disk');
    await waitUntil(async () => (await readFile(onDisk, 'utf8')).includes('line two typed by cara'), STEP_MS, 'the human text written back');
    expect(((await cara.locator('.editor-doc__monaco .view-lines').textContent()) ?? '').replace(/ /g, ' ')).toContain('line two typed by cara');
  }, 240_000);
});
