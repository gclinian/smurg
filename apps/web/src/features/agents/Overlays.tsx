// The dialogs the terminal feature keeps in the workspace shell, in both modes (lib/slots.ts `overlays`):
//   - "New session" / "New terminal" for the command `newSession` (the "New" control of the session list), then the
//     new session in a column. The command's HANDLER is in slots.tsx, which loads with the page: a click on "New"
//     right after the page appeared must not find nobody listening while this file is still on its way;
//   - the dialogs a terminal's row asks for from its context menu (end, terminate, attach).
import { useEffect } from 'react';
import { useStore } from '../../lib/store.ts';
import { isTerminalSession, selectSession } from '../../lib/stores/sessions.ts';
import { useCapabilities, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { AttachDialog } from './AttachDialog.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';
import type { SessionKind } from './new-session.ts';
import { terminalDialogs } from './requests.ts';
import './agents.css';

export interface AgentsDialogsProps {
  /** The kind `newSession` asked for; null: the dialog is closed. */
  readonly creating: SessionKind | null;
  onCreatingClosed(): void;
}

export default function AgentsDialogs({ creating, onCreatingClosed }: AgentsDialogsProps) {
  const stores = useStores();
  const commands = useCommands();
  const caps = useCapabilities();
  const requests = terminalDialogs(stores);
  const request = useStore(requests);
  const session = useStore(stores.sessions, (state) => (request === null ? undefined : selectSession(state, request.sessionId)));
  const terminal = session !== undefined && isTerminalSession(session) ? session : null;
  const close = (): void => requests.setState(null);

  // The terminal went while its dialog was asked for.
  const gone = request !== null && terminal === null;
  useEffect(() => {
    if (gone) requests.setState(null);
  }, [gone, requests]);

  return (
    <>
      <NewSessionDialog
        kind={creating ?? 'agent'}
        open={creating !== null}
        onClose={onCreatingClosed}
        onCreated={(created) => {
          onCreatingClosed();
          void commands.dispatch('openColumn', { target: { kind: 'session', sessionId: created.id } }).catch(() => {
            // no shell around (a test, another host): the session is in the list
          });
        }}
      />
      <EndSessionDialog session={request !== null && request.kind !== 'attach' ? terminal : null} mode={request?.kind === 'terminate' ? 'terminate' : 'end'} onClose={close} />
      {request?.kind === 'attach' && terminal !== null ? <AttachDialog session={terminal} isHost={caps.isHost} relayOrigin={window.location.origin} onClose={close} /> : null}
    </>
  );
}
