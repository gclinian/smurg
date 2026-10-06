// What the left column's data says outside the left column:
//   - ShellBanners: above the columns, the restart of the host's smurg ("4 items are paused. Continue all", DESIGN
//     §5.12 item 9) and the state of the host's Claude account;
//   - InboxNotices: a new "agents are waiting" item is announced politely (UX §11) and, when what it is about is on
//     no visible column (always in code mode), shown as a toast with "Open" (UX §7, §8). Nothing moves the focus.
import type { InboxItem } from '@smurg/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { columnId, isColumnRef } from '../../lib/columns/target.ts';
import { describeError } from '../../lib/errors.ts';
import { formatTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectAccount } from '../../lib/stores/host.ts';
import { selectPausedTopics } from '../../lib/stores/topics.ts';
import { selectClockSkew, selectUserId } from '../../lib/stores/workspace.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, useToast } from '../../ui/index.ts';
import { useOpenInboxItem } from './InboxList.tsx';
import { describeInboxItem, type InboxRowContext } from './inbox-rows.ts';
import { t } from './strings.ts';

export function ShellBanners() {
  const stores = useStores();
  const toast = useToast();
  const canDrive = useCan('session.drive');
  const paused = useStore(stores.topics, selectPausedTopics, (a, b) => a.length === b.length && a.every((topic, index) => topic.id === b[index]?.id));
  const pausedItems = useStore(stores.inbox, (state) => {
    let items = 0;
    for (const item of state.items.values()) if (item.kind === 'attention' && item.subject === 'plan-paused') items += item.count ?? 0;
    return items;
  });
  const account = useStore(stores.host, selectAccount);
  const [busy, setBusy] = useState(false);

  const continueAll = (): void => {
    setBusy(true);
    Promise.all(paused.map((topic) => stores.topics.resume(topic.id)))
      .catch((error: unknown) => toast.show({ tone: 'warning', title: t('restart.failed', { reason: describeError(error) }) }))
      .finally(() => setBusy(false));
  };

  const accountText =
    account === null || account.state === 'ok'
      ? null
      : account.state === 'logged-out'
        ? t('account.loggedOut')
        : account.resetsAt === undefined
          ? t('account.limit')
          : t('account.limit.at', { time: formatTime(account.resetsAt) });

  return (
    <>
      {paused.length > 0 ? (
        <Banner
          tone="warning"
          className="sidebar-banner"
          actions={
            canDrive ? (
              <Button size="sm" loading={busy} onClick={continueAll}>
                {t('restart.continue')}
              </Button>
            ) : undefined
          }
        >
          <span data-banner="restart">
            {pausedItems > 0 ? t('restart.items', { count: pausedItems }) : t('restart.plans', { count: paused.length })}
            {canDrive ? null : ` ${t('restart.who')}`}
          </span>
        </Banner>
      ) : null}
      {accountText !== null && account !== null ? (
        <Banner tone="warning" className="sidebar-banner">
          <span data-banner="account">
            {accountText}
            {account.sessions > 0 ? ` ${t('account.sessions', { count: account.sessions })}` : null}
          </span>
        </Banner>
      ) : null}
    </>
  );
}

export interface InboxNoticesProps {
  /** The sessions view is on screen (false: code mode, where every new waiting item shows a toast). */
  sessionsShown: boolean;
}

export function InboxNotices({ sessionsShown }: InboxNoticesProps) {
  const stores = useStores();
  const toast = useToast();
  const openItem = useOpenInboxItem();
  const open = useRef(openItem);
  open.current = openItem;
  const arrivals = useStore(stores.inbox, (state) => state.arrivals);
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef(arrivals.at(-1)?.id ?? 0);
  const shown = useRef(sessionsShown);
  shown.current = sessionsShown;

  const describe = useMemo(
    () =>
      (item: InboxItem): { title: string; where: string } => {
        const ctx: InboxRowContext = {
          sessions: stores.sessions.getState(),
          topics: stores.topics.getState(),
          selfUserId: selectUserId(stores.workspace.getState()),
          account: selectAccount(stores.host.getState()),
          // The host's clock, as the rows of the inbox count (lib/use-now.ts).
          now: Date.now() + selectClockSkew(stores.workspace.getState()),
          stores: { topics: stores.topics, sessions: stores.sessions },
        };
        return describeInboxItem(item, ctx);
      },
    [stores],
  );

  useEffect(() => {
    for (const arrival of arrivals) {
      if (arrival.id <= seen.current) continue;
      seen.current = arrival.id;
      const { item } = arrival;
      const row = describe(item);
      setAnnouncement(t('inbox.announce', { title: row.title, where: row.where }));
      const target = item.target;
      const onScreen = shown.current && isColumnRef(target) && stores.columns.getState().columns.some((column) => column.id === columnId(target));
      if (onScreen) continue;
      toast.show({
        tone: 'warning',
        title: t('inbox.toast', { title: row.title }),
        ...(row.where === '' ? {} : { description: row.where }),
        action: { label: t('inbox.toast.open'), onClick: () => open.current(item, false) },
      });
    }
  }, [arrivals, describe, stores.columns, toast]);

  return (
    <div className="ui-visually-hidden" role="status" aria-live="polite" data-inbox-announcer="">
      {announcement}
    </div>
  );
}
