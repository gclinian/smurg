// The activity feed (SPEC R8.5 "every change by an agent appears in the activity feed, naming the agent and whose it is", R11): live, newest first,
// who (a member, "Claude (owner)", or an outside process) did what to which file. Clicking a file opens it in the editor
// (openFile command); a conflict entry leads to the conflict panel. Notifications an agent sent to this member with
// the coordination tool "notify a member" are shown above the feed until dismissed.
import type { ActivityEvent, FileRef, MemberNotification } from '@smurg/protocol';
import { useState } from 'react';
import { NoCommandHandlerError, type CommandMap, type CommandName } from '../../lib/commands.ts';
import { describeError, renderWireText } from '../../lib/errors.ts';
import { formatActor, formatDateTime, formatRelativeTime } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectActivityEvents, selectNotifications } from '../../lib/stores/activity.ts';
import { selectWorktreeList } from '../../lib/stores/worktrees.ts';
import { useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, EmptyState, Select, Spinner, cx, useToast } from '../../ui/index.ts';
import { IconActivity, IconAgent, IconAlertTriangle, IconFileText, IconTerminal, IconUser } from '../../ui/icons.tsx';
import { actorLabel, canOpenFileOf, FEED_FILTERS, filterLabel, kindLabel, kindTone, matchesFilter, viaShellCommand, type FeedFilter } from './feed-model.ts';
import { t } from './strings.ts';
import { useNow } from './use-now.ts';

export function ActivityFeed() {
  const { activity, worktrees } = useStores();
  const commands = useCommands();
  const toast = useToast();
  const events = useStore(activity, selectActivityEvents);
  const notifications = useStore(activity, selectNotifications);
  const status = useStore(activity, (state) => ({ status: state.status, error: state.error, hasMore: state.hasMore, loadingOlder: state.loadingOlder }), shallowEqual);
  const worktreeList = useStore(worktrees, selectWorktreeList, shallowEqual);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const now = useNow(30_000);

  const dispatch = <K extends CommandName>(name: K, payload: CommandMap[K]): void => {
    commands.dispatch(name, payload).catch((error: unknown) => {
      if (!(error instanceof NoCommandHandlerError)) toast.show({ tone: 'danger', title: describeError(error) });
    });
  };

  const fileLabel = (file: FileRef): string => {
    if (file.root.kind === 'main') return file.path;
    const { worktreeId } = file.root;
    const worktree = worktreeList.find((w) => w.id === worktreeId);
    return t('feed.inWorktree', { path: file.path, name: worktree ? `${worktree.ownerName} · ${worktree.branch}` : worktreeId });
  };

  const shown = events.filter((event) => matchesFilter(event, filter));

  let body;
  if (events.length === 0 && (status.status === 'loading' || status.status === 'idle')) {
    body = (
      <div className="activity-status">
        <Spinner label={t('feed.loading')} />
      </div>
    );
  } else if (events.length === 0 && status.status === 'error') {
    body = (
      <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={() => void activity.reload().catch(() => {})}>{t('feed.retry')}</Button>}>
        {t('feed.error', { message: status.error ?? '' })}
      </Banner>
    );
  } else if (shown.length === 0) {
    body = <EmptyState compact icon={<IconActivity size={20} />} title={events.length === 0 ? t('feed.empty') : t('feed.emptyFiltered')} description={events.length === 0 ? t('feed.emptyHint') : undefined} />;
  } else {
    body = (
      <ol className="activity-feed" aria-label={t('feed.label')}>
        {shown.map((event) => (
          <FeedItem
            key={event.id}
            event={event}
            now={now}
            fileLabel={fileLabel}
            onOpen={(file) => dispatch('openFile', { file })}
            onShowConflicts={() => dispatch('showPanel', { panel: 'conflicts' })}
          />
        ))}
      </ol>
    );
  }

  return (
    <div className="activity-panel">
      <div className="activity-toolbar">
        <Select<FeedFilter>
          label={t('filter.label')}
          hideLabel
          options={FEED_FILTERS.map((value) => ({ value, label: filterLabel(value) }))}
          value={filter}
          onChange={setFilter}
        />
      </div>
      {notifications.length > 0 ? (
        <section className="activity-notifications" aria-label={t('notify.label')}>
          {notifications.map((notification) => (
            <Notification
              key={notification.id}
              notification={notification}
              onOpen={(file) => dispatch('openFile', { file })}
              onDismiss={() => activity.dismissNotification(notification.id)}
            />
          ))}
        </section>
      ) : null}
      {body}
      {status.hasMore && shown.length > 0 ? (
        <div className="activity-more">
          <Button size="sm" variant="ghost" loading={status.loadingOlder} onClick={() => void activity.loadOlder().catch((error: unknown) => toast.show({ tone: 'danger', title: describeError(error) }))}>
            {t('feed.older')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ActorIcon({ event }: { event: ActivityEvent }) {
  if (event.actor.kind === 'agent') return <IconAgent size={14} />;
  if (event.actor.kind === 'user') return <IconUser size={14} />;
  return event.kind === 'external.change' ? <IconTerminal size={14} /> : <IconAlertTriangle size={14} />;
}

interface FeedItemProps {
  readonly event: ActivityEvent;
  readonly now: number;
  fileLabel(file: FileRef): string;
  onOpen(file: FileRef): void;
  onShowConflicts(): void;
}

function FeedItem({ event, now, fileLabel, onOpen, onShowConflicts }: FeedItemProps) {
  const file = event.file;
  return (
    <li className={cx('activity-item', `activity-item--${event.actor.kind}`)} data-kind={event.kind}>
      <span className="activity-item__icon" aria-hidden="true">
        <ActorIcon event={event} />
      </span>
      <div className="activity-item__main">
        <div className="activity-item__head">
          <span className="activity-item__actor">{actorLabel(event.actor)}</span>
          <Badge tone={kindTone(event.kind)}>{kindLabel(event.kind)}</Badge>
          {viaShellCommand(event) ? (
            <span className="activity-item__via" title={t('via.shellHint', { agent: actorLabel(event.actor) })} data-testid="activity-via-shell">
              <IconTerminal size={11} aria-hidden="true" />
              {t('via.shell')}
              <span className="ui-visually-hidden">{t('via.shellHint', { agent: actorLabel(event.actor) })}</span>
            </span>
          ) : null}
          <time className="activity-item__time" dateTime={new Date(event.at).toISOString()} title={formatDateTime(event.at)}>
            {formatRelativeTime(event.at, Math.max(now, event.at))}
          </time>
        </div>
        {/* The host's sentence, in the viewer's language (the wire reference); its English `summary` when this build
            does not know the message. */}
        <p className="activity-item__summary">{renderWireText(event.text, event.summary)}</p>
        {file !== undefined || event.kind === 'conflict' ? (
          <div className="activity-item__links">
            {file !== undefined && canOpenFileOf(event) ? (
              <button type="button" className="activity-item__file" aria-label={t('feed.openFile', { path: fileLabel(file) })} onClick={() => onOpen(file)}>
                <IconFileText size={12} aria-hidden="true" />
                <span>{fileLabel(file)}</span>
              </button>
            ) : file !== undefined ? (
              <span className="activity-item__file activity-item__file--gone">{t('feed.deletedFile', { path: fileLabel(file) })}</span>
            ) : null}
            {event.kind === 'conflict' ? (
              <Button size="sm" variant="ghost" onClick={onShowConflicts}>
                {t('feed.showConflicts')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Notification({ notification, onOpen, onDismiss }: { notification: MemberNotification; onOpen(file: FileRef): void; onDismiss(): void }) {
  const file = notification.file;
  return (
    <Banner
      tone="info"
      // A notice the host's smurg wrote itself comes from `system`: named "smurg", not "an outside program".
      title={t('notify.title', { from: formatActor(notification.from) })}
      actions={
        <>
          {file !== undefined ? (
            <Button size="sm" onClick={() => onOpen(file)}>
              {t('notify.open')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('notify.dismiss')}
          </Button>
        </>
      }
    >
      {/* An agent's own words are shown as written; a notice smurg wrote is a wire reference. */}
      {notification.text ?? renderWireText(notification.msg, notification.fallback ?? '')}
    </Banner>
  );
}
