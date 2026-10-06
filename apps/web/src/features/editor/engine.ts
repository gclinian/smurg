// The editor engine seam: what the document view needs from Monaco + y-monaco, behind a small interface.
//  - production: loadEditorEngine() fetches Monaco through lib/lazy.ts (loadMonaco) and y-monaco with import(), so
//    both stay out of the entry chunk (scripts/check-chunks.ts); ./monaco-engine.ts adapts them;
//  - tests: an EditorEngineContext provider hands in a fake engine, so no Monaco runs in jsdom (the real-browser
//    behaviour is verified in the integration phase).
import type { FileRef } from '@smurg/protocol';
import { createContext, useContext } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { loadMonaco } from '../../lib/lazy.ts';
import type { ResolvedTheme } from '../../lib/preferences.ts';
import type { EditorSelection } from './selection.ts';

/** A text model for one replica of a document (LF, content taken from the Y.Text after the first sync). */
export interface ModelHandle {
  dispose(): void;
}

export interface BindingHandle {
  destroy(): void;
}

export interface EditorAction {
  readonly id: string;
  readonly label: string;
  /** Offered only while text is selected. */
  readonly needsSelection?: boolean;
  run(): void;
}

export interface EditorHandle {
  setModel(model: ModelHandle | null): void;
  setReadOnly(readOnly: boolean, message: string | null): void;
  /** Normalised selection (start before end), or null without a model. */
  getSelection(): EditorSelection | null;
  /** The selected text, LF line ends. */
  getSelectedText(): string;
  onSelectionChange(listener: (selection: EditorSelection | null) => void): () => void;
  revealPosition(line: number, column?: number): void;
  focus(): void;
  addAction(action: EditorAction): () => void;
  dispose(): void;
}

export interface EditorEngine {
  /** `wrap`: long lines continue on the next line instead of running out of the pane (prose: view-model.ts `wrapsLines`). */
  createEditor(container: HTMLElement, options: { readonly theme: ResolvedTheme; readonly ariaLabel: string; readonly wrap?: boolean }): EditorHandle;
  /** One model per replica: dispose the previous one of the same file first (V6). */
  createModel(text: string, file: FileRef): ModelHandle;
  /** y-monaco: keeps model and Y.Text in step and renders remote selections (classes yRemoteSelection-<clientID>). */
  bind(ytext: Y.Text, model: ModelHandle, editor: EditorHandle, awareness: Awareness): BindingHandle;
  setTheme(theme: ResolvedTheme): void;
}

export type EditorEngineLoader = () => Promise<EditorEngine>;

let enginePromise: Promise<EditorEngine> | null = null;

/** Monaco + y-monaco, loaded once (a failed chunk load may be retried). */
export const loadEditorEngine: EditorEngineLoader = () => {
  enginePromise ??= Promise.all([loadMonaco(), import('y-monaco'), import('./monaco-engine.ts')])
    .then(([monaco, yMonaco, adapter]) => adapter.createMonacoEngine(monaco, yMonaco.MonacoBinding))
    .catch((error: unknown) => {
      enginePromise = null;
      throw error;
    });
  return enginePromise;
};

export const EditorEngineContext = createContext<EditorEngineLoader>(loadEditorEngine);

export function useEditorEngineLoader(): EditorEngineLoader {
  return useContext(EditorEngineContext);
}
