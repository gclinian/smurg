// The CLI side of the daemon's control socket (ARCHITECTURE §8 "Control socket"; frames in @smurg/daemon's
// local protocol): one-shot `status` / `stop` requests, and the host's local attach, which carries msgpack Envelopes
// both ways on a normal logical channel of the host (seq, channel.ack, requests, events) without Noise and without
// the relay. A disconnect ends the attach; the CLI does not resume (a new `smurg attach` starts a fresh channel).
import { createConnection, type Socket } from 'node:net';
import { SmurgError, decodeEnvelope, encodeEnvelope, type PayloadInputOf, type ResultOf, type Welcome } from '@smurg/protocol';
import type { EventHandler, EventMeta, InteractiveEventType, InteractiveNotifyType, InteractiveRequestType, RequestOptions } from '@smurg/protocol/client';
import { CTL_FRAME_KIND, CtlFrameDecoder, encodeCtlControl, encodeCtlFrame, parseCtlResponse, type CtlRequest, type CtlResponse } from '@smurg/daemon';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { m, wireError } from '../i18n/index.ts';
import { closedMessage, type ChannelEnd, type ChannelStatus, type WorkspaceChannel } from './channel.ts';

const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ACK_DELAY_MS = 250;
const ACK_EVERY = 32;

function connect(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CliError(m('ctl.connectTimeout')));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new CliError(m('ctl.notRunning'), { exitCode: EXIT.notRunning }));
      else reject(new CliError(m('ctl.connectFailed', { code: err.code ?? 'unknown' })));
    });
  });
}

/** Reads frames from `socket` until the first control response. */
function readResponse(socket: Socket, decoder: CtlFrameDecoder, timeoutMs: number, onRest: (rest: Uint8Array[]) => void): Promise<CtlResponse> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const fail = (err: CliError): void => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new CliError(m('ctl.requestTimeout'))), timeoutMs);
    const onData = (chunk: Buffer): void => {
      let frames;
      try {
        frames = decoder.push(new Uint8Array(chunk));
      } catch {
        fail(new CliError(m('ctl.badResponse')));
        return;
      }
      if (frames.length === 0) return;
      const [first, ...rest] = frames;
      if (!first || first.kind !== CTL_FRAME_KIND.control) {
        fail(new CliError(m('ctl.badResponse')));
        return;
      }
      let response: CtlResponse;
      try {
        response = parseCtlResponse(first.body);
      } catch {
        fail(new CliError(m('ctl.badResponse')));
        return;
      }
      cleanup();
      // Paused until the channel's own listener is attached: nothing that follows the response may be dropped.
      socket.pause();
      onRest(rest.map((f) => f.body));
      resolve(response);
    };
    const onClose = (): void => fail(new CliError(m('ctl.closedEarly')));
    const onError = (): void => undefined;
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.on('error', onError);
  });
}

/** `status` or `stop`: one request, one response, then the daemon closes the socket. */
export async function ctlRequest(path: string, request: Extract<CtlRequest, { op: 'status' | 'stop' }>, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<CtlResponse> {
  const socket = await connect(path, CONNECT_TIMEOUT_MS);
  try {
    socket.write(encodeCtlControl(request));
    return await readResponse(socket, new CtlFrameDecoder(), timeoutMs, () => {});
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
    socket.on('close', () => this.finish(this.closedReason === null ? { reason: 'disconnected', message: m('ctl.disconnected') } : { reason: endReason(this.closedReason), message: closedMessage(this.closedReason) }));
    socket.resume();
  }

  /** Attaches to the daemon behind `path` as the host (the socket's file mode is the credential). */
  static async open(path: string, options: { readonly deviceName: string }): Promise<LocalWorkspaceChannel> {
    const socket = await connect(path, CONNECT_TIMEOUT_MS);
    const decoder = new CtlFrameDecoder();
    let rest: Uint8Array[] = [];
    try {
      socket.write(encodeCtlControl({ v: 1, op: 'attach', deviceName: options.deviceName }));
      const response = await readResponse(socket, decoder, RESPONSE_TIMEOUT_MS, (r) => {
        rest = r;
      });
      if (!response.ok) throw new CliError(m('ctl.attachRefused', { reason: wireError(response.error) }));
      if (response.op !== 'attach') throw new CliError(m('ctl.badResponse'));
      const channel = new LocalWorkspaceChannel(socket, decoder, response.welcome);
      for (const body of rest) channel.onEnvelope(body);
      return channel;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  request<T extends InteractiveRequestType>(type: T, payload: PayloadInputOf<T>, options: RequestOptions = {}): Promise<ResultOf<T>> {
    if (this.ended) return Promise.reject(new CliError(this.ended.message));
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
      this.closedReason = 'protocol-error';
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.kind !== CTL_FRAME_KIND.envelope) {
        this.closedReason = 'protocol-error';
        this.socket.destroy();
        return;
      }
      this.onEnvelope(frame.body);
    }
  }

  private onEnvelope(body: Uint8Array): void {
    const decoded = decodeEnvelope(body, { from: 'daemon', channel: 'interactive' });
    if (!decoded.ok) return;
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

  private finish(end: ChannelEnd): void {
    if (this.ended) return;
    this.ended = end;
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer);
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new CliError(end.message));
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
