// The inbox of the left column (UX §3.1, §7): two groups, a row per thing that waits. A row opens what it is about
// (Enter or a click; Shift for "to the side") and marks it seen; a row may offer one action of its own ("Continue",
// "Continue all"); a mention or a result can be dismissed. One tab stop for the whole list: Up and Down move between
// rows; Tab goes on to the row's own action.
import { isSmurgError, type ColumnTarget, type InboxItem } from '@smurg/protocol';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { columnId, isColumnRef } from '../../lib/columns/target.ts';
import { describeError } from '../../lib/errors.ts';
import { formatAge, formatDateTime } from '../../lib/format.ts';
import { kindLabel } from '../../lib/session-status.ts';
import type { InboxRowView } from '../../lib/slots.ts';
import { useStore } from '../../lib/store.ts';
import { selectInboxGroups } from '../../lib/stores/inbox.ts';
import { selectAccount } from '../../lib/stores/host.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCapabilities, useCommand, useStores } from '../../lib/workspace/context.tsx';
import { useSlotEnv, useSlots } from '../../lib/workspace/slots.tsx';
import { useNow } from '../../lib/use-now.ts';
import { Button, IconButton, KindIcon, cx, useToast } from '../../ui/index.ts';
import { IconCheck, IconClose } from '../../ui/icons.tsx';
import { describeInboxItem, inboxTarget, isDismissable, plansToLoad, reportNeededFor, type InboxRowContext } from './inbox-rows.ts';
import { t } from './strings.ts';

export interface InboxRow {
  readonly item: InboxItem;
  readonly view: InboxRowView;
  /** Where the row leads (`inboxTarget`): not always the target the item names. */
  readonly target: ColumnTarget;
}

/** The member's inbox as rows, in the order of the two groups. */
export function useInboxRows(): { waiting: InboxRow[]; look: InboxRow[]; now: number } {
  const stores = useStores();
  const slots = useSlots();
  const env = useSlotEnv();
  const inbox = useStore(stores.inbox);
  const sessions = useStore(stores.sessions);
  const topics = useStore(stores.topics);
  const selfUserId = useStore(stores.workspace, selectUserId);
  const account = useStore(stores.host, selectAccount);
  const now = useNow();
  // Why an item stopped is in the topic's plan: the rows ask for the plans they read.
  const neededPlans = plansToLoad(inbox.items.values(), topics).join('\n');
  useEffect(() => {
    for (const topicId of neededPlans === '' ? [] : neededPlans.split('\n')) stores.topics.ensurePlan(topicId);
  }, [neededPlans, stores.topics]);
  return useMemo(() => {
    const ctx: InboxRowContext = { sessions, topics, selfUserId, account, now, stores: { topics: stores.topics, sessions: stores.sessions } };
    const groups = selectInboxGroups(inbox, selfUserId);
    const row = (item: InboxItem): InboxRow => ({ item, view: slots.inboxRow(item, describeInboxItem(item, ctx), env), target: inboxTarget(item, topics) });
    return { waiting: groups.waiting.map(row), look: groups.look.map(row), now };
  }, [inbox, sessions, topics, selfUserId, account, now, stores.topics, stores.sessions, slots, env]);
}

/** Opens what an inbox item is about and marks it seen. */
export function useOpenInboxItem(): (item: InboxItem, side: boolean) => void {
  const stores = useStores();
  const openColumn = useCommand('openColumn');
  const toast = useToast();
  return (item, side) => {
    stores.inbox.seen([item.key]);
    const open = (): void => {
      openColumn({ target: inboxTarget(item, stores.topics.getState()), from: 'inbox', ...(side ? { side: true } : {}), ...(item.anchor === undefined ? {} : { anchor: item.anchor }) }).catch((error: unknown) =>
        toast.show({ tone: 'warning', title: t('inbox.failed', { reason: describeError(error) }) }),
      );
    };
    // Where a work item's merge row leads is in the item's result report (which request its "Merge…" opens): the
    // click reads it first. A report that does not exist or cannot be read leaves the target the item names.
    const missing = reportNeededFor(item, stores.topics.getState());
    if (missing === null) open();
    else void stores.topics.loadReport(missing.topicId, missing.itemId).then(open, open);
  };
}

export function InboxList() {
  const stores = useStores();
  const caps = useCapabilities();
  const toast = useToast();
  const { waiting, look, now } = useInboxRows();
  const focusedColumn = useStore(stores.columns, (state) => state.focusedId);
  const open = useOpenInboxItem();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const all = [...waiting, ...look];
  if (all.length === 0) {
    return (
      <p className="sidebar-empty" data-inbox-empty="">
        <IconCheck size={14} />
        {caps.role === 'viewer' ? t('inbox.empty.viewer') : t('inbox.empty')}
      </p>
    );
  }
  const tabStop = activeKey !== null && all.some((row) => row.item.key === activeKey) ? activeKey : (all[0] as InboxRow).item.key;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: InboxRow | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = all[index + 1];
        break;
      case 'ArrowUp':
        next = all[index - 1];
        break;
      case 'Home':
        next = all[0];
        break;
      case 'End':
        next = all[all.length - 1];
        break;
      case 'Enter':
        // Shift+Enter: to the side. (A plain Enter is the button's own click.)
        if (!event.shiftKey) return;
        open((all[index] as InboxRow).item, true);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    setActiveKey(next.item.key);
    buttons.current.get(next.item.key)?.focus();
  };

  const run = (row: InboxRow): void => {
    const action = row.view.action;
    if (!action) return;
    setBusy(row.item.key);
    Promise.resolve()
      .then(() => action.run())
      .catch((error: unknown) => toast.show({ tone: 'warning', title: t('inbox.failed', { reason: describeError(error) }) }))
      .finally(() => setBusy((current) => (current === row.item.key ? null : current)));
  };

  const dismiss = (row: InboxRow): void => {
    stores.inbox.dismiss(row.item.key).catch((error: unknown) => {
      // Settled or dismissed elsewhere meanwhile: it is gone, which is what was asked.
      if (isSmurgError(error) && error.code === 'not_found') return;
      toast.show({ tone: 'warning', title: t('inbox.failed', { reason: describeError(error) }) });
    });
  };

  const renderRow = (row: InboxRow): ReactNode => {
    const { item, view, target } = row;
    const index = all.indexOf(row);
    const kind = kindLabel(item.kind);
    const age = formatAge(item.at, now);
    const current = isColumnRef(target) && columnId(target) === focusedColumn;
    const active = item.key === tabStop;
    return (
      <li key={item.key} className="inbox-item" data-kind={item.kind} data-unread={item.unread ? '' : undefined} data-current={current ? '' : undefined} data-inbox-key={item.key}>
        <button
          ref={(node) => {
            if (node) buttons.current.set(item.key, node);
            else buttons.current.delete(item.key);
          }}
          type="button"
          className="inbox-item__main"
          tabIndex={active ? 0 : -1}
          aria-current={current ? 'true' : undefined}
          aria-label={t(item.unread ? 'inbox.row.unread' : 'inbox.row', { kind, title: view.title, where: view.where, age })}
          onFocus={() => setActiveKey(item.key)}
          onKeyDown={(event) => move(event, index)}
          onClick={(event: MouseEvent<HTMLButtonElement>) => open(item, event.shiftKey)}
        >
          <KindIcon kind={item.kind} label={kind} />
          <span className="inbox-item__text">
            <span className={cx('inbox-item__title', view.mono && 'inbox-item__title--mono')}>{view.title}</span>
            {view.where === '' ? null : <span className="inbox-item__where">{view.where}</span>}
          </span>
          <span className="inbox-item__age" title={formatDateTime(item.at)}>
            {age}
          </span>
        </button>
        {view.action || isDismissable(item) ? (
          <span className="inbox-item__actions">
            {view.action ? (
              <Button size="sm" variant="secondary" tabIndex={active ? 0 : -1} loading={busy === item.key} data-inbox-action={view.action.id} onClick={() => run(row)}>
                {view.action.label}
              </Button>
            ) : null}
            {isDismissable(item) ? (
              <IconButton label={t('inbox.dismiss', { title: view.title })} icon={<IconClose size={12} />} size="sm" tabIndex={active ? 0 : -1} onClick={() => dismiss(row)} />
            ) : null}
          </span>
        ) : null}
      </li>
    );
  };

  return (
    <div className="inbox">
      {waiting.length > 0 ? (
        <>
          <h3 className="inbox__group" id="inbox-group-waiting">
            {t('inbox.group.waiting')}
            <span aria-hidden="true">{waiting.length}</span>
          </h3>
          <ul className="inbox__list" aria-labelledby="inbox-group-waiting" data-inbox-group="waiting">
            {waiting.map(renderRow)}
          </ul>
        </>
      ) : null}
      {look.length > 0 ? (
        <>
          <h3 className="inbox__group" id="inbox-group-look">
            {t('inbox.group.look')}
            <span aria-hidden="true">{look.length}</span>
          </h3>
          <ul className="inbox__list" aria-labelledby="inbox-group-look" data-inbox-group="look">
            {look.map(renderRow)}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** The first things that wait, with "Open": the empty right side says what to do next (UX §12). */
export function InboxPreview({ limit = 3 }: { limit?: number }) {
  const { waiting, look, now } = useInboxRows();
  const open = useOpenInboxItem();
  const rows = (waiting.length > 0 ? waiting : look).slice(0, limit);
  if (rows.length === 0) return null;
  return (
    <section className="inbox-preview" aria-labelledby="inbox-preview-title">
      <h3 className="inbox-preview__title" id="inbox-preview-title">
        {t('inbox.preview')}
      </h3>
      <ul className="inbox__list">
        {rows.map(({ item, view }) => (
          <li key={item.key} className="inbox-item inbox-item--preview" data-kind={item.kind}>
            <span className="inbox-item__main inbox-item__main--static">
              <KindIcon kind={item.kind} label={kindLabel(item.kind)} />
              <span className="inbox-item__text">
                <span className={cx('inbox-item__title', view.mono && 'inbox-item__title--mono')}>{view.title}</span>
                {view.where === '' ? null : <span className="inbox-item__where">{view.where}</span>}
              </span>
              <span className="inbox-item__age">{formatAge(item.at, now)}</span>
            </span>
            <span className="inbox-item__actions">
              <Button size="sm" onClick={() => open(item, false)} aria-label={`${t('inbox.preview.open')}: ${view.title}`}>
                {t('inbox.preview.open')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
