// The Hub: every admitted channel, the logical channels behind them (resume), and all d→c fan-out.
//
// Inbound: decrypted message → decodeEnvelope (strict, registry-validated, direction + channel checked) → c→d seq
// de-duplication → channel.ack handled here → Router.dispatch. Outbound: every d→c Envelope on the interactive
// channel is sequenced and kept in the logical channel's outbox until the client acknowledges it, so a reply or an
// event lost with a socket is replayed on resume. Fan-out re-checks the recipient's CURRENT role with the registry's
// mayReceive (fail closed), then any capability / filter the caller adds.
import {
  can,
  decodeEnvelope,
  encodeEnvelope,
  mayReceive,
  type Actor,
  type ChannelPurpose,
  type ClientEnvelope,
  type PayloadInputOf,
  type Role,
  type SecureChannel,
} from '@smurg/protocol';
import { LOCAL_CHANNEL_VIA, localChannelReceives } from '../local/local-channel.ts';
import { withAuditVia } from './audit.ts';
import type { LimitsConfig, TimingConfig } from './config.ts';
import type {
  AuditLog,
  BroadcastOptions,
  ChannelClosedReason,
  ClientConnection,
  ClientKind,
  ConnectionCloseReason,
  ConnectionMode,
  EventBus,
  Hub,
  OutboundType,
  Recipient,
  Router,
  UserId,
} from './interfaces.ts';
import { newId, toDisposable, type Clock, type Disposable } from './lifecycle.ts';
import { LogicalChannel } from './logical-channel.ts';
import type { Logger } from './logger.ts';

/** What the network layer lets the hub do with the relay connection under a channel. */
export interface ConnectionControl {
  /** host → relay peer.kick: the relay closes that client socket (bye 4003). */
  kick(reason: string): void;
  /** Bytes queued on the daemon's host socket of this purpose. */
  bufferedAmount(): number;
}

/** The decision taken inside admit() (synchronously) for an interactive or transfer channel. */
export interface HubAdmission {
  readonly purpose: ChannelPurpose;
  readonly channelId: string;
  readonly resumed: boolean;
  /** Interactive: the client processed everything up to here (replay starts after it). */
  readonly replayFrom: number;
}

/** What the hub uses of a channel: an established SecureChannel, or the local control-socket adapter. */
export type HubChannel = Pick<SecureChannel, 'isClosed' | 'send' | 'onMessage' | 'onClose' | 'close'>;

export interface HubAttachInput {
  readonly channel: HubChannel;
  readonly admission: HubAdmission;
  /** The relay's connection id; null for a local (control socket) connection. */
  readonly relayConn: number | null;
  readonly userId: UserId;
  readonly deviceId: string;
  readonly clientKind: ClientKind;
  readonly deviceName: string;
  readonly mode: ConnectionMode;
  readonly control: ConnectionControl;
}

export interface HubOptions {
  readonly clock: Clock;
  readonly log: Logger;
  readonly bus: EventBus;
  readonly timing: TimingConfig;
  readonly limits: LimitsConfig;
  /** Current role of an ACTIVE member, or null (kicked / unknown): nothing is delivered to them. */
  readonly roleOf: (userId: UserId) => Role | null;
  /** Refusals the hub decides itself (undecodable, forged direction/channel) and connects/disconnects are audited. */
  readonly audit: AuditLog;
  /** Audit actor of a member (any status). */
  readonly actorOf: (userId: UserId) => Actor;
}

/** Messages of the decoder that name a path problem (paths.ts): the refusal is a path denial (SPEC R1). */
const PATH_ISSUE = /^invalid (?:relative path|name): (.+)$/;

/** decodeEnvelope failures that mean "not allowed" rather than "malformed": audited as authz.denied. */
const AUTHZ_DECODE_REASONS: ReadonlySet<string> = new Set(['direction', 'channel', 'unknown-type']);

const DENIAL_WINDOW_MS = 60_000;

class HubConnection implements ClientConnection {
  readonly id: string;
  readonly purpose: ChannelPurpose;
  readonly relayConn: number | null;
  readonly userId: UserId;
  readonly deviceId: string;
  readonly clientKind: ClientKind;
  readonly deviceName: string;
  readonly mode: ConnectionMode;
  readonly channelId: string;
  readonly openedAt: number;
  readonly channel: HubChannel;
  readonly logical: LogicalChannel | null;
  readonly control: ConnectionControl;
  transferSeq = 0;
  unacked = 0;
  ackSince: number | null = null;
  protocolErrors = 0;
  /** Refusals (authz / path) in the current window; too many close the connection (security review F5). */
  denialWindowStart = 0;
  denials = 0;
  closed = false;
  closeReason: ConnectionCloseReason | null = null;
  private readonly closeListeners = new Set<(reason: ConnectionCloseReason) => void>();

  constructor(input: HubAttachInput, logical: LogicalChannel | null, openedAt: number) {
    this.id = newId('conn');
    this.purpose = input.admission.purpose;
    this.relayConn = input.relayConn;
    this.userId = input.userId;
    this.deviceId = input.deviceId;
    this.clientKind = input.clientKind;
    this.deviceName = input.deviceName;
    this.mode = input.mode;
    this.channelId = input.admission.channelId;
    this.openedAt = openedAt;
    this.channel = input.channel;
    this.logical = logical;
    this.control = input.control;
  }

  get isOpen(): boolean {
    return !this.closed && !this.channel.isClosed;
  }

  get bufferedAmount(): number {
    try {
      return this.control.bufferedAmount();
    } catch {
      return 0;
    }
  }

  onClose(listener: (reason: ConnectionCloseReason) => void): Disposable {
    if (this.closed) {
      const reason = this.closeReason ?? 'disconnected';
      queueMicrotask(() => listener(reason));
      return toDisposable(() => {});
    }
    this.closeListeners.add(listener);
    return toDisposable(() => this.closeListeners.delete(listener));
  }

  /** Marks closed and runs the listeners once. */
  finish(reason: ConnectionCloseReason, log: Logger): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.closeReason = reason;
    for (const listener of [...this.closeListeners]) {
      try {
        listener(reason);
      } catch (err) {
        log.error('connection close listener failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.closeListeners.clear();
    return true;
  }
}

export class HubImpl implements Hub {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly bus: EventBus;
  private readonly timing: TimingConfig;
  private readonly limits: LimitsConfig;
  private readonly roleOf: (userId: UserId) => Role | null;
  private readonly audit: AuditLog;
  private readonly actorOf: (userId: UserId) => Actor;
  private router: Router | null = null;
  private readonly conns = new Map<string, HubConnection>();
  /** Interactive logical channels by id (connected or retained for resume). */
  private readonly channels = new Map<string, LogicalChannel>();
  /** The live connection of each logical channel. */
  private readonly channelConn = new Map<string, HubConnection>();
  /** Transfer connections by their per-socket channel id. */
  private readonly transferByChannel = new Map<string, HubConnection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(options: HubOptions) {
    this.clock = options.clock;
    this.log = options.log;
    this.bus = options.bus;
    this.timing = options.timing;
    this.limits = options.limits;
    this.roleOf = options.roleOf;
    this.audit = options.audit;
    this.actorOf = options.actorOf;
  }

  /** The router is created after the hub (it replies through it). */
  setRouter(router: Router): void {
    this.router = router;
  }

  start(): void {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.timing.presenceHeartbeatMs);
    this.heartbeatTimer.unref?.();
    this.tickTimer = setInterval(() => this.tick(), Math.min(this.timing.ackDelayMs, 1_000));
    this.tickTimer.unref?.();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Admission (called from admit(), synchronously) and attach (after daemonAccept resolved)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Interactive: continue the requested logical channel when the contract allows it (same user AND device, lastSeq in
   * range), else open a new one. Transfer: a fresh per-socket id. Never fails.
   */
  prepareAdmission(input: {
    readonly purpose: ChannelPurpose;
    readonly userId: UserId;
    readonly deviceId: string;
    readonly resume?: { readonly channelId: string; readonly lastSeq: number } | undefined;
    /** A control-socket channel (DaemonLifecycle.attachLocal): receives only LOCAL_CHANNEL_RECEIVES unasked. */
    readonly local?: boolean;
  }): HubAdmission {
    if (input.purpose === 'transfer') return { purpose: 'transfer', channelId: newId('xf'), resumed: false, replayFrom: 0 };
    const local = input.local === true;
    const want = input.resume;
    const existing = want ? this.channels.get(want.channelId) : undefined;
    const sameDevice = existing !== undefined && existing.userId === input.userId && existing.deviceId === input.deviceId && existing.local === local;
    if (want && existing && sameDevice && existing.canResumeFrom(want.lastSeq)) {
      existing.trim(want.lastSeq);
      return { purpose: 'interactive', channelId: existing.id, resumed: true, replayFrom: want.lastSeq };
    }
    // The client could not continue: the old logical channel (if it was this device's) is replaced for good.
    if (existing && sameDevice) this.discard(existing, 'interactive');
    // A device reconnecting fresh (page reload) leaves its disconnected channels behind; stop queueing for them.
    for (const channel of [...this.channels.values()]) {
      if (channel.deviceId === input.deviceId && channel.userId === input.userId && channel.local === local && !this.channelConn.has(channel.id)) this.discard(channel, 'interactive');
    }
    const channel = new LogicalChannel(
      newId('ch'),
      input.userId,
      input.deviceId,
      this.clock.now(),
      { maxEntries: this.limits.outboxMaxEntries, maxBytes: this.limits.outboxMaxBytes },
      { local },
    );
    this.channels.set(channel.id, channel);
    return { purpose: 'interactive', channelId: channel.id, resumed: false, replayFrom: 0 };
  }

  /** Binds an admitted channel. Returns null (and closes it) when the admission is no longer valid. */
  attach(input: HubAttachInput): ClientConnection | null {
    const { admission } = input;
    let logical: LogicalChannel | null = null;
    if (admission.purpose === 'interactive') {
      logical = this.channels.get(admission.channelId) ?? null;
      if (!logical || logical.userId !== input.userId || logical.local !== (input.mode === 'local')) {
        // Discarded between admit() and now (kick, role change): the client must start over. (A local connection
        // only ever binds a local logical channel and vice versa: what reaches it is filtered by that flag.)
        input.channel.close();
        return null;
      }
    } else if (input.mode === 'local') {
      input.channel.close();
      return null;
    }
    if (this.stopped || this.roleOf(input.userId) === null) {
      input.channel.close();
      return null;
    }
    const conn = new HubConnection(input, logical, this.clock.now());
    this.conns.set(conn.id, conn);
    if (logical) {
      const previous = this.channelConn.get(logical.id);
      this.channelConn.set(logical.id, conn);
      logical.disconnectedAt = null;
      // The same device came back while its old socket still looked open: the old one is dead to the client.
      if (previous && previous !== conn) this.detach(previous, 'replaced', { closeChannel: true });
    } else {
      this.transferByChannel.set(conn.channelId, conn);
    }
    // Register at once: pipelined requests may already be waiting behind the verdict. Whatever a local (control-socket)
    // connection's message causes is audited with detail.via 'control-socket' (review F1: that "host" is whoever runs
    // as the host's OS account).
    if (conn.mode === 'local') input.channel.onMessage((bytes) => withAuditVia(LOCAL_CHANNEL_VIA, () => this.onMessage(conn, bytes)));
    else input.channel.onMessage((bytes) => this.onMessage(conn, bytes));
    input.channel.onClose((event) => this.detach(conn, event.initiator === 'error' ? 'error' : 'disconnected', { closeChannel: false }));
    if (logical && admission.resumed) {
      // Rule 5: everything the client has not processed, in order, before anything new.
      for (const entry of logical.pendingAfter(admission.replayFrom)) this.transmit(conn, entry.bytes);
    }
    this.bus.emit('conn.opened', { conn, resumed: admission.resumed });
    return conn;
  }

  /** The relay said the client socket closed, or the relay socket of `purpose` went down. */
  peerGone(connId: string, reason: ConnectionCloseReason = 'disconnected'): void {
    const conn = this.conns.get(connId);
    if (conn) this.detach(conn, reason, { closeChannel: true });
  }

  /** Every connection of a purpose, e.g. when that relay socket dropped (its conn ids are void now). */
  dropPurpose(purpose: ChannelPurpose, reason: ConnectionCloseReason): void {
    for (const conn of [...this.conns.values()]) if (conn.purpose === purpose) this.detach(conn, reason, { closeChannel: true });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Hub interface
  // ---------------------------------------------------------------------------------------------------------------

  connection(id: string): ClientConnection | null {
    return this.conns.get(id) ?? null;
  }

  connections(filter: { readonly userId?: UserId; readonly purpose?: ChannelPurpose } = {}): ClientConnection[] {
    return [...this.conns.values()].filter(
      (conn) => conn.isOpen && (filter.userId === undefined || conn.userId === filter.userId) && (filter.purpose === undefined || conn.purpose === filter.purpose),
    );
  }

  recipients(filter: { readonly userId?: UserId; readonly purpose?: ChannelPurpose } = {}): Recipient[] {
    const purpose = filter.purpose ?? 'interactive';
    const out: Recipient[] = [];
    if (purpose === 'interactive') {
      for (const channel of this.channels.values()) {
        if (filter.userId !== undefined && channel.userId !== filter.userId) continue;
        const conn = this.channelConn.get(channel.id);
        out.push({ channelId: channel.id, userId: channel.userId, purpose, conn: conn && conn.isOpen ? conn : null });
      }
    } else {
      for (const conn of this.transferByChannel.values()) {
        if (!conn.isOpen || (filter.userId !== undefined && conn.userId !== filter.userId)) continue;
        out.push({ channelId: conn.channelId, userId: conn.userId, purpose, conn });
      }
    }
    return out;
  }

  isOnline(userId: UserId): boolean {
    for (const conn of this.conns.values()) if (conn.userId === userId && conn.isOpen) return true;
    return false;
  }

  onlineUserIds(): ReadonlySet<UserId> {
    const out = new Set<UserId>();
    for (const conn of this.conns.values()) if (conn.isOpen) out.add(conn.userId);
    return out;
  }

  send<T extends OutboundType>(target: ClientConnection | string, type: T, payload: PayloadInputOf<T>): boolean {
    const recipient = this.recipientOf(target);
    if (!recipient) return false;
    const role = this.roleOf(recipient.userId);
    if (role === null || !mayReceive(role, type)) {
      this.log.warn('fan-out refused by the registry', { type, reason: role === null ? 'not-a-member' : 'role' });
      return false;
    }
    if (this.localRefuses(recipient, type)) {
      this.log.debug('fan-out not sent to a local channel', { type });
      return false;
    }
    return this.deliver(recipient, type, payload, newId('ev'));
  }

  sendToUser<T extends OutboundType>(userId: UserId, type: T, payload: PayloadInputOf<T>, options: { readonly purpose?: ChannelPurpose } = {}): number {
    let count = 0;
    for (const recipient of this.recipients({ userId, purpose: options.purpose ?? 'interactive' })) {
      if (this.send(recipient.channelId, type, payload)) count++;
    }
    return count;
  }

  broadcast<T extends OutboundType>(type: T, payload: PayloadInputOf<T>, options: BroadcastOptions = {}): number {
    let count = 0;
    for (const recipient of this.recipients({ purpose: options.purpose ?? 'interactive' })) {
      if (recipient.channelId === options.exclude) continue;
      const role = this.roleOf(recipient.userId);
      if (role === null || !mayReceive(role, type)) continue;
      if (this.localRefuses(recipient, type)) continue;
      if (options.capability !== undefined && !can(role, options.capability)) continue;
      if (options.filter && !options.filter(recipient, role)) continue;
      if (this.deliver(recipient, type, payload, newId('ev'))) count++;
    }
    return count;
  }

  close(target: ClientConnection | string, reason: ChannelClosedReason, message?: string): void {
    const conn = typeof target === 'string' ? (this.conns.get(target) ?? this.channelConnOf(target)) : this.conns.get(target.id);
    if (!conn) return;
    this.closeWithReason(conn, reason, message);
  }

  closeUser(userId: UserId, reason: ChannelClosedReason, message?: string): number {
    let count = 0;
    for (const conn of [...this.conns.values()]) {
      if (conn.userId !== userId || conn.closed) continue;
      this.closeWithReason(conn, reason, message);
      count++;
    }
    // No resume after a kick / role change: the next admission starts a fresh logical channel.
    for (const channel of [...this.channels.values()]) if (channel.userId === userId) this.discard(channel, 'interactive');
    return count;
  }

  /** stop(): channel.closed{stopped} everywhere, then close every channel (without peer.kick: the host socket closes). */
  closeAll(reason: ChannelClosedReason, message?: string): void {
    this.stopped = true;
    for (const conn of [...this.conns.values()]) {
      if (conn.closed) continue;
      this.sendClosed(conn, reason, message);
      this.detach(conn, reason, { closeChannel: true });
    }
    for (const channel of [...this.channels.values()]) this.discard(channel, 'interactive');
    this.stopTimers();
  }

  stopTimers(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer);
    this.heartbeatTimer = undefined;
    this.tickTimer = undefined;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Used by the router
  // ---------------------------------------------------------------------------------------------------------------

  /** `X.ok` / `error` for request `requestId`, on the request's logical channel (replayed if the socket is gone). */
  reply(conn: ClientConnection, requestId: string, type: string, payload: unknown): void {
    const hubConn = this.conns.get(conn.id);
    if (!hubConn) return;
    const recipient: Recipient = hubConn.logical
      ? { channelId: hubConn.logical.id, userId: hubConn.userId, purpose: 'interactive', conn: hubConn }
      : { channelId: hubConn.channelId, userId: hubConn.userId, purpose: 'transfer', conn: hubConn };
    this.deliver(recipient, type as OutboundType, payload as never, requestId);
  }

  /** A protocol violation on a connection; too many close it with protocol-error. */
  protocolError(conn: ClientConnection): void {
    const hubConn = this.conns.get(conn.id);
    if (!hubConn || hubConn.closed) return;
    hubConn.protocolErrors++;
    if (hubConn.protocolErrors > this.limits.maxProtocolErrorsPerConn) this.closeWithReason(hubConn, 'protocol-error');
  }

  /**
   * The router (or the hub itself) refused and audited a request of this connection. More than
   * limits.maxDenialsPerConnPerMinute in a minute close it with protocol-error AND end its logical channel, so the
   * client cannot replay the rest of a flood on resume: every refusal costs the host an audit entry (security
   * review F5). Called after the refusal was answered.
   */
  denied(conn: ClientConnection): void {
    const hubConn = this.conns.get(conn.id);
    if (!hubConn || hubConn.closed) return;
    const now = this.clock.now();
    if (now - hubConn.denialWindowStart >= DENIAL_WINDOW_MS) {
      hubConn.denialWindowStart = now;
      hubConn.denials = 0;
    }
    hubConn.denials++;
    if (hubConn.denials <= this.limits.maxDenialsPerConnPerMinute) return;
    this.audit.record({
      actor: this.actorOf(hubConn.userId),
      action: 'authz.denied',
      outcome: 'denied',
      target: hubConn.deviceId,
      detail: { reason: 'too-many-denials', denials: hubConn.denials, windowMs: DENIAL_WINDOW_MS },
    });
    this.closeWithReason(hubConn, 'protocol-error');
    if (hubConn.logical) this.discard(hubConn.logical, 'interactive');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------------

  private recipientOf(target: ClientConnection | string): Recipient | null {
    if (typeof target !== 'string') {
      const conn = this.conns.get(target.id);
      if (!conn) return null;
      if (conn.logical) return { channelId: conn.logical.id, userId: conn.userId, purpose: 'interactive', conn };
      return conn.isOpen ? { channelId: conn.channelId, userId: conn.userId, purpose: 'transfer', conn } : null;
    }
    const channel = this.channels.get(target);
    if (channel) {
      const conn = this.channelConn.get(channel.id);
      return { channelId: channel.id, userId: channel.userId, purpose: 'interactive', conn: conn && conn.isOpen ? conn : null };
    }
    const transfer = this.transferByChannel.get(target) ?? this.conns.get(target);
    if (transfer && transfer.isOpen) {
      if (transfer.logical) return { channelId: transfer.logical.id, userId: transfer.userId, purpose: 'interactive', conn: transfer };
      return { channelId: transfer.channelId, userId: transfer.userId, purpose: 'transfer', conn: transfer };
    }
    return null;
  }

  /**
   * A local (control-socket) logical channel receives unasked only what `smurg attach` consumes
   * (local/local-channel.ts LOCAL_CHANNEL_RECEIVES): checked per logical channel, so a disconnected one's outbox does
   * not collect the rest either. (A recipient whose logical channel is gone gets nothing anyway: deliver().)
   */
  private localRefuses(recipient: Recipient, type: string): boolean {
    if (recipient.purpose !== 'interactive') return false;
    const channel = this.channels.get(recipient.channelId);
    return channel !== undefined && channel.local && !localChannelReceives(type);
  }

  private channelConnOf(channelId: string): HubConnection | undefined {
    return this.channelConn.get(channelId) ?? this.transferByChannel.get(channelId);
  }

  /** Encodes and sends (interactive: sequenced + kept for replay). Returns false when nothing was queued or sent. */
  private deliver(recipient: Recipient, type: string, payload: unknown, id: string): boolean {
    if (recipient.purpose === 'interactive') {
      const channel = this.channels.get(recipient.channelId);
      if (!channel) return false;
      const seq = channel.nextSeq();
      const bytes = encodeEnvelope({ type, id, seq, payload } as never, { from: 'daemon', channel: 'interactive' });
      channel.push(seq, bytes);
      const conn = this.channelConn.get(channel.id);
      if (conn && conn.isOpen) this.transmit(conn, bytes);
      return true;
    }
    const conn = this.transferByChannel.get(recipient.channelId);
    if (!conn || !conn.isOpen) return false;
    conn.transferSeq += 1;
    const bytes = encodeEnvelope({ type, id, seq: conn.transferSeq, payload } as never, { from: 'daemon', channel: 'transfer' });
    this.transmit(conn, bytes);
    return true;
  }

  private transmit(conn: HubConnection, bytes: Uint8Array): void {
    if (!conn.isOpen) return;
    try {
      conn.channel.send(bytes);
    } catch (err) {
      // The channel closed underneath us; its close handler detaches. Interactive messages stay in the outbox.
      this.log.debug('send on a closing channel', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private onMessage(conn: HubConnection, bytes: Uint8Array): void {
    if (conn.closed) return;
    const decoded = decodeEnvelope(bytes, { from: 'client', channel: conn.purpose });
    if (!decoded.ok) {
      this.log.debug('undecodable envelope', { reason: String(decoded.error.detail?.['reason'] ?? 'unknown'), type: decoded.type ?? 'unknown' });
      if (decoded.id !== null) this.reply(conn, decoded.id, 'error', decoded.error.toPayload());
      this.auditDecodeRefusal(conn, decoded.type, decoded.error.detail);
      this.protocolError(conn);
      return;
    }
    const envelope = decoded.envelope;
    if (conn.logical && envelope.seq > 0) {
      if (!conn.logical.acceptInbound(envelope.seq)) return; // rule 3: already processed (a replay after resume)
      conn.unacked++;
      conn.ackSince ??= this.clock.now();
      if (conn.unacked >= this.timing.ackEvery) this.sendAck(conn);
    }
    if (envelope.type === 'channel.ack') {
      conn.logical?.trim((envelope.payload as { upTo: number }).upTo);
      return;
    }
    const router = this.router;
    if (!router) {
      this.log.error('message before the router was attached', { type: envelope.type });
      return;
    }
    router.dispatch(conn, envelope as ClientEnvelope).catch((err: unknown) => {
      this.log.error('router dispatch failed', { type: envelope.type, error: err instanceof Error ? err.name : 'unknown' });
    });
  }

  /**
   * SPEC R1 (refuse and record), ARCHITECTURE §2 rule 4: the decoder refuses some requests before any handler could audit
   * them. An invalid path (`..`, absolute, backslash, …) is a path denial; a type the client may not send at all
   * (d→c, the other socket's, unknown) is an authorization denial. Plainly malformed bytes are only counted as
   * protocol errors. Both kinds also count against the connection's denial budget.
   */
  private auditDecodeRefusal(conn: HubConnection, type: string | null, detail: Readonly<Record<string, unknown>> | undefined): void {
    const reason = typeof detail?.['reason'] === 'string' ? detail['reason'] : 'unknown';
    const issues: readonly unknown[] = Array.isArray(detail?.['issues']) ? (detail['issues'] as unknown[]) : [];
    let pathIssue: { readonly problem: string; readonly field: string | null } | null = null;
    for (const issue of issues) {
      const { message, path } = (issue ?? {}) as { message?: unknown; path?: unknown };
      const match = typeof message === 'string' ? PATH_ISSUE.exec(message) : null;
      if (match) {
        pathIssue = { problem: match[1] ?? 'lexical', field: typeof path === 'string' ? path : null };
        break;
      }
    }
    const label = type ?? 'unknown';
    const actor = this.actorOf(conn.userId);
    if (pathIssue !== null) {
      this.audit.record({
        actor,
        action: 'path.denied',
        outcome: 'denied',
        target: label,
        detail: { type: label, reason: 'lexical', problem: pathIssue.problem, ...(pathIssue.field === null ? {} : { field: pathIssue.field }) },
      });
    } else if (AUTHZ_DECODE_REASONS.has(reason)) {
      this.audit.record({ actor, action: 'authz.denied', outcome: 'denied', target: label, detail: { type: label, reason } });
    } else {
      return;
    }
    this.denied(conn);
  }

  private sendAck(conn: HubConnection): void {
    const logical = conn.logical;
    conn.unacked = 0;
    conn.ackSince = null;
    if (!logical || !conn.isOpen) return;
    // Rule 2: acks are unsequenced (seq 0) and never stored.
    const bytes = encodeEnvelope({ type: 'channel.ack', id: newId('ack'), seq: 0, payload: { upTo: logical.c2dLast } }, { from: 'daemon', channel: 'interactive' });
    this.transmit(conn, bytes);
  }

  private sendClosed(conn: HubConnection, reason: ChannelClosedReason, message?: string): void {
    if (!conn.isOpen) return;
    const payload = message === undefined ? { reason } : { reason, message };
    try {
      if (conn.logical) this.deliver({ channelId: conn.logical.id, userId: conn.userId, purpose: 'interactive', conn }, 'channel.closed', payload, newId('ev'));
      else this.deliver({ channelId: conn.channelId, userId: conn.userId, purpose: 'transfer', conn }, 'channel.closed', payload, newId('ev'));
    } catch (err) {
      this.log.error('channel.closed could not be encoded', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** Authenticated channel.closed, then close, then ask the relay to drop the socket (same order as on the wire). */
  private closeWithReason(conn: HubConnection, reason: ChannelClosedReason, message?: string): void {
    if (conn.closed) return;
    this.sendClosed(conn, reason, message);
    this.detach(conn, reason, { closeChannel: true });
    try {
      conn.control.kick(reason);
    } catch (err) {
      this.log.warn('peer.kick failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private detach(conn: HubConnection, reason: ConnectionCloseReason, options: { readonly closeChannel: boolean }): void {
    if (!conn.finish(reason, this.log)) return;
    this.conns.delete(conn.id);
    // R11 (logins and logouts): the counterpart of admit()'s auth.connect, for every way a connection ends.
    this.audit.record({
      actor: this.actorOf(conn.userId),
      action: 'auth.disconnect',
      outcome: 'ok',
      target: conn.deviceId,
      detail: {
        ...(conn.mode === 'local' ? { via: LOCAL_CHANNEL_VIA } : {}),
        purpose: conn.purpose,
        mode: conn.mode,
        reason,
        durationMs: Math.max(0, this.clock.now() - conn.openedAt),
      },
    });
    if (conn.logical) {
      if (this.channelConn.get(conn.logical.id) === conn) {
        this.channelConn.delete(conn.logical.id);
        conn.logical.disconnectedAt = this.clock.now();
      }
    } else if (this.transferByChannel.get(conn.channelId) === conn) {
      this.transferByChannel.delete(conn.channelId);
    }
    if (options.closeChannel) {
      try {
        conn.channel.close();
      } catch {
        // Already closed.
      }
    }
    this.bus.emit('conn.closed', { conn, reason });
    if (!conn.logical) this.bus.emit('channel.discarded', { channelId: conn.channelId, userId: conn.userId, purpose: 'transfer' });
  }

  private discard(channel: LogicalChannel, purpose: ChannelPurpose): void {
    if (!this.channels.delete(channel.id)) return;
    const conn = this.channelConn.get(channel.id);
    if (conn) this.detach(conn, 'replaced', { closeChannel: true });
    this.channelConn.delete(channel.id);
    this.bus.emit('channel.discarded', { channelId: channel.id, userId: channel.userId, purpose });
  }

  private heartbeat(): void {
    const at = this.clock.now();
    for (const conn of this.conns.values()) {
      if (!conn.logical || !conn.isOpen) continue;
      this.deliver({ channelId: conn.logical.id, userId: conn.userId, purpose: 'interactive', conn }, 'presence.heartbeat', { at }, newId('hb'));
    }
  }

  private tick(): void {
    const now = this.clock.now();
    for (const conn of this.conns.values()) {
      if (conn.ackSince !== null && now - conn.ackSince >= this.timing.ackDelayMs) this.sendAck(conn);
    }
    for (const channel of [...this.channels.values()]) {
      if (channel.disconnectedAt !== null && now - channel.disconnectedAt >= this.timing.channelRetentionMs) this.discard(channel, 'interactive');
    }
  }

  /** Test / diagnostics view of a logical channel. */
  logicalChannel(channelId: string): LogicalChannel | null {
    return this.channels.get(channelId) ?? null;
  }
}
