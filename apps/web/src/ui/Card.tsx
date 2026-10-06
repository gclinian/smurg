import { useId, type ReactNode, type Ref } from 'react';
import { cx } from './cx.ts';
import type { Tone } from './Feedback.tsx';

export interface CardProps {
  /** The card's heading (an `h3`: a card lives inside a column, whose title is the `h2`). */
  title: ReactNode;
  /** Before the title: a KindIcon or a status glyph. */
  icon?: ReactNode;
  /** At the end of the header: a fact ("4 of 4 voted"). */
  meta?: ReactNode;
  /** The stripe on the card's edge: `warning` while it waits for a person. */
  tone?: Tone;
  children?: ReactNode;
  /** Under the body, separated: the answer and its buttons. */
  footer?: ReactNode;
  /** Settled (answered, allowed, accepted …): drawn quieter. */
  settled?: boolean;
  /** Outlined for a moment: where an inbox item led. */
  flash?: boolean;
  /** The DOM id (the anchor an inbox item scrolls to). */
  id?: string;
  className?: string;
  /** The section itself: focus lands on a card (`tabIndex={-1}`), never on one of its buttons. */
  ref?: Ref<HTMLElement>;
}

/**
 * A thing inside a conversation or a column that stands on its own: a question, a permission request, a
 * suggestion, a next step. A `section` named by its `h3`, focusable by script so that "open the inbox item" can
 * put the focus on the card and a screen reader starts reading at its title.
 */
export function Card({ title, icon, meta, tone = 'neutral', children, footer, settled = false, flash = false, id, className, ref }: CardProps) {
  const headingId = useId();
  return (
    <section
      ref={ref}
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      className={cx('ui-card', `ui-card--${tone}`, settled && 'ui-card--settled', className)}
      data-flash={flash || undefined}
    >
      <header className="ui-card__head">
        {icon ? <span className="ui-card__icon">{icon}</span> : null}
        <h3 id={headingId} className="ui-card__title">
          {title}
        </h3>
        {meta ? <span className="ui-card__meta">{meta}</span> : null}
      </header>
      {children === undefined || children === null ? null : <div className="ui-card__body">{children}</div>}
      {footer ? <footer className="ui-card__foot">{footer}</footer> : null}
    </section>
  );
}
