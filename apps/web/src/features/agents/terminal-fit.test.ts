// The owner's PTY size: columns AND rows fitted to the panel, a floor for Claude Code, scrollbars
// accounted for, the daemon's clamp; and what is sent when (debounced, never the rendered size, never twice while
// the daemon's answer is on its way).
import { describe, expect, it } from 'vitest';
import { OWNER_SIZE_FLOOR, OwnerResizer, PTY_SIZE_MIN, RESIZE_DEBOUNCE_MS, RESIZE_ECHO_WAIT_MS, planOwnerSize, type TerminalGeometry, type TerminalSize } from './terminal-fit.ts';

/** A common setup: 13 px font, 7.825 × 18 px cells, 4 px padding, xterm's 14 px scrollbar reserve. */
function panel(width: number, height: number, cell = { width: 7.825, height: 18 }): TerminalGeometry {
  return { width, height, cellWidth: cell.width, cellHeight: cell.height, paddingX: 8, paddingY: 8, reserveX: 14, scrollbar: 12 };
}

describe('planOwnerSize: the PTY follows the owner panel, columns and rows', () => {
  it('a 420 px panel gets the columns it can show (a shell), not 80 columns clipped at the panel edge', () => {
    const plan = planOwnerSize(panel(420, 520), OWNER_SIZE_FLOOR.terminal);
    // (420 − 8 − 14) / 7.825 = 50.9 → 50 columns; (520 − 8) / 18 = 28.4 → 28 rows.
    expect(plan).toEqual({ cols: 50, rows: 28, fitCols: 50, fitRows: 28, narrow: false, short: false });
    // The terminal (padding + 50 cells) fits inside the panel with the reserve to spare.
    expect(8 + 50 * 7.825).toBeLessThanOrEqual(420 - 14);
    expect(8 + 51 * 7.825).toBeGreaterThan(420 - 14);
  });

  it('a wide panel gets a wide PTY; every pixel size maps to the largest cell count that fits', () => {
    expect(planOwnerSize(panel(1100, 800), OWNER_SIZE_FLOOR.agent)).toMatchObject({ cols: 137, rows: 44, narrow: false, short: false });
    for (let width = 200; width <= 1200; width += 37) {
      const plan = planOwnerSize(panel(width, 600), OWNER_SIZE_FLOOR.terminal)!;
      if (plan.narrow) continue;
      expect(8 + 14 + plan.cols * 7.825).toBeLessThanOrEqual(width);
      expect(8 + 14 + (plan.cols + 1) * 7.825).toBeGreaterThan(width);
    }
  });

  it("Claude Code's floor (80 × 24, pty-packaging.md F16/F17): a narrower panel keeps 80 columns, says so, and loses a row to the horizontal scrollbar", () => {
    const plan = planOwnerSize(panel(420, 520), OWNER_SIZE_FLOOR.agent);
    // 28 rows would fit without the scrollbar: (520 − 12 − 8) / 18 = 27.7 → 27 with it.
    expect(plan).toEqual({ cols: 80, rows: 27, fitCols: 50, fitRows: 27, narrow: true, short: false });
  });

  it('a short panel keeps 24 rows and loses a column to the vertical scrollbar; both floors at once', () => {
    expect(planOwnerSize(panel(900, 300), OWNER_SIZE_FLOOR.agent)).toEqual({ cols: 110, rows: 24, fitCols: 110, fitRows: 16, narrow: false, short: true });
    // (900 − 12 − 8 − 14) / 7.825 = 110.6 → 110 (without the scrollbar it would be 112).
    expect(planOwnerSize(panel(900, 800), OWNER_SIZE_FLOOR.agent)?.cols).toBe(112);
    expect(planOwnerSize(panel(300, 200), OWNER_SIZE_FLOOR.agent)).toMatchObject({ cols: 80, rows: 24, narrow: true, short: true });
  });

  it('the floors: Claude Code 80 × 24 (agent), the daemon clamp 20 × 5 (terminal); the ceiling 500 × 200', () => {
    expect(OWNER_SIZE_FLOOR).toEqual({ agent: { cols: 80, rows: 24 }, terminal: { cols: 20, rows: 5 } });
    expect(PTY_SIZE_MIN).toEqual({ cols: 20, rows: 5 });
    expect(planOwnerSize(panel(60, 40), OWNER_SIZE_FLOOR.terminal)).toMatchObject({ cols: 20, rows: 5, narrow: true, short: true });
    expect(planOwnerSize(panel(9000, 9000), OWNER_SIZE_FLOOR.terminal)).toMatchObject({ cols: 500, rows: 200 });
    // A floor below the daemon's clamp is raised to it.
    expect(planOwnerSize(panel(60, 40), { cols: 1, rows: 1 })).toMatchObject({ cols: 20, rows: 5 });
  });

  it('nothing to measure (a hidden panel, a terminal not rendered yet): no plan', () => {
    expect(planOwnerSize(panel(0, 500), OWNER_SIZE_FLOOR.agent)).toBeNull();
    expect(planOwnerSize(panel(500, 0), OWNER_SIZE_FLOOR.agent)).toBeNull();
    expect(planOwnerSize(panel(500, 500, { width: 0, height: 18 }), OWNER_SIZE_FLOOR.agent)).toBeNull();
  });
});

describe('OwnerResizer: what the owner sends as exec.resize', () => {
  function harness(initial: { measured: TerminalSize | null; current: TerminalSize | null }) {
    const state = { ...initial, ready: true, now: 0 };
    const sent: TerminalSize[] = [];
    const timers: { run: () => void; at: number; cleared: boolean }[] = [];
    const resizer = new OwnerResizer({
      measure: () => state.measured,
      current: () => state.current,
      send: (size) => sent.push(size),
      ready: () => state.ready,
      now: () => state.now,
      setTimer: (run, ms) => {
        const timer = { run, at: state.now + ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    });
    const advance = (ms: number): void => {
      state.now += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cleared) continue;
        if (timer.at <= state.now) timer.run();
        else timers.push(timer);
      }
    };
    return { state, sent, resizer, advance };
  }

  it('debounced: a burst of observations (dragging a separator) sends the final size once', () => {
    const { state, sent, resizer, advance } = harness({ measured: { cols: 50, rows: 28 }, current: { cols: 80, rows: 28 } });
    for (let i = 0; i < 10; i++) {
      state.measured = { cols: 50 + i, rows: 28 };
      resizer.schedule();
      advance(RESIZE_DEBOUNCE_MS - 10);
    }
    expect(sent).toEqual([]);
    advance(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([{ cols: 59, rows: 28 }]);
  });

  it('never sends the size the terminal already renders; never the same size twice while the answer is on its way', () => {
    const { state, sent, resizer } = harness({ measured: { cols: 80, rows: 28 }, current: { cols: 80, rows: 28 } });
    expect(resizer.flush()).toBeNull();
    state.measured = { cols: 120, rows: 40 };
    expect(resizer.flush()).toEqual({ cols: 120, rows: 40 });
    // The daemon has not answered yet: the same size is not sent again…
    state.now += RESIZE_ECHO_WAIT_MS - 1;
    expect(resizer.flush()).toBeNull();
    // …unless it never came (another window of the owner took over meanwhile).
    state.now += 2;
    expect(resizer.flush()).toEqual({ cols: 120, rows: 40 });
    // The answer arrived: the terminal renders it, nothing more to send.
    state.current = { cols: 120, rows: 40 };
    state.now += RESIZE_ECHO_WAIT_MS * 3;
    expect(resizer.flush()).toBeNull();
    expect(sent).toEqual([{ cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);
  });

  it('the size sent with session.attach counts as sent; nothing is sent while not ready or unmeasurable', () => {
    const { state, sent, resizer } = harness({ measured: { cols: 100, rows: 30 }, current: { cols: 80, rows: 24 } });
    resizer.sentWithAttach({ cols: 100, rows: 30 });
    expect(resizer.flush()).toBeNull();
    state.now += RESIZE_ECHO_WAIT_MS + 1;
    state.ready = false;
    expect(resizer.flush()).toBeNull();
    state.ready = true;
    state.measured = null;
    expect(resizer.flush()).toBeNull();
    expect(sent).toEqual([]);
  });

  it('a disposed resizer sends nothing, even from a pending timer', () => {
    const { sent, resizer, advance } = harness({ measured: { cols: 50, rows: 20 }, current: { cols: 80, rows: 24 } });
    resizer.schedule();
    resizer.dispose();
    advance(RESIZE_DEBOUNCE_MS * 2);
    expect(resizer.flush()).toBeNull();
    expect(sent).toEqual([]);
  });
});
