// The column strip of the sessions view under a real mouse and a real layout engine (DESIGN §5.11 `columns.smoke`;
// UX §2, §9): the BUILT app served by the real relay, a daemon composing the release's modules, and system Chrome
// driven headless at 1440 x 900. The unit tests (src/ui/Columns.test.tsx, src/ui/columns-layout.test.ts) cover the
// arithmetic with given boxes; only a browser proves that the boxes are what the arithmetic says:
//   - up to four columns side by side, whole columns only, none narrower than 320 px, the page itself never scrolls;
//   - a divider follows the pointer exactly while the button is down, trades width between its two neighbours, stops
//     at their minimums, and nothing moves on a hover afterwards; arrow keys and a double click work on it too;
//   - what is open, in which order and how wide, is remembered per browser and workspace across a reload;
//   - a fourth column that does not fit is reached sideways ("1 more"), a fifth is refused, and with the left column
//     folded to its rail all four fit;
//   - closing moves the focus to the neighbour's title; a pinned column is not replaced; the mode switch brings the
//     columns back as they were.
// The columns here are plain terminals (no agent is needed to prove the strip): each has a real body, the terminal
// column of features/agents.
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeClaude } from '../../../../packages/daemon/src/testing/index.ts';
import { STEP_MS, explainFailures, joinAsHost, startSmoke, systemChrome, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

const WIDTH = 1440;
const HEIGHT = 900;
/** The left column's default width and its separator: what the strip does not have. */
const LEFT = 288 + 1;
const RAIL = 44;
const MIN = 320;

interface Strip {
  /** The open columns, left to right. */
  readonly columns: { readonly id: string; readonly name: string; readonly left: number; readonly width: number; readonly height: number; readonly focused: boolean }[];
  /** The x of every divider's line. */
  readonly separators: number[];
  readonly left: number;
  readonly width: number;
  readonly scrollLeft: number;
  /** The edge buttons that say how many columns are out of view. */
  readonly more: { readonly side: 'left' | 'right'; readonly text: string }[];
  /** The page itself never scrolls. */
  readonly pageFits: boolean;
}

async function stripOf(page: Page): Promise<Strip> {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.app-shell__view[data-view="sessions"] .ui-columns');
    if (!strip) throw new Error('no column strip on the page');
    const box = strip.getBoundingClientRect();
    const round = (value: number): number => Math.round(value * 100) / 100;
    return {
      columns: [...strip.querySelectorAll<HTMLElement>('[data-column-id]')].map((column) => {
        const rect = column.getBoundingClientRect();
        return { id: column.getAttribute('data-column-id') ?? '', name: column.getAttribute('aria-label') ?? '', left: round(rect.left), width: round(rect.width), height: round(rect.height), focused: column.hasAttribute('data-focused') };
      }),
      separators: [...strip.querySelectorAll<HTMLElement>('.ui-columns__separator')].map((separator) => round(separator.getBoundingClientRect().left)),
      left: round(box.left),
      width: round(box.width),
      scrollLeft: strip.scrollLeft,
      more: [...document.querySelectorAll<HTMLElement>('.ui-columns__more')].map((button) => ({ side: button.className.includes('--left') ? ('left' as const) : ('right' as const), text: (button.textContent ?? '').trim() })),
      pageFits: document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight,
    };
  });
}

const widths = (strip: Strip): number[] => strip.columns.map((column) => column.width);
const names = (strip: Strip): string[] => strip.columns.map((column) => column.name);

/** Waits until the strip looks as `check` says, and returns it; says what the strip looked like when it never did. */
async function stripWhen(page: Page, check: (strip: Strip) => boolean, what: string): Promise<Strip> {
  const deadline = Date.now() + STEP_MS;
  let last = await stripOf(page);
  while (!check(last)) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${STEP_MS} ms; the strip: ${JSON.stringify(last)}`);
    await page.waitForTimeout(50);
    last = await stripOf(page);
  }
  return last;
}

/** Presses the primary button on the divider behind column `index`, moves by `dx` in steps, and (unless told not to) releases. */
async function drag(page: Page, index: number, dx: number, options: { readonly release?: boolean } = {}): Promise<{ x: number; y: number }> {
  const before = await stripOf(page);
  const x = (before.separators[index] as number) + 0.5;
  const y = HEIGHT / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  if (options.release !== false) await page.mouse.up();
  return { x: x + dx, y };
}

describe.skipIf(chrome === null)('the column strip under a real mouse (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;
  let page: Page;

  /** A plain terminal of the host, opened on the host's computer; its row appears in the session list. */
  const terminal = async (title: string): Promise<string> => {
    const { session } = await env.stack.hostClient.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title });
    await page.getByRole('treeitem', { name: new RegExp(`^${title}`) }).waitFor({ timeout: STEP_MS });
    return session.id;
  };
  const row = (title: string) => page.getByRole('treeitem', { name: new RegExp(`^${title}`) });
  const column = (title: string) => page.getByRole('region', { name: title, exact: true });

  beforeAll(async () => {
    // No agent is started here; the stand-in makes sure nothing on this machine could be either.
    const claude = await installFakeClaude(await mkdtemp(join(process.env['TMPDIR'] as string, 'columns-claude-')), { turns: [{ steps: [{ text: 'Noted.' }] }] });
    env = await startSmoke({
      stack: {
        git: true,
        projectFiles: { 'README.md': '# Bookshop\n' },
        sessions: { claudePath: claude.path, selfCommand: { file: '/usr/bin/true', args: [] } },
      },
    });
    page = await env.newPage({ width: WIDTH, height: HEIGHT });
    await joinAsHost(page, env);
    for (const title of ['one', 'two', 'three', 'four', 'five']) await terminal(title);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  it('a click opens in the focused column, Shift+click to the side: three whole columns share the strip exactly', async () => {
    // Nothing is open: the right side says so.
    await page.getByRole('heading', { level: 2, name: 'Nothing is open' }).waitFor({ timeout: STEP_MS });
    await row('one').click();
    let strip = await stripWhen(page, (s) => s.columns.length === 1, 'one column');
    expect(names(strip)).toEqual(['one']);
    expect(strip.left).toBe(LEFT);
    expect(strip.width).toBe(WIDTH - LEFT);
    expect(strip.columns[0]).toMatchObject({ left: LEFT, width: WIDTH - LEFT, focused: true });
    // The column fills the height under the top bar: its body can be used.
    expect(strip.columns[0]?.height).toBeGreaterThan(HEIGHT - 60);
    // A click on another row replaces what the focused column shows.
    await row('two').click();
    strip = await stripWhen(page, (s) => names(s).join() === 'two', 'the click replaced the column');
    // Shift+click opens to the side, right of the focused column, and takes the focus.
    await row('one').click({ modifiers: ['Shift'] });
    await row('three').click({ modifiers: ['Shift'] });
    strip = await stripWhen(page, (s) => s.columns.length === 3, 'three columns');
    expect(names(strip)).toEqual(['two', 'one', 'three']);
    expect(strip.columns.map((c) => c.focused)).toEqual([false, false, true]);
    // 1440 − 289 = 1151 px for three columns and two 1 px dividers: 383 px each (UX §9).
    expect(widths(strip)).toEqual([383, 383, 383]);
    expect(strip.separators).toEqual([LEFT + 383, LEFT + 383 + 1 + 383]);
    expect(strip.more).toEqual([]);
    expect(strip.pageFits).toBe(true);
    // Each column shows its own terminal.
    for (const title of ['one', 'two', 'three']) await column(title).locator('.agents-term__viewport[data-phase="live"]').waitFor({ timeout: STEP_MS });
  });

  it('a divider follows the pointer while the button is down, trades width between its neighbours, and stops at their minimum', async () => {
    const at = await drag(page, 0, 40, { release: false });
    // Under the pointer, before the release.
    let strip = await stripWhen(page, (s) => s.columns[0]?.width === 423, 'the divider followed the pointer');
    expect(widths(strip)).toEqual([423, 343, 383]);
    expect(strip.separators[0]).toBe(at.x - 0.5);
    await page.mouse.up();
    // Nothing moves without the button: a hover over the line, and far from it.
    await page.mouse.move(at.x + 80, at.y, { steps: 4 });
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await page.mouse.move(at.x - 120, at.y + 50, { steps: 4 });
    expect(widths(await stripOf(page))).toEqual([423, 343, 383]);

    // Further than the neighbour can give: it keeps 320 px, the third column is not touched.
    await drag(page, 0, 300);
    strip = await stripWhen(page, (s) => s.columns[1]?.width === MIN, 'the neighbour stopped at its minimum');
    expect(widths(strip)).toEqual([446, MIN, 383]);
    // And the other way: the first column keeps its minimum.
    await drag(page, 0, -600);
    strip = await stripWhen(page, (s) => s.columns[0]?.width === MIN, 'the column stopped at its minimum');
    expect(widths(strip)).toEqual([MIN, 446, 383]);
    expect(strip.pageFits).toBe(true);
  });

  it('the keys move a divider by 16 px (64 px with Shift); a double click makes all columns equal', async () => {
    const separator = page.getByRole('separator', { name: 'Drag or use the arrow keys to resize two' });
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    await stripWhen(page, (s) => s.columns[0]?.width === MIN + 16, 'ArrowRight moved the divider by 16 px');
    await page.keyboard.press('Shift+ArrowRight');
    let strip = await stripWhen(page, (s) => s.columns[0]?.width === MIN + 80, 'Shift+ArrowRight moved it by 64 px');
    expect(widths(strip)).toEqual([400, 366, 383]);
    expect(await separator.getAttribute('aria-valuenow')).toBe('400');
    await page.keyboard.press('ArrowLeft');
    await stripWhen(page, (s) => s.columns[0]?.width === 384, 'ArrowLeft moved it back by 16 px');
    await separator.dblclick();
    strip = await stripWhen(page, (s) => widths(s).join() === '383,383,383', 'a double click made the columns equal');
    expect(strip.pageFits).toBe(true);
  });

  it('what is open, in which order and how wide, is remembered across a reload', async () => {
    await drag(page, 1, -43);
    const before = await stripWhen(page, (s) => s.columns[2]?.width === 426, 'the second divider moved');
    expect(widths(before)).toEqual([383, 340, 426]);
    await page.reload();
    await workspaceOnline(page);
    const after = await stripWhen(page, (s) => s.columns.length === 3, 'the columns are back');
    expect(names(after)).toEqual(['two', 'one', 'three']);
    expect(widths(after)).toEqual([383, 340, 426]);
    expect(after.columns.map((c) => c.focused)).toEqual([false, false, true]);
    // Their terminals are live again.
    for (const title of ['one', 'two', 'three']) await column(title).locator('.agents-term__viewport[data-phase="live"]').waitFor({ timeout: STEP_MS });
    await page.getByRole('separator', { name: 'Drag or use the arrow keys to resize two' }).dblclick();
    await stripWhen(page, (s) => widths(s).join() === '383,383,383', 'equal again');
  });

  it('a fourth column that does not fit is reached sideways, whole columns only; a fifth is refused', async () => {
    await row('four').click({ modifiers: ['Shift'] });
    let strip = await stripWhen(page, (s) => s.columns.length === 4 && s.more.length === 1, 'four columns, one out of view');
    expect(names(strip)).toEqual(['two', 'one', 'three', 'four']);
    // Three whole columns fill the view; the fourth is as wide and off to the right (brought into view: it was asked for).
    expect(widths(strip)).toEqual([383, 383, 383, 383]);
    expect(strip.pageFits).toBe(true);
    // The new column was brought into view: the first one is the one out of view now.
    strip = await stripWhen(page, (s) => s.scrollLeft === 384 && s.more[0]?.side === 'left', 'the strip scrolled by one column');
    expect(strip.more).toEqual([{ side: 'left', text: '1 more' }]);
    expect(strip.columns[1]?.left).toBe(LEFT);
    // A reload brings the same view back: the focused column ("four", the one the list marks) is in view again, not
    // off the right edge of a strip that starts at its first column.
    await page.reload();
    await workspaceOnline(page);
    strip = await stripWhen(page, (s) => s.columns.length === 4 && s.scrollLeft === 384 && s.more[0]?.side === 'left', 'after a reload the focused column is in view');
    expect(strip.columns.map((c) => c.focused)).toEqual([false, false, false, true]);
    expect(strip.columns[3]?.left).toBe(LEFT + 2 * 384);
    expect(strip.pageFits).toBe(true);
    await page.getByRole('button', { name: '1 more' }).click();
    strip = await stripWhen(page, (s) => s.scrollLeft === 0 && s.more[0]?.side === 'right', 'the edge button scrolled back by one column');
    expect(strip.more).toEqual([{ side: 'right', text: '1 more' }]);
    expect(strip.columns[0]?.left).toBe(LEFT);

    // A fifth: refused with one sentence, and nothing changes.
    await row('five').click({ modifiers: ['Shift'] });
    await page.getByText('Four columns are open. Close one first.').waitFor({ timeout: STEP_MS });
    expect(names(await stripOf(page))).toEqual(['two', 'one', 'three', 'four']);
  });

  it('with the left column folded to its rail all four fit; unfolded again, three do', async () => {
    const toggle = page.getByRole('button', { name: 'Show or hide the inbox and the session list' });
    await toggle.click();
    // The rail has no separator of its own: the strip begins right behind its 44 px.
    let strip = await stripWhen(page, (s) => s.left === RAIL && s.more.length === 0, 'the rail gives the strip its room');
    // 1440 − 44 = 1396 px for four columns and three dividers: 348 px each, and the one pixel left over (UX §9).
    expect(widths(strip)).toEqual([349, 348, 348, 348]);
    expect(strip.width).toBe(WIDTH - RAIL);
    expect(strip.columns.every((column) => column.width >= MIN)).toBe(true);
    expect(strip.pageFits).toBe(true);
    await toggle.click();
    strip = await stripWhen(page, (s) => s.left === LEFT && s.more.length === 1, 'three fit again');
    expect(widths(strip)).toEqual([383, 383, 383, 383]);
  });

  it('closing moves the focus to the neighbour\'s title; Delete on a title closes; closing never ends a session', async () => {
    await page.getByRole('button', { name: 'Close column: one' }).click();
    let strip = await stripWhen(page, (s) => s.columns.length === 3, 'the column closed');
    expect(names(strip)).toEqual(['two', 'three', 'four']);
    // The right neighbour has the focus, on its title.
    expect(await page.evaluate(() => document.activeElement?.closest('[data-column-id]')?.getAttribute('aria-label'))).toBe('three');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H2');
    await page.keyboard.press('Delete');
    strip = await stripWhen(page, (s) => s.columns.length === 2, 'Delete closed the column');
    expect(names(strip)).toEqual(['two', 'four']);
    expect(await page.evaluate(() => document.activeElement?.closest('[data-column-id]')?.getAttribute('aria-label'))).toBe('four');
    // Two columns share the strip.
    expect(widths(strip)).toEqual([575, 575]);
    // The sessions are still there, running.
    for (const title of ['one', 'three']) await row(title).waitFor({ timeout: STEP_MS });
    expect(env.stack.daemon.ctx.services.sessions.list().filter((s) => s.kind === 'terminal' && s.status === 'running')).toHaveLength(5);
  });

  it('a pinned column is not replaced by a click on the left; the mode switch brings the columns back as they were', async () => {
    await column('four').getByRole('button', { name: 'Pin column: four' }).click();
    await column('four').getByRole('button', { name: 'Unpin column: four' }).waitFor({ timeout: STEP_MS });
    // "four" is focused and pinned: the click opens beside it instead of replacing it.
    await row('five').click();
    let strip = await stripWhen(page, (s) => s.columns.length === 3, 'the click opened beside the pinned column');
    expect(names(strip)).toEqual(['two', 'four', 'five']);
    const before = widths(strip);

    await page.getByRole('link', { name: /^Code mode/ }).click();
    await page.waitForURL(`${env.origin}/w/${env.stack.workspaceId}/code`, { timeout: STEP_MS });
    await page.getByRole('main', { name: 'Editor' }).waitFor({ timeout: STEP_MS });
    await page.getByRole('link', { name: /^Sessions/ }).click();
    await page.waitForURL(`${env.origin}/w/${env.stack.workspaceId}`, { timeout: STEP_MS });
    strip = await stripWhen(page, (s) => s.columns.length === 3 && s.width === WIDTH - LEFT, 'the sessions view is back');
    expect(names(strip)).toEqual(['two', 'four', 'five']);
    expect(widths(strip)).toEqual(before);
    expect(strip.pageFits).toBe(true);

    // After the last column the right side is empty again and the focus is in the session list.
    for (const title of ['two', 'four', 'five']) await page.getByRole('button', { name: `Close column: ${title}` }).click();
    await page.getByRole('heading', { level: 2, name: 'Nothing is open' }).waitFor({ timeout: STEP_MS });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('treeitem');
    // Nothing went wrong in the page on the way.
    expect(env.problemsOf(page).pageErrors).toEqual([]);
  });
});
