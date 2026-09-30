// Errors of the Noise state machine. Codes are for logs and tests only; nothing here is ever sent to a peer.

export type NoiseErrorCode =
  | 'bad-pattern' // unknown pattern or modifier
  | 'bad-config' // missing keys, wrong PSK count or size
  | 'state' // call out of turn, after failure, after completion, or concurrently
  | 'decrypt' // AEAD authentication failed
  | 'dh' // the DH primitive refused the peer's key (e.g. a low-order point)
  | 'nonce-exhausted'
  | 'too-large' // a handshake message above 65535 bytes
  | 'short'; // a handshake message too short for its tokens

export class NoiseError extends Error {
  readonly code: NoiseErrorCode;

  constructor(code: NoiseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoiseError';
    this.code = code;
  }
}
