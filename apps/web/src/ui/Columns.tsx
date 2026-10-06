import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { cx } from './cx.ts';
import { COLUMN_MIN_PX, COLUMN_SEPARATOR_PX, layoutStrip, resizeStrip, viewStrip, weightsFromWidths, type StripLayout } from './columns-layout.ts';
import { IconChevronLeft, IconChevronRight } from './icons.tsx';
import { KEY_BIG_STEP, KEY_STEP, dragMove } from './split-resize.ts';

export interface ColumnsItem {
  readonly id: string;
  /** Its share of the strip in multiples of an equal share (1: as wide as the others). */
  readonly weight: number;
  /** The column's name, for the separator behind it ("1 · Cart API"). */
  readonly label: string;
  readonly node: ReactNode;
}

export interface ColumnsProps {
  columns: readonly ColumnsItem[];
  /** New weights, one per column in order: a separator was dragged or moved with the keys. */
  onWeights(weights: number[]): void;
  /** A double click on a separator: every column as wide as the others. */
  onEqualize(): void;
  /** How many whole columns fit the strip changed (told once it is measured, and on every change). */
  onCapacity?(columns: number): void;
  /** Which columns are on screen changed (the others are scrolled out of the strip). */
  onVisible?(ids: readonly string[]): void;
  /** The accessible name of a separator: "Drag or use the arrow keys to resize 1 · Cart API". */
  separatorLabel(column: string): string;
  /** The edge button over columns that are out of view: "2 more". */
  moreLabel(count: number, side: 'left' | 'right'): string;
  /** Bring this column into view; a new `token` asks again for the same column. */
  reveal?: { readonly id: string; readonly token: number } | null;
  /**
   * The column the person is at (the focused one). It is in view when the strip is first laid out: a view that comes
   * back (a reload, a restored tab, a strip whose mode was hidden until now) has no request that says so.
   */
  current?: string | null;
  /** No column is narrower than this (default 320 px). */
  minWidth?: number;
  /** Shown instead of the strip while there is no column. */
  empty?: ReactNode;
  className?: string;
  /** The DOM id of the strip (the skip link's target). */
  id?: string;
}

interface ActiveDrag {
  flush(): void;
  stop(): void;
  readonly startWidths: readonly number[];
}

/**
 * A strip of columns side by side with a draggable separator between two (columns-layout.ts has the arithmetic).
 * Columns that do not fit are reached sideways: the strip snaps to whole columns and an edge button says how many
 * are out of view. A separator is a focusable window splitter: arrow keys move it (Shift for bigger steps), Home and
 * End go to the limits, a double click makes every column equal.
 *
 * Where the strip cannot be measured (not laid out yet, a test without a layout engine) the columns share it by
 * their weights through CSS alone and every column counts as on screen.
 */
export function Columns({ columns, onWeights, onEqualize, onCapacity, onVisible, separatorLabel, moreLabel, reveal, current, minWidth = COLUMN_MIN_PX, empty, className, id }: ColumnsProps) {
  const strip = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  /** Widths while a separator is being dragged (the store learns the result at the end). */
  const [dragWidths, setDragWidths] = useState<readonly number[] | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const drag = useRef<ActiveDrag | null>(null);

  const weights = columns.map((column) => column.weight);
  const layout: StripLayout | null = available === null ? null : layoutStrip(weights, { available, min: minWidth, separator: COLUMN_SEPARATOR_PX });
  const widths = dragWidths !== null && dragWidths.length === columns.length ? dragWidths : (layout?.widths ?? null);
  // A strip that does not overflow cannot be scrolled, whatever was last heard from a scroll event.
  const overflowing = layout?.overflow === true;
  const view = widths === null || available === null ? null : viewStrip(widths, overflowing ? scrollLeft : 0, available);

  // The browser clamps (or resets) the scroll position when the content gets narrower: a column was closed, the
  // window grew, the left column was folded away. No scroll event tells; read it back after every change of layout.
  const widthsKey = widths === null ? '' : widths.join(',');
  useLayoutEffect(() => {
    const node = strip.current;
    if (node) setScrollLeft(node.scrollLeft);
  }, [available, widthsKey, overflowing]);

  // The strip's own box follows the window and the left column, never its columns: observing it cannot feed back.
  useLayoutEffect(() => {
    const node = strip.current;
    if (!node) return;
    // A strip that is hidden (its view is the other mode) reports no width: it keeps the layout it had, so nothing
    // jumps for a frame when it is shown again.
    const observed = (value: number): void => {
      if (value > 0) setAvailable(Math.floor(value));
    };
    observed(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') {
      const read = (): void => observed(node.clientWidth);
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const observer = new ResizeObserver(() => observed(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [columns.length === 0]);

  const fits = layout?.fits ?? null;
  const capacityCallback = useRef(onCapacity);
  capacityCallback.current = onCapacity;
  useEffect(() => {
    if (fits !== null) capacityCallback.current?.(fits);
  }, [fits]);

  const visibleIds = columns.filter((_, index) => view === null || view.visible[index] !== false).map((column) => column.id);
  const visibleKey = visibleIds.join('\n');
  const visibleCallback = useRef(onVisible);
  visibleCallback.current = onVisible;
  useEffect(() => {
    visibleCallback.current?.(visibleKey === '' ? [] : visibleKey.split('\n'));
  }, [visibleKey]);

  const scrollToColumn = useCallback(
    (index: number): void => {
      const node = strip.current;
      const offsets = view?.offsets;
      if (!node || !offsets) return;
      const left = offsets[Math.max(0, Math.min(offsets.length - 1, index))] ?? 0;
      if (typeof node.scrollTo === 'function') node.scrollTo({ left, behavior: 'auto' });
      else node.scrollLeft = left;
    },
    [view?.offsets],
  );

  // A column that was asked for (opened, focused from the list) comes into view.
  const revealToken = reveal?.token;
  const revealId = reveal?.id;
  useEffect(() => {
    if (revealId === undefined || view === null) return;
    const index = columns.findIndex((column) => column.id === revealId);
    if (index !== -1 && view.visible[index] === false) scrollToColumn(index);
    // Only when asked: a scroll by hand must not be undone by the next render.
  }, [revealToken, revealId]);

  // A strip that is measured for the first time starts at its left edge, and a request made before that found
  // nothing to scroll: the current column comes into view then, once. Afterwards only a request scrolls.
  const measured = view !== null;
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!measured || placed.current) return;
    placed.current = true;
    const index = columns.findIndex((column) => column.id === current);
    if (index !== -1 && view?.visible[index] === false) scrollToColumn(index);
  }, [measured]);

  /** The widths the drag last put on screen (state may still be pending when the drag ends). */
  const dragged = useRef<readonly number[] | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const weightsCallback = useRef(onWeights);
  weightsCallback.current = onWeights;

  /** 'keep': the widths the pointer chose, its last move included; 'revert': as before the drag; 'unmount': quietly. */
  const endDrag = (outcome: 'keep' | 'revert' | 'unmount'): void => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (outcome === 'keep') active.flush();
    active.stop();
    const result = dragged.current;
    dragged.current = null;
    if (outcome === 'unmount') return;
    const measured = layoutRef.current;
    if (outcome === 'keep' && result !== null && measured !== null && result.some((width, i) => width !== active.startWidths[i])) {
      weightsCallback.current(weightsFromWidths(result, measured));
    }
    setDraggingIndex(null);
    setDragWidths(null);
  };
  useEffect(() => () => endDrag('unmount'), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number): void => {
    if (event.button !== 0 || layout === null || widths === null) return;
    endDrag('keep');
    // No text selection, no focus change (a composer keeps the keyboard), no native drag.
    event.preventDefault();
    const node = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidths = [...widths];
    const overflow = layout.overflow;
    const max = Math.max(minWidth, (available ?? minWidth) - COLUMN_SEPARATOR_PX);
    let applied: readonly number[] = startWidths;
    const apply = (x: number): void => {
      const next = resizeStrip(startWidths, index, x - startX, { overflow, min: minWidth, max });
      if (next.every((width, i) => width === applied[i])) return;
      applied = next;
      dragged.current = next;
      // In this frame: the line is under the pointer when the frame is painted.
      flushSync(() => setDragWidths(next));
    };
    let pending: number | null = null;
    let frame: number | null = null;
    const flush = (): void => {
      frame = null;
      if (pending === null) return;
      const x = pending;
      pending = null;
      apply(x);
    };
    const onMove = (e: PointerEvent): void => {
      const what = dragMove(pointerId, e);
      if (what === 'ignore') return;
      if (what === 'end') {
        endDrag('keep');
        return;
      }
      pending = e.clientX;
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      pending = e.clientX;
      endDrag('keep');
    };
    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) endDrag('keep');
    };
    const onLost = (): void => endDrag('keep');
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      endDrag('revert');
    };
    const onContextMenu = (e: Event): void => e.preventDefault();
    const root = document.documentElement;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('blur', onLost);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    node.addEventListener('lostpointercapture', onLost);
    try {
      node.setPointerCapture(pointerId);
    } catch {
      // No capture: the window listeners follow the pointer anyway.
    }
    root.setAttribute('data-ui-resizing', 'col');
    drag.current = {
      startWidths,
      flush: () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        flush();
      },
      stop: () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = null;
        pending = null;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('blur', onLost);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('contextmenu', onContextMenu, true);
        node.removeEventListener('lostpointercapture', onLost);
        try {
          if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
        } catch {
          // already released
        }
        root.removeAttribute('data-ui-resizing');
      },
    };
    dragged.current = startWidths;
    setDraggingIndex(index);
    setDragWidths(startWidths);
  };

  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>, index: number): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? KEY_BIG_STEP : KEY_STEP;
    let delta: number;
    switch (event.key) {
      case 'ArrowRight':
        delta = step;
        break;
      case 'ArrowLeft':
        delta = -step;
        break;
      case 'Home':
        delta = Number.NEGATIVE_INFINITY;
        break;
      case 'End':
        delta = Number.POSITIVE_INFINITY;
        break;
      default:
        return;
    }
    event.preventDefault();
    endDrag('keep');
    if (layout === null) {
      // Not measured: trade a tenth of a share per step (a whole share with Shift), the best a blind strip can do.
      const share = (Number.isFinite(delta) ? delta : Math.sign(delta) * KEY_BIG_STEP) / (KEY_STEP * 10);
      const next = [...weights];
      const before = next[index] ?? 1;
      const after = next[index + 1];
      if (after === undefined) return;
      const moved = Math.min(Math.max(share, 0.25 - before), after - 0.25);
      next[index] = before + moved;
      next[index + 1] = after - moved;
      onWeights(next);
      return;
    }
    const bounded = Number.isFinite(delta) ? delta : Math.sign(delta) * 1_000_000;
    const max = Math.max(minWidth, (available ?? minWidth) - COLUMN_SEPARATOR_PX);
    onWeights(weightsFromWidths(resizeStrip(layout.widths, index, bounded, { overflow: layout.overflow, min: minWidth, max }), layout));
  };

  if (columns.length === 0) {
    return (
      <div ref={strip} id={id} className={cx('ui-columns', 'ui-columns--empty', className)}>
        {empty}
      </div>
    );
  }

  const overflow = layout?.overflow ?? false;
  return (
    <div className={cx('ui-columns-frame', className)}>
      <div
        ref={strip}
        id={id}
        className="ui-columns"
        data-overflow={overflow ? '' : undefined}
        data-dragging={draggingIndex === null ? undefined : ''}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        {columns.map((column, index) => {
          const width = widths?.[index];
          const last = index === columns.length - 1;
          return (
            <div key={column.id} className="ui-columns__slot" style={width === undefined ? { flexGrow: column.weight, flexShrink: 1, flexBasis: 0, minWidth } : { flex: 'none', width: width + (last ? 0 : COLUMN_SEPARATOR_PX) }}>
              <div className="ui-columns__column" data-column={column.id}>
                {column.node}
              </div>
              {last ? null : (
                <div
                  role="separator"
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-label={separatorLabel(column.label)}
                  aria-valuenow={width}
                  aria-valuemin={minWidth}
                  className="ui-columns__separator"
                  data-dragging={draggingIndex === index ? '' : undefined}
                  onPointerDown={(event) => onPointerDown(event, index)}
                  onKeyDown={(event) => onSeparatorKey(event, index)}
                  onDoubleClick={() => {
                    endDrag('revert');
                    onEqualize();
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {view !== null && view.before > 0 ? (
        <button type="button" className="ui-columns__more ui-columns__more--left" onClick={() => scrollToColumn(view.before - 1)}>
          <IconChevronLeft size={12} />
          <span>{moreLabel(view.before, 'left')}</span>
        </button>
      ) : null}
      {view !== null && view.after > 0 ? (
        <button type="button" className="ui-columns__more ui-columns__more--right" onClick={() => scrollToColumn(view.before + 1)}>
          <span>{moreLabel(view.after, 'right')}</span>
          <IconChevronRight size={12} />
        </button>
      ) : null}
    </div>
  );
}
