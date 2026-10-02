// The interactive connection of a web or CLI client to one workspace (purpose 'interactive'): typed requests,
// events and one-way messages over the E2E channel, with resume across reconnects (ARCHITECTURE §4, §5).
//
//   const conn = new Connection({ relay, workspaceId, deviceKeys, pins, invite, clientKind: 'web', deviceName });
//   conn.subscribe((state) => render(state));            // 'online', 'host-offline', 'key-mismatch', …
//   conn.onWelcome((welcome, { resumed }) => { if (!resumed) resyncEverything(); });
//   conn.on('file.changed', (payload) => …);
//   conn.start();
//   const { entries } = await conn.request('file.tree', { root: MAIN_ROOT, path: '' });
import type { PayloadInputOf, ResultOf } from '../schema/registry.ts';
import type { Welcome } from '../schema/handshake.ts';
import { ChannelEngine, type CommonConnectionOptions } from './engine.ts';
import type {
  EventHandler,
  InteractiveEventType,
  InteractiveNotifyType,
  InteractiveRequestType,
  NotifyOptions,
  RequestOptions,
} from './message-types.ts';
import type { ConnectionState } from './state.ts';
import type { ResumeStore } from './storage.ts';
import { waitForState, type WaitOptions } from './wait.ts';

export interface ConnectionOptions extends CommonConnectionOptions {
  /** Where the resume position lives between Connection instances. Default: this instance only (memory). */
  resumeStore?: ResumeStore;
  /** Budget for unacknowledged outgoing messages; above it requests fail with 'overflow'. Default 32 MiB. */
  maxOutboxBytes?: number;
  /** "The host is offline" after this long without any message from the daemon. Default CLIENT_OFFLINE_THRESHOLD_MS (8 s). */
  silenceThresholdMs?: number;
  /** Start over on a fresh socket after this long of daemon silence. Default 20 s. */
  silenceReconnectMs?: number;
}

export class Connection {
  private readonly engine: ChannelEngine;

  constructor(options: ConnectionOptions) {
    this.engine = new ChannelEngine({ ...options, purpose: 'interactive' });
  }

  /** Starts connecting (register listeners first). Returns this. */
  start(): this {
    this.engine.start();
    return this;
  }

  /** Closes for good: pending requests reject with ClientRequestError('closed'). */
  close(): void {
    this.engine.close();
  }

  /** Bound, like subscribe. */
  getState = (): ConnectionState => this.engine.getState();

  /** State changes, synchronously (React: useSyncExternalStore(conn.subscribe, conn.getState)). */
  subscribe = (listener: (state: ConnectionState) => void): (() => void) => this.engine.subscribe(listener);

  /** The Welcome of the current (or last) admission: member, role, workspace, settings. */
  get welcome(): Welcome | null {
    return this.engine.welcome;
  }

  /**
   * Every admission. `resumed = false` (always on the first one) means: drop and reload everything (tree, open docs,
   * attached sessions); nothing that happened while disconnected will be replayed.
   */
  onWelcome(listener: (welcome: Welcome, info: { readonly resumed: boolean }) => void): () => void {
    return this.engine.onWelcome(listener);
  }

  /**
   * Sends request `type` and resolves with its typed `.ok` payload. Rejects with the daemon's SmurgError, or with a
   * ClientRequestError (timeout, cancelled, connection-lost, closed, overflow). While disconnected the request waits in
   * the outbox and goes out when the channel is back (its timeout keeps running).
   */
  request<T extends InteractiveRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>> {
    return this.engine.request(type, payload, options) as Promise<ResultOf<T>>;
  }

  /** Sends a one-way message (doc.sync, exec.input, presence.update, …). False if it was dropped. */
  notify<T extends InteractiveNotifyType>(type: T, payload: PayloadInputOf<T>, options?: NotifyOptions): boolean {
    return this.engine.notify(type, payload, options);
  }

  /** Subscribes to a daemon event. `error` receives errors that answer no pending request. */
  on<T extends InteractiveEventType>(type: T, handler: EventHandler<T>): () => void {
    return this.engine.on(type, handler as (payload: unknown, meta: { id: string; seq: number }) => void);
  }

  /** Resolves when online (with the Welcome); rejects with ConnectionEndedError on a terminal state. */
  async whenOnline(options?: WaitOptions): Promise<Welcome> {
    const state = await waitForState(this, (s) => s.kind === 'online', options);
    return (state as Extract<ConnectionState, { kind: 'online' }>).welcome;
  }

  /** Leave: the daemon ends this member's sessions and deletes their guest directory, then the connection closes. */
  async leave(options?: RequestOptions): Promise<void> {
    try {
      await this.request('channel.leave', {}, options);
    } finally {
      this.close();
    }
  }
}
