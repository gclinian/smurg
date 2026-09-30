import { describe, expect, it } from 'vitest';
import { createMemoryRouter, parseRoute, routePath } from './router.ts';

const WS = 'ws_router_test_000001';

describe('router', () => {
  it('parses the four routes of ARCHITECTURE §9', () => {
    expect(parseRoute('/')).toEqual({ name: 'landing' });
    expect(parseRoute(`/join/${WS}`)).toEqual({ name: 'join', workspaceId: WS });
    expect(parseRoute(`/w/${WS}`)).toEqual({ name: 'workspace', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/`)).toEqual({ name: 'workspace', workspaceId: WS });
    expect(parseRoute(`/w/${WS}/console`)).toEqual({ name: 'console', workspaceId: WS });
  });

  it('never repairs an invalid workspace id or an unknown path', () => {
    for (const path of ['/join/short', `/w/${WS}/other`, '/w/../etc', `/w/${WS}%2F`, '/w/', '/x', `/join/${WS}/extra`]) {
      expect(parseRoute(path).name, path).toBe('not-found');
    }
  });

  it('round-trips paths', () => {
    for (const route of [{ name: 'landing' }, { name: 'join', workspaceId: WS }, { name: 'workspace', workspaceId: WS }, { name: 'console', workspaceId: WS }] as const) {
      expect(parseRoute(routePath(route))).toEqual(route);
    }
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
