// RelayRoom: the forwarding core shared by WorkspaceDO and TransferDO (ARCHITECTURE §6, relay.md §1.1-1.2).
//
// Hibernation API only. Nothing about sockets is kept in memory, because local workerd (and production) really
// hibernates idle objects: routing state lives in socket tags (`host`, `client`, `c:<conn>`), socket attachments and
// the synchronous KV of the SQLite-backed storage.
//
// Framing (outside the end-to-end encryption; the only layer the relay reads):
//   client -> relay  <ciphertext>                  relay -> host    <u32be conn><ciphertext>
//   host   -> relay  <u32be conn><ciphertext>      relay -> client  <ciphertext>
// Control is JSON text, validated and encoded with @smurg/protocol/relay. "ping" -> "pong" is the runtime's
// auto-response: it never wakes the object and records the time used for liveness.
import { DurableObject } from 'cloudflare:workers';
import {
  MAX_CONN_ID,
  MAX_RELAY_FRAME,
  MIN_CONN_ID,
  RELAY_CLOSE_CODES,
  RELAY_CONN_PREFIX_BYTES,
  RELAY_PING,
  RELAY_PONG,
  encodeRelayControl,
  isConnId,
  parseHostToRelayText,
  prefixFrame,
  splitFrame,
  truncateCloseReason,
  type RelayCloseCode,
  type RelayControlFrame,
  type RelayHostOfflineReason,
} from '@smurg/protocol/relay';
import { parseRoomConfig, type RoomConfig } from '../lib/config.ts';
import { errorResponse } from '../lib/http.ts';
import { postTap, type TapDirection, type TapRole } from '../lib/tap.ts';
import {
  TAG_CLIENT,
  TAG_HOST,
  clientTag,
  readAttachment,
  type Attachment,
  type ClientAttachment,
  type HostAttachment,
} from './attachments.ts';
import type { RoomInspection } from './inspection.ts';
import { readAdmission, type Admission } from './internal.ts';

export const KV = {
  workspaceId: 'workspaceId',
  hostEpoch: 'hostEpoch',
  hostStatus: 'hostStatus',
  hostOfflineReason: 'hostOfflineReason',
  nextConn: 'nextConn',
  /** WorkspaceDO only: the account that claimed the workspace. */
  owner: 'owner',
} as const;

/** Alarms fire a little after the deadline so `now - lastSeen >= timeout` holds when they run. */
const ALARM_SLACK_MS = 25;
const MIN_ALARM_DELAY_MS = 10;

type Live<A extends Attachment> = { ws: WebSocket; att: A };

export abstract class RelayRoom extends DurableObject<Env> {
  protected abstract readonly source: 'WorkspaceDO' | 'TransferDO';
  /** WorkspaceDO watches host liveness with its alarm; TransferDO leaves that to the WorkspaceDO. */
  protected abstract readonly watchHost: boolean;

  private readonly bootedAt = Date.now();
  private tapSeq = 0;
  private settingsCache: RoomConfig | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every wake-up: keep it cheap (relay.md gotcha 4).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG));
  }

  /** Room-specific admission (ownership). Returns the refusal, or null when admitted. */
  protected abstract admit(admission: Admission): Response | null;

  protected get kv(): SyncKvStorage {
    return this.ctx.storage.kv;
  }

  protected get settings(): RoomConfig {
    this.settingsCache ??= parseRoomConfig(this.env);
    return this.settingsCache;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Upgrade
  // -------------------------------------------------------------------------------------------------------------

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return errorResponse(426, 'upgrade_required');
    const admission = readAdmission(req.headers);
    if (!admission) return errorResponse(400, 'bad_request');
    const refused = this.admit(admission);
    if (refused) return refused;
    const known = this.kv.get<string>(KV.workspaceId);
    if (known === undefined) this.kv.put(KV.workspaceId, admission.workspaceId);
    else if (known !== admission.workspaceId) return errorResponse(400, 'bad_request');
    if (admission.role === 'client') {
      const capped = this.checkClientCaps(admission.userId);
      if (capped) return capped;
    }

    const pair = new WebSocketPair();
    const now = Date.now();
    if (admission.role === 'host') this.acceptHost(pair[1], admission, now);
    else this.acceptClient(pair[1], admission, now);
    await this.armAlarm(false);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private checkClientCaps(userId: string): Response | null {
    const clients = this.liveClients();
    if (clients.length >= this.settings.maxClientSocketsPerWorkspace) {
      return errorResponse(429, 'too_many_connections', 'workspace connection limit reached');
    }
    if (clients.filter((c) => c.att.uid === userId).length >= this.settings.maxSocketsPerAccount) {
      return errorResponse(429, 'too_many_connections', 'account connection limit reached');
    }
    return null;
  }

  /** A new host connection always wins: it bumps the epoch and replaces older host sockets (relay.md gotcha 8). */
  private acceptHost(server: WebSocket, admission: Admission, now: number): void {
    const epoch = (this.kv.get<number>(KV.hostEpoch) ?? 0) + 1;
    this.kv.put(KV.hostEpoch, epoch);
    for (const old of this.ctx.getWebSockets(TAG_HOST)) {
      this.closeWithBye(old, readAttachment(old), RELAY_CLOSE_CODES.hostReplaced, 'replaced by a newer host connection');
    }
    this.ctx.acceptWebSocket(server, [TAG_HOST]);
    const att: HostAttachment = { r: 'h', epoch, uid: admission.userId, since: now };
    server.serializeAttachment(att);
    this.kv.put(KV.hostStatus, 'online');
    this.kv.delete(KV.hostOfflineReason);
    // The new host learns every connected client before any client is told to (re)start its handshake.
    const clients = this.liveClients();
    for (const client of clients) this.sendControl(server, att, peerOpenFrame(client.att));
    for (const client of clients) this.sendControl(client.ws, client.att, { t: 'host.online' });
  }

  private acceptClient(server: WebSocket, admission: Admission, now: number): void {
    const conn = this.allocConn();
    this.ctx.acceptWebSocket(server, [TAG_CLIENT, clientTag(conn)]);
    const att: ClientAttachment = { r: 'c', conn, uid: admission.userId, name: admission.displayName, since: now };
    if (admission.avatarUrl) att.avatar = admission.avatarUrl;
    server.serializeAttachment(att);
    // Liveness is checked right here: a host that froze while nobody watched is reported offline at once.
    const host = this.liveHostOrMarkOffline(now);
    this.sendControl(server, att, { t: 'hello', conn, host: host !== null });
    if (host) this.sendControl(host.ws, host.att, peerOpenFrame(att));
  }

  /** Relay-assigned u32 connection ids, unique per object across hibernation (0 is reserved). */
  private allocConn(): number {
    let candidate = this.kv.get<number>(KV.nextConn) ?? MIN_CONN_ID;
    for (let i = 0; i < 10_000; i++) {
      if (!isConnId(candidate)) candidate = MIN_CONN_ID;
      if (this.ctx.getWebSockets(clientTag(candidate)).length === 0) {
        this.kv.put(KV.nextConn, candidate >= MAX_CONN_ID ? MIN_CONN_ID : candidate + 1);
        return candidate;
      }
      candidate = candidate >= MAX_CONN_ID ? MIN_CONN_ID : candidate + 1;
    }
    throw new Error('no free connection id');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Hibernatable handlers
  // -------------------------------------------------------------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = readAttachment(ws);
    if (!att || att.gone) return;

    if (typeof message === 'string') {
      this.tap('in', att, att.r === 'c' ? att.conn : 0, message);
      // Clients have no control frames besides the auto-responded "ping"; anything else is dropped. Text is never
      // forwarded between peers.
      if (att.r === 'h' && this.isCurrentEpoch(att)) this.onHostText(message);
      return;
    }

    const conn = att.r === 'c' ? att.conn : message.byteLength >= RELAY_CONN_PREFIX_BYTES ? new DataView(message).getUint32(0) : 0;
    this.tap('in', att, conn, message);
    // Clients' frames grow by the 4-byte prefix on the way to the host, which must still fit MAX_RELAY_FRAME.
    const limit = att.r === 'c' ? MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES : MAX_RELAY_FRAME;
    if (message.byteLength > limit) {
      this.closeTooBig(ws, att);
      return;
    }
    if (att.r === 'c') this.forwardToHost(ws, att, message);
    else if (this.isCurrentEpoch(att)) this.forwardToClient(ws, att, message);
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.onGone(ws);
    // Complete the closing handshake ourselves: local workerd does not auto-reply for hibernatable sockets, and the
    // TCP connection otherwise lingers ~16 s (relay.md V10, gotcha 1).
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, 'bye');
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.onGone(ws);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    if (this.watchHost) {
      const host = this.currentHost();
      if (host && now - this.lastSeen(host) >= this.settings.hostTimeoutMs) this.markHostOffline(host, 'timeout');
    }
    // Clients whose laptop slept keep a socket that looks open; without this the host's member list goes stale.
    for (const client of this.liveClients()) {
      if (now - this.lastSeen(client) >= this.settings.clientSweepMs) {
        this.closeClient(client, RELAY_CLOSE_CODES.heartbeatTimeout, 'client heartbeat timeout');
      }
    }
    await this.armAlarm(true);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Forwarding
  // -------------------------------------------------------------------------------------------------------------

  private forwardToHost(ws: WebSocket, att: ClientAttachment, message: ArrayBuffer): void {
    if (message.byteLength === 0) return;
    const host = this.currentHost();
    if (!host) {
      this.sendControl(ws, att, { t: 'host.offline', reason: this.offlineReason() });
      return;
    }
    const frame = prefixFrame(att.conn, new Uint8Array(message));
    this.tap('out', host.att, att.conn, frame);
    host.ws.send(frame);
  }

  private forwardToClient(ws: WebSocket, att: HostAttachment, message: ArrayBuffer): void {
    const split = splitFrame(message);
    if (!split) return;
    const target = this.clientByConn(split.conn);
    if (!target) {
      // Tell the host the connection is gone so it can drop that channel.
      this.sendControl(ws, att, { t: 'peer.close', conn: split.conn });
      return;
    }
    this.tap('out', target.att, split.conn, split.payload);
    target.ws.send(split.payload);
  }

  private onHostText(text: string): void {
    const parsed = parseHostToRelayText(text);
    if (parsed.kind !== 'control') return;
    const frame = parsed.frame;
    if (frame.t === 'peer.kick') {
      const target = this.clientByConn(frame.conn);
      if (target) this.closeClient(target, RELAY_CLOSE_CODES.kicked, frame.reason === '' ? 'removed by the host' : frame.reason);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Liveness and teardown
  // -------------------------------------------------------------------------------------------------------------

  private onGone(ws: WebSocket): void {
    const att = readAttachment(ws);
    if (!att || att.gone) return;
    markGone(ws, att);
    if (att.r === 'c') {
      const host = this.currentHost();
      if (host) this.sendControl(host.ws, host.att, { t: 'peer.close', conn: att.conn });
    } else if (this.isCurrentEpoch(att) && this.kv.get(KV.hostStatus) === 'online') {
      // Close events of replaced host sockets (older epochs) are ignored (gotcha 8).
      this.setHostOffline('closed');
    }
  }

  private closeTooBig(ws: WebSocket, att: Attachment): void {
    const reason = 'frame exceeds the relay limit';
    if (att.r === 'c') {
      this.closeClient({ ws, att }, RELAY_CLOSE_CODES.tooBig, reason);
      return;
    }
    const wasCurrent = this.isCurrentEpoch(att) && this.kv.get(KV.hostStatus) === 'online';
    this.closeWithBye(ws, att, RELAY_CLOSE_CODES.tooBig, reason);
    if (wasCurrent) this.setHostOffline('closed');
  }

  private closeClient(client: Live<ClientAttachment>, code: RelayCloseCode, reason: string): void {
    this.closeWithBye(client.ws, client.att, code, reason);
    const host = this.currentHost();
    if (host) this.sendControl(host.ws, host.att, { t: 'peer.close', conn: client.att.conn });
  }

  private markHostOffline(host: Live<HostAttachment>, reason: RelayHostOfflineReason): void {
    this.setHostOffline(reason);
    this.closeWithBye(host.ws, host.att, RELAY_CLOSE_CODES.heartbeatTimeout, 'heartbeat timeout');
  }

  private setHostOffline(reason: RelayHostOfflineReason): void {
    this.kv.put(KV.hostStatus, 'offline');
    this.kv.put(KV.hostOfflineReason, reason);
    for (const client of this.liveClients()) this.sendControl(client.ws, client.att, { t: 'host.offline', reason });
  }

  /**
   * Relay-initiated close: `bye` first, because Node clients only see the close event when workerd's TCP FIN arrives
   * 10-16 s later (relay.md V11, gotcha 2). Clients treat `bye` as "closed now".
   */
  private closeWithBye(ws: WebSocket, att: Attachment | null, code: RelayCloseCode, reason: string): void {
    const safeReason = truncateCloseReason(reason);
    if (att) markGone(ws, att);
    this.sendControl(ws, att, { t: 'bye', code, reason: safeReason });
    try {
      ws.close(code, safeReason);
    } catch {
      // already closing
    }
  }

  private liveHostOrMarkOffline(now: number): Live<HostAttachment> | null {
    const host = this.currentHost();
    if (!host) return null;
    if (this.watchHost && now - this.lastSeen(host) >= this.settings.hostTimeoutMs) {
      this.markHostOffline(host, 'timeout');
      return null;
    }
    return host;
  }

  /** The host socket of the current epoch, if the host is considered online. */
  protected currentHost(): Live<HostAttachment> | null {
    if (this.kv.get(KV.hostStatus) !== 'online') return null;
    const epoch = this.kv.get<number>(KV.hostEpoch);
    for (const ws of this.ctx.getWebSockets(TAG_HOST)) {
      const att = readAttachment(ws);
      if (att?.r === 'h' && !att.gone && att.epoch === epoch && ws.readyState === WebSocket.OPEN) return { ws, att };
    }
    return null;
  }

  protected liveClients(): Live<ClientAttachment>[] {
    const clients: Live<ClientAttachment>[] = [];
    for (const ws of this.ctx.getWebSockets(TAG_CLIENT)) {
      const att = readAttachment(ws);
      if (att?.r === 'c' && !att.gone && ws.readyState === WebSocket.OPEN) clients.push({ ws, att });
    }
    return clients;
  }

  private clientByConn(conn: number): Live<ClientAttachment> | null {
    for (const ws of this.ctx.getWebSockets(clientTag(conn))) {
      const att = readAttachment(ws);
      if (att?.r === 'c' && att.conn === conn && !att.gone && ws.readyState === WebSocket.OPEN) return { ws, att };
    }
    return null;
  }

  private isCurrentEpoch(att: HostAttachment): boolean {
    return att.epoch === this.kv.get<number>(KV.hostEpoch);
  }

  private offlineReason(): RelayHostOfflineReason {
    return this.kv.get<string>(KV.hostOfflineReason) === 'timeout' ? 'timeout' : 'closed';
  }

  /** Last sign of life: the runtime's auto-response timestamp of the last "ping", or the accept time. */
  private lastSeen(live: Live<Attachment>): number {
    const ping = this.ctx.getWebSocketAutoResponseTimestamp(live.ws)?.getTime() ?? 0;
    return Math.max(ping, live.att.since);
  }

  /**
   * One alarm per object multiplexes every deadline: the host timeout (WorkspaceDO) and the client sweep. With no
   * client connected nothing is watched (nobody would be told); a joining client triggers a synchronous check.
   */
  private async armAlarm(fromAlarm: boolean): Promise<void> {
    const clients = this.liveClients();
    if (clients.length === 0) return;
    let next = Number.POSITIVE_INFINITY;
    if (this.watchHost) {
      const host = this.currentHost();
      if (host) next = this.lastSeen(host) + this.settings.hostTimeoutMs;
    }
    for (const client of clients) next = Math.min(next, this.lastSeen(client) + this.settings.clientSweepMs);
    if (!Number.isFinite(next)) return;
    const at = Math.max(next + ALARM_SLACK_MS, Date.now() + MIN_ALARM_DELAY_MS);
    if (!fromAlarm) {
      const current = await this.ctx.storage.getAlarm();
      if (current !== null && current <= at) return;
    }
    await this.ctx.storage.setAlarm(at);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------------------------------------------

  private sendControl(ws: WebSocket, att: Attachment | null, frame: RelayControlFrame): void {
    let text: string;
    try {
      text = encodeRelayControl(frame);
    } catch {
      // encodeRelayControl refuses frames the peer would reject; never put one on the wire.
      console.error(`relay: dropped an invalid ${frame.t} control frame`);
      return;
    }
    const conn = att?.r === 'c' ? att.conn : 'conn' in frame ? frame.conn : 0;
    this.tap('out', att, conn, text);
    try {
      ws.send(text);
    } catch {
      // socket already closed
    }
  }

  private tap(direction: TapDirection, att: Attachment | null, conn: number, data: string | ArrayBuffer | Uint8Array): void {
    const url = this.settings.tapUrl;
    if (!url) return;
    const role: TapRole = att?.r === 'h' ? 'host' : att?.r === 'c' ? 'client' : 'none';
    const body = typeof data === 'string' ? data : data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    void postTap(
      url,
      {
        source: this.source,
        direction,
        role,
        conn,
        kind: typeof data === 'string' ? 'text' : 'binary',
        workspaceId: this.kv.get<string>(KV.workspaceId) ?? '',
        seq: ++this.tapSeq,
      },
      body,
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // RPC for tests and diagnostics (only bound Workers and the local test harness can call it)
  // -------------------------------------------------------------------------------------------------------------

  async inspect(): Promise<RoomInspection> {
    const host = this.currentHost();
    const reason = this.kv.get<string>(KV.hostOfflineReason);
    return {
      source: this.source,
      bootedAt: this.bootedAt,
      workspaceId: this.kv.get<string>(KV.workspaceId) ?? null,
      owner: this.kv.get<string>(KV.owner) ?? null,
      hostStatus: this.kv.get(KV.hostStatus) === 'online' ? 'online' : 'offline',
      hostEpoch: this.kv.get<number>(KV.hostEpoch) ?? 0,
      hostOfflineReason: reason === 'timeout' || reason === 'closed' ? reason : null,
      hostLastSeen: host ? this.lastSeen(host) : null,
      clients: this.liveClients().map((c) => ({ conn: c.att.conn, userId: c.att.uid, lastSeen: this.lastSeen(c) })),
      alarm: await this.ctx.storage.getAlarm(),
      nextConn: this.kv.get<number>(KV.nextConn) ?? null,
    };
  }
}

function peerOpenFrame(att: ClientAttachment): RelayControlFrame {
  return {
    t: 'peer.open',
    conn: att.conn,
    userId: att.uid,
    displayName: att.name,
    ...(att.avatar ? { avatarUrl: att.avatar } : {}),
  };
}

function markGone(ws: WebSocket, att: Attachment): void {
  att.gone = 1;
  try {
    ws.serializeAttachment(att);
  } catch {
    // a socket that is already closed cannot store an attachment; the in-memory flag still applies to this event
  }
}
