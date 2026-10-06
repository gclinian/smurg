// The left column of the sessions view (UX §1, §3): the inbox above the session list, both collapsible, or a rail
// of three buttons when the column is folded away.
import { useState, type Ref } from 'react';
import { NoCommandHandlerError, type CommandMap, type CommandName } from '../../lib/commands.ts';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { SESSION_FILTERS, type SessionFilter } from '../../lib/stores/columns.ts';
import { selectInboxCounts } from '../../lib/stores/inbox.ts';
import { useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Collapsible, IconButton, Menu, Segmented, useToast } from '../../ui/index.ts';
import { IconAgent, IconInbox, IconPlus, IconSessions, IconTerminal } from '../../ui/icons.tsx';
import { InboxList } from './InboxList.tsx';
import { SessionTree } from './SessionTree.tsx';
import { t } from './strings.ts';
import { buildSessionTree } from './tree-model.ts';
import './sidebar.css';

export type SidebarSection = 'inbox' | 'sessions';

export interface SidebarProps {
  /** Folded to the rail. */
  collapsed: boolean;
  /** A rail button was pressed: show the column (and that section). */
  onExpand(section: SidebarSection): void;
  inboxOpen: boolean;
  sessionsOpen: boolean;
  onToggle(section: SidebarSection, open: boolean): void;
  /** The toggle buttons of the two sections: where F6 lands. */
  inboxRef?: Ref<HTMLButtonElement>;
  sessionsRef?: Ref<HTMLButtonElement>;
}

/** The two counts as they show on a header, a rail button and the mode switch: amber for waiting, neutral for the rest. */
export function InboxCounts({ waiting, look }: { waiting: number; look: number }) {
  if (waiting === 0 && look === 0) return null;
  return (
    <span className="inbox-counts" title={t('inbox.counts', { waiting, look })}>
      {waiting > 0 ? (
        <span className="ui-count ui-count--waiting" data-count="waiting" aria-hidden="true">
          {waiting}
        </span>
      ) : null}
      {look > 0 ? (
        <span className="ui-count" data-count="look" aria-hidden="true">
          {look}
        </span>
      ) : null}
      <span className="ui-visually-hidden">{t('inbox.counts', { waiting, look })}</span>
    </span>
  );
}

/** Dispatches a command a feature handles; says so when this build has no such feature. */
function useFeatureCommand(): <K extends CommandName>(name: K, payload: CommandMap[K]) => void {
  const commands = useCommands();
  const toast = useToast();
  return (name, payload) => {
    commands.dispatch(name, payload).catch((error: unknown) => {
      toast.show({ tone: 'warning', title: error instanceof NoCommandHandlerError ? t('sessions.new.unavailable') : describeError(error) });
    });
  };
}

export function Sidebar({ collapsed, onExpand, inboxOpen, sessionsOpen, onToggle, inboxRef, sessionsRef }: SidebarProps) {
  const stores = useStores();
  const toast = useToast();
  const run = useFeatureCommand();
  const counts = useStore(stores.inbox, selectInboxCounts, (a, b) => a.waiting === b.waiting && a.look === b.look);
  const filter = useStore(stores.columns, (state) => state.filter);
  const hasTopics = useStore(stores.topics, (state) => state.topics.size > 0);
  const hasSessions = useStore(stores.sessions, (state) => state.sessions.size > 0);
  const archivedLoaded = useStore(stores.topics, (state) => state.archived !== null);
  const [loadingArchived, setLoadingArchived] = useState(false);

  const showArchived = (): void => {
    setLoadingArchived(true);
    stores.topics
      .loadArchived()
      .catch((error: unknown) => toast.show({ tone: 'warning', title: t('archived.failed', { reason: describeError(error) }) }))
      .finally(() => setLoadingArchived(false));
  };

  return (
    <aside className="sidebar" aria-label={t('region')} data-collapsed={collapsed ? '' : undefined}>
      <div className="sidebar-rail" hidden={!collapsed}>
        <span className="sidebar-rail__button">
          <IconButton label={t('rail.inbox', { waiting: counts.waiting, look: counts.look })} icon={<IconInbox />} onClick={() => onExpand('inbox')} />
          {counts.waiting > 0 ? (
            <span className="sidebar-rail__count sidebar-rail__count--waiting" aria-hidden="true">
              {counts.waiting}
            </span>
          ) : counts.look > 0 ? (
            <span className="sidebar-rail__count" aria-hidden="true">
              {counts.look}
            </span>
          ) : null}
        </span>
        <IconButton label={t('rail.sessions')} icon={<IconSessions />} onClick={() => onExpand('sessions')} />
        <IconButton label={t('rail.new')} icon={<IconPlus />} onClick={() => run('newTopic', {})} />
      </div>

      <div className="sidebar-sections" hidden={collapsed}>
        <Collapsible
          className="sidebar-section sidebar-section--inbox"
          title={t('inbox.title')}
          open={inboxOpen}
          onToggle={(open) => onToggle('inbox', open)}
          meta={<InboxCounts waiting={counts.waiting} look={counts.look} />}
          sectionProps={{ 'data-region': '', 'data-section': 'inbox' }}
          {...(inboxRef === undefined ? {} : { toggleRef: inboxRef })}
        >
          <InboxList />
        </Collapsible>
        <Collapsible
          className="sidebar-section sidebar-section--sessions"
          title={t('sessions.title')}
          open={sessionsOpen}
          onToggle={(open) => onToggle('sessions', open)}
          sectionProps={{ 'data-region': '', 'data-section': 'sessions' }}
          {...(sessionsRef === undefined ? {} : { toggleRef: sessionsRef })}
          actions={
            <Menu
              label={t('sessions.new.menu')}
              text={t('sessions.new')}
              icon={<IconPlus size={14} />}
              size="sm"
              testId="sidebar-new"
              items={[
                { id: 'topic', label: t('sessions.new.topic'), icon: <IconSessions size={14} />, onSelect: () => run('newTopic', {}) },
                { id: 'session', label: t('sessions.new.session'), icon: <IconAgent size={14} />, onSelect: () => run('newSession', { kind: 'agent' }) },
                { id: 'terminal', label: t('sessions.new.terminal'), icon: <IconTerminal size={14} />, onSelect: () => run('newSession', { kind: 'terminal' }) },
              ]}
            />
          }
        >
          {hasTopics || hasSessions ? (
            <>
              <div className="sidebar-filter">
                <Segmented<SessionFilter>
                  label={t('sessions.filter')}
                  size="sm"
                  value={filter}
                  onChange={(next) => stores.columns.setFilter(next)}
                  options={SESSION_FILTERS.map((id) => ({ id, label: t(`sessions.filter.${id}`) }))}
                />
              </div>
              <SessionTree showArchived={archivedLoaded} />
              <FilterEmpty />
            </>
          ) : (
            <p className="sidebar-empty">{t('sessions.empty')}</p>
          )}
          {archivedLoaded ? null : (
            <button type="button" className="sidebar-archived" disabled={loadingArchived} onClick={showArchived}>
              {t('archived.show')}
            </button>
          )}
        </Collapsible>
      </div>
    </aside>
  );
}

/** "Nothing matches this filter": the list has things, the filter hides all of them. */
function FilterEmpty() {
  const stores = useStores();
  const filter = useStore(stores.columns, (state) => state.filter);
  const columns = useStore(stores.columns);
  const topics = useStore(stores.topics);
  const sessions = useStore(stores.sessions);
  const selfUserId = useStore(stores.workspace, (state) => state.member?.userId ?? null);
  if (filter === 'all') return null;
  // The tree model again, only to know whether it is empty: it is cheap, and this runs only under a filter.
  return buildSessionTree({ topics, sessions, columns, selfUserId }).length === 0 ? <p className="sidebar-empty">{t('sessions.empty.filter')}</p> : null;
}
