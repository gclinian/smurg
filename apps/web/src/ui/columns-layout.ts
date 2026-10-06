// The arithmetic of the column strip (Columns.tsx), free of the DOM. A strip shows up to a few columns side by side
// with a 1 px separator between two; a column is never narrower than `min`.
//
// A column has a WEIGHT, in multiples of an equal share (1: as wide as the others). Two regimes:
//   - the columns fit (each could have `min`): they share the strip's width in proportion to their weights, and a
//     separator trades width between its two neighbours;
//   - they do not fit: the strip shows whole columns and scrolls sideways. A column of weight 1 is exactly as wide as
//     one of the `fits` columns that fill the view; a separator changes the column before it and the rest move along.
// Widths are whole pixels and, when the columns fit, add up to the strip exactly.

export const COLUMN_MIN_PX = 320;
export const COLUMN_SEPARATOR_PX = 1;

export interface StripMetrics {
  /** The strip's inner width. */
  readonly available: number;
  readonly min?: number;
  readonly separator?: number;
}

export interface StripLayout {
  /** One width per column, in px. */
  readonly widths: readonly number[];
  /** How many whole columns of at least `min` fit the strip (at least 1). */
  readonly fits: number;
  /** More columns than fit: the strip scrolls sideways. */
  readonly overflow: boolean;
  /** The width of one equal share: what weight 1 means in px. */
  readonly unit: number;
}

/** How many whole columns of at least `min` fit `available` px (at least 1: one column is always shown). */
export function columnsThatFit({ available, min = COLUMN_MIN_PX, separator = COLUMN_SEPARATOR_PX }: StripMetrics): number {
  if (!Number.isFinite(available) || available <= 0) return 1;
  return Math.max(1, Math.floor((available + separator) / (min + separator)));
}

const safeWeight = (weight: number): number => (Number.isFinite(weight) && weight > 0 ? weight : 1);
/**
 * Weights are widths divided by a share, so a share computed back from them can miss a whole pixel by a rounding
 * error of the division (429.99999999999994 for 430): a width within this of the next pixel is that pixel.
 */
const EPSILON = 1e-6;

/** Shares `room` px among the weights, nobody below `min`, in whole pixels that add up to `room`. */
function distribute(room: number, weights: readonly number[], min: number): number[] {
  const count = weights.length;
  const widths = new Array<number>(count).fill(0);
  const fixed = new Array<boolean>(count).fill(false);
  // Columns that would fall below the minimum get exactly the minimum; the others share what is left. Repeats until
  // nobody else falls below (at most `count` rounds).
  for (let round = 0; round < count; round += 1) {
    let free = room;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      if (fixed[i]) free -= min;
      else total += weights[i] as number;
    }
    let changed = false;
    for (let i = 0; i < count; i += 1) {
      if (fixed[i]) {
        widths[i] = min;
        continue;
      }
      const share = total > 0 ? (free * (weights[i] as number)) / total : 0;
      if (share < min - EPSILON) {
        fixed[i] = true;
        changed = true;
      }
      widths[i] = share;
    }
    if (!changed) break;
  }
  // Whole pixels: round down, then hand the leftover pixels out from the left, to the columns that are above the
  // minimum (a column held at the minimum stays exactly there); to all of them when every column is at it.
  const floored = widths.map((width) => Math.max(min, Math.floor(width + EPSILON)));
  let leftover = Math.round(room - floored.reduce((sum, width) => sum + width, 0));
  const takers = fixed.some((isFixed) => !isFixed) ? floored.map((_, index) => index).filter((index) => !fixed[index]) : floored.map((_, index) => index);
  for (let turn = 0; leftover > 0 && takers.length > 0; turn += 1, leftover -= 1) {
    const index = takers[turn % takers.length] as number;
    floored[index] = (floored[index] as number) + 1;
  }
  return floored;
}

/** The width of every column for a strip of `available` px. */
export function layoutStrip(weights: readonly number[], metrics: StripMetrics): StripLayout {
  const min = metrics.min ?? COLUMN_MIN_PX;
  const separator = metrics.separator ?? COLUMN_SEPARATOR_PX;
  const fits = columnsThatFit(metrics);
  const count = weights.length;
  const safe = weights.map(safeWeight);
  if (count === 0) return { widths: [], fits, overflow: false, unit: Math.max(min, metrics.available) };
  if (count <= fits) {
    const room = Math.max(count * min, Math.floor(metrics.available) - (count - 1) * separator);
    return { widths: distribute(room, safe, min), fits, overflow: false, unit: room / count };
  }
  const unit = Math.max(min, (Math.floor(metrics.available) - (fits - 1) * separator) / fits);
  return { widths: safe.map((weight) => Math.max(min, Math.round(unit * weight))), fits, overflow: true, unit };
}

/**
 * The widths after the separator behind column `index` moved by `delta` px (right is positive). While the columns
 * fit, the two neighbours trade width and neither goes below `min`; while the strip overflows, only the column
 * before the separator changes (between `min` and `max`).
 */
export function resizeStrip(widths: readonly number[], index: number, delta: number, options: { readonly overflow: boolean; readonly min?: number; readonly max?: number }): number[] {
  const min = options.min ?? COLUMN_MIN_PX;
  const next = [...widths];
  const before = next[index];
  if (before === undefined || !Number.isFinite(delta)) return next;
  if (options.overflow) {
    next[index] = Math.round(Math.min(options.max ?? Number.POSITIVE_INFINITY, Math.max(min, before + delta)));
    return next;
  }
  const after = next[index + 1];
  if (after === undefined) return next;
  const moved = Math.round(Math.min(Math.max(delta, min - before), after - min));
  next[index] = before + moved;
  next[index + 1] = after - moved;
  return next;
}

/** The weights that give `widths` back in the same layout (the inverse of layoutStrip for both regimes). */
export function weightsFromWidths(widths: readonly number[], layout: Pick<StripLayout, 'unit'>): number[] {
  const unit = layout.unit > 0 ? layout.unit : 1;
  return widths.map((width) => width / unit);
}

export interface StripView {
  /** Columns out of view on the left / on the right (more than half of the column is cut off). */
  readonly before: number;
  readonly after: number;
  /** Per column: enough of it is on screen to read it. */
  readonly visible: readonly boolean[];
  /** The left edge of every column inside the strip's scrolled content. */
  readonly offsets: readonly number[];
}

/** What of the strip is on screen at `scrollLeft` in a viewport of `viewport` px. */
export function viewStrip(widths: readonly number[], scrollLeft: number, viewport: number, separator = COLUMN_SEPARATOR_PX): StripView {
  const offsets: number[] = [];
  let x = 0;
  for (const width of widths) {
    offsets.push(x);
    x += width + separator;
  }
  const visible = widths.map((width, index) => {
    const start = offsets[index] as number;
    const shown = Math.min(start + width, scrollLeft + viewport) - Math.max(start, scrollLeft);
    return shown >= width / 2;
  });
  const first = visible.indexOf(true);
  const last = visible.lastIndexOf(true);
  return {
    before: first === -1 ? 0 : first,
    after: last === -1 ? 0 : widths.length - 1 - last,
    visible,
    offsets,
  };
}
