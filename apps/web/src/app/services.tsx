// Everything the app talks to outside React, created once at startup and handed down by context, so tests (and
// previews) substitute fakes: the router, the workspace manager (one connection per workspace), the relay login,
// the pin store, the tab's sessionStorage (pending invites) and per-browser preferences.
import { createContext, useContext, type ReactNode } from 'react';
import type { PinStore } from '@smurg/protocol/client';
import { browserConnect, createBrowserConnectionDeps, type KeyStorageStatus } from '../lib/connection/browser-deps.ts';
import type { InviteStorage } from '../lib/invite/pending-invite.ts';
import { browserLocalStorage, createRecentWorkspaces, createThemeController, type RecentWorkspaces, type ThemeController } from '../lib/preferences.ts';
import { createRelayAuthClient, type RelayAuthClient } from '../lib/relay/auth.ts';
import { browserSessionHint } from '../lib/relay/session-hint.ts';
import { createBrowserRouter, type Router } from '../lib/router.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import { createWorkspaceManager, type WorkspaceManager } from '../lib/workspace/manager.ts';

export interface AppServices {
  readonly router: Router;
  readonly manager: WorkspaceManager;
  readonly auth: RelayAuthClient;
  /** Read-only use: the join page compares a pinned daemon key with a new invite's fingerprint. */
  readonly pins: Pick<PinStore, 'get'>;
  /** The tab's sessionStorage (pending invites); null when the browser refuses it. */
  readonly sessionStorage: InviteStorage | null;
  readonly recent: RecentWorkspaces;
  readonly theme: ThemeController;
  readonly keyStorage: ReadableStore<KeyStorageStatus>;
}

const AppServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) throw new Error('useAppServices() outside <AppServicesProvider>');
  return services;
}

function browserSessionStorage(): InviteStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The real thing, for main.tsx. */
export function createBrowserServices(): AppServices {
  const deps = createBrowserConnectionDeps();
  const auth = createRelayAuthClient({ relay: deps.relay, origin: window.location.origin, hint: browserSessionHint() });
  const connect = browserConnect(deps);
  const manager = createWorkspaceManager({
    connect: (workspaceId, options) => {
      const connection = connect(workspaceId, options);
      // Admitted ⇒ the relay accepted this browser's session: later page loads may ask who is logged in.
      connection.subscribe((state) => {
        if (state.kind === 'online') auth.sessionSeen();
      });
      return connection;
    },
  });
  return {
    router: createBrowserRouter(),
    manager,
    auth,
    pins: deps.pins,
    sessionStorage: browserSessionStorage(),
    recent: createRecentWorkspaces(browserLocalStorage()),
    theme: createThemeController(),
    keyStorage: deps.keyStorage,
  };
}

/** A key storage status that never changes (tests, previews). */
export function staticKeyStorage(persistent: boolean | null = true): ReadableStore<KeyStorageStatus> {
  return createStore<KeyStorageStatus>({ persistent });
}
