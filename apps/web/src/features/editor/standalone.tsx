// A document on its own, outside the editor's tab strip: what the spec and plan columns of the sessions view mount
// (DESIGN §5.4: "Edit: DocumentPane on specs/<slug>/SPEC.md (brings cursors, the lock banner, the deleted-file
// state)"). The document is the ONE the docs store holds for that file, so a person typing in the column and a person
// typing in the same file in code mode share one replica, one lock and one autosave.
//
//   const held = useHeldDocument(file);                      // opens it (doc-holds.ts) while the component is mounted
//   const text = useDocumentText(held.session);               // the live text for a rendered view; null until synced
//   <StandaloneDocument held={held} active={mode === 'edit'} />   // the editor itself, mounted on first view
//   const writable = useHeldDocumentWritable(held);           // a change made now would be the host's (not read-only)
//
// The open sticky note (DESIGN 0.8.0 D7.5) mounts the same editor without "Send to agent" (`sendToAgent={false}`),
// and adds a line to the note in one local transaction only while `heldDocumentWritable` says the change would hold.
import { fileRefKey, type FileRef } from '@smurg/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../lib/store.ts';
import type { OpenDoc } from '../../lib/stores/docs.ts';
import type { WorkspaceStores } from '../../lib/stores/index.ts';
import { useMember, useStores } from '../../lib/workspace/context.tsx';
import { docHoldsFor } from './doc-holds.ts';
import { docSessionsFor, type DocSession, type DocSessionState } from './doc-session.ts';
import { DocumentPane } from './DocumentPane.tsx';
import { t } from './strings.ts';
import { editorView, liveLockOf } from './view-model.ts';
import './editor.css';

export interface HeldDocument {
  readonly file: FileRef;
  /** The docs store's entry; undefined for the moment before the store listed it. */
  readonly doc: OpenDoc | undefined;
  /** The Yjs side of it (doc-session.ts). */
  readonly session: DocSession | undefined;
  /** doc.open again, after a refusal. */
  reopen(): void;
}

/**
 * Opens `file` in the workspace's document registry for as long as the component is mounted (`file` null: nothing).
 * The same file held twice is one document.
 */
export function useHeldDocument(file: FileRef | null): HeldDocument | null {
  const stores = useStores();
  const registry = useMemo(() => docSessionsFor({ docs: stores.docs, connection: stores.connection }), [stores]);
  const holds = useMemo(() => docHoldsFor(stores.docs), [stores]);
  const key = file === null ? null : fileRefKey(file);
  // The file by value: a caller may build a new FileRef object on every render.
  const stable = useMemo(() => file, [key]);
  const recordFailure = useCallback((error: unknown) => (key === null ? undefined : registry.get(key)?.setOpenFailure(error)), [registry, key]);

  useEffect(() => {
    if (stable === null) return;
    return holds.hold(stable, recordFailure);
  }, [holds, stable, recordFailure]);

  const doc = useStore(stores.docs, (state) => (key === null ? undefined : state.docs.get(key)));
  const reopen = useCallback(() => {
    if (stable !== null) holds.reopen(stable, recordFailure);
  }, [holds, stable, recordFailure]);
  return useMemo(() => (stable === null || key === null ? null : { file: stable, doc, session: doc === undefined ? undefined : registry.get(key), reopen }), [stable, key, doc, registry, reopen]);
}

const NO_SESSION = { getState: (): DocSessionState | undefined => undefined, subscribe: () => () => {} };

/** How often a rendered view of a document's text follows the typing (DESIGN §5.5: Markdown is re-parsed at most every 200 ms). */
export const DOCUMENT_TEXT_INTERVAL_MS = 200;

/**
 * The document's text as it is right now, for a READ view (the spec's rendered Markdown): null until the replica has
 * the daemon's text. Follows every change of everyone, at most once per DOCUMENT_TEXT_INTERVAL_MS.
 */
export function useDocumentText(session: DocSession | undefined): string | null {
  const replica = useStore(session ?? NO_SESSION, (state) => state?.replica ?? -1);
  const synced = useStore(session ?? NO_SESSION, (state) => state?.replicaSynced === true);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!session || !synced) {
      setText(null);
      return;
    }
    const ytext = session.ytext;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (): void => {
      timer = null;
      setText(ytext.toString());
    };
    const onChange = (): void => {
      timer ??= setTimeout(read, DOCUMENT_TEXT_INTERVAL_MS);
    };
    read();
    ytext.observe(onChange);
    return () => {
      ytext.unobserve(onChange);
      if (timer !== null) clearTimeout(timer);
    };
  }, [session, replica, synced]);
  return text;
}

/**
 * Whether a change made to the held document right now would be the host's: the editor would not be read-only for
 * `userId` (the role may write, the replica has the daemon's text and is connected, no agent holds the file's lock,
 * the file is there). Read from the stores as they are at this moment, for an action that writes after a wait.
 */
export function heldDocumentWritable(held: HeldDocument, stores: Pick<WorkspaceStores, 'docs' | 'locks'>, userId: string | null): boolean {
  const doc = stores.docs.getState().docs.get(fileRefKey(held.file));
  if (doc === undefined || held.session === undefined) return false;
  return !editorView({ doc, session: held.session.getState(), userId, lock: liveLockOf(stores.locks.getState(), held.file) }).readOnly;
}

/** The same, kept current: false while there is no held document. */
export function useHeldDocumentWritable(held: HeldDocument | null): boolean {
  const stores = useStores();
  const userId = useMember()?.userId ?? null;
  const file = held?.file ?? null;
  const doc = held?.doc;
  const sessionState = useStore(held?.session ?? NO_SESSION, (state) => state);
  const lock = useStore(stores.locks, (state) => (file === null ? undefined : liveLockOf(state, file)));
  if (doc === undefined || sessionState === undefined) return false;
  return !editorView({ doc, session: sessionState, userId, lock }).readOnly;
}

export interface StandaloneDocumentProps {
  readonly held: HeldDocument;
  /** Shown right now. The editor is created the first time this is true and then kept (hidden), like a tab's. */
  readonly active: boolean;
  /** "Send to agent" for the roles that may send (default true); false: none, whoever looks. */
  readonly sendToAgent?: boolean;
}

/** The collaborative editor of one held document, without tabs. */
export function StandaloneDocument({ held, active, sendToAgent = true }: StandaloneDocumentProps) {
  const { doc, session, reopen } = held;
  // Nothing was asked to be revealed: a column opens its file at the top.
  const noReveal = useCallback(() => {}, []);
  if (doc === undefined) return null;
  return (
    <DocumentPane
      doc={doc}
      session={session}
      active={active}
      rootLabel={doc.file.root.kind === 'main' ? t('root.main') : t('root.worktree', { name: doc.file.root.worktreeId })}
      reveal={null}
      onRevealed={noReveal}
      onReopen={reopen}
      sendToAgent={sendToAgent}
    />
  );
}
