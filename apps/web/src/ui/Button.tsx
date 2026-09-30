import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Spinner } from './Spinner.tsx';
import { Tooltip } from './Tooltip.tsx';
import { cx } from './cx.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (decorative; the text is the label). */
  icon?: ReactNode;
  /** Shows a spinner and disables the button (the label stays for screen readers). */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = 'secondary', size = 'md', icon, loading = false, className, children, disabled, type = 'button', ref, ...rest }: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} decorative /> : icon}
      {children === undefined ? null : <span className="ui-button__label">{children}</span>}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** The accessible name (zh-TW), also shown as the tooltip. Required: an icon alone is not a label. */
  label: string;
  icon: ReactNode;
  variant?: Exclude<ButtonVariant, 'primary'>;
  size?: ButtonSize;
  /** Toggle buttons: the pressed state (aria-pressed). */
  pressed?: boolean;
  /** Hide the tooltip (e.g. when a visible label sits next to it). */
  noTooltip?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, icon, variant = 'ghost', size = 'md', pressed, noTooltip = false, className, type = 'button', ref, ...rest }: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type={type}
      className={cx('ui-icon-button', `ui-button--${variant}`, `ui-icon-button--${size}`, className)}
      aria-label={label}
      aria-pressed={pressed}
      {...rest}
    >
      {icon}
    </button>
  );
  return noTooltip ? button : (
    <Tooltip content={label} describe={false}>
      {button}
    </Tooltip>
  );
}
