// "Send to agent" (SPEC R6): select code → straight into an agent session (the host and agent access: any session), or, for
// an editor, as a suggestion to one. The editor only builds the text (file path + line range + code) and dispatches the
// command; the suggest feature owns the suggestion flow (and the paste).
import type { FileRef } from '@smurg/protocol';
import { useImperativeHandle, useRef, type Ref, type RefObject } from 'react';
import { NoCommandHandlerError } from '../../lib/commands.ts';
import { describeError } from '../../lib/errors.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { plainSessionTitle, selectSessionList, sessionTitle } from '../../lib/stores/sessions.ts';
import { useCapabilities, useCommands, useMember, useStores } from '../../lib/workspace/context.tsx';
import { Menu, useToast, type MenuItem } from '../../ui/index.ts';
import { IconAgent, IconEdit, IconLightbulb, IconSend } from '../../ui/icons.tsx';
import type { EditorHandle } from './engine.ts';
import { buildSelectionPayload, canSendToAgent, sessionTargets } from './selection.ts';
import { t } from './strings.ts';

export interface SendToAgentMenuHandle {
  /** Opens the menu (the editor's context-menu entry "Send to agent…"). */
  open(): void;
}

export interface SendToAgentMenuProps {
  readonly file: FileRef;
  readonly hasSelection: boolean;
  readonly editorRef: RefObject<EditorHandle | null>;
  readonly ref?: Ref<SendToAgentMenuHandle>;
}

/** Whether the local role can send a selection anywhere (viewers cannot). */
export function useCanSendToAgent(): boolean {
  return canSendToAgent(useCapabilities());
}

export function SendToAgentMenu({ file, hasSelection, editorRef, ref }: SendToAgentMenuProps) {
  const stores = useStores();
  const commands = useCommands();
  const toast = useToast();
  const caps = useCapabilities();
  const member = useMember();
  const sessions = useStore(stores.sessions, selectSessionList, shallowEqual);
  const anchor = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    open() {
      const trigger = anchor.current?.querySelector<HTMLButtonElement>('button');
      if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    },
  }));

  const send = (sessionId: string, mode?: 'send' | 'draft'): void => {
    const editor = editorRef.current;
    const result = buildSelectionPayload(file, editor?.getSelection() ?? null, editor?.getSelectedText() ?? '', sessionId);
    if (!result.ok) {
      toast.show({ tone: 'warning', title: result.problem === 'too-large' ? t('send.tooLarge') : t('send.empty') });
      return;
    }
    commands.dispatch('sendSelectionAsSuggestion', mode === undefined ? result.payload : { ...result.payload, mode }).catch((error: unknown) => {
      toast.show({
        tone: 'danger',
        title: error instanceof NoCommandHandlerError ? t('send.unavailable') : t('send.failed', { message: describeError(error) }),
      });
    });
  };

  const targets = sessionTargets(sessions, member?.userId ?? null, caps);
  const items: MenuItem[] = hasSelection
    ? [
        ...targets.own.map((session) => ({
          id: `own:${session.id}`,
          label: t('send.toOwn', { title: sessionTitle(session) }),
          icon: <IconAgent />,
          onSelect: () => send(session.id),
        })),
        // Someone else's session: one click sends the suggestion (SPEC R6), or it goes into the
        // composer to add a note first.
        ...targets.others.flatMap((session) => [
          {
            id: `other:${session.id}`,
            label: t('send.toOther', { owner: session.ownerName, title: plainSessionTitle(session) }),
            icon: <IconLightbulb />,
            onSelect: () => send(session.id, 'send'),
          },
          {
            id: `draft:${session.id}`,
            label: t('send.toOtherDraft', { owner: session.ownerName, title: plainSessionTitle(session) }),
            icon: <IconEdit />,
            onSelect: () => send(session.id, 'draft'),
          },
        ]),
      ]
    : [{ id: 'need-selection', label: t('send.needSelection'), disabled: true, onSelect: () => {} }];
  if (items.length === 0) items.push({ id: 'none', label: t('send.none'), disabled: true, onSelect: () => {} });

  return (
    <span ref={anchor} className="editor-send" data-has-selection={hasSelection || undefined}>
      <Menu label={t('send.menuLabel')} text={t('send.menu')} icon={<IconSend />} size="sm" items={items} />
    </span>
  );
}
