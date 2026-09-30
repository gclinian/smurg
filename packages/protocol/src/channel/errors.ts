// Errors of the encrypted channel (handshake and established channel). The codes are local diagnostics: the only
// thing a peer ever learns about a pre-authentication failure is the generic cleartext ABORT.

export type ChannelErrorCode =
  // ---- handshake, client side
  /** The daemon proved a static key that is NOT the one in the invite (`k`) or the pinned one: possible relay MITM. */
  | 'daemon-key-mismatch'
  /** The peer answered with the generic cleartext ABORT (it could not authenticate us, or refused before auth). */
  | 'aborted'
  /** The daemon authenticated us and refused admission; the opaque reason is in `ChannelError.verdict`. */
  | 'rejected'
  /** `onDaemonVerified` threw (e.g. the pin could not be persisted); msg3 was not sent. */
  | 'callback-failed'
  // ---- handshake, daemon side (never sent to the peer)
  /** No invite on file makes msg1 verify (unknown, forged or tampered HELLO). */
  | 'invite-unknown'
  /** HELLO has an unsupported version or mode, or a malformed length. */
  | 'bad-hello'
  /** The caller's `allowHandshake` gate said no (rate limit). */
  | 'refused'
  /** `admit` threw, returned a promise or returned something malformed. Fails closed as a rejection. */
  | 'admit-failed'
  // ---- both sides
  /** A handshake message did not authenticate (wrong PSK, wrong key, tampering, low-order point, …). */
  | 'handshake-failed'
  /** An unexpected frame type or a malformed frame. */
  | 'protocol'
  /** The handshake did not finish within the deadline. */
  | 'timeout'
  /** The caller's AbortSignal fired. */
  | 'cancelled'
  /** The transport closed. */
  | 'closed'
  // ---- established channel
  /** A record failed authentication, or was dropped, replayed or reordered (the nonce sequence broke). */
  | 'integrity'
  /** An application message exceeds the size limit (incoming: fatal; outgoing: thrown to the caller only). */
  | 'too-large'
  /** An `onMessage` handler threw; the channel is closed so the failure cannot go unnoticed. */
  | 'handler-error'
  /** More data arrived before any `onMessage` handler was registered than the channel buffers. */
  | 'overflow';

export type HandshakeStage = 1 | 2 | 3;

export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  /** Handshake message at which the failure was detected (1 = HELLO/msg1, 2 = REPLY/msg2, 3 = FINISH/msg3 + verdict). */
  readonly stage: HandshakeStage | undefined;
  /** For `rejected`: the opaque, authenticated reject payload the daemon's `admit` produced. */
  readonly verdict: Uint8Array | undefined;

  constructor(
    code: ChannelErrorCode,
    message: string,
    options: { stage?: HandshakeStage; verdict?: Uint8Array; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChannelError';
    this.code = code;
    this.stage = options.stage;
    this.verdict = options.verdict;
  }
}

export function isChannelError(value: unknown, code?: ChannelErrorCode): value is ChannelError {
  return value instanceof ChannelError && (code === undefined || value.code === code);
}
