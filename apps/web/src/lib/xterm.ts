// xterm.js bootstrap for session viewers (pty-packaging.md §6.2, verified). HEAVY: import it only through
// `loadXterm()` in src/lib/lazy.ts, never statically.
//
// What a web viewer MUST do (and createViewerTerminal does):
//  - never answer terminal queries: the daemon's headless mirror answers each one exactly once. xterm.js answers DA1,
//    DA2, DSR/CPR, DECXCPR, DECRQM, DECRQSS, XTWINOPS reports and (browser build only) OSC 4/10/11/12 colour queries
//    by itself, so the FULL swallow set below is registered (the original two handlers still leaked, V5);
//  - render at exactly the PTY size (cols × rows from session.attach / exec.resize), never fit the PTY to the window:
//    only the owner's viewport drives the PTY size, through sessions.resize() (policy `owner`; the owner's panel is
//    measured by features/agents/viewer.ts measureTerminal, the size planned by features/agents/terminal-fit.ts);
//  - apply resizes in stream order: term.write('', () => term.resize(c, r)) (F18), and paint a snapshot after a reset.
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { HOST_MAX_CHARS, PORT_MAX_CHARS, authorityOf } from './web-address.ts';

export { Terminal, Unicode11Addon, WebLinksAddon };

export const TERMINAL_THEMES = {
  dark: {
    background: '#0f1115',
    foreground: '#e6e9ef',
    cursor: '#9cc2ff',
    cursorAccent: '#0f1115',
    selectionBackground: '#7cb0ff4d',
  },
  light: {
    background: '#ffffff',
    foreground: '#1b1f27',
    cursor: '#1d4ed8',
    cursorAccent: '#ffffff',
    selectionBackground: '#1d4ed833',
  },
} as const;

export const TERMINAL_DEFAULTS: ITerminalOptions = {
  fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'Noto Sans Mono CJK TC', 'PingFang TC', monospace",
  fontSize: 13,
  lineHeight: 1.2,
  scrollback: 5000,
  // Unicode 11 widths (CJK, emoji) must match what Claude Code assumes; needs the proposed API.
  allowProposedApi: true,
  convertEol: false,
  cursorBlink: false,
  theme: TERMINAL_THEMES.dark,
};

/**
 * Stops this viewer from answering terminal queries (pty-packaging.md §6.2, "VERIFIED full set"). State-changing
 * sequences are unaffected. Returns a disposer.
 */
export function swallowTerminalQueries(term: Terminal): () => void {
  const parser = term.parser;
  const swallow = (): boolean => true;
  const disposables = [
    ...[undefined, '>', '='].map((prefix) => parser.registerCsiHandler(prefix === undefined ? { final: 'c' } : { prefix, final: 'c' }, swallow)), // DA1/DA2/DA3
    ...[undefined, '?'].map((prefix) => parser.registerCsiHandler(prefix === undefined ? { final: 'n' } : { prefix, final: 'n' }, swallow)), // DSR/CPR/DECXCPR
    ...[undefined, '?'].map((prefix) =>
      parser.registerCsiHandler(prefix === undefined ? { intermediates: '$', final: 'p' } : { prefix, intermediates: '$', final: 'p' }, swallow),
    ), // DECRQM
    parser.registerCsiHandler({ final: 't' }, (params) => [11, 13, 14, 15, 16, 18, 19, 20, 21].includes(params[0] as number)), // XTWINOPS reports
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow), // DECRQSS
    ...[4, 10, 11, 12].map((id) => parser.registerOscHandler(id, (data) => data.split(';').includes('?'))), // colour QUERIES only
  ];
  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}

/**
 * http(s) only; `javascript:`, `data:`, `file:` and anything unparsable are refused, and so is an address whose host
 * is longer than a host name can be: the output is written by agents and guests, and the browser's parser is not
 * handed a host of any length (lib/web-address.ts).
 */
export function isWebLink(uri: string): boolean {
  const authority = authorityOf(uri);
  if (authority === null || authority.length > HOST_MAX_CHARS + PORT_MAX_CHARS) return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export interface ViewerTerminal {
  readonly term: Terminal;
  /** Paints a session.attach snapshot: reset, set the PTY size, then the serialized state (in stream order). */
  applySnapshot(data: Uint8Array, cols: number, rows: number): void;
  /** exec.output / an attach delta. */
  write(data: Uint8Array): void;
  /** exec.resize, in stream order with the output. */
  resize(cols: number, rows: number): void;
  dispose(): void;
}

/**
 * Applies a theme, including the background of xterm's scroll viewport: its stylesheet paints `.xterm-viewport` black
 * (for the macOS scrollbar) and xterm never repaints it from the theme, which framed the light terminal in black bars
 *.
 */
export function applyTerminalTheme(term: Terminal, theme: keyof typeof TERMINAL_THEMES): void {
  const colors = TERMINAL_THEMES[theme];
  term.options.theme = colors;
  const element = term.element;
  if (!element) return;
  element.style.backgroundColor = colors.background;
  for (const node of element.querySelectorAll<HTMLElement>('.xterm-viewport')) node.style.backgroundColor = colors.background;
}

export interface ViewerOptions {
  readonly theme?: 'dark' | 'light';
  /** Called for URLs in the output (open in a new tab). */
  readonly onLink?: (event: MouseEvent, uri: string) => void;
  readonly options?: ITerminalOptions;
}

export function createViewerTerminal(container: HTMLElement, options: ViewerOptions = {}): ViewerTerminal {
  const term = new Terminal({ ...TERMINAL_DEFAULTS, theme: TERMINAL_THEMES[options.theme ?? 'dark'], ...options.options });
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  // Terminal output is written by agents and guests: only ever open plain web links, in a new tab without an opener.
  term.loadAddon(new WebLinksAddon((event, uri) => {
    if (!isWebLink(uri)) return;
    if (options.onLink) options.onLink(event, uri);
    else window.open(uri, '_blank', 'noopener,noreferrer');
  }));
  const releaseQueries = swallowTerminalQueries(term);
  term.open(container);
  applyTerminalTheme(term, options.theme ?? 'dark');
  return {
    term,
    applySnapshot(data, cols, rows) {
      term.write('', () => {
        term.reset();
        term.resize(cols, rows);
      });
      term.write(data);
    },
    write(data) {
      term.write(data);
    },
    resize(cols, rows) {
      term.write('', () => term.resize(cols, rows));
    },
    dispose() {
      releaseQueries();
      term.dispose();
    },
  };
}
