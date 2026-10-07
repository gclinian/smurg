// One workspace as the app holds it: ONE connection, the stores it feeds and the command bus of its features.
import { createCommandBus, type CommandBus } from '../commands.ts';
import type { WorkspaceConnection } from '../connection/types.ts';
import { createWorkspaceStores, type CreateStoresOptions, type WorkspaceStores } from '../stores/index.ts';
import { accessEnded, forgetDrafts } from './drafts-storage.ts';

export interface WorkspaceSession {
  readonly workspaceId: string;
  readonly connection: WorkspaceConnection;
  readonly stores: WorkspaceStores;
  readonly commands: CommandBus;
  /**
   * "Leave": channel.leave (the daemon ends this member's sessions and deletes their guest directory, which logs
   * Claude out), then the connection closes for good. Resolves once the daemon answered or the request failed.
   * Either way this browser forgets the workspace's unsent texts.
   */
  leave(): Promise<void>;
  /** Closes the connection and detaches the stores (used when nobody shows this workspace any more). */
  dispose(): void;
  readonly disposed: boolean;
}

/** Wires stores and the command bus to `connection` and starts it. */
export function createWorkspaceSession(workspaceId: string, connection: WorkspaceConnection, options: CreateStoresOptions = {}): WorkspaceSession {
  const { stores, dispose: disposeStores } = createWorkspaceStores(connection, { workspaceId, ...options });
  const commands = createCommandBus();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    connection.close();
    disposeStores();
  };
  // Unsent texts can quote project code: they go the moment this browser learns that the member was removed, that the
  // device was revoked or that it belongs to another account, on whatever page that happens (drafts-storage.ts).
  if (accessEnded(connection.getState())) forgetDrafts(workspaceId);
  else {
    const stop = connection.subscribe((state) => {
      if (!accessEnded(state)) return;
      stop();
      forgetDrafts(workspaceId);
    });
  }
  // Listeners are registered: now the connection may start (events can arrive right behind the Welcome).
  connection.start();
  return {
    workspaceId,
    connection,
    stores,
    commands,
    async leave() {
      try {
        await connection.leave();
      } finally {
        dispose();
        forgetDrafts(workspaceId);
      }
    },
    dispose,
    get disposed() {
      return disposed;
    },
  };
}
