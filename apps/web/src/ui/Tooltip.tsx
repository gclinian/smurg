import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  content: ReactNode;
  /** One focusable element (a button, a link). */
  children: ReactElement;
  placement?: 'top' | 'bottom';
  /**
   * Link the text to the child with aria-describedby (default). Off when the tooltip only repeats the child's own
   * accessible name (icon buttons), so screen readers do not read it twice.
   */
  describe?: boolean;
  /** Hover delay in ms; keyboard focus shows it at once. */
  delay?: number;
}

/** A hover / focus hint. Escape hides it; it never holds anything interactive. */
export function Tooltip({ content, children, placement = 'top', describe = true, delay = 450 }: TooltipProps) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const clear = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const show = useCallback((immediately: boolean) => {
    clear();
    if (immediately) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);
  const hide = useCallback(() => {
    clear();
    setOpen(false);
    setPosition(null);
  }, []);

  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const tip = bubble.current.getBoundingClientRect();
    const margin = 6;
    let side = placement;
    if (side === 'top' && rect.top - tip.height - margin < 0) side = 'bottom';
    if (side === 'bottom' && rect.bottom + tip.height + margin > window.innerHeight) side = 'top';
    const top = side === 'top' ? rect.top - tip.height - margin : rect.bottom + margin;
    const left = Math.min(Math.max(4, rect.left + rect.width / 2 - tip.width / 2), Math.max(4, window.innerWidth - tip.width - 4));
    setPosition({ left, top, placement: side });
  }, [open, placement, content]);

  const child = isValidElement<Record<string, unknown>>(children) && describe && open ? cloneElement(children, { 'aria-describedby': id }) : children;

  return (
    <span
      ref={anchor}
      className="ui-tooltip-anchor"
      onPointerEnter={() => show(false)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={() => show(true)}
      onBlur={hide}
    >
      {child}
      {open
        ? createPortal(
            <div
              ref={bubble}
              id={id}
              role="tooltip"
              className="ui-tooltip"
              data-placement={position?.placement ?? placement}
              style={position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
