// "Send to agent" from an editor selection (DESIGN §5.6): the handler of the command `sendSelectionAsSuggestion`.
// The quoted lines go to an agent session: as a message from a member with agent access, as a suggestion from an
// Editor (the daemon decides the same way). `mode: 'draft'` (the default) puts the quote into that session's
// composer, shown beside the editor, to complete first; `mode: 'send'` sends it at once. Without a session the
// member is asked which one.
import { useState } from 'react';
import { isSessionOver, type AgentSession } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import type { CommandMap } from '../../lib/commands.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectAgentList, selectSession, sessionTitle } from '../../lib/stores/sessions.ts';
import { useCapabilities, useCommandHandler, useCommands, useStores, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { Button, Dialog, Select, useToast } from '../../ui/index.ts';
import { draftsOf, type DraftSource } from './drafts.ts';
import { t } from './strings.ts';
import { quoteSelection } from './text.ts';

type Selection = CommandMap['sendSelectionAsSuggestion'];

export function SendSelection() {
  const stores = useStores();
  const caps = useCapabilities();
  const commands = useCommands();
  const workspace = useWorkspaceSession();
  const toast = useToast();
  const [choosing, setChoosing] = useState<Selection | null>(null);
  const [chosen, setChosen] = useState('');
  const sessions = useStore(stores.sessions, (state) => selectAgentList(state).filter((session) => !isSessionOver(session)), shallowEqual);
  const drive = caps.canDrive;
  const suggest = !drive && caps.can('suggest.create');

  const deliver = async (selection: Selection, sessionId: string): Promise<void> => {
    const session = selectSession(stores.sessions.getState(), sessionId);
    if (session === undefined || session.kind !== 'agent') {
      toast.show({ tone: 'warning', title: t('select.gone') });
      return;
    }
    if (isSessionOver(session)) {
      toast.show({ tone: 'warning', title: t('select.ended') });
      return;
    }
    const text = quoteSelection(selection);
    const source: DraftSource = { file: selection.file, startLine: selection.startLine, endLine: selection.endLine };
    if ((selection.mode ?? 'draft') === 'draft') {
      // A line of its own after the fence: what the member adds must not continue the code.
      draftsOf(workspace, workspace.workspaceId).append(sessionId, `${text}\n`, source);
      // The composer that now holds it: the session column beside the editor.
      await commands.dispatch('openInCodeMode', { root: selection.file.root, sessionId }).catch(() => {});
      return;
    }
    try {
      if (drive) await stores.conversations.send(sessionId, text, { origin: 'selection' });
      else await stores.suggestions.create({ sessionId, text, source });
      toast.show({ tone: 'success', title: t('select.sent', { title: sessionTitle(session) }) });
    } catch (error) {
      toast.show({ tone: 'danger', title: t('select.failed', { message: describeError(error) }) });
    }
  };

  useCommandHandler('sendSelectionAsSuggestion', async (payload) => {
    if (!drive && !suggest) {
      toast.show({ tone: 'warning', title: t('select.viewer') });
      return;
    }
    if (payload.sessionId !== undefined) {
      await deliver(payload, payload.sessionId);
      return;
    }
    const only = sessions.length === 1 ? (sessions[0] as AgentSession) : null;
    if (sessions.length === 0) toast.show({ tone: 'warning', title: t('select.none') });
    else if (only !== null) await deliver(payload, only.id);
    else {
      setChosen((sessions[0] as AgentSession).id);
      setChoosing(payload);
    }
  });

  if (choosing === null) return null;
  const close = (): void => setChoosing(null);
  return (
    <Dialog
      open
      onClose={close}
      title={t('select.title')}
      description={drive ? t('select.body.message') : t('select.body.suggestion')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={chosen === ''}
            onClick={() => {
              close();
              void deliver(choosing, chosen);
            }}
          >
            {drive ? t('composer.send') : t('composer.sendSuggestion')}
          </Button>
        </>
      }
    >
      <Select label={t('select.title')} hideLabel options={sessions.map((session) => ({ value: session.id, label: session.topicName === undefined ? sessionTitle(session) : `${sessionTitle(session)} · ${session.topicName}` }))} value={chosen} onChange={setChosen} />
    </Dialog>
  );
}
