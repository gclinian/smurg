// The arithmetic of a split pane's separator (SplitPane.tsx), free of the DOM: what size the fixed pane gets from a
// pointer position, a key or a stored value, and when a drag is over. One axis: `start` / `size` are left / width for
// panes side by side and top / height for stacked panes.

export type SplitOrientation = 'horizontal' | 'vertical';
/** Which pane has the size; the other one takes the rest. */
export type SplitFixed = 'start' | 'end';

export interface SplitLimits {
  readonly min: number;
  readonly max: number;
}

/** Where the split is on screen, along its axis. */
export interface SplitGeometry {
  readonly containerStart: number;
  readonly containerSize: number;
  /** The separator's own thickness (the 1 px line; its wider grab area is not layout). */
  readonly separatorSize: number;
}

export interface SplitLimitOptions {
  readonly minSize: number;
  readonly maxSize: number;
  /** The least the other pane keeps. */
  readonly minOther: number;
  /** The container's size along the axis, or null while it is not laid out (hidden, not mounted). */
  readonly containerSize: number | null;
  readonly separatorSize: number;
}

/**
 * The sizes the fixed pane may have: [minSize, maxSize], and never so big that the other pane keeps less than
 * `minOther` of a container whose size is known. `minSize` wins when the container is too small for both.
 */
export function splitLimits({ minSize, maxSize, minOther, containerSize, separatorSize }: SplitLimitOptions): SplitLimits {
  const min = Math.max(0, Math.round(minSize));
  const room = containerSize !== null && containerSize > 0 ? Math.floor(containerSize - separatorSize - minOther) : Number.POSITIVE_INFINITY;
  return { min, max: Math.max(min, Math.min(Math.round(maxSize), room)) };
}

/** A whole number of pixels inside the limits (anything that is not a finite number: the minimum). */
export function clampSize(value: number, limits: SplitLimits): number {
  if (!Number.isFinite(value)) return limits.min;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

/** Where a split pane remembers its size in this browser (`storageKey` of SplitPane): `smurg.pane.<key>`. */
export function paneStorageKey(storageKey: string): string {
  return `smurg.pane.${storageKey}`;
}

/** A size read back from storage: a finite number, or null (missing, corrupt, another type). */
export function storedSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Where the pointer holds the separator: its distance from the separator's leading edge when the button went down. */
export function grabOffset(pointer: number, separatorStart: number): number {
  return pointer - separatorStart;
}

/**
 * The fixed pane's size that keeps the separator under the pointer exactly where it was grabbed: the separator's
 * leading edge is at `pointer - grab`, measured inside the container's own box. Not clamped.
 */
export function sizeFromPointer(pointer: number, grab: number, geometry: SplitGeometry, fixed: SplitFixed): number {
  const separatorStart = pointer - grab;
  return fixed === 'start' ? separatorStart - geometry.containerStart : geometry.containerStart + geometry.containerSize - (separatorStart + geometry.separatorSize);
}

/** The fixed pane's size as it is on screen: what a separator at `separatorStart` leaves it. */
export function sizeFromSeparator(separatorStart: number, geometry: SplitGeometry, fixed: SplitFixed): number {
  return sizeFromPointer(separatorStart, 0, geometry, fixed);
}

export const KEY_STEP = 16;
export const KEY_BIG_STEP = 64;

export interface SplitKeyOptions {
  readonly orientation: SplitOrientation;
  readonly fixed: SplitFixed;
  readonly shiftKey: boolean;
  readonly size: number;
  readonly limits: SplitLimits;
}

/**
 * The size after a key on the focused separator, or null for a key that is not the separator's. Arrows follow the
 * screen (the separator moves the way the arrow points; Shift for a bigger step), Home / End jump to the limits.
 */
export function sizeFromKey(key: string, { orientation, fixed, shiftKey, size, limits }: SplitKeyOptions): number | null {
  const step = shiftKey ? KEY_BIG_STEP : KEY_STEP;
  const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  // The separator moving forward (right / down) grows a pane fixed at the start and shrinks one fixed at the end.
  const direction = fixed === 'start' ? 1 : -1;
  if (key === forward) return clampSize(size + direction * step, limits);
  if (key === backward) return clampSize(size - direction * step, limits);
  if (key === 'Home') return limits.min;
  if (key === 'End') return limits.max;
  return null;
}

/** The primary button (left mouse button, touch contact, pen tip) is down in a pointer event's `buttons`. */
export function primaryPressed(buttons: number): boolean {
  return (buttons & 1) === 1;
}

/**
 * What a pointer move means for a drag of pointer `dragPointerId`:
 *  - 'ignore': another pointer;
 *  - 'end': the primary button is no longer down. The release never arrived (the browser dropped the pointer capture
 *    for a context menu, a second button, a window that took the focus): the drag is over and NOTHING moves;
 *  - 'move': the separator follows.
 */
export function dragMove(dragPointerId: number, event: { readonly pointerId: number; readonly buttons: number }): 'ignore' | 'end' | 'move' {
  if (event.pointerId !== dragPointerId) return 'ignore';
  return primaryPressed(event.buttons) ? 'move' : 'end';
}
