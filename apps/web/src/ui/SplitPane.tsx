import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { browserLocalStorage, readJson, writeJson } from '../lib/preferences.ts';
import { tUi } from '../strings/ui.ts';
import { cx } from './cx.ts';
import { clampSize, dragMove, grabOffset, sizeFromKey, sizeFromPointer, sizeFromSeparator, splitLimits, storedSize, type SplitGeometry, type SplitLimits } from './split-resize.ts';

export interface SplitPaneProps {
  /** 'horizontal': panes side by side (a vertical separator); 'vertical': stacked. */
  orientation: 'horizontal' | 'vertical';
  /** Which pane has the fixed size; the other takes the rest. */
  fixed: 'start' | 'end';
  /** Initial size of the fixed pane in px; a double click on the separator comes back to it. */
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  /** The least the other pane keeps, in px: the fixed pane never grows (or stays, in a smaller window) past it. */
  minOtherSize?: number;
  /** Remember the size in this browser under this key. */
  storageKey?: string;
  /** Name of the fixed pane, for the separator's accessible label (「檔案」). */
  label: string;
  /**
   * Collapse the fixed pane (its size is kept for when it comes back). Its content stays mounted: with a
   * `collapsedSize` it keeps that size (e.g. a drawer's header), otherwise it is hidden.
   */
  collapsed?: boolean;
  collapsedSize?: number;
  /** The fixed pane takes all the room; the other pane stays mounted but hidden (e.g. a terminal given the width). */
  maximized?: boolean;
  start: ReactNode;
  end: ReactNode;
  className?: string;
}

/** The separator's thickness (components.css) where it cannot be measured. */
const SEPARATOR_PX = 1;

/** One drag, from the press of the primary button to its end. Nothing listens to the pointer outside of one. */
interface ActiveDrag {
  readonly startSize: number;
  /** Applies a move that still waits for its frame. */
  flush(): void;
  /** Removes every listener of the drag, cancels its frame, gives the pointer capture back. */
  stop(): void;
}

/**
 * Two panes with a draggable separator. The separator is a focusable WAI-ARIA window splitter: arrow keys resize (Shift
 * for bigger steps), Home / End jump to the limits, a double click comes back to the default size.
 *
 * Dragging (split-resize.ts has the arithmetic): the separator stays under the pointer exactly where it was grabbed,
 * measured against the container's own box, inside limits that leave the other pane its minimum. The pane moves ONLY
 * while the primary button is down: the listeners of a drag exist from that press until the drag ends, and it ends on
 * the release wherever the pointer is (pointer capture), on a move without the button (a release the browser never
 * delivered: it drops the capture for a context menu or a second button), on a lost capture, a cancelled pointer, a
 * window that lost the focus, Escape (which also puts the size back) and when the separator goes away. Moves are
 * applied once per frame; the panes ignore the pointer meanwhile (no hover, selection or terminal mouse reports
 * under a drag).
 */
export function SplitPane({
  orientation,
  fixed,
  defaultSize,
  minSize = 120,
  maxSize = 1200,
  minOtherSize = 0,
  storageKey,
  label,
  collapsed = false,
  collapsedSize = 0,
  maximized = false,
  start,
  end,
  className,
}: SplitPaneProps) {
  const horizontal = orientation === 'horizontal';
  const storeKey = storageKey ? `smurg.pane.${storageKey}` : null;
  const limitsIn = (geometry: SplitGeometry | null): SplitLimits =>
    splitLimits({ minSize, maxSize, minOther: minOtherSize, containerSize: geometry?.containerSize ?? null, separatorSize: geometry?.separatorSize ?? SEPARATOR_PX });

  const [size, setSize] = useState<number>(() => clampSize(storedSize(storeKey ? readJson(browserLocalStorage(), storeKey) : undefined) ?? defaultSize, limitsIn(null)));
  const [dragging, setDragging] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const separator = useRef<HTMLDivElement>(null);
  const drag = useRef<ActiveDrag | null>(null);
  /** The size last set (a state update may still be pending when a drag ends). */
  const applied = useRef(size);

  /** Where the split and its separator are on screen, along the axis; null while they are not laid out. */
  const measure = (): { geometry: SplitGeometry; separatorStart: number } | null => {
    const box = container.current?.getBoundingClientRect();
    const line = separator.current?.getBoundingClientRect();
    if (!box || !line) return null;
    return horizontal
      ? { geometry: { containerStart: box.left, containerSize: box.width, separatorSize: line.width }, separatorStart: line.left }
      : { geometry: { containerStart: box.top, containerSize: box.height, separatorSize: line.height }, separatorStart: line.top };
  };

  const persist = (value: number): void => {
    if (storeKey) writeJson(browserLocalStorage(), storeKey, value);
  };
  /** A size chosen in one step (a key, a double click): shown and remembered. */
  const commit = (value: number): void => {
    applied.current = value;
    setSize(value);
    persist(value);
  };

  /**
   * Ends the drag, if there is one. 'keep': the size the pointer chose, its last move included; 'revert': the size
   * before the drag; 'gone': the separator left the page (what was applied stays); 'unmount': the same, quietly.
   */
  const endDrag = (outcome: 'keep' | 'revert' | 'gone' | 'unmount'): void => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (outcome === 'keep') active.flush();
    active.stop();
    if (outcome === 'revert') applied.current = active.startSize;
    persist(applied.current);
    if (outcome === 'unmount') return;
    setDragging(false);
    setSize(applied.current);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // A drag whose end never arrived is over before another one begins.
    endDrag('keep');
    const pressed = measure();
    if (!pressed) return;
    // No text selection, no focus change (the terminal or the editor keeps the keyboard), no native drag.
    event.preventDefault();
    const node = event.currentTarget;
    const pointerId = event.pointerId;
    const along = (e: { readonly clientX: number; readonly clientY: number }): number => (horizontal ? e.clientX : e.clientY);
    const grab = grabOffset(along(event), pressed.separatorStart);
    const root = document.documentElement;
    // The container's box does not change while its own separator moves: measured at the press and when the window
    // is resized, never per move (reading layout in every frame would force one on top of the terminal's and the
    // editor's own).
    let geometry = pressed.geometry;
    const onResize = (): void => {
      geometry = measure()?.geometry ?? geometry;
    };

    const apply = (pointer: number): void => {
      const next = clampSize(sizeFromPointer(pointer, grab, geometry, fixed), limitsIn(geometry));
      if (next === applied.current) return;
      applied.current = next;
      // In this frame, not in a later task: the line is under the pointer when the frame is painted.
      flushSync(() => setSize(next));
    };
    let pending: number | null = null;
    let frame: number | null = null;
    const flush = (): void => {
      frame = null;
      if (pending === null) return;
      const pointer = pending;
      pending = null;
      apply(pointer);
    };
    const onMove = (e: PointerEvent): void => {
      const what = dragMove(pointerId, e);
      if (what === 'ignore') return;
      if (what === 'end') {
        endDrag('keep');
        return;
      }
      pending = along(e);
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      // The release position counts, wherever it is (over the terminal, the editor, outside the window).
      pending = along(e);
      endDrag('keep');
    };
    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) endDrag('keep');
    };
    const onLost = (): void => endDrag('keep');
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // The drag's own key: it does not also reach the terminal or the editor that has the focus.
      e.preventDefault();
      e.stopPropagation();
      endDrag('revert');
    };
    // A context menu would swallow the release.
    const onContextMenu = (e: Event): void => e.preventDefault();

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('blur', onLost);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('resize', onResize);
    node.addEventListener('lostpointercapture', onLost);
    try {
      node.setPointerCapture(pointerId);
    } catch {
      // No capture (the pointer is already gone, or no such API): the window listeners follow the pointer anyway.
    }
    root.setAttribute('data-ui-resizing', horizontal ? 'col' : 'row');
    drag.current = {
      startSize: applied.current,
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
        window.removeEventListener('resize', onResize);
        node.removeEventListener('lostpointercapture', onLost);
        try {
          if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
        } catch {
          // already released
        }
        root.removeAttribute('data-ui-resizing');
      },
    };
    setDragging(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const measured = measure();
    const onScreen = measured !== null && measured.geometry.containerSize > 0 ? measured : null;
    const limits = limitsIn(onScreen?.geometry ?? null);
    // From the size on screen: in a window that became smaller the pane shows less than the remembered size.
    const current = onScreen ? clampSize(sizeFromSeparator(onScreen.separatorStart, onScreen.geometry, fixed), limits) : size;
    const next = sizeFromKey(event.key, { orientation, fixed, shiftKey: event.shiftKey, size: current, limits });
    if (next === null) return;
    event.preventDefault();
    endDrag('keep');
    commit(next);
  };

  const wide = maximized && !collapsed;
  const separatorShown = !collapsed && !wide;

  // The separator went away under a pressed button (the pane was collapsed or maximised): that drag is over.
  useEffect(() => {
    if (!separatorShown) endDrag('gone');
  });
  // Refs and the storage key are the same in every render: the first render's endDrag ends any later drag.
  useEffect(() => () => endDrag('unmount'), []);

  const shown = collapsed ? collapsedSize : size;
  const fixedStyle = wide ? undefined : horizontal ? { width: shown } : { height: shown };
  const fixedPane = (
    <div className={cx('ui-split__pane', wide ? 'ui-split__pane--flex' : 'ui-split__pane--fixed')} style={fixedStyle} hidden={collapsed && collapsedSize <= 0}>
      {fixed === 'start' ? start : end}
    </div>
  );
  const flexPane = (
    <div className="ui-split__pane ui-split__pane--flex" hidden={wide}>
      {fixed === 'start' ? end : start}
    </div>
  );
  const separatorNode = separatorShown ? (
    <div
      ref={separator}
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={tUi('split.resize', { name: label })}
      aria-valuenow={size}
      aria-valuemin={minSize}
      aria-valuemax={maxSize}
      className="ui-split__separator"
      data-dragging={dragging ? '' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(clampSize(defaultSize, limitsIn(measure()?.geometry ?? null)))}
    />
  ) : null;

  return (
    <div
      ref={container}
      className={cx('ui-split', `ui-split--${orientation}`, className)}
      data-dragging={dragging ? '' : undefined}
      style={{ '--ui-split-min-other': `${minOtherSize}px` } as CSSProperties}
    >
      {fixed === 'start' ? (
        <>
          {fixedPane}
          {separatorNode}
          {flexPane}
        </>
      ) : (
        <>
          {flexPane}
          {separatorNode}
          {fixedPane}
        </>
      )}
    </div>
  );
}
