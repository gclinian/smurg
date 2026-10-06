// Acceptance criteria that were covered only in jsdom, now in real browsers on the BUILT app (docs/ACCEPTANCE.md
// R11.1c, R9, R8.4, and the role "Agent access"): the production build served by the real relay, a
// daemon composing every module on a git repository, system Chrome driven headless (fresh contexts, the relay's dev
// login). Every step waits for a condition.
//
// A member lands in the sessions view: a plain terminal is a column there; the file tree, the editor, the worktree
// switcher and the conflicts panel are code mode. (A suggestion goes to an agent session, never into a terminal:
// conversation.smoke.test.ts has that flow.)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, columnOf, explainFailures, joinAs, joinAsHost, newSessionDialog, newTerminalDialog, openFromList, openTerminal, rowOf, startSmoke, systemChrome, terminalOf, toCodeMode, toSessionsView, typeInTerminal, waitForTerminalText, waitUntil, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const NOTES = 'line one\nline two\nline three\n';

/** What the host confirms before handing out agent access (verbatim). */
const RISK = 'Anyone with agent access can have an agent run any command on your computer, read the files in your home directory and use your Claude account. Give it only to people you fully trust.';

describe.skipIf(chrome === null)('acceptance in real browsers: console, worktree merge, conflicts, agent access (built app, real relay)', () => {
  let env: SmokeEnv;
  let host: Page;

  beforeAll(async () => {
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Class project\n', 'src/app.ts': 'export const x = 1;\n', 'notes.md': NOTES },
      },
    });
    host = await env.newPage();
    await joinAsHost(host, env);
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  // A failed test prints the daemon's log tail, audit and sessions (a bare "Timeout" says nothing).
  explainFailures(() => env);

  /** The host's console, in the host's page. */
  async function openConsole(): Promise<void> {
    await host.getByRole('link', { name: 'Host console' }).click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/console`, { timeout: STEP_MS });
  }

  /** Each test starts with the host on the sessions view (a failed test may have left the console or code mode open). */
  async function onSessionsView(): Promise<void> {
    if (host.url() === `${env.origin}/w/${env.stack.workspaceId}`) return;
    await host.goto(`${env.origin}/w/${env.stack.workspaceId}`);
    await workspaceOnline(host);
  }

  it('the host can terminate any session or remove any member from the console with one click — one click each in the console (the removal after its confirmation), and the other browser shows the result: the session ended with the reason, the removed screen', async () => {
    await onSessionsView();
    const rita = await env.newPage();
    await joinAs(rita, env, 'rita', 'agent');
    const sessionId = await openTerminal(rita, 'rita-shell');

    await openConsole();
    // One click: the session's row in the console.
    const terminate = host.getByRole('button', { name: /^Terminate "rita-shell", opened by / });
    await terminate.waitFor({ timeout: STEP_MS });
    await terminate.click();
    // Rita's browser: the session ended, and it says who ended it.
    const summary = rita.locator(`.agents-session[data-session-id="${sessionId}"] .agents-summary`);
    await summary.getByText(/Terminated by the host \(.+\)/).waitFor({ timeout: STEP_MS });
    expect(env.stack.daemon.ctx.services.sessions.get(sessionId)?.status).toBe('exited');

    // One click, then the confirmation that says what will happen.
    await host.getByRole('button', { name: /^Remove rita$/i }).click();
    const dialog = host.getByRole('alertdialog', { name: /Remove rita\?/i });
    await dialog.waitFor({ timeout: STEP_MS });
    expect(await dialog.textContent()).toContain('The keys of all devices of rita are revoked.');
    await dialog.getByRole('button', { name: /^Remove rita$/i }).click();
    // Rita's browser: the removed screen, nothing of the workspace behind it.
    const ended = rita.getByTestId('connection-ended-screen');
    await ended.waitFor({ timeout: STEP_MS });
    expect(await ended.textContent()).toContain('You were removed from the workspace');
    expect(env.stack.daemon.ctx.members.active('dev:rita')).toBeFalsy();
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

  it('R9 merge — a member with agent access works in a worktree and requests a merge; the host reviews the complete diff and approves: the file is in the main workspace for everyone; a rejected request leaves the worktree as it was', async () => {
    await onSessionsView();
    const wes = await env.newPage();
    await joinAs(wes, env, 'wes', 'agent');
    const sessionId = await openTerminal(wes, 'wes-work', { worktree: true });
    await typeInTerminal(wes, sessionId, `printf 'from the worktree\\n' > merged-file.txt && echo WROTE-1`);
    await waitForTerminalText(wes, sessionId, 'WROTE-1');
    let worktreeDir: string | null = null;
    await waitUntil(async () => (worktreeDir = await worktreeWith('merged-file.txt')) !== null, STEP_MS, 'the file in the worktree');

    // Wes asks for the merge: in code mode, the worktree switcher above the file tree shows his worktree.
    await toCodeMode(wes);
    const switcher = wes.getByRole('combobox', { name: 'Viewing' });
    await switcher.waitFor({ timeout: STEP_MS });
    await switcher.selectOption({ index: 1 });
    await wes.getByRole('treeitem', { name: 'merged-file.txt' }).first().waitFor({ timeout: STEP_MS });
    const askToMerge = wes.getByRole('group', { name: 'Worktree in view' }).getByRole('button', { name: 'Ask the host to merge' });
    await askToMerge.click();
    const request = wes.getByRole('dialog', { name: /^Ask the host to merge/ });
    await request.waitFor({ timeout: STEP_MS });
    await request.getByRole('textbox', { name: 'Message (optional)' }).fill('add merged-file');
    await request.getByRole('button', { name: 'Send merge request' }).click();
    await request.waitFor({ state: 'detached', timeout: STEP_MS });

    // The host: the request is an inbox item; it opens the whole diff in a Changes column, and the host merges there.
    const asked = host.locator('.sidebar-section--inbox .inbox-item', { hasText: 'wes asks to merge changes of a session' });
    await asked.locator('.inbox-item__main').click();
    const review = columnOf(host, /^Changes: /);
    await review.waitFor({ timeout: STEP_MS });
    // The complete diff: the changed file, opened, with its added line.
    await review.getByRole('navigation', { name: 'Changed files' }).getByText('merged-file.txt').first().click();
    await review.getByRole('region', { name: 'Diff of merged-file.txt' }).getByText('+from the worktree').waitFor({ timeout: STEP_MS });
    await review.getByRole('button', { name: 'Merge into the main workspace' }).click();
    await review.getByRole('button', { name: 'Confirm merge' }).click();
    await waitUntil(async () => (await readFile(join(env.stack.root, 'merged-file.txt'), 'utf8').catch(() => '')) === 'from the worktree\n', STEP_MS, 'the merged file in the main workspace');
    // The item left the host's inbox with the decision; the host closes the column of the merged request.
    await asked.waitFor({ state: 'detached', timeout: STEP_MS });
    await review.getByRole('button', { name: /^Close column: Changes/ }).click();
    await review.waitFor({ state: 'detached', timeout: STEP_MS });
    // Everyone sees it in the main workspace's file tree (code mode); the requester is told.
    const fern = await env.newPage();
    await joinAs(fern, env, 'fern', 'viewer');
    await toCodeMode(fern);
    await fern.getByRole('treeitem', { name: 'merged-file.txt' }).first().waitFor({ timeout: STEP_MS });
    await wes.getByText('The host merged your merge request into the main workspace.').first().waitFor({ timeout: STEP_MS });

    // A second change, rejected: the worktree stays exactly as it was, the main workspace does not get it.
    await toSessionsView(wes);
    await typeInTerminal(wes, sessionId, `printf 'not wanted\\n' > rejected-file.txt && echo WROTE-2`);
    await waitForTerminalText(wes, sessionId, 'WROTE-2');
    await waitUntil(async () => (await readFile(join(worktreeDir as unknown as string, 'rejected-file.txt'), 'utf8').catch(() => '')) === 'not wanted\n', STEP_MS, 'the second file in the worktree');
    const before = (await readdir(worktreeDir as unknown as string)).sort();
    await toCodeMode(wes);
    await askToMerge.click();
    await wes.getByRole('dialog', { name: /^Ask the host to merge/ }).getByRole('button', { name: 'Send merge request' }).click();
    await asked.locator('.inbox-item__main').click();
    const review2 = columnOf(host, /^Changes: /);
    await review2.getByText('rejected-file.txt').first().waitFor({ timeout: STEP_MS });
    await review2.getByRole('button', { name: 'Reject', exact: true }).click();
    await review2.getByRole('textbox', { name: /^Reason for rejecting/ }).fill('not this one');
    await review2.getByRole('button', { name: 'Confirm rejection' }).click();
    await wes.getByText('The host rejected your merge request.').first().waitFor({ timeout: STEP_MS });
    expect((await readdir(worktreeDir as unknown as string)).sort()).toEqual(before);
    expect(await readFile(join(worktreeDir as unknown as string, 'rejected-file.txt'), 'utf8')).toBe('not wanted\n');
    expect(await readFile(join(worktreeDir as unknown as string, 'merged-file.txt'), 'utf8')).toBe('from the worktree\n');
    expect(await readFile(join(env.stack.root, 'rejected-file.txt'), 'utf8').catch(() => null)).toBeNull();
  }, 300_000);

  it('R8.4 when an agent changes a file through Bash while someone is editing it, what the person typed is not lost; the overlapping part appears in the conflict panel — a real conflict: the disk is written while a person types', async () => {
    const cara = await env.newPage();
    await joinAs(cara, env, 'cara', 'editor');
    await toCodeMode(cara);
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
    await cara.getByRole('tab', { name: /Conflicts/ }).click();
    const conflict = cara.locator('article.conflict').filter({ hasText: 'notes.md' }).first();
    await conflict.waitFor({ timeout: STEP_MS });
    const text = (await conflict.textContent()) ?? '';
    expect(text).toContain('Text being edited (kept for now)');
    expect(text).toContain('line two typed by cara');
    expect(text).toContain('line two written on disk');
    await waitUntil(async () => (await readFile(onDisk, 'utf8')).includes('line two typed by cara'), STEP_MS, 'the human text written back');
    expect(((await cara.locator('.editor-doc__monaco .view-lines').textContent()) ?? '').replace(/ /g, ' ')).toContain('line two typed by cara');
  }, 240_000);

  it("agent access — a member with the role opens a session of their own (a terminal: it runs as the host, on the host's computer and as the host's user, no sandbox) and types straight into the HOST's session; an editor only watches", async () => {
    await onSessionsView();
    const hostSession = await openTerminal(host, 'host-typed');
    const abe = await env.newPage();
    await joinAs(abe, env, 'abe', 'agent');

    // The two dialogs behind "New": one line each on where it runs; nothing about a sandbox, a login or an API key.
    const agentDialog = await newSessionDialog(abe);
    expect(await agentDialog.getByTestId('new-session-runs-as').textContent()).toBe("This session runs on the host's computer, and the agent uses the host's Claude account.");
    expect(await agentDialog.textContent()).not.toMatch(/sandbox|API key|subscription/i);
    await agentDialog.getByRole('button', { name: 'Cancel' }).click();
    await agentDialog.waitFor({ state: 'detached', timeout: STEP_MS });
    const terminalDialog = await newTerminalDialog(abe);
    expect(await terminalDialog.getByTestId('new-session-runs-as').textContent()).toBe("This terminal runs on the host's computer, as the host.");
    expect(await terminalDialog.textContent()).not.toMatch(/sandbox|API key|subscription/i);
    await terminalDialog.getByRole('button', { name: 'Cancel' }).click();
    await terminalDialog.waitFor({ state: 'detached', timeout: STEP_MS });
    const abeSession = await openTerminal(abe, 'abe-shell');
    expect(env.stack.daemon.ctx.services.sessions.get(abeSession)).toMatchObject({ kind: 'terminal', status: 'running', openedBy: { userId: 'dev:abe' }, root: { kind: 'main' } });
    expect(env.stack.daemon.ctx.services.sessions.get(abeSession)).not.toHaveProperty('sandboxed');
    await typeInTerminal(abe, abeSession, 'echo ABE-RUNS-AS-$(id -un)');
    await waitForTerminalText(abe, abeSession, `ABE-RUNS-AS-${userInfo().username}`);
    // Everyone sees the terminal in the session list, and who opened it on its column.
    await openFromList(host, 'abe-shell', { side: true });
    await columnOf(host, 'abe-shell').locator('.agents-summary').getByText('By abe', { exact: true }).waitFor({ timeout: STEP_MS });

    // Abe types into the HOST's terminal: no "Watch only", the keystrokes reach the host's PTY.
    await openFromList(abe, 'host-typed', { side: true });
    await abe.locator(`.agents-session[data-session-id="${hostSession}"] .agents-term__viewport[data-phase="live"]`).waitFor({ timeout: STEP_MS });
    expect(await abe.locator(`.agents-session[data-session-id="${hostSession}"]`).getByText('Watch only').count()).toBe(0);
    expect(await terminalOf(abe, hostSession).getAttribute('data-readonly')).toBeNull();
    await typeInTerminal(abe, hostSession, 'echo TYPED-BY-ABE-$((6*7))');
    await waitForTerminalText(host, hostSession, 'TYPED-BY-ABE-42');

    // An editor watches the same terminal read-only, and has no way to open one.
    const eve = await env.newPage();
    await joinAs(eve, env, 'eve', 'editor');
    await rowOf(eve, 'host-typed').click();
    const eveSession = eve.locator(`.agents-session[data-session-id="${hostSession}"]`);
    await eveSession.getByText('Watch only').waitFor({ timeout: STEP_MS });
    expect(await terminalOf(eve, hostSession).getAttribute('data-readonly')).toBe('true');
    for (const page of [abe, eve]) expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 300_000);

  it('the console names the roles Agent access / Editor / Viewer and shows the risk of agent access before an invite or a role change applies (nothing is sent before the host confirms)', async () => {
    await onSessionsView();
    const vic = await env.newPage();
    await joinAs(vic, env, 'vic', 'viewer');
    await openConsole();

    // An invite: "Cancel" at the risk step creates nothing; "I understand" creates it.
    const invites = host.locator('section').filter({ has: host.getByRole('heading', { level: 2, name: 'Invite links' }) });
    const roles = invites.getByLabel('Role');
    expect(await roles.locator('option').allTextContents()).toEqual(['Agent access', 'Editor', 'Viewer']);
    const count = async (): Promise<number> => (await env.stack.hostClient.conn.request('admin.invite.list', {})).invites.filter((invite) => invite.role === 'agent').length;
    const before = await count();
    await roles.selectOption('agent');
    await invites.getByRole('button', { name: 'Create invite link', exact: true }).click();
    let risk = host.getByRole('alertdialog', { name: 'Create an invite link with agent access?' });
    await risk.waitFor({ timeout: STEP_MS });
    expect(await risk.getByTestId('role-risk-text').textContent()).toBe(RISK);
    await risk.getByRole('button', { name: 'Cancel' }).click();
    await risk.waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await count()).toBe(before);
    await invites.getByRole('button', { name: 'Create invite link', exact: true }).click();
    risk = host.getByRole('alertdialog', { name: 'Create an invite link with agent access?' });
    await risk.getByRole('button', { name: 'I understand, create the link' }).click();
    const link = host.getByRole('dialog', { name: 'Invite link created' });
    await link.waitFor({ timeout: STEP_MS });
    expect(await link.textContent()).toContain('Role: Agent access.');
    await link.getByRole('button', { name: 'I have copied it' }).click();
    expect(await count()).toBe(before + 1);

    // A member: the select stays at the role in force until the host confirms.
    const select = host.getByLabel('Role of vic');
    await select.selectOption('agent');
    const confirm = host.getByRole('alertdialog', { name: 'Give vic agent access?' });
    await confirm.waitFor({ timeout: STEP_MS });
    expect(await confirm.getByTestId('role-risk-text').textContent()).toBe(RISK);
    expect(env.stack.daemon.ctx.members.active('dev:vic')?.role).toBe('viewer');
    await confirm.getByRole('button', { name: 'I understand, change the role' }).click();
    await waitUntil(async () => env.stack.daemon.ctx.members.active('dev:vic')?.role === 'agent', STEP_MS, 'vic to have agent access');
    // Vic's page follows (a reconnect with the new role): the new-session dialog now opens a session.
    await vic.getByRole('banner', { name: 'Workspace' }).getByText('Agent access').first().waitFor({ timeout: STEP_MS });
    await (await newSessionDialog(vic)).getByTestId('new-session-runs-as').waitFor({ timeout: STEP_MS });
    expect(env.problemsOf(vic).pageErrors).toEqual([]);
  }, 240_000);
});
