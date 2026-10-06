// The body of an agent session's column (DESIGN §5.4, §5.5; UX §4): the strip (who is responsible, where, the
// permission mode, Stop), the conversation, the status bar and the composer. The frame around it (title, pin, close,
// "More actions") is the shell's (features/columns); this component adds "Rename" and "End session" to that menu.
//
// The session is watched for as long as the column exists: with streaming deltas while the column is on screen,
// without them while its view is hidden (the other mode, scrolled out of the strip), so a hidden column stays
// current and costs the relay no delta frames (DESIGN §5.3).
import { useEffect, useMemo, useRef } from 'react';
import { ColumnHeaderExtra, ColumnMenuItems, useColumn } from '../../lib/columns/context.tsx';
import { sessionTitle } from '../../lib/stores/sessions.ts';
import { useCapabilities, useMember, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Spinner, type MenuItem } from '../../ui/index.ts';
import { IconEdit, IconTrash } from '../../ui/icons.tsx';
import { Composer } from './Composer.tsx';
import { mayEnd, sessionDialogs } from './dialogs.tsx';
import { ConversationEnvProvider, useAgentSession } from './env.tsx';
import { EventList, type EventListHandle } from './EventList.tsx';
import { HeaderStrip } from './HeaderStrip.tsx';
import { StatusBar } from './StatusBar.tsx';
import { t } from './strings.ts';
import './conversation.css';

export interface ConversationColumnProps {
  readonly sessionId: string;
}

export default function ConversationColumn({ sessionId }: ConversationColumnProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const member = useMember();
  const column = useColumn();
  const session = useAgentSession(sessionId);
  const list = useRef<EventListHandle>(null);

  const live = column.visible;
  useEffect(() => stores.conversations.watch(sessionId, { live }), [stores, sessionId, live]);

  const canRename = caps.canDrive && session !== null && session.status !== 'ended';
  const canEnd = session !== null && mayEnd(member, session);
  const menu = useMemo<readonly MenuItem[]>(() => {
    const dialogs = sessionDialogs(stores);
    const items: MenuItem[] = [];
    if (canRename) items.push({ id: 'rename', label: t('menu.rename'), icon: <IconEdit />, onSelect: () => dialogs.setState({ kind: 'rename', sessionId }) });
    if (canEnd) items.push({ id: 'end', label: t('menu.end'), icon: <IconTrash />, danger: true, onSelect: () => dialogs.setState({ kind: 'end', sessionId }) });
    return items;
  }, [stores, sessionId, canRename, canEnd]);

  if (session === null) {
    return (
      <div className="col-note">
        <Spinner label={t('loading')} />
      </div>
    );
  }
  return (
    <ConversationEnvProvider sessionId={sessionId} root={session.root}>
      <ColumnMenuItems items={menu} />
      {session.purpose === 'item' && session.attempt !== undefined && session.attempt > 1 ? (
        <ColumnHeaderExtra>
          <Badge>{t('attempt', { number: session.attempt })}</Badge>
        </ColumnHeaderExtra>
      ) : null}
      <HeaderStrip session={session} />
      <EventList ref={list} sessionId={sessionId} title={sessionTitle(session)} />
      <StatusBar session={session} onShowCard={(cardId) => void list.current?.show({ cardId })} />
      <Composer session={session} />
    </ConversationEnvProvider>
  );
}
