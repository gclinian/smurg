// Handshake drivers: client (web / CLI, initiator) <-> daemon (responder), through an untrusted relay.
// Port of the verified channel-v2.ts (noise.md, Verification V-C) onto an event-based Transport.
//
//   first contact  mode 'invite'  Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s  psk from the invite secret `s`;
//                                  the client checks the daemon key against the fingerprint `k` at msg2.
//   reconnect      mode 'device'  Noise_XX_25519_ChaChaPoly_BLAKE2s      mutual pinning: the client checks its
//                                  pinned daemon key at msg2, the daemon checks its device registry in admit().
//
// Rules this file enforces (each one was a verified bug in the first spike):
//  * The daemon decides NOTHING on the unauthenticated msg3 static key. One synchronous admit() runs after msg3
//    authenticates, so check-and-consume of an invite use cannot race (V1) and expiry is re-checked there (V8).
//  * Every pre-authentication failure produces the same cleartext ABORT [0x7f,0x00] (no device-status oracle, V2).
//    Post-authentication decisions travel encrypted in the verdict.
//  * The client verifies the daemon key at msg2, calls onDaemonVerified (persist the pin) and only then sends msg3,
//    so a lost verdict never strands a joiner whose invite use was consumed (V3).
//  * The client resolves only after the verdict decrypts: in XXpsk3 that is its only proof the PSK was accepted.
import { HANDSHAKE_DEADLINE_MS, MAX_APP_MESSAGE, MAX_RELAY_FRAME, NOISE_MAX_MESSAGE_BYTES, NOISE_TAG_BYTES } from '../constants.ts';
import { EMPTY_BYTES, concatBytes, equalBytes } from '../bytes.ts';
import {
  HANDSHAKE_MODE_BYTES,
  INVITE_ID_BYTES,
  INVITE_PSK_BYTES,
  buildNoisePrologue,
  daemonKeyFingerprint,
  deriveInviteKeys,
  handshakeModeFromByte,
  type HandshakeMode,
} from '../invite.ts';
import { NoiseError } from '../noise/errors.ts';
import { resolveHandshakePattern } from '../noise/patterns.ts';
import { HandshakeState } from '../noise/state.ts';
import { nobleSuite, type NoiseKeyPair, type NoiseSuite } from '../noise/suite.ts';
import { isWorkspaceId } from '../relay/routes.ts';
import { ChannelError, type HandshakeStage } from './errors.ts';
import {
  CHANNEL_FRAME,
  HANDSHAKE_WIRE_VERSION,
  HELLO_HEADER_BYTES,
  MAX_HANDSHAKE_FRAME_BYTES,
  VERDICT,
  genericAbortFrame,
  handshakeFrame,
} from './frames.ts';
import { FrameInbox } from './inbox.ts';
import { RecordOpener, RecordSealer } from './records.ts';
import { createSecureChannel, type SecureChannel } from './secure-channel.ts';
import type { Transport } from './transport.ts';

const KEY_BYTES = 32;
/** msg3 = enc(s) (32 + 16) + enc(payload) (+16) must fit one Noise message. */
export const MAX_CLIENT_HELLO_BYTES = NOISE_MAX_MESSAGE_BYTES - (KEY_BYTES + NOISE_TAG_BYTES) - NOISE_TAG_BYTES;
/** What a connection may queue before the channel takes over (pipelined frames included). */
const MAX_HANDSHAKE_QUEUE_BYTES = 4 * MAX_RELAY_FRAME;

// ---------------------------------------------------------------------------------------------------------------
// Shared run context: deadline, cancellation, fail-closed cleanup
// ---------------------------------------------------------------------------------------------------------------

interface RunOptions {
  deadlineMs: number;
  signal: AbortSignal | undefined;
  onFailed: ((error: ChannelError) => void) | undefined;
}

function withStage(error: ChannelError, stage: HandshakeStage): ChannelError {
  if (error.stage !== undefined) return error;
  return new ChannelError(error.code, error.message, { stage, ...(error.verdict ? { verdict: error.verdict } : {}), cause: error.cause });
}

function toChannelError(err: unknown, stage: HandshakeStage): ChannelError {
  if (err instanceof ChannelError) return withStage(err, stage);
  const detail = err instanceof NoiseError ? err.code : 'internal error';
  return new ChannelError('handshake-failed', `msg${stage} rejected: ${detail}`, { stage, cause: err });
}

class HandshakeRun {
  readonly inbox: FrameInbox;
  stage: HandshakeStage = 1;
  private readonly transport: Transport;
  private readonly options: RunOptions;
  /** Whether a failure is answered with the generic cleartext ABORT (only before authentication / before FINISH). */
  private abortOnFailure = true;
  private settled = false;
  private failure: ChannelError | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rejectOuter: ((error: ChannelError) => void) | undefined;
  private readonly onAbortSignal = (): void => this.fail(new ChannelError('cancelled', 'handshake cancelled'));

  constructor(transport: Transport, options: RunOptions) {
    this.transport = transport;
    this.options = options;
    // Subscribe synchronously, before anything can arrive.
    this.inbox = new FrameInbox(transport, MAX_HANDSHAKE_QUEUE_BYTES);
  }

  execute<T>(body: (run: HandshakeRun) => Promise<T>, discard: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.rejectOuter = reject;
      if (this.options.signal?.aborted) {
        this.fail(new ChannelError('cancelled', 'handshake cancelled'));
        return;
      }
      this.options.signal?.addEventListener('abort', this.onAbortSignal, { once: true });
      this.timer = setTimeout(
        () => this.fail(new ChannelError('timeout', `handshake did not complete within ${this.options.deadlineMs} ms`)),
        this.options.deadlineMs,
      );
      (this.timer as { unref?: () => void }).unref?.();
      body(this).then(
        (value) => {
          if (this.settled) {
            discard(value);
            return;
          }
          this.settled = true;
          this.cleanup();
          resolve(value);
        },
        (err: unknown) => this.fail(toChannelError(err, this.stage)),
      );
    });
  }

  /** From here on failures are not answered with a cleartext ABORT (we are past FINISH / authenticated). */
  noAbortOnFailure(): void {
    this.abortOnFailure = false;
  }

  fail(error: ChannelError): void {
    if (this.settled) return;
    const staged = withStage(error, this.stage);
    this.settled = true;
    this.failure = staged;
    this.cleanup();
    this.inbox.fail(staged);
    this.inbox.dispose();
    if (this.abortOnFailure) {
      try {
        this.transport.send(genericAbortFrame());
      } catch {
        // The transport may already be gone; the peer then sees the close instead.
      }
    }
    try {
      this.transport.close();
    } catch {
      // Closing is best-effort; the run is failed either way.
    }
    try {
      this.options.onFailed?.(staged);
    } catch {
      // A throwing observer must not change the outcome.
    }
    this.rejectOuter?.(staged);
  }

  private cleanup(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbortSignal);
  }

  /** Throws once the run failed (deadline, cancellation): nothing may be sent or decided after that. */
  checkpoint(): void {
    if (this.settled) throw this.failure ?? new ChannelError('closed', 'handshake is over');
  }

  async next(): Promise<Uint8Array> {
    const frame = await this.inbox.next();
    this.checkpoint();
    return frame;
  }

  send(frame: Uint8Array): void {
    this.checkpoint();
    this.transport.send(frame);
  }
}

function assertBytes(value: unknown, length: number, what: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new TypeError(`${what} must be ${length} bytes`);
}

function assertCommon(options: { workspaceId: string; deadlineMs?: number; maxMessageBytes?: number }): void {
  if (!isWorkspaceId(options.workspaceId)) throw new TypeError('invalid workspace id');
  if (options.deadlineMs !== undefined && !(Number.isFinite(options.deadlineMs) && options.deadlineMs > 0)) {
    throw new RangeError('deadlineMs must be a positive number');
  }
  if (
    options.maxMessageBytes !== undefined &&
    !(Number.isSafeInteger(options.maxMessageBytes) && options.maxMessageBytes >= 1 && options.maxMessageBytes <= MAX_APP_MESSAGE)
  ) {
    throw new RangeError(`maxMessageBytes must be in 1..${MAX_APP_MESSAGE}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Client (initiator)
// ---------------------------------------------------------------------------------------------------------------

export type ClientTrust =
  /** First contact: `k` and `s` from the invite fragment (parseInviteFragment). */
  | { readonly kind: 'invite'; readonly fingerprint: Uint8Array; readonly secret: Uint8Array }
  /** Reconnect: the daemon key pinned at first contact. */
  | { readonly kind: 'pinned'; readonly daemonStaticKey: Uint8Array };

export interface ClientConnectOptions {
  workspaceId: string;
  /** The device's static key (raw, WebCrypto non-extractable or wrapped: DH is awaited). */
  deviceKey: NoiseKeyPair;
  trust: ClientTrust;
  /** Opaque msg3 payload (the msgpack ClientHello), at most MAX_CLIENT_HELLO_BYTES. Travels encrypted. */
  hello: Uint8Array;
  /**
   * Runs after msg2 proved the daemon key (fingerprint / pin + `es`), BEFORE msg3 is sent. Persist the pin here
   * (in invite mode the invite is the trust anchor, so replacing an older pin is legitimate). If it throws, msg3 is
   * not sent and the handshake fails with 'callback-failed'.
   */
  onDaemonVerified?: (daemonStaticKey: Uint8Array, mode: HandshakeMode) => void | Promise<void>;
  suite?: NoiseSuite;
  /** Default HANDSHAKE_DEADLINE_MS. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Largest application message in either direction; default MAX_APP_MESSAGE. */
  maxMessageBytes?: number;
}

export interface ClientConnectResult {
  readonly channel: SecureChannel;
  /** Opaque, authenticated accept payload from the daemon's admit() (the msgpack Welcome). */
  readonly verdict: Uint8Array;
  readonly daemonStaticKey: Uint8Array;
  readonly mode: HandshakeMode;
}

/**
 * Runs the client side of the handshake over `transport` and resolves once the daemon's accept verdict decrypted.
 * On failure the transport is closed and the promise rejects with a ChannelError:
 *  - 'daemon-key-mismatch' (stage 2): the peer proved a key other than `k` / the pin. Show the SPEC R3 warning.
 *  - 'handshake-failed' at stage 2: msg2 did not authenticate (in invite mode also what a relay without the invite
 *    secret produces when it answers in the daemon's place).
 *  - 'aborted': the daemon sent the generic ABORT (stage 2: no invite matched / refused; stage 3: it could not
 *    authenticate msg3, e.g. a wrong PSK or a key the device does not own).
 *  - 'rejected' (stage 3): authenticated refusal; the opaque reason is `error.verdict`.
 *  - 'timeout', 'cancelled', 'closed', 'protocol', 'callback-failed'.
 * msg3 is never sent unless the daemon key was verified and onDaemonVerified returned.
 */
export function clientConnect(transport: Transport, options: ClientConnectOptions): Promise<ClientConnectResult> {
  try {
    assertCommon(options);
    if (options.trust.kind === 'invite') {
      assertBytes(options.trust.fingerprint, KEY_BYTES, 'invite fingerprint');
      assertBytes(options.trust.secret, KEY_BYTES, 'invite secret');
    } else if (options.trust.kind === 'pinned') {
      assertBytes(options.trust.daemonStaticKey, KEY_BYTES, 'pinned daemon key');
    } else {
      throw new TypeError('unknown trust kind');
    }
    if (!(options.hello instanceof Uint8Array) || options.hello.length > MAX_CLIENT_HELLO_BYTES) {
      throw new RangeError(`hello must be a Uint8Array of at most ${MAX_CLIENT_HELLO_BYTES} bytes`);
    }
  } catch (err) {
    return Promise.reject(err);
  }
  const suite = options.suite ?? nobleSuite;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_APP_MESSAGE;
  const run = new HandshakeRun(transport, {
    deadlineMs: options.deadlineMs ?? HANDSHAKE_DEADLINE_MS,
    signal: options.signal,
    onFailed: undefined,
  });
  return run.execute(
    async (r) => {
      const trust = options.trust;
      const mode: HandshakeMode = trust.kind === 'invite' ? 'invite' : 'device';
      const inviteKeys = trust.kind === 'invite' ? deriveInviteKeys(trust.secret) : null;
      const hs = new HandshakeState({
        suite,
        pattern: resolveHandshakePattern(inviteKeys ? 'XXpsk3' : 'XX'),
        initiator: true,
        prologue: buildNoisePrologue(options.workspaceId, mode, inviteKeys?.inviteId),
        s: options.deviceKey,
        psks: inviteKeys ? [inviteKeys.psk] : [],
      });

      // ---- msg1: the invite id is NOT sent; the daemon finds the invite by trial-verifying msg1.
      const msg1 = await hs.writeMessage();
      r.send(handshakeFrame(CHANNEL_FRAME.HELLO, [HANDSHAKE_WIRE_VERSION, HANDSHAKE_MODE_BYTES[mode]], msg1));

      // ---- msg2: verify the daemon's static key before anything about us is revealed.
      r.stage = 2;
      const reply = await r.next();
      if (reply[0] === CHANNEL_FRAME.ABORT) {
        r.noAbortOnFailure();
        throw new ChannelError('aborted', 'the daemon aborted the handshake', { stage: 2 });
      }
      if (reply[0] !== CHANNEL_FRAME.REPLY || reply.length > MAX_HANDSHAKE_FRAME_BYTES) {
        throw new ChannelError('protocol', `expected REPLY, got frame type ${reply[0]}`, { stage: 2 });
      }
      let payload2: Uint8Array;
      try {
        payload2 = await hs.readMessage(reply.subarray(1), (rs) => {
          const ok =
            trust.kind === 'invite' ? equalBytes(daemonKeyFingerprint(rs), trust.fingerprint) : equalBytes(rs, trust.daemonStaticKey);
          if (!ok) {
            throw new ChannelError('daemon-key-mismatch', 'the daemon static key does not match the invite fingerprint or the pinned key', {
              stage: 2,
            });
          }
        });
      } catch (err) {
        if (err instanceof ChannelError) throw err;
        throw new ChannelError('handshake-failed', `msg2 rejected: ${err instanceof NoiseError ? err.code : 'error'}`, { stage: 2, cause: err });
      }
      if (payload2.length !== 0) throw new ChannelError('protocol', 'msg2 carries an unexpected payload', { stage: 2 });
      // msg2's payload decrypted => `es` mixed => the daemon proved possession of the verified static key.
      const daemonStaticKey = hs.remoteStatic as Uint8Array;
      r.checkpoint();
      if (options.onDaemonVerified) {
        try {
          await options.onDaemonVerified(daemonStaticKey.slice(), mode);
        } catch (cause) {
          throw new ChannelError('callback-failed', 'onDaemonVerified failed; msg3 was not sent', { stage: 2, cause });
        }
      }
      r.checkpoint();

      // ---- msg3: our static key (encrypted) + psk proof + the opaque hello.
      const msg3 = await hs.writeMessage(options.hello);
      r.send(handshakeFrame(CHANNEL_FRAME.FINISH, [], msg3));
      r.stage = 3;
      r.noAbortOnFailure();
      const keys = hs.split();
      const sealer = new RecordSealer(keys.send, maxMessageBytes);
      const opener = new RecordOpener(keys.recv, maxMessageBytes);

      // ---- verdict: the first application message from the daemon.
      const pending: Uint8Array[] = [];
      while (pending.length === 0) {
        const frame = await r.next();
        if (frame[0] === CHANNEL_FRAME.ABORT) {
          throw new ChannelError('aborted', 'the daemon could not authenticate msg3 (wrong PSK, or not the owner of the device key)', {
            stage: 3,
          });
        }
        if (frame[0] !== CHANNEL_FRAME.DATA) throw new ChannelError('protocol', `expected DATA, got frame type ${frame[0]}`, { stage: 3 });
        try {
          pending.push(...opener.open(frame));
        } catch (cause) {
          throw new ChannelError('handshake-failed', 'the verdict did not authenticate', { stage: 3, cause });
        }
      }
      const verdict = pending.shift() as Uint8Array;
      if (verdict[0] === VERDICT.REJECT) {
        throw new ChannelError('rejected', 'the daemon refused admission', { stage: 3, verdict: verdict.slice(1) });
      }
      if (verdict.length < 1 || verdict[0] !== VERDICT.ACCEPT) throw new ChannelError('protocol', 'malformed verdict', { stage: 3 });
      r.checkpoint();
      const channel = createSecureChannel({
        transport,
        inbox: r.inbox,
        sealer,
        opener,
        remoteStaticKey: daemonStaticKey,
        handshakeHash: keys.handshakeHash,
        initialMessages: pending,
      });
      return { channel, verdict: verdict.slice(1), daemonStaticKey: daemonStaticKey.slice(), mode };
    },
    (result) => result.channel.close(),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Daemon (responder)
// ---------------------------------------------------------------------------------------------------------------

/** What the daemon keeps per invite for matching (the invite store holds role, expiry and uses next to it). */
export interface DaemonInviteKey {
  readonly inviteId: Uint8Array;
  readonly psk: Uint8Array;
}

/** Everything admit() may decide on. All of it is authenticated when admit() runs. */
export interface AdmitContext {
  readonly mode: HandshakeMode;
  /** The invite whose PSK the client proved (invite mode only). */
  readonly inviteId?: Uint8Array;
  /** The client's device static key; the client proved possession of it. */
  readonly clientStaticKey: Uint8Array;
  /** Opaque msg3 payload (msgpack ClientHello). */
  readonly helloPayload: Uint8Array;
  /** Noise handshake hash, identical on both ends. */
  readonly handshakeHash: Uint8Array;
}

/** `payload` is opaque to the channel: the msgpack Welcome on accept, the msgpack reason on reject. */
export interface AdmitDecision {
  readonly accept: boolean;
  readonly payload: Uint8Array;
}

export interface DaemonAcceptOptions {
  workspaceId: string;
  /** The daemon's static identity key for this workspace. */
  staticKey: NoiseKeyPair;
  /**
   * Every invite still on file, including recently expired or used-up ones (so admit() can give a precise reason).
   * Called once per invite-mode HELLO; entries are trial-verified against msg1 (no DH needed).
   */
  invites: () => Iterable<DaemonInviteKey>;
  /**
   * Runs exactly once, right after msg3 AUTHENTICATED (PSK and device-key possession proven), and must be
   * SYNCHRONOUS: check and consume in one step (invite expiry, uses left, device registered / revoked, identity
   * token, then decrement uses / register the device). Returning a promise, throwing or returning anything malformed
   * fails closed: the client gets a rejection with an empty payload and the daemon sees 'admit-failed'.
   */
  admit: (context: AdmitContext) => AdmitDecision;
  /**
   * Rate-limit gate, called once per well-formed HELLO before any cryptographic work. Returning false (or throwing)
   * answers with the generic ABORT ('refused').
   */
  allowHandshake?: (info: { readonly mode: HandshakeMode }) => boolean;
  /** Observes every failed handshake (pre-auth failures, rejections, timeouts) for per-connection limits and audit. */
  onHandshakeFailed?: (error: ChannelError) => void;
  /** Default: nobleSuite. The daemon passes nodeCryptoSuite from @smurg/protocol/node. */
  suite?: NoiseSuite;
  /** Default HANDSHAKE_DEADLINE_MS. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Default MAX_APP_MESSAGE. */
  maxMessageBytes?: number;
}

export interface DaemonAcceptResult {
  readonly channel: SecureChannel;
  readonly mode: HandshakeMode;
  readonly inviteId?: Uint8Array;
  readonly clientStaticKey: Uint8Array;
  readonly helloPayload: Uint8Array;
}

type AdmitOutcome = { ok: true; decision: AdmitDecision } | { ok: false; error: ChannelError };

function callAdmit(admit: DaemonAcceptOptions['admit'], context: AdmitContext, maxPayload: number): AdmitOutcome {
  let result: unknown;
  try {
    result = admit(context);
  } catch (cause) {
    return { ok: false, error: new ChannelError('admit-failed', 'admit() threw', { stage: 3, cause }) };
  }
  if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
    // Swallow its eventual rejection; the verdict is already "no".
    (result as Promise<unknown>).then(undefined, () => {});
    return { ok: false, error: new ChannelError('admit-failed', 'admit() must be synchronous (it returned a promise)', { stage: 3 }) };
  }
  const decision = result as Partial<AdmitDecision> | null;
  if (!decision || typeof decision.accept !== 'boolean' || !(decision.payload instanceof Uint8Array)) {
    return { ok: false, error: new ChannelError('admit-failed', 'admit() returned a malformed decision', { stage: 3 }) };
  }
  if (decision.payload.length > maxPayload) {
    return { ok: false, error: new ChannelError('admit-failed', 'admit() payload is too large', { stage: 3 }) };
  }
  return { ok: true, decision: { accept: decision.accept, payload: decision.payload } };
}

/**
 * Runs the daemon side of the handshake over `transport` and resolves with an admitted channel. On failure the
 * transport is closed and the promise rejects with a ChannelError whose code says why (for logs and audit only: the
 * peer saw either the generic ABORT or an encrypted reject verdict).
 */
export function daemonAccept(transport: Transport, options: DaemonAcceptOptions): Promise<DaemonAcceptResult> {
  try {
    assertCommon(options);
    assertBytes(options.staticKey?.publicKey, KEY_BYTES, 'daemon static public key');
    if (typeof options.admit !== 'function' || typeof options.invites !== 'function') throw new TypeError('admit and invites are required');
  } catch (err) {
    return Promise.reject(err);
  }
  const suite = options.suite ?? nobleSuite;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_APP_MESSAGE;
  const run = new HandshakeRun(transport, {
    deadlineMs: options.deadlineMs ?? HANDSHAKE_DEADLINE_MS,
    signal: options.signal,
    onFailed: options.onHandshakeFailed,
  });
  const responder = (mode: HandshakeMode, invite?: DaemonInviteKey): HandshakeState =>
    new HandshakeState({
      suite,
      pattern: resolveHandshakePattern(invite ? 'XXpsk3' : 'XX'),
      initiator: false,
      prologue: buildNoisePrologue(options.workspaceId, mode, invite?.inviteId),
      s: options.staticKey,
      psks: invite ? [invite.psk] : [],
    });

  return run.execute(
    async (r) => {
      // ---- HELLO
      const hello = await r.next();
      if (hello[0] === CHANNEL_FRAME.ABORT) {
        r.noAbortOnFailure();
        throw new ChannelError('aborted', 'the client aborted', { stage: 1 });
      }
      if (hello[0] !== CHANNEL_FRAME.HELLO) throw new ChannelError('protocol', `expected HELLO, got frame type ${hello[0]}`, { stage: 1 });
      const mode = handshakeModeFromByte(hello[2]);
      if (hello.length < HELLO_HEADER_BYTES || hello.length > MAX_HANDSHAKE_FRAME_BYTES || hello[1] !== HANDSHAKE_WIRE_VERSION || !mode) {
        throw new ChannelError('bad-hello', 'unsupported HELLO version, mode or size', { stage: 1 });
      }
      let allowed = true;
      try {
        allowed = options.allowHandshake ? options.allowHandshake({ mode }) === true : true;
      } catch {
        allowed = false;
      }
      if (!allowed) throw new ChannelError('refused', 'handshake refused by the rate limit', { stage: 1 });

      const msg1 = hello.subarray(HELLO_HEADER_BYTES);
      let hs: HandshakeState | undefined;
      let invite: DaemonInviteKey | undefined;
      if (mode === 'invite') {
        // A psk-mode `e` does MixKey(e): msg1 carries a tag whose AD is h(prologue incl. inviteId). Only a holder of
        // `s` can produce a msg1 that verifies for one of our invites; no DH is spent on anything else.
        if (msg1.length !== suite.dhLen + NOISE_TAG_BYTES) throw new ChannelError('bad-hello', 'invite msg1 has the wrong size', { stage: 1 });
        for (const candidateInvite of options.invites()) {
          if (
            !(candidateInvite?.inviteId instanceof Uint8Array) ||
            candidateInvite.inviteId.length !== INVITE_ID_BYTES ||
            !(candidateInvite.psk instanceof Uint8Array) ||
            candidateInvite.psk.length !== INVITE_PSK_BYTES
          ) {
            continue;
          }
          const candidate = responder('invite', candidateInvite);
          try {
            await candidate.readMessage(msg1);
          } catch {
            continue;
          }
          hs = candidate;
          invite = { inviteId: candidateInvite.inviteId.slice(), psk: candidateInvite.psk.slice() };
          break;
        }
        if (!hs) throw new ChannelError('invite-unknown', 'no invite on file matches msg1', { stage: 1 });
      } else {
        // Plain XX msg1 is an unauthenticated ephemeral: anything of the right size passes, hence the deadline.
        if (msg1.length !== suite.dhLen) throw new ChannelError('bad-hello', 'device msg1 has the wrong size', { stage: 1 });
        hs = responder('device');
        await hs.readMessage(msg1);
      }
      r.checkpoint();

      // ---- REPLY
      const msg2 = await hs.writeMessage();
      r.send(handshakeFrame(CHANNEL_FRAME.REPLY, [], msg2));
      r.stage = 3;

      // ---- FINISH: no hook on the static key. Nothing is decided before the whole message authenticated.
      const finish = await r.next();
      if (finish[0] === CHANNEL_FRAME.ABORT) {
        r.noAbortOnFailure();
        throw new ChannelError('aborted', 'the client aborted after msg2 (e.g. daemon key mismatch)', { stage: 3 });
      }
      if (finish[0] !== CHANNEL_FRAME.FINISH || finish.length > MAX_HANDSHAKE_FRAME_BYTES) {
        throw new ChannelError('protocol', `expected FINISH, got frame type ${finish[0]}`, { stage: 3 });
      }
      const helloPayload = (await hs.readMessage(finish.subarray(1))).slice();
      r.checkpoint();

      // ---- authenticated: from here every outcome is sent encrypted, never as a cleartext ABORT.
      r.noAbortOnFailure();
      const keys = hs.split();
      const clientStaticKey = (keys.remoteStatic as Uint8Array).slice();
      const sealer = new RecordSealer(keys.send, maxMessageBytes);
      const opener = new RecordOpener(keys.recv, maxMessageBytes);
      const context: AdmitContext = {
        mode,
        ...(invite ? { inviteId: invite.inviteId.slice() } : {}),
        clientStaticKey: clientStaticKey.slice(),
        helloPayload: helloPayload.slice(),
        handshakeHash: keys.handshakeHash.slice(),
      };
      const outcome = callAdmit(options.admit, context, maxMessageBytes - 1); // synchronous check-and-consume
      const decision: AdmitDecision = outcome.ok ? outcome.decision : { accept: false, payload: EMPTY_BYTES };
      r.send(sealer.seal(concatBytes(new Uint8Array([decision.accept ? VERDICT.ACCEPT : VERDICT.REJECT]), decision.payload)));
      if (!outcome.ok) throw outcome.error;
      if (!decision.accept) throw new ChannelError('rejected', 'admission refused', { stage: 3, verdict: decision.payload.slice() });

      const channel = createSecureChannel({
        transport,
        inbox: r.inbox,
        sealer,
        opener,
        remoteStaticKey: clientStaticKey,
        handshakeHash: keys.handshakeHash,
      });
      return { channel, mode, ...(invite ? { inviteId: invite.inviteId.slice() } : {}), clientStaticKey, helloPayload };
    },
    (result) => result.channel.close(),
  );
}
