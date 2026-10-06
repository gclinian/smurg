import { useState, type ReactNode } from 'react';
import { tUi } from '../strings/ui.ts';
import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';
import { IconCheck, IconCopy } from './icons.tsx';

export interface PanelProps {
  /** Heading of the region; also its landmark name. */
  title: ReactNode;
  /** Accessible name when `title` is not plain text. */
  label?: string;
  icon?: ReactNode;
  /** Header controls. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Heading level inside the page outline (default 2). */
  level?: 2 | 3;
}

/** A titled region of code mode (the file tree, a tab of the drawer): a fixed header and a scrolling body. */
export function Panel({ title, label, icon, actions, children, className, level = 2 }: PanelProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('ui-panel', className)} aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
      <header className="ui-panel__header">
        {icon ? <span className="ui-panel__icon">{icon}</span> : null}
        <Heading className="ui-panel__title">{title}</Heading>
        {actions ? <div className="ui-panel__actions">{actions}</div> : null}
      </header>
      <div className="ui-panel__body">{children}</div>
    </section>
  );
}

/** Copies `text` to the clipboard; the icon confirms for a moment (the label says what is copied). */
export function CopyButton({ text, label, size = 'sm' }: { text: string; label: string; size?: 'sm' | 'md' }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <IconButton
      label={state === 'done' ? tUi('copy.done') : state === 'failed' ? tUi('copy.failed') : label}
      icon={state === 'done' ? <IconCheck /> : <IconCopy />}
      size={size}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => setState('done'))
          .catch(() => setState('failed'))
          .finally(() => setTimeout(() => setState('idle'), 2000));
      }}
    />
  );
}
