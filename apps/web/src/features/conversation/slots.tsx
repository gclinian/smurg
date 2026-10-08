// What the conversation feature contributes to the workspace shell (lib/slots.ts; P7/FOR-FEATURES.md):
//
//   columns.conversation   the body of an agent session's column (ConversationColumn.tsx), loaded when one is first shown;
//   overlays               the dialogs about a session and the handler of `sendSelectionAsSuggestion` (Overlays.tsx);
//   menus.session          "Rename session…" and "End session…" of an agent session's row in the list.
//
// Light on purpose: this file loads with the workspace page, the components behind it do not.
import { mayEndSession } from '@smurg/protocol';
import { lazyChunk, loadChunk, reportChunkFailure } from '../../lib/chunks.ts';
import { defineSlots } from '../../lib/slots.ts';
import type { MenuItem } from '../../ui/Menu.tsx';
import { t } from './strings.ts';

export const slots = defineSlots({
  feature: 'conversation',
  columns: { conversation: lazyChunk(() => import('./ConversationColumn.tsx')) },
  overlays: [lazyChunk(() => import('./Overlays.tsx'))],
  menus: {
    session(session, env) {
      if (session.kind !== 'agent' || session.status === 'ended') return [];
      const items: MenuItem[] = [];
      const open = (kind: 'rename' | 'end'): void => {
        // The dialogs live in Overlays.tsx; asking for one must not load them with this file. A menu has no place
        // to say that their chunk did not come: the workspace's banner does (lib/chunks.ts).
        void loadChunk(() => import('./dialogs.tsx'))
          .then(({ sessionDialogs }) => sessionDialogs(env.stores).setState({ kind, sessionId: session.id }))
          .catch(reportChunkFailure);
      };
      if (env.capabilities.canDrive) items.push({ id: 'conversation.rename', label: t('menu.rename'), onSelect: () => open('rename') });
      const member = env.member;
      const mayEnd =
        member !== null &&
        mayEndSession({ userId: member.userId, role: member.role }, { kind: 'agent', purpose: session.purpose, openedBy: session.openedBy.userId, responsible: session.responsible?.userId ?? null });
      if (mayEnd) items.push({ id: 'conversation.end', label: t('menu.end'), danger: true, onSelect: () => open('end') });
      return items;
    },
  },
});
