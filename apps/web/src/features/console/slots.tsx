// What the console feature contributes to the workspace shell (lib/slots.ts explains every slot):
//
//   overlays   the handlers of the three commands that open a dialog of the host, and the dialogs themselves
//              (ConsoleOverlays.tsx): the Claude Code project settings of a root (`reviewProjectSettings`), the host's
//              own Claude Code rules (`showHostRules`) and the confirmation before a conversation entry is removed
//              (`redactEvent`). Mounted once, in the sessions view and in code mode (DESIGN §5.2); the dialogs render
//              nothing until a command asks, and nothing at all for anyone but the host.
//
// This file loads with the workspace page and stays light: the handlers are registered here, at once (a notice or a
// conversation entry can ask from the first moment), and the dialogs behind them load on their own.
//
// The console page itself (index.tsx `HostConsolePage`) is a route of its own and is not a slot.
import { lazy, Suspense } from 'react';
import { defineSlots } from '../../lib/slots.ts';
import { useCommandHandler, useStores } from '../../lib/workspace/context.tsx';
import { consoleDialogs } from './dialogs.ts';

const Dialogs = lazy(() => import('./ConsoleOverlays.tsx'));

function ConsoleOverlay() {
  const dialogs = consoleDialogs(useStores());
  useCommandHandler('redactEvent', ({ sessionId, seq }) => dialogs.open({ kind: 'redact', sessionId, seq }));
  useCommandHandler('reviewProjectSettings', ({ root }) => dialogs.open(root === undefined ? { kind: 'claude-config' } : { kind: 'claude-config', root }));
  useCommandHandler('showHostRules', () => dialogs.open({ kind: 'host-rules' }));
  return (
    <Suspense fallback={null}>
      <Dialogs />
    </Suspense>
  );
}

export const slots = defineSlots({
  feature: 'console',
  overlays: [ConsoleOverlay],
});
