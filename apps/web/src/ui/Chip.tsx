import type { ReactNode, Ref } from 'react';
import { cx } from './cx.ts';

export interface ChipProps {
  children: ReactNode;
  /** Before the text: an icon or a small avatar. */
  lead?: ReactNode;
  /** With it the chip is a button; without it a static fact. */
  onClick?(): void;
  /** The full wording (tooltip and accessible name) when the text is cut or, in a narrow column, hidden. */
  title?: string;
  /** In a column narrower than 620 px only the lead shows (the worktree, the permission mode). Needs `title`. */
  collapsible?: boolean;
  /** A menu button: `aria-haspopup` / `aria-expanded` are the caller's to pass through `buttonProps`. */
  buttonProps?: Readonly<Record<`aria-${string}` | `data-${string}`, string | boolean | undefined>>;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** A small rounded fact in a column's strip: who is responsible, the worktree, the permission mode. */
export function Chip({ children, lead, onClick, title, collapsible = false, buttonProps, className, ref }: ChipProps) {
  const names = cx('ui-chip', onClick === undefined && 'ui-chip--static', collapsible && 'ui-chip--collapsible', className);
  const content = (
    <>
      {lead}
      <span className="ui-chip__text">{children}</span>
    </>
  );
  if (onClick === undefined) {
    return (
      <span className={names} title={title} aria-label={collapsible ? title : undefined} role={collapsible && title ? 'img' : undefined}>
        {content}
      </span>
    );
  }
  return (
    <button ref={ref} type="button" className={names} title={title} aria-label={collapsible ? title : undefined} onClick={onClick} {...buttonProps}>
      {content}
    </button>
  );
}
