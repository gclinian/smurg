// What the terminal feature's dialogs are asked for from outside a component that could hold them: a session row's
// context menu in the list (slots.tsx). One request at a time per workspace; Overlays.tsx shows it.
import { createStore, type WritableStore } from '../../lib/store.ts';

export type TerminalDialogRequest = { readonly kind: 'end' | 'terminate' | 'attach'; readonly sessionId: string } | null;

const requests = new WeakMap<object, WritableStore<TerminalDialogRequest>>();

/** The dialog request of one workspace (keyed by its stores object: what a component and a slot function both have). */
export function terminalDialogs(owner: object): WritableStore<TerminalDialogRequest> {
  let store = requests.get(owner);
  if (store === undefined) {
    store = createStore<TerminalDialogRequest>(null);
    requests.set(owner, store);
  }
  return store;
}
