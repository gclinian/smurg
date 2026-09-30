// The hub's channel for a host-local client of the control socket (ARCHITECTURE §7.1, §8). A relay client's channel
// is a Noise SecureChannel; here the bytes never leave the host's machine and the 0600 socket authenticates the host's
// OS account, so the channel is a plain pass-through with the same contract the hub relies on: in-order delivery of
// fresh buffers, close events exactly once, nothing sent before the owner is ready (the Welcome goes out first).
import type { ChannelCloseEvent } from '@smurg/protocol';
import type { HubChannel } from '../core/hub.ts';

export interface LocalChannelSink {
  send(bytes: Uint8Array): void;
  close(): void;
}

export class LocalChannel implements HubChannel {
  private readonly sink: LocalChannelSink;
  private messageHandler: ((message: Uint8Array) => void) | null = null;
  private readonly closeHandlers = new Set<(event: ChannelCloseEvent) => void>();
  private closeEvent: ChannelCloseEvent | null = null;
  /** Daemon messages held until open(); null once open. */
  private held: Uint8Array[] | null = [];

  constructor(sink: LocalChannelSink) {
    this.sink = sink;
  }

  get isClosed(): boolean {
    return this.closeEvent !== null;
  }

  send(message: Uint8Array): void {
    if (this.closeEvent) return;
    if (this.held) this.held.push(message);
    else this.sink.send(message);
  }

  onMessage(handler: (message: Uint8Array) => void): () => void {
    this.messageHandler = handler;
    return () => {
      if (this.messageHandler === handler) this.messageHandler = null;
    };
  }

  onClose(handler: (event: ChannelCloseEvent) => void): () => void {
    const event = this.closeEvent;
    if (event) {
      queueMicrotask(() => handler(event));
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** The daemon closes (stop, protocol error, the host's own kick is impossible): the socket goes too. */
  close(): void {
    if (!this.finish({ initiator: 'local' })) return;
    try {
      this.sink.close();
    } catch {
      // The socket is already gone.
    }
  }

  /** The Welcome went out: deliver what the hub queued (a resumed channel's replay) and everything after it. */
  open(): void {
    const held = this.held;
    this.held = null;
    if (!held || this.closeEvent) return;
    for (const message of held) this.sink.send(message);
  }

  /** One client Envelope from the socket. A copy: decoded byte fields alias their input buffer. */
  deliver(bytes: Uint8Array): void {
    if (this.closeEvent) return;
    this.messageHandler?.(bytes.slice());
  }

  /** The socket closed underneath. */
  remoteClosed(): void {
    this.finish({ initiator: 'remote' });
  }

  private finish(event: ChannelCloseEvent): boolean {
    if (this.closeEvent) return false;
    this.closeEvent = event;
    this.held = null;
    for (const handler of [...this.closeHandlers]) handler(event);
    this.closeHandlers.clear();
    return true;
  }
}
