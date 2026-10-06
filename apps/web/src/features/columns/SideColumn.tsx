// Code mode's one session column (UX §8): the same body as a session column of the sessions view, beside the editor,
// with a selector for which session. "Open in editor" from a conversation chooses the session (openInCodeMode); the
// choice is remembered per browser and workspace (the columns store).
import { isSessionOver, type AgentSession } from '@smurg/protocol';
import { useMemo } from 'react';
import { columnId, type ColumnRef } from '../../lib/columns/target.ts';
import { compareText } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectAgentList, sessionTitle } from '../../lib/stores/sessions.ts';
import { selectTopic } from '../../lib/stores/topics.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { EmptyState, Select, type SelectOption } from '../../ui/index.ts';
import { IconSessions } from '../../ui/icons.tsx';
import { ColumnFrame } from './ColumnFrame.tsx';
import { t } from './strings.ts';
import './columns.css';

export interface SideColumnProps {
  /** Code mode is the mode on screen. */
  shown: boolean;
}

const NONE = '';

export function SideColumn({ shown }: SideColumnProps) {
  const stores = useStores();
  const sessionId = useStore(stores.columns, (state) => state.code.sessionId);
  const sessions = useStore(stores.sessions);
  const topics = useStore(stores.topics);

  const options = useMemo((): SelectOption<string>[] => {
    const name = (session: AgentSession): string => {
      const topic = session.topicId === undefined ? undefined : (selectTopic(topics, session.topicId)?.name ?? session.topicName);
      return topic === undefined ? sessionTitle(session) : t('title.topic', { title: sessionTitle(session), topic });
    };
    // The sessions still going first, then by name: the one a person is working with is rarely an ended one.
    const list = selectAgentList(sessions)
      .map((session) => ({ session, label: name(session) }))
      .sort((a, b) => Number(isSessionOver(a.session)) - Number(isSessionOver(b.session)) || compareText(a.label, b.label));
    return [{ value: NONE, label: t('side.none') }, ...list.map(({ session, label }) => ({ value: session.id, label }))];
  }, [sessions, topics]);

  const chosen = sessionId !== null && options.some((option) => option.value === sessionId) ? sessionId : null;
  const selector = (
    <Select<string>
      className="col-select"
      label={t('side.choose')}
      hideLabel
      options={options}
      value={chosen ?? NONE}
      onChange={(value) => stores.columns.setCodeSession(value === NONE ? null : value)}
    />
  );

  if (chosen === null) {
    return (
      <section className="col col--code" aria-label={t('side.region')} data-region="">
        <header className="col-head">
          <span className="col-head__icon">
            <IconSessions />
          </span>
          <h2 className="ui-visually-hidden" tabIndex={-1} data-region-focus="">
            {t('side.region')}
          </h2>
          {selector}
        </header>
        <div className="col-body">
          <div className="col-note">
            <EmptyState compact title={t('side.empty.title')} description={options.length > 1 ? t('side.empty.body') : t('side.empty.none')} />
          </div>
        </div>
      </section>
    );
  }

  const target: ColumnRef = { kind: 'session', sessionId: chosen };
  return (
    <ColumnFrame
      key={chosen}
      target={target}
      id={columnId(target)}
      place="code"
      focused
      visible={shown}
      anchor={null}
      onAnchorShown={() => {}}
      headerActions={() => selector}
    />
  );
}
