// React access to the current workspace: its session, connection state, stores, command bus and capabilities.
// Everything a feature needs comes through these hooks; features never create connections or stores.
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { ConnectionState } from '@smurg/protocol/client';
import type { Member, WorkspaceInfo } from '@smurg/protocol';
import { capabilitiesForRole, type Capabilities, type Capability } from '../capabilities.ts';
import type { CommandBus, CommandMap, CommandName, CommandObserver } from '../commands.ts';
import type { WorkspaceConnection } from '../connection/types.ts';
import { useStore } from '../store.ts';
import type { WorkspaceStores } from '../stores/index.ts';
import { selectMember, selectRole, selectWorkspaceInfo } from '../stores/workspace.ts';
import type { WorkspaceSession } from './session.ts';

const WorkspaceContext = createContext<WorkspaceSession | null>(null);

export function WorkspaceProvider({ session, children }: { session: WorkspaceSession; children: ReactNode }) {
  return <WorkspaceContext.Provider value={session}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceSession(): WorkspaceSession {
  const session = useContext(WorkspaceContext);
  if (!session) throw new Error('useWorkspaceSession() outside <WorkspaceProvider>');
  return session;
}

/** The session, or null outside a workspace (components that also render on the landing page). */
export function useOptionalWorkspaceSession(): WorkspaceSession | null {
  return useContext(WorkspaceContext);
}

export function useConnection(): WorkspaceConnection {
  return useWorkspaceSession().connection;
}

export function useStores(): WorkspaceStores {
  return useWorkspaceSession().stores;
}

export function useConnectionState(): ConnectionState {
  return useStore(useStores().connection);
}

export function useMember(): Member | null {
  return useStore(useStores().workspace, selectMember);
}

export function useWorkspaceInfo(): WorkspaceInfo | null {
  return useStore(useStores().workspace, selectWorkspaceInfo);
}

/** The member's capabilities; updates when the role changes. */
export function useCapabilities(): Capabilities {
  const role = useStore(useStores().workspace, selectRole);
  return capabilitiesForRole(role);
}

/** `useCan('file.write')`: whether to SHOW write actions (the daemon enforces). */
export function useCan(capability: Capability): boolean {
  return useCapabilities().can(capability);
}

/** Renders `children` only when the role has `capability` (cosmetic, see capabilities.ts). */
export function Can({ capability, children, fallback = null }: { capability: Capability; children: ReactNode; fallback?: ReactNode }) {
  return useCan(capability) ? children : fallback;
}

export function useCommands(): CommandBus {
  return useWorkspaceSession().commands;
}

/** A stable function that dispatches `name`. */
export function useCommand<K extends CommandName>(name: K): (payload: CommandMap[K]) => Promise<void> {
  const bus = useCommands();
  return useCallback((payload: CommandMap[K]) => bus.dispatch(name, payload), [bus, name]);
}

/** Registers the handler of `name` while the component is mounted (the latest `handler` is always used). */
export function useCommandHandler<K extends CommandName>(name: K, handler: (payload: CommandMap[K]) => void | Promise<void>): void {
  const bus = useCommands();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => bus.handle(name, (payload) => latest.current(payload)), [bus, name]);
}

export function useCommandObserver<K extends CommandName>(name: K, observer: CommandObserver<K>): void {
  const bus = useCommands();
  const latest = useRef(observer);
  latest.current = observer;
  useEffect(() => bus.observe(name, (payload) => latest.current(payload)), [bus, name]);
}
