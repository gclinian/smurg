// An established, authenticated channel. It treats application messages as opaque bytes (msgpack Envelopes are the
// codec's business). Any integrity failure, unexpected frame or oversized message closes it for good: after
// reconnecting the keys are fresh and nonces restart, so the application resends by `seq` (noise.md gotcha 7).
import { MAX_RELAY_FRAME } from '../constants.ts';
import { ChannelError } from './errors.ts';
import { CHANNEL_FRAME } from './frames.ts';
import type { FrameInbox } from './inbox.ts';
import type { RecordOpener, RecordSealer } from './records.ts';
import type { Transport, TransportCloseEvent } from './transport.ts';

export interface ChannelCloseEvent {
  /** 'local': close() was called; 'remote': the transport closed underneath; 'error': a fatal error (see `error`). */
  readonly initiator: 'local' | 'remote' | 'error';
  readonly error?: ChannelError;
  readonly code?: number;
  readonly reason?: string;
}

export interface SecureChannel {
  /** The peer's static public key, authenticated by the handshake (daemon key for clients, device key for the daemon). */
  readonly remoteStaticKey: Uint8Array;
  /** Noise handshake hash `h`; identical on both ends (channel binding). */
  readonly handshakeHash: Uint8Array;
  /** Largest message send() accepts and the peer's reassembly cap we assume. */
  readonly maxMessageBytes: number;
  readonly isClosed: boolean;
  /**
   * Encrypts and sends one application message. Throws ChannelError('too-large') for an oversized message (the
   * channel stays open) and ChannelError('closed') after close.
   */
  send(message: Uint8Array): void;
  /**
   * Registers a handler for decrypted messages, in order. Each message is a fresh buffer. Messages that arrive before
   * the first handler is registered are buffered. A handler that throws closes the channel ('handler-error').
   */
  onMessage(handler: (message: Uint8Array) => void): () => void;
  /** Runs once when the channel closes (immediately, asynchronously, if it already has). */
  onClose(handler: (event: ChannelCloseEvent) => void): () => void;
  /** Closes the channel and its transport. Idempotent. */
  close(code?: number, reason?: string): void;
}

/** Bytes the channel buffers while no onMessage handler exists before it gives up ('overflow'). */
const MAX_BUFFERED_BYTES = 4 * MAX_RELAY_FRAME;

type QueuedEvent = { kind: 'message'; message: Uint8Array } | { kind: 'close'; event: ChannelCloseEvent };

export interface SecureChannelParts {
  transport: Transport;
  inbox: FrameInbox;
  sealer: RecordSealer;
  opener: RecordOpener;
  remoteStaticKey: Uint8Array;
  handshakeHash: Uint8Array;
  /** Messages decrypted during the handshake (after the verdict) that belong to the application. */
  initialMessages?: readonly Uint8Array[];
}

/** Internal: only the handshake drivers construct channels. */
export function createSecureChannel(parts: SecureChannelParts): SecureChannel {
  return new SecureChannelImpl(parts);
}

class SecureChannelImpl implements SecureChannel {
  readonly remoteStaticKey: Uint8Array;
  readonly handshakeHash: Uint8Array;
  private readonly transport: Transport;
  private readonly inbox: FrameInbox;
  private readonly sealer: RecordSealer;
  private readonly opener: RecordOpener;
  private readonly messageHandlers = new Set<(message: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(event: ChannelCloseEvent) => void>();
  private readonly queue: QueuedEvent[] = [];
  private queuedBytes = 0;
  private closed = false;
  private closeEvent: ChannelCloseEvent | null = null;
  private dispatching = false;

  constructor(parts: SecureChannelParts) {
    this.transport = parts.transport;
    this.inbox = parts.inbox;
    this.sealer = parts.sealer;
    this.opener = parts.opener;
    this.remoteStaticKey = parts.remoteStaticKey.slice();
    this.handshakeHash = parts.handshakeHash.slice();
    for (const message of parts.initialMessages ?? []) this.enqueue({ kind: 'message', message });
    this.inbox.handOff({
      frame: (frame) => this.onFrame(frame),
      close: (event) => this.onTransportClose(event),
    });
  }

  get maxMessageBytes(): number {
    return this.sealer.maxMessageBytes;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(message: Uint8Array): void {
    if (this.closed) throw new ChannelError('closed', 'channel is closed');
    let frame: Uint8Array;
    try {
      frame = this.sealer.seal(message);
    } catch (err) {
      if (err instanceof ChannelError && err.code === 'too-large') throw err;
      const error = err instanceof ChannelError ? err : new ChannelError('protocol', 'sealing failed', { cause: err });
      this.fail(error);
      throw error;
    }
    this.transport.send(frame);
  }

  onMessage(handler: (message: Uint8Array) => void): () => void {
    this.messageHandlers.add(handler);
    // Buffered messages are delivered after onMessage returned, never re-entrantly during the registration call
    // (a handler that unsubscribes itself would otherwise run before it has its unsubscribe function).
    queueMicrotask(() => this.drain());
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: (event: ChannelCloseEvent) => void): () => void {
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

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    // The application asked to stop: undelivered messages are dropped.
    this.purgeMessages();
    this.finish({ initiator: 'local', ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    this.transport.close(code, reason);
  }

  // ---- inbound

  private onFrame(frame: Uint8Array): void {
    if (this.closed) return;
    if (frame[0] !== CHANNEL_FRAME.DATA) {
      // ABORT is only legal before authentication; anything else here is a forgery or a broken peer.
      this.fail(new ChannelError('protocol', `unexpected frame type ${frame[0]} on an established channel`));
      return;
    }
    let messages: Uint8Array[];
    try {
      messages = this.opener.open(frame);
    } catch (err) {
      this.fail(err instanceof ChannelError ? err : new ChannelError('integrity', 'record rejected', { cause: err }));
      return;
    }
    for (const message of messages) this.enqueue({ kind: 'message', message });
  }

  private onTransportClose(event: TransportCloseEvent): void {
    if (this.closed) return;
    this.finish({ initiator: 'remote', ...event });
  }

  private fail(error: ChannelError): void {
    if (this.closed) return;
    this.finish({ initiator: 'error', error });
    this.transport.close();
  }

  private finish(event: ChannelCloseEvent): void {
    this.closed = true;
    this.inbox.dispose();
    this.enqueue({ kind: 'close', event });
  }

  // ---- ordered delivery: messages first, then the close event; messages wait for a handler.

  private purgeMessages(): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]?.kind === 'message') this.queue.splice(i, 1);
    this.queuedBytes = 0;
  }

  private enqueue(event: QueuedEvent): void {
    if (event.kind === 'message') {
      this.queuedBytes += event.message.length;
      if (this.messageHandlers.size === 0 && this.queuedBytes > MAX_BUFFERED_BYTES && !this.closed) {
        this.queue.push(event);
        this.fail(new ChannelError('overflow', 'too many messages buffered before an onMessage handler was registered'));
        return;
      }
    }
    this.queue.push(event);
    this.drain();
  }

  private drain(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (;;) {
        const next = this.queue[0];
        if (!next) return;
        if (next.kind === 'message') {
          if (this.messageHandlers.size === 0) return;
          this.queue.shift();
          this.queuedBytes -= next.message.length;
          // After a transport close or an integrity error, messages that authenticated before it are still delivered,
          // then the close event. After a handler error nothing more is delivered.
          for (const handler of [...this.messageHandlers]) {
            try {
              handler(next.message);
            } catch (cause) {
              this.purgeMessages();
              this.fail(new ChannelError('handler-error', 'an onMessage handler threw', { cause }));
              break;
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
              // A throwing close handler must not prevent the others from running.
            }
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}
