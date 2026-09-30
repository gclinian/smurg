// TEST ONLY. An in-memory stand-in for the relay (ARCHITECTURE §6) with the behaviour the client SDK depends on:
// hello{conn, host}, host.online / host.offline, "ping" → "pong", bye before a relay-initiated close, binary tunnel
// between each client socket and the host. It can also misbehave on purpose: refuse sockets, stop answering pings,
// black-hole a path, kick, delay the close after a bye (Node sees the FIN 10-16 s late), substitute the host.
// Not reachable from any entry point.
import { toBase64Url, fromBase64Url, utf8Decode, utf8Encode } from '../../bytes.ts';
import { RELAY_CLOSE_CODES } from '../../relay/close-codes.ts';
import { encodeRelayControl, RELAY_PING, RELAY_PONG, type RelayHostOfflineReason } from '../../relay/frames.ts';
import { matchTunnelPath, type RelayTunnelKind } from '../../relay/routes.ts';
import { RelayApiError } from '../errors.ts';
import type { ConnectionRelay } from '../relay-api.ts';
import {
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
  type ClientWebSocket,
  type ClientWebSocketCloseEvent,
  type ClientWebSocketMessageEvent,
} from '../websocket.ts';

export const FAKE_RELAY_ORIGIN = 'https://relay.test';

/** What the relay hands the host for each client socket (the relay's peer.open). */
export interface FakeConnInfo {
  readonly conn: number;
  readonly kind: RelayTunnelKind;
  /** The login the relay asserts (not proof of anything). */
  readonly userId: string;
  /** host → client binary frame */
  send(frame: Uint8Array): void;
  /** host → relay peer.kick: the relay sends bye 4003 and closes the client. */
  kick(reason: string): void;
}

export interface FakeConnEndpoint {
  /** client → host binary frame */
  receive(frame: Uint8Array): void;
  /** peer.close (the client socket went away, or the host detached). */
  close(): void;
}

export interface FakeHost {
  openConn(info: FakeConnInfo): FakeConnEndpoint;
}

type Listener = (event: never) => void;

export class FakeWebSocket implements ClientWebSocket {
  binaryType = 'blob';
  readyState: number = WS_CONNECTING;
  bufferedAmount = 0;
  readonly url: string;
  readonly userId: string;
  kind: RelayTunnelKind = 'ws';
  conn = 0;
  /** Everything the client sent as text (pings). */
  readonly sentText: string[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  private readonly relay: FakeRelay;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string, userId: string, relay: FakeRelay) {
    this.url = url;
    this.userId = userId;
    this.relay = relay;
  }

  send(data: string | Uint8Array): void {
    if (this.readyState === WS_CONNECTING) throw new Error('InvalidStateError: still connecting');
    if (this.readyState !== WS_OPEN) return;
    if (typeof data === 'string') this.sentText.push(data);
    this.relay.fromClient(this, data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    if (this.readyState === WS_CLOSING || this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSING;
    this.relay.clientClosed(this);
    queueMicrotask(() => this.fireClose(code ?? 1005, reason ?? ''));
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  // ---- driven by the relay

  fireOpen(): void {
    if (this.readyState !== WS_CONNECTING) return;
    this.readyState = WS_OPEN;
    this.emit('open', {});
  }

  fireMessage(data: string | ArrayBuffer): void {
    if (this.readyState !== WS_OPEN) return;
    this.emit('message', { data } satisfies ClientWebSocketMessageEvent);
  }

  fireError(): void {
    this.emit('error', {});
  }

  fireClose(code: number, reason: string): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.relay.clientClosed(this);
    this.emit('close', { code, reason } satisfies ClientWebSocketCloseEvent);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) (listener as (event: unknown) => void)(event);
  }
}

export interface TunnelFrame {
  readonly kind: RelayTunnelKind;
  readonly conn: number;
  readonly direction: 'client->daemon' | 'daemon->client';
  readonly frame: Uint8Array;
}

export class FakeRelay {
  readonly origin = new URL(FAKE_RELAY_ORIGIN);
  /** Every socket ever created, in order. */
  readonly sockets: FakeWebSocket[] = [];
  /** Every tunnelled binary frame, as the relay saw it (the R3 "byte tap"). */
  readonly frames: TunnelFrame[] = [];
  /** New sockets fail to open (network down, or an HTTP 401 the browser hides). */
  refuseConnections = false;
  answerPings = true;
  /** A silently dead path: nothing crosses in either direction and nothing closes. */
  blackhole = false;
  private nextConn = 1;
  private readonly hosts = new Map<RelayTunnelKind, FakeHost>();
  private readonly endpoints = new Map<FakeWebSocket, FakeConnEndpoint>();

  /** A WebSocket factory for sockets authenticated as `userId`. */
  connect(url: string, userId: string, options: { refuse?: boolean } = {}): FakeWebSocket {
    const ws = new FakeWebSocket(url, userId, this);
    this.sockets.push(ws);
    const route = matchTunnelPath(new URL(url).pathname);
    queueMicrotask(() => {
      if (ws.readyState !== WS_CONNECTING) return;
      if (options.refuse || this.refuseConnections || !route || route.role !== 'client') {
        ws.fireError();
        ws.fireClose(1006, '');
        return;
      }
      ws.kind = route.kind;
      ws.conn = this.nextConn++;
      ws.fireOpen();
      const host = this.hosts.get(route.kind);
      this.sendText(ws, encodeRelayControl({ t: 'hello', conn: ws.conn, host: host !== undefined }));
      if (host) this.attachEndpoint(ws, host);
    });
    return ws;
  }

  apiFor(userId: string): FakeRelayApi {
    return new FakeRelayApi(this, userId);
  }

  // ---- client side

  fromClient(ws: FakeWebSocket, data: string | Uint8Array): void {
    if (this.blackhole) return;
    if (typeof data === 'string') {
      if (data === RELAY_PING && this.answerPings) this.sendText(ws, RELAY_PONG);
      return;
    }
    const frame = data.slice();
    this.frames.push({ kind: ws.kind, conn: ws.conn, direction: 'client->daemon', frame });
    this.endpoints.get(ws)?.receive(frame);
  }

  clientClosed(ws: FakeWebSocket): void {
    const endpoint = this.endpoints.get(ws);
    this.endpoints.delete(ws);
    endpoint?.close();
  }

  // ---- host side

  get hostKinds(): RelayTunnelKind[] {
    return [...this.hosts.keys()];
  }

  /** The host connects (or a new host replaces the old one): host.online to every client, peer.open replayed. */
  attachHost(kind: RelayTunnelKind, host: FakeHost): void {
    this.detachHost(kind, 'closed', { silent: true });
    this.hosts.set(kind, host);
    for (const ws of this.openClients(kind)) {
      this.attachEndpoint(ws, host);
      this.sendText(ws, encodeRelayControl({ t: 'host.online' }));
    }
  }

  /** The host socket closed or timed out: host.offline to every client, every host-side connection closes. */
  detachHost(kind: RelayTunnelKind, reason: RelayHostOfflineReason = 'closed', options: { silent?: boolean } = {}): void {
    if (!this.hosts.delete(kind)) return;
    for (const ws of this.openClients(kind)) {
      const endpoint = this.endpoints.get(ws);
      this.endpoints.delete(ws);
      endpoint?.close();
      if (!options.silent) this.sendText(ws, encodeRelayControl({ t: 'host.offline', reason }));
    }
  }

  /** Relay-initiated close: `bye` first, the close event after `closeDelayMs` (0 = right away). */
  bye(ws: FakeWebSocket, code: 4000 | 4001 | 4003 | 1009, reason = '', closeDelayMs = 0): void {
    if (ws.readyState !== WS_OPEN) return;
    this.sendText(ws, encodeRelayControl({ t: 'bye', code, reason }));
    const endpoint = this.endpoints.get(ws);
    this.endpoints.delete(ws);
    endpoint?.close();
    const close = (): void => ws.fireClose(code, reason);
    if (closeDelayMs > 0) setTimeout(close, closeDelayMs);
    else queueMicrotask(close);
  }

  kick(ws: FakeWebSocket, reason = 'kicked', closeDelayMs = 0): void {
    this.bye(ws, RELAY_CLOSE_CODES.kicked, reason, closeDelayMs);
  }

  /** The socket dies without a bye (network loss the TCP stack noticed). */
  drop(ws: FakeWebSocket, code = 1006): void {
    if (ws.readyState === WS_CLOSED) return;
    ws.fireClose(code, '');
  }

  sendText(ws: FakeWebSocket, text: string): void {
    if (this.blackhole) return;
    queueMicrotask(() => ws.fireMessage(text));
  }

  openClients(kind?: RelayTunnelKind): FakeWebSocket[] {
    return this.sockets.filter((ws) => ws.readyState === WS_OPEN && ws.conn > 0 && (kind === undefined || ws.kind === kind));
  }

  lastSocket(): FakeWebSocket {
    const ws = this.sockets.at(-1);
    if (!ws) throw new Error('no socket yet');
    return ws;
  }

  /** Tunnelled frames of one socket in one direction. */
  framesOf(ws: FakeWebSocket, direction: TunnelFrame['direction']): Uint8Array[] {
    return this.frames.filter((f) => f.conn === ws.conn && f.kind === ws.kind && f.direction === direction).map((f) => f.frame);
  }

  private attachEndpoint(ws: FakeWebSocket, host: FakeHost): void {
    const endpoint = host.openConn({
      conn: ws.conn,
      kind: ws.kind,
      userId: ws.userId,
      send: (frame) => this.toClient(ws, frame),
      kick: (reason) => this.kick(ws, reason),
    });
    this.endpoints.set(ws, endpoint);
  }

  private toClient(ws: FakeWebSocket, frame: Uint8Array): void {
    if (this.blackhole || ws.readyState !== WS_OPEN || !this.endpoints.has(ws)) return;
    const copy = frame.slice();
    this.frames.push({ kind: ws.kind, conn: ws.conn, direction: 'daemon->client', frame: copy });
    const buffer = copy.slice().buffer;
    queueMicrotask(() => ws.fireMessage(buffer));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The relay's HTTP API, faked
// ---------------------------------------------------------------------------------------------------------------

export interface FakeIdentityClaims {
  readonly sub: string;
  readonly aud: string;
  readonly cnf: string;
}

/** A compact-JWS-shaped token (the daemon's fake verifies claims, not signatures). */
export function fakeIdentityToken(claims: FakeIdentityClaims): string {
  return `fake.${toBase64Url(utf8Encode(JSON.stringify(claims)))}.sig`;
}

export function parseFakeIdentityToken(token: string): FakeIdentityClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'fake') return null;
  try {
    const claims = JSON.parse(utf8Decode(fromBase64Url(parts[1] as string))) as Partial<FakeIdentityClaims>;
    if (typeof claims.sub !== 'string' || typeof claims.aud !== 'string' || typeof claims.cnf !== 'string') return null;
    return { sub: claims.sub, aud: claims.aud, cnf: claims.cnf };
  } catch {
    return null;
  }
}

export class FakeRelayApi implements ConnectionRelay {
  readonly origin: URL;
  readonly userId: string;
  loggedIn = true;
  /** When set, identityToken() rejects with it. */
  identityTokenError: Error | null = null;
  readonly identityTokenCalls: { workspaceId: string; cnf: string }[] = [];
  meCalls = 0;
  private readonly relay: FakeRelay;

  constructor(relay: FakeRelay, userId: string) {
    this.relay = relay;
    this.origin = relay.origin;
    this.userId = userId;
  }

  me(): Promise<unknown> {
    this.meCalls++;
    if (!this.loggedIn) return Promise.reject(new RelayApiError(401, 'unauthorized', 'login required'));
    return Promise.resolve({ userId: this.userId, displayName: this.userId, provider: 'dev' });
  }

  identityToken(workspaceId: string, cnf: string): Promise<{ token: string }> {
    this.identityTokenCalls.push({ workspaceId, cnf });
    if (this.identityTokenError) return Promise.reject(this.identityTokenError);
    if (!this.loggedIn) return Promise.reject(new RelayApiError(401, 'unauthorized', 'login required'));
    return Promise.resolve({ token: fakeIdentityToken({ sub: this.userId, aud: workspaceId, cnf }) });
  }

  createWebSocket(url: string): ClientWebSocket {
    // A logged-out socket is refused at the upgrade, which the client only sees as a failed open.
    return this.relay.connect(url, this.userId, { refuse: !this.loggedIn });
  }
}
