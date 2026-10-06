// The cross-feature command bus. A feature never imports another feature; when the file tree wants the editor to
// open a file, it dispatches `openFile` and the editor (which registered the handler) does it.
//
//   // editor feature, once:
//   useCommandHandler('openFile', async ({ file, line }) => { await docs.open(file); revealLine(line); });
//   // anywhere:
//   const openFile = useCommand('openFile');
//   await openFile({ file, line: 12 });
//
// Exactly one handler per command (the feature that owns the behaviour); any number of observers (e.g. the layout
// reveals the editor pane on openFile). Commands are typed: adding one means adding it to CommandMap below.
import type { ColumnTarget, FileRef, RootRef } from '@smurg/protocol';
import type { ColumnAnchor } from './columns/target.ts';

/** What a drop or a file picker handed over (transfer.md §1.9: collected synchronously in the event handler). */
export type UploadSource =
  /** `<input type="file" [webkitdirectory]>`: `webkitRelativePath` keeps the folder structure (not empty folders). */
  | { readonly kind: 'files'; readonly files: readonly File[] }
  /**
   * A drop: `webkitGetAsEntry()` of every item (all browsers), plus `getAsFileSystemHandle()` promises where the
   * browser has them (Chromium; handles can be kept for resume). Collect both BEFORE any await (lib/drop.ts).
   */
  | {
      readonly kind: 'drop';
      readonly entries: readonly FileSystemEntry[];
      readonly handles: readonly Promise<FileSystemHandle | null>[];
    };

/** The two views of a workspace (DESIGN §5.1): the sessions view (the main screen) and code mode (the workbench). */
export type WorkspaceMode = 'sessions' | 'code';

/** A panel of code mode: the file tree, the editor, the session column beside the editor, and the tabs of the bottom drawer. */
export type PanelId = 'files' | 'editor' | 'session' | 'activity' | 'conflicts' | 'transfers' | 'terminal';

export interface CommandMap {
  /** Open `file` in the editor (and scroll to a 1-based line). Handler: editor feature. */
  openFile: { readonly file: FileRef; readonly line?: number; readonly column?: number };
  /**
   * "Send to agent" from an editor selection: the quoted lines go to an agent session, as a message from a member
   * with agent access and as a suggestion from anyone else. Without `sessionId` the handler asks which session.
   * Handler: conversation feature.
   */
  sendSelectionAsSuggestion: {
    readonly file: FileRef;
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
    readonly sessionId?: string;
    /**
     * 'send' sends it at once; 'draft' (the default) puts the quote into the composer to complete first.
     */
    readonly mode?: 'send' | 'draft';
  };
  /**
   * Show a thing in a column of the sessions view (UX §2): a session's conversation or terminal, a topic's spec or
   * plan, a result report, a merge request's changes. A click on a row replaces what the focused column shows;
   * `side` adds a column beside it (every link INSIDE a column passes `side: true`, so the column one is reading
   * stays); `from: 'inbox'` opens to the side while the strip has room. `anchor`: the card or event to scroll to.
   * A console section navigates to the host console. Switches to the sessions view when code mode is shown.
   * Handler: the workspace shell.
   */
  openColumn: { readonly target: ColumnTarget; readonly side?: boolean; readonly from?: 'row' | 'inbox'; readonly anchor?: ColumnAnchor };
  /** Switch between the sessions view and code mode (a route change: both stay mounted). Handler: the workspace shell. */
  setMode: { readonly mode: WorkspaceMode };
  /**
   * Switch to code mode on `root`: the file tree shows that root, `file` (a path inside that root, when given) opens
   * in the editor at `line`, `sessionId` (when given) is the session beside the editor, and the line above the editor
   * offers the way back. Handler: the workspace shell.
   */
  openInCodeMode: { readonly root: RootRef; readonly file?: string; readonly line?: number; readonly sessionId?: string };
  /** Open the "New topic" dialog. Handler: topics feature. */
  newTopic: Record<never, never>;
  /** Open the "New session" dialog for a session without a topic, or for a plain terminal. Handler: agents feature. */
  newSession: { readonly kind: 'agent' | 'terminal' };
  /** Upload into `targetDir` of `root` (R7, D15). Handler: transfer feature. */
  startUpload: { readonly root: RootRef; readonly targetDir: string; readonly source: UploadSource };
  /** Download a file, or a folder as a streamed zip. Handler: transfer feature. */
  download: { readonly file: FileRef; readonly zip?: boolean };
  /** Reveal and select `file` in the file tree. Handler: files feature. */
  revealFile: { readonly file: FileRef };
  /** Bring a panel of code mode into view (a drawer tab, the file tree, the session column). Handler: the workbench layout. */
  showPanel: { readonly panel: PanelId };
}

export type CommandName = keyof CommandMap;
export type CommandHandler<K extends CommandName> = (payload: CommandMap[K]) => void | Promise<void>;
export type CommandObserver<K extends CommandName> = (payload: CommandMap[K]) => void;

export class NoCommandHandlerError extends Error {
  override readonly name = 'NoCommandHandlerError';
  readonly command: CommandName;

  constructor(command: CommandName) {
    super(`no handler registered for command ${command}`);
    this.command = command;
  }
}

export interface CommandBus {
  /**
   * Registers THE handler of a command. Registering a second one replaces the first (the dispose of the first then
   * does nothing): with React's effects a component may re-register before the old one unregistered.
   */
  handle<K extends CommandName>(name: K, handler: CommandHandler<K>): () => void;
  /** Observers run before the handler, synchronously; they never block or fail the command. */
  observe<K extends CommandName>(name: K, observer: CommandObserver<K>): () => void;
  /** Runs the command. Rejects with NoCommandHandlerError when nobody handles it (e.g. the feature is not built). */
  dispatch<K extends CommandName>(name: K, payload: CommandMap[K]): Promise<void>;
  has(name: CommandName): boolean;
  /**
   * Resolves once `name` has a handler (at once when it has one). For a command whose handler lives in a part of the
   * page that is still loading: code mode's chunk, a lazy column.
   */
  whenHandled(name: CommandName): Promise<void>;
}

export function createCommandBus(options: { onObserverError?: (error: unknown) => void } = {}): CommandBus {
  const handlers = new Map<CommandName, CommandHandler<CommandName>>();
  const observers = new Map<CommandName, Set<CommandObserver<CommandName>>>();
  const waiting = new Map<CommandName, (() => void)[]>();

  return {
    handle(name, handler) {
      const stored = handler as CommandHandler<CommandName>;
      handlers.set(name, stored);
      for (const resolve of waiting.get(name) ?? []) resolve();
      waiting.delete(name);
      return () => {
        if (handlers.get(name) === stored) handlers.delete(name);
      };
    },
    observe(name, observer) {
      let set = observers.get(name);
      if (!set) {
        set = new Set();
        observers.set(name, set);
      }
      const stored = observer as CommandObserver<CommandName>;
      set.add(stored);
      return () => {
        set.delete(stored);
      };
    },
    async dispatch(name, payload) {
      for (const observer of [...(observers.get(name) ?? [])]) {
        try {
          observer(payload);
        } catch (error) {
          options.onObserverError?.(error);
        }
      }
      const handler = handlers.get(name);
      if (!handler) throw new NoCommandHandlerError(name);
      await handler(payload);
    },
    has(name) {
      return handlers.has(name);
    },
    whenHandled(name) {
      if (handlers.has(name)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const list = waiting.get(name) ?? [];
        list.push(resolve);
        waiting.set(name, list);
      });
    },
  };
}
