// Presence (SPEC R7, R11): who is online, which agents run, what everyone looks at. The daemon broadcasts the whole
// picture as presence.state; the client reports its own active file with presence.update.
import { fileRefEquals, type FileRef, type PresenceAgent, type PresenceMember } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import type { AreaLifecycle, StoreContext } from './base.ts';

export interface PresenceState {
  readonly members: readonly PresenceMember[];
  readonly agents: readonly PresenceAgent[];
  /** False until the first presence.state of the current channel (members then holds only yourself). */
  readonly received: boolean;
  /** What this client last reported as its active file. */
  readonly activeFile: FileRef | null;
}

export interface PresenceStore extends ReadableStore<PresenceState> {
  /** Reports the file this member is looking at (null = none). Re-sent after every full resync. */
  setActiveFile(file: FileRef | null): void;
}

export const INITIAL_PRESENCE_STATE: PresenceState = Object.freeze({ members: [], agents: [], received: false, activeFile: null });

// ---- selectors

export const selectOnlineMembers = (state: PresenceState): readonly PresenceMember[] => state.members.filter((m) => m.online);
export const selectPresenceMember = (state: PresenceState, userId: string): PresenceMember | undefined =>
  state.members.find((m) => m.userId === userId);
export const selectAgents = (state: PresenceState): readonly PresenceAgent[] => state.agents;
/** Members and agents currently looking at `file` (for editor tabs and tree badges). */
export function selectViewersOf(state: PresenceState, file: FileRef): { members: PresenceMember[]; agents: PresenceAgent[] } {
  return {
    members: state.members.filter((m) => m.activeFile !== undefined && fileRefEquals(m.activeFile, file)),
    agents: state.agents.filter((a) => a.activeFile !== undefined && fileRefEquals(a.activeFile, file)),
  };
}

export function createPresenceArea(): { store: PresenceStore; lifecycle: AreaLifecycle } {
  const state = createStore<PresenceState>(INITIAL_PRESENCE_STATE);
  let ctx: StoreContext | null = null;

  const send = (file: FileRef | null): void => {
    try {
      // Presence is best effort: never queue it behind a reconnect (a resync re-sends it anyway).
      ctx?.conn.notify('presence.update', { activeFile: file }, { whenDisconnected: 'drop' });
    } catch {
      // A closed connection: nothing to report to.
    }
  };

  const store: PresenceStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    setActiveFile(file) {
      const current = state.getState().activeFile;
      if ((current === null && file === null) || (current !== null && file !== null && fileRefEquals(current, file))) return;
      state.setState((previous) => ({ ...previous, activeFile: file }));
      send(file);
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(context) {
      ctx = context;
      return context.conn.on('presence.state', ({ members, agents }) => {
        state.setState((previous) => ({ ...previous, members, agents, received: true }));
      });
    },
    reset() {
      const self = ctx?.conn.welcome?.member;
      state.setState((previous) => ({
        members: self ? [{ ...self, online: true, connections: 1 }] : [],
        agents: [],
        received: false,
        activeFile: previous.activeFile,
      }));
    },
    async load() {
      // The daemon forgot our active file with the old channel.
      const active = state.getState().activeFile;
      if (active !== null) send(active);
    },
  };

  return { store, lifecycle };
}
