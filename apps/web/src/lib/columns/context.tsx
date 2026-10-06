// What a column's body knows about the frame around it. The frame (features/columns in the sessions view, the side
// column of code mode) provides it; a kind's component reads it with useColumn():
//
//   const column = useColumn();
//   conversations.watch(sessionId, { live: column.visible });          // watch live only while on screen
//   useEffect(() => { if (column.anchor) { scrollTo(column.anchor); column.anchorShown(); } }, [column.anchor]);
//   <ColumnMenuItems items={[{ id: 'rename', label: t('rename'), onSelect: … }]} />   // into "More actions"
//   <ColumnHeaderExtra><Badge>Attempt 2 of 2</Badge></ColumnHeaderExtra>             // into the header, after the title
//
// The frame owns the header (icon, title as the region's h2, the topic's name, pin, "More actions", close); a body
// never draws a second title.
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItem } from '../../ui/Menu.tsx';
import type { ColumnAnchor, ColumnRef } from './target.ts';

/** An anchor request: a new object for every request, so an effect keyed on it runs again for the same card. */
export interface ColumnAnchorRequest extends ColumnAnchor {
  readonly token: number;
}

export interface ColumnContextValue {
  /** `columnId(target)`. */
  readonly id: string;
  readonly target: ColumnRef;
  /** `strip`: a column of the sessions view. `code`: the one session column beside the editor in code mode. */
  readonly place: 'strip' | 'code';
  /** The focused column: where a click on the left opens; only its composer has the accent border. */
  readonly focused: boolean;
  /**
   * On screen: its mode is the one shown and it is not scrolled out of the strip. A hidden column stays mounted and
   * current; it should not ask for streaming deltas (`session.watch { live: false }`).
   */
  readonly visible: boolean;
  /** Where an inbox item (or a link) led: scroll there, focus it, outline it for a moment. Null: nothing asked. */
  readonly anchor: ColumnAnchorRequest | null;
  /** The body showed the anchor (or cannot): the request is dropped. */
  anchorShown(): void;
  /** Internal: the node ColumnHeaderExtra renders into. */
  readonly headerExtraNode: HTMLElement | null;
  /** Internal: ColumnMenuItems registers its items under an owner key. */
  setMenuItems(owner: object, items: readonly MenuItem[] | null): void;
}

const ColumnContext = createContext<ColumnContextValue | null>(null);

export function ColumnContextProvider({ value, children }: { value: ColumnContextValue; children: ReactNode }) {
  return <ColumnContext.Provider value={value}>{children}</ColumnContext.Provider>;
}

/** The column this component is the body of. Throws outside a column: a body is always rendered by a frame. */
export function useColumn(): ColumnContextValue {
  const value = useContext(ColumnContext);
  if (!value) throw new Error('useColumn() outside a column');
  return value;
}

/** The same, or null (a component that is also used outside a column, e.g. in a dialog). */
export function useOptionalColumn(): ColumnContextValue | null {
  return useContext(ColumnContext);
}

/**
 * Adds items to the column header's "More actions" menu, after the frame's own ("Close the other columns"). Renders
 * nothing; the items go when the component unmounts. A fresh array on every render is fine: the frame is told only
 * when what the menu SHOWS changes (ids, labels, disabled / checked / danger, hints), and a chosen item always runs the
 * latest `onSelect`.
 */
export function ColumnMenuItems({ items }: { items: readonly MenuItem[] }): null {
  const column = useOptionalColumn();
  const owner = useRef<object>({});
  const latest = useRef(items);
  latest.current = items;
  const setMenuItems = column?.setMenuItems;
  const shown = items.map((item) => [item.id, item.label, item.hint ?? '', item.disabled ? 1 : 0, item.checked ?? '', item.danger ? 1 : 0].join('\u0000')).join('\u0001');
  useEffect(() => {
    if (!setMenuItems) return;
    const key = owner.current;
    setMenuItems(
      key,
      latest.current.map((item) => ({ ...item, onSelect: () => latest.current.find((current) => current.id === item.id)?.onSelect() })),
    );
    return () => setMenuItems(key, null);
  }, [setMenuItems, shown]);
  return null;
}

/** Renders its children inside the column's header, between the title and the header's buttons. */
export function ColumnHeaderExtra({ children }: { children: ReactNode }) {
  const column = useOptionalColumn();
  if (!column?.headerExtraNode) return null;
  return createPortal(children, column.headerExtraNode);
}
