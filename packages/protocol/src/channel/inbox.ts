// One subscription to a transport for the whole life of a connection: during the handshake the driver pulls frames
// with next(); afterwards the queue (including frames the peer pipelined) is handed to the SecureChannel in order.
import { ChannelError } from './errors.ts';
import type { Transport, TransportCloseEvent } from './transport.ts';

export interface InboxSink {
  frame(frame: Uint8Array): void;
  close(event: TransportCloseEvent): void;
}

export class FrameInbox {
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private readonly maxQueuedBytes: number;
  private waiter: { resolve(frame: Uint8Array): void; reject(err: unknown): void } | null = null;
  private closeEvent: TransportCloseEvent | null = null;
  private failure: unknown = null;
  private sink: InboxSink | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(transport: Transport, maxQueuedBytes: number) {
    this.maxQueuedBytes = maxQueuedBytes;
    this.unsubscribe = [
      transport.onMessage((frame) => this.onFrame(frame)),
      transport.onClose((event) => this.onClose(event)),
    ];
  }

  private onFrame(frame: Uint8Array): void {
    if (this.sink) {
      this.sink.frame(frame);
      return;
    }
    if (this.failure || this.closeEvent) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(frame);
      return;
    }
    this.queuedBytes += frame.length;
    if (this.queuedBytes > this.maxQueuedBytes) {
      this.fail(new ChannelError('overflow', 'peer sent too much data during the handshake'));
      return;
    }
    this.queue.push(frame);
  }

  private onClose(event: TransportCloseEvent): void {
    if (this.sink) {
      this.sink.close(event);
      return;
    }
    this.closeEvent = event;
    if (this.waiter && this.queue.length === 0) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(new ChannelError('closed', 'transport closed during the handshake'));
    }
  }

  /** The next frame; rejects when the inbox failed or the transport closed with nothing queued. One caller at a time. */
  next(): Promise<Uint8Array> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new ChannelError('protocol', 'concurrent read'));
    const frame = this.queue.shift();
    if (frame) {
      this.queuedBytes -= frame.length;
      return Promise.resolve(frame);
    }
    if (this.closeEvent) return Promise.reject(new ChannelError('closed', 'transport closed during the handshake'));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** Fails the pending and every later next() with `error` (deadline, cancellation, overflow). */
  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  /** Switches to push mode: queued frames go to `sink` now, in order, then every later frame and the close event. */
  handOff(sink: InboxSink): void {
    if (this.sink) throw new Error('inbox already handed off');
    this.sink = sink;
    const queued = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const frame of queued) sink.frame(frame);
    if (this.closeEvent) sink.close(this.closeEvent);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }
}
