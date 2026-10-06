// The three dialogs of the host that a conversation leads to. They are the console feature's (one overlay, mounted
// by the shell in both modes); it asked for them to be opened through its light `dialogs.ts` until the commands
// `redactEvent`, `reviewProjectSettings` and `showHostRules` exist (REQUESTS-P8 "From P10"). Everything of the
// conversation feature that opens one goes through this file, so that change is one file. For anyone but the host
// the overlay renders nothing.
import type { RootRef } from '@smurg/protocol';
import type { WorkspaceStores } from '../../lib/stores/index.ts';
import { consoleDialogs } from '../console/dialogs.ts';

/** "Remove this entry": the confirmation before one event is replaced by "The host removed this entry." */
export function openRedact(stores: WorkspaceStores, sessionId: string, seq: number): void {
  consoleDialogs(stores).open({ kind: 'redact', sessionId, seq });
}

/** The Claude Code project settings of the folder a session works in (the trust gate). */
export function openProjectSettings(stores: WorkspaceStores, root: RootRef): void {
  consoleDialogs(stores).open({ kind: 'claude-config', root });
}

/** Which of the host's own Claude Code allow rules apply to agents here. */
export function openHostRules(stores: WorkspaceStores): void {
  consoleDialogs(stores).open({ kind: 'host-rules' });
}
