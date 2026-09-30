// TEST ONLY. An in-memory relay with the behaviour of ARCHITECTURE §6 that the daemon and the client SDK rely on:
// host sockets (bearer, peer.open / peer.close, <u32 conn> prefix, peer.kick → bye 4003 + close, "ping" → "pong",
// a newer host replaces the older one with bye 4001) and client sockets (hello{conn, host}, host.online /
// host.offline, the binary tunnel). Every tunnelled frame is recorded (the R3 "byte tap"). Delivery is asynchronous
// and ordered (microtasks), like a WebSocket.
import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { ClientWebSocket, ClientWebSocketCloseEvent, ClientWebSocketMessageEvent, ConnectionRelay } from '@smurg/protocol/client';
import {
  RELAY_CLOSE_CODES,
  RELAY_PING,
  RELAY_PONG,
  encodeRelayControl,
  matchTunnelPath,
  parseHostToRelayText,
  prefixFrame,
  splitFrame,
  type RelayTunnelKind,
} from '@smurg/protocol/relay';
import type { HostSocket, HostSocketFactory, HostSocketHandlers } from '../net/host-socket.ts';
import type { Clock } from '../core/lifecycle.ts';

export const MEMORY_RELAY_ORIGIN = 'https://relay.smurg.test';

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export interface TappedFrame {
  readonly kind: RelayTunnelKind;
  readonly conn: number;
  readonly direction: 'client->daemon' | 'daemon->client';
  readonly bytes: Uint8Array;
}

export interface RelayUser {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------------------------------------------

type Listener = (event: never) => void;

export class MemoryClientSocket implements ClientWebSocket {
  binaryType = 'blob';
  readyState: number = WS_CONNECTING;
  bufferedAmount = 0;
  kind: RelayTunnelKind = 'ws';
  conn = 0;
  readonly user: RelayUser;
  readonly url: string;
  private readonly relay: MemoryRelay;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string, user: RelayUser, relay: MemoryRelay) {
    this.url = url;
    this.user = user;
    this.relay = relay;
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.readyState === WS_CONNECTING) throw new Error('InvalidStateError: still connecting');
    if (this.readyState !== WS_OPEN) return;
    this.relay.fromClient(this, data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_CLOSING || this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSING;
    this.relay.clientGone(this);
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

  fireOpen(): void {
    if (this.readyState !== WS_CONNECTING) return;
    this.readyState = WS_OPEN;
    this.emit('open', {});
  }

  fireMessage(data: string | ArrayBuffer): void {
    if (this.readyState !== WS_OPEN) return;
    this.emit('message', { data } satisfies ClientWebSocketMessageEvent);
  }

  fireClose(code: number, reason: string): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.relay.clientGone(this);
    this.emit('close', { code, reason } satisfies ClientWebSocketCloseEvent);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) (listener as (event: unknown) => void)(event);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------------------------------------------

class MemoryHostSocket implements HostSocket {
  readonly kind: RelayTunnelKind;
  readonly handlers: HostSocketHandlers;
  open = false;
  closed = false;
  bufferedAmount = 0;
  private readonly relay: MemoryRelay;

  constructor(kind: RelayTunnelKind, handlers: HostSocketHandlers, relay: MemoryRelay) {
    this.kind = kind;
    this.handlers = handlers;
    this.relay = relay;
  }

  send(data: string | Uint8Array): void {
    if (!this.open || this.closed) return;
    this.relay.fromHost(this, data);
  }

  close(code = 1000, reason = ''): void {
    this.shutdown(code, reason);
  }

  terminate(): void {
    this.shutdown(1006, '');
  }

  /** relay → host */
  deliver(data: string | Uint8Array): void {
    if (!this.open || this.closed) return;
    const copy = typeof data === 'string' ? data : data.slice();
    queueMicrotask(() => {
      if (this.open && !this.closed) this.handlers.message(copy);
    });
  }

  shutdown(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.relay.hostGone(this);
    queueMicrotask(() => this.handlers.close(code, reason));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------------------------------------------

export class MemoryRelay {
  readonly origin = new URL(MEMORY_RELAY_ORIGIN);
  readonly workspaceId: string;
  /** Every tunnelled binary frame (without the relay's conn prefix), in order. */
  readonly frames: TappedFrame[] = [];
  /** Host tokens presented, for assertions (tests use dummy tokens only). */
  readonly hostTokens: string[] = [];
  answerPings = true;
  /** A silently dead host path: nothing crosses and nothing closes (pong watchdog tests). */
  blackholeHost = false;
  /** Host session tokens the relay accepts at the upgrade; a refused one gets HTTP 401 (expired login). */
  hostTokenValid: (token: string) => boolean = () => true;
  private readonly hosts = new Map<RelayTunnelKind, MemoryHostSocket>();
  private readonly clients = new Set<MemoryClientSocket>();
  private nextConn = 1;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  /** For createDaemon({ relay: { socketFactory } }). */
  hostSocketFactory(): HostSocketFactory {
    return (url, headers, handlers) => {
      const route = matchTunnelPath(new URL(url).pathname);
      const socket = new MemoryHostSocket(route?.kind ?? 'ws', handlers, this);
      const auth = headers['authorization'] ?? '';
      queueMicrotask(() => {
        if (socket.closed) return;
        if (!route || route.role !== 'host' || route.workspaceId !== this.workspaceId || !auth.startsWith('Bearer ') || auth.length <= 7) {
          socket.shutdown(1008, 'refused');
          return;
        }
        this.hostTokens.push(auth.slice(7));
        if (!this.hostTokenValid(auth.slice(7))) {
          // The real relay answers the upgrade with HTTP 401 (invalid_session) and the socket never opens.
          socket.handlers.rejected?.(401);
          socket.shutdown(1006, '');
          return;
        }
        this.attachHost(socket);
      });
      return socket;
    };
  }

  /** The relay HTTP API as a client of `user` sees it, with identity tokens signed by `issuer`. */
  apiFor(user: RelayUser, issuer: TestIdentityIssuer): ConnectionRelay & { loggedIn: boolean; readonly tokensIssued: number } {
    const relay = this;
    let tokensIssued = 0;
    const api = {
      origin: relay.origin,
      loggedIn: true,
      get tokensIssued() {
        return tokensIssued;
      },
      me: async () => {
        if (!api.loggedIn) throw Object.assign(new Error('unauthorized'), { status: 401 });
        return { userId: user.userId, displayName: user.displayName, provider: 'dev' };
      },
      identityToken: async (workspaceId: string, cnf: string) => {
        tokensIssued++;
        return { token: await issuer.issue({ sub: user.userId, name: user.displayName, workspaceId, cnf }), expiresIn: 300 };
      },
      createWebSocket: (url: string): ClientWebSocket => relay.connectClient(url, user),
    };
    return api;
  }

  connectClient(url: string, user: RelayUser): MemoryClientSocket {
    const socket = new MemoryClientSocket(url, user, this);
    const route = matchTunnelPath(new URL(url).pathname);
    queueMicrotask(() => {
      if (socket.readyState !== WS_CONNECTING) return;
      if (!route || route.role !== 'client' || route.workspaceId !== this.workspaceId) {
        socket.fireClose(1006, '');
        return;
      }
      socket.kind = route.kind;
      socket.conn = this.nextConn++;
      this.clients.add(socket);
      socket.fireOpen();
      const host = this.hosts.get(route.kind);
      this.toClientText(socket, encodeRelayControl({ t: 'hello', conn: socket.conn, host: host !== undefined }));
      if (host) this.announce(host, socket);
    });
    return socket;
  }

  // ---- controls for tests

  hostOnline(kind: RelayTunnelKind): boolean {
    return this.hosts.has(kind);
  }

  /** The host's network path dies loudly (TCP reset): clients get host.offline, the daemon gets a close. */
  dropHost(kind: RelayTunnelKind): void {
    this.hosts.get(kind)?.shutdown(1006, '');
  }

  /** Relay-initiated close of the host socket (bye first, e.g. 4000 heartbeat timeout). */
  byeHost(kind: RelayTunnelKind, code: 4000 | 4001 | 4003 | 1009, reason = ''): void {
    const host = this.hosts.get(kind);
    if (!host) return;
    host.deliver(encodeRelayControl({ t: 'bye', code, reason }));
    queueMicrotask(() => host.shutdown(code, reason));
  }

  /** A raw text frame to the host socket (malformed control frames, replays). */
  sendToHost(kind: RelayTunnelKind, text: string): void {
    this.hosts.get(kind)?.deliver(text);
  }

  /** Relay-initiated close of a client (bye first, like the real relay). */
  byeClient(socket: MemoryClientSocket, code: 4000 | 4001 | 4003 | 1009, reason = ''): void {
    if (socket.readyState !== WS_OPEN) return;
    this.toClientText(socket, encodeRelayControl({ t: 'bye', code, reason }));
    this.clientGone(socket);
    queueMicrotask(() => socket.fireClose(code, reason));
  }

  openClients(kind?: RelayTunnelKind): MemoryClientSocket[] {
    return [...this.clients].filter((s) => s.readyState === WS_OPEN && (kind === undefined || s.kind === kind));
  }

  clientsOf(userId: string, kind?: RelayTunnelKind): MemoryClientSocket[] {
    return this.openClients(kind).filter((s) => s.user.userId === userId);
  }

  // ---- plumbing

  fromClient(socket: MemoryClientSocket, data: string | Uint8Array): void {
    if (typeof data === 'string') {
      if (data === RELAY_PING && this.answerPings) this.toClientText(socket, RELAY_PONG);
      return;
    }
    const bytes = data.slice();
    this.frames.push({ kind: socket.kind, conn: socket.conn, direction: 'client->daemon', bytes });
    const host = this.hosts.get(socket.kind);
    if (!host) {
      this.toClientText(socket, encodeRelayControl({ t: 'host.offline', reason: 'closed' }));
      return;
    }
    if (this.blackholeHost) return;
    host.deliver(prefixFrame(socket.conn, bytes));
  }

  fromHost(host: MemoryHostSocket, data: string | Uint8Array): void {
    if (this.blackholeHost) return;
    if (typeof data === 'string') {
      if (data === RELAY_PING) {
        if (this.answerPings) host.deliver(RELAY_PONG);
        return;
      }
      const message = parseHostToRelayText(data);
      if (message.kind !== 'control') return;
      const target = [...this.clients].find((c) => c.kind === host.kind && c.conn === message.frame.conn);
      // bye 4003, close; the host then hears peer.close like from the real relay's webSocketClose.
      if (target) this.byeClient(target, RELAY_CLOSE_CODES.kicked, message.frame.reason);
      return;
    }
    const split = splitFrame(data);
    if (!split) return;
    const target = [...this.clients].find((c) => c.kind === host.kind && c.conn === split.conn && c.readyState === WS_OPEN);
    if (!target) {
      host.deliver(encodeRelayControl({ t: 'peer.close', conn: split.conn }));
      return;
    }
    const bytes = split.payload.slice();
    this.frames.push({ kind: host.kind, conn: split.conn, direction: 'daemon->client', bytes });
    const buffer = bytes.slice().buffer;
    queueMicrotask(() => target.fireMessage(buffer));
  }

  clientGone(socket: MemoryClientSocket): void {
    if (!this.clients.delete(socket)) return;
    this.hosts.get(socket.kind)?.deliver(encodeRelayControl({ t: 'peer.close', conn: socket.conn }));
  }

  hostGone(host: MemoryHostSocket): void {
    if (this.hosts.get(host.kind) !== host) return;
    this.hosts.delete(host.kind);
    for (const client of this.openClients(host.kind)) this.toClientText(client, encodeRelayControl({ t: 'host.offline', reason: 'closed' }));
  }

  private attachHost(socket: MemoryHostSocket): void {
    const previous = this.hosts.get(socket.kind);
    if (previous) {
      previous.deliver(encodeRelayControl({ t: 'bye', code: RELAY_CLOSE_CODES.hostReplaced, reason: 'replaced by newer host connection' }));
      this.hosts.delete(socket.kind);
      queueMicrotask(() => previous.shutdown(RELAY_CLOSE_CODES.hostReplaced, 'replaced'));
    }
    this.hosts.set(socket.kind, socket);
    socket.open = true;
    queueMicrotask(() => {
      socket.handlers.open();
      for (const client of this.openClients(socket.kind)) {
        this.announce(socket, client);
        this.toClientText(client, encodeRelayControl({ t: 'host.online' }));
      }
    });
  }

  private announce(host: MemoryHostSocket, client: MemoryClientSocket): void {
    host.deliver(
      encodeRelayControl({
        t: 'peer.open',
        conn: client.conn,
        userId: client.user.userId,
        displayName: client.user.displayName,
        ...(client.user.avatarUrl === undefined ? {} : { avatarUrl: client.user.avatarUrl }),
      }),
    );
  }

  private toClientText(socket: MemoryClientSocket, text: string): void {
    queueMicrotask(() => socket.fireMessage(text));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Identity tokens
// ---------------------------------------------------------------------------------------------------------------

export interface IssueOptions {
  readonly sub: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly cnf?: string;
  /** Override claims / header for negative tests. */
  readonly issuer?: string;
  readonly audience?: string;
  readonly typ?: string;
  readonly iatMs?: number;
  readonly ttlSeconds?: number;
  readonly kid?: string;
  readonly signWith?: KeyObject;
}

/** A relay stand-in that signs identity tokens exactly like the relay (EdDSA, typ smurg-identity+jwt, 5 min). */
export class TestIdentityIssuer {
  readonly issuer: string;
  readonly kid: string;
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  private readonly clock: Clock;

  constructor(issuer: string, keys: { readonly publicKey: KeyObject; readonly privateKey: KeyObject }, clock: Clock, kid = `test-${randomUUID()}`) {
    this.issuer = issuer;
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
    this.clock = clock;
    this.kid = kid;
  }

  issue(options: IssueOptions): Promise<string> {
    const iat = Math.floor((options.iatMs ?? this.clock.now()) / 1000);
    return new SignJWT({
      sub: options.sub,
      name: options.name,
      provider: 'dev',
      ...(options.cnf === undefined ? {} : { cnf: { 'smurg-noise-static': options.cnf } }),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: options.kid ?? this.kid, typ: options.typ ?? 'smurg-identity+jwt' })
      .setIssuer(options.issuer ?? this.issuer)
      .setAudience(options.audience ?? `smurg-daemon:${options.workspaceId}`)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (options.ttlSeconds ?? 300))
      .setJti(randomUUID())
      .sign(options.signWith ?? this.privateKey);
  }
}
