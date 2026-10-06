// TEST ONLY: a stand-in for the sessions module that runs no process at all. A session is an "echo terminal" (every
// session it OPENS is a terminal: `smurg attach` attaches to nothing else; an agent session is a conversation, and a
// test may add some with `addAgent` so that `session.list` names them and `session.attach` refuses them as the real
// module does): what a driver types comes back as output (\r → \r\n); the input `exit N\r` ends it with exit code N. Viewers get exactly
// the message flow of the real module (session.attach → snapshot + nextOffset, then exec.output by absolute offset,
// exec.resize to viewers when the owner resizes, session.state on changes), so the CLI's attach runs unchanged over it
// in-process, through the relay path with real Noise channels. The access rules are the real module's (ARCHITECTURE
// §11 D-15): the router lets only `session.drive` (the host, agent access) send exec.input, into ANY session; only
// the owner (who opened it) resizes it.
import { randomBytes } from 'node:crypto';
import { DisposableStack, notImplemented, type DaemonContext, type FeatureModule } from '@smurg/daemon';
import { SmurgError, type AgentSession, type TerminalSession } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';

interface EchoSession {
  info: TerminalSession;
  output: Uint8Array[];
  offset: number;
  readonly viewers: Set<string>;
}

export interface EchoSessions {
  readonly module: FeatureModule;
  readonly sessions: Map<string, EchoSession>;
  /** Everything typed into each session (to prove whose keys arrive and whose never do). */
  readonly inputs: Map<string, string>;
  /** Writes output as if the program printed it. */
  print(sessionId: string, text: string): void;
  /**
   * Opens a session for `ownerUserId` directly on the daemon side, as session.create from that member's web client
   * would (the control socket, i.e. `smurg attach`, cannot open sessions: review F1).
   */
  open(input: EchoOpen): TerminalSession;
  /** An agent session (a conversation) the workspace also has: listed after the terminals, never attachable. */
  addAgent(session: AgentSession): void;
}

export interface EchoOpen {
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly title?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export function echoSessions(): EchoSessions {
  const sessions = new Map<string, EchoSession>();
  const agents = new Map<string, AgentSession>();
  const inputs = new Map<string, string>();
  let ctxRef: DaemonContext | null = null;

  const publish = (s: EchoSession): void => {
    s.info = { ...s.info, attached: s.viewers.size };
    ctxRef?.hub.broadcast('session.state', { session: s.info });
  };
  const emit = (s: EchoSession, data: Uint8Array): void => {
    if (data.length === 0) return;
    const offset = s.offset;
    s.output.push(data);
    s.offset += data.length;
    for (const channelId of s.viewers) ctxRef?.hub.send(channelId, 'exec.output', { sessionId: s.info.id, offset, data });
  };
  const create = (input: EchoOpen): TerminalSession => {
    const s: EchoSession = {
      info: {
        id: `ses_${randomBytes(12).toString('hex')}`,
        kind: 'terminal',
        openedBy: { userId: input.ownerUserId, displayName: input.ownerName },
        // Only a title the opener typed, as the daemon does: without one each client words the default itself.
        ...(input.title !== undefined ? { title: input.title } : {}),
        root: { kind: 'main' },
        status: 'running',
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        createdAt: ctxRef?.clock.now() ?? Date.now(),
        attached: 0,
      },
      output: [],
      offset: 0,
      viewers: new Set(),
    };
    sessions.set(s.info.id, s);
    publish(s);
    return s.info;
  };
  const find = (id: string): EchoSession => {
    const s = sessions.get(id);
    if (!s) throw new SmurgError('not_found', 'That session was not found.');
    return s;
  };

  const module: FeatureModule = {
    name: 'sessions',
    register: (router, ctx) => {
      ctxRef = ctx;
      const stack = new DisposableStack();
      stack.add(
        router.handle('session.create', (payload, req) => {
          if (payload.kind !== 'terminal') throw notImplemented('agent sessions');
          return { session: create({ ownerUserId: req.userId, ownerName: req.member.displayName, cols: payload.cols, rows: payload.rows, ...(payload.title !== undefined ? { title: payload.title } : {}) }) };
        }),
      );
      stack.add(router.handle('session.list', () => ({ sessions: [...[...sessions.values()].map((s) => s.info), ...agents.values()], hasMore: false })));
      stack.add(
        router.handle('session.attach', (payload, req) => {
          // The check `terminal-session` of the real handler (ARCHITECTURE §5.5): a conversation has no PTY.
          if (agents.has(payload.sessionId)) throw new SmurgError('bad_request', msg('session.notTerminal'), { reason: 'not-a-terminal' });
          const s = find(payload.sessionId);
          if (req.userId === s.info.openedBy.userId && payload.cols !== undefined && payload.rows !== undefined) {
            s.info = { ...s.info, cols: payload.cols, rows: payload.rows };
          }
          const data = Buffer.concat(s.output.map((b) => Buffer.from(b)));
          const channelId = req.conn.channelId;
          req.afterReply(() => {
            s.viewers.add(channelId);
            publish(s);
          });
          return { session: s.info, mode: 'snapshot' as const, data: new Uint8Array(data), cols: s.info.cols, rows: s.info.rows, nextOffset: s.offset };
        }),
      );
      stack.add(
        router.on('session.detach', (payload, req) => {
          const s = sessions.get(payload.sessionId);
          if (s?.viewers.delete(req.conn.channelId)) publish(s);
        }),
      );
      stack.add(
        // The router already checked `session.drive` (protocol registry): any session, whoever opened it.
        router.on('exec.input', (payload) => {
          const s = find(payload.sessionId);
          if (s.info.status === 'exited') throw new SmurgError('conflict', 'The session has ended.');
          const text = Buffer.from(payload.data).toString('utf8');
          inputs.set(s.info.id, (inputs.get(s.info.id) ?? '') + text);
          emit(s, new TextEncoder().encode(text.replace(/\r/g, '\r\n')));
          const exit = /exit (\d+)\r/.exec(inputs.get(s.info.id) ?? '');
          if (exit) {
            s.info = { ...s.info, status: 'exited', exitCode: Number(exit[1]), endedAt: ctx.clock.now() };
            publish(s);
          }
        }),
      );
      stack.add(
        router.on('exec.resize', (payload, req) => {
          const s = find(payload.sessionId);
          req.requireOwner(s.info.openedBy.userId, 'session');
          s.info = { ...s.info, cols: payload.cols, rows: payload.rows };
          for (const channelId of s.viewers) ctx.hub.send(channelId, 'exec.resize', { sessionId: s.info.id, cols: payload.cols, rows: payload.rows });
          publish(s);
        }),
      );
      stack.add(
        ctx.bus.on('channel.discarded', ({ channelId }) => {
          for (const s of sessions.values()) s.viewers.delete(channelId);
        }),
      );
      return stack;
    },
  };
  return {
    module,
    sessions,
    inputs,
    print: (sessionId, text) => emit(find(sessionId), new TextEncoder().encode(text)),
    open: (input) => create(input),
    addAgent: (session) => {
      agents.set(session.id, session);
    },
  };
}
