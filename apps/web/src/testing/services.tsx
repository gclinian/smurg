// Test doubles for the app services and helpers to render a component inside a workspace driven by a
// FakeConnection. Feature tests typically need only renderInWorkspace():
//
//   const { conn, stores } = renderInWorkspace(<FilesPanel />, { role: 'editor' });
//   conn.respond('file.tree', { entries: [makeEntry('README.md')], truncated: false });
//   expect(await screen.findByText('README.md')).toBeTruthy();
//
// A component that is the body of a column renders inside one (features/columns):
//
//   renderInColumn(<ConversationColumn sessionId="s1" />, { target: { kind: 'session', sessionId: 's1' } });
//
// and a test of the shell with its own column kinds passes `slots` (what features/*/slots.tsx would register):
//
//   renderInWorkspace(<ColumnStrip shown empty={null} />, { slots: [{ feature: 'test', columns: { plan: FakePlan } }] });
import { render, type RenderResult } from '@testing-library/react';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { createMemoryPinStore, type RelayUser } from '@smurg/protocol/client';
import type { Role } from '@smurg/protocol';
import { App } from '../app/App.tsx';
import { AppServicesProvider, staticKeyStorage, type AppServices } from '../app/services.tsx';
import type { KeyStorageStatus } from '../lib/connection/browser-deps.ts';
import type { OpenOptions } from '../lib/connection/types.ts';
import type { PageBuild } from '../lib/page-build.ts';
import { createRecentWorkspaces, createThemeController } from '../lib/preferences.ts';
import type { LoginOptions, RelayAuthClient } from '../lib/relay/auth.ts';
import { createMemoryRouter, type Router } from '../lib/router.ts';
import { createStore } from '../lib/store.ts';
import type { Scheduler } from '../lib/stores/base.ts';
import { createSlotRegistry, type FeatureSlots } from '../lib/slots.ts';
import { createWorkspaceManager, type WorkspaceManager } from '../lib/workspace/manager.ts';
import { WorkspaceProvider } from '../lib/workspace/context.tsx';
import { SlotRegistryProvider } from '../lib/workspace/slots.tsx';
import { createWorkspaceSession, type WorkspaceSession } from '../lib/workspace/session.ts';
import { ToastProvider } from '../ui/index.ts';
import { FakeConnection } from './fake-connection.ts';
import { WORKSPACE_ID, makeWelcome } from './fixtures.ts';

/** An in-memory Web Storage. */
export class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

export interface FakeAuth extends RelayAuthClient {
  user: RelayUser | null;
  options: LoginOptions;
  /** Makes me() reject (relay down). */
  meError: unknown;
}

export function createFakeAuth(initial: { user?: RelayUser | null; dev?: boolean } = {}): FakeAuth {
  const auth: FakeAuth = {
    user: initial.user ?? null,
    options: { providers: ['github', 'google'], dev: initial.dev ?? false },
    meError: null,
    me: () => (auth.meError ? Promise.reject(auth.meError) : Promise.resolve(auth.user)),
    logout: () => {
      auth.user = null;
      return Promise.resolve();
    },
    loginUrl: (provider, returnPath) => `https://relay.test/auth/${provider}/login?return_to=${encodeURIComponent(`https://app.test${returnPath}`)}`,
    devLoginUrl: (user, _name, returnPath) => `https://relay.test/auth/dev/start?user=${user}&return_to=${encodeURIComponent(`https://app.test${returnPath}`)}`,
    loginOptions: () => Promise.resolve(auth.options),
    sessionSeen: () => {},
  };
  return auth;
}

export const TEST_USER: RelayUser = { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' };

export interface TestServices extends AppServices {
  readonly router: Router & { readonly assigned: readonly string[]; readonly entries: readonly string[] };
  readonly auth: FakeAuth;
  readonly pins: ReturnType<typeof createMemoryPinStore>;
  readonly sessionStorage: MemoryStorage;
  /** Every connection the manager created, in order, with the options it was opened with. */
  readonly connections: { readonly workspaceId: string; readonly options: OpenOptions; readonly conn: FakeConnection }[];
}

export interface TestServicesOptions {
  path?: string;
  user?: RelayUser | null;
  dev?: boolean;
  releaseGraceMs?: number;
  /** What asking the relay for the current page answers (default: it cannot be asked). */
  pageBuild?: () => Promise<PageBuild>;
  /** What the key storage says about itself (default: persistent, no record of a newer page). */
  keyStorage?: KeyStorageStatus;
}

export function createTestServices(options: TestServicesOptions = {}): TestServices {
  const connections: TestServices['connections'][number][] = [];
  const manager: WorkspaceManager = createWorkspaceManager({
    connect: (workspaceId, openOptions) => {
      const conn = new FakeConnection();
      connections.push({ workspaceId, options: openOptions, conn });
      return conn;
    },
    // Long by default: a page hand-over (join → workspace) must not race a test's lazy chunk load.
    releaseGraceMs: options.releaseGraceMs ?? 60_000,
  });
  return {
    router: createMemoryRouter(options.path ?? '/'),
    manager,
    auth: createFakeAuth({ user: options.user === undefined ? TEST_USER : options.user, dev: options.dev ?? false }),
    pins: createMemoryPinStore(),
    sessionStorage: new MemoryStorage(),
    recent: createRecentWorkspaces(new MemoryStorage()),
    theme: createThemeController({ storage: null, media: null }),
    keyStorage: options.keyStorage === undefined ? staticKeyStorage(true) : createStore<KeyStorageStatus>(options.keyStorage),
    pageBuild: options.pageBuild ?? (() => Promise.resolve('unknown')),
    connections,
  };
}

export function renderApp(services: AppServices = createTestServices()): RenderResult & { services: AppServices } {
  return { ...render(<App services={services} />), services };
}

/** A scheduler whose timers run only when the test says so. */
export function createManualScheduler(start = 1_780_000_000_000): Scheduler & { advance(ms: number): void; readonly pending: number } {
  let now = start;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextHandle = 1;
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

export interface WorkspaceTestContext {
  readonly conn: FakeConnection;
  readonly session: WorkspaceSession;
  readonly stores: WorkspaceSession['stores'];
  readonly services: TestServices;
  /** What the features registered, for this test (default: nothing). */
  readonly slots: readonly FeatureSlots[];
}

/**
 * A session on a FakeConnection, admitted with `role` unless `admit: false`. Requests the stores send on admission
 * stay pending until the test answers them (conn.respond / conn.handle).
 */
export function createTestWorkspace(
  options: { role?: Role; admit?: boolean; conn?: FakeConnection; scheduler?: Scheduler; services?: TestServices; slots?: readonly FeatureSlots[]; userId?: string; displayName?: string } = {},
): WorkspaceTestContext {
  const conn = options.conn ?? new FakeConnection();
  // The columns store keeps the member's view in localStorage, which setup.ts clears after every test.
  const session = createWorkspaceSession(WORKSPACE_ID, conn, options.scheduler ? { scheduler: options.scheduler } : {});
  if (options.admit !== false) {
    conn.admit(
      makeWelcome({
        role: options.role ?? 'editor',
        ...(options.userId === undefined ? {} : { userId: options.userId }),
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
        // The host's clock is the test's own: with a scheduler of its own, that scheduler's.
        ...(options.scheduler === undefined ? {} : { serverTime: options.scheduler.now() }),
      }),
    );
  }
  return { conn, session, stores: session.stores, services: options.services ?? createTestServices(), slots: options.slots ?? [] };
}

export function WorkspaceTestProviders({ context, children }: { context: WorkspaceTestContext; children: ReactNode }) {
  const registry = useMemo(() => createSlotRegistry(context.slots), [context.slots]);
  return (
    <AppServicesProvider services={context.services}>
      <ToastProvider>
        <WorkspaceProvider session={context.session}>
          <SlotRegistryProvider registry={registry}>{children}</SlotRegistryProvider>
        </WorkspaceProvider>
      </ToastProvider>
    </AppServicesProvider>
  );
}

/** Renders `ui` inside a workspace (see createTestWorkspace). */
export function renderInWorkspace(ui: ReactElement, options: Parameters<typeof createTestWorkspace>[0] = {}): RenderResult & WorkspaceTestContext {
  const context = createTestWorkspace(options);
  const result = render(<WorkspaceTestProviders context={context}>{ui}</WorkspaceTestProviders>);
  return { ...result, ...context };
}
