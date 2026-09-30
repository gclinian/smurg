// TEST ONLY. An EditorEngine without Monaco: records what the document view asks of the editor (model, read-only
// flag and message, bindings, reveals, actions) and lets a test play the user (select text, run an action).
import type { FileRef } from '@smurg/protocol';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { EditorAction, EditorEngine, EditorEngineLoader, EditorHandle, ModelHandle } from '../engine.ts';
import type { EditorSelection } from '../selection.ts';

export class FakeModel implements ModelHandle {
  readonly text: string;
  readonly file: FileRef;
  disposed = false;
  constructor(text: string, file: FileRef) {
    this.text = text;
    this.file = file;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export class FakeEditor implements EditorHandle {
  model: FakeModel | null = null;
  readOnly = true;
  readOnlyMessage: string | null = null;
  selection: EditorSelection | null = null;
  selectedText = '';
  disposed = false;
  focusCount = 0;
  readonly revealed: { line: number; column: number | undefined }[] = [];
  readonly actions = new Map<string, EditorAction>();
  private readonly listeners = new Set<(selection: EditorSelection | null) => void>();

  setModel(model: ModelHandle | null): void {
    this.model = model instanceof FakeModel ? model : null;
  }
  setReadOnly(readOnly: boolean, message: string | null): void {
    this.readOnly = readOnly;
    this.readOnlyMessage = message;
  }
  getSelection(): EditorSelection | null {
    return this.model ? this.selection : null;
  }
  getSelectedText(): string {
    return this.selectedText;
  }
  onSelectionChange(listener: (selection: EditorSelection | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  revealPosition(line: number, column?: number): void {
    this.revealed.push({ line, column });
  }
  focus(): void {
    this.focusCount++;
  }
  addAction(action: EditorAction): () => void {
    this.actions.set(action.id, action);
    return () => this.actions.delete(action.id);
  }
  dispose(): void {
    this.disposed = true;
  }
  /** The user selects `text` spanning `selection`. */
  select(selection: EditorSelection | null, text: string): void {
    this.selection = selection;
    this.selectedText = text;
    for (const listener of [...this.listeners]) listener(selection);
  }
}

export interface FakeBinding {
  readonly ytext: Y.Text;
  readonly model: FakeModel;
  readonly editor: FakeEditor;
  readonly awareness: Awareness;
  destroyed: boolean;
}

export function createFakeEngine(): { engine: EditorEngine; loader: EditorEngineLoader; editors: FakeEditor[]; models: FakeModel[]; bindings: FakeBinding[] } {
  const editors: FakeEditor[] = [];
  const models: FakeModel[] = [];
  const bindings: FakeBinding[] = [];
  const engine: EditorEngine = {
    createEditor() {
      const editor = new FakeEditor();
      editors.push(editor);
      return editor;
    },
    createModel(text, file) {
      const model = new FakeModel(text, file);
      models.push(model);
      return model;
    },
    bind(ytext, model, editor, awareness) {
      if (!(model instanceof FakeModel) || !(editor instanceof FakeEditor)) throw new TypeError('foreign handles');
      const binding: FakeBinding = { ytext, model, editor, awareness, destroyed: false };
      bindings.push(binding);
      return {
        destroy() {
          binding.destroyed = true;
        },
      };
    },
    setTheme() {},
  };
  return { engine, loader: () => Promise.resolve(engine), editors, models, bindings };
}
