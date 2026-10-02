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
import type { FileRef, RootRef } from '@smurg/protocol';

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

export type PanelId = 'files' | 'editor' | 'agents' | 'suggestions' | 'activity' | 'conflicts' | 'transfers' | 'merge-requests';

export interface CommandMap {
  /** Open `file` in the editor (and scroll to a 1-based line). Handler: editor feature. */
  openFile: { readonly file: FileRef; readonly line?: number; readonly column?: number };
  /**
   * Turn an editor selection into a suggestion for someone else's session (R6), or paste it into your own session
   * when `sessionId` is yours. Without `sessionId` the handler asks which session. Handler: suggest feature.
   */
  sendSelectionAsSuggestion: {
    readonly file: FileRef;
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
    readonly sessionId?: string;
    /**
     * For someone else's session: 'send' creates the suggestion at once (SPEC R6: one click sends it into someone else's session as a suggestion); 'draft' (the default) puts the quote into the composer to complete first.
     */
    readonly mode?: 'send' | 'draft';
  };
  /** Show a session in the agents panel. Handler: agents feature. */
  focusSession: { readonly sessionId: string };
  /** Upload into `targetDir` of `root` (R7, D15). Handler: transfer feature. */
  startUpload: { readonly root: RootRef; readonly targetDir: string; readonly source: UploadSource };
  /** Download a file, or a folder as a streamed zip. Handler: transfer feature. */
  download: { readonly file: FileRef; readonly zip?: boolean };
  /** Reveal and select `file` in the file tree. Handler: files feature. */
  revealFile: { readonly file: FileRef };
  /** Bring a panel of the workbench into view (bottom drawer tab, right panel). Handler: the workbench layout. */
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
}

export function createCommandBus(options: { onObserverError?: (error: unknown) => void } = {}): CommandBus {
  const handlers = new Map<CommandName, CommandHandler<CommandName>>();
  const observers = new Map<CommandName, Set<CommandObserver<CommandName>>>();

  return {
    handle(name, handler) {
      const stored = handler as CommandHandler<CommandName>;
      handlers.set(name, stored);
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
  };
}
