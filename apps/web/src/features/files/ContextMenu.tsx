// A context menu at a point (right click, Shift+F10, the ContextMenu key), following the WAI-ARIA menu pattern of
// ui/Menu.tsx: focus moves to the first item, arrows move, Home/End jump, Escape closes and the caller restores focus,
// Tab or a click outside closes. Uses the design system's menu styles.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cx, type MenuItem } from '../../ui/index.ts';

export interface ContextMenuProps {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
  /** `refocus`: the menu was left with Escape (or an item ran): return focus to where it was opened. */
  onClose(refocus: boolean): void;
}

export function ContextMenu({ label, x, y, items, onClose }: ContextMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPosition({
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
    });
    node.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      if (!list.current?.contains(event.target as Node)) onCloseRef.current(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number): void => buttons[(i + buttons.length) % buttons.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1);
        break;
      case 'ArrowUp':
        focus(index - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(buttons.length - 1);
        break;
      case 'Escape':
        onCloseRef.current(true);
        break;
      case 'Tab':
        onCloseRef.current(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={list}
      role="menu"
      aria-label={label}
      className="ui-menu files-context-menu"
      style={position ?? { top: -9999, left: -9999 }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          tabIndex={-1}
          className={cx('ui-menu__item', item.danger && 'ui-menu__item--danger')}
          onClick={() => {
            if (item.disabled) return;
            onCloseRef.current(true);
            item.onSelect();
          }}
        >
          <span className="ui-menu__icon">{item.icon}</span>
          <span className="ui-menu__label">{item.label}</span>
          {item.hint ? <span className="ui-menu__hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
