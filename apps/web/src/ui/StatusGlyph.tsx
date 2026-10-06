import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconArc, IconCheckCircle, IconCircle, IconCircleDashed, IconClock, IconHourglassStop, IconQuestion, IconShieldAlert, IconStop, IconXCircle, type IconProps } from './icons.tsx';

/**
 * What a session or a work item is doing, as the eye reads it (UX §3.2): a shape AND a colour, never colour alone.
 * Amber always means "a person must act".
 */
export const GLYPH_STATUSES = ['running', 'question', 'permission', 'stalled', 'idle', 'done', 'failed', 'ended', 'blocked', 'todo'] as const;
export type GlyphStatus = (typeof GLYPH_STATUSES)[number];

const SHAPE: Record<GlyphStatus, (props: IconProps) => ReactNode> = {
  running: IconArc,
  question: IconQuestion,
  permission: IconShieldAlert,
  stalled: IconHourglassStop,
  idle: IconCircle,
  done: IconCheckCircle,
  failed: IconXCircle,
  ended: IconStop,
  blocked: IconClock,
  todo: IconCircleDashed,
};

export interface StatusGlyphProps {
  status: GlyphStatus;
  /** The status in words ("Waiting for an answer"): the glyph's accessible name and tooltip. */
  label: string;
  /** 14 in rows (default), 16 in headers, 12 beside small text. */
  size?: 12 | 14 | 16;
  className?: string;
}

export function StatusGlyph({ status, label, size = 14, className }: StatusGlyphProps) {
  const Shape = SHAPE[status];
  return (
    <span className={cx('ui-status', `ui-status--${status}`, className)} title={label} data-status={status}>
      <Shape size={size} title={label} />
    </span>
  );
}
