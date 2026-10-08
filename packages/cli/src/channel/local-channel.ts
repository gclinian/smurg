// The CLI side of the daemon's control socket (ARCHITECTURE §8 "Control socket"; frames in @smurg/daemon's
// local protocol): one-shot `status` / `stop` requests, and the host's local attach, which carries msgpack Envelopes
// both ways on a normal logical channel of the host (seq, channel.ack, requests, events) without Noise and without
// the relay. A disconnect ends the attach; the CLI does not resume (a new `smurg attach` starts a fresh channel).
//
// A daemon of ANOTHER smurg version (0.5.1, DESIGN B1/B2). The daemon behind a control socket may be older or newer
// than this command (the installer replaced the executable under a running share; two smurgs on one machine). A
// request to it therefore has three outcomes (`ctlAsk`), never two:
//   - nothing there: the connect failed (no socket file, nobody listening);
//   - an answer this command can read (the command-side schemas of @smurg/daemon: unknown keys are ignored);
//   - alive but unreadable: the connect succeeded (or hung: something holds the socket) and the answer could not be
//     read, or none came. That is "a smurg host of another version is sharing here", never "nothing is running".
// And a local attach ends AT ONCE on the first frame from the daemon it cannot decode, with that same explanation: it
// used to drop the frame and wait out its 30 s request timer ("smurg host did not answer (session.list)").
import { createConnection, type Socket } from 'node:net';
import { SmurgError, decodeEnvelope, encodeEnvelope, type PayloadInputOf, type ResultOf, type Welcome } from '@smurg/protocol';
import type { EventHandler, EventMeta, InteractiveEventType, InteractiveNotifyType, InteractiveRequestType, RequestOptions } from '@smurg/protocol/client';
import { CTL_FRAME_KIND, CtlFrameDecoder, encodeCtlControl, encodeCtlFrame, readCtlResponse, type CtlRequest, type CtlResponseRead } from '@smurg/daemon';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { m, wireError, type Text } from '../i18n/index.ts';
import type { UnreadableHost } from '../i18n/en.ts';
import { CLI_VERSION } from '../version.ts';
import { closedMessage, type ChannelEnd, type ChannelStatus, type WorkspaceChannel } from './channel.ts';

const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ACK_DELAY_MS = 250;
const ACK_EVERY = 32;

/** Why a running smurg host could not be read; `message`: a frame after a successful attach. */
export type { UnreadableHost } from '../i18n/en.ts';

/** "A smurg host of another version is sharing here": what `smurg attach` says, and how to get out of it. */
export function otherVersionAttachError(why: UnreadableHost): CliError {
  return new CliError(otherVersionAttachText(why), { hint: m('otherVersion.hint') });
}

function otherVersionAttachText(why: UnreadableHost): Text {
  return m('attach.otherVersion', { current: CLI_VERSION, why });
}

/** How a connect ended when it did not succeed. */
class ConnectFailure extends Error {
  /** `timeout`: neither connected nor refused within the time (something holds the socket); else the errno. */
  readonly code: string;

  constructor(code: string) {
    super(`control socket connect: ${code}`);
    this.name = 'ConnectFailure';
    this.code = code;
  }
}

/** Why no readable response came on a connected socket. */
class ResponseFailure extends Error {
  readonly why: Exclude<UnreadableHost, 'message'>;

  constructor(why: Exclude<UnreadableHost, 'message'>) {
    super(`control socket response: ${why}`);
    this.name = 'ResponseFailure';
    this.why = why;
  }
}

function connect(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ConnectFailure('timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ConnectFailure(err.code ?? 'unknown'));
    });
  });
}

/** A failed connect as `smurg attach` words it (a socket that was just found and is gone again, mostly). */
function connectProblem(err: unknown): unknown {
  if (!(err instanceof ConnectFailure)) return err;
  if (err.code === 'timeout') return otherVersionAttachError('no-answer');
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') return new CliError(m('ctl.notRunning'), { exitCode: EXIT.notRunning });
  return new CliError(m('ctl.connectFailed', { code: err.code }));
}

/** Reads frames from `socket` until the first control response; rejects with a ResponseFailure. */
function readResponse(socket: Socket, decoder: CtlFrameDecoder, timeoutMs: number, onRest: (rest: Uint8Array[]) => void): Promise<CtlResponseRead> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const fail = (why: Exclude<UnreadableHost, 'message'>): void => {
      cleanup();
      socket.destroy();
      reject(new ResponseFailure(why));
    };
    const timer = setTimeout(() => fail('no-answer'), timeoutMs);
    const onData = (chunk: Buffer): void => {
      let frames;
      try {
        frames = decoder.push(new Uint8Array(chunk));
      } catch {
        fail('not-understood');
        return;
      }
      if (frames.length === 0) return;
      const [first, ...rest] = frames;
      if (!first || first.kind !== CTL_FRAME_KIND.control) {
        fail('not-understood');
        return;
      }
      let response: CtlResponseRead;
      try {
        response = readCtlResponse(first.body);
      } catch {
        fail('not-understood');
        return;
      }
      cleanup();
      // Paused until the channel's own listener is attached: nothing that follows the response may be dropped.
      socket.pause();
      onRest(rest.map((f) => f.body));
      resolve(response);
    };
    const onClose = (): void => fail('closed');
    const onError = (): void => undefined;
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.on('error', onError);
  });
}

/** What one `status` or `stop` request to a control socket came to (the three outcomes of the header). */
export type CtlOutcome =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'answer'; readonly response: CtlResponseRead }
  | { readonly kind: 'unreadable'; readonly why: Exclude<UnreadableHost, 'message'> };

/**
 * `status` or `stop`: one request, at most one response, then the socket is closed. Never throws for what the other
 * side does: a daemon that is not there, one that answers, and one whose answer cannot be read are three outcomes.
 * (Both requests have had the same shape in every published version.)
 */
export async function ctlAsk(path: string, request: Extract<CtlRequest, { op: 'status' | 'stop' }>, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<CtlOutcome> {
  let socket: Socket;
  try {
    socket = await connect(path, Math.min(CONNECT_TIMEOUT_MS, timeoutMs));
  } catch (err) {
    if (!(err instanceof ConnectFailure)) throw err;
    // A connect that neither succeeds nor fails: a listener is there and takes no connection. Fail closed: alive.
    return err.code === 'timeout' ? { kind: 'unreadable', why: 'no-answer' } : { kind: 'nothing' };
  }
  try {
    socket.write(encodeCtlControl(request));
    return { kind: 'answer', response: await readResponse(socket, new CtlFrameDecoder(), timeoutMs, () => {}) };
  } catch (err) {
    if (err instanceof ResponseFailure) return { kind: 'unreadable', why: err.why };
    throw err;
  } finally {
    socket.destroy();
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

type Listener = (payload: unknown, meta: EventMeta) => void;

export class LocalWorkspaceChannel implements WorkspaceChannel {
  readonly kind = 'local' as const;
  readonly welcome: Welcome;
  private readonly socket: Socket;
  private readonly decoder: CtlFrameDecoder;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly endListeners = new Set<(end: ChannelEnd) => void>();
  private ended: ChannelEnd | null = null;
  private closedReason: string | null = null;
  /** Set when THIS side ends the attach because the daemon sent something it cannot read. */
  private unreadable: ChannelEnd | null = null;
  private seq = 0;
  private lastSeq = 0;
  private unacked = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private ids = 0;
  private readonly idPrefix = `l${Math.random().toString(36).slice(2, 8)}`;

  private constructor(socket: Socket, decoder: CtlFrameDecoder, welcome: Welcome) {
    this.socket = socket;
    this.decoder = decoder;
    this.welcome = welcome;
    socket.on('data', (chunk: Buffer) => this.onData(new Uint8Array(chunk)));
    socket.on('error', () => undefined);
    socket.on('close', () =>
      this.finish(this.unreadable ?? (this.closedReason === null ? { reason: 'disconnected', message: m('ctl.disconnected') } : { reason: endReason(this.closedReason), message: closedMessage(this.closedReason) })),
    );
    socket.resume();
  }

  /** Attaches to the daemon behind `path` as the host (the socket's file mode is the credential). */
  static async open(path: string, options: { readonly deviceName: string }): Promise<LocalWorkspaceChannel> {
    let socket: Socket;
    try {
      socket = await connect(path, CONNECT_TIMEOUT_MS);
    } catch (err) {
      throw connectProblem(err);
    }
    const decoder = new CtlFrameDecoder();
    let rest: Uint8Array[] = [];
    try {
      socket.write(encodeCtlControl({ v: 1, op: 'attach', deviceName: options.deviceName }));
      const response = await readResponse(socket, decoder, RESPONSE_TIMEOUT_MS, (r) => {
        rest = r;
      });
      if (!response.ok) throw new CliError(m('ctl.attachRefused', { reason: wireError(response.error) }));
      if (response.op !== 'attach') throw otherVersionAttachError('not-understood');
      const channel = new LocalWorkspaceChannel(socket, decoder, response.welcome);
      for (const body of rest) channel.onEnvelope(body);
      return channel;
    } catch (err) {
      socket.destroy();
      // No answer, or one this command cannot read (the welcome of another version): said as that, at once.
      throw err instanceof ResponseFailure ? otherVersionAttachError(err.why) : err;
    }
  }

  request<T extends InteractiveRequestType>(type: T, payload: PayloadInputOf<T>, options: RequestOptions = {}): Promise<ResultOf<T>> {
    if (this.ended) return Promise.reject(this.endError(this.ended));
    const id = `${this.idPrefix}-${++this.ids}`;
    return new Promise<ResultOf<T>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new CliError(m('ctl.noAnswer', { type })));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.send(type, payload, id);
      } catch (err) {
        if (timer !== undefined) clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify<T extends InteractiveNotifyType>(type: T, payload: PayloadInputOf<T>): boolean {
    if (this.ended) return false;
    this.send(type, payload, `${this.idPrefix}-${++this.ids}`);
    return true;
  }

  on<T extends InteractiveEventType>(type: T, handler: EventHandler<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const listener = handler as unknown as Listener;
    set.add(listener);
    return () => set.delete(listener);
  }

  onEnd(listener: (end: ChannelEnd) => void): () => void {
    const ended = this.ended;
    if (ended) {
      queueMicrotask(() => listener(ended));
      return () => {};
    }
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  onRestart(): () => void {
    return () => {};
  }

  onStatus(_listener: (status: ChannelStatus) => void): () => void {
    return () => {};
  }

  close(): void {
    this.flushAck();
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 1_000);
    timer.unref?.();
  }

  private send(type: string, payload: unknown, id: string): void {
    const bytes = encodeEnvelope({ type, id, seq: this.seq + 1, payload } as never, { from: 'client', channel: 'interactive' });
    this.seq += 1;
    this.socket.write(encodeCtlFrame(CTL_FRAME_KIND.envelope, bytes));
  }

  private onData(chunk: Uint8Array): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.endUnreadable();
      return;
    }
    for (const frame of frames) {
      if (this.ended) return;
      if (frame.kind !== CTL_FRAME_KIND.envelope) {
        this.endUnreadable();
        return;
      }
      this.onEnvelope(frame.body);
    }
  }

  /**
   * The daemon sent something this command cannot decode (a frame, or an Envelope: a message type or a payload shape of
   * another smurg version). The attach ends now, with the reason, instead of waiting for an answer that was dropped.
   */
  private endUnreadable(): void {
    if (this.ended) return;
    this.unreadable = { reason: 'protocol-error', message: otherVersionAttachText('message') };
    this.finish(this.unreadable);
    this.socket.destroy();
  }

  private onEnvelope(body: Uint8Array): void {
    if (this.ended) return;
    const decoded = decodeEnvelope(body, { from: 'daemon', channel: 'interactive' });
    if (!decoded.ok) {
      this.endUnreadable();
      return;
    }
    const envelope = decoded.envelope as { type: string; id: string; seq: number; payload: unknown };
    if (envelope.seq > 0) {
      if (envelope.seq <= this.lastSeq) return; // a replay we already processed
      this.lastSeq = envelope.seq;
      this.unacked += 1;
      if (this.unacked >= ACK_EVERY) this.flushAck();
      else if (this.ackTimer === undefined) {
        this.ackTimer = setTimeout(() => this.flushAck(), ACK_DELAY_MS);
        this.ackTimer.unref?.();
      }
    }
    if (envelope.type === 'channel.ack') return;
    const pending = this.pending.get(envelope.id);
    if (pending && (envelope.type === 'error' || envelope.type.endsWith('.ok'))) {
      this.pending.delete(envelope.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (envelope.type === 'error') pending.reject(SmurgError.fromPayload(envelope.payload as Parameters<typeof SmurgError.fromPayload>[0]));
      else pending.resolve(envelope.payload);
      return;
    }
    if (envelope.type === 'channel.closed') this.closedReason = (envelope.payload as { reason: string }).reason;
    for (const listener of this.listeners.get(envelope.type) ?? []) {
      try {
        listener(envelope.payload, { id: envelope.id, seq: envelope.seq });
      } catch {
        // A listener's failure must not stop the stream.
      }
    }
  }

  private flushAck(): void {
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.unacked === 0 || this.ended || this.socket.destroyed) return;
    this.unacked = 0;
    try {
      const bytes = encodeEnvelope({ type: 'channel.ack', id: `${this.idPrefix}-ack`, seq: 0, payload: { upTo: this.lastSeq } }, { from: 'client', channel: 'interactive' });
      this.socket.write(encodeCtlFrame(CTL_FRAME_KIND.envelope, bytes));
    } catch {
      // closing
    }
  }

  /** A request that cannot be answered any more; the "another version" end names the way out as its hint. */
  private endError(end: ChannelEnd): CliError {
    return new CliError(end.message, end === this.unreadable ? { hint: m('otherVersion.hint') } : {});
  }

  private finish(end: ChannelEnd): void {
    if (this.ended) return;
    this.ended = end;
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(this.endError(end));
    }
    this.pending.clear();
    for (const listener of [...this.endListeners]) listener(end);
    this.endListeners.clear();
  }
}

function endReason(reason: string): ChannelEnd['reason'] {
  switch (reason) {
    case 'stopped':
    case 'kicked':
    case 'revoked':
    case 'role-changed':
    case 'protocol-error':
      return reason;
    default:
      return 'closed';
  }
}
