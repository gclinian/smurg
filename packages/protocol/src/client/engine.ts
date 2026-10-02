// The connection engine behind Connection (interactive) and TransferConnection (transfer): relay socket, handshake,
// reconnect policy, request/response correlation, events and, on the interactive channel, the seq/outbox/ack/resume
// contract of outbox.ts. The public classes only add compile-time typing per socket.
//
// Reconnect policy (ARCHITECTURE §4; relay.md §1.2):
//  - relay socket lost (close, pong watchdog, bye other than 4003) → relay-unreachable, retry with jittered backoff;
//  - relay says host offline → host-offline, keep the socket, new handshake on `host.online`;
//  - daemon silent for CLIENT_OFFLINE_THRESHOLD_MS → host-offline (R1), back online on the next message, start over
//    after silenceReconnectMs;
//  - NEVER again after key mismatch, kick (channel.closed{kicked} or bye 4003), revocation, or an authenticated
//    rejection other than `busy`.
import { CLIENT_OFFLINE_THRESHOLD_MS, HANDSHAKE_DEADLINE_MS, PROTOCOL_VERSION } from '../constants.ts';
import { equalBytes, randomBytes, toBase64Url } from '../bytes.ts';
import { isChannelError } from '../channel/errors.ts';
import { clientConnect, type ClientConnectResult, type ClientTrust } from '../channel/handshake.ts';
import { generateCnfNonce, identityCnf } from '../channel/identity-binding.ts';
import type { ChannelCloseEvent, SecureChannel } from '../channel/secure-channel.ts';
import { decodeEnvelope, decodeVerdictReason, decodeWelcome, encodeClientHello, encodeEnvelope } from '../codec.ts';
import { SmurgError, type ErrorPayload } from '../errors.ts';
import { daemonKeyFingerprint, type HandshakeMode } from '../invite.ts';
import type { NoiseKeyPair, NoiseSuite } from '../noise/suite.ts';
import { PEER_KICK_REASON_IDLE, RELAY_CLOSE_CODES } from '../relay/close-codes.ts';
import { isWorkspaceId, wsClientUrl, xferClientUrl } from '../relay/routes.ts';
import type { ChannelPurpose, Welcome } from '../schema/handshake.ts';
import { getMessageSpec, isRequestType, parseWireType } from '../schema/registry.ts';
import { backoffDelay, resolveBackoff, type BackoffOptions } from './backoff.ts';
import { ClientRequestError, isRelayApiError } from './errors.ts';
import type { ChannelClosedReason, ClientKind, EventMeta, NotifyOptions, RequestOptions } from './message-types.ts';
import { ReliableState, type OutboxEntry } from './outbox.ts';
import type { ConnectionRelay } from './relay-api.ts';
import { RelaySocket, type RelaySocketFailure } from './relay-socket.ts';
import {
  isTerminalState,
  type ConnectionState,
  type HostOfflineReason,
  type RelayUnreachableCause,
  type RetryCause,
} from './state.ts';
import { isResumeState, type DeviceKeyProvider, type PinStore, type ResumeStore } from './storage.ts';

/** `k` and `s` of an invite fragment (parseInviteFragment / parseInviteUrl). */
export interface InviteTrust {
  readonly fingerprint: Uint8Array;
  readonly secret: Uint8Array;
}

/** Observations for logs. Never carries payloads, tokens or keys. */
export type ConnectionDiagnostic =
  | { readonly kind: 'invalid-envelope'; readonly reason: string; readonly type: string | null }
  | { readonly kind: 'listener-error'; readonly type: string; readonly error: unknown }
  | { readonly kind: 'invalid-relay-text'; readonly detail: string }
  | { readonly kind: 'resume-store-error'; readonly error: unknown }
  | { readonly kind: 'handshake-failed'; readonly code: string; readonly stage: number | undefined }
  | { readonly kind: 'channel-error'; readonly code: string }
  | { readonly kind: 'uncorrelated-response'; readonly type: string };

export interface CommonConnectionOptions {
  /** RelayApi (or a test fake): identity tokens and authenticated WebSockets. */
  relay: ConnectionRelay;
  workspaceId: string;
  deviceKeys: DeviceKeyProvider;
  pins: PinStore;
  /**
   * From the invite link's fragment. Used when no daemon key is pinned yet (first contact), and once as a fallback
   * when the daemon refuses this device before it was ever admitted, if the invite names the pinned daemon key.
   */
  invite?: InviteTrust | null;
  /**
   * Use the invite even if a key is pinned. The daemon key it verifies REPLACES a different pin, so pass this only
   * when the person chose the invite link after being told the host's key changed (key-mismatch).
   */
  preferInvite?: boolean;
  clientKind: ClientKind;
  /** Shown in the host's device list, e.g. `Chrome (macOS)`. */
  deviceName: string;
  /** Noise suite: nobleSuite by default (browser); the CLI passes nodeCryptoSuite from @smurg/protocol/node. */
  suite?: NoiseSuite;
  requestTimeoutMs?: number;
  backoff?: BackoffOptions;
  handshakeDeadlineMs?: number;
  /** Invite mode only: consecutive generic ABORTs before giving up with rejected('aborted'). Default 3. Device mode
   *  never gives up on an ABORT (unauthenticated, and for a known device it only means "busy"); it retries with backoff. */
  maxAbortedHandshakes?: number;
  now?: () => number;
  random?: () => number;
  onDiagnostic?: (diagnostic: ConnectionDiagnostic) => void;
}

export interface EngineOptions extends CommonConnectionOptions {
  purpose: ChannelPurpose;
  resumeStore?: ResumeStore | null;
  maxOutboxBytes?: number;
  /** null disables the silence detector (the transfer channel has no heartbeat). */
  silenceThresholdMs?: number | null;
  silenceReconnectMs?: number;
}

interface PendingRequest {
  readonly id: string;
  readonly entry: OutboxEntry | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup: () => void;
}

type Listener = (payload: unknown, meta: EventMeta) => void;
type WelcomeListener = (welcome: Welcome, info: { readonly resumed: boolean }) => void;
type HandshakeRun = { readonly socket: RelaySocket; readonly abort: AbortController };
type TrustChoice = { readonly mode: HandshakeMode; readonly trust: ClientTrust };

const TICK_MS = 250;
/** Acknowledge daemon messages at the latest this long after the first unacknowledged one… */
const ACK_DELAY_MS = 250;
/** …or after this many. */
const ACK_EVERY = 32;
const RESUME_SAVE_INTERVAL_MS = 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTBOX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SILENCE_RECONNECT_MS = 20_000;
const DEFAULT_MAX_ABORTED = 3;

export class ChannelEngine {
  private readonly purpose: ChannelPurpose;
  private readonly workspaceId: string;
  private readonly relay: ConnectionRelay;
  private readonly deviceKeys: DeviceKeyProvider;
  private readonly pins: PinStore;
  private readonly invite: InviteTrust | null;
  private readonly clientKind: ClientKind;
  private readonly deviceName: string;
  private readonly suite: NoiseSuite | undefined;
  private readonly requestTimeoutMs: number;
  private readonly backoff: Required<BackoffOptions>;
  private readonly handshakeDeadlineMs: number;
  private readonly maxAborted: number;
  private readonly silenceThresholdMs: number | null;
  private readonly silenceReconnectMs: number;
  private readonly resumeStore: ResumeStore | null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onDiagnostic: ((diagnostic: ConnectionDiagnostic) => void) | undefined;
  private readonly reliable: ReliableState | null;

  private state: ConnectionState = { kind: 'idle' };
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private started = false;
  private socket: RelaySocket | null = null;
  private channel: SecureChannel | null = null;
  private handshake: HandshakeRun | null = null;
  /** What the relay last said about the host on the current socket. */
  private relayHostOnline = false;
  /** Set while the channel drains before a relay-announced ending is acted on (see drainThen). */
  private afterDrain: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  /** Consecutive failed attempts: the backoff exponent. Reset when online. */
  private failures = 0;
  private abortedInARow = 0;
  private forceInvite: boolean;
  /** Admitted at least once: from then on the invite is spent and only the pin counts. */
  private admittedOnce = false;
  /** The invite's fingerprint equals fingerprint(pinned key) (set when device mode is chosen). */
  private inviteMatchesPin = false;
  private lastDaemonAt = 0;
  /** The last authenticated channel.closed reason on the current socket (explains a following bye 4003). */
  private daemonClosed: ChannelClosedReason | null = null;
  private online: { welcome: Welcome; resumed: boolean } | null = null;
  private transferSeq = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly welcomeListeners = new Set<WelcomeListener>();
  private readonly idPrefix = toBase64Url(randomBytes(6));
  private idCounter = 0;
  private unacked = 0;
  private ackSince: number | null = null;
  private resumeDirty = false;
  private lastResumeSaveAt = 0;

  constructor(options: EngineOptions) {
    if (options.purpose !== 'interactive' && options.purpose !== 'transfer') throw new TypeError('unknown channel purpose');
    if (!isWorkspaceId(options.workspaceId)) throw new TypeError('invalid workspace id');
    if (!options.relay || !(options.relay.origin instanceof URL)) throw new TypeError('relay is required');
    if (!options.deviceKeys || typeof options.deviceKeys.getKeyPair !== 'function') throw new TypeError('deviceKeys is required');
    if (!options.pins || typeof options.pins.get !== 'function' || typeof options.pins.pin !== 'function') {
      throw new TypeError('pins is required');
    }
    const invite = options.invite ?? null;
    if (invite !== null) {
      if (!(invite.fingerprint instanceof Uint8Array) || invite.fingerprint.length !== 32) throw new TypeError('invite fingerprint must be 32 bytes');
      if (!(invite.secret instanceof Uint8Array) || invite.secret.length !== 32) throw new TypeError('invite secret must be 32 bytes');
    }
    // Validate clientKind / deviceName now, not at the first handshake.
    encodeClientHello({
      protocolVersion: PROTOCOL_VERSION,
      purpose: options.purpose,
      identityToken: 'x.y.z',
      cnfNonce: new Uint8Array(32),
      clientKind: options.clientKind,
      deviceName: options.deviceName,
    });
    const positive = (value: number | undefined, fallback: number, what: string, allowZero = false): number => {
      const v = value ?? fallback;
      if (!(Number.isFinite(v) && (allowZero ? v >= 0 : v > 0))) throw new RangeError(`${what} must be a positive number`);
      return v;
    };
    this.purpose = options.purpose;
    this.workspaceId = options.workspaceId;
    this.relay = options.relay;
    this.deviceKeys = options.deviceKeys;
    this.pins = options.pins;
    this.invite = invite === null ? null : { fingerprint: invite.fingerprint.slice(), secret: invite.secret.slice() };
    this.forceInvite = options.preferInvite === true && invite !== null;
    this.clientKind = options.clientKind;
    this.deviceName = options.deviceName;
    this.suite = options.suite;
    this.requestTimeoutMs = positive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs', true);
    this.backoff = resolveBackoff(options.backoff);
    this.handshakeDeadlineMs = positive(options.handshakeDeadlineMs, HANDSHAKE_DEADLINE_MS, 'handshakeDeadlineMs');
    this.maxAborted = Math.max(1, Math.floor(positive(options.maxAbortedHandshakes, DEFAULT_MAX_ABORTED, 'maxAbortedHandshakes')));
    this.silenceThresholdMs =
      options.silenceThresholdMs === null ? null : positive(options.silenceThresholdMs, CLIENT_OFFLINE_THRESHOLD_MS, 'silenceThresholdMs');
    this.silenceReconnectMs = positive(options.silenceReconnectMs, DEFAULT_SILENCE_RECONNECT_MS, 'silenceReconnectMs');
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.onDiagnostic = options.onDiagnostic;
    const interactive = options.purpose === 'interactive';
    this.resumeStore = interactive ? (options.resumeStore ?? null) : null;
    this.reliable = interactive ? new ReliableState(Math.floor(positive(options.maxOutboxBytes, DEFAULT_MAX_OUTBOX_BYTES, 'maxOutboxBytes'))) : null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public surface (wrapped by the typed facades)
  // ---------------------------------------------------------------------------------------------------------------

  getState(): ConnectionState {
    return this.state;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  get welcome(): Welcome | null {
    return this.online?.welcome ?? null;
  }

  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  start(): void {
    if (this.started || isTerminalState(this.state)) return;
    this.started = true;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    (this.tickTimer as { unref?: () => void }).unref?.();
    void this.boot();
  }

  close(): void {
    this.enterTerminal({ kind: 'closed', reason: 'local' });
  }

  onWelcome(listener: WelcomeListener): () => void {
    this.welcomeListeners.add(listener);
    return () => {
      this.welcomeListeners.delete(listener);
    };
  }

  on(type: string, listener: Listener): () => void {
    const spec = getMessageSpec(type);
    if (!spec || spec.dir === 'c2d' || type === 'channel.ack') throw new TypeError(`${type} is not an event`);
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  request(type: string, payload: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (isTerminalState(this.state)) return Promise.reject(new ClientRequestError('closed'));
    if (!isRequestType(type)) {
      return Promise.reject(new SmurgError('bad_request', `${type} is not a request type`, { reason: 'unknown-type' }));
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!(Number.isFinite(timeoutMs) && timeoutMs >= 0)) return Promise.reject(new RangeError('timeoutMs must be >= 0'));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new ClientRequestError('cancelled'));
    const id = this.nextId();
    const encode = this.encoder(type, id, payload);
    return new Promise<unknown>((resolve, reject) => {
      let entry: OutboxEntry | null = null;
      try {
        if (this.reliable) {
          entry = this.reliable.enqueue({ id, type, request: true, encode });
        } else {
          this.sendUnsequenced(encode);
        }
      } catch (error) {
        reject(asRequestError(error));
        return;
      }
      const pending: PendingRequest = { id, entry, resolve, reject, timer: undefined, cleanup: () => {} };
      // Transmitted (transfer requests are sent at once): the daemon may have it, so the outcome is unknown.
      const sent = (): boolean => (entry ? entry.sent : true);
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => this.failRequest(id, new ClientRequestError('timeout', undefined, { sent: sent() })), timeoutMs);
      }
      if (signal) {
        const onAbort = (): void => {
          this.failRequest(id, new ClientRequestError('cancelled', undefined, { sent: sent() }));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, pending);
      if (this.reliable) this.flushOutbox();
    });
  }

  /** One-way message. Returns false when it was dropped (disconnected with `whenDisconnected: 'drop'`, or transfer). */
  notify(type: string, payload: unknown, options: NotifyOptions = {}): boolean {
    if (isTerminalState(this.state)) throw new ClientRequestError('closed');
    const spec = getMessageSpec(type);
    if (!spec || spec.result !== null || spec.dir === 'd2c' || type === 'channel.ack') {
      throw new SmurgError('bad_request', `${type} is not a one-way client message`, { reason: 'unknown-type' });
    }
    const id = this.nextId();
    const encode = this.encoder(type, id, payload);
    if (!this.reliable) {
      if (!this.channel || this.state.kind !== 'online') {
        encode(0); // still validate: an invalid payload is a bug, not a connectivity problem
        return false;
      }
      try {
        this.sendUnsequenced(encode);
      } catch (error) {
        throw asRequestError(error);
      }
      return true;
    }
    if (!this.channel && options.whenDisconnected === 'drop') {
      encode(0);
      return false;
    }
    this.reliable.enqueue({ id, type, request: false, encode });
    this.flushOutbox();
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------------

  private async boot(): Promise<void> {
    if (this.reliable && this.resumeStore) {
      try {
        const saved = await this.resumeStore.load(this.workspaceId);
        if (saved !== null && isResumeState(saved)) this.reliable.restore(saved);
      } catch (error) {
        this.diag({ kind: 'resume-store-error', error });
      }
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (isTerminalState(this.state)) return;
    this.clearRetry();
    this.setState({ kind: 'connecting', attempt: this.failures + 1, retryAt: null, cause: null });
    if (isTerminalState(this.state) || this.socket) return;
    // A channel.closed seen on an earlier socket explains nothing about this one.
    this.daemonClosed = null;
    this.relayHostOnline = false;
    const url = this.purpose === 'interactive' ? wsClientUrl(this.relay.origin, this.workspaceId) : xferClientUrl(this.relay.origin, this.workspaceId);
    const socket: RelaySocket = new RelaySocket({
      url,
      now: this.now,
      createWebSocket: (target) => this.relay.createWebSocket(target),
      handlers: {
        hello: (frame) => {
          if (this.socket !== socket) return;
          this.relayHostOnline = frame.host;
          if (frame.host) this.startHandshake();
          else this.enterHostOffline('relay');
        },
        hostOnline: () => {
          if (this.socket !== socket) return;
          this.relayHostOnline = true;
          this.startHandshake();
        },
        hostOffline: () => {
          if (this.socket !== socket) return;
          this.relayHostOnline = false;
          this.drainThen(() => {
            this.enterHostOffline('relay');
            // The host may already be back (host.online arrived while the old channel drained).
            if (this.relayHostOnline) this.startHandshake();
          });
        },
        bye: (code, reason) => {
          if (this.socket !== socket) return;
          this.socket = null; // already terminated by RelaySocket; its session ends after the frames it holds
          this.drainThen(() => this.onBye(code, reason));
        },
        failed: (cause) => {
          if (this.socket === socket) this.onSocketFailed(cause);
        },
        invalidText: (detail) => this.diag({ kind: 'invalid-relay-text', detail }),
      },
    });
    this.socket = socket;
    socket.open();
  }

  /**
   * Runs `action` once the established channel has delivered every message that arrived before this point. Relay
   * control frames overtake binary frames still being decrypted, but the relay sent them in order: the daemon's
   * authenticated `channel.closed{role-changed}` precedes the relay's `bye 4003`, and must be seen first.
   */
  private drainThen(action: () => void): void {
    const channel = this.channel;
    if (!channel || channel.isClosed) {
      action();
      return;
    }
    this.afterDrain = action;
    // The channel closes ('remote') after its pending messages; onChannelClose runs `action`.
    this.socket?.closeSession();
  }

  private onBye(code: number, reason: string): void {
    if (code === RELAY_CLOSE_CODES.kicked) {
      // The relay closes a kicked client with 4003. An authenticated channel.closed just before explains it.
      if (this.daemonClosed === 'role-changed') this.retry('connecting', 'role-changed', 0);
      else if (this.daemonClosed === 'stopped') this.retry('connecting', null);
      // The daemon dropped a socket that sat idle (e.g. a very slow identity-token fetch): not a removal, start over.
      else if (this.daemonClosed === null && reason === PEER_KICK_REASON_IDLE) this.retry('relay-unreachable', 'bye');
      else this.enterTerminal({ kind: 'closed', reason: 'kicked', ...(this.daemonClosed ? { daemonReason: this.daemonClosed } : {}) });
      return;
    }
    this.retry('relay-unreachable', 'bye');
  }

  private onSocketFailed(cause: RelaySocketFailure): void {
    this.socket = null;
    this.retry('relay-unreachable', cause);
    // Browsers hide the HTTP status of a refused upgrade: ask the API whether we are still logged in.
    if (cause === 'open-failed') this.probeLogin();
  }

  private probeLogin(): void {
    const onError = (error: unknown): void => {
      if (!isRelayApiError(error, 401)) return;
      if (this.state.kind === 'relay-unreachable' || this.state.kind === 'connecting') {
        this.enterTerminal({ kind: 'closed', reason: 'login-required' });
      }
    };
    Promise.resolve()
      .then(() => this.relay.me())
      .then(() => {}, onError);
  }

  private enterHostOffline(reason: HostOfflineReason): void {
    this.teardownSession();
    if (!this.reliable) this.failPending(new ClientRequestError('connection-lost'));
    this.setState({ kind: 'host-offline', reason, since: this.now() });
  }

  private retry(kind: 'relay-unreachable', cause: RelayUnreachableCause, delayMs?: number): void;
  private retry(kind: 'connecting', cause: RetryCause | null, delayMs?: number): void;
  private retry(kind: 'relay-unreachable' | 'connecting', cause: RelayUnreachableCause | RetryCause | null, delayMs?: number): void {
    if (isTerminalState(this.state)) return;
    this.teardownSocket();
    if (!this.reliable) this.failPending(new ClientRequestError('connection-lost'));
    if (delayMs === undefined) this.failures++;
    const delay = delayMs ?? backoffDelay(this.failures, this.backoff, this.random);
    const retryAt = this.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.openSocket();
    }, delay);
    const attempt = this.failures + 1;
    if (kind === 'relay-unreachable') {
      this.setState({ kind, attempt, retryAt, cause: cause as RelayUnreachableCause });
    } else {
      this.setState({ kind, attempt, retryAt, cause: cause as RetryCause | null });
    }
  }

  private enterTerminal(state: ConnectionState): void {
    if (isTerminalState(this.state)) return;
    this.teardownSocket();
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.failPending(new ClientRequestError('closed'));
    this.reliable?.clear();
    const keepResume = state.kind === 'closed' && state.reason === 'local';
    if (!keepResume && this.resumeStore) {
      this.resumeStore.clear(this.workspaceId).catch((error: unknown) => this.diag({ kind: 'resume-store-error', error }));
    } else if (keepResume) {
      this.saveResume(true);
    }
    this.setState(state);
  }

  /** Ends the current handshake / channel, keeps the socket. */
  private teardownSession(): void {
    this.afterDrain = null;
    const run = this.handshake;
    this.handshake = null;
    run?.abort.abort();
    const channel = this.channel;
    this.channel = null;
    channel?.close();
  }

  private teardownSocket(): void {
    this.teardownSession();
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Handshake
  // ---------------------------------------------------------------------------------------------------------------

  private startHandshake(): void {
    const socket = this.socket;
    if (!socket || this.handshake || this.channel || isTerminalState(this.state)) return;
    const run: HandshakeRun = { socket, abort: new AbortController() };
    this.handshake = run;
    void this.runHandshake(run).finally(() => {
      if (this.handshake === run) this.handshake = null;
    });
  }

  private async chooseTrust(): Promise<TrustChoice | null> {
    let pin: Uint8Array | null;
    try {
      pin = await this.pins.get(this.workspaceId);
    } catch {
      this.enterTerminal({ kind: 'closed', reason: 'storage-error' });
      return null;
    }
    if (this.invite && (pin === null || this.forceInvite)) {
      this.forceInvite = false;
      return { mode: 'invite', trust: { kind: 'invite', fingerprint: this.invite.fingerprint, secret: this.invite.secret } };
    }
    if (pin) {
      // Remember whether the unspent invite points at the pinned daemon: only then may a refused device fall back to
      // it. A different fingerprint means the daemon key changed; that is never accepted silently (noise.md gotcha 16):
      // the application must ask the person and reconnect with preferInvite.
      this.inviteMatchesPin = this.invite !== null && equalBytes(daemonKeyFingerprint(pin), this.invite.fingerprint);
      return { mode: 'device', trust: { kind: 'pinned', daemonStaticKey: pin } };
    }
    this.enterTerminal({ kind: 'closed', reason: 'no-trust' });
    return null;
  }

  private async runHandshake(run: HandshakeRun): Promise<void> {
    const live = (): boolean => this.handshake === run && this.socket === run.socket && !run.abort.signal.aborted;
    const choice = await this.chooseTrust();
    if (!choice || !live()) return;
    this.setState({ kind: 'handshaking', mode: choice.mode, attempt: this.failures + 1 });
    if (!live()) return;

    let deviceKey: NoiseKeyPair;
    try {
      deviceKey = await this.deviceKeys.getKeyPair(this.workspaceId);
    } catch {
      if (live()) this.enterTerminal({ kind: 'closed', reason: 'storage-error' });
      return;
    }
    if (!live()) return;

    // A fresh token (5 min) and a fresh cnf nonce per handshake: the relay never sees a stable device id.
    const nonce = generateCnfNonce();
    let token: string;
    try {
      token = (await this.relay.identityToken(this.workspaceId, identityCnf(nonce, deviceKey.publicKey))).token;
    } catch (error) {
      if (live()) this.onRelayApiFailure(error);
      return;
    }
    if (!live()) return;

    const resume = this.reliable?.resumeRequest() ?? null;
    let hello: Uint8Array;
    try {
      hello = encodeClientHello({
        protocolVersion: PROTOCOL_VERSION,
        purpose: this.purpose,
        identityToken: token,
        cnfNonce: nonce,
        clientKind: this.clientKind,
        deviceName: this.deviceName,
        ...(resume ? { resume } : {}),
      });
    } catch {
      this.retry('connecting', 'protocol');
      return;
    }

    let result: ClientConnectResult;
    try {
      result = await clientConnect(run.socket.openSession(), {
        workspaceId: this.workspaceId,
        deviceKey,
        trust: choice.trust,
        hello,
        // Invite mode: the invite's fingerprint verified the key, so it may replace an older pin. It is persisted
        // BEFORE msg3 is sent (noise.md §1.3). Device mode: the key IS the pin.
        onDaemonVerified: async (key, mode) => {
          if (mode === 'invite') await this.pins.pin(this.workspaceId, key, { replace: true });
        },
        ...(this.suite ? { suite: this.suite } : {}),
        signal: run.abort.signal,
        deadlineMs: this.handshakeDeadlineMs,
      });
    } catch (error) {
      if (live()) this.onHandshakeError(error, choice.mode);
      return;
    }
    if (!live()) {
      result.channel.close();
      return;
    }
    const decoded = decodeWelcome(result.verdict);
    if (!decoded.ok || !decoded.verdict.ok) {
      result.channel.close();
      this.enterTerminal({ kind: 'rejected', reason: 'unknown' });
      return;
    }
    this.onEstablished(result.channel, decoded.verdict.welcome, resume);
  }

  private onRelayApiFailure(error: unknown): void {
    if (isRelayApiError(error, 401)) this.enterTerminal({ kind: 'closed', reason: 'login-required' });
    else if (isRelayApiError(error, 403)) this.enterTerminal({ kind: 'closed', reason: 'relay-refused' });
    else this.retry('relay-unreachable', 'relay-error');
  }

  private onHandshakeError(error: unknown, mode: HandshakeMode): void {
    if (!isChannelError(error)) {
      this.retry('connecting', 'protocol');
      return;
    }
    this.diag({ kind: 'handshake-failed', code: error.code, stage: error.stage });
    switch (error.code) {
      case 'daemon-key-mismatch':
        this.enterTerminal({ kind: 'key-mismatch', mode, detail: 'fingerprint' });
        return;
      case 'handshake-failed':
        // msg2 did not authenticate: whoever answered does not hold the expected key (or, in invite mode, the
        // invite). That is what a substituting relay produces: warn, never retry (SPEC R3).
        if (error.stage === 2) this.enterTerminal({ kind: 'key-mismatch', mode, detail: 'unauthenticated' });
        else this.retry('connecting', 'protocol');
        return;
      case 'aborted':
        // The ABORT is unauthenticated (the relay can forge it) and, for a device the daemon knows, it only ever means
        // "not now" (handshake budget, too many handshakes in flight): an unknown or revoked device gets an
        // authenticated verdict instead. So device mode keeps retrying with capped backoff and never gives up on a
        // flood (security review F4). In invite mode an unknown invite also answers ABORT, so it ends after a few.
        if (mode === 'device') {
          this.retry('connecting', 'aborted');
          return;
        }
        this.abortedInARow++;
        if (this.abortedInARow >= this.maxAborted) this.enterTerminal({ kind: 'rejected', reason: 'aborted' });
        else this.retry('connecting', 'aborted');
        return;
      case 'rejected':
        this.onRejected(error.verdict, mode);
        return;
      case 'callback-failed':
        this.enterTerminal({ kind: 'closed', reason: 'storage-error' });
        return;
      case 'timeout':
        this.retry('connecting', 'timeout');
        return;
      case 'cancelled':
        return;
      default:
        this.retry('connecting', 'protocol');
    }
  }

  private onRejected(verdict: Uint8Array | undefined, mode: HandshakeMode): void {
    const decoded = verdict ? decodeVerdictReason(verdict) : null;
    const reason = decoded?.ok && !decoded.verdict.ok ? decoded.verdict.reason : null;
    if (reason === 'busy') {
      this.retry('connecting', 'busy');
      return;
    }
    // Device mode refused before this connection was ever admitted, with an invite in hand: the device may be unknown
    // because an earlier invite attempt pinned the key but never reached admit() (lost msg3, busy), or because the
    // device key is new next to an old pin. The invite is still the right credential then.
    if (mode === 'device' && this.invite && this.inviteMatchesPin && !this.admittedOnce && reason !== 'kicked' && reason !== 'version' && reason !== 'device-other-account') {
      this.forceInvite = true;
      this.retry('connecting', null, 0);
      return;
    }
    this.enterTerminal({ kind: 'rejected', reason: reason ?? 'unknown' });
  }

  private onEstablished(channel: SecureChannel, welcome: Welcome, resume: { channelId: string; lastSeq: number } | null): void {
    this.channel = channel;
    this.admittedOnce = true;
    this.failures = 0;
    this.abortedInARow = 0;
    this.daemonClosed = null;
    this.lastDaemonAt = this.now();
    const resumed = resume !== null && welcome.resumed && welcome.channelId === resume.channelId;
    // Register at once: replayed messages may already be waiting behind the verdict.
    channel.onMessage((bytes) => this.onChannelMessage(channel, bytes));
    channel.onClose((event) => this.onChannelClose(channel, event));
    this.online = { welcome, resumed };
    if (this.reliable) {
      this.reliable.establish(welcome.channelId, resumed);
      if (!resumed) {
        // Rule 6: a request that reached the old logical channel (even one it acknowledged) will never be answered on
        // the new one. Only requests that were still queued, and were renumbered, stay pending.
        const kept = new Set(this.reliable.outbox);
        for (const pending of [...this.pending.values()]) {
          if (pending.entry && !kept.has(pending.entry)) this.failRequest(pending.id, new ClientRequestError('connection-lost'));
        }
      }
      this.unacked = 0;
      this.ackSince = null;
      // Rule 5: everything unacknowledged goes out, in order, before anything new.
      this.flushOutbox();
      this.resumeDirty = true;
      this.saveResume(true);
    }
    this.setState({ kind: 'online', welcome, resumed });
    for (const listener of [...this.welcomeListeners]) {
      try {
        listener(welcome, { resumed });
      } catch (error) {
        this.diag({ kind: 'listener-error', type: 'welcome', error });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Established channel
  // ---------------------------------------------------------------------------------------------------------------

  private onChannelMessage(channel: SecureChannel, bytes: Uint8Array): void {
    if (channel !== this.channel) return;
    this.lastDaemonAt = this.now();
    if (this.state.kind === 'host-offline' && this.state.reason === 'silence' && this.online) {
      this.setState({ kind: 'online', welcome: this.online.welcome, resumed: this.online.resumed });
    }
    const decoded = decodeEnvelope(bytes, { from: 'daemon', channel: this.purpose });
    if (!decoded.ok) {
      const reason = decoded.error.detail?.['reason'];
      this.diag({ kind: 'invalid-envelope', reason: typeof reason === 'string' ? reason : 'unknown', type: decoded.type });
      if (decoded.id !== null) this.failRequest(decoded.id, decoded.error);
      return;
    }
    const envelope = decoded.envelope as { type: string; id: string; seq: number; payload: unknown };
    if (this.reliable && envelope.seq > 0) {
      if (!this.reliable.acceptInbound(envelope.seq)) return; // rule 3: a replay of something already processed
      this.noteInbound();
    }
    this.dispatch(envelope);
  }

  private dispatch(envelope: { type: string; id: string; seq: number; payload: unknown }): void {
    const { type, id, seq, payload } = envelope;
    if (parseWireType(type)?.kind === 'response') {
      if (!this.settle(id, payload)) this.diag({ kind: 'uncorrelated-response', type });
      return;
    }
    const meta: EventMeta = { id, seq };
    switch (type) {
      case 'error':
        if (!this.failRequest(id, SmurgError.fromPayload(payload as ErrorPayload))) this.emit(type, payload, meta);
        return;
      case 'channel.ack':
        this.reliable?.trim((payload as { upTo: number }).upTo);
        return;
      case 'channel.closed':
        this.emit(type, payload, meta);
        this.onDaemonClosed((payload as { reason: ChannelClosedReason }).reason);
        return;
      default:
        this.emit(type, payload, meta);
    }
  }

  private onDaemonClosed(reason: ChannelClosedReason): void {
    this.daemonClosed = reason;
    switch (reason) {
      case 'kicked':
      case 'revoked':
        this.enterTerminal({ kind: 'closed', reason, daemonReason: reason });
        return;
      case 'stopped':
        this.enterHostOffline('stopped');
        return;
      case 'role-changed':
        this.retry('connecting', 'role-changed', 0);
        return;
      case 'protocol-error':
        this.retry('connecting', 'protocol');
        return;
    }
  }

  private onChannelClose(channel: SecureChannel, event: ChannelCloseEvent): void {
    if (channel !== this.channel) return;
    this.channel = null;
    const afterDrain = this.afterDrain;
    this.afterDrain = null;
    if (afterDrain) {
      afterDrain();
      return;
    }
    if (event.initiator === 'local') return;
    if (event.error) this.diag({ kind: 'channel-error', code: event.error.code });
    // An integrity failure, or the session ended while the socket lives on: start over on a fresh socket.
    this.retry('connecting', 'protocol');
  }

  private tick(): void {
    if (isTerminalState(this.state)) return;
    const now = this.now();
    if (this.reliable && this.channel) this.maybeAck(now);
    if (this.silenceThresholdMs !== null) {
      if (this.channel) {
        const silent = now - this.lastDaemonAt;
        if (this.state.kind === 'online' && silent >= this.silenceThresholdMs) {
          this.setState({ kind: 'host-offline', reason: 'silence', since: now });
        } else if (this.state.kind === 'host-offline' && this.state.reason === 'silence' && silent >= this.silenceReconnectMs) {
          this.retry('connecting', 'stalled');
        }
      } else if (this.state.kind === 'host-offline' && this.state.reason === 'stopped' && now - this.state.since >= this.silenceReconnectMs) {
        this.retry('connecting', 'stalled');
      }
    }
    if (now - this.lastResumeSaveAt >= RESUME_SAVE_INTERVAL_MS) this.saveResume(false);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------------------

  private encoder(type: string, id: string, payload: unknown): (seq: number) => Uint8Array {
    const channel = this.purpose;
    return (seq) => encodeEnvelope({ type, id, seq, payload } as never, { from: 'client', channel });
  }

  /** Transfer channel: no outbox, seq still increments. */
  private sendUnsequenced(encode: (seq: number) => Uint8Array): void {
    const channel = this.channel;
    if (!channel || this.state.kind !== 'online') throw new ClientRequestError('not-connected');
    const bytes = encode(this.transferSeq);
    channel.send(bytes);
    this.transferSeq++;
  }

  private flushOutbox(): void {
    const channel = this.channel;
    // While draining, the session is already ending: whatever is queued waits for the next channel.
    if (!channel || !this.reliable || this.afterDrain) return;
    for (const entry of this.reliable.unsent()) {
      if (channel.isClosed || channel !== this.channel) return;
      try {
        channel.send(entry.bytes);
        entry.sent = true;
      } catch (error) {
        if (isChannelError(error, 'too-large')) {
          this.reliable.removeUnsent(entry);
          if (entry.request) this.failRequest(entry.id, asRequestError(error));
          continue;
        }
        return; // the channel closed; its close handler takes over and the entry is re-sent later
      }
    }
  }

  private noteInbound(): void {
    this.unacked++;
    this.ackSince ??= this.now();
    if (this.unacked >= ACK_EVERY) this.sendAck();
  }

  private maybeAck(now: number): void {
    if (this.ackSince !== null && now - this.ackSince >= ACK_DELAY_MS) this.sendAck();
  }

  private sendAck(): void {
    const reliable = this.reliable;
    const channel = this.channel;
    if (!reliable || !channel || channel.isClosed) return;
    const upTo = reliable.pendingAck();
    if (upTo === null) {
      this.unacked = 0;
      this.ackSince = null;
      return;
    }
    try {
      // Rule 2: acks are unsequenced (seq 0).
      channel.send(encodeEnvelope({ type: 'channel.ack', id: this.nextId(), seq: 0, payload: { upTo } }, { from: 'client', channel: 'interactive' }));
    } catch {
      return;
    }
    reliable.markAcked(upTo);
    this.unacked = 0;
    this.ackSince = null;
    this.resumeDirty = true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Requests and events
  // ---------------------------------------------------------------------------------------------------------------

  private nextId(): string {
    this.idCounter++;
    return `${this.idPrefix}.${this.idCounter.toString(36)}`;
  }

  private settle(id: string, value: unknown): boolean {
    const pending = this.takePending(id);
    if (!pending) return false;
    pending.resolve(value);
    return true;
  }

  /**
   * Rejects the pending request `id`, if any, and takes it out of the outbox even when it was already transmitted:
   * a request its caller saw fail is never replayed on a resumed channel, so retrying it cannot make
   * the action happen twice.
   */
  private failRequest(id: string, error: unknown): boolean {
    const pending = this.takePending(id);
    if (!pending) return false;
    if (pending.entry && this.reliable) this.reliable.remove(pending.entry);
    pending.reject(error);
    return true;
  }

  private takePending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.cleanup();
    return pending;
  }

  private failPending(error: unknown): void {
    for (const id of [...this.pending.keys()]) this.failRequest(id, error);
  }

  private emit(type: string, payload: unknown, meta: EventMeta): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload, meta);
      } catch (error) {
        this.diag({ kind: 'listener-error', type, error });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------------------------------------------

  private saveResume(force: boolean): void {
    if (!this.reliable || !this.resumeStore || (!force && !this.resumeDirty)) return;
    const snapshot = this.reliable.snapshot();
    this.resumeDirty = false;
    this.lastResumeSaveAt = this.now();
    if (snapshot === null) return;
    this.resumeStore.save(this.workspaceId, snapshot).catch((error: unknown) => this.diag({ kind: 'resume-store-error', error }));
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch (error) {
        this.diag({ kind: 'listener-error', type: 'state', error });
      }
    }
  }

  private diag(diagnostic: ConnectionDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // A logger must not break the connection.
    }
  }
}

function asRequestError(error: unknown): unknown {
  if (error instanceof SmurgError) return error;
  if (isChannelError(error, 'too-large')) return new SmurgError('too_large', undefined, { reason: 'too-large' }, { cause: error });
  if (isChannelError(error)) return new ClientRequestError('connection-lost', undefined, { cause: error });
  return error;
}
