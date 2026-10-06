// Which dialog of the topics feature is open in a workspace. The dialogs are rendered once, by the feature's overlay
// (TopicOverlays.tsx, mounted by the workspace shell in both modes); whatever wants one opens it here: a column's
// button, a topic's "More actions", an inbox row's action, the `newTopic` command.
//
//   topicDialogs(stores).open({ kind: 'start', topicId });            // the Start dialog of a plan
//   const dialog = useStore(topicDialogs(stores));                    // the overlay
//
// One at a time: opening one replaces another (a confirmation is never stacked on a dialog).
import { createStore, type ReadableStore } from '../../lib/store.ts';
import type { WorkspaceStores } from '../../lib/stores/index.ts';

export type TopicDialog =
  /** "New topic". */
  | { readonly kind: 'new' }
  /** The Start dialog (`plan.preflight` → `plan.start`). `itemIds`: only these ("Start this one", "Start again"). */
  | { readonly kind: 'start'; readonly topicId: string; readonly itemIds?: readonly string[] }
  /** "Show the changes": the spec and plan files against what the last Start confirmed (`plan.changes`). */
  | { readonly kind: 'changes'; readonly topicId: string }
  | { readonly kind: 'rename'; readonly topicId: string }
  /** The Archive confirmation (reviewed items that are not merged; worktrees with changes that were never merged). */
  | { readonly kind: 'archive'; readonly topicId: string }
  /** "Restore topic": no question, sent at once (the overlay says how it went). */
  | { readonly kind: 'restore'; readonly topicId: string }
  /** The host deletes an archived topic. */
  | { readonly kind: 'delete'; readonly topicId: string }
  /** "Restart discussion" (a lost discussion, or a fresh conversation for a long one). */
  | { readonly kind: 'restart'; readonly topicId: string }
  /** The host's "Merge…" of a result report's changes: the complete diff review. */
  | { readonly kind: 'merge'; readonly requestId: string };

export interface TopicDialogs extends ReadableStore<TopicDialog | null> {
  open(dialog: TopicDialog): void;
  /** Closes the dialog; with `only`, only when that one is (still) the open one. */
  close(only?: TopicDialog): void;
}

const registries = new WeakMap<WorkspaceStores, TopicDialogs>();

/** The dialog state of a workspace, created on first use. */
export function topicDialogs(stores: WorkspaceStores): TopicDialogs {
  let dialogs = registries.get(stores);
  if (!dialogs) {
    const state = createStore<TopicDialog | null>(null);
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
