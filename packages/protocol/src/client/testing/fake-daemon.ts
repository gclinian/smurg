// TEST ONLY. A daemon stand-in for the client SDK's tests, built on the real channel code (createMemoryTransportPair +
// daemonAccept) and the real codec. It is also the executable reference for the daemon side of the resume contract
// in ../outbox.ts: per logical channel a d→c seq space with a bounded outbox replayed after `seq > lastSeq`, c→d
// de-duplication by seq, unsequenced `channel.ack` (seq 0) both ways, resumed = false when the gap is gone.
// Not reachable from any entry point.
import { randomBytes, toBase64Url, toHex } from '../../bytes.ts';
import type { ChannelError } from '../../channel/errors.ts';
import { daemonAccept, type AdmitContext, type AdmitDecision } from '../../channel/handshake.ts';
import { verifyIdentityCnf } from '../../channel/identity-binding.ts';
import type { SecureChannel } from '../../channel/secure-channel.ts';
import { createMemoryTransportPair, type Transport } from '../../channel/transport.ts';
import { decodeClientHello, decodeEnvelope, encodeEnvelope, encodeVerdict } from '../../codec.ts';
import { SmurgError } from '../../errors.ts';
import { buildInviteUrl, deriveInviteKeys, generateInviteSecret, parseInviteUrl } from '../../invite.ts';
import { x25519KeyPair, type RawNoiseKeyPair } from '../../noise/suite.ts';
import type { Role } from '../../roles.ts';
import type { ChannelPurpose, ClientHello, VerdictRejectReason, Welcome } from '../../schema/handshake.ts';
import { isRequestType } from '../../schema/registry.ts';
import type { InviteTrust } from '../engine.ts';
import { parseFakeIdentityToken, type FakeConnEndpoint, type FakeConnInfo, type FakeHost } from './fake-relay.ts';

/** Not a channel frame type: marks "peer.kick" on the in-memory host socket. */
const KICK_MARKER = new Uint8Array([0xff, 0x4b]);

export const FAKE_WORKSPACE_ID = 'ws_client_test_0001';
export const FAKE_HOST_USER = 'dev:host';

export interface ReceivedEnvelope {
  readonly channelId: string | null;
  readonly userId: string;
  readonly type: string;
  readonly id: string;
  readonly seq: number;
  readonly payload: unknown;
}

export interface HandlerContext {
  readonly userId: string;
  readonly channelId: string | null;
  readonly conn: number;
}

export type FakeHandler = (payload: never, ctx: HandlerContext) => unknown;

interface LogicalChannel {
  readonly id: string;
  readonly userId: string;
  /** Last d→c seq assigned. */
  d2cSeq: number;
  readonly outbox: { seq: number; bytes: Uint8Array }[];
  /** Outbox entries up to this seq were discarded without an ack: a resume from below it is impossible. */
  droppedUpTo: number;
  /** Last c→d seq processed. */
  c2dLast: number;
  conn: ConnState | null;
}

interface ConnState {
  readonly info: FakeConnInfo;
  /** Host-side end of the relay tunnel: control actions go through it so they stay ordered behind frames. */
  readonly hostSide: Transport;
  readonly purpose: ChannelPurpose;
  channel: SecureChannel | null;
  logical: LogicalChannel | null;
  userId: string | null;
  transferSeq: number;
}

interface Admission {
  readonly logical: LogicalChannel | null;
  readonly resumed: boolean;
  readonly replayFrom: number;
  readonly userId: string;
}

interface InviteRecord {
  readonly inviteId: Uint8Array;
  readonly psk: Uint8Array;
  readonly role: Exclude<Role, 'host'>;
  usesLeft: number;
  readonly expiresAt: number;
}

/** The identity-token claims admit() needs. */
export interface IdentityClaims {
  readonly sub: string;
  readonly aud: string;
  /** The blinded commitment (identityCnf) the token was issued for. */
  readonly cnf: string;
}

export interface FakeDaemonOptions {
  workspaceId?: string;
  /**
   * Verifies an identity token SYNCHRONOUSLY (admit() may not await) and returns its claims, or null. Default: the
   * unsigned test tokens of FakeRelayApi. A real relay's EdDSA JWTs can be checked with node:crypto.verify against a
   * JWKS fetched beforehand.
   */
  verifyIdentity?: (token: string) => IdentityClaims | null;
  staticKey?: RawNoiseKeyPair;
  /** Answer every sequenced client message with channel.ack right away (default true). */
  autoAck?: boolean;
  now?: () => number;
}

export class FakeDaemon implements FakeHost {
  readonly workspaceId: string;
  readonly staticKey: RawNoiseKeyPair;
  readonly invites = new Map<string, InviteRecord>();
  readonly devices = new Map<string, { userId: string; revoked: boolean }>();
  readonly roles = new Map<string, Role>();
  readonly channels = new Map<string, LogicalChannel>();
  readonly conns = new Set<ConnState>();
  readonly received: ReceivedEnvelope[] = [];
  readonly handshakeFailures: ChannelError[] = [];
  readonly admissions: { mode: AdmitContext['mode']; userId: string | null; accepted: boolean; reason?: VerdictRejectReason }[] = [];
  /** Every ClientHello that decoded (msg3 payloads). */
  readonly hellos: ClientHello[] = [];
  /** `upTo` of every channel.ack the clients sent. */
  readonly acksReceived: number[] = [];
  /** c→d Envelopes dropped as duplicates (seq ≤ last processed). */
  duplicates = 0;
  /** Every client admission is refused with this reason (authenticated verdict). */
  verdictOverride: VerdictRejectReason | null = null;
  /** admit() throws: daemonAccept then sends an EMPTY rejection (the daemon's 'admit-failed'). */
  failAdmit = false;
  /** The next this-many HELLOs are refused before any crypto (a daemon over its handshake budget): generic ABORT. */
  refuseHandshakes = 0;
  /** Replay this many already-processed messages in front of the missing ones (tests client-side de-duplication). */
  replayOverlap = 0;
  autoAck: boolean;
  /** Keep the outbox although the client acknowledged it (so replayOverlap has something to replay). */
  ignoreClientAcks = false;
  handlers: Record<string, FakeHandler> = {};
  /** Runs right after an `.ok` went out (e.g. to stream download chunks right behind file.download.begin.ok). */
  afterReply: ((type: string, result: unknown, ctx: HandlerContext) => void) | null = null;
  private readonly kickedUsers = new Set<string>();
  private readonly pendingAdmissions = new Map<string, Admission>();
  private readonly now: () => number;
  private readonly verifyIdentity: (token: string) => IdentityClaims | null;
  private channelCounter = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: FakeDaemonOptions = {}) {
    this.workspaceId = options.workspaceId ?? FAKE_WORKSPACE_ID;
    this.staticKey = options.staticKey ?? x25519KeyPair();
    this.autoAck = options.autoAck ?? true;
    this.now = options.now ?? (() => Date.now());
    this.verifyIdentity = options.verifyIdentity ?? parseFakeIdentityToken;
    this.roles.set(FAKE_HOST_USER, 'host');
  }

  // ---- invites, devices, members

  /** A fresh invite (daemon stores inviteId + psk only) and what the link's fragment gives the client. */
  createInvite(options: { role?: Exclude<Role, 'host'>; uses?: number; ttlMs?: number; secret?: Uint8Array } = {}): {
    url: string;
    trust: InviteTrust;
    secret: Uint8Array;
  } {
    const secret = options.secret ?? generateInviteSecret();
    const { inviteId, psk } = deriveInviteKeys(secret);
    this.invites.set(toHex(inviteId), {
      inviteId,
      psk,
      role: options.role ?? 'editor',
      usesLeft: options.uses ?? 1,
      expiresAt: this.now() + (options.ttlMs ?? 60_000),
    });
    const url = buildInviteUrl('https://smurg.test', this.workspaceId, this.staticKey.publicKey, secret);
    const parsed = parseInviteUrl(url);
    return { url, secret, trust: { fingerprint: parsed.fingerprint, secret: parsed.secret } };
  }

  usesLeft(secret: Uint8Array): number | undefined {
    return this.invites.get(toHex(deriveInviteKeys(secret).inviteId))?.usesLeft;
  }

  /** Registers a device directly (as if it had joined earlier). */
  registerDevice(publicKey: Uint8Array, userId: string, role: Role = 'editor'): void {
    this.devices.set(toHex(publicKey), { userId, revoked: false });
    if (!this.roles.has(userId)) this.roles.set(userId, role);
  }

  revokeDevice(publicKey: Uint8Array): void {
    const device = this.devices.get(toHex(publicKey));
    if (device) device.revoked = true;
  }

  // ---- relay host side

  openConn(info: FakeConnInfo): FakeConnEndpoint {
    const pair = createMemoryTransportPair();
    const purpose: ChannelPurpose = info.kind === 'ws' ? 'interactive' : 'transfer';
    const state: ConnState = { info, hostSide: pair.daemon, purpose, channel: null, logical: null, userId: null, transferSeq: 0 };
    this.conns.add(state);
    pair.client.onMessage((frame) => {
      // The real host sends peer.kick on the same socket as its frames, so the relay acts on it in order.
      if (frame.length === 2 && frame[0] === KICK_MARKER[0] && frame[1] === KICK_MARKER[1]) info.kick('kicked');
      else info.send(frame);
    });
    daemonAccept(pair.daemon, {
      workspaceId: this.workspaceId,
      staticKey: this.staticKey,
      invites: () => [...this.invites.values()].map(({ inviteId, psk }) => ({ inviteId, psk })),
      allowHandshake: () => {
        if (this.refuseHandshakes <= 0) return true;
        this.refuseHandshakes--;
        return false;
      },
      admit: (ctx) => this.admit(ctx, info, purpose),
    }).then(
      (result) => this.onAccepted(state, result.channel),
      (error: ChannelError) => {
        this.handshakeFailures.push(error);
      },
    );
    return {
      receive: (frame) => pair.client.send(frame),
      close: () => {
        this.conns.delete(state);
        if (state.logical?.conn === state) state.logical.conn = null;
        pair.client.close();
      },
    };
  }

  private reject(reason: VerdictRejectReason, mode: AdmitContext['mode'], userId: string | null): AdmitDecision {
    this.admissions.push({ mode, userId, accepted: false, reason });
    return encodeVerdict({ ok: false, reason });
  }

  private admit(ctx: AdmitContext, info: FakeConnInfo, purpose: ChannelPurpose): AdmitDecision {
    if (this.failAdmit) throw new Error('admit failed on purpose');
    const decoded = decodeClientHello(ctx.helloPayload);
    if (!decoded.ok) return this.reject(decoded.reason === 'version' ? 'version' : 'identity-invalid', ctx.mode, null);
    const hello = decoded.hello;
    this.hellos.push(hello);
    const claims = this.verifyIdentity(hello.identityToken);
    // The token binds the relay's login to THIS device key through the blinded commitment (ARCHITECTURE §4.2).
    if (
      !claims ||
      claims.aud !== this.workspaceId ||
      claims.sub !== info.userId ||
      hello.purpose !== purpose ||
      !verifyIdentityCnf(claims.cnf, hello.cnfNonce, ctx.clientStaticKey)
    ) {
      return this.reject('identity-invalid', ctx.mode, claims?.sub ?? null);
    }
    const userId = claims.sub;
    if (this.verdictOverride) return this.reject(this.verdictOverride, ctx.mode, userId);
    if (this.kickedUsers.has(userId)) return this.reject('kicked', ctx.mode, userId);
    const deviceKey = toHex(ctx.clientStaticKey);
    const device = this.devices.get(deviceKey);
    if (device?.revoked) return this.reject('device-revoked', ctx.mode, userId);
    if (ctx.mode === 'invite') {
      const invite = ctx.inviteId ? this.invites.get(toHex(ctx.inviteId)) : undefined;
      if (!invite || this.now() > invite.expiresAt || invite.usesLeft <= 0) return this.reject('invite-invalid', ctx.mode, userId);
      if (device && device.userId !== userId) return this.reject('identity-invalid', ctx.mode, userId);
      invite.usesLeft--; // check and consume in one synchronous step
      this.devices.set(deviceKey, { userId, revoked: false });
      if (!this.roles.has(userId)) this.roles.set(userId, invite.role);
    } else {
      // There is no "device-unknown" reason on the wire; an unknown device is refused like a revoked one.
      if (!device) return this.reject('device-revoked', ctx.mode, userId);
      if (device.userId !== userId) return this.reject('identity-invalid', ctx.mode, userId);
    }

    let logical: LogicalChannel | null = null;
    let resumed = false;
    let replayFrom = 0;
    if (purpose === 'interactive') {
      const want = hello.resume;
      const existing = want ? this.channels.get(want.channelId) : undefined;
      if (want && existing && existing.userId === userId && want.lastSeq >= existing.droppedUpTo && want.lastSeq <= existing.d2cSeq) {
        logical = existing;
        resumed = true;
        replayFrom = want.lastSeq;
        // Everything up to lastSeq was processed: those outbox entries can go.
        this.trimOutbox(existing, want.lastSeq - this.replayOverlap);
      } else {
        logical = this.newChannel(userId);
      }
    }
    const channelId = logical?.id ?? `xfer_${++this.channelCounter}`;
    const welcome: Welcome = {
      channelId,
      resumed,
      member: this.memberOf(userId),
      workspace: {
        id: this.workspaceId,
        name: 'demo',
        hostUserId: FAKE_HOST_USER,
        hostName: 'Host',
        platform: 'darwin',
        isGitRepo: false,
      },
      settings: { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] },
      serverTime: this.now(),
    };
    this.pendingAdmissions.set(toHex(ctx.handshakeHash), { logical, resumed, replayFrom, userId });
    this.admissions.push({ mode: ctx.mode, userId, accepted: true });
    return encodeVerdict({ ok: true, welcome });
  }

  private memberOf(userId: string): Welcome['member'] {
    return {
      userId,
      displayName: userId.slice(userId.indexOf(':') + 1) || 'user',
      role: this.roles.get(userId) ?? 'viewer',
      color: '#3366cc',
      online: true,
      joinedAt: 1_700_000_000_000,
    };
  }

  private newChannel(userId: string): LogicalChannel {
    const id = `ch_${++this.channelCounter}_${toBase64Url(randomBytes(6))}`;
    const logical: LogicalChannel = { id, userId, d2cSeq: 0, outbox: [], droppedUpTo: 0, c2dLast: 0, conn: null };
    this.channels.set(id, logical);
    return logical;
  }

  private onAccepted(state: ConnState, channel: SecureChannel): void {
    const admission = this.pendingAdmissions.get(toHex(channel.handshakeHash));
    this.pendingAdmissions.delete(toHex(channel.handshakeHash));
    if (!admission || !this.conns.has(state)) {
      channel.close();
      return;
    }
    state.channel = channel;
    state.userId = admission.userId;
    channel.onMessage((bytes) => this.onClientMessage(state, bytes));
    channel.onClose(() => {
      if (state.logical?.conn === state) state.logical.conn = null;
    });
    const logical = admission.logical;
    if (!logical) return;
    const previous = logical.conn;
    logical.conn = state;
    state.logical = logical;
    if (previous && previous !== state) previous.channel?.close();
    if (admission.resumed) {
      const from = Math.max(0, admission.replayFrom - this.replayOverlap);
      for (const entry of logical.outbox) if (entry.seq > from) channel.send(entry.bytes);
    }
  }

  private onClientMessage(state: ConnState, bytes: Uint8Array): void {
    const decoded = decodeEnvelope(bytes, { from: 'client', channel: state.purpose });
    if (!decoded.ok) {
      if (decoded.id !== null) this.reply(state, 'error', decoded.error.toPayload(), decoded.id);
      return;
    }
    const envelope = decoded.envelope as { type: string; id: string; seq: number; payload: unknown };
    const logical = state.logical;
    if (logical && envelope.seq > 0) {
      if (envelope.seq <= logical.c2dLast) {
        this.duplicates++;
        return;
      }
      logical.c2dLast = envelope.seq;
      if (this.autoAck) this.sendAck(state, envelope.seq);
    }
    if (envelope.type === 'channel.ack') {
      this.acksReceived.push((envelope.payload as { upTo: number }).upTo);
      if (logical && !this.ignoreClientAcks) this.trimOutbox(logical, (envelope.payload as { upTo: number }).upTo);
      return;
    }
    this.received.push({
      channelId: logical?.id ?? null,
      userId: state.userId ?? '',
      type: envelope.type,
      id: envelope.id,
      seq: envelope.seq,
      payload: envelope.payload,
    });
    if (isRequestType(envelope.type)) void this.handle(state, envelope);
  }

  private async handle(state: ConnState, envelope: { type: string; id: string; payload: unknown }): Promise<void> {
    const handler = this.handlers[envelope.type];
    if (!handler) {
      this.reply(state, 'error', { code: 'not_found', message: `no handler for ${envelope.type}` }, envelope.id);
      return;
    }
    const ctx: HandlerContext = { userId: state.userId ?? '', channelId: state.logical?.id ?? null, conn: state.info.conn };
    try {
      const result = await handler(envelope.payload as never, ctx);
      this.reply(state, `${envelope.type}.ok`, result, envelope.id);
      this.afterReply?.(envelope.type, result, ctx);
    } catch (error) {
      this.reply(state, 'error', SmurgError.wrap(error).toPayload(), envelope.id);
    }
  }

  /** Answers on the logical channel (queued for replay) or, on the transfer socket, on the connection. */
  private reply(state: ConnState, type: string, payload: unknown, id: string): void {
    if (state.logical) this.sendOn(state.logical, type, payload, id);
    else this.sendOnConn(state, type, payload, id);
  }

  private sendAck(state: ConnState, upTo: number): void {
    const bytes = encodeEnvelope({ type: 'channel.ack', id: this.freshId(), seq: 0, payload: { upTo } }, { from: 'daemon', channel: 'interactive' });
    if (state.channel && !state.channel.isClosed) state.channel.send(bytes);
  }

  private trimOutbox(logical: LogicalChannel, upTo: number): void {
    while (logical.outbox.length > 0 && (logical.outbox[0] as { seq: number }).seq <= upTo) logical.outbox.shift();
  }

  private freshId(): string {
    return `d.${toBase64Url(randomBytes(6))}`;
  }

  // ---- sending events

  /** Sequenced send on a logical channel: kept in the outbox until acknowledged, sent now if connected. */
  sendOn(logical: LogicalChannel, type: string, payload: unknown, id = this.freshId()): number {
    const seq = ++logical.d2cSeq;
    const bytes = encodeEnvelope({ type, id, seq, payload } as never, { from: 'daemon', channel: 'interactive' });
    logical.outbox.push({ seq, bytes });
    const channel = logical.conn?.channel;
    if (channel && !channel.isClosed) channel.send(bytes);
    return seq;
  }

  sendOnConn(state: ConnState, type: string, payload: unknown, id = this.freshId()): void {
    const bytes = encodeEnvelope({ type, id, seq: ++state.transferSeq, payload } as never, { from: 'daemon', channel: state.purpose });
    if (state.channel && !state.channel.isClosed) state.channel.send(bytes);
  }

  /** An event to every logical channel of `userId` (or everyone), connected or not (then it waits for the resume). */
  broadcast(type: string, payload: unknown, userId?: string): void {
    for (const logical of this.channels.values()) if (userId === undefined || logical.userId === userId) this.sendOn(logical, type, payload);
  }

  /** An event on every live transfer connection. */
  broadcastTransfer(type: string, payload: unknown): void {
    for (const state of this.conns) if (state.purpose === 'transfer' && state.channel) this.sendOnConn(state, type, payload);
  }

  startHeartbeat(intervalMs = 3_000): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      for (const logical of this.channels.values()) if (logical.conn?.channel) this.sendOn(logical, 'presence.heartbeat', { at: this.now() });
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  // ---- admin actions and failure injection

  /** R2 kick: revoke the member's devices, send channel.closed{kicked}, then ask the relay to kick the sockets. */
  kick(userId: string, options: { viaRelay?: boolean } = {}): void {
    this.kickedUsers.add(userId);
    for (const device of this.devices.values()) if (device.userId === userId) device.revoked = true;
    for (const logical of this.channels.values()) {
      if (logical.userId !== userId) continue;
      this.sendOn(logical, 'channel.closed', { reason: 'kicked' });
    }
    if (options.viaRelay !== false) this.relayKick(userId);
  }

  /** channel.closed with any reason to every channel of `userId`, optionally followed by peer.kick (in order). */
  closeChannels(userId: string, reason: 'kicked' | 'revoked' | 'stopped' | 'role-changed' | 'protocol-error', options: { kick?: boolean } = {}): void {
    for (const logical of this.channels.values()) if (logical.userId === userId) this.sendOn(logical, 'channel.closed', { reason });
    if (options.kick) this.relayKick(userId);
  }

  private relayKick(userId: string): void {
    for (const state of [...this.conns]) if (state.userId === userId) state.hostSide.send(KICK_MARKER);
  }

  setRole(userId: string, role: Role): void {
    this.roles.set(userId, role);
  }

  /** The daemon forgets the outbox (as if it overflowed): a later resume gets resumed = false. */
  dropOutbox(): void {
    for (const logical of this.channels.values()) {
      logical.droppedUpTo = logical.d2cSeq;
      logical.outbox.length = 0;
    }
  }

  /** A daemon restart: every logical channel is gone (keys, invites and devices are on disk and stay). */
  restart(): void {
    this.channels.clear();
    for (const state of this.conns) state.channel?.close();
  }

  /** Received envelopes of one type. */
  receivedOf(type: string): ReceivedEnvelope[] {
    return this.received.filter((r) => r.type === type);
  }

  /** The live logical channel of a user (latest). */
  channelOf(userId: string): LogicalChannel | undefined {
    return [...this.channels.values()].filter((c) => c.userId === userId).at(-1);
  }
}
