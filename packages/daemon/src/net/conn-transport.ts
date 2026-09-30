// The daemon's view of one relay connection id as a channel Transport: frames go out prefixed with the connection
// id on the shared host socket; frames in are delivered in order, buffered until the channel registers its handler.
// close() only ends this virtual transport (the host socket and other clients are unaffected).
import type { Transport, TransportCloseEvent } from '@smurg/protocol';

type Event = { readonly kind: 'frame'; readonly frame: Uint8Array } | { readonly kind: 'close'; readonly event: TransportCloseEvent };

export class ConnTransport implements Transport {
  private readonly sendFrame: (frame: Uint8Array) => void;
  private readonly onLocalClose: () => void;
  private readonly queue: Event[] = [];
  private readonly messageHandlers = new Set<(frame: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  private finished = false;
  private closeEvent: TransportCloseEvent | null = null;
  private scheduled = false;
  private queuedBytes = 0;
  private readonly maxQueuedBytes: number;

  constructor(sendFrame: (frame: Uint8Array) => void, onLocalClose: () => void, maxQueuedBytes: number) {
    this.sendFrame = sendFrame;
    this.onLocalClose = onLocalClose;
    this.maxQueuedBytes = maxQueuedBytes;
  }

  get isFinished(): boolean {
    return this.finished;
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

  /** The channel layer closed it (handshake failed, channel closed). */
  close(code?: number, reason?: string): void {
    if (this.finished) return;
    this.finish({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    this.onLocalClose();
  }

  /** A frame from the relay for this connection id. Returns false (and ends the transport) on overflow. */
  deliver(frame: Uint8Array): boolean {
    if (this.finished) return false;
    this.queuedBytes += frame.byteLength;
    if (this.queuedBytes > this.maxQueuedBytes) {
      // Nobody consumes: a peer flooding a connection that has no reader yet. Fail closed.
      this.finish({ reason: 'overflow' });
      this.onLocalClose();
      return false;
    }
    this.queue.push({ kind: 'frame', frame });
    this.schedule();
    return true;
  }

  /** The relay connection is gone (peer.close, host socket down). */
  finish(event: TransportCloseEvent): void {
    if (this.finished) return;
    this.finished = true;
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
      if (next.kind === 'frame') {
        if (this.messageHandlers.size === 0) return;
        this.queue.shift();
        this.queuedBytes -= next.frame.byteLength;
        for (const handler of [...this.messageHandlers]) {
          try {
            handler(next.frame);
          } catch {
            // The channel layer handles its own errors; a throw here must not wedge the queue.
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
