// Cipher-suite plumbing for the Noise state machine. Every primitive comes from an audited library (@noble/*) or
// the platform; this file only adapts signatures (noise.md §1.1: "we implement no primitive").
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2s } from '@noble/hashes/blake2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { EMPTY_BYTES } from '../bytes.ts';
import { NoiseError } from './errors.ts';

/**
 * A DH key pair whose private half may live anywhere: raw bytes, a non-extractable WebCrypto key, a wrapped key.
 * The state machine only ever calls `dh()`, and awaits it, so WebCrypto's async `deriveBits` works.
 */
export interface NoiseKeyPair {
  readonly publicKey: Uint8Array;
  /** Must throw (or reject) for invalid peer keys, including low-order points; never return an all-zero secret. */
  dh(remotePublicKey: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** A key pair whose secret is available as bytes (daemon, CLI, ephemerals). */
export interface RawNoiseKeyPair extends NoiseKeyPair {
  readonly secretKey: Uint8Array;
}

export interface NoiseSuite {
  /** DH, cipher and hash names as they appear in the protocol name, e.g. "25519_ChaChaPoly_BLAKE2s". */
  readonly name: string;
  readonly dhLen: number;
  readonly hashLen: number;
  generateKeyPair(): NoiseKeyPair;
  encrypt(key: Uint8Array, nonce: number, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Must throw on authentication failure. */
  decrypt(key: Uint8Array, nonce: number, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  hash(data: Uint8Array): Uint8Array;
  /** Noise HKDF (= RFC 5869 with salt = chaining key and empty info), split into `outputs` hashLen-sized blocks. */
  hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[];
}

export const X25519_KEY_BYTES = 32;

/** ChaChaPoly nonce (Noise rev 34 §12.3): 32 zero bits followed by the counter as little-endian 64-bit. */
export function chachaPolyNonce(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`invalid nonce ${n}`);
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, n >>> 0, true);
  view.setUint32(8, Math.floor(n / 0x1_0000_0000), true);
  return nonce;
}

/** Noise's HKDF over any noble hash: one RFC 5869 call with salt = ck and empty info, cut into blocks. */
export function noiseHkdf(
  hash: Parameters<typeof hkdf>[0],
  hashLen: number,
  chainingKey: Uint8Array,
  ikm: Uint8Array,
  outputs: 2 | 3,
): Uint8Array[] {
  const okm = hkdf(hash, ikm, chainingKey, EMPTY_BYTES, hashLen * outputs);
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < outputs; i++) blocks.push(okm.slice(i * hashLen, (i + 1) * hashLen));
  return blocks;
}

/** X25519 key pair on raw bytes; generates a fresh secret when none is given. */
export function x25519KeyPair(secretKey?: Uint8Array): RawNoiseKeyPair {
  const sk = secretKey ? secretKey.slice() : x25519.utils.randomSecretKey();
  if (sk.length !== X25519_KEY_BYTES) throw new RangeError('X25519 secret key must be 32 bytes');
  const publicKey = x25519.getPublicKey(sk);
  return {
    publicKey,
    secretKey: sk,
    dh(remotePublicKey: Uint8Array): Uint8Array {
      try {
        // noble rejects low-order public keys (throws) instead of returning an all-zero secret.
        return x25519.getSharedSecret(sk, remotePublicKey);
      } catch (cause) {
        throw new NoiseError('dh', 'X25519 rejected the remote public key', { cause });
      }
    },
  };
}

/** `Noise_*_25519_ChaChaPoly_BLAKE2s` on @noble. The default in browsers; the daemon swaps in node:crypto AEAD. */
export const nobleSuite: NoiseSuite = Object.freeze({
  name: '25519_ChaChaPoly_BLAKE2s',
  dhLen: 32,
  hashLen: 32,
  generateKeyPair: () => x25519KeyPair(),
  encrypt: (key: Uint8Array, nonce: number, ad: Uint8Array, plaintext: Uint8Array) =>
    chacha20poly1305(key, chachaPolyNonce(nonce), ad).encrypt(plaintext),
  decrypt: (key: Uint8Array, nonce: number, ad: Uint8Array, ciphertext: Uint8Array) =>
    chacha20poly1305(key, chachaPolyNonce(nonce), ad).decrypt(ciphertext),
  hash: (data: Uint8Array) => blake2s(data),
  hkdf: (chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3) => noiseHkdf(blake2s, 32, chainingKey, ikm, outputs),
});
