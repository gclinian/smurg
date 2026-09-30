import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton, type ButtonVariant } from './Button.tsx';
import { cx } from './cx.ts';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Secondary text on the right (a shortcut, a count). */
  readonly hint?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Radio-like items (theme picker): shown with aria-checked. */
  readonly checked?: boolean;
  onSelect(): void;
}

export interface MenuProps {
  /** Accessible name of the trigger; with `icon` and no `text`, the trigger is an icon button. */
  label: string;
  items: readonly MenuItem[];
  icon?: ReactNode;
  /** Visible trigger text. */
  text?: ReactNode;
  variant?: Exclude<ButtonVariant, 'primary'>;
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  className?: string;
}

/**
 * A menu button (WAI-ARIA menu pattern): Enter / Space / ArrowDown open it on the first item, ArrowUp on the last;
 * arrows move, Home / End jump, Escape closes and returns focus to the trigger, Tab closes.
 */
export function Menu({ label, items, icon, text, variant = 'ghost', size = 'md', align = 'end', className }: MenuProps) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<null | 'first' | 'last'>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const close = (refocus: boolean): void => {
    setOpen(null);
    setPosition(null);
    if (refocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !list.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const menu = list.current.getBoundingClientRect();
    const top = rect.bottom + 4 + menu.height > window.innerHeight ? Math.max(4, rect.top - 4 - menu.height) : rect.bottom + 4;
    const left = align === 'end' ? Math.max(4, rect.right - menu.width) : Math.min(rect.left, window.innerWidth - menu.width - 4);
    setPosition({ top, left });
    const buttons = list.current.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
    (open === 'last' ? buttons[buttons.length - 1] : buttons[0])?.focus();
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen('last');
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
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
        close(true);
        break;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  const toggle = (): void => (open ? close(false) : setOpen('first'));
  const triggerProps = {
    ref: trigger,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open !== null,
    'aria-controls': open ? menuId : undefined,
    onClick: toggle,
    onKeyDown: onTriggerKey,
    className,
  };

  return (
    <>
      {text === undefined ? (
        // The tooltip wrapper stays mounted in both states: re-parenting the trigger would drop its focus.
        <IconButton label={label} icon={icon} variant={variant} size={size} {...triggerProps} />
      ) : (
        // The visible text is the accessible name (WCAG 2.5.3); `label` names the menu itself.
        <Button variant={variant} size={size} icon={icon} {...triggerProps}>
          {text}
        </Button>
      )}
      {open
        ? createPortal(
            <div
              ref={list}
              id={menuId}
              role="menu"
              aria-label={label}
              className="ui-menu"
              style={position ?? { top: -9999, left: -9999 }}
              onKeyDown={onMenuKey}
            >
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item.checked}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
                  className={cx('ui-menu__item', item.danger && 'ui-menu__item--danger')}
                  onClick={() => {
                    if (item.disabled) return;
                    close(true);
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
          )
        : null}
    </>
  );
}
