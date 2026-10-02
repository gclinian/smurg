import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx.ts';

export interface TabItem<V extends string> {
  readonly id: V;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  /** e.g. a count Badge. */
  readonly badge?: ReactNode;
  readonly panel: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps<V extends string> {
  items: readonly TabItem<V>[];
  value: V;
  onChange(value: V): void;
  /** Accessible name of the tab list (from the catalogue). */
  label: string;
  /** Keep inactive panels mounted (hidden): terminals and editors keep their state. */
  keepMounted?: boolean;
  /** Extra controls at the end of the tab strip. */
  actions?: ReactNode;
  className?: string;
  size?: 'sm' | 'md';
  /** Hide every panel but keep them mounted (a collapsed drawer shows only its tab strip). */
  collapsed?: boolean;
}

/**
 * WAI-ARIA tabs with automatic activation: Left/Right (or Up/Down) move and select, Home/End jump, Tab leaves the
 * strip into the panel.
 */
export function Tabs<V extends string>({ items, value, onChange, label, keepMounted = false, actions, className, size = 'md', collapsed = false }: TabsProps<V>) {
  const base = useId();
  const refs = useRef(new Map<V, HTMLButtonElement>());
  const enabled = items.filter((item) => !item.disabled);

  const move = (event: KeyboardEvent<HTMLButtonElement>, current: V): void => {
    const index = enabled.findIndex((item) => item.id === current);
    let next: TabItem<V> | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = enabled[(index + 1) % enabled.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = enabled[(index - 1 + enabled.length) % enabled.length];
        break;
      case 'Home':
        next = enabled[0];
        break;
      case 'End':
        next = enabled[enabled.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };

  return (
    <div className={cx('ui-tabs', `ui-tabs--${size}`, className)}>
      <div className="ui-tabs__strip">
        <div role="tablist" aria-label={label} className="ui-tabs__list">
          {items.map((item) => {
            const selected = item.id === value;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  if (node) refs.current.set(item.id, node);
                  else refs.current.delete(item.id);
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${item.id}`}
                aria-selected={selected}
                aria-controls={`${base}-panel-${item.id}`}
                tabIndex={selected ? 0 : -1}
                disabled={item.disabled}
                className={cx('ui-tab', selected && 'ui-tab--selected')}
                onClick={() => onChange(item.id)}
                onKeyDown={(event) => move(event, item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge}
              </button>
            );
          })}
        </div>
        {actions ? <div className="ui-tabs__actions">{actions}</div> : null}
      </div>
      {items.map((item) => {
        const selected = item.id === value;
        if (!selected && !keepMounted) return null;
        return (
          <div
            key={item.id}
            role="tabpanel"
            id={`${base}-panel-${item.id}`}
            aria-labelledby={`${base}-tab-${item.id}`}
            hidden={!selected || collapsed}
            className="ui-tabs__panel"
          >
            {item.panel}
          </div>
        );
      })}
    </div>
  );
}
