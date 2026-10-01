// How big the OWNER's terminal should be (review LEAD-01, pty-packaging.md §1 "Resize policy `owner`", F16–F18): the
// PTY follows the owner's panel — columns AND rows fitted to the visible area — but never below a floor that the
// program in it needs. Below the floor the terminal keeps the floor, the panel scrolls (both scrollbars visible) and a
// hint says so: it is never clipped silently. Pure, so it is tested without a browser.
//
// Floors (the research's verified sizes):
//  - agent sessions run Claude Code, whose TUI was captured and verified at 80 × 24 (pty-packaging.md F16, F17:
//    first-run TUI and main REPL rendered correctly at 80 × 24 after a resize from 100 × 30); below that its Ink layout
//    wraps its own boxes;
//  - a plain terminal is a shell, which re-flows itself: only the daemon's own clamp applies (20 × 5).
// The ceiling is the daemon's clamp (500 × 200, packages/daemon/src/sessions/pty-session.ts clampSize).
import type { SessionKind } from '@smurg/protocol';

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * What the owner's panel offers, in CSS pixels. `width` / `height`: the scroll container's box WITHOUT scrollbars
 * (they are added below when the plan needs them); `cellWidth` / `cellHeight`: one character cell of the rendered
 * terminal; `paddingX` / `paddingY`: the terminal element's own padding (both sides together); `reserveX`: room the
 * terminal keeps right of the text for its own scrollback scrollbar; `scrollbar`: the thickness of the container's
 * scrollbars.
 */
export interface TerminalGeometry {
  readonly width: number;
  readonly height: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly paddingX: number;
  readonly paddingY: number;
  readonly reserveX: number;
  readonly scrollbar: number;
}

export const PTY_SIZE_MIN: TerminalSize = Object.freeze({ cols: 20, rows: 5 });
export const PTY_SIZE_MAX: TerminalSize = Object.freeze({ cols: 500, rows: 200 });

export const OWNER_SIZE_FLOOR: Readonly<Record<SessionKind, TerminalSize>> = Object.freeze({
  agent: Object.freeze({ cols: 80, rows: 24 }),
  terminal: PTY_SIZE_MIN,
});

export interface OwnerSizePlan extends TerminalSize {
  /** What the panel fits (before the floor). */
  readonly fitCols: number;
  readonly fitRows: number;
  /** The floor made the terminal wider / taller than the panel: it scrolls that way, and the hint is shown. */
  readonly narrow: boolean;
  readonly short: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The PTY size the owner's panel proposes. A scrollbar needed on one axis takes room from the other one, so the fit is
 * computed again with it. Null when nothing can be measured (a hidden panel, a terminal not rendered yet).
 */
export function planOwnerSize(geometry: TerminalGeometry, floor: TerminalSize): OwnerSizePlan | null {
  const { width, height, cellWidth, cellHeight, paddingX, paddingY, reserveX, scrollbar } = geometry;
  if (!(width > 0 && height > 0 && cellWidth > 0 && cellHeight > 0)) return null;
  const colsIn = (w: number): number => Math.floor((w - paddingX - reserveX) / cellWidth);
  const rowsIn = (h: number): number => Math.floor((h - paddingY) / cellHeight);
  const minCols = clamp(floor.cols, PTY_SIZE_MIN.cols, PTY_SIZE_MAX.cols);
  const minRows = clamp(floor.rows, PTY_SIZE_MIN.rows, PTY_SIZE_MAX.rows);
  let fitCols = colsIn(width);
  let fitRows = rowsIn(height);
  let narrow = fitCols < minCols;
  let short = fitRows < minRows;
  if (narrow) {
    fitRows = rowsIn(height - scrollbar);
    short = fitRows < minRows;
  }
  if (short) {
    fitCols = colsIn(width - scrollbar);
    narrow = fitCols < minCols;
    if (narrow) fitRows = rowsIn(height - scrollbar);
  }
  return {
    cols: clamp(Math.max(fitCols, minCols), PTY_SIZE_MIN.cols, PTY_SIZE_MAX.cols),
    rows: clamp(Math.max(fitRows, minRows), PTY_SIZE_MIN.rows, PTY_SIZE_MAX.rows),
    fitCols: Math.max(0, fitCols),
    fitRows: Math.max(0, fitRows),
    narrow,
    short,
  };
}

export function sameSize(a: TerminalSize | null | undefined, b: TerminalSize | null | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

/** How long a sent size may stay unanswered before the same size is sent again (another window took over meanwhile). */
export const RESIZE_ECHO_WAIT_MS = 1_000;
/** The owner's window settles before its size is proposed (dragging a separator fires dozens of observations). */
export const RESIZE_DEBOUNCE_MS = 150;

export interface OwnerResizerDeps {
  /** What the owner's panel proposes now; null while it cannot be measured. */
  measure(): TerminalSize | null;
  /** The PTY size the terminal renders now (the daemon's last exec.resize / attach answer). */
  current(): TerminalSize | null;
  /** exec.resize. */
  send(size: TerminalSize): void;
  /** Whether sending makes sense now (the feed is live, the session runs, the panel is shown). */
  ready(): boolean;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * Sends the owner's panel size as exec.resize, debounced, in answer to anything that can change it (the panel is
 * resized, the drawer or a pane is toggled, a font finished loading, the browser tab became visible again). The
 * daemon answers with exec.resize in stream order (to every viewer, this one included), which the terminal applies
 * between the right bytes (F18) — so the rendered size, not the size sent, is what counts as current. A size equal to
 * the rendered one is never sent; a size already sent is not sent again while its answer is on the way.
 */
export class OwnerResizer {
  private readonly deps: OwnerResizerDeps;
  private timer: unknown = null;
  private lastSent: TerminalSize | null = null;
  private lastSentAt = 0;
  private disposed = false;

  constructor(deps: OwnerResizerDeps) {
    this.deps = deps;
  }

  /** Something may have changed the panel's size: check once things settled. */
  schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.flush();
    }, RESIZE_DEBOUNCE_MS);
  }

  /** Checks now; returns the size sent, if any. */
  flush(): TerminalSize | null {
    if (this.disposed || !this.deps.ready()) return null;
    const next = this.deps.measure();
    if (!next) return null;
    if (sameSize(next, this.deps.current())) {
      this.lastSent = null;
      return null;
    }
    if (sameSize(next, this.lastSent) && this.deps.now() - this.lastSentAt < RESIZE_ECHO_WAIT_MS) return null;
    this.lastSent = next;
    this.lastSentAt = this.deps.now();
    this.deps.send(next);
    return next;
  }

  /** The size went out with session.attach (it counts as sent). */
  sentWithAttach(size: TerminalSize | null): void {
    if (!size) return;
    this.lastSent = size;
    this.lastSentAt = this.deps.now();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
