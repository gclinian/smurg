import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.ts';
import type { MenuItem } from './Menu.tsx';

export interface ContextMenuProps {
  /** Where it opens (viewport coordinates); null: closed. */
  at: { readonly x: number; readonly y: number } | null;
  /** Accessible name of the menu ("Actions for 1 · Cart API"). */
  label: string;
  items: readonly MenuItem[];
  /** Closed by Escape, Tab, a click outside or a choice. The caller gives the focus back to what opened it. */
  onClose(): void;
}

/**
 * A menu that opens at a point instead of under its own button: the context menu of a row (right click, Shift+F10,
 * the menu key). The same keys as Menu: arrows move, Home / End jump, Escape and Tab close.
 */
export function ContextMenu({ at, label, items, onClose }: ContextMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null && items.length > 0;

  useLayoutEffect(() => {
    if (!open || !list.current || at === null) {
      setPosition(null);
      return;
    }
    const menu = list.current.getBoundingClientRect();
    const top = at.y + menu.height + 4 > window.innerHeight ? Math.max(4, at.y - menu.height) : at.y;
    const left = Math.max(4, Math.min(at.x, window.innerWidth - menu.width - 4));
    setPosition({ top, left });
    list.current.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open, at?.x, at?.y]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!list.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open, onClose]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
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
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return createPortal(
    <div ref={list} role="menu" aria-label={label} className="ui-menu" style={position ?? { top: -9999, left: -9999 }} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-menu-item={item.id}
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          aria-disabled={item.disabled || undefined}
          tabIndex={-1}
          className={cx('ui-menu__item', item.danger && 'ui-menu__item--danger')}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
        >
          <span className="ui-menu__icon">{item.icon}</span>
          <span className="ui-menu__label" lang={item.lang}>
            {item.label}
          </span>
          {item.hint ? <span className="ui-menu__hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
