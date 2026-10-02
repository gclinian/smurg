// One host socket to the relay (`/ws/<ws>/host` for interactive traffic, `/xfer/<ws>/host` for transfers;
// ARCHITECTURE §4 "Liveness", §6; relay.md §1.2, §6.6, gotchas 2, 8, 9, 23):
//  - bearer auth (Node sends no Origin, so the relay skips its CSWSH check);
//  - literal text "ping" every 2 s (the DO answers "pong" without waking); a pong watchdog: 6 s without hearing
//    anything ⇒ terminate and reconnect, because a silently dead path (Wi-Fi switch, NAT rebinding) gives no FIN;
//  - `bye` is acted on at once (Node sees the FIN 10-16 s late); 4001 means another host socket replaced this one
//    (another `smurg host` for the same workspace): stop, do not fight over the workspace;
//  - reconnect with jittered backoff; every conn id of a dead socket is void (the relay replays peer.open for the
//    clients still there once we are back);
//  - binary frames are `<u32be conn><ciphertext>` both ways.
import {
  RELAY_CLOSE_CODES,
  RELAY_PING,
  encodeRelayControl,
  parseRelayToHostText,
  prefixFrame,
  splitFrame,
  truncateCloseReason,
  type RelayPeerOpenFrame,
} from '@smurg/protocol/relay';
import type { TimingConfig } from '../core/config.ts';
import { monotonicNow, type Clock } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import type { HostSocket, HostSocketFactory } from './host-socket.ts';
import { backoffDelay } from './rate-limit.ts';

/**
 * `auth-rejected`: the relay answered the upgrade with 401/403: the host's relay login expired or was revoked. Members
 * cannot connect until the host logs in again (`smurg login`) and the daemon gets the new token (setToken); the old
 * token is re-tried only every `timing.relayAuthRetryMs`.
 */
export type RelayLinkState = 'idle' | 'connecting' | 'online' | 'waiting' | 'auth-rejected' | 'replaced' | 'stopped';

export type RelayLinkDownReason = 'closed' | 'bye' | 'watchdog' | 'open-timeout' | 'error' | 'rejected' | 'stopped';

export interface RelayLinkStateDetail {
  /** Why the link left `online` or why an attempt failed. */
  readonly reason?: RelayLinkDownReason;
  /** The HTTP status of a refused upgrade. */
  readonly status?: number;
}

export interface RelayLinkHandlers {
  /** The socket is open: the relay will (re)announce every client with peer.open. */
  online(): void;
  /** The socket is gone: every connection id of this link is void. */
  offline(reason: RelayLinkDownReason): void;
  peerOpen(frame: RelayPeerOpenFrame): void;
  peerClose(conn: number): void;
  frame(conn: number, payload: Uint8Array): void;
  /** bye 4001: a newer host connection took the workspace; this link stopped for good. */
  replaced?(): void;
  /**
   * Every change of `state` (the host must see the relay link drop and recover, and an expired login
   * must look different from a network blip). `waiting` ↔ `connecting` flips of a retry loop are not reported.
   */
  stateChanged?(state: RelayLinkState, detail: RelayLinkStateDetail): void;
}

export interface RelayLinkOptions {
  readonly url: string;
  readonly token: string;
  readonly label: 'ws' | 'xfer';
  readonly socketFactory: HostSocketFactory;
  readonly handlers: RelayLinkHandlers;
  readonly timing: TimingConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly random?: () => number;
}

/** How often the watchdog looks at the clock. */
const WATCH_TICK_MS = 500;

export class RelayLink {
  private readonly options: RelayLinkOptions;
  private token: string;
  private socket: HostSocket | null = null;
  private epoch = 0;
  private stateValue: RelayLinkState = 'idle';
  private attempt = 0;
  private lastHeard = 0;
  private lastPing = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private openDeadline = 0;
  /** HTTP status of the latest refused upgrade with 401/403 (cleared when a socket opens). */
  private authRejectedStatus: number | null = null;
  /** The latest attempt failed (or the link dropped): a new attempt is a reconnect, reported as `waiting`. */
  private retrying = false;
  private offlineSince: number | null = null;
  private lastRejectedStatus: number | null = null;
  private reported: RelayLinkState = 'idle';

  constructor(options: RelayLinkOptions) {
    this.options = options;
    this.token = options.token;
  }

  get state(): RelayLinkState {
    if ((this.stateValue === 'connecting' || this.stateValue === 'waiting') && this.authRejectedStatus !== null) return 'auth-rejected';
    return this.stateValue;
  }

  /**
   * A new relay session token for the host sockets (the host logged in again). Used from the next upgrade on; when
   * the relay refused the old one, the link reconnects at once instead of waiting for its slow re-try.
   */
  setToken(token: string): void {
    if (token.length === 0) return;
    const changed = token !== this.token;
    this.token = token;
    if (!changed) return;
    this.lastRejectedStatus = null; // a refusal of the NEW token is news
    if (this.stateValue !== 'waiting') return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.attempt = 0;
    this.connect();
  }

  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  start(): void {
    if (this.stateValue !== 'idle') return;
    this.connect();
  }

  /** Graceful stop: close the socket, never reconnect. The relay tells clients host.offline. */
  stop(): void {
    if (this.stateValue === 'stopped') return;
    const wasOnline = this.socket !== null;
    this.stateValue = 'stopped';
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.epoch++;
    if (socket) {
      try {
        socket.close(1000, 'host stopped');
      } catch {
        socket.terminate();
      }
    }
    if (wasOnline) this.options.handlers.offline('stopped');
    this.report({ reason: 'stopped' });
  }

  /** `<u32be conn><payload>` to the relay; false when the socket is not open. */
  sendFrame(conn: number, payload: Uint8Array): boolean {
    if (this.stateValue !== 'online' || !this.socket) return false;
    this.socket.send(prefixFrame(conn, payload));
    return true;
  }

  /** host → relay peer.kick: the relay sends that client `bye 4003` and closes it. */
  kick(conn: number, reason: string): void {
    if (this.stateValue !== 'online' || !this.socket) return;
    try {
      this.socket.send(encodeRelayControl({ t: 'peer.kick', conn, reason: truncateCloseReason(reason) }));
    } catch (err) {
      this.options.log.warn('peer.kick could not be sent', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  private connect(): void {
    if (this.stateValue === 'stopped' || this.stateValue === 'replaced') return;
    this.stateValue = 'connecting';
    this.report({});
    const epoch = ++this.epoch;
    this.openDeadline = monotonicNow(this.options.clock) + this.options.timing.relayOpenTimeoutMs;
    const live = (): boolean => epoch === this.epoch;
    const token = this.token;
    let refusedStatus: number | null = null;
    let socket: HostSocket;
    try {
      socket = this.options.socketFactory(this.options.url, { authorization: `Bearer ${token}` }, {
        open: () => {
          if (live()) this.onOpen();
        },
        message: (data) => {
          if (live()) this.onMessage(data);
        },
        close: () => {
          if (!live()) return;
          if (refusedStatus !== null) this.refused(refusedStatus, token);
          else this.down('closed');
        },
        error: () => {
          // A close event follows every error; nothing else to do.
        },
        rejected: (status) => {
          if (live()) refusedStatus = status;
        },
      });
    } catch (err) {
      this.options.log.warn('relay socket could not be created', { link: this.options.label, error: err instanceof Error ? err.name : 'unknown' });
      this.retrying = true;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.clearTimers();
    // Fine enough that a ping goes out on time and the watchdog can never fire between two pongs.
    const { relayPingIntervalMs, pongWatchdogMs } = this.options.timing;
    const tickMs = Math.max(5, Math.min(WATCH_TICK_MS, relayPingIntervalMs / 2, pongWatchdogMs / 4));
    this.timer = setInterval(() => {
      if (live()) this.tick();
    }, tickMs);
    this.timer.unref?.();
  }

  private onOpen(): void {
    this.stateValue = 'online';
    this.attempt = 0;
    const now = monotonicNow(this.options.clock);
    this.lastHeard = now;
    this.sendPing(now);
    const offlineMs = this.offlineSince === null ? null : Math.max(0, now - this.offlineSince);
    if (this.authRejectedStatus !== null) this.options.log.warn('the relay accepts the host session token again', { link: this.options.label });
    this.authRejectedStatus = null;
    this.lastRejectedStatus = null;
    this.retrying = false;
    this.offlineSince = null;
    this.options.log.info('relay link online', { link: this.options.label, ...(offlineMs === null ? {} : { offlineMs }) });
    this.options.handlers.online();
    this.report({});
  }

  /** The relay answered the upgrade with an HTTP status (the socket never opened). */
  private refused(status: number, token: string): void {
    if (this.stateValue === 'stopped' || this.stateValue === 'replaced') return;
    this.teardownSocket();
    this.retrying = true;
    this.offlineSince ??= monotonicNow(this.options.clock);
    const repeated = status === this.lastRejectedStatus;
    this.lastRejectedStatus = status;
    if (status !== 401 && status !== 403) {
      // 404 (workspace not claimed), 429, 5xx…: nothing the host can fix from here; keep retrying with backoff.
      if (!repeated) this.options.log.warn('the relay refused the host socket; retrying', { link: this.options.label, status });
      this.scheduleReconnect({ reason: 'rejected', status });
      return;
    }
    if (token !== this.token) {
      // A new token arrived while this attempt was on its way: try the new one right away.
      this.attempt = 0;
      this.scheduleReconnect({ reason: 'rejected', status });
      return;
    }
    this.authRejectedStatus = status;
    if (!repeated) {
      this.options.log.error('the relay refused the host session token (expired or revoked login): members cannot connect until the host logs in again with `smurg login`', {
        link: this.options.label,
        status,
      });
    }
    this.stateValue = 'waiting';
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, this.options.timing.relayAuthRetryMs);
    this.retryTimer.unref?.();
    this.report({ reason: 'rejected', status });
  }

  /** Tells the handler about a change of the coarse state (a retry loop's connecting ↔ waiting is one state). */
  private report(detail: RelayLinkStateDetail): void {
    const current = this.state;
    const coarse: RelayLinkState = current === 'connecting' && this.retrying ? 'waiting' : current;
    if (coarse === this.reported) return;
    this.reported = coarse;
    try {
      this.options.handlers.stateChanged?.(coarse, detail);
    } catch (err) {
      this.options.log.error('relay link state listener failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private onMessage(data: string | Uint8Array): void {
    this.lastHeard = monotonicNow(this.options.clock);
    if (typeof data !== 'string') {
      const split = splitFrame(data);
      if (!split) return; // too short or conn 0: nothing can be routed
      this.options.handlers.frame(split.conn, split.payload);
      return;
    }
    const message = parseRelayToHostText(data);
    if (message.kind === 'ping' || message.kind === 'pong') return;
    if (message.kind === 'invalid') {
      this.options.log.warn('invalid relay control frame', { link: this.options.label, reason: message.reason });
      return;
    }
    const frame = message.frame;
    switch (frame.t) {
      case 'peer.open':
        this.options.handlers.peerOpen(frame);
        return;
      case 'peer.close':
        this.options.handlers.peerClose(frame.conn);
        return;
      case 'bye':
        this.options.log.info('relay said bye', { link: this.options.label, code: frame.code });
        if (frame.code === RELAY_CLOSE_CODES.hostReplaced) {
          this.teardownSocket();
          this.stateValue = 'replaced';
          this.options.handlers.offline('bye');
          this.options.handlers.replaced?.();
          this.report({ reason: 'bye' });
          return;
        }
        this.down('bye');
        return;
    }
  }

  private tick(): void {
    const now = monotonicNow(this.options.clock);
    if (this.stateValue === 'connecting') {
      if (now >= this.openDeadline) this.down('open-timeout');
      return;
    }
    if (this.stateValue !== 'online') return;
    if (now - this.lastHeard >= this.options.timing.pongWatchdogMs) {
      this.options.log.warn('relay pong watchdog fired', { link: this.options.label });
      this.down('watchdog');
      return;
    }
    if (now - this.lastPing >= this.options.timing.relayPingIntervalMs) this.sendPing(now);
  }

  private sendPing(now: number): void {
    this.lastPing = now;
    try {
      this.socket?.send(RELAY_PING);
    } catch {
      // The close event follows.
    }
  }

  private down(reason: RelayLinkDownReason): void {
    if (this.stateValue === 'stopped' || this.stateValue === 'replaced') return;
    const wasOnline = this.stateValue === 'online';
    this.teardownSocket();
    this.retrying = true;
    this.lastRejectedStatus = null;
    if (wasOnline) {
      // Members see "The host is offline" from now on: the host must not be the only one who does not know.
      this.offlineSince = monotonicNow(this.options.clock);
      this.options.log.warn('relay link down; reconnecting', { link: this.options.label, reason });
      this.options.handlers.offline(reason);
    } else {
      this.offlineSince ??= monotonicNow(this.options.clock);
    }
    this.scheduleReconnect({ reason });
  }

  private teardownSocket(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.epoch++;
    socket?.terminate();
  }

  private scheduleReconnect(detail: RelayLinkStateDetail = {}): void {
    if (this.stateValue === 'stopped' || this.stateValue === 'replaced') return;
    this.stateValue = 'waiting';
    // A non-auth failure after an auth refusal (network down meanwhile) is a plain reconnect again.
    if (detail.reason !== 'rejected') this.authRejectedStatus = null;
    this.report(detail);
    const delay = backoffDelay(this.attempt++, {
      baseMs: this.options.timing.reconnectBaseMs,
      maxMs: this.options.timing.reconnectMaxMs,
      jitter: this.options.timing.reconnectJitter,
    }, this.options.random);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.timer = undefined;
    this.retryTimer = undefined;
  }
}
