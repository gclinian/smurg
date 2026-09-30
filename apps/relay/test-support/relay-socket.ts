// A small `ws`-based relay socket for tests: an awaitable message queue, the "ping" heartbeat, and `bye` handling
// (Node clients must treat `bye` as closed-now: workerd's TCP FIN arrives 10-16 s later, relay.md V11).
import { RELAY_PING, RELAY_PING_INTERVAL_MS, RELAY_PONG } from '@smurg/protocol/relay';
import WebSocket from 'ws';

export type RelaySocketFrame =
  | { kind: 'text'; text: string; json: Record<string, unknown> | undefined; at: number }
  | { kind: 'binary'; data: Buffer; at: number };

export type RelaySocketClosed = { code: number; reason: string; via: 'bye' | 'close' | 'error'; at: number };

export type RelaySocketOptions = {
  /** Session token sent as `Authorization: Bearer` (CLI / daemon style). */
  token?: string;
  /** Raw `Cookie` header (browser style). */
  cookie?: string;
  origin?: string;
  headers?: Record<string, string>;
  /** Send "ping" every n ms while open (default RELAY_PING_INTERVAL_MS); false = never (see stopHeartbeat). */
  heartbeatMs?: number | false;
};

/** The upgrade was answered with an HTTP status instead of 101. */
export class RelayUpgradeError extends Error {
  override readonly name = 'RelayUpgradeError';
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`relay refused the WebSocket upgrade: HTTP ${status} ${body}`);
    this.status = status;
    this.body = body;
  }
}

type Waiter = { predicate: (frame: RelaySocketFrame) => boolean; resolve: (frame: RelaySocketFrame) => void };

export class RelaySocket {
  readonly ws: WebSocket;
  /** Resolves on 101, rejects with RelayUpgradeError (or a network error). */
  readonly opened: Promise<void>;
  /** Resolves on `bye` (then the socket is terminated), on the close event, or on an error. */
  readonly closed: Promise<RelaySocketClosed>;
  /** Every frame received except "pong", in order (including the `bye`). */
  readonly history: RelaySocketFrame[] = [];
  lastPongAt: number | undefined;

  private readonly queue: RelaySocketFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private resolveClosed!: (value: RelaySocketClosed) => void;

  constructor(url: string, options: RelaySocketOptions = {}) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    if (options.cookie !== undefined) headers['cookie'] = options.cookie;
    if (options.origin !== undefined) headers['origin'] = options.origin;
    this.ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => reject(new RelayUpgradeError(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'))));
        res.on('error', () => reject(new RelayUpgradeError(res.statusCode ?? 0, '')));
      });
      this.ws.once('error', (error) => reject(error));
    });
    // Handled here so a refused upgrade never becomes an unhandled rejection when a test only awaits `closed`.
    this.opened.catch(() => undefined);

    this.ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    this.ws.on('close', (code: number, reason: Buffer) => this.finish({ code, reason: reason.toString('utf8'), via: 'close', at: Date.now() }));
    this.ws.on('error', () => this.finish({ code: 1006, reason: 'error', via: 'error', at: Date.now() }));

    const heartbeatMs = options.heartbeatMs ?? RELAY_PING_INTERVAL_MS;
    if (heartbeatMs !== false) this.ws.once('open', () => this.startHeartbeat(heartbeatMs));
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    const at = Date.now();
    if (!isBinary) {
      const text = data.toString('utf8');
      if (text === RELAY_PONG) {
        this.lastPongAt = at;
        return;
      }
      const frame: RelaySocketFrame = { kind: 'text', text, json: parseJson(text), at };
      this.deliver(frame);
      if (frame.json?.['t'] === 'bye') {
        this.finish({ code: Number(frame.json['code']), reason: String(frame.json['reason'] ?? ''), via: 'bye', at });
        this.ws.terminate();
      }
      return;
    }
    this.deliver({ kind: 'binary', data: Buffer.from(data), at });
  }

  private deliver(frame: RelaySocketFrame): void {
    this.history.push(frame);
    const index = this.waiters.findIndex((w) => w.predicate(frame));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter?.resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }

  private finish(closed: RelaySocketClosed): void {
    this.stopHeartbeat();
    this.resolveClosed(closed);
  }

  /** Next queued (or future) frame matching `predicate`; frames that do not match stay queued. */
  next(predicate: (frame: RelaySocketFrame) => boolean = () => true, timeoutMs = 5_000): Promise<RelaySocketFrame> {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0] as RelaySocketFrame);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`relay socket: no matching frame within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Next control frame with `t === type`. */
  async nextControl(type: string, timeoutMs = 5_000): Promise<Record<string, unknown> & { at: number }> {
    const frame = await this.next((f) => f.kind === 'text' && f.json?.['t'] === type, timeoutMs);
    if (frame.kind !== 'text' || !frame.json) throw new Error('unreachable');
    return { ...frame.json, at: frame.at };
  }

  async nextBinary(timeoutMs = 5_000): Promise<Buffer> {
    const frame = await this.next((f) => f.kind === 'binary', timeoutMs);
    if (frame.kind !== 'binary') throw new Error('unreachable');
    return frame.data;
  }

  /** Frames received but not consumed by next()/nextControl()/nextBinary() yet. */
  pending(): readonly RelaySocketFrame[] {
    return [...this.queue];
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  startHeartbeat(intervalMs: number = RELAY_PING_INTERVAL_MS): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(RELAY_PING);
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  close(code?: number, reason?: string): void {
    this.stopHeartbeat();
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.stopHeartbeat();
    this.ws.terminate();
  }
}

export function connectRelaySocket(url: string, options?: RelaySocketOptions): RelaySocket {
  return new RelaySocket(url, options);
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
