// The terminal viewer the agents panel paints into: xterm.js through lib/xterm.ts, loaded lazily (lib/lazy.ts — xterm
// must never reach the entry chunk). createViewerTerminal() already registers the FULL query-swallow set, orders
// resizes with the output stream and paints snapshots after a reset; this adapter adds what the panel needs on top:
// input only from those who may type (host and members with agent access; everyone else's terminal has stdin disabled, so xterm
// emits nothing at all — not even focus or mouse reports), the geometry the owner's panel offers (terminal-fit.ts turns
// it into the PTY size), theme switching and file-path links.
//
// The factory is injectable (ViewerFactoryContext) so tests can hold on to the real xterm instance they render.
import { createContext, useContext } from 'react';
import type { ILinkProvider, Terminal } from '@xterm/xterm';
import { loadXterm } from '../../lib/lazy.ts';
import type { TerminalGeometry } from './terminal-fit.ts';

export type ViewerTheme = 'dark' | 'light';

export interface TerminalViewer {
  readonly term: Terminal;
  applySnapshot(data: Uint8Array, cols: number, rows: number): void;
  write(data: Uint8Array): void;
  /** In stream order with the output. */
  resize(cols: number, rows: number): void;
  /** Read-only viewers (everyone but the session's owner, or an ended session) send nothing. */
  setReadOnly(readOnly: boolean): void;
  /** Keystrokes and pastes (only while not read-only). */
  onInput(listener: (data: string) => void): () => void;
  /**
   * What `container` (the scroll container around the terminal) offers the terminal, in CSS pixels; null when it
   * cannot be measured (hidden, not rendered yet). Only the OWNER turns it into a PTY size (terminal-fit.ts).
   */
  measure(container: HTMLElement): TerminalGeometry | null;
  /** Measure the character cell again (a font finished loading: xterm.js keeps the size it measured at open). */
  remeasure(): void;
  setTheme(theme: ViewerTheme): void;
  registerLinkProvider(provider: ILinkProvider): () => void;
  focus(): void;
  dispose(): void;
}

export interface ViewerCreateOptions {
  readonly theme: ViewerTheme;
  readonly readOnly: boolean;
}

export type ViewerFactory = (container: HTMLElement, options: ViewerCreateOptions) => Promise<TerminalViewer>;

/** The production factory: lazy xterm.js + the verified viewer bootstrap. */
export const createXtermViewer: ViewerFactory = async (container, options) => {
  const xterm = await loadXterm();
  const viewer = xterm.createViewerTerminal(container, {
    theme: options.theme,
    options: { disableStdin: options.readOnly },
  });
  const { term } = viewer;
  return {
    term,
    applySnapshot: (data, cols, rows) => viewer.applySnapshot(data, cols, rows),
    write: (data) => viewer.write(data),
    resize: (cols, rows) => viewer.resize(cols, rows),
    setReadOnly(readOnly) {
      term.options.disableStdin = readOnly;
    },
    onInput(listener) {
      const subscription = term.onData((data) => {
        // Belt and braces: xterm itself drops data while stdin is disabled.
        if (!term.options.disableStdin) listener(data);
      });
      return () => subscription.dispose();
    },
    measure(container) {
      return measureTerminal(term, container);
    },
    remeasure() {
      // xterm.js measures its cell again when fontFamily changes: the same family, spelled with or without a trailing
      // space, is such a change and selects the same fonts.
      const family = term.options.fontFamily ?? '';
      term.options.fontFamily = family.endsWith(' ') ? family.trimEnd() : `${family} `;
    },
    setTheme(theme) {
      xterm.applyTerminalTheme(term, theme);
    },
    registerLinkProvider(provider) {
      const disposable = term.registerLinkProvider(provider);
      return () => disposable.dispose();
    },
    focus: () => term.focus(),
    dispose: () => viewer.dispose(),
  };
};

/** The scrollbar thickness of the terminal's scroll container (agents.css `.agents-term__viewport::-webkit-scrollbar`). */
export const TERMINAL_SCROLLBAR_PX = 12;
/** xterm.js keeps this much room right of the text for its scrollback scrollbar (its DEFAULT_SCROLL_BAR_WIDTH). */
const XTERM_SCROLLBAR_PX = 14;

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The geometry of `container` for `term` (the arithmetic of xterm's FitAddon, but measured on the scroll container
 * rather than on the terminal's parent, which a scaled viewer resizes): the container's box without scrollbars, the
 * rendered cell size (xterm's own measurement: the same private render dimensions FitAddon reads), the terminal's
 * padding and the scrollbar thickness.
 */
export function measureTerminal(term: Terminal, container: HTMLElement): TerminalGeometry | null {
  const element = term.element;
  if (!element || !container.isConnected) return null;
  let cellWidth = 0;
  let cellHeight = 0;
  try {
    const cell = (term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })._core._renderService.dimensions.css.cell;
    cellWidth = cell.width;
    cellHeight = cell.height;
  } catch {
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    if (screen && term.cols > 0 && term.rows > 0) {
      cellWidth = screen.offsetWidth / term.cols;
      cellHeight = screen.offsetHeight / term.rows;
    }
  }
  const box = getComputedStyle(container);
  const width = container.offsetWidth - px(box.borderLeftWidth) - px(box.borderRightWidth) - px(box.paddingLeft) - px(box.paddingRight);
  const height = container.offsetHeight - px(box.borderTopWidth) - px(box.borderBottomWidth) - px(box.paddingTop) - px(box.paddingBottom);
  const own = getComputedStyle(element);
  // The real thickness where a scrollbar is shown now; the stylesheet's otherwise (none at all: overlay scrollbars).
  const shown = Math.max(container.offsetWidth - container.clientWidth - px(box.borderLeftWidth) - px(box.borderRightWidth), container.offsetHeight - container.clientHeight - px(box.borderTopWidth) - px(box.borderBottomWidth));
  return {
    width,
    height,
    cellWidth,
    cellHeight,
    paddingX: px(own.paddingLeft) + px(own.paddingRight),
    paddingY: px(own.paddingTop) + px(own.paddingBottom),
    reserveX: term.options.scrollback === 0 ? 0 : (term.options.overviewRuler?.width ?? XTERM_SCROLLBAR_PX),
    scrollbar: shown > 0 ? shown : TERMINAL_SCROLLBAR_PX,
  };
}

export const ViewerFactoryContext = createContext<ViewerFactory>(createXtermViewer);

export function useViewerFactory(): ViewerFactory {
  return useContext(ViewerFactoryContext);
}
