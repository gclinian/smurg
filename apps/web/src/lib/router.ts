// A small History-API router for the routes of ARCHITECTURE §9. No framework: routes are a closed union, so a
// component switches on `route.name` and TypeScript checks every case.
//
//   /                                    landing + login
//   /join/:workspaceId                   invite acceptance (the fragment was already captured by boot/capture-invite.ts)
//   /w/:workspaceId                      workspace: the sessions view (the main screen)
//   /w/:workspaceId/code                 workspace: code mode (files, editor, terminal)
//   /w/:workspaceId/console              host console
//   /w/:workspaceId/console/:section     host console at one of its sections (what an inbox item of the host opens)
//
// The mode of a workspace is a route (DESIGN AD-12): a reload and the back button keep it.
import { CONSOLE_SECTIONS, type ConsoleSection } from '@smurg/protocol';
import { isWorkspaceId } from '@smurg/protocol/relay';
import { createStore, type ReadableStore } from './store.ts';

export type Route =
  | { readonly name: 'landing' }
  | { readonly name: 'join'; readonly workspaceId: string }
  /** The sessions view. */
  | { readonly name: 'workspace'; readonly workspaceId: string }
  /** Code mode. */
  | { readonly name: 'code'; readonly workspaceId: string }
  | { readonly name: 'console'; readonly workspaceId: string; readonly section?: ConsoleSection }
  | { readonly name: 'not-found'; readonly pathname: string };

const JOIN = /^\/join\/([^/]+)\/?$/;
const WORKSPACE = /^\/w\/([^/]+)\/?$/;
const CODE = /^\/w\/([^/]+)\/code\/?$/;
const CONSOLE = /^\/w\/([^/]+)\/console(?:\/([^/]+))?\/?$/;

/** Strict: an invalid workspace id or an unknown console section is not-found, never "repaired". */
export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'landing' };
  for (const [pattern, name] of [
    [JOIN, 'join'],
    [WORKSPACE, 'workspace'],
    [CODE, 'code'],
    [CONSOLE, 'console'],
  ] as const) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const workspaceId = match[1] as string;
    if (!isWorkspaceId(workspaceId)) return { name: 'not-found', pathname };
    if (name !== 'console' || match[2] === undefined) return { name, workspaceId };
    const section = CONSOLE_SECTIONS.find((known) => known === match[2]);
    return section === undefined ? { name: 'not-found', pathname } : { name, workspaceId, section };
  }
  return { name: 'not-found', pathname };
}

export function routePath(route: Exclude<Route, { name: 'not-found' }>): string {
  switch (route.name) {
    case 'landing':
      return '/';
    case 'join':
      return `/join/${route.workspaceId}`;
    case 'workspace':
      return `/w/${route.workspaceId}`;
    case 'code':
      return `/w/${route.workspaceId}/code`;
    case 'console':
      return route.section === undefined ? `/w/${route.workspaceId}/console` : `/w/${route.workspaceId}/console/${route.section}`;
  }
}

export interface RouterLocation {
  readonly pathname: string;
  readonly search: string;
}

export interface Router extends ReadableStore<RouterLocation> {
  /** Same-origin, path-only navigation (`/w/<id>`). Anything else is refused: use assignExternal. */
  navigate(path: string, options?: { replace?: boolean }): void;
  /** Leaves the SPA (login redirects). Never called with a URL that carries an invite fragment. */
  assignExternal(url: string): void;
  dispose(): void;
}

export interface RouterEnvironment {
  readonly location: { readonly pathname: string; readonly search: string; readonly origin: string; assign(url: string): void };
  readonly history: { readonly state: unknown; pushState(data: unknown, unused: string, url?: string): void; replaceState(data: unknown, unused: string, url?: string): void };
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

function isInternalPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('#') && !path.includes('\\');
}

export function createBrowserRouter(env: RouterEnvironment = window): Router {
  const read = (): RouterLocation => ({ pathname: env.location.pathname, search: env.location.search });
  const store = createStore<RouterLocation>(read());
  const sync = (): void => {
    const next = read();
    const current = store.getState();
    if (next.pathname !== current.pathname || next.search !== current.search) store.setState(next);
  };
  env.addEventListener('popstate', sync);
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    navigate(path, options = {}) {
      if (!isInternalPath(path)) throw new TypeError('navigate() takes an in-app path');
      if (options.replace) env.history.replaceState(null, '', path);
      else env.history.pushState(null, '', path);
      sync();
    },
    assignExternal(url) {
      env.location.assign(url);
    },
    dispose() {
      env.removeEventListener('popstate', sync);
    },
  };
}

/** For tests and previews: an in-memory history. `assigned` records assignExternal calls. */
export function createMemoryRouter(initialPath = '/'): Router & { readonly assigned: readonly string[]; readonly entries: readonly string[] } {
  const parse = (path: string): RouterLocation => {
    const url = new URL(path, 'http://memory.invalid');
    return { pathname: url.pathname, search: url.search };
  };
  const store = createStore<RouterLocation>(parse(initialPath));
  const assigned: string[] = [];
  const entries: string[] = [initialPath];
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    assigned,
    entries,
    navigate(path, options = {}) {
      if (!isInternalPath(path)) throw new TypeError('navigate() takes an in-app path');
      if (options.replace) entries[entries.length - 1] = path;
      else entries.push(path);
      store.setState(parse(path));
    },
    assignExternal(url) {
      assigned.push(url);
    },
    dispose() {},
  };
}
