import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconAlertTriangle, IconAt, IconCheck, IconComment, IconGitMerge, IconLightbulb, IconQuestion, IconReport, IconShieldAlert, type IconProps } from './icons.tsx';

/** The kinds of things that wait for a person: the inbox item kinds, which are also the card kinds. */
export const ITEM_KINDS = ['question', 'vote', 'permission', 'attention', 'suggestion', 'report', 'merge', 'mention', 'result'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

const SHAPE: Record<ItemKind, (props: IconProps) => ReactNode> = {
  question: IconQuestion,
  vote: IconCheck,
  permission: IconShieldAlert,
  attention: IconAlertTriangle,
  suggestion: IconLightbulb,
  report: IconReport,
  merge: IconGitMerge,
  mention: IconAt,
  result: IconComment,
};

export interface KindIconProps {
  kind: ItemKind;
  /** The kind in words ("Permission request"): the icon's accessible name and tooltip. */
  label: string;
  className?: string;
}

/** The icon of an inbox item or a card: a tinted square. */
export function KindIcon({ kind, label, className }: KindIconProps) {
  const Shape = SHAPE[kind];
  return (
    <span className={cx('ui-kind', `ui-kind--${kind}`, className)} title={label} data-kind={kind}>
      <Shape size={14} title={label} />
    </span>
  );
}
