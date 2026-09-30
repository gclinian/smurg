// The handshake responder (ARCHITECTURE §4, §4.2): one Noise session per relay connection id and socket purpose.
// Per connection: idle → (first frame) handshaking → open (handed to the hub) | idle again after a failure, and
// dead (frames dropped) after MAX_FAILED_HANDSHAKES_PER_CONN failures (the relay is asked to drop it) or after the
// channel ended. A connection that stays idle or dead for handshakeDeadlineMs + idleConnGraceMs is dropped too, so
// sockets that never handshake cannot hold the relay's per-account / per-workspace socket slots.
//
// Every HELLO passes the handshake budget before any crypto (security review F4: one relay account must not be able
// to starve everyone else): per relay user a token bucket and a cap on handshakes in flight; then the global bucket,
// with a reserve that only members holding a registered device can draw from once the global bucket is empty. The
// user id is the relay's claim, which is enough for fairness (it is never used for a security decision here).
import { MAX_RELAY_FRAME, daemonAccept, type ChannelError, type ChannelPurpose, type NoiseKeyPair, type NoiseSuite } from '@smurg/protocol';
import { PEER_KICK_REASON_IDLE, type RelayPeerOpenFrame } from '@smurg/protocol/relay';
import type { LimitsConfig, TimingConfig } from '../core/config.ts';
import type { HubImpl } from '../core/hub.ts';
import type { AuditLog, HandshakeStats, InviteService, MemberDirectory } from '../core/interfaces.ts';
import type { Clock } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { admitConnection, type AdmissionDeps, type Admitted, type RelayPeer } from './admission.ts';
import { ConnTransport } from './conn-transport.ts';
import { TokenBucket } from './rate-limit.ts';

/** What the channel server needs from a relay link. */
export interface LinkPort {
  sendFrame(conn: number, payload: Uint8Array): boolean;
  kick(conn: number, reason: string): void;
  readonly bufferedAmount: number;
}

interface ConnState {
  readonly purpose: ChannelPurpose;
  readonly conn: number;
  readonly peer: RelayPeer;
  phase: 'idle' | 'handshaking' | 'open' | 'dead';
  transport: ConnTransport | null;
  failures: number;
  admitted: Admitted | null;
  hubConnId: string | null;
  /** peer.kick was sent for this connection id. */
  kicked: boolean;
  /** Drops the connection when it is still idle / dead (never admitted, or its channel ended) at expiry. */
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Relay users whose handshake bucket has been unused this long are forgotten (a full refill takes a minute). */
const USER_BUCKET_IDLE_MS = 60_000;
const USER_BUCKET_PRUNE_AT = 512;

export interface ChannelServerOptions {
  readonly workspaceId: string;
  readonly staticKey: NoiseKeyPair;
  readonly suite: NoiseSuite;
  readonly invites: InviteService;
  readonly members: MemberDirectory;
  readonly hub: HubImpl;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly log: Logger;
  readonly timing: TimingConfig;
  readonly limits: LimitsConfig;
  readonly admission: Omit<AdmissionDeps, 'hub' | 'invites' | 'audit' | 'clock' | 'log' | 'limits'>;
}

export class ChannelServer {
  private readonly options: ChannelServerOptions;
  private readonly links = new Map<ChannelPurpose, LinkPort>();
  private readonly conns = new Map<string, ConnState>();
  /** Global budget, shared by everyone. */
  private readonly bucket: TokenBucket;
  /** Reserve that only members with a registered, unrevoked device may use once `bucket` is empty. */
  private readonly memberBucket: TokenBucket;
  private readonly userBuckets = new Map<string, { readonly bucket: TokenBucket; lastUsed: number }>();
  /** Handshakes in flight: per relay user, and per class (members with a device / everyone else). */
  private readonly pendingByUser = new Map<string, number>();
  private pendingMembers = 0;
  private pendingStrangers = 0;
  private stopped = false;
  /** Counters for status and tests. */
  readonly stats: { -readonly [K in keyof HandshakeStats]: number } = { handshakes: 0, accepted: 0, failed: 0, refusedByRateLimit: 0, kickedForFailures: 0, kickedIdle: 0 };

  constructor(options: ChannelServerOptions) {
    this.options = options;
    this.bucket = new TokenBucket({ perMinute: options.limits.handshakesPerMinute, clock: options.clock });
    this.memberBucket = new TokenBucket({ perMinute: options.limits.memberHandshakesPerMinute, clock: options.clock });
  }

  bindLink(purpose: ChannelPurpose, link: LinkPort): void {
    this.links.set(purpose, link);
  }

  /** relay → host peer.open: a logged-in client opened a socket. */
  peerOpen(purpose: ChannelPurpose, frame: RelayPeerOpenFrame): void {
    const key = `${purpose}:${frame.conn}`;
    this.dropState(key, 'replaced');
    const state: ConnState = {
      purpose,
      conn: frame.conn,
      peer: { userId: frame.userId, displayName: frame.displayName, ...(frame.avatarUrl === undefined ? {} : { avatarUrl: frame.avatarUrl }) },
      phase: 'idle',
      transport: null,
      failures: 0,
      admitted: null,
      hubConnId: null,
      kicked: false,
      idleTimer: undefined,
    };
    this.conns.set(key, state);
    this.armIdle(state);
  }

  /** relay → host peer.close. */
  peerClose(purpose: ChannelPurpose, conn: number): void {
    this.dropState(`${purpose}:${conn}`, 'disconnected');
  }

  /** The host socket of `purpose` went away: every connection id on it is void. */
  linkDown(purpose: ChannelPurpose): void {
    for (const [key, state] of [...this.conns]) if (state.purpose === purpose) this.dropState(key, 'relay-down');
    this.options.hub.dropPurpose(purpose, 'relay-down');
  }

  frame(purpose: ChannelPurpose, conn: number, payload: Uint8Array): void {
    const state = this.conns.get(`${purpose}:${conn}`);
    if (!state || state.phase === 'dead' || this.stopped) return;
    if (state.phase === 'idle') this.startHandshake(state);
    state.transport?.deliver(payload);
  }

  stop(): void {
    this.stopped = true;
    for (const key of [...this.conns.keys()]) this.dropState(key, 'relay-down');
    this.userBuckets.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------

  private startHandshake(state: ConnState): void {
    const link = this.links.get(state.purpose);
    if (!link) return;
    this.clearIdle(state);
    state.phase = 'handshaking';
    state.admitted = null;
    const transport = new ConnTransport(
      (frame) => {
        link.sendFrame(state.conn, frame);
      },
      () => {},
      4 * MAX_RELAY_FRAME,
    );
    state.transport = transport;
    const userId = state.peer.userId;
    const member = this.hasRegisteredDevice(userId);
    this.countPending(userId, member, +1);
    this.stats.handshakes++;
    const o = this.options;
    const deps: AdmissionDeps = { ...o.admission, hub: o.hub, invites: o.invites, audit: o.audit, clock: o.clock, log: o.log, limits: o.limits };
    daemonAccept(transport, {
      workspaceId: o.workspaceId,
      staticKey: o.staticKey,
      suite: o.suite,
      deadlineMs: o.timing.handshakeDeadlineMs,
      invites: () => o.invites.handshakeKeys(),
      allowHandshake: () => this.allowHandshake(userId, member),
      admit: (ctx) => {
        const result = admitConnection(ctx, state.purpose, state.peer, deps);
        state.admitted = result.admitted;
        return result.decision;
      },
    }).then(
      (result) => {
        this.countPending(userId, member, -1);
        this.onAccepted(state, transport, result.channel);
      },
      (err: unknown) => {
        this.countPending(userId, member, -1);
        this.onFailed(state, transport, err as ChannelError);
      },
    );
  }

  /** A member with a registered, unrevoked device: may use the member reserve of the handshake budget. */
  private hasRegisteredDevice(userId: string): boolean {
    const members = this.options.members;
    return members.roleOf(userId) !== null && members.devicesOf(userId).some((device) => !device.revoked);
  }

  private countPending(userId: string, member: boolean, delta: 1 | -1): void {
    const next = (this.pendingByUser.get(userId) ?? 0) + delta;
    if (next <= 0) this.pendingByUser.delete(userId);
    else this.pendingByUser.set(userId, next);
    if (member) this.pendingMembers += delta;
    else this.pendingStrangers += delta;
  }

  private userBucket(userId: string): TokenBucket {
    const now = this.options.clock.now();
    let entry = this.userBuckets.get(userId);
    if (!entry) {
      if (this.userBuckets.size >= USER_BUCKET_PRUNE_AT) {
        for (const [id, item] of this.userBuckets) if (now - item.lastUsed > USER_BUCKET_IDLE_MS) this.userBuckets.delete(id);
      }
      entry = { bucket: new TokenBucket({ perMinute: this.options.limits.handshakesPerUserPerMinute, clock: this.options.clock }), lastUsed: now };
      this.userBuckets.set(userId, entry);
    }
    entry.lastUsed = now;
    return entry.bucket;
  }

  private allowHandshake(userId: string, member: boolean): boolean {
    const limits = this.options.limits;
    // The pending counters already count the handshake asking.
    const tooManyInFlight =
      (this.pendingByUser.get(userId) ?? 0) > limits.maxPendingHandshakesPerUser ||
      (member ? this.pendingMembers : this.pendingStrangers) > limits.maxPendingHandshakes;
    const allowed = !tooManyInFlight && this.userBucket(userId).take() && (this.bucket.take() || (member && this.memberBucket.take()));
    if (!allowed) this.stats.refusedByRateLimit++;
    return allowed;
  }

  private armIdle(state: ConnState): void {
    this.clearIdle(state);
    if (this.stopped) return;
    const timer = setTimeout(() => {
      state.idleTimer = undefined;
      if (this.stopped || this.conns.get(`${state.purpose}:${state.conn}`) !== state || state.kicked) return;
      if (state.phase !== 'idle' && state.phase !== 'dead') return;
      this.stats.kickedIdle++;
      this.options.log.debug('dropping an idle relay connection', { purpose: state.purpose, phase: state.phase });
      this.kick(state, PEER_KICK_REASON_IDLE);
    }, this.options.timing.handshakeDeadlineMs + this.options.timing.idleConnGraceMs);
    timer.unref?.();
    state.idleTimer = timer;
  }

  private clearIdle(state: ConnState): void {
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private onAccepted(state: ConnState, transport: ConnTransport, channel: Parameters<HubImpl['attach']>[0]['channel']): void {
    const admitted = state.admitted;
    const current = this.conns.get(`${state.purpose}:${state.conn}`);
    if (current !== state || state.transport !== transport || !admitted || this.stopped) {
      channel.close();
      return;
    }
    // Kicked or revoked between admit() and now: the verdict already went out, so drop the socket at the relay.
    const device = this.options.members.device(admitted.deviceId);
    if (!device || device.revoked || this.options.members.roleOf(admitted.userId) === null) {
      channel.close();
      this.kick(state, 'revoked');
      return;
    }
    const link = this.links.get(state.purpose);
    const hubConn = this.options.hub.attach({
      channel,
      admission: admitted.hub,
      relayConn: state.conn,
      userId: admitted.userId,
      deviceId: admitted.deviceId,
      clientKind: admitted.hello.clientKind,
      deviceName: admitted.hello.deviceName,
      mode: admitted.mode,
      control: {
        kick: (reason) => this.kick(state, reason),
        bufferedAmount: () => link?.bufferedAmount ?? 0,
      },
    });
    if (!hubConn) {
      this.kick(state, 'refused');
      return;
    }
    this.stats.accepted++;
    this.clearIdle(state);
    state.phase = 'open';
    state.hubConnId = hubConn.id;
    state.failures = 0;
    hubConn.onClose(() => {
      // The channel ended (kick, integrity failure, stop): nothing more on this connection id. A kick already asked
      // the relay to drop it; otherwise an honest client notices and reconnects on a fresh socket (the relay then
      // sends peer.close), and a socket still here after the idle grace is dropped.
      if (this.conns.get(`${state.purpose}:${state.conn}`) === state) {
        state.phase = 'dead';
        state.transport = null;
        if (!state.kicked) this.armIdle(state);
      }
    });
  }

  private onFailed(state: ConnState, transport: ConnTransport, err: ChannelError): void {
    if (state.transport === transport) state.transport = null;
    this.stats.failed++;
    const current = this.conns.get(`${state.purpose}:${state.conn}`);
    if (current !== state || state.phase === 'dead') return;
    state.failures++;
    this.options.log.debug('handshake failed', { purpose: state.purpose, code: err?.code ?? 'unknown', stage: err?.stage ?? null });
    if (state.failures >= this.options.limits.maxFailedHandshakesPerConn) {
      this.stats.kickedForFailures++;
      this.options.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'auth.rejected',
        outcome: 'denied',
        target: state.peer.userId,
        detail: { reason: 'too-many-failed-handshakes', purpose: state.purpose, failures: state.failures },
      });
      this.kick(state, 'too many failed handshakes');
      return;
    }
    state.phase = 'idle';
    state.admitted = null;
    this.armIdle(state);
  }

  private kick(state: ConnState, reason: string): void {
    this.clearIdle(state);
    state.phase = 'dead';
    state.kicked = true;
    state.transport?.finish({ reason });
    state.transport = null;
    this.links.get(state.purpose)?.kick(state.conn, reason);
  }

  private dropState(key: string, reason: 'disconnected' | 'replaced' | 'relay-down'): void {
    const state = this.conns.get(key);
    if (!state) return;
    this.conns.delete(key);
    this.clearIdle(state);
    state.phase = 'dead';
    state.transport?.finish({ reason });
    state.transport = null;
    if (state.hubConnId !== null) this.options.hub.peerGone(state.hubConnId, reason === 'relay-down' ? 'relay-down' : 'disconnected');
  }
}
