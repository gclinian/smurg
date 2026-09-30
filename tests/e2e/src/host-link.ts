// The daemon's host sockets as the acceptance tests see them: the daemon's own production socket factory
// (`wsHostSocketFactory`, real `ws` sockets to the real relay), wrapped so that a test can
//
//  - record every frame the daemon sent and received (R3 tap completeness), and
//  - pause the host like a sleeping laptop (R1): while paused NOTHING crosses the boundary between the daemon and its
//    sockets. The daemon's pings and encrypted frames are held back, frames from the relay are held back, and a
//    close / terminate / reconnect the daemon asks for is deferred too, so the TCP connection stays open and silent,
//    exactly what the relay sees when the laptop lid closes. resume() replays everything in its original order, as a
//    process thawing out of SIGSTOP would find it: queued input first, the daemon's reaction after.
//
// Why in-process instead of SIGSTOP on a child: every acceptance test also needs the daemon's audit log, PathGuard and
// member registry in-process. The daemon's own timers keep running while paused (its pong watchdog fires after 6 s
// and schedules a reconnect), but none of that reaches the relay until resume(): the relay-observable behaviour is
// the sleeping laptop's.
import { wsHostSocketFactory, type HostSocket, type HostSocketFactory, type HostSocketHandlers } from '@smurg/daemon';
import type { WireLog } from './wire.ts';

interface LiveSocket {
  readonly label: 'ws' | 'xfer';
  readonly serial: number;
  inner: HostSocket | null;
  open: boolean;
}

export class HostLinkGate {
  private readonly inner: HostSocketFactory;
  private readonly log: WireLog;
  private readonly queue: (() => void)[] = [];
  private readonly sockets: LiveSocket[] = [];
  private paused = false;
  private draining = false;
  /** Date.now() of the last pause(), null while running. */
  pausedAt: number | null = null;
  /** Actions held back during the last pause (diagnostics). */
  heldActions = 0;

  constructor(log: WireLog, inner: HostSocketFactory = wsHostSocketFactory()) {
    this.log = log;
    this.inner = inner;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The factory handed to createDaemon({ relay: { socketFactory } }). */
  readonly factory: HostSocketFactory = (url, headers, handlers) => {
    const live: LiveSocket = { label: url.includes('/xfer/') ? 'xfer' : 'ws', serial: this.log.nextSocket(), inner: null, open: false };
    this.sockets.push(live);
    const wrapped: HostSocketHandlers = {
      open: () =>
        this.run(() => {
          live.open = true;
          handlers.open();
        }),
      message: (data) =>
        this.run(() => {
          this.log.record({
            side: 'host',
            label: live.label,
            socket: live.serial,
            direction: 'received',
            kind: typeof data === 'string' ? 'text' : 'binary',
            data: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data),
          });
          handlers.message(data);
        }),
      close: (code, reason) =>
        this.run(() => {
          live.open = false;
          handlers.close(code, reason);
        }),
      error: (error) => this.run(() => handlers.error(error)),
    };
    // A reconnect the daemon starts while "asleep" only reaches the network on resume().
    this.run(() => {
      live.inner = this.inner(url, headers, wrapped);
    });
    return {
      get bufferedAmount() {
        return live.inner?.bufferedAmount ?? 0;
      },
      send: (data) =>
        this.run(() => {
          if (!live.inner || !live.open) return;
          this.log.record({
            side: 'host',
            label: live.label,
            socket: live.serial,
            direction: 'sent',
            kind: typeof data === 'string' ? 'text' : 'binary',
            data: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data),
          });
          live.inner.send(data);
        }),
      close: (code, reason) =>
        this.run(() => {
          live.open = false;
          live.inner?.close(code, reason);
        }),
      terminate: () =>
        this.run(() => {
          live.open = false;
          live.inner?.terminate();
        }),
    };
  };

  /** The laptop goes to sleep: from now on nothing crosses between the daemon and the relay. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = Date.now();
    this.heldActions = 0;
  }

  /** The laptop wakes up: held input and output are replayed in their original order. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pausedAt = null;
    this.draining = true;
    try {
      // Actions queued while draining (the daemon reacting to replayed input) go to the back of the same queue.
      for (let action = this.queue.shift(); action; action = this.queue.shift()) {
        try {
          action();
        } catch (error) {
          // A handler throwing must not strand the rest of the queue; the daemon logs its own errors.
          console.error('[e2e host-link] held action failed:', error instanceof Error ? error.message : error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Test-only: puts `data` on the currently open host socket of `label`, bypassing the daemon (positive controls that
   * need raw bytes on the relay path). Returns false when no such socket is open.
   */
  sendRaw(label: 'ws' | 'xfer', data: Uint8Array | string): boolean {
    const live = [...this.sockets].reverse().find((s) => s.label === label && s.open && s.inner);
    if (!live?.inner) return false;
    this.log.record({
      side: 'host',
      label: live.label,
      socket: live.serial,
      direction: 'sent',
      kind: typeof data === 'string' ? 'text' : 'binary',
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data),
    });
    live.inner.send(data);
    return true;
  }

  /** Number of host sockets the daemon opened so far (reconnects included). */
  get socketsOpened(): number {
    return this.sockets.length;
  }

  private run(action: () => void): void {
    if (this.paused || this.draining) {
      if (this.paused) this.heldActions++;
      this.queue.push(action);
      return;
    }
    action();
  }
}
