// Noise Protocol Framework state machine, revision 34 (§5 processing rules, §7 patterns, §9 PSK).
// Only the state machine lives here; primitives come from a NoiseSuite. Validated byte for byte against the complete
// cacophony and snow vector corpora (noise.vectors.*.test.ts). Ported from the verified spike (noise.md Appendix A).
//
// Safety properties the drivers rely on:
//  * single use and fail closed: any error poisons the HandshakeState and every later call throws;
//  * no concurrent calls (a second call while an async DH is pending throws);
//  * a failed decryption never advances a nonce.
import { NOISE_MAX_MESSAGE_BYTES, NOISE_TAG_BYTES } from '../constants.ts';
import { EMPTY_BYTES, concatBytes, utf8Encode } from '../bytes.ts';
import { NoiseError } from './errors.ts';
import type { HandshakePattern, NoisePreToken, NoiseToken } from './patterns.ts';
import type { NoiseKeyPair, NoiseSuite } from './suite.ts';

/** The spec reserves 2^64-1; JS numbers are exact only up to 2^53-1. Unreachable in practice (rekey not needed). */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;
const CIPHER_KEY_BYTES = 32;

export class CipherState {
  private readonly suite: NoiseSuite;
  private k: Uint8Array | null;
  private n = 0;

  constructor(suite: NoiseSuite, key: Uint8Array | null = null) {
    this.suite = suite;
    this.k = key;
  }

  initializeKey(key: Uint8Array | null): void {
    this.k = key;
    this.n = 0;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  /** The next nonce to be used (for tests and diagnostics). */
  get nonce(): number {
    return this.n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError('nonce-exhausted', 'nonce exhausted; re-handshake');
    const ciphertext = this.suite.encrypt(this.k, this.n, ad, plaintext);
    this.n++;
    return ciphertext;
  }

  /** Throws NoiseError('decrypt') on authentication failure; the nonce is NOT advanced then (§5.1). */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError('nonce-exhausted', 'nonce exhausted; re-handshake');
    let plaintext: Uint8Array;
    try {
      plaintext = this.suite.decrypt(this.k, this.n, ad, ciphertext);
    } catch (cause) {
      throw new NoiseError('decrypt', 'authentication tag mismatch', { cause });
    }
    this.n++;
    return plaintext;
  }
}

export class SymmetricState {
  readonly suite: NoiseSuite;
  readonly cipher: CipherState;
  private ck: Uint8Array;
  private h: Uint8Array;

  constructor(suite: NoiseSuite, protocolName: string) {
    this.suite = suite;
    const name = utf8Encode(protocolName);
    if (name.length <= suite.hashLen) {
      this.h = new Uint8Array(suite.hashLen);
      this.h.set(name);
    } else {
      this.h = suite.hash(name);
    }
    this.ck = this.h.slice();
    this.cipher = new CipherState(suite);
  }

  /** Hashes with HASHLEN 64 produce 64-byte temp keys; the cipher key is their first 32 bytes (§5.2). */
  private cipherKey(k: Uint8Array): Uint8Array {
    return k.length === CIPHER_KEY_BYTES ? k : k.slice(0, CIPHER_KEY_BYTES);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = this.suite.hkdf(this.ck, ikm, 2) as [Uint8Array, Uint8Array];
    this.ck = ck;
    this.cipher.initializeKey(this.cipherKey(tempK));
  }

  mixHash(data: Uint8Array): void {
    this.h = this.suite.hash(concatBytes(this.h, data));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = this.suite.hkdf(this.ck, ikm, 3) as [Uint8Array, Uint8Array, Uint8Array];
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher.initializeKey(this.cipherKey(tempK));
  }

  get handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = this.suite.hkdf(this.ck, EMPTY_BYTES, 2) as [Uint8Array, Uint8Array];
    return [new CipherState(this.suite, this.cipherKey(k1)), new CipherState(this.suite, this.cipherKey(k2))];
  }
}

export interface HandshakeOptions {
  suite: NoiseSuite;
  pattern: HandshakePattern;
  initiator: boolean;
  prologue?: Uint8Array;
  /** Local static key pair (may be a non-extractable WebCrypto key: DH is awaited). */
  s?: NoiseKeyPair;
  /** Fixed local ephemeral. TEST VECTORS ONLY: a reused ephemeral destroys the handshake's security. */
  e?: NoiseKeyPair;
  /** Remote static public key known in advance (pre-message patterns such as IK, KK). */
  rs?: Uint8Array;
  /** Remote ephemeral known in advance (pre-message patterns only). */
  re?: Uint8Array;
  psks?: readonly Uint8Array[];
}

export interface TransportKeys {
  /** CipherState for messages this side sends. */
  readonly send: CipherState;
  /** CipherState for messages this side receives. */
  readonly recv: CipherState;
  readonly handshakeHash: Uint8Array;
  readonly remoteStatic: Uint8Array | null;
}

export class HandshakeState {
  readonly protocolName: string;
  private readonly symmetric: SymmetricState;
  private readonly suite: NoiseSuite;
  private readonly pattern: HandshakePattern;
  private readonly initiator: boolean;
  private readonly isPsk: boolean;
  private readonly psks: Uint8Array[];
  private readonly s: NoiseKeyPair | undefined;
  private e: NoiseKeyPair | undefined;
  private rs: Uint8Array | undefined;
  private re: Uint8Array | undefined;
  private msgIndex = 0;
  private failed = false;
  private busy = false;
  private result: TransportKeys | null = null;

  constructor(options: HandshakeOptions) {
    this.suite = options.suite;
    this.pattern = options.pattern;
    this.initiator = options.initiator;
    this.s = options.s;
    this.e = options.e;
    this.rs = options.rs?.slice();
    this.re = options.re?.slice();
    this.psks = (options.psks ?? []).map((p) => p.slice());
    const pskTokens = this.pattern.messages.flat().filter((t) => t === 'psk').length;
    this.isPsk = pskTokens > 0;
    if (this.psks.length !== pskTokens) {
      throw new NoiseError('bad-config', `pattern needs ${pskTokens} psk(s), got ${this.psks.length}`);
    }
    for (const psk of this.psks) if (psk.length !== 32) throw new NoiseError('bad-config', 'psk must be 32 bytes');

    this.protocolName = `Noise_${this.pattern.name}_${this.suite.name}`;
    this.symmetric = new SymmetricState(this.suite, this.protocolName);
    this.symmetric.mixHash(options.prologue ?? EMPTY_BYTES);
    // Pre-messages: the initiator's first, then the responder's (§7.1).
    this.mixPreMessage(this.pattern.initiatorPre, this.initiator);
    this.mixPreMessage(this.pattern.responderPre, !this.initiator);
  }

  private mixPreMessage(tokens: readonly NoisePreToken[], mine: boolean): void {
    for (const token of tokens) {
      const key = token === 's' ? (mine ? this.s?.publicKey : this.rs) : mine ? this.e?.publicKey : this.re;
      if (!key) throw new NoiseError('bad-config', `missing pre-message key ${token}`);
      this.symmetric.mixHash(key);
      if (token === 'e' && this.isPsk) this.symmetric.mixKey(key);
    }
  }

  get isComplete(): boolean {
    return this.result !== null;
  }

  /** Remote static public key once learned (or pre-known). Unauthenticated until the message carrying it is fully processed. */
  get remoteStatic(): Uint8Array | null {
    return this.rs ? this.rs.slice() : null;
  }

  get handshakeHash(): Uint8Array {
    return this.symmetric.handshakeHash;
  }

  /** True when this side must call writeMessage next. */
  get isMyTurn(): boolean {
    return !this.isComplete && (this.msgIndex % 2 === 0) === this.initiator;
  }

  get messageIndex(): number {
    return this.msgIndex;
  }

  /** Transport keys; available only after the last handshake message. */
  split(): TransportKeys {
    if (!this.result) throw new NoiseError('state', 'handshake not complete');
    return this.result;
  }

  private enter(write: boolean): readonly NoiseToken[] {
    if (this.failed) throw new NoiseError('state', 'handshake already failed');
    if (this.busy) throw new NoiseError('state', 'concurrent handshake call');
    if (this.isComplete) throw new NoiseError('state', 'handshake already complete');
    if (this.isMyTurn !== write) throw new NoiseError('state', write ? 'not our turn to write' : 'not our turn to read');
    const tokens = this.pattern.messages[this.msgIndex];
    if (!tokens) throw new NoiseError('state', 'no more handshake messages');
    this.busy = true;
    return tokens;
  }

  private async dh(local: NoiseKeyPair | undefined, remote: Uint8Array | undefined): Promise<Uint8Array> {
    if (!local || !remote) throw new NoiseError('bad-config', 'missing key for DH');
    try {
      return await local.dh(remote);
    } catch (cause) {
      if (cause instanceof NoiseError) throw cause;
      throw new NoiseError('dh', 'DH failed', { cause });
    }
  }

  private async mixToken(token: NoiseToken): Promise<void> {
    switch (token) {
      case 'ee':
        this.symmetric.mixKey(await this.dh(this.e, this.re));
        return;
      case 'es':
        this.symmetric.mixKey(this.initiator ? await this.dh(this.e, this.rs) : await this.dh(this.s, this.re));
        return;
      case 'se':
        this.symmetric.mixKey(this.initiator ? await this.dh(this.s, this.re) : await this.dh(this.e, this.rs));
        return;
      case 'ss':
        this.symmetric.mixKey(await this.dh(this.s, this.rs));
        return;
      case 'psk': {
        const psk = this.psks.shift();
        if (!psk) throw new NoiseError('bad-config', 'psk missing');
        this.symmetric.mixKeyAndHash(psk);
        return;
      }
      default:
        throw new NoiseError('bad-pattern', `unexpected token ${token}`);
    }
  }

  private finishMessage(): void {
    this.msgIndex++;
    if (this.msgIndex === this.pattern.messages.length) {
      const [c1, c2] = this.symmetric.split();
      this.result = {
        send: this.initiator ? c1 : c2,
        recv: this.initiator ? c2 : c1,
        handshakeHash: this.symmetric.handshakeHash,
        remoteStatic: this.rs ? this.rs.slice() : null,
      };
    }
  }

  async writeMessage(payload: Uint8Array = EMPTY_BYTES): Promise<Uint8Array> {
    const tokens = this.enter(true);
    try {
      const parts: Uint8Array[] = [];
      for (const token of tokens) {
        if (token === 'e') {
          if (!this.e) this.e = this.suite.generateKeyPair();
          parts.push(this.e.publicKey);
          this.symmetric.mixHash(this.e.publicKey);
          if (this.isPsk) this.symmetric.mixKey(this.e.publicKey);
        } else if (token === 's') {
          if (!this.s) throw new NoiseError('bad-config', 'local static key required');
          parts.push(this.symmetric.encryptAndHash(this.s.publicKey));
        } else {
          await this.mixToken(token);
        }
      }
      parts.push(this.symmetric.encryptAndHash(payload));
      const message = concatBytes(...parts);
      if (message.length > NOISE_MAX_MESSAGE_BYTES) throw new NoiseError('too-large', 'handshake message exceeds 65535 bytes');
      this.finishMessage();
      return message;
    } catch (err) {
      this.failed = true;
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Processes one handshake message and returns its decrypted payload. `onRemoteStatic` runs as soon as the remote
   * static key is decrypted, BEFORE the rest of the message is verified: the key is not yet authenticated, so the hook
   * may only be used to reject (the client's pin check), never to grant anything.
   */
  async readMessage(
    message: Uint8Array,
    onRemoteStatic?: (remoteStatic: Uint8Array) => void | Promise<void>,
  ): Promise<Uint8Array> {
    const tokens = this.enter(false);
    try {
      if (message.length > NOISE_MAX_MESSAGE_BYTES) throw new NoiseError('too-large', 'handshake message exceeds 65535 bytes');
      let offset = 0;
      const take = (n: number): Uint8Array => {
        if (offset + n > message.length) throw new NoiseError('short', 'handshake message too short');
        const bytes = message.subarray(offset, offset + n);
        offset += n;
        return bytes;
      };
      for (const token of tokens) {
        if (token === 'e') {
          this.re = take(this.suite.dhLen).slice();
          this.symmetric.mixHash(this.re);
          if (this.isPsk) this.symmetric.mixKey(this.re);
        } else if (token === 's') {
          const length = this.suite.dhLen + (this.symmetric.cipher.hasKey() ? NOISE_TAG_BYTES : 0);
          this.rs = this.symmetric.decryptAndHash(take(length)).slice();
          if (onRemoteStatic) await onRemoteStatic(this.rs.slice());
        } else {
          await this.mixToken(token);
        }
      }
      const payload = this.symmetric.decryptAndHash(message.subarray(offset));
      this.finishMessage();
      return payload;
    } catch (err) {
      this.failed = true;
      throw err;
    } finally {
      this.busy = false;
    }
  }
}
