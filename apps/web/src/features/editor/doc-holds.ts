// Documents that are open because a column of the sessions view shows them (a topic's SPEC.md or PLAN.md, DESIGN
// §5.4), not because someone opened them as a tab of the editor.
//
// The docs store (lib/stores/docs.ts) is ONE registry of open documents: one docId and one Yjs replica per file,
// whoever shows it. A column therefore opens its file in the same registry, without activating it, and HOLDS it:
//
//   const release = docHoldsFor(stores.docs).hold(file);      // doc.open (activate: false), counted
//   …
//   release();                                                 // the last release closes the document again
//
// Rules:
//  - a document a column opened is "column-only": the editor area does not list it as a tab (selectEditorDocs), so
//    code mode does not grow a tab nobody asked for;
//  - the moment the editor activates it (someone opens the same file from the file tree: `openFile`), it is the
//    editor's too: the tab shows, and the last release leaves it open;
//  - a document that was a tab already when the column came is never closed by a release.
import { fileRefKey, type FileRef } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../../lib/store.ts';
import type { DocsState, DocsStore, OpenDoc } from '../../lib/stores/docs.ts';

export interface DocHolds extends ReadableStore<ReadonlySet<string>> {
  /**
   * Opens `file` (when it is not open) and keeps it open until the returned function is called. A failed doc.open
   * is the document's own state (`status: 'error'`): `onOpenFailure` gets the error, nothing is thrown.
   */
  hold(file: FileRef, onOpenFailure?: (error: unknown) => void): () => void;
  /** Opens a held document again after a refusal (the "Open again" of a file that could not be opened). */
  reopen(file: FileRef, onOpenFailure?: (error: unknown) => void): void;
  /** The keys of the documents only columns hold (the store's state, as a method for non-React callers). */
  isColumnOnly(key: string): boolean;
}

interface Hold {
  count: number;
  /** The editor has it as a tab (it was open before, or was activated since). */
  editors: boolean;
}

const registries = new WeakMap<DocsStore, DocHolds>();

/** The holds of a workspace's docs store, created on first use. */
export function docHoldsFor(docs: DocsStore): DocHolds {
  let holds = registries.get(docs);
  if (!holds) {
    holds = createDocHolds(docs);
    registries.set(docs, holds);
  }
  return holds;
}

export function createDocHolds(docs: DocsStore): DocHolds {
  const held = new Map<string, Hold>();
  const columnOnly = createStore<ReadonlySet<string>>(new Set());
  let offDocs: (() => void) | null = null;

  const publish = (): void => {
    const next = new Set<string>();
    for (const [key, hold] of held) if (!hold.editors) next.add(key);
    const current = columnOnly.getState();
    if (next.size === current.size && [...next].every((key) => current.has(key))) return;
    columnOnly.setState(next);
  };

  /** The editor activating a held document adopts it. */
  const follow = (): void => {
    const active = docs.getState().activeKey;
    const hold = active === null ? undefined : held.get(active);
    if (hold && !hold.editors) {
      hold.editors = true;
      publish();
    }
  };

  const open = (file: FileRef, onOpenFailure?: (error: unknown) => void): void => {
    docs.open(file, { activate: false }).catch((error: unknown) => onOpenFailure?.(error));
  };

  return {
    getState: columnOnly.getState,
    subscribe: columnOnly.subscribe,
    hold(file, onOpenFailure) {
      const key = fileRefKey(file);
      let hold = held.get(key);
      if (!hold) {
        hold = { count: 0, editors: docs.getState().docs.has(key) };
        held.set(key, hold);
        offDocs ??= docs.subscribe(follow);
      }
      hold.count++;
      publish();
      const existing = docs.getState().docs.get(key);
      if (!existing || existing.status === 'error') open(file, onOpenFailure);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = held.get(key);
        if (!current) return;
        current.count--;
        if (current.count > 0) return;
        held.delete(key);
        if (held.size === 0) {
          offDocs?.();
          offDocs = null;
        }
        publish();
        if (!current.editors && docs.getState().activeKey !== key) docs.close(key);
      };
    },
    reopen(file, onOpenFailure) {
      open(file, onOpenFailure);
    },
    isColumnOnly: (key) => columnOnly.getState().has(key),
  };
}

/** The documents the editor area shows as tabs: every open document that is not held by columns only. */
export function selectEditorDocs(state: DocsState, columnOnly: ReadonlySet<string>): OpenDoc[] {
  const docs: OpenDoc[] = [];
  for (const key of state.order) {
    const doc = state.docs.get(key);
    if (doc !== undefined && !columnOnly.has(key)) docs.push(doc);
  }
  return docs;
}
