import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { tUi } from '../strings/ui.ts';
import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';
import { focusableWithin, holdAppInert, trapTab } from './focus.ts';
import { IconClose } from './icons.tsx';

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button and a click on the backdrop (when `dismissible`). */
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  /** 'alertdialog' for confirmations of destructive or security-relevant actions. */
  role?: 'dialog' | 'alertdialog';
  /** false: only an explicit button closes it (no Escape, no backdrop, no close button). */
  dismissible?: boolean;
  /** Focused on open; default the first focusable element, else the dialog itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * A modal dialog: focus moves in and is trapped, the app behind becomes inert, Escape closes it, and focus returns to
 * whatever opened it.
 */
export function Dialog({ open, onClose, title, description, children, footer, role = 'dialog', dismissible = true, initialFocus, size = 'md', className }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = holdAppInert();
    const node = panel.current;
    if (node) {
      // The close button is the last resort: start on the content or the first real action.
      const target = initialFocus?.current ?? focusableWithin(node).find((el) => el.dataset['dialogClose'] === undefined) ?? node;
      target.focus();
    }
    return () => {
      release();
      if (previous && document.contains(previous)) previous.focus();
    };
    // `initialFocus` is read once, when the dialog opens.
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="ui-dialog-backdrop"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx('ui-dialog', `ui-dialog--${size}`, className)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && dismissible) {
            event.stopPropagation();
            onCloseRef.current();
            return;
          }
          if (panel.current) trapTab(event, panel.current);
        }}
      >
        <header className="ui-dialog__header">
          <h2 id={titleId} className="ui-dialog__title">
            {title}
          </h2>
          {dismissible ? (
            <IconButton label={tUi('dialog.close')} icon={<IconClose />} size="sm" onClick={() => onCloseRef.current()} data-dialog-close="" noTooltip />
          ) : null}
        </header>
        {description ? (
          <div id={descriptionId} className="ui-dialog__description">
            {description}
          </div>
        ) : null}
        {children ? <div className="ui-dialog__body">{children}</div> : null}
        {footer ? <footer className="ui-dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
