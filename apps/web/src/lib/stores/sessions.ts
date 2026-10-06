// Every session of the workspace (ARCHITECTURE §5.5): agent sessions (conversations) and terminals (PTYs), live
// through session.list + session.state. Also the requests about a session that are not the conversation itself
// (rename, end, who is responsible, the permission mode, stop, retry: the conversation's events and cards are the
// conversations store's), and for terminals the routing of their stream (exec.output / exec.resize) to viewers.
//
// What is in the list: the sessions of every topic that is not archived, and the sessions without a topic. A topic
// that is archived or deleted takes its sessions out of the list; `ofTopic()` reads the sessions of one topic,
// archived or not (earlier attempts, earlier discussions).
//
// Terminal viewers (features/agents):
//   const off = sessions.stream(id, { output: (chunk) => …, resize: (size) => … });   // subscribe FIRST
//   const attached = await sessions.attach({ sessionId: id, haveOffset, cols, rows }); // snapshot or delta, then live
// exec.output and exec.resize are delivered in stream order (resize applies between the right bytes; render at the
// PTY size, pty-packaging.md gotcha 4). After a full resync (workspace `generation` changes) the daemon forgot the
// attachment: attach again, passing the last offset you rendered as `haveOffset`.
import {
  collectPages,
  isSessionOver,
  sessionTitleRef,
  type AgentSession,
  type LoginState,
  type PayloadInputOf,
  type PayloadOf,
  type PermissionMode,
  type ResultOf,
  type SessionInfo,
  type TerminalSession,
} from '@smurg/protocol';
import { renderEnglish } from '@smurg/protocol/i18n';
import { tStores } from '../../strings/stores.ts';
import { renderWireText } from '../errors.ts';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, mapWith, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface SessionsState extends Loadable {
  readonly sessions: ReadonlyMap<string, SessionInfo>;
  /**
   * Sessions of archived topics that were looked up with ofTopic(): not part of the list, but a column can show
   * them (an archived topic's conversations stay readable until the topic is deleted).
   */
  readonly others: ReadonlyMap<string, SessionInfo>;
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
  /** Who may: `mayEndSession` (@smurg/protocol). `keepWorktree` answers "Keep the worktree?" of a free session. */
  end(sessionId: string, options?: { keepWorktree?: boolean }): Promise<void>;
  /** Host only: end anyone's session (admin.session.terminate). */
  terminate(sessionId: string): Promise<void>;
  /** session.drive. */
  rename(sessionId: string, title: string): Promise<SessionInfo>;
  /** session.drive: runs `claude auth status` (the host's Claude login, which every agent session uses). */
  loginStatus(sessionId: string): Promise<LoginState>;
  /**
   * Every session of one topic, archived or not, newest first (earlier attempts, earlier discussions). The ones the
   * list does not hold (an archived topic's) are kept in `others`.
   */
  ofTopic(topicId: string): Promise<SessionInfo[]>;

  // ---- agent sessions (session.drive; the daemon refuses a terminal with reason `not-an-agent`)
  /** Stop the agent's current turn. */
  interrupt(sessionId: string): Promise<void>;
  /** "Try again" of a failed session. */
  retry(sessionId: string): Promise<AgentSession>;
  /** "Restart this session's agent now" (a notice with `action: 'restart-agent'`). */
  restart(sessionId: string): Promise<AgentSession>;
  /** `null`: nobody is responsible (everyone watches). */
  setResponsible(sessionId: string, userId: string | null): Promise<AgentSession>;
  setMode(sessionId: string, mode: PermissionMode): Promise<AgentSession>;
  /** The always-allowed kinds of the session and what the host's own Claude Code rules add (session.view). */
  rules(sessionId: string): Promise<ResultOf<'session.rules.get'>>;
  removeRule(sessionId: string, ruleId: string): Promise<AgentSession>;

  // ---- terminals
  attach(input: PayloadInputOf<'session.attach'>): Promise<ResultOf<'session.attach'>>;
  detach(sessionId: string): void;
  /** session.drive (host and members with agent access, any terminal): keystrokes / paste. */
  input(sessionId: string, data: Uint8Array): void;
  /** session.drive; the web sends it from the panel of the member who opened the terminal only (terminal-fit.ts). */
  resize(sessionId: string, cols: number, rows: number): void;
  /** Receives exec.output / exec.resize of one terminal, in stream order. */
  stream(sessionId: string, listener: TerminalStreamListener): () => void;
}

export const INITIAL_SESSIONS_STATE: SessionsState = Object.freeze({ status: 'idle', error: null, sessions: new Map(), others: new Map() });

// ---- selectors

/** Newest first. */
export const selectSessionList = (state: SessionsState): SessionInfo[] => [...state.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
/** A session by id: one of the list, or one of an archived topic that was looked up. */
export const selectSession = (state: SessionsState, id: string): SessionInfo | undefined => state.sessions.get(id) ?? state.others.get(id);
export const selectSessionsOf = (state: SessionsState, userId: string): SessionInfo[] =>
  selectSessionList(state).filter((session) => session.openedBy.userId === userId);
export const selectRunningSessions = (state: SessionsState): SessionInfo[] => selectSessionList(state).filter((session) => !isSessionOver(session));
/** A terminal (a PTY the terminal panel attaches to), as opposed to an agent session (a conversation). */
export const isTerminalSession = (session: SessionInfo): session is TerminalSession => session.kind === 'terminal';
export const isAgentSession = (session: SessionInfo): session is AgentSession => session.kind === 'agent';
/** The terminals, newest first. */
export const selectTerminalList = (state: SessionsState): TerminalSession[] => selectSessionList(state).filter(isTerminalSession);
/** The agent sessions (conversations), newest first. */
export const selectAgentList = (state: SessionsState): AgentSession[] => selectSessionList(state).filter(isAgentSession);
/** The agent sessions of one topic, oldest first (the discussion, then the items' attempts as they were started). */
export const selectTopicSessions = (state: SessionsState, topicId: string): AgentSession[] =>
  selectAgentList(state)
    .filter((session) => session.topicId === topicId)
    .sort((a, b) => a.createdAt - b.createdAt);

export function createSessionsArea(): { store: SessionsStore; lifecycle: AreaLifecycle } {
  const state = createStore<SessionsState>(INITIAL_SESSIONS_STATE);
  const listeners = new Map<string, Set<TerminalStreamListener>>();
  /** Topics known to be archived: their sessions are not in the list (session.list leaves them out too). */
  const archivedTopics = new Set<string>();
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('sessions store is not bound to a connection');
    return ctx;
  };

  const ofArchivedTopic = (session: SessionInfo): boolean => session.kind === 'agent' && session.topicId !== undefined && archivedTopics.has(session.topicId);

  const upsert = <S extends SessionInfo>(session: S): S => {
    state.setState((previous) => {
      if (ofArchivedTopic(session)) return previous.others.has(session.id) ? { ...previous, others: mapWith(previous.others, session.id, session) } : previous;
      return { ...previous, sessions: mapWith(previous.sessions, session.id, session) };
    });
    return session;
  };

  /**
   * Takes a topic's sessions out of the list. Archived (`forget` false): they stay readable in `others`, so a column
   * that shows one keeps its content. Deleted (`forget` true): they are gone.
   */
  const dropTopic = (topicId: string, forget: boolean): void => {
    const ofTopic = (session: SessionInfo): boolean => session.kind === 'agent' && session.topicId === topicId;
    state.setState((previous) => {
      const moved = [...previous.sessions.values()].filter(ofTopic);
      const others = new Map([...previous.others].filter(([, session]) => !(forget && ofTopic(session))));
      if (!forget) for (const session of moved) others.set(session.id, session);
      if (moved.length === 0 && others.size === previous.others.size) return previous;
      return { ...previous, sessions: mapFrom([...previous.sessions.values()].filter((session) => !ofTopic(session)), (s) => s.id), others };
    });
  };

  const listAll = (c: StoreContext, topicId?: string): Promise<SessionInfo[]> =>
    // `session.list` follows the list rule: read every page.
    collectPages(async (after) => {
      const page = await c.conn.request('session.list', { ...(topicId === undefined ? {} : { topicId }), ...(after === undefined ? {} : { after }) });
      return { items: page.sessions, hasMore: page.hasMore };
    }, (session: SessionInfo) => session.id);

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => listAll(c),
      (sessions) => state.setState((previous) => ({ ...previous, ...readyState(), sessions: mapFrom(sessions, (s) => s.id) })),
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
      return upsert((await context().conn.request('session.create', input)).session);
    },
    async end(sessionId, options = {}) {
      await context().conn.request('session.end', options.keepWorktree === undefined ? { sessionId } : { sessionId, keepWorktree: options.keepWorktree });
    },
    async terminate(sessionId) {
      await context().conn.request('admin.session.terminate', { sessionId });
    },
    async rename(sessionId, title) {
      return upsert((await context().conn.request('session.rename', { sessionId, title })).session);
    },
    async loginStatus(sessionId) {
      return (await context().conn.request('session.loginStatus', { sessionId })).login;
    },
    async ofTopic(topicId) {
      const c = context();
      const generation = c.generation();
      const sessions = (await listAll(c, topicId)).sort((a, b) => b.createdAt - a.createdAt);
      if (c.generation() === generation) {
        state.setState((previous) => {
          const extra = sessions.filter((session) => !previous.sessions.has(session.id));
          if (extra.length === 0) return previous;
          const others = new Map(previous.others);
          for (const session of extra) others.set(session.id, session);
          return { ...previous, others };
        });
      }
      return sessions;
    },
    async interrupt(sessionId) {
      await context().conn.request('session.interrupt', { sessionId });
    },
    async retry(sessionId) {
      return upsert((await context().conn.request('session.retry', { sessionId })).session);
    },
    async restart(sessionId) {
      return upsert((await context().conn.request('session.restart', { sessionId })).session);
    },
    async setResponsible(sessionId, userId) {
      return upsert((await context().conn.request('session.responsible.set', { sessionId, userId })).session);
    },
    async setMode(sessionId, mode) {
      return upsert((await context().conn.request('session.mode.set', { sessionId, mode })).session);
    },
    rules(sessionId) {
      return context().conn.request('session.rules.get', { sessionId });
    },
    async removeRule(sessionId, ruleId) {
      return upsert((await context().conn.request('session.rule.remove', { sessionId, ruleId })).session);
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
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offs = [
        c.conn.on('session.state', ({ session }) => {
          upsert(session);
        }),
        c.conn.on('exec.output', (payload) => dispatch(payload.sessionId, 'output', payload)),
        c.conn.on('exec.resize', (payload) => dispatch(payload.sessionId, 'resize', payload)),
        // A deleted topic takes its sessions along (the wire's topic.removed names only the topic).
        c.conn.on('topic.removed', ({ topicId }) => {
          archivedTopics.delete(topicId);
          dropTopic(topicId, true);
        }),
        // An archived topic's sessions leave the list; a restored topic's sessions come back with a fresh list.
        c.conn.on('topic.updated', ({ topic }) => {
          if (topic.archived && !archivedTopics.has(topic.id)) {
            archivedTopics.add(topic.id);
            dropTopic(topic.id, false);
          } else if (!topic.archived && archivedTopics.delete(topic.id)) {
            load().catch((error: unknown) => c.reportError('sessions', error));
          }
        }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    reset() {
      archivedTopics.clear();
      state.setState(INITIAL_SESSIONS_STATE);
    },
    load,
  };
  return { store, lifecycle };
}

// ---------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------

/** What the title helpers read of a session (`title` is present only when a person gave one: P0-API §3.1). */
export interface TitledSession {
  readonly kind: SessionInfo['kind'];
  readonly openedBy: { readonly displayName: string };
  readonly title?: string | undefined;
  /** An agent session's purpose and, for a work item's session, the item: what names a topic's session. */
  readonly purpose?: AgentSession['purpose'] | undefined;
  readonly item?: AgentSession['item'] | undefined;
}

function typedTitle(session: TitledSession): string | undefined {
  const title = session.title?.trim();
  return title === undefined || title === '' ? undefined : title;
}

/**
 * The name of a session wherever it stands alone (rows, column headers, menus): the title a person gave it, else the
 * one rule of the wire catalogue (`sessionTitleRef`), in the viewer's language: "Terminal (Ian)", "Claude (Ian)",
 * "Discussion", "2 · Payment form". The host never sends a default title: one stored spelling could only be in one
 * language.
 */
export function sessionTitle(session: TitledSession): string {
  const typed = typedTitle(session);
  if (typed !== undefined) return typed;
  const ref = sessionTitleRef({
    kind: session.kind,
    // Only the name is read.
    openedBy: { userId: '', displayName: session.openedBy.displayName },
    ...(session.purpose === undefined ? {} : { purpose: session.purpose }),
    ...(session.item === undefined ? {} : { item: session.item }),
  });
  return renderWireText(ref, renderEnglish(ref));
}

/**
 * The name of a session for wording that already names the person who opened it ("Ian's worktree (Terminal)"): the
 * typed title, else the bare kind ("Claude", "Terminal").
 */
export function plainSessionTitle(session: TitledSession): string {
  return typedTitle(session) ?? tStores(`session.kind.${session.kind}`);
}
