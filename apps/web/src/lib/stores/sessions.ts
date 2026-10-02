// Agent sessions and terminals (SPEC R4, ARCHITECTURE §5.5): the live list (session.list + session.state), the
// requests around a session, and the routing of its terminal stream (exec.output / exec.resize) to viewers.
//
// Terminal viewers (the agents feature):
//   const off = sessions.stream(id, { output: (chunk) => …, resize: (size) => … });   // subscribe FIRST
//   const attached = await sessions.attach({ sessionId: id, haveOffset, cols, rows }); // snapshot or delta, then live
// exec.output and exec.resize are delivered in stream order (resize applies between the right bytes; render at the
// PTY size, pty-packaging.md gotcha 4). After a full resync (workspace `generation` changes) the daemon forgot the
// attachment: attach again, passing the last offset you rendered as `haveOffset`.
import { defaultSessionTitle, type MessageRef, type PayloadInputOf, type PayloadOf, type ResultOf, type SessionInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { tStores } from '../../strings/stores.ts';
import { renderWireText } from '../errors.ts';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, mapWith, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface SessionsState extends Loadable {
  readonly sessions: ReadonlyMap<string, SessionInfo>;
  /** The session the agents panel shows (set by the focusSession command). */
  readonly focusedId: string | null;
}

export type ExecOutput = PayloadOf<'exec.output'>;
export type ExecResize = PayloadOf<'exec.resize'>;

export interface TerminalStreamListener {
  output(chunk: ExecOutput): void;
  resize(size: ExecResize): void;
}

export interface SessionsStore extends ReadableStore<SessionsState> {
  reload(): Promise<void>;
  /** Host and members with agent access (session.create); every session runs as the host. */
  create(input: PayloadInputOf<'session.create'>): Promise<SessionInfo>;
  /** The member who opened it. `keepWorktree` answers the R9 question "Keep the worktree?". */
  end(sessionId: string, options?: { keepWorktree?: boolean }): Promise<void>;
  /** Host only: end anyone's session (admin.session.terminate). */
  terminate(sessionId: string): Promise<void>;
  /** session.drive: runs `claude auth status` (the host's Claude login, which every session uses). */
  loginStatus(sessionId: string): Promise<ResultOf<'session.loginStatus'>['login']>;
  attach(input: PayloadInputOf<'session.attach'>): Promise<ResultOf<'session.attach'>>;
  detach(sessionId: string): void;
  /** session.drive (host and members with agent access, any session): keystrokes / paste. */
  input(sessionId: string, data: Uint8Array): void;
  /** session.drive; the web sends it from the panel of the member who opened the session only (terminal-fit.ts). */
  resize(sessionId: string, cols: number, rows: number): void;
  /** Receives exec.output / exec.resize of one session, in stream order. */
  stream(sessionId: string, listener: TerminalStreamListener): () => void;
  focus(sessionId: string | null): void;
}

export const INITIAL_SESSIONS_STATE: SessionsState = Object.freeze({ status: 'idle', error: null, sessions: new Map(), focusedId: null });

// ---- selectors

/** Newest first. */
export const selectSessionList = (state: SessionsState): SessionInfo[] => [...state.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
export const selectSession = (state: SessionsState, id: string): SessionInfo | undefined => state.sessions.get(id);
export const selectSessionsOf = (state: SessionsState, userId: string): SessionInfo[] =>
  selectSessionList(state).filter((session) => session.ownerUserId === userId);
export const selectRunningSessions = (state: SessionsState): SessionInfo[] => selectSessionList(state).filter((session) => session.status !== 'exited');

export function createSessionsArea(): { store: SessionsStore; lifecycle: AreaLifecycle } {
  const state = createStore<SessionsState>(INITIAL_SESSIONS_STATE);
  const listeners = new Map<string, Set<TerminalStreamListener>>();
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('sessions store is not bound to a connection');
    return ctx;
  };

  const upsert = (session: SessionInfo): void => {
    state.setState((previous) => ({ ...previous, sessions: mapWith(previous.sessions, session.id, session) }));
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => c.conn.request('session.list', {}),
      ({ sessions }) => state.setState((previous) => ({ ...previous, ...readyState(), sessions: mapFrom(sessions, (s) => s.id) })),
    );
  };

  const dispatch = <K extends keyof TerminalStreamListener>(sessionId: string, kind: K, payload: Parameters<TerminalStreamListener[K]>[0]): void => {
    const set = listeners.get(sessionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener[kind] as (value: typeof payload) => void)(payload);
      } catch (error) {
        ctx?.reportError('sessions', error);
      }
    }
  };

  const store: SessionsStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async create(input) {
      const { session } = await context().conn.request('session.create', input);
      upsert(session);
      return session;
    },
    async end(sessionId, options = {}) {
      await context().conn.request('session.end', options.keepWorktree === undefined ? { sessionId } : { sessionId, keepWorktree: options.keepWorktree });
    },
    async terminate(sessionId) {
      await context().conn.request('admin.session.terminate', { sessionId });
    },
    async loginStatus(sessionId) {
      return (await context().conn.request('session.loginStatus', { sessionId })).login;
    },
    async attach(input) {
      const result = await context().conn.request('session.attach', input);
      upsert(result.session);
      return result;
    },
    detach(sessionId) {
      try {
        context().conn.notify('session.detach', { sessionId }, { whenDisconnected: 'drop' });
      } catch {
        // closed connection: nothing is attached any more
      }
    },
    input(sessionId, data) {
      context().conn.notify('exec.input', { sessionId, data });
    },
    resize(sessionId, cols, rows) {
      context().conn.notify('exec.resize', { sessionId, cols, rows }, { whenDisconnected: 'drop' });
    },
    stream(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(sessionId);
        current?.delete(listener);
        if (current && current.size === 0) listeners.delete(sessionId);
      };
    },
    focus(sessionId) {
      state.setState((previous) => (previous.focusedId === sessionId ? previous : { ...previous, focusedId: sessionId }));
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offs = [
        c.conn.on('session.state', ({ session }) => upsert(session)),
        c.conn.on('exec.output', (payload) => dispatch(payload.sessionId, 'output', payload)),
        c.conn.on('exec.resize', (payload) => dispatch(payload.sessionId, 'resize', payload)),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    reset() {
      state.setState((previous) => ({ ...INITIAL_SESSIONS_STATE, focusedId: previous.focusedId }));
    },
    load,
  };
  return { store, lifecycle };
}

/** What the title helpers read of a session (`title` is present only when the member who opened it typed one). */
export interface TitledSession {
  readonly kind: SessionInfo['kind'];
  readonly ownerName: string;
  readonly title?: string | undefined;
}

/** The default title as a message of the wire catalogue: one wording for the web app and the CLI. */
function defaultTitleRef(session: TitledSession): MessageRef {
  return session.kind === 'agent' ? msg('session.title.agent', { owner: session.ownerName }) : msg('session.title.terminal', { owner: session.ownerName });
}

function typedTitle(session: TitledSession): string | undefined {
  const title = session.title?.trim();
  return title === undefined || title === '' ? undefined : title;
}

/**
 * The name of a session wherever it stands alone (tabs, lists, menus): the title its opener typed, else a default
 * built here from the kind and the opener's name, in the viewer's language ("Terminal (Ian)"). The host never sends
 * a default title: one stored spelling could only be in one language.
 */
export function sessionTitle(session: TitledSession): string {
  return typedTitle(session) ?? renderWireText(defaultTitleRef(session), defaultSessionTitle(session.kind, session.ownerName));
}

/**
 * The name of a session for wording that already names the person who opened it ("Ian's worktree (Terminal)"): the
 * typed title, else the bare kind ("Claude", "Terminal").
 */
export function plainSessionTitle(session: TitledSession): string {
  return typedTitle(session) ?? tStores(`session.kind.${session.kind}`);
}
