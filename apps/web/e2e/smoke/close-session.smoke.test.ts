// The reported bug: "in the session panel on the right I cannot close a session that has ended". In a real browser (the built
// app, the real relay, a daemon with every module, system Chrome): an ended session's tab is closed by whoever looks at
// it, in their OWN panel (ARCHITECTURE §9 "Closing an ended session's tab"):
//  - the tab of an ended session (one that exited by itself, one its owner ended) has a close button with an accessible
//    name, Delete on the tab closes it too, and so does "Close tab" in the session's bar; a RUNNING session has none of
//    them and Delete does nothing to it;
//  - closing is per viewer: the others keep the tab, and the daemon still lists the session;
//  - the closed tab does not come back on a reload while the daemon still lists the ended session;
//  - the tab that is selected afterwards is the neighbour, and it has the keyboard focus;
//  - four tabs do not fit the panel: the strip scrolls, and the selected tab's close button is brought into view;
//  - the daemon keeps an ended session for a while only (15 minutes; 2 s in the second suite) and tells nobody when it
//    forgets it: a panel that stayed open keeps the tab, showing it again says that the content is no longer kept (no
//    retry), the tab can still be closed, a reload no longer has it, and the closed id is forgotten with it.
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES } from '../../../../packages/daemon/src/daemon.ts';
import { createSessionsModule } from '../../../../packages/daemon/src/sessions/module.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, openSession, startSmoke, systemChrome, typeInTerminal, waitUntil, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

/** A control that must be there is given this long (the run without the fix fails here, not after STEP_MS). */
const CONTROL_MS = 20_000;

// Long names: four such tabs never fit the agents panel, whatever its width is set to.
const FIRST = 'first-exits-by-itself';
const SECOND = 'second-ended-by-its-owner';
const THIRD = 'third-ended-by-its-owner';
const KEEPER = 'keeper-that-keeps-running';
const label = (title: string): string => `${title} (host)`;

const tabOf = (page: Page, title: string) => page.getByRole('tab', { name: new RegExp(`^${title} \\(`) });
const closeButtonOf = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(`^Close ${title} \\(`) });

/** The titles of the session tabs, in the order of the strip. */
async function tabTitles(page: Page): Promise<string[]> {
  return page.getByRole('tablist', { name: 'Session tabs' }).locator('.agents-tab__title').allTextContents();
}

/** Waits until the tab of `title` says the session ended. */
async function waitEnded(page: Page, title: string): Promise<void> {
  await tabOf(page, title).locator('.agents-tab[data-status="exited"]').waitFor({ timeout: STEP_MS });
}

/** Runs in the page: whether the close button of the tab of `title` lies inside the visible part of the tab strip. */
function closeButtonInViewIn(title: string): boolean {
  const strip = document.querySelector('.agents-tabs [role="tablist"]')?.getBoundingClientRect();
  const button = [...document.querySelectorAll('.agents-tabs [role="tablist"] button:not([role="tab"])')]
    .find((candidate) => candidate.getAttribute('aria-label')?.startsWith(`Close ${title} (`))
    ?.getBoundingClientRect();
  return strip !== undefined && button !== undefined && button.left >= strip.left - 0.5 && button.right <= strip.right + 0.5;
}

/** Whether the close button of the tab of `title` is inside the visible part of the (sideways scrolling) tab strip now. */
async function closeButtonInView(page: Page, title: string): Promise<boolean> {
  return page.evaluate(closeButtonInViewIn, title);
}

/** Waits until the strip has scrolled the close button of the tab of `title` into view. */
async function waitCloseButtonInView(page: Page, title: string): Promise<void> {
  await page.waitForFunction(closeButtonInViewIn, title, { timeout: CONTROL_MS });
}

/** Whether the keyboard focus is on the tab of `title`, and that tab is the selected one. */
async function selectedAndFocused(page: Page, title: string): Promise<boolean> {
  return tabOf(page, title).evaluate((tab) => tab === document.activeElement && tab.getAttribute('aria-selected') === 'true');
}

describe.skipIf(chrome === null)("closing an ended session's tab (built app, real relay, system Chrome)", () => {
  let env: SmokeEnv;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# Class project\n' } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  const statusOf = (id: string): string | undefined => env.stack.daemon.ctx.services.sessions.list().find((session) => session.id === id)?.status;

  it("every viewer closes an ended session's tab in their own panel (button, Delete, 'Close tab'); it stays closed after a reload; a running session is never closed", async () => {
    const host = await env.newPage();
    await joinAsHost(host, env);
    const first = await openSession(host, 'terminal', FIRST);
    const second = await openSession(host, 'terminal', SECOND);
    const third = await openSession(host, 'terminal', THIRD);
    const keeper = await openSession(host, 'terminal', KEEPER);

    const wendy = await env.newPage();
    await joinAs(wendy, env, 'wendy', 'viewer');
    await tabOf(wendy, KEEPER).waitFor({ timeout: STEP_MS });

    // The first one exits by itself (the owner types exit), the second and the third are ended by their owner.
    await tabOf(host, FIRST).click();
    await typeInTerminal(host, first, 'exit');
    for (const title of [SECOND, THIRD]) {
      await tabOf(host, title).click();
      await host.getByRole('tabpanel').getByRole('button', { name: 'End session' }).click();
      await host.getByRole('alertdialog', { name: 'End session' }).getByRole('button', { name: 'End session' }).click();
      await waitEnded(host, title);
    }
    for (const page of [host, wendy]) for (const title of [FIRST, SECOND, THIRD]) await waitEnded(page, title);
    // Running sessions first, ended ones after them.
    expect(await tabTitles(wendy)).toEqual([label(KEEPER), label(FIRST), label(SECOND), label(THIRD)]);

    // An ended session's tab has a close button with an accessible name, for a viewer too; a running one has none.
    await closeButtonOf(wendy, FIRST).waitFor({ timeout: CONTROL_MS });
    for (const page of [host, wendy]) {
      expect(await closeButtonOf(page, FIRST).count()).toBe(1);
      expect(await closeButtonOf(page, SECOND).count()).toBe(1);
      expect(await closeButtonOf(page, THIRD).count()).toBe(1);
      expect(await closeButtonOf(page, KEEPER).count()).toBe(0);
    }

    // Four tabs do not fit the panel: the strip scrolls, and the selected tab is in view WITH its close button. By
    // keyboard (End selects the last tab): a click would make the test driver scroll the tab into view by itself.
    expect(await wendy.getByRole('tablist', { name: 'Session tabs' }).evaluate((strip) => strip.scrollWidth > strip.clientWidth)).toBe(true);
    expect(await closeButtonInView(wendy, THIRD)).toBe(false);
    await tabOf(wendy, KEEPER).focus();
    await wendy.keyboard.press('End');
    expect(await selectedAndFocused(wendy, THIRD)).toBe(true);
    await waitCloseButtonInView(wendy, THIRD);
    expect(await wendy.getByRole('tablist', { name: 'Session tabs' }).evaluate((strip) => strip.scrollLeft)).toBeGreaterThan(0);
    await wendy.keyboard.press('Home');
    expect(await selectedAndFocused(wendy, KEEPER)).toBe(true);

    // The viewer closes the tab she is looking at: the neighbour to the right is selected and focused.
    await tabOf(wendy, FIRST).click();
    await waitCloseButtonInView(wendy, FIRST);
    await closeButtonOf(wendy, FIRST).click();
    await tabOf(wendy, FIRST).waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await tabTitles(wendy)).toEqual([label(KEEPER), label(SECOND), label(THIRD)]);
    expect(await selectedAndFocused(wendy, SECOND)).toBe(true);
    // Only in her panel: the host still has the tab, and the daemon still lists the ended session.
    expect(await tabOf(host, FIRST).count()).toBe(1);
    expect(statusOf(first)).toBe('exited');

    // A reload: the daemon still lists the ended session, the closed tab does not come back; the others do.
    await wendy.reload();
    await workspaceOnline(wendy);
    await tabOf(wendy, KEEPER).waitFor({ timeout: STEP_MS });
    await tabOf(wendy, SECOND).waitFor({ timeout: STEP_MS });
    expect(statusOf(first)).toBe('exited');
    expect(await tabTitles(wendy)).toEqual([label(KEEPER), label(SECOND), label(THIRD)]);

    // Keyboard: Delete on the ended tab closes it; the last tab of the strip hands over to the one before it.
    await tabOf(wendy, THIRD).click();
    expect(await tabOf(wendy, THIRD).getAttribute('aria-keyshortcuts')).toBe('Delete');
    await wendy.keyboard.press('Delete');
    await tabOf(wendy, THIRD).waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await selectedAndFocused(wendy, SECOND)).toBe(true);
    // The close button is reached with Tab from the selected tab, and works with the keyboard.
    await wendy.keyboard.press('Tab');
    expect(await closeButtonOf(wendy, SECOND).evaluate((button) => button === document.activeElement)).toBe(true);
    await wendy.keyboard.press('Enter');
    await tabOf(wendy, SECOND).waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await selectedAndFocused(wendy, KEEPER)).toBe(true);

    // A running session is never closed by this: Delete does nothing, there is no button, and it keeps running.
    expect(await tabOf(wendy, KEEPER).getAttribute('aria-keyshortcuts')).toBeNull();
    await wendy.keyboard.press('Delete');
    expect(await tabTitles(wendy)).toEqual([label(KEEPER)]);
    expect(await wendy.getByRole('tabpanel').getByRole('button', { name: 'Close tab' }).count()).toBe(0);
    expect(statusOf(keeper)).toBe('running');

    // The owner closes one from the session's own bar ("Close tab"), where "End session" was while it ran.
    await tabOf(host, SECOND).click();
    await host.getByRole('tabpanel').getByRole('button', { name: 'Close tab' }).click();
    await tabOf(host, SECOND).waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await tabTitles(host)).toEqual([label(KEEPER), label(FIRST), label(THIRD)]);
    expect(await selectedAndFocused(host, THIRD)).toBe(true);
    expect(await host.getByRole('tabpanel').getByRole('button', { name: 'Close tab' }).count()).toBe(1);
    // Nothing was ended or removed on the host's computer by closing tabs.
    expect([first, second, third, keeper].map(statusOf)).toEqual(['exited', 'exited', 'exited', 'running']);

    expect(env.problemsOf(wendy).pageErrors).toEqual([]);
    expect(env.problemsOf(host).pageErrors).toEqual([]);
  }, 300_000);
});

describe.skipIf(chrome === null)('an ended session the daemon no longer keeps (built app; a daemon that forgets after 2 s instead of 15 minutes)', () => {
  let env: SmokeEnv;
  const CLOSED_KEY = 'smurg.agents.closedSessions';

  beforeAll(async () => {
    // Production's modules, the sessions module with a short retention of ended sessions (ARCHITECTURE §7.6).
    const modules = DEFAULT_FEATURE_MODULES.map((module) => (module.name === 'sessions' ? createSessionsModule({ limits: { exitedRetentionMs: 2_000 } }) : module));
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# Class project\n' }, modules } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  it('the tab that stayed open says the content is gone (no retry) and can be closed; a reload no longer has it, and its closed id is forgotten', async () => {
    const host = await env.newPage();
    await joinAsHost(host, env);
    const gone = await openSession(host, 'terminal', 'gone');
    const stays = await openSession(host, 'terminal', 'stays');
    const wendy = await env.newPage();
    await joinAs(wendy, env, 'wendy', 'viewer');
    // She watches the other session while this one ends.
    await tabOf(wendy, 'stays').click();
    await tabOf(host, 'gone').click();
    await typeInTerminal(host, gone, 'exit');
    await waitEnded(wendy, 'gone');
    await waitEnded(host, 'gone');
    const listed = (id: string): boolean => env.stack.daemon.ctx.services.sessions.list().some((session) => session.id === id);
    await waitUntil(() => !listed(gone), STEP_MS, 'the daemon to forget the ended session');
    expect(listed(stays)).toBe(true);

    // Nobody is told: both panels still have the tab. Showing it again finds nothing to attach to.
    expect(await tabTitles(host)).toEqual(['stays (host)', 'gone (host)']);
    await tabOf(wendy, 'gone').click();
    const panel = wendy.getByRole('tabpanel');
    await panel.getByText("This session ended a while ago, and the host's computer no longer keeps its terminal output. You can close this tab.").waitFor({ timeout: STEP_MS });
    expect(await panel.getByText(/Could not connect to the terminal/).count()).toBe(0);
    expect(await panel.getByRole('button', { name: 'Reconnect the terminal' }).count()).toBe(0);

    // It can be closed like any ended session; while this page stays open its id is remembered.
    await closeButtonOf(wendy, 'gone').click();
    await tabOf(wendy, 'gone').waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await selectedAndFocused(wendy, 'stays')).toBe(true);
    expect(JSON.parse((await wendy.evaluate((key) => window.localStorage.getItem(key), CLOSED_KEY)) ?? '{}')).toEqual({ [env.stack.workspaceId]: [gone] });

    // A reload: the daemon's list no longer has it, so there is nothing left to remember.
    await wendy.reload();
    await workspaceOnline(wendy);
    await tabOf(wendy, 'stays').waitFor({ timeout: STEP_MS });
    await wendy.waitForFunction((key) => window.localStorage.getItem(key) === null, CLOSED_KEY, { timeout: STEP_MS });
    expect(await tabTitles(wendy)).toEqual(['stays (host)']);
    // The host, who closed nothing: the tab is gone after a reload as well.
    await host.reload();
    await workspaceOnline(host);
    await tabOf(host, 'stays').waitFor({ timeout: STEP_MS });
    expect(await tabTitles(host)).toEqual(['stays (host)']);

    // The 4xx-free console of both pages: a refused attach is an answer on the channel, not an error of the page.
    expect(env.problemsOf(wendy).pageErrors).toEqual([]);
    expect(env.problemsOf(host).pageErrors).toEqual([]);
  }, 300_000);
});
