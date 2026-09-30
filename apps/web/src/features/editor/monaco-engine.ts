// The Monaco adapter behind engine.ts. Loaded ONLY through loadEditorEngine() (dynamic import): it receives the
// Monaco module (lib/monaco.ts, via loadMonaco) and y-monaco's MonacoBinding as arguments and imports nothing of
// Monaco at run time itself, so neither can reach the entry chunk.
import { rootRefKey, type FileRef } from '@smurg/protocol';
import type { MonacoBinding } from 'y-monaco';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { ResolvedTheme } from '../../lib/preferences.ts';
import type { BindingHandle, EditorAction, EditorEngine, EditorHandle, ModelHandle } from './engine.ts';
import type { EditorSelection } from './selection.ts';

type MonacoModule = typeof import('../../lib/monaco.ts');
type Monaco = MonacoModule['monaco'];
type TextModel = ReturnType<MonacoModule['createSmurgModel']>;
type CodeEditor = ReturnType<MonacoModule['createEditor']>;
type MonacoBindingClass = typeof MonacoBinding;

class MonacoModelHandle implements ModelHandle {
  readonly model: TextModel;
  constructor(model: TextModel) {
    this.model = model;
  }
  dispose(): void {
    if (!this.model.isDisposed()) this.model.dispose();
  }
}

class MonacoEditorHandle implements EditorHandle {
  readonly editor: CodeEditor;
  private readonly monaco: Monaco;

  constructor(editor: CodeEditor, monaco: Monaco) {
    this.editor = editor;
    this.monaco = monaco;
  }

  setModel(model: ModelHandle | null): void {
    this.editor.setModel(model instanceof MonacoModelHandle ? model.model : null);
  }

  setReadOnly(readOnly: boolean, message: string | null): void {
    this.editor.updateOptions({ readOnly, readOnlyMessage: message === null ? undefined : { value: message } });
  }

  getSelection(): EditorSelection | null {
    const selection = this.editor.getSelection();
    if (selection === null || this.editor.getModel() === null) return null;
    return {
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLine: selection.endLineNumber,
      endColumn: selection.endColumn,
    };
  }

  getSelectedText(): string {
    const selection = this.editor.getSelection();
    const model = this.editor.getModel();
    if (selection === null || model === null) return '';
    return model.getValueInRange(selection, this.monaco.editor.EndOfLinePreference.LF);
  }

  onSelectionChange(listener: (selection: EditorSelection | null) => void): () => void {
    const disposable = this.editor.onDidChangeCursorSelection(() => listener(this.getSelection()));
    return () => disposable.dispose();
  }

  revealPosition(line: number, column = 1): void {
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column });
  }

  focus(): void {
    this.editor.focus();
  }

  addAction(action: EditorAction): () => void {
    const disposable = this.editor.addAction({
      id: action.id,
      label: action.label,
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      ...(action.needsSelection ? { precondition: 'editorHasSelection' } : {}),
      run: () => action.run(),
    });
    return () => disposable.dispose();
  }

  dispose(): void {
    this.editor.dispose();
  }
}

export function createMonacoEngine(module: MonacoModule, Binding: MonacoBindingClass): EditorEngine {
  const { monaco } = module;
  let modelCounter = 0;
  return {
    createEditor(container, options) {
      const editor = module.createEditor(container, { theme: module.monacoThemeFor(options.theme), ariaLabel: options.ariaLabel });
      return new MonacoEditorHandle(editor, monaco);
    },
    createModel(text: string, file: FileRef) {
      // The language follows the file name's extension; the counter keeps URIs unique across replicas.
      modelCounter++;
      const uri = monaco.Uri.from({ scheme: 'smurg', path: `/${rootRefKey(file.root)}/${file.path}`, query: `m=${modelCounter}` });
      return new MonacoModelHandle(module.createSmurgModel(text, uri));
    },
    bind(ytext: Y.Text, model: ModelHandle, editor: EditorHandle, awareness: Awareness): BindingHandle {
      if (!(model instanceof MonacoModelHandle) || !(editor instanceof MonacoEditorHandle)) throw new TypeError('foreign editor handles');
      return new Binding(ytext, model.model, new Set([editor.editor]), awareness);
    },
    setTheme(theme: ResolvedTheme) {
      monaco.editor.setTheme(module.monacoThemeFor(theme));
    },
  };
}
