// Badge, Banner and EmptyState: small presentational pieces.
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconInfo } from './icons.tsx';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: <IconInfo />,
  info: <IconInfo />,
  success: <IconCheck />,
  warning: <IconAlertTriangle />,
  danger: <IconAlertCircle />,
};

export interface BannerProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons on the right. */
  actions?: ReactNode;
  icon?: ReactNode;
  /**
   * 'status' (polite, default) for states that the person should notice; 'alert' (assertive) only for something that
   * needs action now. 'none' for static text.
   */
  live?: 'status' | 'alert' | 'none';
  className?: string;
  id?: string;
}

export function Banner({ tone = 'info', title, children, actions, icon, live = 'status', className, id }: BannerProps) {
  return (
    <div id={id} className={cx('ui-banner', `ui-banner--${tone}`, className)} role={live === 'none' ? undefined : live}>
      <span className="ui-banner__icon">{icon ?? TONE_ICON[tone]}</span>
      <div className="ui-banner__body">
        {title ? <p className="ui-banner__title">{title}</p> : null}
        {children ? <div className="ui-banner__text">{children}</div> : null}
      </div>
      {actions ? <div className="ui-banner__actions">{actions}</div> : null}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Compact variant for small panels. */
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact = false }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', compact && 'ui-empty--compact', className)}>
      {icon ? <span className="ui-empty__icon">{icon}</span> : null}
      <p className="ui-empty__title">{title}</p>
      {description ? <p className="ui-empty__description">{description}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}

/** A keyboard key, e.g. <Kbd>Esc</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
