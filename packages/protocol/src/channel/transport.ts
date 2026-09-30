// The byte pipe a channel runs over: one binary WebSocket message = one frame. The browser's and Node's WebSocket
// (via transportFromWebSocket), the daemon's per-connection view of its multiplexed relay socket, and the in-memory
// pair used by tests all implement this interface.

export interface TransportCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

export interface Transport {
  /** Sends one frame. Must preserve order. Frames sent after close are dropped silently (like a WebSocket). */
  send(frame: Uint8Array): void;
  /**
   * Registers a handler for incoming frames, in order. Returns an unsubscribe function. The frame buffer belongs to
   * the receiver. Implementations should buffer frames that arrive while no handler is registered.
   */
  onMessage(handler: (frame: Uint8Array) => void): () => void;
  /** Registers a handler that runs once when the transport has closed (either side). Returns an unsubscribe function. */
  onClose(handler: (event: TransportCloseEvent) => void): () => void;
  /** Closes the transport. Idempotent. Frames already sent are still delivered to the peer before its close event. */
  close(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared endpoint plumbing: ordered delivery, buffering until a message handler exists, close after pending frames.
// ---------------------------------------------------------------------------------------------------------------

type EndpointEvent = { kind: 'message'; frame: Uint8Array } | { kind: 'close'; event: TransportCloseEvent };

/**
 * Delivers events to handlers strictly in order. A message waits (and blocks the queue) until a message handler is
 * registered, so nothing is lost and the close event never overtakes a frame.
 */
class EndpointDispatcher {
  private readonly queue: EndpointEvent[] = [];
  private readonly messageHandlers = new Set<(frame: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  private closeEvent: TransportCloseEvent | null = null;
  private scheduled = false;
  private pumping = false;

  push(event: EndpointEvent): void {
    this.queue.push(event);
    this.schedule();
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

  private schedule(): void {
    if (this.scheduled || this.pumping) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    this.pumping = true;
    try {
      for (;;) {
        const next = this.queue[0];
        if (!next) return;
        if (next.kind === 'message') {
          if (this.messageHandlers.size === 0) return;
          this.queue.shift();
          for (const handler of [...this.messageHandlers]) handler(next.frame);
        } else {
          this.queue.shift();
          if (this.closeEvent) continue;
          this.closeEvent = next.event;
          const handlers = [...this.closeHandlers];
          this.closeHandlers.clear();
          for (const handler of handlers) handler(next.event);
        }
      }
    } finally {
      this.pumping = false;
      // A handler may have been registered or an event pushed while pumping.
      if (this.queue.length > 0 && (this.queue[0]?.kind === 'close' || this.messageHandlers.size > 0)) this.schedule();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// In-memory pair (tests of every package)
// ---------------------------------------------------------------------------------------------------------------

export type MemoryDirection = 'client->daemon' | 'daemon->client';

export interface MemoryTransportPairOptions {
  /**
   * A man in the middle: sees every frame (already copied) and returns the frames to forward instead (an empty array
   * drops it; several frames inject). Use it to log what a relay would see or to tamper.
   */
  tap?: (frame: Uint8Array, direction: MemoryDirection) => readonly Uint8Array[];
}

export interface MemoryTransportPair {
  readonly client: Transport;
  readonly daemon: Transport;
  /** Every frame that crossed the pair, as sent (before the tap), in order. */
  readonly log: readonly { readonly direction: MemoryDirection; readonly frame: Uint8Array }[];
}

/**
 * Two connected transports. Delivery is asynchronous (microtasks) and ordered, like a WebSocket; frames are copied
 * on send; frames arriving before a message handler exists are buffered; close() on either end delivers everything
 * already sent and then closes both ends.
 */
export function createMemoryTransportPair(options: MemoryTransportPairOptions = {}): MemoryTransportPair {
  const log: { direction: MemoryDirection; frame: Uint8Array }[] = [];
  const toClient = new EndpointDispatcher();
  const toDaemon = new EndpointDispatcher();
  let closed = false;

  const endpoint = (inbox: EndpointDispatcher, outbox: EndpointDispatcher, direction: MemoryDirection): Transport => ({
    send(frame: Uint8Array): void {
      if (closed) return;
      const copy = frame.slice();
      log.push({ direction, frame: copy.slice() });
      const out = options.tap ? options.tap(copy, direction) : [copy];
      for (const f of out) outbox.push({ kind: 'message', frame: f });
    },
    onMessage: (handler) => inbox.onMessage(handler),
    onClose: (handler) => inbox.onClose(handler),
    close(code?: number, reason?: string): void {
      if (closed) return;
      closed = true;
      const event: TransportCloseEvent = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
      toClient.push({ kind: 'close', event });
      toDaemon.push({ kind: 'close', event });
    },
  });

  return {
    client: endpoint(toClient, toDaemon, 'client->daemon'),
    daemon: endpoint(toDaemon, toClient, 'daemon->client'),
    log,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// WHATWG WebSocket adapter (browsers, Node >= 22's global WebSocket)
// ---------------------------------------------------------------------------------------------------------------

/** The subset of the WHATWG WebSocket API the adapter needs. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  /** ArrayBuffer-backed bytes only: the DOM's send takes BufferSource, which excludes views on a SharedArrayBuffer. */
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
}

const WS_OPEN = 1;

export interface WebSocketTransportOptions {
  /**
   * Text frames on the same socket (relay control JSON, "pong"). They never enter the channel; without this callback
   * they are ignored.
   */
  onText?: (text: string) => void;
}

/**
 * Wraps an OPEN WebSocket. Binary messages become frames; text messages go to `onText`. Sets `binaryType` to
 * "arraybuffer". Frames sent while the socket is not open are dropped (the channel fails by deadline or close).
 */
export function transportFromWebSocket(ws: WebSocketLike, options: WebSocketTransportOptions = {}): Transport {
  ws.binaryType = 'arraybuffer';
  const dispatcher = new EndpointDispatcher();
  const onMessage = (event: { data: unknown }): void => {
    const { data } = event;
    if (typeof data === 'string') options.onText?.(data);
    else if (data instanceof ArrayBuffer) dispatcher.push({ kind: 'message', frame: new Uint8Array(data) });
    else if (ArrayBuffer.isView(data)) {
      dispatcher.push({ kind: 'message', frame: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() });
    }
  };
  const onClose = (event: { code: number; reason: string }): void => {
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    dispatcher.push({ kind: 'close', event: { code: event.code, reason: event.reason } });
  };
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  return {
    send(frame: Uint8Array): void {
      if (ws.readyState === WS_OPEN) ws.send(frame.buffer instanceof ArrayBuffer ? (frame as Uint8Array<ArrayBuffer>) : new Uint8Array(frame));
    },
    onMessage: (handler) => dispatcher.onMessage(handler),
    onClose: (handler) => dispatcher.onClose(handler),
    close(code?: number, reason?: string): void {
      try {
        ws.close(code, reason);
      } catch {
        ws.close();
      }
    },
  };
}
