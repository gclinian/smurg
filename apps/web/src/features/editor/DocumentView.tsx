// The Monaco view of one document: the only component that talks to the editor engine (engine.ts). It binds the
// session's current replica ONCE, after its first sync (the editor stays read-only and empty until then: never insert
// file content on the client, gotcha 3), re-binds when the replica is replaced (new epoch, rejected change), and
// keeps Monaco's read-only flag in step with the view-model.
import { fileRefKey, type FileRef } from '@smurg/protocol';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useAppServices } from '../../app/services.tsx';
import { isChunkLoadError, type ChunkLoadError } from '../../lib/chunks.ts';
import { useStore } from '../../lib/store.ts';
import { Banner, Button, ChunkNotice, Spinner } from '../../ui/index.ts';
import type { DocSession } from './doc-session.ts';
import { useEditorEngineLoader, type EditorEngine, type EditorHandle } from './engine.ts';
import type { EditorSelection } from './selection.ts';
import { t } from './strings.ts';
import { wrapsLines } from './view-model.ts';

export interface RevealRequest {
  readonly key: string;
  readonly line: number;
  readonly column?: number;
  readonly seq: number;
}

export interface DocumentViewProps {
  readonly session: DocSession;
  readonly file: FileRef;
  readonly readOnly: boolean;
  readonly readOnlyMessage: string | null;
  readonly reveal: RevealRequest | null;
  onRevealed(seq: number): void;
  onSelection(selection: EditorSelection | null): void;
  /** Filled with the editor while it exists (the "Send to agent" menu reads the selection through it). */
  readonly editorRef: RefObject<EditorHandle | null>;
  /** The editor's context-menu entry "Send to agent…" (omitted when the role cannot send). */
  readonly onSendToAgent?: () => void;
}

/**
 * `notLoaded`: the editor's chunk did not come (lib/chunks.ts says why: the web app was deployed again, the network
 * is gone); the notice for it offers the reload, not a retry (a failed import stays failed).
 */
function useEngine(): { engine: EditorEngine | null; failed: boolean; notLoaded: ChunkLoadError | null; retry(): void } {
  const loader = useEditorEngineLoader();
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [failed, setFailed] = useState(false);
  const [notLoaded, setNotLoaded] = useState<ChunkLoadError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setNotLoaded(null);
    loader().then(
      (loaded) => {
        if (!cancelled) setEngine(() => loaded);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (isChunkLoadError(error)) setNotLoaded(error);
        else setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loader, attempt]);
  return { engine, failed, notLoaded, retry: () => setAttempt((n) => n + 1) };
}

export function DocumentView({ session, file, readOnly, readOnlyMessage, reveal, onRevealed, onSelection, editorRef, onSendToAgent }: DocumentViewProps) {
  const { engine, failed, notLoaded, retry } = useEngine();
  const container = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<EditorHandle | null>(null);
  const [bound, setBound] = useState(false);
  const theme = useStore(useAppServices().theme, (state) => state.resolved);
  const replica = useStore(session, (state) => state.replica);
  const replicaSynced = useStore(session, (state) => state.replicaSynced);
  const fileKey = fileRefKey(file);
  const latest = useRef({ onSelection, onSendToAgent, onRevealed, file, theme });
  latest.current = { onSelection, onSendToAgent, onRevealed, file, theme };
  const hasSendAction = onSendToAgent !== undefined;

  // One editor per document view, created once the engine is there.
  useEffect(() => {
    const node = container.current;
    if (!engine || !node) return;
    const created = engine.createEditor(node, { theme: latest.current.theme, ariaLabel: t('doc.editorLabel', { path: latest.current.file.path }), wrap: wrapsLines(latest.current.file.path) });
    setEditor(created);
    editorRef.current = created;
    const offSelection = created.onSelectionChange((selection) => latest.current.onSelection(selection));
    return () => {
      offSelection();
      if (editorRef.current === created) editorRef.current = null;
      setEditor(null);
      created.dispose();
    };
  }, [engine, editorRef]);

  useEffect(() => {
    engine?.setTheme(theme);
  }, [engine, theme]);

  // Bind the current replica once it holds the daemon's text; a new replica (epoch, rejection) means a new model.
  useEffect(() => {
    if (!engine || !editor || !replicaSynced) return;
    const ytext = session.ytext;
    const model = engine.createModel(ytext.toString(), latest.current.file);
    editor.setModel(model);
    const binding = engine.bind(ytext, model, editor, session.awareness);
    setBound(true);
    return () => {
      setBound(false);
      binding.destroy();
      editor.setModel(null);
      model.dispose();
      latest.current.onSelection(null);
    };
  }, [engine, editor, session, replica, replicaSynced, fileKey]);

  useEffect(() => {
    if (!editor) return;
    editor.setReadOnly(readOnly || !bound, readOnlyMessage ?? (bound ? null : t('readOnly.loading')));
  }, [editor, readOnly, readOnlyMessage, bound]);

  useEffect(() => {
    if (!editor || !hasSendAction) return;
    return editor.addAction({ id: 'smurg.sendToAgent', label: t('send.action'), needsSelection: true, run: () => latest.current.onSendToAgent?.() });
  }, [editor, hasSendAction]);

  useEffect(() => {
    if (!editor || !bound || reveal === null) return;
    editor.revealPosition(reveal.line, reveal.column);
    editor.focus();
    latest.current.onRevealed(reveal.seq);
  }, [editor, bound, reveal]);

  return (
    <div className="editor-doc__view">
      <div ref={container} className="editor-doc__monaco" data-bound={bound || undefined} />
      {notLoaded ? (
        <div className="editor-doc__overlay">
          <ChunkNotice error={notLoaded} />
        </div>
      ) : failed ? (
        <div className="editor-doc__overlay">
          <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={retry}>{t('engine.retry')}</Button>}>
            {t('engine.failed')}
          </Banner>
        </div>
      ) : !engine || !bound ? (
        <div className="editor-doc__overlay">
          <Spinner label={engine ? t('doc.syncing') : t('engine.loading')} />
        </div>
      ) : null}
    </div>
  );
}
