import { useId, type ReactNode, type Ref } from 'react';
import { cx } from './cx.ts';
import { IconChevronDown } from './icons.tsx';

export interface CollapsibleProps {
  /** The section's heading; the toggle button is its content. */
  title: ReactNode;
  open: boolean;
  onToggle(open: boolean): void;
  /** Inside the toggle, after the title: counts ("2 · 4"). Stays visible while collapsed. */
  meta?: ReactNode;
  /** Header controls beside the toggle (they stay usable while collapsed). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Heading level inside the page outline (default 2). */
  level?: 2 | 3;
  /** The toggle button (focus targets: F6 lands here). */
  toggleRef?: Ref<HTMLButtonElement>;
  /** The scrolling body. */
  bodyRef?: Ref<HTMLDivElement>;
  /** Extra attributes of the section (`data-region`, …). */
  sectionProps?: Readonly<Record<`data-${string}`, string | boolean | undefined>>;
}

/**
 * A titled section that folds to its header: a real `section` named by its heading, with a disclosure button
 * (`aria-expanded`, `aria-controls`). The body stays mounted while collapsed (hidden), so lists keep their state.
 */
export function Collapsible({ title, open, onToggle, meta, actions, children, className, level = 2, toggleRef, bodyRef, sectionProps }: CollapsibleProps) {
  const id = useId();
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('ui-collapsible', !open && 'ui-collapsible--collapsed', className)} aria-labelledby={`${id}-title`} {...sectionProps}>
      <header className="ui-collapsible__head">
        <Heading className="ui-collapsible__heading">
          <button ref={toggleRef} type="button" className="ui-collapsible__toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => onToggle(!open)}>
            <IconChevronDown size={12} />
            <span className="ui-collapsible__title" id={`${id}-title`}>
              {title}
            </span>
            {meta}
          </button>
        </Heading>
        {actions ? <div className="ui-collapsible__actions">{actions}</div> : null}
      </header>
      <div ref={bodyRef} id={`${id}-body`} className="ui-collapsible__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
