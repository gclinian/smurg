import { useId, type ReactNode } from 'react';
import { tUi } from '../strings/ui.ts';
import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';
import { IconChevronDown, IconChevronUp } from './icons.tsx';

export interface DrawerProps {
  /** Name of the region (from the catalogue), also its landmark label. */
  title: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Rendered in the header, e.g. Tabs for the bottom drawer. Replaces the title text when given. */
  header?: ReactNode;
  /** Header controls on the right. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A collapsible region docked at the bottom of the workbench. Collapsed, only its header stays visible; the content
 * is hidden (not unmounted), so terminals and feeds keep their state.
 */
export function Drawer({ title, open, onOpenChange, header, actions, children, className }: DrawerProps) {
  const contentId = useId();
  return (
    <section className={cx('ui-drawer', open ? 'ui-drawer--open' : 'ui-drawer--closed', className)} aria-label={title}>
      <div className="ui-drawer__header">
        <div className="ui-drawer__heading">{header ?? <h2 className="ui-drawer__title">{title}</h2>}</div>
        <div className="ui-drawer__actions">
          {actions}
          <IconButton
            label={open ? tUi('drawer.collapse', { name: title }) : tUi('drawer.expand', { name: title })}
            icon={open ? <IconChevronDown /> : <IconChevronUp />}
            size="sm"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => onOpenChange(!open)}
          />
        </div>
      </div>
      <div id={contentId} className="ui-drawer__content" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
