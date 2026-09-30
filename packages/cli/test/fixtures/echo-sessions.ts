// TEST ONLY: a stand-in for the sessions module that runs no process at all. A session is an "echo terminal": the
// owner's input comes back as output (\r → \r\n); the input `exit N\r` ends it with exit code N. Viewers get exactly
// the message flow of the real module (session.attach → snapshot + nextOffset, then exec.output by absolute offset,
// exec.resize to viewers when the owner resizes, session.state on changes), so the CLI's attach runs unchanged over it
// in-process, through the relay path with real Noise channels.
import { randomBytes } from 'node:crypto';
import { DisposableStack, type DaemonContext, type FeatureModule } from '@smurg/daemon';
import { SmurgError, type SessionInfo } from '@smurg/protocol';

interface EchoSession {
  info: SessionInfo;
  output: Uint8Array[];
  offset: number;
  readonly viewers: Set<string>;
}

export interface EchoSessions {
  readonly module: FeatureModule;
  readonly sessions: Map<string, EchoSession>;
  /** Everything the owner typed, per session (to prove non-owners' keys never arrive). */
  readonly inputs: Map<string, string>;
  /** Writes output as if the program printed it. */
  print(sessionId: string, text: string): void;
}

export function echoSessions(): EchoSessions {
  const sessions = new Map<string, EchoSession>();
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
  const find = (id: string): EchoSession => {
    const s = sessions.get(id);
    if (!s) throw new SmurgError('not_found', '找不到這個 session');
    return s;
  };

  const module: FeatureModule = {
    name: 'sessions',
    register: (router, ctx) => {
      ctxRef = ctx;
      const stack = new DisposableStack();
      stack.add(
        router.handle('session.create', (payload, req) => {
          const now = ctx.clock.now();
          const s: EchoSession = {
            info: {
              id: `ses_${randomBytes(12).toString('hex')}`,
              kind: payload.kind,
              ownerUserId: req.userId,
              ownerName: req.member.displayName,
              title: payload.title ?? 'echo',
              sandboxed: req.role !== 'host',
              root: { kind: 'main' },
              status: 'running',
              cols: payload.cols,
              rows: payload.rows,
              createdAt: now,
              login: 'unknown',
              attached: 0,
            },
            output: [],
            offset: 0,
            viewers: new Set(),
          };
          sessions.set(s.info.id, s);
          publish(s);
          return { session: s.info };
        }),
      );
      stack.add(router.handle('session.list', () => ({ sessions: [...sessions.values()].map((s) => s.info) })));
      stack.add(
        router.handle('session.attach', (payload, req) => {
          const s = find(payload.sessionId);
          if (req.userId === s.info.ownerUserId && payload.cols !== undefined && payload.rows !== undefined) {
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
        router.on('exec.input', (payload, req) => {
          const s = find(payload.sessionId);
          req.requireOwner(s.info.ownerUserId, 'session');
          if (s.info.status === 'exited') throw new SmurgError('conflict', 'session 已結束');
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
          req.requireOwner(s.info.ownerUserId, 'session');
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
  };
}
