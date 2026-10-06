// What the conversation feature keeps mounted in the workspace shell, in the sessions view and in code mode
// (lib/slots.ts `overlays`): the dialogs about a session (rename, end) and the handler of "Send to agent".
import { SessionDialogs } from './dialogs.tsx';
import { SendSelection } from './SendSelection.tsx';
import './conversation.css';

export default function ConversationOverlays() {
  return (
    <>
      <SessionDialogs />
      <SendSelection />
    </>
  );
}
