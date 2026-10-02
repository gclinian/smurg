// The web viewer must never answer terminal queries (pty-packaging.md §6.2, V5): the daemon's mirror answers each
// one exactly once. xterm.js itself answers them unless the full swallow set is registered.
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { applyTerminalTheme, createViewerTerminal, swallowTerminalQueries } from './xterm.ts';

const QUERIES: readonly (readonly [string, string])[] = [
  ['DA1', '\x1b[c'],
  ['DA2', '\x1b[>c'],
  ['DA3', '\x1b[=c'],
  ['DSR', '\x1b[5n'],
  ['CPR', '\x1b[6n'],
  ['DECXCPR', '\x1b[?6n'],
  ['DECRQM (ANSI)', '\x1b[4$p'],
  ['DECRQM (DEC)', '\x1b[?25$p'],
  ['DECRQSS', '\x1bP$qm\x1b\\'],
  ['XTWINOPS 18', '\x1b[18t'],
  ['OSC 11', '\x1b]11;?\x07'],
  ['OSC 10', '\x1b]10;?\x07'],
  ['OSC 4', '\x1b]4;1;?\x07'],
];

async function repliesTo(query: string, swallow: boolean): Promise<string> {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  if (swallow) swallowTerminalQueries(term);
  let replies = '';
  term.onData((data) => {
    replies += data;
  });
  await new Promise<void>((resolve) => term.write(query, resolve));
  term.dispose();
  return replies;
}

describe('xterm viewer: terminal queries', () => {
  it('without the handlers xterm.js answers queries by itself (the control)', async () => {
    expect(await repliesTo('\x1b[c', false)).not.toBe('');
    expect(await repliesTo('\x1b[>c', false)).not.toBe('');
  });

  for (const [name, query] of QUERIES) {
    it(`swallows ${name}`, async () => {
      expect(await repliesTo(query, true)).toBe('');
    });
  }

  it('still applies state-changing sequences (colour set, not query; window resize is not a report)', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    swallowTerminalQueries(term);
    await new Promise<void>((resolve) => term.write('hello\x1b[31mred\x1b[0m', resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('hellored');
    term.dispose();
  });
});

describe('xterm viewer: links from terminal output', () => {
  it('opens only http(s) links', async () => {
    const { isWebLink } = await import('./xterm.ts');
    expect(isWebLink('https://example.com/a')).toBe(true);
    expect(isWebLink('http://localhost:5173/')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('data:text/html,x')).toBe(false);
    expect(isWebLink('file:///etc/passwd')).toBe(false);
    expect(isWebLink('not a url')).toBe(false);
  });
});

describe('xterm viewer: theme', () => {
  it("paints xterm's scroll viewport with the theme too, not xterm's black, and follows a theme switch", () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    // jsdom has no matchMedia; xterm asks it for the device pixel ratio.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    const viewer = createViewerTerminal(host, { theme: 'light' });
    try {
      const viewport = host.querySelector<HTMLElement>('.xterm-viewport');
      expect(viewport?.style.backgroundColor).toBe('rgb(255, 255, 255)');
      applyTerminalTheme(viewer.term, 'dark');
      expect(viewport?.style.backgroundColor).toBe('rgb(15, 17, 21)');
    } finally {
      viewer.dispose();
      host.remove();
      window.matchMedia = original;
    }
  });
});
