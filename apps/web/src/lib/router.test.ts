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

  it('round-trips paths', () => {
    const routes: Exclude<Route, { name: 'not-found' }>[] = [
      { name: 'landing' },
      { name: 'join', workspaceId: WS },
      { name: 'workspace', workspaceId: WS },
      { name: 'code', workspaceId: WS },
      { name: 'console', workspaceId: WS },
      { name: 'console', workspaceId: WS, section: 'claude-config' },
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
