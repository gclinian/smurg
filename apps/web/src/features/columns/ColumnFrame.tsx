// The frame of one column (UX §2): a region named by its title, the header (picture, title, the topic's name, pin,
// "More actions", close) and the body, which is the component a feature registered for this kind of thing
// (lib/slots.ts). The frame gives the body its context (lib/columns/context.tsx): whether the column is focused and
// on screen, and where an inbox item asked it to scroll.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ColumnContextProvider, type ColumnContextValue } from '../../lib/columns/context.tsx';
import { describeColumn, type ColumnDescription, type ColumnPicture } from '../../lib/columns/describe.ts';
import { columnBodyProps, type ColumnBodyProps, type ColumnKind, type ColumnRef } from '../../lib/columns/target.ts';
import { statusLabel } from '../../lib/session-status.ts';
import { useStore } from '../../lib/store.ts';
import type { ColumnAnchorRequest } from '../../lib/columns/context.tsx';
import { useStores } from '../../lib/workspace/context.tsx';
import { useSlots } from '../../lib/workspace/slots.tsx';
import { Button, EmptyState, IconButton, Menu, SlotBoundary, Spinner, StatusGlyph, cx, type MenuItem } from '../../ui/index.ts';
import { IconClose, IconFileText, IconGitMerge, IconMore, IconPin, IconPlan, IconReport, IconSessions, IconTerminal } from '../../ui/icons.tsx';
import { t } from './strings.ts';

/** The stores a column's name is read from, as one value that changes only when one of them does. */
export function useColumnDescription(target: ColumnRef): ColumnDescription {
  const stores = useStores();
  const sessions = useStore(stores.sessions);
  const topics = useStore(stores.topics);
  const worktrees = useStore(stores.worktrees);
  return useMemo(() => describeColumn(target, { sessions, topics, worktrees }), [target, sessions, topics, worktrees]);
}

export function ColumnPictureIcon({ picture, size = 16 }: { picture: ColumnPicture; size?: 14 | 16 }) {
  switch (picture.kind) {
    case 'status':
      return <StatusGlyph status={picture.status} label={statusLabel(picture.status)} size={size} />;
    case 'terminal':
      return <IconTerminal size={size} />;
    case 'spec':
      return <IconFileText size={size} />;
    case 'plan':
      return <IconPlan size={size} />;
    case 'report':
      return <IconReport size={size} />;
    case 'changes':
      return <IconGitMerge size={size} />;
    case 'unknown':
      return <IconSessions size={size} />;
  }
}

/** The name of a column for a screen reader and for the separator behind it: "Discussion · Checkout redesign". */
export function columnName(description: ColumnDescription): string {
  return description.discussion && description.topicName !== undefined ? t('title.topic', { title: description.title, topic: description.topicName }) : description.title;
}

export interface ColumnFrameProps {
  target: ColumnRef;
  id: string;
  place: 'strip' | 'code';
  focused: boolean;
  /** On screen (lib/columns/context.tsx `visible`). */
  visible: boolean;
  anchor: ColumnAnchorRequest | null;
  onAnchorShown(token: number): void;
  /** The column was clicked or tabbed into. */
  onFocusWithin?(): void;
  /** Header controls of the place: the strip's pin and close, code mode's session selector. */
  headerStart?: ReactNode;
  headerActions?(context: { title: string; menu: readonly MenuItem[] }): ReactNode;
  /** The frame's own items of "More actions" (before the body's). */
  menuItems?: readonly MenuItem[];
  onClose?(): void;
  /** Put the keyboard focus on the title when this changes to a new value (lib/stores/columns.ts `reveal`). */
  focusToken?: number | null;
}

function BodyOf<K extends ColumnKind>({ kind, Component, target }: { kind: K; Component: ComponentType<ColumnBodyProps[K]>; target: ColumnRef }) {
  const props = columnBodyProps(kind, target);
  return <Component {...(props as ColumnBodyProps[K] & object)} />;
}

export function ColumnFrame({ target, id, place, focused, visible, anchor, onAnchorShown, onFocusWithin, headerStart, headerActions, menuItems, onClose, focusToken }: ColumnFrameProps) {
  const slots = useSlots();
  const description = useColumnDescription(target);
  const title = useRef<HTMLHeadingElement>(null);
  const [headerExtraNode, setHeaderExtraNode] = useState<HTMLElement | null>(null);
  const [bodyMenus, setBodyMenus] = useState<ReadonlyMap<object, readonly MenuItem[]>>(new Map());

  const setMenuItems = useCallback((owner: object, items: readonly MenuItem[] | null) => {
    setBodyMenus((previous) => {
      if (items === null) {
        if (!previous.has(owner)) return previous;
        const next = new Map(previous);
        next.delete(owner);
        return next;
      }
      if (previous.get(owner) === items) return previous;
      return new Map(previous).set(owner, items);
    });
  }, []);

  const anchorToken = anchor?.token;
  const anchorShown = useCallback(() => {
    if (anchorToken !== undefined) onAnchorShown(anchorToken);
  }, [anchorToken, onAnchorShown]);

  const context = useMemo<ColumnContextValue>(
    () => ({ id, target, place, focused, visible, anchor, anchorShown, headerExtraNode, setMenuItems }),
    [id, target, place, focused, visible, anchor, anchorShown, headerExtraNode, setMenuItems],
  );

  // Opened (or opened again, or the neighbour of a closed column): the focus goes to the title. A body that was
  // asked for a card moves it on to the card.
  useEffect(() => {
    if (focusToken === undefined || focusToken === null) return;
    title.current?.focus();
  }, [focusToken]);

  const name = columnName(description);
  const Component = description.kind === null ? null : slots.column(description.kind);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const menu: MenuItem[] = [...(menuItems ?? []), ...[...bodyMenus.values()].flat()];

  // The body as an element that changes only when what it shows changes: the frame's own state (the menu a body
  // registered, the header node) must not render the body again.
  const kind = description.kind;
  const gone = description.gone;
  const body = useMemo((): ReactNode => {
    if (gone) {
      const text = target.kind === 'session' ? t('gone.session') : target.kind === 'changes' ? t('gone.changes') : t('gone.topic');
      return (
        <div className="col-note" role="status">
          <p>{text}</p>
          {onCloseRef.current ? (
            <Button size="sm" onClick={() => onCloseRef.current?.()}>
              {t('gone.close')}
            </Button>
          ) : null}
        </div>
      );
    }
    if (kind === null) {
      // A session whose kind the list has not told yet.
      return (
        <div className="col-note">
          <Spinner label={t('waiting', { title: name })} />
        </div>
      );
    }
    if (Component === null) {
      return (
        <div className="col-note" data-column-placeholder={kind}>
          <EmptyState compact title={t('placeholder.title', { title: name })} description={t('placeholder.body')} />
        </div>
      );
    }
    return (
      <SlotBoundary name={name}>
        <Suspense
          fallback={
            <div className="col-note">
              <Spinner label={t('waiting', { title: name })} />
            </div>
          }
        >
          <BodyOf kind={kind} Component={Component as ComponentType<ColumnBodyProps[ColumnKind]>} target={target} />
        </Suspense>
      </SlotBoundary>
    );
  }, [gone, kind, Component, target, name]);

  return (
    <section
      className={cx('col', `col--${place}`)}
      aria-label={name}
      data-column-id={id}
      data-kind={description.kind ?? 'unknown'}
      data-focused={focused ? '' : undefined}
      data-discussion={description.discussion ? '' : undefined}
      data-region=""
      onFocusCapture={onFocusWithin}
      onPointerDownCapture={onFocusWithin}
    >
      <header className="col-head">
        <span className="col-head__icon">
          <ColumnPictureIcon picture={description.picture} />
        </span>
        {headerStart}
        <h2
          ref={title}
          className="col-head__title"
          tabIndex={0}
          title={onClose ? t('title.hint', { title: name }) : name}
          data-region-focus=""
          onKeyDown={(event) => {
            if (event.key !== 'Delete' || !onClose || event.target !== event.currentTarget) return;
            event.preventDefault();
            onClose();
          }}
        >
          <span className="col-head__title-text">{description.title}</span>
        </h2>
        {description.topicName !== undefined ? <span className="col-head__sub">{description.topicName}</span> : null}
        <div className="col-head__extra" ref={setHeaderExtraNode} />
        <div className="col-head__actions">{headerActions?.({ title: name, menu })}</div>
      </header>
      <ColumnContextProvider value={context}>
        <div className="col-body">{body}</div>
      </ColumnContextProvider>
    </section>
  );
}

/** The strip's header buttons: pin, "More actions", close. */
export function StripHeaderActions({ title, menu, pinned, onPin, onClose }: { title: string; menu: readonly MenuItem[]; pinned: boolean; onPin(pinned: boolean): void; onClose(): void }) {
  return (
    <>
      <IconButton
        className="col-head__pin"
        label={pinned ? t('unpin', { title }) : t('pin', { title })}
        icon={<IconPin />}
        size="sm"
        pressed={pinned}
        onClick={() => onPin(!pinned)}
      />
      <Menu label={t('more', { title })} icon={<IconMore />} size="sm" items={menu} />
      <IconButton label={t('close', { title })} icon={<IconClose />} size="sm" onClick={onClose} />
    </>
  );
}
