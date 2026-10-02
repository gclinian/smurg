// Workspace, own member and public settings: everything the Welcome carries, kept live by channel.memberUpdated and
// channel.settingsUpdated (ARCHITECTURE §5.1).
import type { Member, PublicSettings, Role, Welcome, WorkspaceInfo } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import type { WorkspaceConnection } from '../connection/types.ts';

export interface RoleChange {
  readonly from: Role;
  readonly to: Role;
  readonly at: number;
}

export interface WorkspaceState {
  readonly workspace: WorkspaceInfo | null;
  /** The member's own record (role, colour, display name). */
  readonly member: Member | null;
  readonly settings: PublicSettings | null;
  /** Number of full resyncs (non-resumed Welcomes) so far; 0 before the first Welcome. */
  readonly generation: number;
  /** Whether the latest admission resumed the logical channel. */
  readonly resumed: boolean | null;
  /** The latest role change, for the "Your role is now ..." notice. */
  readonly roleChange: RoleChange | null;
  /** `Welcome.serverTime − Date.now()` at the latest admission (display only). */
  readonly clockSkewMs: number;
}

export interface WorkspaceStore extends ReadableStore<WorkspaceState> {
  /**
   * "Leave" (channel.leave): the daemon ends this member's sessions and deletes their guest directory, then the
   * connection closes for good. The host's own leave is a no-op on the daemon; the connection still closes.
   */
  leave(): Promise<void>;
}

export const INITIAL_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  workspace: null,
  member: null,
  settings: null,
  generation: 0,
  resumed: null,
  roleChange: null,
  clockSkewMs: 0,
});

// ---- selectors

export const selectRole = (state: WorkspaceState): Role | null => state.member?.role ?? null;
export const selectMember = (state: WorkspaceState): Member | null => state.member;
export const selectUserId = (state: WorkspaceState): string | null => state.member?.userId ?? null;
export const selectWorkspaceInfo = (state: WorkspaceState): WorkspaceInfo | null => state.workspace;
export const selectSettings = (state: WorkspaceState): PublicSettings | null => state.settings;
export const selectIsHost = (state: WorkspaceState): boolean => state.member?.role === 'host';

/** Internal half used by createWorkspaceStores. */
export interface WorkspaceArea {
  readonly store: WorkspaceStore;
  /** Applies a Welcome; returns the role change it caused, if any. */
  applyWelcome(welcome: Welcome, resumed: boolean, now: number): RoleChange | null;
  bind(onRoleChange: (change: RoleChange) => void, now: () => number): () => void;
}

export function createWorkspaceArea(conn: WorkspaceConnection): WorkspaceArea {
  const state = createStore<WorkspaceState>(INITIAL_WORKSPACE_STATE);

  const roleChangeOf = (previous: Member | null, next: Member, at: number): RoleChange | null =>
    previous !== null && previous.role !== next.role ? { from: previous.role, to: next.role, at } : null;

  return {
    store: {
      getState: state.getState,
      subscribe: state.subscribe,
      leave: () => conn.leave(),
    },
    applyWelcome(welcome, resumed, now) {
      const previous = state.getState();
      const change = roleChangeOf(previous.member, welcome.member, now);
      state.setState({
        workspace: welcome.workspace,
        member: welcome.member,
        settings: welcome.settings,
        generation: resumed ? previous.generation : previous.generation + 1,
        resumed,
        roleChange: change ?? previous.roleChange,
        clockSkewMs: welcome.serverTime - now,
      });
      return change;
    },
    bind(onRoleChange, now) {
      const offMember = conn.on('channel.memberUpdated', ({ member }) => {
        const previous = state.getState();
        // Only our own record comes on this event (recipients:self); ignore anything else defensively.
        if (previous.member !== null && previous.member.userId !== member.userId) return;
        const change = roleChangeOf(previous.member, member, now());
        state.setState({ ...previous, member, roleChange: change ?? previous.roleChange });
        if (change) onRoleChange(change);
      });
      const offSettings = conn.on('channel.settingsUpdated', ({ settings }) => {
        state.setState((previous) => ({ ...previous, settings }));
      });
      return () => {
        offMember();
        offSettings();
      };
    },
  };
}
