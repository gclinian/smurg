// What the terminal feature contributes to the workspace shell (lib/slots.ts; P7/FOR-FEATURES.md):
//
//   columns.terminal   the body of a plain terminal's column (TerminalColumn.tsx); xterm loads when one is first shown;
//   overlays           the handler of the command `newSession` (the "New" control of the session list: a session
//                      without a topic, or a plain terminal) and the dialogs a terminal's row asks for;
//   menus.session      "Attach from your own terminal", "End session…" / "Terminate…" of a terminal's row.
//
// index.tsx exports `TerminalPanel`: the "Terminal" tab of code mode's drawer.
//
// This file loads with the workspace page and stays light: the handler of `newSession` is registered here, at once
// (the "New" control is there from the first moment), and the dialogs behind it (Overlays.tsx) load on their own.
import { lazy, Suspense, useState } from 'react';
import { isSessionOver } from '@smurg/protocol';
import { defineSlots } from '../../lib/slots.ts';
import { useCommandHandler } from '../../lib/workspace/context.tsx';
import type { MenuItem } from '../../ui/Menu.tsx';
import type { SessionKind } from './new-session.ts';
import { terminalDialogs } from './requests.ts';
import { t } from './strings.ts';

const Dialogs = lazy(() => import('./Overlays.tsx'));

function AgentsOverlay() {
  const [creating, setCreating] = useState<SessionKind | null>(null);
  useCommandHandler('newSession', ({ kind }) => {
    setCreating(kind);
  });
  return (
    <Suspense fallback={null}>
      <Dialogs creating={creating} onCreatingClosed={() => setCreating(null)} />
    </Suspense>
  );
}

export const slots = defineSlots({
  feature: 'agents',
  columns: { terminal: lazy(() => import('./TerminalColumn.tsx')) },
  overlays: [AgentsOverlay],
  menus: {
    session(session, env) {
      if (session.kind !== 'terminal') return [];
      const open = (kind: 'end' | 'terminate' | 'attach'): void => terminalDialogs(env.stores).setState({ kind, sessionId: session.id });
      const items: MenuItem[] = [{ id: 'agents.attach', label: t('action.attach'), onSelect: () => open('attach') }];
      if (isSessionOver(session)) return items;
      const mine = env.member !== null && session.openedBy.userId === env.member.userId;
      if (mine) items.push({ id: 'agents.end', label: t('menu.end'), danger: true, onSelect: () => open('end') });
      else if (env.capabilities.isHost) items.push({ id: 'agents.terminate', label: t('menu.terminate'), danger: true, onSelect: () => open('terminate') });
      return items;
    },
  },
});
