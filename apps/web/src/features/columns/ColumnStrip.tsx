// The strip of up to four columns on the right of the sessions view (UX §2, §9): the open columns of the columns
// store in their order, each in its frame, with draggable dividers (ui/Columns). The strip tells the store how many
// columns fit and which are on screen, marks what a visible column shows as seen (a row is bold only for what
// happened since), and says so when a fifth column is refused.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeColumn } from '../../lib/columns/describe.ts';
import { useStore } from '../../lib/store.ts';
import type { OpenColumn } from '../../lib/stores/columns.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tUi } from '../../strings/ui.ts';
import { Columns, useToast, type ColumnsItem, type MenuItem } from '../../ui/index.ts';
import { IconClose, IconPin } from '../../ui/icons.tsx';
import { ColumnFrame, StripHeaderActions, columnName, useColumnDescription } from './ColumnFrame.tsx';
import { t } from './strings.ts';
import './columns.css';

export interface ColumnStripProps {
  /** The sessions view is the mode on screen (false: code mode is shown; the columns stay mounted and hidden). */
  shown: boolean;
  /** Shown instead of the strip while no column is open. */
  empty: ReactNode;
  /** The last column was closed: the focus goes back to the session list. */
  onLastClosed?(): void;
  /** The DOM id of the strip (the skip link's target). */
  id?: string;
}

export function ColumnStrip({ shown, empty, onLastClosed, id }: ColumnStripProps) {
  const stores = useStores();
  const toast = useToast();
  const state = useStore(stores.columns);
  const sessions = useStore(stores.sessions);
  const topics = useStore(stores.topics);
  const worktrees = useStore(stores.worktrees);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string> | null>(null);

  // A refused fifth column is said once.
  const refusal = state.refusal;
  const saidRefusal = useRef(refusal?.id ?? 0);
  useEffect(() => {
    if (refusal === null || refusal.id === saidRefusal.current) return;
    saidRefusal.current = refusal.id;
    toast.show({ tone: 'warning', title: t('refused') });
  }, [refusal, toast]);

  const close = useCallback(
    (columnId: string): void => {
      const next = stores.columns.close(columnId);
      if (next === null) onLastClosed?.();
    },
    [stores.columns, onLastClosed],
  );

  const reveal = state.reveal;
  const items: ColumnsItem[] = useMemo(
    () =>
      state.columns.map((column) => ({
        id: column.id,
        weight: column.weight,
        label: columnName(describeColumn(column.target, { sessions, topics, worktrees })),
        node: (
          <StripColumn
            column={column}
            focused={state.focusedId === column.id}
            visible={shown && (onScreen === null || onScreen.has(column.id))}
            alone={state.columns.length === 1}
            focusToken={reveal !== null && reveal.id === column.id ? reveal.token : null}
            onClose={close}
          />
        ),
      })),
    [state.columns, state.focusedId, sessions, topics, worktrees, shown, onScreen, reveal, close],
  );

  return (
    <Columns
      {...(id === undefined ? {} : { id })}
      columns={items}
      empty={empty}
      reveal={reveal}
      onWeights={(weights) => stores.columns.setWeights(weights)}
      onEqualize={() => stores.columns.equalize()}
      onCapacity={(count) => stores.columns.setCapacity(count)}
      onVisible={(ids) => setOnScreen(new Set(ids))}
      separatorLabel={(column) => tUi('columns.resize', { name: column })}
      moreLabel={(count) => tUi('columns.more', { count })}
    />
  );
}

interface StripColumnProps {
  column: OpenColumn;
  focused: boolean;
  visible: boolean;
  /** The only open column: there are no others to close. */
  alone: boolean;
  focusToken: number | null;
  onClose(id: string): void;
}

function StripColumn({ column, focused, visible, alone, focusToken, onClose }: StripColumnProps) {
  const stores = useStores();
  const anchor = useStore(stores.columns, (state) => state.anchors.get(column.id) ?? null);
  const description = useColumnDescription(column.target);

  // What this browser shows now is "seen": the row of the session list is bold only for what happens afterwards.
  const session = description.session;
  const noteworthyAt = session?.kind === 'agent' ? session.noteworthyAt : undefined;
  const specAt = column.target.kind === 'spec' ? description.topic?.spec.changedAt : undefined;
  const planAt = column.target.kind === 'plan' ? description.topic?.plan.changedAt : undefined;
  useEffect(() => {
    if (!visible) return;
    if (column.target.kind === 'session' && noteworthyAt !== undefined) stores.columns.markSeen('session', column.target.sessionId, noteworthyAt);
    if (column.target.kind === 'spec' && specAt !== undefined) stores.columns.markSeen('spec', column.target.topicId, specAt);
    if (column.target.kind === 'plan' && planAt !== undefined) stores.columns.markSeen('plan', column.target.topicId, planAt);
  }, [visible, column.target, noteworthyAt, specAt, planAt, stores.columns]);

  const menuItems: MenuItem[] = [
    column.pinned
      ? { id: 'unpin', label: t('unpin.item'), icon: <IconPin />, onSelect: () => stores.columns.setPinned(column.id, false) }
      : { id: 'pin', label: t('pin.item'), icon: <IconPin />, onSelect: () => stores.columns.setPinned(column.id, true) },
    { id: 'close-others', label: t('closeOthers'), icon: <IconClose />, disabled: alone, onSelect: () => stores.columns.closeOthers(column.id) },
  ];

  return (
    <ColumnFrame
      target={column.target}
      id={column.id}
      place="strip"
      focused={focused}
      visible={visible}
      anchor={anchor}
      onAnchorShown={(token) => stores.columns.clearAnchor(column.id, token)}
      onFocusWithin={() => stores.columns.focus(column.id)}
      menuItems={menuItems}
      onClose={() => onClose(column.id)}
      focusToken={focusToken}
      headerActions={({ title, menu }) => (
        <StripHeaderActions title={title} menu={menu} pinned={column.pinned} onPin={(pinned) => stores.columns.setPinned(column.id, pinned)} onClose={() => onClose(column.id)} />
      )}
    />
  );
}
