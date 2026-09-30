import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { browserLocalStorage, readJson, writeJson } from '../lib/preferences.ts';
import { tUi } from '../strings/ui.ts';
import { cx } from './cx.ts';

export interface SplitPaneProps {
  /** 'horizontal': panes side by side (a vertical separator); 'vertical': stacked. */
  orientation: 'horizontal' | 'vertical';
  /** Which pane has the fixed size; the other takes the rest. */
  fixed: 'start' | 'end';
  /** Initial size of the fixed pane in px. */
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
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

const STEP = 16;
const BIG_STEP = 64;

/**
 * Two panes with a draggable separator. The separator is a focusable WAI-ARIA window splitter: arrow keys resize (Shift
 * for bigger steps), Home / End jump to the limits.
 */
export function SplitPane({ orientation, fixed, defaultSize, minSize = 120, maxSize = 1200, storageKey, label, collapsed = false, collapsedSize = 0, maximized = false, start, end, className }: SplitPaneProps) {
  const clamp = useCallback((value: number) => Math.round(Math.min(maxSize, Math.max(minSize, value))), [minSize, maxSize]);
  const [size, setSize] = useState<number>(() => {
    const stored = storageKey ? readJson(browserLocalStorage(), `smurg.pane.${storageKey}`) : undefined;
    return clamp(typeof stored === 'number' && Number.isFinite(stored) ? stored : defaultSize);
  });
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number } | null>(null);

  useEffect(() => {
    if (storageKey) writeJson(browserLocalStorage(), `smurg.pane.${storageKey}`, size);
  }, [size, storageKey]);

  const horizontal = orientation === 'horizontal';

  const fromPointer = (event: PointerEvent<HTMLDivElement>): number | null => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return null;
    const offset = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const total = horizontal ? rect.width : rect.height;
    return fixed === 'start' ? offset : total - offset;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    // Arrow direction follows the screen; the fixed pane grows towards the separator's far side.
    const growKeys = horizontal ? (fixed === 'start' ? ['ArrowRight'] : ['ArrowLeft']) : fixed === 'start' ? ['ArrowDown'] : ['ArrowUp'];
    const shrinkKeys = horizontal ? (fixed === 'start' ? ['ArrowLeft'] : ['ArrowRight']) : fixed === 'start' ? ['ArrowUp'] : ['ArrowDown'];
    if (growKeys.includes(event.key)) setSize((s) => clamp(s + step));
    else if (shrinkKeys.includes(event.key)) setSize((s) => clamp(s - step));
    else if (event.key === 'Home') setSize(clamp(minSize));
    else if (event.key === 'End') setSize(clamp(maxSize));
    else return;
    event.preventDefault();
  };

  const wide = maximized && !collapsed;
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
  const separator = collapsed || wide ? null : (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={tUi('split.resize', { name: label })}
      aria-valuenow={size}
      aria-valuemin={minSize}
      aria-valuemax={maxSize}
      className="ui-split__separator"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId };
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const next = fromPointer(event);
        if (next !== null) setSize(clamp(next));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );

  return (
    <div ref={container} className={cx('ui-split', `ui-split--${orientation}`, className)}>
      {fixed === 'start' ? (
        <>
          {fixedPane}
          {separator}
          {flexPane}
        </>
      ) : (
        <>
          {flexPane}
          {separator}
          {fixedPane}
        </>
      )}
    </div>
  );
}
