// The session tabs of the agents panel: WAI-ARIA tabs with automatic activation, like ui/Tabs (Left/Right or Up/Down
// move and select, Home/End jump, Tab leaves the strip; every panel stays mounted, so terminals keep their state),
// plus what only this strip needs (ARCHITECTURE §9 "Closing an ended session's tab"): the tab of an ENDED session can
// be closed — a close button next to the tab (a sibling of it: a tab holds no other control; in the tab order right
// after the selected tab), Delete on the tab, a middle click. A running session's tab has none of them.
import { useEffect, useId, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { cx } from '../../ui/index.ts';
import { IconClose } from '../../ui/icons.tsx';

export interface SessionTabItem {
  readonly id: string;
  readonly label: ReactNode;
  /** e.g. a count Badge. */
  readonly badge?: ReactNode;
  readonly panel: ReactNode;
  /** Only for an ended session: the accessible name of its close button ("Close ..."). Without it the tab cannot be closed. */
  readonly closeLabel?: string;
}

export interface SessionTabsHandle {
  /** Moves the keyboard focus to the tab of `id`; false when there is no such tab. */
  focusTab(id: string): boolean;
}

export interface SessionTabsProps {
  readonly items: readonly SessionTabItem[];
  readonly value: string;
  onChange(id: string): void;
  /** Called only for an item with a `closeLabel`. */
  onClose(id: string): void;
  /** Accessible name of the tab list. */
  readonly label: string;
  /** What a closable tab says about itself (aria-description): "Press Delete to close ...". */
  readonly closeHint: string;
  readonly ref?: Ref<SessionTabsHandle>;
}

export function SessionTabs({ items, value, onChange, onClose, label, closeHint, ref }: SessionTabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const stripRef = useRef<HTMLDivElement>(null);

  // The strip scrolls sideways when the tabs do not fit: the selected tab is brought into view WITH
  // its close button, also when that button appears (the session ended). Only the strip is scrolled, never an ancestor.
  const selectedClosable = items.some((item) => item.id === value && item.closeLabel !== undefined);
  useEffect(() => {
    const strip = stripRef.current;
    const item = refs.current.get(value)?.parentElement;
    if (!strip || !item) return;
    const visible = strip.getBoundingClientRect();
    const own = item.getBoundingClientRect();
    if (own.left < visible.left) strip.scrollLeft -= visible.left - own.left;
    else if (own.right > visible.right) strip.scrollLeft += own.right - visible.right;
  }, [value, selectedClosable, items.length]);

  useImperativeHandle(
    ref,
    () => ({
      focusTab(id) {
        const tab = refs.current.get(id);
        tab?.focus();
        return tab !== undefined;
      },
    }),
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, item: SessionTabItem): void => {
    let next: SessionTabItem | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = items[(index + 1) % items.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = items[(index - 1 + items.length) % items.length];
        break;
      case 'Home':
        next = items[0];
        break;
      case 'End':
        next = items[items.length - 1];
        break;
      case 'Delete':
        // Nothing for a running session: ending one is a separate, explicit action in its panel.
        if (item.closeLabel === undefined) return;
        event.preventDefault();
        onClose(item.id);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };

  return (
    <div className="ui-tabs ui-tabs--sm agents-tabs">
      <div className="ui-tabs__strip">
        <div ref={stripRef} role="tablist" aria-label={label} className="ui-tabs__list">
          {items.map((item, index) => {
            const selected = item.id === value;
            const closable = item.closeLabel !== undefined;
            return (
              <div key={item.id} role="presentation" className={cx('agents-tab-item', selected && 'agents-tab-item--selected', closable && 'agents-tab-item--closable')}>
                <button
                  ref={(node) => {
                    if (node) refs.current.set(item.id, node);
                    else refs.current.delete(item.id);
                  }}
                  type="button"
                  role="tab"
                  id={`${base}-tab-${item.id}`}
                  aria-selected={selected}
                  aria-controls={`${base}-panel-${item.id}`}
                  aria-keyshortcuts={closable ? 'Delete' : undefined}
                  aria-description={closable ? closeHint : undefined}
                  tabIndex={selected ? 0 : -1}
                  className={cx('ui-tab', selected && 'ui-tab--selected')}
                  onClick={() => onChange(item.id)}
                  onKeyDown={(event) => onKeyDown(event, index, item)}
                  onAuxClick={(event) => {
                    if (event.button === 1 && closable) onClose(item.id);
                  }}
                >
                  <span>{item.label}</span>
                  {item.badge}
                </button>
                {closable ? (
                  <button
                    type="button"
                    className="agents-tab__close"
                    // Reached with Tab right after the selected tab; the other tabs' buttons with the pointer (or Delete).
                    tabIndex={selected ? 0 : -1}
                    aria-label={item.closeLabel}
                    title={item.closeLabel}
                    onClick={() => onClose(item.id)}
                  >
                    <IconClose size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <div key={item.id} role="tabpanel" id={`${base}-panel-${item.id}`} aria-labelledby={`${base}-tab-${item.id}`} hidden={!selected} className="ui-tabs__panel">
            {item.panel}
          </div>
        );
      })}
    </div>
  );
}
