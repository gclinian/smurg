// A plain terminal in a real browser (the built app, the real relay, a daemon with every module, system Chrome at
// 1440 x 900 with real scrollbars): a column of the sessions view (DESIGN §5.4 "Session (terminal)").
//  - the OWNER's PTY follows the column: `stty size` typed into the terminal equals what the column fits, alone in the
//    strip (wide) and beside another column (narrow), and no part of the terminal lies outside its visible, scrollable
//    container;
//  - a WATCHER renders the PTY's size: in a narrower column a line as long as the owner's terminal is wide is reached
//    by scrolling (visible scrollbars), never reflowed, and "Scale to fit the width" draws all of it inside the column.
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, joinAs, joinAsHost, startSmoke, systemChrome, terminalOf, typeInTerminal, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Layout {
  /** The terminal element (xterm) and the viewport's visible client box (scrollbars excluded). */
  readonly terminal: Box;
  readonly visible: Box;
  /** Every clipping ancestor of the viewport, intersected with the window. */
  readonly clip: Box;
  readonly viewport: Box;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly overflowX: string;
  readonly overflowY: string;
  /** Scrollbar thickness actually drawn (offset − client). */
  readonly scrollbarX: number;
  readonly scrollbarY: number;
  /** Rendered columns / rows (data-cols) and one cell's size, measured from the screen element. */
  readonly cols: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly paddingX: number;
  readonly paddingY: number;
  readonly dataset: Record<string, string | undefined>;
}

async function layoutOf(page: Page, id: string): Promise<Layout> {
  return terminalOf(page, id).evaluate((viewport: HTMLElement) => {
    const box = (r: DOMRect | { left: number; top: number; right: number; bottom: number }) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const xterm = viewport.querySelector('.xterm') as HTMLElement;
    const screen = viewport.querySelector('.xterm-screen') as HTMLElement;
    const v = viewport.getBoundingClientRect();
    const style = getComputedStyle(viewport);
    const visible = { left: v.left + viewport.clientLeft, top: v.top + viewport.clientTop, right: v.left + viewport.clientLeft + viewport.clientWidth, bottom: v.top + viewport.clientTop + viewport.clientHeight };
    let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let el = viewport.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const r = el.getBoundingClientRect();
      clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
    }
    const cols = Number(viewport.dataset['cols']);
    const rows = Number(viewport.dataset['rows']);
    const own = getComputedStyle(xterm);
    return {
      terminal: box(xterm.getBoundingClientRect()),
      visible,
      clip,
      viewport: box(v),
      scrollWidth: viewport.scrollWidth,
      scrollHeight: viewport.scrollHeight,
      clientWidth: viewport.clientWidth,
      clientHeight: viewport.clientHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollbarX: viewport.offsetHeight - viewport.clientHeight,
      scrollbarY: viewport.offsetWidth - viewport.clientWidth,
      cols,
      rows,
      cellWidth: screen.offsetWidth / cols,
      cellHeight: screen.offsetHeight / rows,
      paddingX: parseFloat(own.paddingLeft) + parseFloat(own.paddingRight),
      paddingY: parseFloat(own.paddingTop) + parseFloat(own.paddingBottom),
      dataset: { ...viewport.dataset },
    };
  });
}

const within = (inner: Box, outer: Box, slack = 0.5): boolean =>
  inner.left >= outer.left - slack && inner.top >= outer.top - slack && inner.right <= outer.right + slack && inner.bottom <= outer.bottom + slack;

/** No part of the terminal lies outside its visible, scrollable container; the container itself is not clipped. */
function expectNothingHidden(layout: Layout, what: string): void {
  // The scroll container is entirely visible: no ancestor clips it, it is inside the window.
  expect(within(layout.viewport, layout.clip), `${what}: the terminal's container is clipped by an ancestor: ${JSON.stringify(layout)}`).toBe(true);
  if (within(layout.terminal, layout.visible)) return;
  // Otherwise the container must scroll to every part of it, both ways, with scrollbars it draws.
  expect(layout.overflowX, what).toMatch(/auto|scroll/);
  expect(layout.overflowY, what).toMatch(/auto|scroll/);
  const width = layout.terminal.right - layout.terminal.left;
  const height = layout.terminal.bottom - layout.terminal.top;
  expect(layout.scrollWidth, `${what}: a part of the terminal cannot be scrolled to`).toBeGreaterThanOrEqual(Math.floor(width));
  expect(layout.scrollHeight, `${what}: a part of the terminal cannot be scrolled to`).toBeGreaterThanOrEqual(Math.floor(height));
  if (width > layout.clientWidth + 1) expect(layout.scrollbarX, `${what}: a horizontal scrollbar is drawn`).toBeGreaterThan(0);
  if (height > layout.clientHeight + 1) expect(layout.scrollbarY, `${what}: a vertical scrollbar is drawn`).toBeGreaterThan(0);
}

/** What the panel fits, computed here from the page's geometry (xterm's 14 px scrollback reserve, like its FitAddon). */
function fittedCols(layout: Layout): number {
  return Math.floor((layout.clientWidth - layout.paddingX - 14) / layout.cellWidth);
}
function fittedRows(layout: Layout): number {
  return Math.floor((layout.clientHeight - layout.paddingY) / layout.cellHeight);
}

/** Types `stty size` and returns the PTY's own answer. */
async function sttySize(page: Page, id: string, marker: string): Promise<{ rows: number; cols: number }> {
  await typeInTerminal(page, id, `echo ${marker} $(stty size)`);
  const pattern = new RegExp(`^${marker} (\\d+) (\\d+)$`);
  const row = await page.waitForFunction(
    ({ id, source }) => {
      const re = new RegExp(source);
      const rows = [...document.querySelectorAll(`.agents-session[data-session-id="${id}"] .xterm-rows > div`)].map((r) => (r.textContent ?? '').replace(/ /g, ' ').trim());
      return rows.find((text) => re.test(text)) ?? false;
    },
    { id, source: pattern.source },
    { timeout: STEP_MS },
  );
  const match = pattern.exec((await row.jsonValue()) as string) as RegExpExecArray;
  return { rows: Number(match[1]), cols: Number(match[2]) };
}

/** Waits until the owner's terminal renders what its panel fits (the resize went to the daemon and came back). */
async function waitDriving(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const viewport = document.querySelector<HTMLElement>(`.agents-session[data-session-id="${id}"] .agents-term__viewport`);
      const d = viewport?.dataset;
      return !!d && d['driving'] === 'true' && d['cols'] === d['fitCols'] && d['rows'] === d['fitRows'];
    },
    id,
    { timeout: STEP_MS },
  );
}

/**
 * Opens a plain terminal from the "New" control of the session list ("New" → "Terminal" → the dialog); resolves with
 * its id once its terminal is live in a column.
 */
async function openTerminal(page: Page, title: string): Promise<string> {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  const dialog = page.getByRole('dialog', { name: 'New terminal' });
  await dialog.waitFor({ timeout: STEP_MS });
  await dialog.getByLabel('Name (optional)').fill(title);
  await dialog.getByRole('button', { name: 'Open' }).click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_MS });
  const session = page.getByRole('region', { name: title }).locator('.agents-session', { has: page.locator('.agents-term__viewport[data-phase="live"]') });
  await session.first().waitFor({ timeout: STEP_MS });
  const id = await session.first().getAttribute('data-session-id');
  if (!id) throw new Error('no session id on the live terminal');
  return id;
}

describe.skipIf(chrome === null)('a plain terminal as a column (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;
  let host: Page;
  let sessionId: string;
  /** The columns of the owner's PTY at the end of the first test (alone in the strip). */
  let ownerWide = 0;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# Class project\n' } } });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  it('the owner: the PTY follows the column: `stty size` equals what a wide and a narrow column fit, and no part of the terminal lies outside its visible, scrollable container', async () => {
    host = await env.newPage();
    await joinAsHost(host, env);
    sessionId = await openTerminal(host, 'shell');
    await waitDriving(host, sessionId);

    // Wide: the only column of the strip.
    const wide = await layoutOf(host, sessionId);
    const wideSize = await sttySize(host, sessionId, 'WIDE');
    expect(wideSize).toEqual({ cols: fittedCols(wide), rows: fittedRows(wide) });
    expect(wideSize.cols).toBeGreaterThan(100);
    expectNothingHidden(await layoutOf(host, sessionId), 'wide owner');

    // Narrow: a second terminal takes the column, then "shell" is opened to the side of it (Shift+click on its row).
    await openTerminal(host, 'other');
    await host.getByRole('treeitem', { name: /shell/ }).first().click({ modifiers: ['Shift'] });
    await host.waitForFunction(
      ({ id, before }) => {
        const d = document.querySelector<HTMLElement>(`.agents-session[data-session-id="${id}"] .agents-term__viewport`)?.dataset;
        return !!d && d['phase'] === 'live' && Number(d['fitCols']) < before;
      },
      { id: sessionId, before: wideSize.cols },
      { timeout: STEP_MS },
    );
    await waitDriving(host, sessionId);
    const narrow = await layoutOf(host, sessionId);
    const narrowSize = await sttySize(host, sessionId, 'NARROW');
    expect(narrowSize).toEqual({ cols: fittedCols(narrow), rows: fittedRows(narrow) });
    expect(narrowSize.cols).toBeLessThan(wideSize.cols);
    expect(narrowSize).toEqual({ cols: Number(narrow.dataset['fitCols']), rows: Number(narrow.dataset['fitRows']) });
    // A command longer than the column is wide, and its output: wrapped by the shell inside the column, nothing cut off.
    await typeInTerminal(host, sessionId, `echo hello-from-host-$(printf '%0120d' 0) && ls`);
    await host.waitForFunction(
      (id) => [...document.querySelectorAll(`.agents-session[data-session-id="${id}"] .xterm-rows > div`)].some((r) => (r.textContent ?? '').includes('README.md')),
      sessionId,
      { timeout: STEP_MS },
    );
    const afterCommand = await layoutOf(host, sessionId);
    expect(within(afterCommand.terminal, afterCommand.visible), `the owner's terminal fits its column: ${JSON.stringify(afterCommand)}`).toBe(true);
    expectNothingHidden(afterCommand, 'narrow owner');
    expect(await host.getByRole('region', { name: 'shell' }).getByTestId('terminal-size-hint').count()).toBe(0);

    // Wide again: the other column is closed (the watcher below needs a PTY wider than its own column).
    await host.getByRole('button', { name: 'Close column: other' }).click();
    await host.waitForFunction(
      ({ id, before }) => Number(document.querySelector<HTMLElement>(`.agents-session[data-session-id="${id}"] .agents-term__viewport`)?.dataset['fitCols']) > before,
      { id: sessionId, before: narrowSize.cols },
      { timeout: STEP_MS },
    );
    await waitDriving(host, sessionId);
    expect((await sttySize(host, sessionId, 'AGAIN')).cols).toBe(wideSize.cols);
    ownerWide = wideSize.cols;
    console.info(`[terminal fit] owner PTY ${wideSize.cols}x${wideSize.rows} alone in the strip, ${narrowSize.cols}x${narrowSize.rows} beside another column`);
  }, 240_000);

  it('a watcher: the PTY-sized terminal is never reflowed; in a narrower column a line as long as the owner\'s terminal is wide is reached by scrolling (visible scrollbars), and "Scale to fit the width" fits it', async () => {
    // The owner's PTY is wide (the previous test). A line nearly as long as it is wide: L, zeros, R.
    const lineCols = ownerWide - 2;
    expect(lineCols).toBeGreaterThan(100);
    await typeInTerminal(host, sessionId, `printf 'L%0${lineCols - 2}dR\\n' 0`);
    const line = `L${'0'.repeat(lineCols - 2)}R`;
    // A smaller window than the owner's: the column is narrower than the owner's PTY.
    const watcher = await env.newPage({ width: 1000, height: 800 });
    await joinAs(watcher, env, 'wendy', 'viewer');
    await watcher.getByRole('treeitem', { name: /shell/ }).first().click();
    const viewport = terminalOf(watcher, sessionId);
    await viewport.and(watcher.locator('[data-phase="live"]')).waitFor({ timeout: STEP_MS });
    await watcher.waitForFunction(
      ({ id, line }) => [...document.querySelectorAll(`.agents-session[data-session-id="${id}"] .xterm-rows > div`)].some((r) => (r.textContent ?? '').replace(/ /g, ' ').trim() === line),
      { id: sessionId, line },
      { timeout: STEP_MS },
    );
    const ownerCols = Number((await layoutOf(host, sessionId)).dataset['cols']);
    const watched = await layoutOf(watcher, sessionId);
    // Exactly the PTY's size (never reflowed to the column), bigger than the column: it scrolls, its scrollbars drawn.
    expect(watched.cols).toBe(ownerCols);
    expect(watched.scrollWidth).toBeGreaterThan(watched.clientWidth);
    expect(watched.scrollbarX).toBeGreaterThan(0);
    expectNothingHidden(watched, 'watcher');
    expect(await watcher.getByTestId('terminal-size-hint').textContent()).toContain(`Actual size ${ownerCols} ×`);

    // Where the line's first and last characters are, with the terminal scrolled to the left and to the right.
    const edges = async (scrollLeft: number) =>
      viewport.evaluate(
        (node: HTMLElement, { line, scrollLeft }) => {
          node.scrollLeft = scrollLeft;
          const row = [...node.querySelectorAll('.xterm-rows > div')].find((r) => (r.textContent ?? '').replace(/ /g, ' ').trim() === line) as HTMLElement;
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          const texts: Text[] = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
          const charRect = (which: 'L' | 'R') => {
            for (const text of which === 'L' ? texts : [...texts].reverse()) {
              const at = which === 'L' ? text.data.indexOf('L') : text.data.lastIndexOf('R');
              if (at < 0) continue;
              const range = document.createRange();
              range.setStart(text, at);
              range.setEnd(text, at + 1);
              const r = range.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            }
            return null;
          };
          const v = node.getBoundingClientRect();
          const visible = { left: v.left + node.clientLeft, top: v.top + node.clientTop, right: v.left + node.clientLeft + node.clientWidth, bottom: v.top + node.clientTop + node.clientHeight };
          return { first: charRect('L'), last: charRect('R'), visible, scrollLeft: node.scrollLeft, max: node.scrollWidth - node.clientWidth };
        },
        { line, scrollLeft },
      );
    const left = await edges(0);
    expect(left.first && within(left.first, left.visible)).toBe(true);
    expect(left.last && within(left.last, left.visible)).toBe(false);
    // Scrolled just far enough to the right: the last column comes into view (and the container can scroll that far).
    const needed = Math.ceil((left.last?.right ?? 0) - left.visible.right) + 2;
    expect(needed).toBeLessThanOrEqual(left.max);
    const right = await edges(needed);
    expect(right.scrollLeft).toBe(needed);
    expect(right.last && within(right.last, right.visible), `the last column is reached by scrolling: ${JSON.stringify(right)}`).toBe(true);
    // The line was not wrapped onto two rows: first and last character on the same row.
    expect(Math.abs((right.last?.top ?? 0) - (left.first?.top ?? 0))).toBeLessThan(1);

    // "Scale to fit the width": the same PTY-sized terminal, drawn smaller: all of it inside the column, nothing reflowed.
    await watcher.getByRole('button', { name: 'Scale to fit the width' }).click();
    await watcher.waitForFunction(
      (id) => {
        const node = document.querySelector<HTMLElement>(`.agents-session[data-session-id="${id}"] .agents-term__viewport`);
        const xterm = node?.querySelector('.xterm');
        return !!node && !!xterm && xterm.getBoundingClientRect().width <= node.clientWidth + 1;
      },
      sessionId,
      { timeout: STEP_MS },
    );
    const scaled = await edges(0);
    expect(scaled.last && within(scaled.last, scaled.visible, 1)).toBe(true);
    expect(scaled.first && within(scaled.first, scaled.visible, 1)).toBe(true);
    expect((await layoutOf(watcher, sessionId)).cols).toBe(ownerCols);
    expect(env.problemsOf(watcher).pageErrors).toEqual([]);
    expect(env.problemsOf(host).pageErrors).toEqual([]);
  }, 240_000);
});
