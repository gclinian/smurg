// Which dialog of the console feature is open in a workspace. The dialogs are rendered once, by the feature's overlay
// (ConsoleOverlays.tsx, mounted by the workspace shell in the sessions view and in code mode). ANOTHER feature opens
// one with a command (lib/commands.ts; the handlers are registered in slots.tsx):
//
//   commands.dispatch('reviewProjectSettings', { root: { kind: 'main' } });   // the trust gate of one root
//   commands.dispatch('showHostRules', {});                                    // "My own Claude Code rules"
//   commands.dispatch('redactEvent', { sessionId, seq });                      // remove one conversation entry
//
// and the handlers put the request here: `consoleDialogs(stores).open({ kind: 'claude-config', root })`, …
//
// One at a time: opening one replaces another. All three are the host's: for anyone else the overlay renders
// nothing (the daemon refuses `admin.*` from every other role anyway). This module is the console feature's own
// state: no other feature imports it.
import type { RootRef } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../../lib/store.ts';
import type { WorkspaceStores } from '../../lib/stores/index.ts';

export type ConsoleDialog =
  /** The Claude Code project settings of one root, or of every root that has such files. */
  | { readonly kind: 'claude-config'; readonly root?: RootRef }
  /** Which of the host's own Claude Code allow rules apply here (information only). */
  | { readonly kind: 'host-rules' }
  /** The confirmation before one event of a conversation is replaced by "The host removed this entry." */
  | { readonly kind: 'redact'; readonly sessionId: string; readonly seq: number };

export interface ConsoleDialogs extends ReadableStore<ConsoleDialog | null> {
  open(dialog: ConsoleDialog): void;
  /** Closes the dialog; with `only`, only when that one is (still) the open one. */
  close(only?: ConsoleDialog): void;
}

const registries = new WeakMap<WorkspaceStores, ConsoleDialogs>();

/** The dialog state of a workspace, created on first use. */
export function consoleDialogs(stores: WorkspaceStores): ConsoleDialogs {
  let dialogs = registries.get(stores);
  if (!dialogs) {
    const state = createStore<ConsoleDialog | null>(null);
    dialogs = {
      getState: state.getState,
      subscribe: state.subscribe,
      open: (dialog) => state.setState(dialog),
      close: (only) => {
        if (only === undefined || state.getState() === only) state.setState(null);
      },
    };
    registries.set(stores, dialogs);
  }
  return dialogs;
}
