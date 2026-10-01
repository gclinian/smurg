// Test helpers of the agents feature (imported by *.test.tsx only). xterm.js runs in jsdom once matchMedia exists;
// the recording factory keeps every real viewer (and the link providers registered on it) so a test can type into a
// terminal, read its buffer and ask its link provider.
import { act } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Role, SessionInfo, Welcome } from '@smurg/protocol';
import type { ILinkProvider, Terminal } from '@xterm/xterm';
import { renderInWorkspace } from '../../testing/services.tsx';
import type { FakeConnection } from '../../testing/fake-connection.ts';
import type { WorkspaceStores } from '../../lib/stores/index.ts';
import type { TerminalGeometry } from './terminal-fit.ts';
import { ViewerFactoryContext, createXtermViewer, type TerminalViewer, type ViewerFactory } from './viewer.ts';

/** jsdom has no matchMedia; xterm.js asks it for the device pixel ratio. */
export function installMatchMedia(): void {
  if (typeof window.matchMedia === 'function') return;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

export interface RecordedViewer {
  readonly viewer: TerminalViewer;
  readonly term: Terminal;
  readonly providers: ILinkProvider[];
  readonly container: HTMLElement;
  disposed: boolean;
}

export interface RecordingFactory {
  readonly factory: ViewerFactory;
  readonly viewers: RecordedViewer[];
  /**
   * The panel size in character cells (jsdom cannot measure; null = like jsdom): measure() answers a geometry in which
   * exactly this many cells fit (geometryFitting).
   */
  proposed: { cols: number; rows: number } | null;
  /** Or a raw geometry (wins over `proposed`). */
  geometry: TerminalGeometry | null;
  /** How often remeasure() was called (a font finished loading). */
  remeasured: number;
}

/** The cell size and chrome of the test geometry. */
export const TEST_CELL = { width: 8, height: 16, paddingX: 8, paddingY: 8, reserveX: 14, scrollbar: 12 } as const;

/** A panel in which exactly `cols` × `rows` cells fit (plus less than one cell of slack). */
export function geometryFitting(cols: number, rows: number): TerminalGeometry {
  return {
    width: TEST_CELL.paddingX + TEST_CELL.reserveX + cols * TEST_CELL.width + 3,
    height: TEST_CELL.paddingY + rows * TEST_CELL.height + 5,
    cellWidth: TEST_CELL.width,
    cellHeight: TEST_CELL.height,
    paddingX: TEST_CELL.paddingX,
    paddingY: TEST_CELL.paddingY,
    reserveX: TEST_CELL.reserveX,
    scrollbar: TEST_CELL.scrollbar,
  };
}

export function recordingViewerFactory(): RecordingFactory {
  const recording: RecordingFactory = {
    viewers: [],
    proposed: null,
    geometry: null,
    remeasured: 0,
    factory: async (container, options) => {
      const viewer = await createXtermViewer(container, options);
      const record: RecordedViewer = { viewer, term: viewer.term, providers: [], container, disposed: false };
      recording.viewers.push(record);
      return {
        ...viewer,
        measure: () => recording.geometry ?? (recording.proposed ? geometryFitting(recording.proposed.cols, recording.proposed.rows) : null),
        remeasure: () => {
          recording.remeasured++;
        },
        registerLinkProvider(provider) {
          record.providers.push(provider);
          return viewer.registerLinkProvider(provider);
        },
        dispose() {
          record.disposed = true;
          viewer.dispose();
        },
      };
    },
  };
  return recording;
}

/** Waits until xterm parsed everything written so far. */
export function flushTerm(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', resolve));
}

/** The terminal's text, trailing blanks trimmed, lines joined with \n (scrollback included). */
export function terminalText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Renders `ui` in a workspace whose session.list answers `sessions` (admitted with `welcome` when given). */
export async function renderWithSessions(
  ui: ReactElement,
  options: { role?: Role; sessions: SessionInfo[]; recording?: RecordingFactory; welcome?: Welcome },
) {
  installMatchMedia();
  const recording = options.recording ?? recordingViewerFactory();
  const result = renderInWorkspace(<ViewerFactoryContext.Provider value={recording.factory}>{ui}</ViewerFactoryContext.Provider>, {
    ...(options.role ? { role: options.role } : {}),
    ...(options.welcome ? { admit: false } : {}),
  });
  const welcome = options.welcome;
  if (welcome) {
    act(() => {
      result.conn.admit(welcome);
    });
  }
  await act(async () => {
    result.conn.respond('session.list', { sessions: options.sessions });
  });
  return { ...result, recording };
}

/** The oldest pending request of `type` once it exists (polls through React updates). */
export async function nextRequest<T extends Parameters<FakeConnection['pendingOf']>[0]>(conn: FakeConnection, type: T, timeoutMs = 5_000) {
  const start = Date.now();
  for (;;) {
    const pending = conn.pendingOf(type);
    if (pending.length > 0) return pending[0]!;
    if (Date.now() - start > timeoutMs) throw new Error(`no pending ${type} request`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

/** Every store's state as text (Maps, Sets and bytes included): what a secret must never be found in. */
export function storesText(stores: WorkspaceStores): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Map) return { map: [...value.entries()] };
    if (value instanceof Set) return { set: [...value.values()] };
    if (value instanceof Uint8Array) return { bytes: new TextDecoder().decode(value) };
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[seen]';
      seen.add(value);
    }
    return value;
  };
  return Object.entries(stores)
    .map(([name, store]) => `${name}=${JSON.stringify((store as { getState(): unknown }).getState(), replacer)}`)
    .join('\n');
}

/** Web storage as text. */
export function webStorageText(): string {
  const dump = (storage: Storage): string => Array.from({ length: storage.length }, (_, i) => `${storage.key(i)}=${storage.getItem(storage.key(i) ?? '')}`).join('\n');
  return `${dump(window.localStorage)}\n${dump(window.sessionStorage)}`;
}

/** Records everything written to the console while a test runs (restore() when done). */
export function captureConsole(): { text(): string; restore(): void } {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const lines: string[] = [];
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : (() => {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })())).join(' '));
    };
  }
  return {
    text: () => lines.join('\n'),
    restore() {
      for (const [method, original] of originals) console[method] = original;
    },
  };
}
