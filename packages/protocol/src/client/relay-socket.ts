// One client WebSocket to the relay: relay control frames (text JSON), the "ping"/"pong" heartbeat with its
// watchdog, `bye`, and the binary tunnel to the daemon (ARCHITECTURE §4 "Liveness", §6; relay.md §1.2, gotchas 2, 6).
//
// The tunnel is handed out as "sessions": each Noise handshake runs over its own virtual Transport, so after the host
// went offline and came back a new handshake can run on the same socket, and closing a session never closes the
// socket.
import { PONG_WATCHDOG_MS, RELAY_PING_INTERVAL_MS } from '../constants.ts';
import type { Transport, TransportCloseEvent } from '../channel/transport.ts';
import {
  RELAY_PING,
  parseRelayToClientText,
  type RelayHelloFrame,
  type RelayHostOfflineReason,
} from '../relay/frames.ts';
import {
  WS_OPEN,
  sendableBytes,
  type ClientWebSocket,
  type ClientWebSocketCloseEvent,
  type ClientWebSocketMessageEvent,
} from './websocket.ts';

export type RelaySocketFailure =
  /** The socket never opened (network error, relay down, or an HTTP refusal such as 401, which browsers hide). */
  | 'open-failed'
  /** The socket closed underneath us without a `bye`. */
  | 'closed'
  /** No "pong" (nor anything else) for PONG_WATCHDOG_MS after a ping: the path is dead even if TCP says otherwise. */
  | 'watchdog'
  /** The socket opened but the relay never sent its `hello`. */
  | 'no-hello';

export interface RelaySocketHandlers {
  hello(frame: RelayHelloFrame): void;
  hostOnline(): void;
  hostOffline(reason: RelayHostOfflineReason): void;
  /** The relay is about to close the socket. The socket is already terminated when this runs. */
  bye(code: number, reason: string): void;
  /** Never called after terminate(). */
  failed(cause: RelaySocketFailure, event?: ClientWebSocketCloseEvent): void;
  /** A text frame that is not a valid relay control frame (ignored). */
  invalidText?(detail: string): void;
}

export interface RelaySocketOptions {
  url: string;
  createWebSocket: (url: string) => ClientWebSocket;
  handlers: RelaySocketHandlers;
  now: () => number;
  pingIntervalMs?: number;
  watchdogMs?: number;
  openTimeoutMs?: number;
  helloTimeoutMs?: number;
}

/** Timer granularity of the heartbeat. */
const TICK_MS = 500;
/** A tick this much later than scheduled means the timers were throttled (background tab): skip the watchdog once. */
const LATE_TICK_MS = 4 * TICK_MS;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

export class RelaySocket {
  private readonly options: RelaySocketOptions;
  private readonly handlers: RelaySocketHandlers;
  private readonly pingIntervalMs: number;
  private readonly watchdogMs: number;
  private ws: ClientWebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private terminated = false;
  private opened = false;
  private helloSeen = false;
  private createdAt = 0;
  private openedAt = 0;
  private lastTickAt = 0;
  private lastPingAt = 0;
  /** Time of the first ping sent since anything was last received; null while the relay is known alive. */
  private pingOutstandingSince: number | null = null;
  private session: VirtualTransport | null = null;

  constructor(options: RelaySocketOptions) {
    this.options = options;
    this.handlers = options.handlers;
    this.pingIntervalMs = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
    this.watchdogMs = options.watchdogMs ?? PONG_WATCHDOG_MS;
  }

  get isOpen(): boolean {
    return this.opened && !this.terminated && this.ws?.readyState === WS_OPEN;
  }

  /** Bytes the local socket still has to hand to the network (0 when there is no socket). */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  open(): void {
    if (this.ws || this.terminated) throw new Error('RelaySocket.open() called twice');
    const now = this.options.now();
    this.createdAt = now;
    this.lastTickAt = now;
    let ws: ClientWebSocket;
    try {
      ws = this.options.createWebSocket(this.options.url);
      ws.binaryType = 'arraybuffer';
    } catch {
      // Report asynchronously so the caller's state is consistent when the handler runs.
      queueMicrotask(() => this.fail('open-failed'));
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', this.onOpen);
    ws.addEventListener('message', this.onMessage);
    ws.addEventListener('close', this.onClose);
    ws.addEventListener('error', this.onError);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Closes the socket without waiting for anything and without calling any handler again (used on `bye`, on
   * failures and on purpose). The active session sees a close.
   */
  terminate(code = 1000, reason = ''): void {
    if (this.terminated) return;
    this.terminated = true;
    this.stop();
    const ws = this.ws;
    if (ws) {
      ws.removeEventListener('open', this.onOpen);
      ws.removeEventListener('message', this.onMessage);
      ws.removeEventListener('close', this.onClose);
      ws.removeEventListener('error', this.onError);
      try {
        ws.close(code, reason);
      } catch {
        try {
          ws.close();
        } catch {
          // Already closed.
        }
      }
    }
    this.endSession({ code, reason });
  }

  /**
   * A fresh virtual Transport for one handshake + channel. Any previous session is closed first (only one Noise session
   * per socket at a time; the daemon keys sessions by connection id).
   */
  openSession(): Transport {
    this.endSession({ reason: 'superseded' });
    const session = new VirtualTransport(
      (frame) => {
        if (this.session === session && this.isOpen) this.ws?.send(sendableBytes(frame));
      },
      () => {
        if (this.session === session) this.session = null;
      },
    );
    this.session = session;
    if (this.terminated) session.finish({ reason: 'socket closed' });
    return session;
  }

  /** Ends the current session (its channel closes after the frames it already holds); the socket stays open. */
  closeSession(): void {
    this.endSession({ reason: 'session closed' });
  }

  // ---- WebSocket events (arrow functions: stable identities for removeEventListener)

  private readonly onOpen = (): void => {
    if (this.terminated) return;
    this.opened = true;
    this.openedAt = this.options.now();
    this.sendPing();
  };

  private readonly onError = (): void => {
    // A close event always follows; nothing to do here.
  };

  private readonly onClose = (event: ClientWebSocketCloseEvent): void => {
    if (this.terminated) return;
    this.fail(this.opened ? 'closed' : 'open-failed', event);
  };

  private readonly onMessage = (event: ClientWebSocketMessageEvent): void => {
    if (this.terminated) return;
    // Anything from the relay proves the path is alive (a pong can queue behind big frames on the transfer socket).
    this.pingOutstandingSince = null;
    const { data } = event;
    if (typeof data === 'string') {
      this.onText(data);
      return;
    }
    let frame: Uint8Array;
    if (data instanceof ArrayBuffer) frame = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    else return;
    this.session?.deliver(frame);
  };

  private onText(text: string): void {
    const message = parseRelayToClientText(text);
    if (message.kind === 'ping' || message.kind === 'pong') return;
    if (message.kind === 'invalid') {
      this.handlers.invalidText?.(`${message.reason}: ${message.detail.slice(0, 200)}`);
      return;
    }
    const frame = message.frame;
    switch (frame.t) {
      case 'hello':
        this.helloSeen = true;
        this.handlers.hello(frame);
        return;
      case 'host.online':
        this.handlers.hostOnline();
        return;
      case 'host.offline':
        this.handlers.hostOffline(frame.reason);
        return;
      case 'bye':
        // Act now: Node clients see the close event only when the TCP FIN arrives, 10-16 s later (relay.md V11).
        this.terminate(1000, 'bye');
        this.handlers.bye(frame.code, frame.reason);
        return;
    }
  }

  // ---- heartbeat

  private tick(): void {
    if (this.terminated) return;
    const now = this.options.now();
    const late = now - this.lastTickAt > LATE_TICK_MS;
    this.lastTickAt = now;
    if (!this.opened) {
      if (now - this.createdAt >= (this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS)) this.fail('open-failed');
      return;
    }
    if (!this.helloSeen && now - this.openedAt >= (this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)) {
      this.fail('no-hello');
      return;
    }
    // Throttled timers (hidden tab) must not count as lost pongs: restart the measurement from this tick.
    if (late) this.pingOutstandingSince = null;
    if (this.pingOutstandingSince !== null && now - this.pingOutstandingSince >= this.watchdogMs) {
      this.fail('watchdog');
      return;
    }
    if (late || now - this.lastPingAt >= this.pingIntervalMs) this.sendPing();
  }

  private sendPing(): void {
    if (!this.isOpen) return;
    const now = this.options.now();
    this.lastPingAt = now;
    if (this.pingOutstandingSince === null) this.pingOutstandingSince = now;
    try {
      this.ws?.send(RELAY_PING);
    } catch {
      // The close event follows.
    }
  }

  private fail(cause: RelaySocketFailure, event?: ClientWebSocketCloseEvent): void {
    if (this.terminated) return;
    this.terminate(1000, cause);
    this.handlers.failed(cause, event);
  }

  private stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private endSession(event: TransportCloseEvent): void {
    const session = this.session;
    this.session = null;
    session?.finish(event);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Virtual transport: ordered delivery, frames buffered until a handler exists, close after pending frames.
// ---------------------------------------------------------------------------------------------------------------

type SessionEvent = { kind: 'frame'; frame: Uint8Array } | { kind: 'close'; event: TransportCloseEvent };

class VirtualTransport implements Transport {
  private readonly sendFrame: (frame: Uint8Array) => void;
  private readonly onDetach: () => void;
  private readonly queue: SessionEvent[] = [];
  private readonly messageHandlers = new Set<(frame: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  private finished = false;
  private closeEvent: TransportCloseEvent | null = null;
  private scheduled = false;

  constructor(sendFrame: (frame: Uint8Array) => void, onDetach: () => void) {
    this.sendFrame = sendFrame;
    this.onDetach = onDetach;
  }

  send(frame: Uint8Array): void {
    if (!this.finished) this.sendFrame(frame);
  }

  onMessage(handler: (frame: Uint8Array) => void): () => void {
    this.messageHandlers.add(handler);
    this.schedule();
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: (event: TransportCloseEvent) => void): () => void {
    if (this.closeEvent) {
      const event = this.closeEvent;
      queueMicrotask(() => handler(event));
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /** Ends this session only; the socket stays open. */
  close(code?: number, reason?: string): void {
    this.finish({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
  }

  deliver(frame: Uint8Array): void {
    if (this.finished) return;
    this.queue.push({ kind: 'frame', frame });
    this.schedule();
  }

  finish(event: TransportCloseEvent): void {
    if (this.finished) return;
    this.finished = true;
    this.onDetach();
    this.queue.push({ kind: 'close', event });
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    for (;;) {
      const next = this.queue[0];
      if (!next) return;
      // Handlers belong to the channel layer, which catches its own errors; a throw here must not wedge the queue.
      if (next.kind === 'frame') {
        if (this.messageHandlers.size === 0) return;
        this.queue.shift();
        for (const handler of [...this.messageHandlers]) {
          try {
            handler(next.frame);
          } catch {
            // See above.
          }
        }
      } else {
        this.queue.shift();
        if (this.closeEvent) continue;
        this.closeEvent = next.event;
        const handlers = [...this.closeHandlers];
        this.closeHandlers.clear();
        for (const handler of handlers) {
          try {
            handler(next.event);
          } catch {
            // See above.
          }
        }
      }
    }
  }
}
