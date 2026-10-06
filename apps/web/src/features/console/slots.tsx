// What the console feature contributes to the workspace shell (lib/slots.ts explains every slot):
//
//   overlays   ConsoleOverlays: the Claude Code project settings dialog, the host's own-rules dialog and the
//              confirmation before a conversation entry is removed. Mounted once, in the sessions view and in code
//              mode (DESIGN §5.2); they render nothing until `consoleDialogs(stores).open(…)` asks (dialogs.ts), and
//              nothing at all for anyone but the host.
//
// The console page itself (index.tsx `HostConsolePage`) is a route of its own and is not a slot.
import { lazy } from 'react';
import { defineSlots } from '../../lib/slots.ts';

export const slots = defineSlots({
  feature: 'console',
  overlays: [lazy(() => import('./ConsoleOverlays.tsx'))],
});
