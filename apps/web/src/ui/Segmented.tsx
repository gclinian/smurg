import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { cx } from './cx.ts';

export interface SegmentedOption<V extends string> {
  readonly id: V;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  /** After the label: a count. */
  readonly badge?: ReactNode;
  /** A longer explanation (tooltip). */
  readonly title?: string;
  /** `links` only: where the segment leads. */
  readonly href?: string;
  /** Extra accessible name when the label and badge do not say it all ("Sessions: 2 waiting, 4 to look at"). */
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  /** Accessible name of the group (from the catalogue). */
  label: string;
  options: readonly SegmentedOption<V>[];
  /** The chosen segment; null: none of them (a page that is neither of the linked ones). */
  value: V | null;
  onChange(value: V): void;
  /**
   * `radio` (default): one choice of a few (Read / Edit, Items / File, a filter): a radio group, arrows move and
   * choose. `links`: each segment is a link to a page and the current one is marked `aria-current="page"` (the mode
   * switch): a plain click calls onChange, a modified click behaves like any link.
   */
  variant?: 'radio' | 'links';
  size?: 'sm' | 'md';
  className?: string;
}

/** A row of two to four segments of which one is chosen. */
export function Segmented<V extends string>({ label, options, value, onChange, variant = 'radio', size = 'md', className }: SegmentedProps<V>) {
  const refs = useRef(new Map<V, HTMLElement>());
  const enabled = options.filter((option) => !option.disabled);

  const move = (event: KeyboardEvent<HTMLElement>, current: V): void => {
    const index = enabled.findIndex((option) => option.id === current);
    let next: SegmentedOption<V> | undefined;
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

  const content = (option: SegmentedOption<V>): ReactNode => (
    <>
      {option.icon}
      <span className="ui-segmented__label">{option.label}</span>
      {option.badge}
    </>
  );

  if (variant === 'links') {
    const follow = (event: MouseEvent<HTMLAnchorElement>, option: SegmentedOption<V>): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!option.disabled) onChange(option.id);
    };
    return (
      <div role="group" aria-label={label} className={cx('ui-segmented', `ui-segmented--${size}`, className)}>
        {options.map((option) => (
          <a
            key={option.id}
            href={option.href ?? '#'}
            className="ui-segmented__option"
            aria-current={option.id === value ? 'page' : undefined}
            aria-label={option.ariaLabel}
            aria-disabled={option.disabled || undefined}
            title={option.title}
            data-segment={option.id}
            onClick={(event) => follow(event, option)}
          >
            {content(option)}
          </a>
        ))}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx('ui-segmented', `ui-segmented--${size}`, className)}>
      {options.map((option) => {
        const checked = option.id === value;
        // One tab stop: the chosen segment, or the first one while nothing is chosen.
        const tabStop = value === null ? option === enabled[0] : checked;
        return (
          <button
            key={option.id}
            ref={(node) => {
              if (node) refs.current.set(option.id, node);
              else refs.current.delete(option.id);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            tabIndex={tabStop ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            className="ui-segmented__option"
            data-segment={option.id}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => move(event, option.id)}
          >
            {content(option)}
          </button>
        );
      })}
    </div>
  );
}
