// A hand-driven stand-in for the SDK Connection (the WorkspaceConnection interface): tests push states and daemon
// events IN and inspect the requests and one-way messages the app sends OUT.
//
//   const conn = new FakeConnection();
//   conn.handle('file.tree', () => ({ entries: [], truncated: false }));   // auto-answer a request type
//   const { stores } = createWorkspaceStores(conn); conn.start();
//   conn.admit(makeWelcome({ role: 'editor' }));                          // online, resumed: false → stores load
//   conn.emit('session.state', { session: makeSession() });               // a daemon event
//   expect(conn.requestsOf('session.list')).toHaveLength(1);
//   conn.respond('session.list', { sessions: [] });                       // answer the oldest pending one
//
// Payloads are validated against the protocol registry both ways (a request the real encoder would refuse rejects
// here too; an emitted event must be a valid daemon payload), so fixtures stay honest.
import {
  SmurgError,
  getMessageSpec,
  type PayloadInputOf,
  type PayloadOf,
  type ResultInputOf,
  type ResultOf,
  type Welcome,
} from '@smurg/protocol';
import {
  ClientRequestError,
  isTerminalState,
  waitForState,
  type ConnectionState,
  type EventHandler,
  type EventMeta,
  type InteractiveEventType,
  type InteractiveNotifyType,
  type InteractiveRequestType,
  type NotifyOptions,
  type RequestOptions,
} from '@smurg/protocol/client';
import type { WorkspaceConnection } from '../lib/connection/types.ts';

export interface FakeRequest<T extends InteractiveRequestType = InteractiveRequestType> {
  readonly id: string;
  readonly type: T;
  readonly payload: PayloadOf<T>;
  readonly options: RequestOptions | undefined;
  /** 'pending' until answered (respond / fail / an auto-responder) or failed by close(). */
  status: 'pending' | 'resolved' | 'rejected';
  resolve(result: ResultInputOf<T>): void;
  reject(error: unknown): void;
}

export interface FakeNotification<T extends InteractiveNotifyType = InteractiveNotifyType> {
  readonly type: T;
  readonly payload: PayloadOf<T>;
  readonly options: NotifyOptions | undefined;
}

type Responder<T extends InteractiveRequestType> = (payload: PayloadOf<T>) => ResultInputOf<T> | Promise<ResultInputOf<T>>;
type AnyListener = (payload: unknown, meta: EventMeta) => void;

export class FakeConnection implements WorkspaceConnection {
  readonly requests: FakeRequest[] = [];
  readonly notifications: FakeNotification[] = [];
  started = false;
  private state: ConnectionState = { kind: 'idle' };
  private currentWelcome: Welcome | null = null;
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly welcomeListeners = new Set<(welcome: Welcome, info: { readonly resumed: boolean }) => void>();
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly responders = new Map<string, Responder<InteractiveRequestType>>();
  private nextId = 1;
  private seq = 1;

  // -------------------------------------------------------------------------------------------------------------
  // The WorkspaceConnection surface
  // -------------------------------------------------------------------------------------------------------------

  start(): this {
    this.started = true;
    if (this.state.kind === 'idle') this.setState({ kind: 'connecting', attempt: 1, retryAt: null, cause: null });
    return this;
  }

  close(): void {
    if (isTerminalState(this.state)) return;
    this.setState({ kind: 'closed', reason: 'local' });
  }

  getState = (): ConnectionState => this.state;

  subscribe = (listener: (state: ConnectionState) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  get welcome(): Welcome | null {
    return this.currentWelcome;
  }

  onWelcome(listener: (welcome: Welcome, info: { readonly resumed: boolean }) => void): () => void {
    this.welcomeListeners.add(listener);
    return () => {
      this.welcomeListeners.delete(listener);
    };
  }

  request<T extends InteractiveRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>> {
    if (isTerminalState(this.state)) return Promise.reject(new ClientRequestError('closed'));
    const spec = getMessageSpec(type);
    if (!spec || spec.result === null) return Promise.reject(new SmurgError('bad_request', `${type} is not a request type`, { reason: 'unknown-type' }));
    const parsed = spec.payload.safeParse(payload);
    if (!parsed.success) {
      return Promise.reject(new SmurgError('bad_request', `invalid ${type} payload: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`));
    }
    const resultSchema = spec.result;
    return new Promise<ResultOf<T>>((resolve, reject) => {
      const request: FakeRequest<T> = {
        id: `req-${this.nextId++}`,
        type,
        payload: parsed.data as PayloadOf<T>,
        options,
        status: 'pending',
        resolve: (result) => {
          if (request.status !== 'pending') return;
          const checked = resultSchema.safeParse(result);
          if (!checked.success) {
            request.status = 'rejected';
            reject(new Error(`FakeConnection: invalid ${type}.ok result: ${checked.error.message}`));
            return;
          }
          request.status = 'resolved';
          resolve(checked.data as ResultOf<T>);
        },
        reject: (error) => {
          if (request.status !== 'pending') return;
          request.status = 'rejected';
          reject(error);
        },
      };
      this.requests.push(request as unknown as FakeRequest);
      options?.signal?.addEventListener('abort', () => request.reject(new ClientRequestError('cancelled')), { once: true });
      const responder = this.responders.get(type) as Responder<T> | undefined;
      if (responder) {
        Promise.resolve()
          .then(() => responder(request.payload))
          .then((result) => request.resolve(result), (error: unknown) => request.reject(error));
      }
    });
  }

  notify<T extends InteractiveNotifyType>(type: T, payload: PayloadInputOf<T>, options?: NotifyOptions): boolean {
    if (isTerminalState(this.state)) throw new ClientRequestError('closed');
    const spec = getMessageSpec(type);
    if (!spec || spec.result !== null || spec.dir === 'd2c') throw new SmurgError('bad_request', `${type} is not a one-way client message`);
    const parsed = spec.payload.safeParse(payload);
    if (!parsed.success) throw new SmurgError('bad_request', `invalid ${type} payload: ${parsed.error.message}`);
    const online = this.state.kind === 'online';
    if (!online && options?.whenDisconnected === 'drop') return false;
    this.notifications.push({ type, payload: parsed.data as PayloadOf<T>, options } as unknown as FakeNotification);
    return true;
  }

  on<T extends InteractiveEventType>(type: T, handler: EventHandler<T>): () => void {
    const spec = getMessageSpec(type);
    if (!spec || spec.dir === 'c2d' || (type as string) === 'channel.ack') throw new TypeError(`${type} is not an event`);
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const listener = handler as unknown as AnyListener;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  async whenOnline(): Promise<Welcome> {
    const state = await waitForState(this, (s) => s.kind === 'online');
    return (state as Extract<ConnectionState, { kind: 'online' }>).welcome;
  }

  async leave(options?: RequestOptions): Promise<void> {
    try {
      await this.request('channel.leave', {}, options);
    } finally {
      this.close();
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Driving it from a test
  // -------------------------------------------------------------------------------------------------------------

  /** Sets any state (listeners run synchronously, like the SDK). */
  setState(state: ConnectionState): void {
    this.state = state;
    if (isTerminalState(state)) {
      for (const request of this.requests) request.reject(new ClientRequestError('closed'));
    }
    for (const listener of [...this.stateListeners]) listener(state);
  }

  /**
   * Admission: state `online` then the Welcome listeners, in the SDK's order. `resumed: false` (default, and always
   * on the first admission) makes the stores reload; requests still pending from before fail with connection-lost.
   */
  admit(welcome: Welcome, options: { resumed?: boolean } = {}): void {
    const resumed = options.resumed === true;
    if (!resumed) for (const request of this.requests) request.reject(new ClientRequestError('connection-lost'));
    this.currentWelcome = welcome;
    this.setState({ kind: 'online', welcome, resumed });
    for (const listener of [...this.welcomeListeners]) listener(welcome, { resumed });
  }

  /** Delivers a daemon event (validated like the SDK's decoder would). */
  emit<T extends InteractiveEventType>(type: T, payload: PayloadInputOf<T>): void {
    const spec = getMessageSpec(type);
    if (!spec || spec.dir === 'c2d') throw new TypeError(`${type} is not a daemon event`);
    const parsed = spec.payload.parse(payload);
    const meta: EventMeta = { id: `evt-${this.nextId++}`, seq: this.seq++ };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(parsed, meta);
  }

  /** Auto-answers every request of `type` (now and later). */
  handle<T extends InteractiveRequestType>(type: T, responder: Responder<T>): this {
    this.responders.set(type, responder as unknown as Responder<InteractiveRequestType>);
    for (const request of this.pendingOf(type)) {
      Promise.resolve()
        .then(() => responder(request.payload))
        .then((result) => request.resolve(result), (error: unknown) => request.reject(error));
    }
    return this;
  }

  /** Answers the oldest pending request of `type`. */
  respond<T extends InteractiveRequestType>(type: T, result: ResultInputOf<T>): FakeRequest<T> {
    const request = this.pendingOf(type)[0];
    if (!request) throw new Error(`FakeConnection: no pending ${type} request`);
    request.resolve(result);
    return request;
  }

  /** Fails the oldest pending request of `type` (e.g. with new SmurgError('forbidden')). */
  fail<T extends InteractiveRequestType>(type: T, error: unknown): FakeRequest<T> {
    const request = this.pendingOf(type)[0];
    if (!request) throw new Error(`FakeConnection: no pending ${type} request`);
    request.reject(error);
    return request;
  }

  requestsOf<T extends InteractiveRequestType>(type: T): FakeRequest<T>[] {
    return this.requests.filter((request) => request.type === type) as unknown as FakeRequest<T>[];
  }

  pendingOf<T extends InteractiveRequestType>(type: T): FakeRequest<T>[] {
    return this.requestsOf(type).filter((request) => request.status === 'pending');
  }

  lastRequest<T extends InteractiveRequestType>(type: T): FakeRequest<T> | undefined {
    return this.requestsOf(type).at(-1);
  }

  notificationsOf<T extends InteractiveNotifyType>(type: T): FakeNotification<T>[] {
    return this.notifications.filter((n) => n.type === type) as unknown as FakeNotification<T>[];
  }

  /** Number of listeners for an event type (tests that check cleanup). */
  listenerCount(type: InteractiveEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  // ---- common states, by name

  hostOffline(reason: 'relay' | 'silence' | 'stopped' = 'relay', since = Date.now()): void {
    this.setState({ kind: 'host-offline', reason, since });
  }

  relayUnreachable(retryAt = Date.now() + 5_000, attempt = 2): void {
    this.setState({ kind: 'relay-unreachable', attempt, retryAt, cause: 'closed' });
  }

  retrying(cause: Extract<ConnectionState, { kind: 'connecting' }>['cause'] = 'timeout', retryAt = Date.now() + 3_000): void {
    this.setState({ kind: 'connecting', attempt: 2, retryAt, cause });
  }

  keyMismatch(detail: 'fingerprint' | 'unauthenticated' = 'fingerprint', mode: 'invite' | 'device' = 'invite'): void {
    this.setState({ kind: 'key-mismatch', mode, detail });
  }

  kicked(): void {
    this.setState({ kind: 'closed', reason: 'kicked', daemonReason: 'kicked' });
  }
}
