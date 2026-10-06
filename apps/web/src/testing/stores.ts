// A set of workspace stores on a FakeConnection, for tests of the stores themselves (no React):
//
//   const { conn, stores, admit, flush } = setupStores({ role: 'host' });
//   admit();                                         // online, not resumed: every store loads
//   answerLoads(conn);                               // every initial load answered empty (pass what a test fills)
//   await flush();
import type { InteractiveRequestType } from '@smurg/protocol/client';
import { createWorkspaceStores, type WorkspaceStores } from '../lib/stores/index.ts';
import { FakeConnection } from './fake-connection.ts';
import { T0, WORKSPACE_ID, makeWelcome } from './fixtures.ts';
import { MemoryStorage, createManualScheduler } from './services.tsx';

type WelcomeOptions = NonNullable<Parameters<typeof makeWelcome>[0]>;

export interface StoresTestContext {
  readonly conn: FakeConnection;
  readonly stores: WorkspaceStores;
  readonly scheduler: ReturnType<typeof createManualScheduler>;
  readonly storage: MemoryStorage;
  admit(options?: { resumed?: boolean; role?: WelcomeOptions['role']; channelId?: string }): void;
  dispose(): void;
  /** Lets the pending promise callbacks run (a request that was answered, a responder). */
  flush(): Promise<void>;
}

export function setupStores(base: WelcomeOptions = {}): StoresTestContext {
  const conn = new FakeConnection();
  const scheduler = createManualScheduler(T0);
  const storage = new MemoryStorage();
  const { stores, dispose } = createWorkspaceStores(conn, { scheduler, workspaceId: WORKSPACE_ID, storage });
  conn.start();
  return {
    conn,
    stores,
    scheduler,
    storage,
    dispose,
    admit: (options = {}) =>
      conn.admit(makeWelcome({ serverTime: scheduler.now(), ...base, ...(options.role ? { role: options.role } : {}), ...(options.channelId ? { channelId: options.channelId } : {}) }), { resumed: options.resumed ?? false }),
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

/** The empty answer of every request a store sends when a channel opens. */
export const EMPTY_LOADS = {
  'file.tree': { entries: [], truncated: false },
  'lock.list': { locks: [] },
  'session.list': { sessions: [], hasMore: false },
  'suggest.list': { suggestions: [], hasMore: false },
  'topic.list': { topics: [], hasMore: false },
  'inbox.list': { items: [], hasMore: false },
  'session.host.get': { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' },
  'activity.list': { events: [] },
  'doc.conflict.list': { conflicts: [] },
  'worktree.list': { worktrees: [] },
  'worktree.merge.list': { requests: [] },
  'admin.member.list': { members: [] },
  'admin.invite.list': { invites: [] },
  'admin.settings.get': {
    settings: { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [], diskReserveBytes: 0, diskReservePercent: 5, maxLiveAgents: 8, escalateAfterMs: 600_000, agentMcp: false },
  },
  'admin.audit.query': { entries: [] },
} as const;

/**
 * Answers every pending initial load: with `answers[type]` where given, else with the empty snapshot. Requests that
 * come later stay pending (a test answers them itself).
 */
export function answerLoads(conn: FakeConnection, answers: Partial<Record<InteractiveRequestType, unknown>> = {}): void {
  const all = { ...EMPTY_LOADS, ...answers } as Record<string, unknown>;
  for (const [type, result] of Object.entries(all) as [InteractiveRequestType, never][]) {
    while (conn.pendingOf(type).length > 0) conn.respond(type, result);
  }
}
