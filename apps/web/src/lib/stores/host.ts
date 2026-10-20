// What every member may know about the host's side of agent sessions (ARCHITECTURE §5.9, `HostState`): the state of
// the host's Claude account (the banner of the sessions view, the wording of an `account` inbox row, the line above a
// composer) and whether the main folder's Claude Code project settings are used (the New topic dialog of a member who
// is not the host), the host's agent (protocol 5: the models it offers, its default, whether auto mode and "Asks for
// nothing" can run: the model and mode pickers, the console) and how work items run (`work.history`: the New session
// dialog, the Start dialog, the plan). `session.host.get` once per logical channel, then the event `session.host`;
// `reload()` asks again (the daemon asks its agent for the models when they are not known yet).
import type { AgentHostState, HostState, WorkState } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface HostStoreState extends Loadable {
  /** Null until the first answer. */
  readonly host: HostState | null;
}

export interface HostStore extends ReadableStore<HostStoreState> {
  reload(): Promise<void>;
}

export const INITIAL_HOST_STATE: HostStoreState = Object.freeze({ status: 'idle', error: null, host: null });

export const selectHostState = (state: HostStoreState): HostState | null => state.host;
export const selectAccount = (state: HostStoreState): HostState['account'] | null => state.host?.account ?? null;
/** The host's agent: its models, its default model, what can run. Null until the first answer. */
export const selectAgentHost = (state: HostStoreState): AgentHostState | null => state.host?.agent ?? null;
/** How work items run here (`folder`, `smurg`, `direct`, `unchecked`). Null until the first answer. */
export const selectWork = (state: HostStoreState): WorkState | null => state.host?.work ?? null;

export function createHostArea(): { store: HostStore; lifecycle: AreaLifecycle } {
  const state = createStore<HostStoreState>(INITIAL_HOST_STATE);
  let ctx: StoreContext | null = null;

  const load = (): Promise<void> => {
    if (!ctx) throw new Error('host store is not bound to a connection');
    const c = ctx;
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => c.conn.request('session.host.get', {}),
      (host) => state.setState({ ...readyState(), host }),
    );
  };

  return {
    store: { getState: state.getState, subscribe: state.subscribe, reload: load },
    lifecycle: {
      bind(c) {
        ctx = c;
        return c.conn.on('session.host', (host) => state.setState((previous) => ({ ...previous, host })));
      },
      reset() {
        state.setState(INITIAL_HOST_STATE);
      },
      load,
    },
  };
}
