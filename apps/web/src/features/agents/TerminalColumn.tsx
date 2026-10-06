// The body of a plain terminal's column (DESIGN §5.4): today's terminal with its fit rules. It needs 80 columns, so
// in a narrower column it scrolls sideways inside the column (the terminal's own frame does). "End session" /
// "Terminate" and "Attach from your own terminal" are also in the column's "More actions".
import { useMemo, useState } from 'react';
import { isSessionOver, type TerminalSession } from '@smurg/protocol';
import { ColumnMenuItems, useColumn } from '../../lib/columns/context.tsx';
import { useStore } from '../../lib/store.ts';
import { isTerminalSession, selectSession } from '../../lib/stores/sessions.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Spinner, type MenuItem } from '../../ui/index.ts';
import { IconTerminal, IconTrash } from '../../ui/icons.tsx';
import { AttachDialog } from './AttachDialog.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { t } from './strings.ts';
import { TerminalView } from './TerminalView.tsx';
import './agents.css';

export interface TerminalColumnProps {
  readonly sessionId: string;
}

export default function TerminalColumn({ sessionId }: TerminalColumnProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const column = useColumn();
  const userId = useStore(stores.workspace, selectUserId);
  const found = useStore(stores.sessions, (state) => selectSession(state, sessionId));
  const session: TerminalSession | null = found !== undefined && isTerminalSession(found) ? found : null;
  const [ending, setEnding] = useState<'end' | 'terminate' | null>(null);
  const [attaching, setAttaching] = useState(false);

  const running = session !== null && !isSessionOver(session);
  const isOwner = session !== null && userId !== null && session.openedBy.userId === userId;
  const canEnd = running && isOwner;
  const canTerminate = running && !isOwner && caps.isHost;
  const menu = useMemo<readonly MenuItem[]>(() => {
    const items: MenuItem[] = [{ id: 'attach', label: t('action.attach'), icon: <IconTerminal />, onSelect: () => setAttaching(true) }];
    if (canEnd) items.push({ id: 'end', label: t('menu.end'), icon: <IconTrash />, danger: true, onSelect: () => setEnding('end') });
    if (canTerminate) items.push({ id: 'terminate', label: t('menu.terminate'), icon: <IconTrash />, danger: true, onSelect: () => setEnding('terminate') });
    return items;
  }, [canEnd, canTerminate]);

  if (session === null) {
    return (
      <div className="col-note">
        <Spinner label={t('loading')} />
      </div>
    );
  }
  return (
    <div className="agents-column">
      <ColumnMenuItems items={menu} />
      <TerminalView
        session={session}
        selfUserId={userId}
        active={column.visible}
        keepTerminal
        onEnd={() => setEnding('end')}
        onTerminate={() => setEnding('terminate')}
        onAttach={() => setAttaching(true)}
      />
      <EndSessionDialog session={ending === null ? null : session} mode={ending ?? 'end'} onClose={() => setEnding(null)} />
      {attaching ? <AttachDialog session={session} isHost={caps.isHost} relayOrigin={window.location.origin} onClose={() => setAttaching(false)} /> : null}
    </div>
  );
}
