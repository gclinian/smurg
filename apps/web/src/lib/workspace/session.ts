// One workspace as the app holds it: ONE connection, the stores it feeds and the command bus of its features.
import { createCommandBus, type CommandBus } from '../commands.ts';
import type { WorkspaceConnection } from '../connection/types.ts';
import { createWorkspaceStores, type CreateStoresOptions, type WorkspaceStores } from '../stores/index.ts';

export interface WorkspaceSession {
  readonly workspaceId: string;
  readonly connection: WorkspaceConnection;
  readonly stores: WorkspaceStores;
  readonly commands: CommandBus;
  /**
   * 「離開」: channel.leave (the daemon ends this member's sessions and deletes their guest directory, which logs
   * Claude out), then the connection closes for good. Resolves once the daemon answered or the request failed.
   */
  leave(): Promise<void>;
  /** Closes the connection and detaches the stores (used when nobody shows this workspace any more). */
  dispose(): void;
  readonly disposed: boolean;
}

/** Wires stores and the command bus to `connection` and starts it. */
export function createWorkspaceSession(workspaceId: string, connection: WorkspaceConnection, options: CreateStoresOptions = {}): WorkspaceSession {
  const { stores, dispose: disposeStores } = createWorkspaceStores(connection, options);
  const commands = createCommandBus();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    connection.close();
    disposeStores();
  };
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
      }
    },
    dispose,
    get disposed() {
      return disposed;
    },
  };
}
