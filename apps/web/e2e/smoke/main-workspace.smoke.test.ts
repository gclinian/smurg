// ARCHITECTURE §11 D-14 in a real browser (the built app, the real relay, a daemon with every module on a git share,
// system Chrome): a host that keeps guests out of the shared main workspace (config.sessions.guestMainWorkspace false —
// the default on a Linux host, set explicitly here so the test is the same on macOS and on Linux):
//  - the daemon publishes it (PublicSettings.guestMainWorkspace in the Welcome), and a runner's 「新增 session」 dialog
//    shows 「共享主工作區」 disabled with the reason and 「我的新 worktree」 preselected; the session opens in the runner's
//    own worktree and runs a command;
//  - the daemon refuses a main-mode request from a guest whatever a client sends (forbidden, main-workspace-off);
//  - the host's own session is not affected: the main workspace stays offered, preselected and used.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSmurgError } from '@smurg/protocol';
import { STEP_MS, joinAs, joinAsHost, openSession, startSmoke, systemChrome, typeInTerminal, waitForTerminalText, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

describe.skipIf(chrome === null)('D-14 guests kept out of the main workspace (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;

  beforeAll(async () => {
    env = await startSmoke({ stack: { git: true, projectFiles: { 'README.md': '# 班級專案\n' }, sessions: { guestMainWorkspace: false } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  it('a runner: 「共享主工作區」 is disabled with the reason, 「我的新 worktree」 is preselected, and the terminal opens and runs in their own worktree', async () => {
    const page = await env.newPage();
    await joinAs(page, env, 'nora', 'runner');
    await page.getByRole('button', { name: '新增 session' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新增 session' });
    await dialog.waitFor({ timeout: STEP_MS });
    const main = dialog.getByRole('radio', { name: /共享主工作區/ });
    expect(await main.isDisabled()).toBe(true);
    expect(await main.isChecked()).toBe(false);
    expect(await dialog.getByRole('radio', { name: /我的新 worktree/ }).isChecked()).toBe(true);
    const note = (await dialog.getByTestId('new-session-main-off').textContent()) ?? '';
    // The reason follows the host's platform (WorkspaceInfo.platform): the Linux default, or the host's own choice.
    expect(note).toContain(process.platform === 'linux' ? '這台主人電腦是 Linux：分享時預設不開放客人使用共享主工作區' : '主人分享時關閉了客人使用共享主工作區的功能。');
    expect(note).toContain('smurg host --allow-main-workspace-guests');
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    // The helper picks nothing for 「工作位置」: the preselected choice is what is sent.
    const sessionId = await openSession(page, 'terminal', 'nora-shell');
    const session = env.stack.daemon.ctx.services.sessions.get(sessionId);
    expect(session).toMatchObject({ kind: 'terminal', sandboxed: true, status: 'running', ownerUserId: 'dev:nora' });
    expect(session?.root.kind).toBe('worktree');
    await typeInTerminal(page, sessionId, 'echo D14-$((6*7))');
    await waitForTerminalText(page, sessionId, 'D14-42');
    expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 240_000);

  it("the daemon refuses a guest's main-mode request whatever the client sends; the host's own session still uses the main workspace", async () => {
    const otto = await env.stack.join({ name: 'otto', role: 'runner' });
    const refused = await otto.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isSmurgError(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'forbidden', detail: { reason: 'main-workspace-off' } });
    otto.close();

    const host = await env.newPage();
    await joinAsHost(host, env);
    await host.getByRole('button', { name: '新增 session' }).first().click();
    const dialog = host.getByRole('dialog', { name: '新增 session' });
    await dialog.waitFor({ timeout: STEP_MS });
    const main = dialog.getByRole('radio', { name: /共享主工作區/ });
    expect(await main.isDisabled()).toBe(false);
    expect(await main.isChecked()).toBe(true);
    expect(await dialog.getByTestId('new-session-main-off').count()).toBe(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
    const sessionId = await openSession(host, 'terminal', 'host-shell');
    expect(env.stack.daemon.ctx.services.sessions.get(sessionId)).toMatchObject({ sandboxed: false, root: { kind: 'main' } });
    expect(env.problemsOf(host).pageErrors).toEqual([]);
  }, 240_000);
});
