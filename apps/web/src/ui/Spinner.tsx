import { tUi } from '../strings/ui.ts';
import { cx } from './cx.ts';

export interface SpinnerProps {
  size?: number;
  /** Accessible label (default "Loading"). */
  label?: string;
  /** Inside a control that already says it is busy: hidden from assistive technology. */
  decorative?: boolean;
  className?: string;
}

export function Spinner({ size = 16, label, decorative = false, className }: SpinnerProps) {
  const svg = (
    <svg className="ui-spinner__svg" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
  if (decorative) return <span className={cx('ui-spinner', className)}>{svg}</span>;
  return (
    <span className={cx('ui-spinner', className)} role="status">
      {svg}
      <span className="ui-visually-hidden">{label ?? tUi('spinner.loading')}</span>
    </span>
  );
}
