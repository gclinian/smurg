// All stores of one workspace connection, created together and fed by that connection (README "Stores").
//
//   const { stores, dispose } = createWorkspaceStores(conn);   // BEFORE conn.start(): listeners must be in place
//   conn.start();
//
// On every non-resumed Welcome (always the first) each store resets and loads a fresh snapshot; on a resumed one the
// daemon replays what was missed and nothing reloads (a store with `onResumed` is told: volatile messages are not
// replayed). A role change (Welcome or channel.memberUpdated) is forwarded to the stores that depend on the role
// (admin, docs).
//
// `columns` is the one store the connection does not feed: the member's own view of the sessions view, kept in this
// browser per workspace (stores/columns.ts).
import type { ConnectionState } from '@smurg/protocol/client';
import { createStore, readonly, type ReadableStore } from '../store.ts';
import { describeError, isNotImplemented } from '../errors.ts';
import type { WorkspaceConnection } from '../connection/types.ts';
import { browserLocalStorage, type PreferenceStorage } from '../preferences.ts';
import { realScheduler, type AreaLifecycle, type AreaName, type Scheduler, type StoreContext } from './base.ts';
import { createActivityArea, type ActivityStore } from './activity.ts';
import { createAdminArea, type AdminStore } from './admin.ts';
import { createColumnsStore, type ColumnsStore } from './columns.ts';
import { createConflictsArea, type ConflictsStore } from './conflicts.ts';
import { createConversationsArea, type ConversationsStore } from './conversations.ts';
import { createDocsArea, type DocsStore } from './docs.ts';
import { createFilesArea, type FilesStore } from './files.ts';
import { createHostArea, type HostStore } from './host.ts';
import { createInboxArea, type InboxStore } from './inbox.ts';
import { createLocksArea, type LocksStore } from './locks.ts';
import { createPresenceArea, type PresenceStore } from './presence.ts';
import { createSessionsArea, type SessionsStore } from './sessions.ts';
import { createSuggestionsArea, type SuggestionsStore } from './suggestions.ts';
import { createTopicsArea, type TopicsStore } from './topics.ts';
import { createTransfersArea, type TransfersStore } from './transfers.ts';
import { createWorkspaceArea, type WorkspaceStore } from './workspace.ts';
import { createWorktreesArea, type WorktreesStore } from './worktrees.ts';

export interface StoreErrorEvent {
  readonly id: number;
  readonly area: AreaName;
  /** A sentence for the person, in the language of the moment it was made. */
  readonly message: string;
  readonly at: number;
}

export interface WorkspaceStores {
  /** The connection's state (same values as conn.getState()). */
  readonly connection: ReadableStore<ConnectionState>;
  readonly workspace: WorkspaceStore;
  readonly presence: PresenceStore;
  readonly files: FilesStore;
  readonly locks: LocksStore;
  readonly docs: DocsStore;
  readonly sessions: SessionsStore;
  readonly suggestions: SuggestionsStore;
  readonly topics: TopicsStore;
  readonly inbox: InboxStore;
  readonly conversations: ConversationsStore;
  /** The host's account state and the main folder's project-settings state (session.host). */
  readonly host: HostStore;
  /** The member's own view: open columns, what was seen, the session list's folds. Not fed by the connection. */
  readonly columns: ColumnsStore;
  readonly activity: ActivityStore;
  readonly conflicts: ConflictsStore;
  readonly worktrees: WorktreesStore;
  readonly admin: AdminStore;
  readonly transfers: TransfersStore;
  /** Background failures (a load that failed, a refresh that failed); newest last, at most 20. */
  readonly errors: ReadableStore<readonly StoreErrorEvent[]>;
}

export interface CreateStoresOptions {
  readonly scheduler?: Scheduler;
  /** Also told about every background failure (logging). */
  readonly onError?: (area: AreaName, error: unknown) => void;
  /** The workspace the stores belong to: the key of what the columns store remembers. Default: nothing is remembered. */
  readonly workspaceId?: string;
  /** Where the columns store keeps the member's view. Default: this browser's localStorage. */
  readonly storage?: PreferenceStorage | null;
}

const MAX_ERRORS = 20;

export function createWorkspaceStores(conn: WorkspaceConnection, options: CreateStoresOptions = {}): { stores: WorkspaceStores; dispose(): void } {
  const scheduler = options.scheduler ?? realScheduler;
  const errors = createStore<readonly StoreErrorEvent[]>([]);
  let errorId = 0;
  const reportError = (area: AreaName, error: unknown): void => {
    options.onError?.(area, error);
    // A feature the host's daemon does not have yet is not an incident: the store shows it, no toast.
    if (isNotImplemented(error)) return;
    errorId++;
    const event: StoreErrorEvent = { id: errorId, area, message: describeError(error), at: scheduler.now() };
    errors.setState((previous) => [...previous, event].slice(-MAX_ERRORS));
  };

  const workspace = createWorkspaceArea(conn);
  const presence = createPresenceArea();
  const files = createFilesArea();
  const locks = createLocksArea();
  const docs = createDocsArea(presence.store);
  const sessions = createSessionsArea();
  const suggestions = createSuggestionsArea();
  const topics = createTopicsArea();
  const inbox = createInboxArea();
  const conversations = createConversationsArea();
  const host = createHostArea();
  const columns = createColumnsStore({
    workspaceId: options.workspaceId ?? '',
    storage: options.workspaceId === undefined ? null : options.storage === undefined ? browserLocalStorage() : options.storage,
    now: () => scheduler.now(),
  });
  const activity = createActivityArea();
  const conflicts = createConflictsArea();
  const worktrees = createWorktreesArea();
  const admin = createAdminArea();
  const transfers = createTransfersArea(() => scheduler.now());

  const areas: readonly (readonly [AreaName, AreaLifecycle])[] = [
    ['presence', presence.lifecycle],
    ['files', files.lifecycle],
    ['locks', locks.lifecycle],
    ['docs', docs.lifecycle],
    ['sessions', sessions.lifecycle],
    ['suggestions', suggestions.lifecycle],
    ['topics', topics.lifecycle],
    ['inbox', inbox.lifecycle],
    ['conversations', conversations.lifecycle],
    ['host', host.lifecycle],
    ['activity', activity.lifecycle],
    ['conflicts', conflicts.lifecycle],
    ['worktrees', worktrees.lifecycle],
    ['admin', admin.lifecycle],
    ['transfers', transfers.lifecycle],
  ];

  const ctx: StoreContext = {
    conn,
    role: () => workspace.store.getState().member?.role ?? null,
    userId: () => workspace.store.getState().member?.userId ?? null,
    generation: () => workspace.store.getState().generation,
    scheduler,
    reportError,
  };

  const roleChanged = (role: Parameters<NonNullable<AreaLifecycle['onRoleChange']>>[0], previous: Parameters<NonNullable<AreaLifecycle['onRoleChange']>>[1]): void => {
    for (const [area, lifecycle] of areas) {
      try {
        lifecycle.onRoleChange?.(role, previous);
      } catch (error) {
        reportError(area, error);
      }
    }
  };

  const unbind: (() => void)[] = [];
  unbind.push(workspace.bind((change) => roleChanged(change.to, change.from), () => scheduler.now()));
  for (const [, lifecycle] of areas) unbind.push(lifecycle.bind(ctx));

  unbind.push(
    conn.onWelcome((welcome, { resumed }) => {
      const change = workspace.applyWelcome(welcome, resumed, scheduler.now());
      if (!resumed) {
        // A fresh logical channel: nothing the daemon knew about us survived (open docs, attached terminals).
        for (const [area, lifecycle] of areas) {
          try {
            lifecycle.reset();
          } catch (error) {
            reportError(area, error);
          }
        }
        for (const [area, lifecycle] of areas) {
          lifecycle.load().catch((error: unknown) => reportError(area, error));
        }
      } else {
        for (const [area, lifecycle] of areas) {
          try {
            lifecycle.onResumed?.();
          } catch (error) {
            reportError(area, error);
          }
        }
        if (change) roleChanged(change.to, change.from);
      }
    }),
  );

  const stores: WorkspaceStores = {
    connection: { getState: () => conn.getState(), subscribe: (listener) => conn.subscribe(() => listener()) },
    workspace: workspace.store,
    presence: presence.store,
    files: files.store,
    locks: locks.store,
    docs: docs.store,
    sessions: sessions.store,
    suggestions: suggestions.store,
    topics: topics.store,
    inbox: inbox.store,
    conversations: conversations.store,
    host: host.store,
    columns,
    activity: activity.store,
    conflicts: conflicts.store,
    worktrees: worktrees.store,
    admin: admin.store,
    transfers: transfers.store,
    errors: readonly(errors),
  };

  return {
    stores,
    dispose() {
      for (const off of unbind.splice(0)) off();
      for (const [, lifecycle] of areas) lifecycle.dispose?.();
    },
  };
}

export type { AreaName, LoadStatus, Loadable, Scheduler } from './base.ts';
export * from './activity.ts';
export * from './admin.ts';
export * from './columns.ts';
export * from './conflicts.ts';
export * from './conversations.ts';
export * from './docs.ts';
export * from './files.ts';
export * from './host.ts';
export * from './inbox.ts';
export * from './locks.ts';
export * from './presence.ts';
export * from './sessions.ts';
export * from './suggestions.ts';
export * from './topics.ts';
export * from './transfers.ts';
export * from './workspace.ts';
export * from './worktrees.ts';
