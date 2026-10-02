// The dividers of the workbench under a REAL mouse (the built app, the real relay, a daemon with every module, system
// Chrome at 1440 × 900; playwright's mouse goes through Chrome's own input pipeline: hit testing, pointer capture,
// compatibility mouse events). The owner's bug: 「code 編輯區和 session 區中間的分隔線移動有 bug（滑鼠碰到線右邊線會自己
// 動，很難控制）」. What it was (apps/web/src/ui/SplitPane.tsx before v0.4.0):
//  - the drag state ended only with a pointerup that reached the separator. Chrome drops the pointer capture without
//    one when a second button goes down during the drag (and for a native context menu, or when the separator leaves
//    the page under the pressed button); from then on EVERY hover over the line resized the pane to the pointer, and
//    because only the 3 px left of the line were its grab area, a pointer coming from the right pushed the line ahead
//    of itself, one pixel per pixel, without any button;
//  - a press moved the line to the pointer (a jump of up to 4 px), and the 3 px right of the line belonged to the
//    terminal, the editor's margin or a panel header.
// Now: nothing moves without the primary button; the line stays under the pointer where it was grabbed (3 px on either
// side), stops on the release wherever the pointer is, keeps the editor a minimum, and the terminal still refits.
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STEP_MS, explainFailures, joinAsHost, openSession, startSmoke, systemChrome, terminalOf, workspaceOnline, type SmokeEnv } from './helpers.ts';

const chrome = systemChrome();
if (chrome === null) console.warn('[web smoke] SKIPPED: no system Chrome found (playwright-core downloads no browser); install Google Chrome to run it.');

interface Divider {
  readonly name: string;
  readonly selector: string;
  /** The axis the divider moves along: 'x' for a vertical line between panes side by side. */
  readonly axis: 'x' | 'y';
  /** The direction (along the axis) that makes the sized pane bigger. */
  readonly grow: 1 | -1;
}

// In document order: the file tree's and the agents column's separators are the horizontal splits'; the vertical
// splits' are agents / suggestions and, while the bottom drawer is open (it starts collapsed), the drawer's.
const FILES: Divider = { name: 'file tree | editor', selector: '.ui-split--horizontal > .ui-split__separator >> nth=0', axis: 'x', grow: 1 };
const AGENTS: Divider = { name: 'editor | agents', selector: '.ui-split--horizontal > .ui-split__separator >> nth=1', axis: 'x', grow: -1 };
const SUGGESTIONS: Divider = { name: 'terminal / suggestions', selector: '.ui-split--vertical > .ui-split__separator >> nth=0', axis: 'y', grow: -1 };
const DRAWER: Divider = { name: 'workbench / drawer', selector: '.ui-split--vertical > .ui-split__separator >> nth=1', axis: 'y', grow: -1 };
const DIVIDERS = [FILES, AGENTS, SUGGESTIONS, DRAWER] as const;

/** The agents column's width when nothing is remembered, and the least it gets (Workbench.tsx). */
const AGENTS_DEFAULT_PX = 420;
const AGENTS_MIN_PX = 260;
/** What the separator of the agents column leaves the editor (Workbench.tsx MIN_EDITOR_PX). */
const MIN_EDITOR_PX = 160;
const WIDTH = 1440;
const HEIGHT = 900;

describe.skipIf(chrome === null)('the workbench dividers under a real mouse (built app, real relay, system Chrome)', () => {
  let env: SmokeEnv;
  let page: Page;
  let sessionId: string;

  beforeAll(async () => {
    env = await startSmoke({ stack: { projectFiles: { 'README.md': '# 班級專案\n\nsome text to select\n', 'src/app.ts': 'export const x = 1;\n' } } });
    page = await env.newPage({ width: WIDTH, height: HEIGHT });
    await joinAsHost(page, env);
    // A live terminal right of the divider (xterm, a ResizeObserver that refits the PTY), Monaco left of it.
    sessionId = await openSession(page, 'terminal', 'shell');
    await page.getByRole('treeitem', { name: 'README.md' }).first().click();
    await page.locator('.editor-doc__monaco[data-bound]').waitFor({ timeout: STEP_MS });
    await waitDriving();
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  }, 60_000);

  explainFailures(() => env);

  // A failed test must not leave a button down or a small window to the next one.
  afterEach(async () => {
    await page?.mouse.up({ button: 'left' }).catch(() => {});
    await page?.mouse.up({ button: 'right' }).catch(() => {});
    await page?.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {});
    await setDrawer(false).catch(() => {});
  });

  /** Two animation frames: a move is applied in the next frame, and painted. */
  async function frames(): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }

  async function boxOf(divider: Divider): Promise<{ left: number; top: number; right: number; bottom: number }> {
    return page.locator(divider.selector).evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
  }

  /** Where the divider's line is, along its axis. */
  async function lineOf(divider: Divider): Promise<number> {
    const box = await boxOf(divider);
    return divider.axis === 'x' ? box.left : box.top;
  }

  /** The middle of the line, across its axis: where the mouse crosses it. */
  async function crossOf(divider: Divider): Promise<number> {
    const box = await boxOf(divider);
    return Math.round(divider.axis === 'x' ? (box.top + box.bottom) / 2 : (box.left + box.right) / 2);
  }

  const point = (divider: Divider, along: number, cross: number): [number, number] => (divider.axis === 'x' ? [along, cross] : [cross, along]);

  /** What the mouse is over at a point: the separator, or what else. */
  async function under(at: [number, number]): Promise<string> {
    return page.evaluate(([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      return node === null ? '(nothing)' : `${node.tagName.toLowerCase()}.${(node.getAttribute('class') ?? '').split(' ')[0]}`;
    }, at);
  }

  /** Moves the mouse from `from` to `to` along the axis, one pixel at a time, no button; every place the line was. */
  async function hoverAcross(divider: Divider, from: number, to: number): Promise<number[]> {
    const cross = await crossOf(divider);
    const seen = new Set<number>();
    const step = from <= to ? 1 : -1;
    await page.mouse.move(...point(divider, from, cross));
    for (let at = from; at !== to + step; at += step) {
      await page.mouse.move(...point(divider, at, cross));
      seen.add(await lineOf(divider));
    }
    await frames();
    seen.add(await lineOf(divider));
    return [...seen];
  }

  /** The line stays where it is while the mouse comes from either side and crosses it (no button). */
  async function expectStillUnderHover(divider: Divider, what: string): Promise<void> {
    const line = await lineOf(divider);
    expect(await hoverAcross(divider, line + 40, line - 60), `${divider.name}, ${what}: a hover coming from the right / from below moved the line`).toEqual([line]);
    expect(await hoverAcross(divider, line - 40, line + 60), `${divider.name}, ${what}: a hover coming from the left / from above moved the line`).toEqual([line]);
  }

  /** Drags the divider's line to `target` (press on the line, a few moves, release there). */
  async function dragLineTo(divider: Divider, target: number): Promise<void> {
    const cross = await crossOf(divider);
    const line = await lineOf(divider);
    await page.mouse.move(...point(divider, line, cross));
    await page.mouse.down();
    await page.mouse.move(...point(divider, target, cross), { steps: 4 });
    await page.mouse.up();
    await frames();
  }

  /** The owner's terminal renders what its panel fits (the resize went to the daemon and came back). */
  async function waitDriving(): Promise<void> {
    await page.waitForFunction(
      (id) => {
        const d = document.querySelector<HTMLElement>(`.agents-session[data-session-id="${id}"] .agents-term__viewport`)?.dataset;
        return !!d && d['driving'] === 'true' && d['cols'] === d['fitCols'] && d['rows'] === d['fitRows'];
      },
      sessionId,
      { timeout: STEP_MS },
    );
  }

  async function terminalCols(): Promise<number> {
    return Number(await terminalOf(page, sessionId).getAttribute('data-cols'));
  }

  /** Opens (or closes) the bottom drawer with its button in the top bar: its separator exists only while it is open. */
  async function setDrawer(open: boolean): Promise<void> {
    const toggle = page.locator('.app-topbar__toggles button').nth(1);
    if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
    await page.locator(DRAWER.selector).waitFor({ state: open ? 'attached' : 'detached', timeout: STEP_MS });
    await frames();
  }

  it('a hover never moves a divider: across each one from both sides, one pixel at a time, no button', async () => {
    await setDrawer(true);
    for (const divider of DIVIDERS) await expectStillUnderHover(divider, 'untouched');
    await setDrawer(false);
  }, 120_000);

  it('a press within 3 px of the line, on EITHER side, grabs it without moving it, and the line then follows the pointer within a pixel (all four dividers)', async () => {
    await setDrawer(true);
    for (const divider of DIVIDERS) {
      for (const offset of [-3, 0, 3]) {
        const cross = await crossOf(divider);
        const line = await lineOf(divider);
        // Come from the side the press is on.
        await page.mouse.move(...point(divider, line + offset + (offset < 0 ? -15 : 15), cross));
        await page.mouse.move(...point(divider, line + offset, cross), { steps: 5 });
        expect(await under(point(divider, line + offset, cross)), `${divider.name}: ${offset} px from the line is the separator's`).toBe('div.ui-split__separator');
        // One pixel further out belongs to the pane.
        expect(await under(point(divider, line + (offset < 0 ? -4 : 4), cross)), `${divider.name}: 4 px from the line is the pane's`).not.toBe('div.ui-split__separator');
        await page.mouse.down();
        await frames();
        expect(await lineOf(divider), `${divider.name}: a press ${offset} px from the line moved it`).toBe(line);
        let worst = 0;
        for (let moved = 1; moved <= 20; moved++) {
          await page.mouse.move(...point(divider, line + offset + divider.grow * moved, cross));
          await frames();
          worst = Math.max(worst, Math.abs((await lineOf(divider)) - (line + divider.grow * moved)));
        }
        expect(worst, `${divider.name}, grabbed ${offset} px from the line: how far the line strayed from the pointer's travel`).toBeLessThanOrEqual(1);
        await page.mouse.up();
        await frames();
        expect(await lineOf(divider), `${divider.name}: where the line is after the release`).toBe(line + divider.grow * 20);
      }
    }
    await expectStillUnderHover(AGENTS, 'after twelve drags');
    await setDrawer(false);
  }, 180_000);

  it('slow and fast drags stop on the release wherever the pointer is — over the terminal, over Monaco, outside the window — and take neither the focus nor a selection', async () => {
    // The keyboard is in the terminal, and stays there. (The terminal fills its panel first: a click below a
    // terminal that is still a few rows short would land on nothing.)
    await waitDriving();
    await terminalOf(page, sessionId).click();
    const focused = (): Promise<string> => page.evaluate(() => document.activeElement?.getAttribute('class') ?? '');
    expect(await focused()).toContain('xterm-helper-textarea');
    const cross = await crossOf(AGENTS);
    // The limits of the agents column in this window: its own minimum; the editor keeps MIN_EDITOR_PX.
    const lineAtMin = WIDTH - AGENTS_MIN_PX - 1;
    const lineAtMax = (await lineOf(FILES)) + 1 + MIN_EDITOR_PX;

    // Slowly to the right, one pixel per event, past the limit and on into the terminal; released over the terminal.
    let line = await lineOf(AGENTS);
    await page.mouse.move(line, cross);
    await page.mouse.down();
    for (let x = line + 1; x <= lineAtMin + 80; x++) {
      await page.mouse.move(x, cross);
      if (x % 20 !== 0) continue;
      await frames();
      expect(await lineOf(AGENTS), `slow drag: the line while the pointer is at ${x}`).toBe(Math.min(x, lineAtMin));
    }
    await frames();
    expect(await lineOf(AGENTS)).toBe(lineAtMin);
    // The panes ignore the pointer during a drag: the terminal is not what the mouse is over.
    expect(await under([lineAtMin + 80, cross])).toBe('div.ui-split');
    await page.mouse.up();
    expect(await under([lineAtMin + 80, cross])).not.toBe('div.ui-split');
    await page.mouse.move(lineAtMin + 150, cross + 40, { steps: 10 });
    expect(await lineOf(AGENTS), 'released over the terminal').toBe(lineAtMin);
    await expectStillUnderHover(AGENTS, 'released over the terminal');

    // Fast to the left (one event per 200 px), past the limit; released over Monaco.
    line = await lineOf(AGENTS);
    await page.mouse.move(line, cross);
    await page.mouse.down();
    await page.mouse.move(line - 200, cross);
    await frames();
    expect(await lineOf(AGENTS), 'fast drag: one 200 px move').toBe(line - 200);
    await page.mouse.move(line - 400, cross - 150);
    await frames();
    expect(await lineOf(AGENTS), 'fast drag: a second 200 px move, away from the middle').toBe(line - 400);
    await page.mouse.move(lineAtMax - 60, cross);
    await frames();
    expect(await lineOf(AGENTS), 'the editor keeps its minimum').toBe(lineAtMax);
    await page.mouse.up();
    await page.mouse.move(lineAtMax - 100, cross - 30, { steps: 5 });
    expect(await lineOf(AGENTS), 'released over Monaco').toBe(lineAtMax);
    await expectStillUnderHover(AGENTS, 'released over Monaco');

    // Out of the window with the button down; released out there.
    line = await lineOf(AGENTS);
    await page.mouse.move(line, cross);
    await page.mouse.down();
    await page.mouse.move(line + 300, cross, { steps: 6 });
    await page.mouse.move(line + 300, -60, { steps: 6 });
    await frames();
    expect(await lineOf(AGENTS), 'the pointer above the window: the line still follows it along its axis').toBe(line + 300);
    await page.mouse.move(WIDTH + 200, -60, { steps: 4 });
    await page.mouse.up();
    await frames();
    expect(await lineOf(AGENTS), 'released outside the window').toBe(lineAtMin);
    await page.mouse.move(WIDTH - 100, cross, { steps: 5 });
    await expectStillUnderHover(AGENTS, 'released outside the window');

    expect(await focused(), 'the terminal kept the keyboard through every drag').toContain('xterm-helper-textarea');
    expect(await page.evaluate(() => String(window.getSelection() ?? '')), 'no text was selected by a drag').toBe('');
    await dragLineTo(AGENTS, WIDTH - AGENTS_DEFAULT_PX - 1);
  }, 180_000);

  it('a drag that loses its release ends with the button — a second button during the drag, the panel hidden under the pressed button — and a hover afterwards moves nothing (the line that fled from the pointer)', async () => {
    const cross = await crossOf(AGENTS);

    // Left down, drag, right down, left up: Chrome drops the pointer capture; the last pointerup is not the separator's.
    let line = await lineOf(AGENTS);
    await page.mouse.move(line, cross);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(line - 20, cross, { steps: 5 });
    await frames();
    const stopped = await lineOf(AGENTS);
    expect(Math.abs(stopped - (line - 20))).toBeLessThanOrEqual(1);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'left' });
    await page.mouse.move(line - 50, cross, { steps: 6 });
    await frames();
    expect(await lineOf(AGENTS), 'only the right button is down: the line stays where the left one went up').toBe(stopped);
    await page.mouse.up({ button: 'right' });
    await page.mouse.move(line + 100, cross + 50, { steps: 5 });
    await expectStillUnderHover(AGENTS, 'after a second button ended the drag');

    // The panel hidden from the keyboard while the button is down: the separator leaves the page, the release goes
    // to something else.
    line = await lineOf(AGENTS);
    const toggle = page.locator('.app-topbar__toggles button').nth(2);
    await toggle.focus();
    await page.mouse.move(line, cross);
    await page.mouse.down();
    await page.mouse.move(line - 30, cross, { steps: 6 });
    await frames();
    const dragged = await lineOf(AGENTS);
    expect(Math.abs(dragged - (line - 30))).toBeLessThanOrEqual(1);
    await page.keyboard.press('Enter');
    await page.locator(AGENTS.selector).waitFor({ state: 'detached', timeout: STEP_MS });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await page.locator(AGENTS.selector).waitFor({ timeout: STEP_MS });
    await frames();
    expect(await lineOf(AGENTS), 'the panel is back at the width the drag gave it').toBe(dragged);
    await expectStillUnderHover(AGENTS, 'after the panel was hidden under the pressed button');

    await dragLineTo(AGENTS, WIDTH - AGENTS_DEFAULT_PX - 1);
    expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 180_000);

  it('the terminal still refits: a wider panel gives the PTY more columns, the old width the old columns, and Monaco keeps to its pane', async () => {
    await waitDriving();
    const before = await terminalCols();
    const line = await lineOf(AGENTS);
    const fitCols = (compare: 'more' | 'fewer', than: number) =>
      page.waitForFunction(
        ({ id, compare, than }) => {
          const cols = Number(document.querySelector<HTMLElement>(`.agents-session[data-session-id="${id}"] .agents-term__viewport`)?.dataset['fitCols']);
          return compare === 'more' ? cols > than : cols < than;
        },
        { id: sessionId, compare, than },
        { timeout: STEP_MS },
      );

    await dragLineTo(AGENTS, line - 240);
    await fitCols('more', before);
    await waitDriving();
    const wide = await terminalCols();
    expect(wide).toBeGreaterThan(before + 20);
    // Both panes are laid out inside their own boxes: Monaco ends left of the line, the terminal lies right of it.
    await page.waitForFunction((limit) => (document.querySelector('.editor-doc__monaco .monaco-editor')?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY) <= limit, line - 240, { timeout: STEP_MS });
    const terminal = await terminalOf(page, sessionId).evaluate((node) => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
    expect(terminal.left).toBeGreaterThanOrEqual(line - 240 + 1);
    expect(terminal.right).toBeLessThanOrEqual(WIDTH);

    await dragLineTo(AGENTS, line);
    await fitCols('fewer', wide);
    await waitDriving();
    expect(await terminalCols()).toBe(before);
  }, 180_000);

  it('arrow keys on the focused separator resize, a double click comes back to the default width, and this browser remembers the width across a reload', async () => {
    const separator = page.locator(AGENTS.selector);
    expect(await separator.getAttribute('role')).toBe('separator');
    expect(await separator.getAttribute('aria-orientation')).toBe('vertical');
    const stored = (): Promise<string | null> => page.evaluate(() => window.localStorage.getItem('smurg.pane.right'));
    const valueNow = async (): Promise<number> => Number(await separator.getAttribute('aria-valuenow'));

    const line = await lineOf(AGENTS);
    const width = await valueNow();
    expect(width).toBe(WIDTH - line - 1);
    expect(Number(await separator.getAttribute('aria-valuemin'))).toBeLessThan(width);
    expect(Number(await separator.getAttribute('aria-valuemax'))).toBeGreaterThan(width);
    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    await frames();
    expect(await lineOf(AGENTS)).toBe(line - 16);
    expect(await valueNow()).toBe(width + 16);
    await page.keyboard.press('Shift+ArrowRight');
    await frames();
    expect(await lineOf(AGENTS)).toBe(line - 16 + 64);
    expect(await stored()).toBe(String(width + 16 - 64));

    // A drag, then a double click on the line: the default width again.
    await dragLineTo(AGENTS, line - 137);
    expect(await stored()).toBe(String(width + 137));
    const cross = await crossOf(AGENTS);
    await page.mouse.dblclick(line - 137 + 2, cross);
    await frames();
    expect(await valueNow()).toBe(AGENTS_DEFAULT_PX);
    expect(await lineOf(AGENTS)).toBe(WIDTH - AGENTS_DEFAULT_PX - 1);
    expect(await stored()).toBe(String(AGENTS_DEFAULT_PX));

    // Remembered: the same width after the page is loaded again.
    await dragLineTo(AGENTS, WIDTH - 555 - 1);
    expect(await stored()).toBe('555');
    await page.reload();
    await workspaceOnline(page);
    await page.locator(AGENTS.selector).waitFor({ timeout: STEP_MS });
    expect(await lineOf(AGENTS)).toBe(WIDTH - 555 - 1);
    await expectStillUnderHover(AGENTS, 'after a reload');
  }, 180_000);

  it('a window too small for the remembered width: the editor keeps its minimum, nothing is pushed out of the window, and the divider still follows the pointer', async () => {
    // The agents column remembers 900 px; the window then gets 1000 px wide.
    await dragLineTo(AGENTS, WIDTH - 900 - 1);
    expect(await lineOf(AGENTS)).toBe(WIDTH - 900 - 1);
    await page.setViewportSize({ width: 1000, height: 700 });
    await frames();
    const line = await lineOf(AGENTS);
    expect(line, 'the editor keeps its minimum width').toBe((await lineOf(FILES)) + 1 + MIN_EDITOR_PX);
    const panel = await page.locator('.agents-panel').first().evaluate((node) => node.getBoundingClientRect().right);
    expect(panel, 'the agents panel ends inside the window').toBeLessThanOrEqual(1000);
    // Grabbed where it is shown; it follows from there.
    const cross = await crossOf(AGENTS);
    await page.mouse.move(line + 2, cross);
    await page.mouse.down();
    await frames();
    expect(await lineOf(AGENTS)).toBe(line);
    await page.mouse.move(line + 2 + 100, cross, { steps: 5 });
    await frames();
    expect(await lineOf(AGENTS)).toBe(line + 100);
    await page.mouse.up();
    await expectStillUnderHover(AGENTS, 'in the small window');
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    expect(env.problemsOf(page).pageErrors).toEqual([]);
  }, 180_000);
});
