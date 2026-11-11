import { CONSOLE_SECTIONS } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { createMemoryRouter, parseRoute, routePath, type Route } from './router.ts';

const WS = 'ws_router_test_000001';

describe('router', () => {
  it('parses the routes of ARCHITECTURE §9: landing, join, the two modes of a workspace, the console and its sections', () => {
    expect(parseRoute('/')).toEqual({ name: 'landing' });
    expect(parseRoute(`/join/${WS}`)).toEqual({ name: 'join', workspaceId: WS });
    expect(parseRoute(`/w/${WS}`)).toEqual({ name: 'workspace', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/`)).toEqual({ name: 'workspace', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/code`)).toEqual({ name: 'code', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/code/`)).toEqual({ name: 'code', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/console`)).toEqual({ name: 'console', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/console/`)).toEqual({ name: 'console', workspaceId: WS });
    for (const section of CONSOLE_SECTIONS) expect(parseRoute(`/w/${WS}/console/${section}`)).toEqual({ name: 'console', workspaceId: WS, section });
  });

  it('never repairs an invalid workspace id, an unknown path or an unknown console section', () => {
    for (const path of ['/join/short', `/w/${WS}/other`, '/w/../etc', `/w/${WS}%2F`, '/w/', '/x', `/join/${WS}/extra`, `/w/${WS}/code/x`, `/w/${WS}/console/nope`, `/w/${WS}/console/audit/x`, '/w/short/code']) {
      expect(parseRoute(path).name, path).toBe('not-found');
    }
  });

  // DESIGN 0.8.0 D7.1. The title of the first test stays as it is (docs/ACCEPTANCE.md T7.1 quotes it): the notes
  // routes have their own.
  it('parses the routes of the sticky notes: /w/:id/notes (Home) and /w/:id/notes/:name, the name decoded and checked', () => {
    expect(parseRoute(`/w/${WS}/notes`)).toEqual({ name: 'notes', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/notes/`)).toEqual({ name: 'notes', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/notes/Home`)).toEqual({ name: 'notes', workspaceId: WS, note: 'Home' });
    expect(parseRoute(`/w/${WS}/notes/Home/`)).toEqual({ name: 'notes', workspaceId: WS, note: 'Home' });
    // Spaces, a per cent sign, CJK and a question mark are parts of a name; the address carries them encoded.
    for (const note of ['Payment form', '100% done', '結帳流程 一', 'Why?', 'home']) {
      const path = routePath({ name: 'notes', workspaceId: WS, note });
      expect(path).toBe(`/w/${WS}/notes/${encodeURIComponent(note)}`);
      expect(parseRoute(path), note).toEqual({ name: 'notes', workspaceId: WS, note });
    }
    expect(routePath({ name: 'notes', workspaceId: WS, note: 'Why?' })).toBe(`/w/${WS}/notes/Why%3F`);
    expect(routePath({ name: 'notes', workspaceId: WS })).toBe(`/w/${WS}/notes`);
    // What the memory router (and a browser) reads back of an encoded address is the same route.
    const router = createMemoryRouter(routePath({ name: 'notes', workspaceId: WS, note: '結帳流程 一' }));
    expect(parseRoute(router.getState().pathname)).toEqual({ name: 'notes', workspaceId: WS, note: '結帳流程 一' });
  });

  it('a name that does not decode, or is no sticky note\'s name, is not-found, never repaired', () => {
    const refused = [
      `/w/${WS}/notes/%E0`,
      `/w/${WS}/notes/%`,
      // `/`, a bracket, a markup character, an edge space or dot, a reserved name, NFD, a control character.
      `/w/${WS}/notes/a%2Fb`,
      `/w/${WS}/notes/${encodeURIComponent('[[Home]]')}`,
      `/w/${WS}/notes/${encodeURIComponent('a*b')}`,
      `/w/${WS}/notes/${encodeURIComponent(' Home')}`,
      `/w/${WS}/notes/${encodeURIComponent('Home.')}`,
      `/w/${WS}/notes/CLAUDE`,
      `/w/${WS}/notes/${encodeURIComponent('Cafe\u0301')}`,
      `/w/${WS}/notes/${encodeURIComponent('a\u0007b')}`,
      `/w/${WS}/notes/${encodeURIComponent('x'.repeat(81))}`,
      `/w/${WS}/notes/a/b`,
      '/w/short/notes/Home',
    ];
    for (const path of refused) expect(parseRoute(path).name, path).toBe('not-found');
  });

  it('round-trips paths', () => {
    const routes: Exclude<Route, { name: 'not-found' }>[] = [
      { name: 'landing' },
      { name: 'join', workspaceId: WS },
      { name: 'workspace', workspaceId: WS },
      { name: 'code', workspaceId: WS },
      { name: 'console', workspaceId: WS },
      { name: 'console', workspaceId: WS, section: 'claude-config' },
      { name: 'notes', workspaceId: WS },
      { name: 'notes', workspaceId: WS, note: 'Payment form' },
    ];
    for (const route of routes) expect(parseRoute(routePath(route))).toEqual(route);
    expect(routePath({ name: 'code', workspaceId: WS })).toBe(`/w/${WS}/code`);
    expect(routePath({ name: 'console', workspaceId: WS, section: 'host-rules' })).toBe(`/w/${WS}/console/host-rules`);
  });

  it('navigates in memory and refuses anything that is not an in-app path', () => {
    const router = createMemoryRouter('/');
    router.navigate(`/w/${WS}`);
    expect(router.getState().pathname).toBe(`/w/${WS}`);
    router.navigate('/', { replace: true });
    expect(router.entries).toEqual(['/', '/']);
    expect(() => router.navigate('https://evil.test/')).toThrow();
    expect(() => router.navigate('//evil.test/')).toThrow();
    expect(() => router.navigate(`/join/${WS}#k=x`)).toThrow();
  });
});
