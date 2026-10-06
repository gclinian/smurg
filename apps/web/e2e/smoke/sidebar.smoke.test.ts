// The left column of the sessions view in real browsers (DESIGN §5.11 `sidebar.smoke`; UX §3, §7, §11; DESIGN §5.12
// items 1–8): the BUILT app served by the real relay, a daemon composing the release's modules, the scripted stand-in
// `claude` (packages/daemon/src/testing/fake-claude.mjs: no Claude Code, no account, no network) and system Chrome
// driven headless, one context per member: the host and a member with agent access.
//
// What only the real stack proves about the left column:
//   - the daemon's inbox reaches it: a question of the agent is in the decider's "Agents are waiting" with the amber
//     count (also in the tab's title and, in code mode, on the "Sessions" segment), and as an open vote in the inbox
//     of the member who does not decide; a click opens the session at the card and the item is no longer unread; when
//     the question is answered the item leaves BOTH inboxes;
//   - a topic's rows are fixed from its creation (Discussion, Spec "not written yet", Plan "no plan yet"), a row is
//     bold until this browser showed the thing, and the tree works by keyboard in a real browser (arrows, Enter,
//     Shift+Enter, Left / Right, the context menu key);
//   - the filter, the folds of the two sections, the rail and the separator (220 to 420 px) behave as specified, and
//     the folds are remembered across a reload.
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude, type FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, explainFailures, joinAs, joinAsHost, startSmoke, systemChrome, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const TOPIC = 'Checkout redesign';
const QUESTION = 'Where is the cart kept?';

/** The "model": on the topic's first message it asks one question and waits for the answer. */
const SCENARIO: FakeClaudeScenario = {
  turns: [
    {
      match: 'one page',
      once: true,
      steps: [
        {
          tool: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: QUESTION,
                header: 'Cart',
                multiSelect: false,
                options: [
                  { label: 'On the server', description: 'Survives a reload.' },
                  { label: 'In the browser', description: 'Simpler.' },
                ],
              },
            ],
          },
        },
        { text: 'Thanks. I will write the spec next.' },
      ],
    },
    { steps: [{ text: 'Noted.' }] },
  ],
};

/** The inbox of a page as it is drawn: the two counts and every row. */
async function inboxOf(page: Page): Promise<{ waiting: number; look: number; rows: { key: string; title: string; where: string; unread: boolean; current: boolean; group: string }[] }> {
  return page.evaluate(() => {
    const count = (name: string): number => Number(document.querySelector(`.sidebar-section--inbox .inbox-counts [data-count="${name}"]`)?.textContent ?? '0');
    return {
      waiting: count('waiting'),
      look: count('look'),
      rows: [...document.querySelectorAll<HTMLElement>('.sidebar-section--inbox .inbox-item')].map((row) => ({
        key: row.getAttribute('data-inbox-key') ?? '',
        title: row.querySelector('.inbox-item__title')?.textContent ?? '',
        where: row.querySelector('.inbox-item__where')?.textContent ?? '',
        unread: row.hasAttribute('data-unread'),
        current: row.hasAttribute('data-current'),
        group: row.closest('[data-inbox-group]')?.getAttribute('data-inbox-group') ?? '',
      })),
    };
  });
}

/** The rows of a topic in the tree, as the eye reads them: "Spec (not written yet)". */
async function topicRows(page: Page, topic: string): Promise<string[]> {
  return page.getByRole('treeitem', { name: new RegExp(`^${topic}`) }).evaluate((group) =>
    [...group.querySelectorAll('[role="treeitem"]')].map((row) => {
      const title = row.querySelector('.srow__title')?.textContent ?? '';
      const meta = row.querySelector('.srow__meta')?.textContent;
      return meta ? `${title} (${meta})` : title;
    }),
  );
}

const focusedRow = (page: Page): Promise<string | null> => page.evaluate(() => (document.activeElement?.getAttribute('role') === 'treeitem' ? (document.activeElement.querySelector('.srow__title, .topic__name')?.textContent ?? null) : null));
const columnNames = (page: Page): Promise<(string | null)[]> => page.evaluate(() => [...document.querySelectorAll('.app-shell__view[data-view="sessions"] [data-column-id]')].map((column) => column.getAttribute('aria-label')));
const leftWidth = (page: Page): Promise<number> => page.evaluate(() => Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0));

describe.skipIf(chrome === null)('the left column in real browsers (built app, real relay, real daemon, the stand-in claude)', () => {
  let env: SmokeEnv;
  let claude: FakeClaude;
  let host: Page;
  let mei: Page;

  beforeAll(async () => {
    claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'sidebar-claude-')), SCENARIO);
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n' },
        sessions: { claudePath: claude.path, selfCommand: { file: '/usr/bin/true', args: [] } },
      },
    });
    host = await env.newPage({ width: 1440, height: 900 });
    await joinAsHost(host, env);
    mei = await env.newPage({ width: 1280, height: 900 });
    await joinAs(mei, env, 'mei', 'agent');
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  const topicRow = (page: Page) => page.getByRole('treeitem', { name: new RegExp(`^${TOPIC}`) });
  const rowIn = (page: Page, name: RegExp) => topicRow(page).getByRole('treeitem', { name });

  it('an empty workspace: both sections say so, and the right side explains how to start', async () => {
    await host.getByRole('complementary', { name: 'Inbox and sessions' }).waitFor({ timeout: STEP_MS });
    await host.getByText('Nothing is waiting for you.').waitFor({ timeout: STEP_MS });
    await host.getByText('No topics yet.').waitFor({ timeout: STEP_MS });
    await host.getByRole('heading', { level: 2, name: 'Start with a topic' }).waitFor({ timeout: STEP_MS });
    expect(await inboxOf(host)).toMatchObject({ waiting: 0, look: 0, rows: [] });
    expect(await host.title()).not.toContain('waiting');
    // 288 px by default (UX §1).
    expect(await leftWidth(host)).toBe(288);
  });

  it('"New" → "New topic": the topic appears for everyone with its fixed rows, and the agent\'s question reaches both inboxes', async () => {
    await host.getByRole('button', { name: 'New', exact: true }).click();
    await host.getByRole('menuitem', { name: 'New topic' }).click();
    const dialog = host.getByRole('dialog', { name: 'New topic' });
    await dialog.getByLabel('Name').fill(TOPIC);
    await dialog.getByLabel(/^What do you want to build/).fill('Checkout on one page instead of three steps.');
    await dialog.getByRole('button', { name: 'Start discussion' }).click();
    await dialog.waitFor({ state: 'detached', timeout: STEP_MS });

    // The topic's rows are fixed from its creation, for the member who did nothing too.
    for (const page of [host, mei]) {
      await topicRow(page).waitFor({ timeout: STEP_MS });
      await expect.poll(() => topicRows(page, TOPIC), { timeout: STEP_MS }).toEqual(['Discussion', 'Spec (not written yet)', 'Plan (no plan yet)']);
    }
    expect(await topicRow(host).getAttribute('aria-label')).toBe(`${TOPIC}, Discussing`);

    // The host opened the topic and decides its question: "Agents are waiting", the amber count, the tab's title.
    await expect.poll(async () => (await inboxOf(host)).waiting, { timeout: STEP_MS }).toBe(1);
    const mine = await inboxOf(host);
    expect(mine.look).toBe(0);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ title: QUESTION, group: 'waiting' });
    expect(mine.rows[0]?.key.startsWith('question:')).toBe(true);
    expect(mine.rows[0]?.where).toContain(`${TOPIC} › Discussion`);
    await expect.poll(() => host.title(), { timeout: STEP_MS }).toMatch(/^\(1 waiting\) /);
    // The discussion's row says what it waits for, in words.
    await rowIn(host, /^Discussion, Waiting for an answer/).waitFor({ timeout: STEP_MS });

    // Mei does not decide: the open vote is in her inbox.
    await expect.poll(async () => (await inboxOf(mei)).rows.map((row) => row.title), { timeout: STEP_MS }).toEqual([`Vote: ${QUESTION}`]);
    const hers = await inboxOf(mei);
    expect(hers).toMatchObject({ waiting: 1, look: 0 });
    expect(hers.rows[0]?.key.startsWith('vote:')).toBe(true);
    expect(hers.rows[0]?.where).toMatch(/0 of \d voted · host decides/);
    // Something happened there since her browser looked: the row is bold.
    expect(await rowIn(mei, /^Discussion/).locator('.ui-tree__row').getAttribute('data-unread')).toBe('');
  });

  it('the tree by keyboard: arrows move, Enter opens, Shift+Enter opens to the side, Left and Right fold and unfold', async () => {
    await rowIn(mei, /^Discussion/).focus();
    await mei.keyboard.press('ArrowDown');
    expect(await focusedRow(mei)).toBe('Spec');
    await mei.keyboard.press('ArrowDown');
    expect(await focusedRow(mei)).toBe('Plan');
    await mei.keyboard.press('ArrowUp');
    await mei.keyboard.press('ArrowUp');
    expect(await focusedRow(mei)).toBe('Discussion');
    await mei.keyboard.press('Enter');
    await expect.poll(() => columnNames(mei), { timeout: STEP_MS }).toEqual([`Discussion · ${TOPIC}`]);
    // Shown in this browser now: no longer bold, marked as open, and the row of the focused column is selected.
    const discussion = rowIn(mei, /^Discussion/);
    await expect.poll(() => discussion.locator('.ui-tree__row').getAttribute('data-unread'), { timeout: STEP_MS }).toBeNull();
    expect(await discussion.locator('.ui-tree__row').getAttribute('data-open-in')).toBe('');
    expect(await discussion.getAttribute('aria-selected')).toBe('true');

    // Shift+Enter on "Spec": a second column, to the side; the empty step opens its empty state.
    await rowIn(mei, /^Spec/).focus();
    await mei.keyboard.press('Shift+Enter');
    // (A spec column is named with its topic, like a discussion: two of them can be told apart.)
    await expect.poll(() => columnNames(mei), { timeout: STEP_MS }).toEqual([`Discussion · ${TOPIC}`, `Spec · ${TOPIC}`]);
    expect(await rowIn(mei, /^Spec/).getAttribute('aria-selected')).toBe('true');

    // Left on a row goes to its topic; Left again folds it: the fold says what waits inside.
    await rowIn(mei, /^Spec/).focus();
    await mei.keyboard.press('ArrowLeft');
    expect(await focusedRow(mei)).toBe(TOPIC);
    await mei.keyboard.press('ArrowLeft');
    await expect.poll(() => topicRow(mei).getAttribute('aria-expanded'), { timeout: STEP_MS }).toBe('false');
    expect(await topicRow(mei).getAttribute('aria-label')).toBe(`${TOPIC}, Discussing, 1 waiting`);
    await mei.keyboard.press('ArrowRight');
    await expect.poll(() => topicRow(mei).getAttribute('aria-expanded'), { timeout: STEP_MS }).toBe('true');

    // The context menu by keyboard: the shell's two items first, then what the features add.
    await rowIn(mei, /^Plan/).focus();
    await mei.keyboard.press('Shift+F10');
    const menu = mei.getByRole('menu', { name: 'Actions for Plan' });
    await menu.waitFor({ timeout: STEP_MS });
    expect((await menu.getByRole('menuitem').allTextContents()).slice(0, 2)).toEqual(['Open', 'Open to the side']);
    await mei.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: STEP_MS });
    expect(await focusedRow(mei)).toBe('Plan');
  });

  it('the filter "Waiting" keeps the rows a person must act on; the folds of the two sections stay folded', async () => {
    const sessions = host.getByRole('region', { name: 'Sessions' });
    await sessions.getByRole('radio', { name: 'Waiting' }).click();
    await expect.poll(() => topicRows(host, TOPIC), { timeout: STEP_MS }).toEqual(['Discussion']);
    await sessions.getByRole('radio', { name: 'Mine' }).click();
    // Nobody is responsible for the discussion: it is the session of the member who opened it.
    await expect.poll(() => topicRows(host, TOPIC), { timeout: STEP_MS }).toEqual(['Discussion']);
    await sessions.getByRole('radio', { name: 'All' }).click();
    await expect.poll(() => topicRows(host, TOPIC), { timeout: STEP_MS }).toEqual(['Discussion', 'Spec (not written yet)', 'Plan (no plan yet)']);

    // Folded, a section keeps its header: the inbox still shows its count.
    const inboxToggle = host.getByRole('region', { name: 'Inbox' }).getByRole('button', { name: /^Inbox/ });
    await inboxToggle.click();
    expect(await inboxToggle.getAttribute('aria-expanded')).toBe('false');
    expect(await host.locator('.sidebar-section--inbox .inbox-counts [data-count="waiting"]').textContent()).toBe('1');
    expect(await host.locator('.sidebar-section--inbox .inbox-item').first().isVisible()).toBe(false);
    await host.reload();
    await workspaceOnline(host);
    const again = host.getByRole('region', { name: 'Inbox' }).getByRole('button', { name: /^Inbox/ });
    await again.waitFor({ timeout: STEP_MS });
    expect(await again.getAttribute('aria-expanded')).toBe('false');
    await again.click();
    await expect.poll(async () => (await inboxOf(host)).rows.length, { timeout: STEP_MS }).toBe(1);
  });

  it('the separator moves the left column between 220 and 420 px; the rail is 44 px with the count; a rail button unfolds it', async () => {
    const separator = host.getByRole('separator', { name: 'Drag or use the arrow keys to resize the inbox and the session list' });
    const box = (await separator.boundingBox()) as { x: number; y: number; width: number; height: number };
    const y = box.y + box.height / 2;
    await host.mouse.move(box.x + 0.5, y);
    await host.mouse.down();
    await host.mouse.move(box.x + 0.5 + 60, y, { steps: 6 });
    await expect.poll(() => leftWidth(host), { timeout: STEP_MS }).toBe(348);
    // Never wider than 420 px, never narrower than 220 px.
    await host.mouse.move(box.x + 500, y, { steps: 6 });
    await expect.poll(() => leftWidth(host), { timeout: STEP_MS }).toBe(420);
    await host.mouse.move(40, y, { steps: 8 });
    await expect.poll(() => leftWidth(host), { timeout: STEP_MS }).toBe(220);
    await host.mouse.up();
    // A hover afterwards moves nothing.
    await host.mouse.move(600, y, { steps: 4 });
    expect(await leftWidth(host)).toBe(220);
    await separator.dblclick();
    await expect.poll(() => leftWidth(host), { timeout: STEP_MS }).toBe(288);

    // Folded: a 44 px rail with the amber count; the inbox button brings the column back.
    await host.getByRole('button', { name: 'Show or hide the inbox and the session list' }).click();
    await expect.poll(() => leftWidth(host), { timeout: STEP_MS }).toBe(44);
    expect(await host.locator('.sidebar-rail__count--waiting').textContent()).toBe('1');
    await host.getByRole('button', { name: 'Inbox: 1 waiting, 0 to look at' }).click();
    await expect.poll(() => leftWidth(host), { timeout: STEP_MS }).toBe(288);
    expect(await host.getByRole('button', { name: 'Show or hide the inbox and the session list' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('in code mode the "Sessions" segment carries the count; back in the sessions view the inbox item opens the session at its card', async () => {
    await host.getByRole('link', { name: /^Code mode/ }).click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/code`, { timeout: STEP_MS });
    const segment = host.getByRole('link', { name: 'Sessions: 1 waiting, 0 to look at' });
    await segment.waitFor({ timeout: STEP_MS });
    expect(await segment.locator('[data-count="waiting"]').textContent()).toBe('1');
    await segment.click();
    await host.waitForURL(`${env.origin}/w/${env.stack.workspaceId}`, { timeout: STEP_MS });

    await host.locator('.sidebar-section--inbox .inbox-item__main').first().click();
    await expect.poll(() => columnNames(host), { timeout: STEP_MS }).toContain(`Discussion · ${TOPIC}`);
    // The card the item is about is in that column.
    const card = host.getByRole('region', { name: `Discussion · ${TOPIC}` }).getByRole('region', { name: 'Question from Claude' });
    await card.waitFor({ timeout: STEP_MS });
    await card.getByText(QUESTION).first().waitFor({ timeout: STEP_MS });
    // Looked at: no longer unread, and it is the row of what the focused column shows.
    await expect.poll(async () => (await inboxOf(host)).rows[0], { timeout: STEP_MS }).toMatchObject({ unread: false, current: true });
    // Still waiting: looking at an item does not take it out of the inbox.
    expect((await inboxOf(host)).waiting).toBe(1);
  });

  it('answered: the item leaves both inboxes at the same moment, and the tab\'s title with it', async () => {
    const card = host.getByRole('region', { name: `Discussion · ${TOPIC}` }).getByRole('region', { name: 'Question from Claude' });
    await card.getByRole('radio', { name: /On the server/ }).click();
    await card.getByRole('button', { name: 'Submit answer' }).click();
    for (const page of [host, mei]) {
      await expect.poll(async () => (await inboxOf(page)).rows.length, { timeout: STEP_MS }).toBe(0);
      await page.getByText('Nothing is waiting for you.').waitFor({ timeout: STEP_MS });
      expect(await inboxOf(page)).toMatchObject({ waiting: 0, look: 0 });
    }
    await expect.poll(() => host.title(), { timeout: STEP_MS }).not.toMatch(/waiting/);
    // The agent went on: the discussion no longer waits for an answer.
    await expect.poll(async () => (await rowIn(host, /^Discussion/).getAttribute('aria-label')) ?? '', { timeout: STEP_MS }).not.toContain('Waiting for an answer');
    // Nothing went wrong in either page on the way.
    expect(env.problemsOf(host).pageErrors).toEqual([]);
    expect(env.problemsOf(mei).pageErrors).toEqual([]);
  });
});
