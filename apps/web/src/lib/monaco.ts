// Monaco bootstrap (yjs-monaco.md Q2, verified on monaco-editor 0.57.0 + Vite 8.3.1). HEAVY (~4 MB): import it only
// through `loadMonaco()` in src/lib/lazy.ts, never statically — `pnpm build` fails (scripts/check-chunks.ts) when it
// reaches the entry chunk.
//
//  - the tree-shakeable "slim" entry points of monaco ≥ 0.56: editor core, every editor feature, Monarch highlighting
//    for every language (each a lazy chunk), and NO language-service workers (the TypeScript worker alone is 6.8 MB;
//    IntelliSense is not a product goal);
//  - MonacoEnvironment.getWorker is still required for the base editor worker (without it: "Failed to load worker
//    script for label: editorWorkerService"); the production build emits it as a classic IIFE worker;
//  - y-monaco 0.1.6 deep-imports monaco-editor/esm/vs/editor/editor.api.js: the alias in vite.config.ts maps it onto
//    the same module this file loads, so there is exactly one Monaco instance;
//  - unicodeHighlight allows zh-hant / zh-hans (otherwise full-width punctuation such as 「！」 gets a warning box);
//  - unusualLineTerminators 'off' (the 0.57 default 'prompt' shows a window.confirm on EVERY client for a file with
//    U+2028 and rewrites the shared file when accepted).
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string): Worker {
    return new EditorWorker();
  },
};

export { monaco };

/** Options every smurg editor starts from. Read-only until the Yjs binding is in place (gotcha 3). */
export const EDITOR_DEFAULTS: monaco.editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  automaticLayout: true,
  fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'Noto Sans Mono CJK TC', 'PingFang TC', monospace",
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  // Room above line 1 for a remote caret's name label (it sits above the caret: review WEB-03).
  padding: { top: 16 },
  scrollBeyondLastLine: false,
  renderWhitespace: 'selection',
  unicodeHighlight: { allowedLocales: { 'zh-hant': true, 'zh-hans': true } },
  unusualLineTerminators: 'off',
  // Shared documents are LF inside the Y.Text (the daemon re-applies CRLF on save); see createSmurgModel.
  tabSize: 2,
  theme: 'smurg-dark',
};

let themesDefined = false;

/** Monaco themes matching tokens.css (the editor cannot read CSS variables). */
export function defineSmurgThemes(): void {
  if (themesDefined) return;
  themesDefined = true;
  monaco.editor.defineTheme('smurg-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0f1115',
      'editor.foreground': '#e6e9ef',
      'editorLineNumber.foreground': '#5d667a',
      'editorLineNumber.activeForeground': '#aab3c3',
      'editor.selectionBackground': '#7cb0ff4d',
      'editor.lineHighlightBackground': '#151821',
      'editorCursor.foreground': '#9cc2ff',
      'editorWidget.background': '#1b1f2a',
      'editorWidget.border': '#2a3040',
    },
  });
  monaco.editor.defineTheme('smurg-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1b1f27',
      'editorLineNumber.foreground': '#8e98ab',
      'editorLineNumber.activeForeground': '#485262',
      'editor.selectionBackground': '#1d4ed833',
      'editor.lineHighlightBackground': '#f5f6f8',
      'editorCursor.foreground': '#1d4ed8',
    },
  });
}

/** 'dark' | 'light' (lib/preferences.ts ThemeState.resolved) → the Monaco theme name. */
export function monacoThemeFor(resolved: 'dark' | 'light'): string {
  return resolved === 'light' ? 'smurg-light' : 'smurg-dark';
}

/** Creates an editor with the smurg defaults (themes defined on first use). */
export function createEditor(
  container: HTMLElement,
  options: monaco.editor.IStandaloneEditorConstructionOptions = {},
): monaco.editor.IStandaloneCodeEditor {
  defineSmurgThemes();
  return monaco.editor.create(container, { ...EDITOR_DEFAULTS, ...options });
}

/**
 * A model for a shared document: content from the Y.Text AFTER the first sync (never insert file content yourself,
 * gotcha 3), end of line forced to LF (a CRLF model diverges from the LF Y.Text, F21). One model per URI: dispose the
 * previous one (and its MonacoBinding) before creating another for the same file (V6: "Cannot add model because it
 * already exists").
 */
export function createSmurgModel(text: string, uri: monaco.Uri, language?: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, language, uri);
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  return model;
}
