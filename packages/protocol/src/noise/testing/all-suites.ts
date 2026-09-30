// TEST ONLY. Every DH / cipher / hash combination of the published vector files, built from @noble, so the whole
// corpus exercises the production state machine. Not reachable from any package entry point.
import { gcm } from '@noble/ciphers/aes.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { x448 } from '@noble/curves/ed448.js';
import { blake2b, blake2s } from '@noble/hashes/blake2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { chachaPolyNonce, noiseHkdf, type NoiseKeyPair, type NoiseSuite } from '../suite.ts';

type Curve = { getPublicKey(sk: Uint8Array): Uint8Array; getSharedSecret(sk: Uint8Array, pk: Uint8Array): Uint8Array; utils: { randomSecretKey(): Uint8Array } };

const CURVES: Record<string, { curve: Curve; len: number }> = {
  '25519': { curve: x25519 as unknown as Curve, len: 32 },
  '448': { curve: x448 as unknown as Curve, len: 56 },
};

/** AESGCM nonce (§12.4): 32 zero bits followed by the counter as big-endian 64-bit. */
function gcmNonce(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(n / 0x1_0000_0000), false);
  view.setUint32(8, n >>> 0, false);
  return nonce;
}

type Aead = Pick<NoiseSuite, 'encrypt' | 'decrypt'>;

const CIPHERS: Record<string, Aead> = {
  ChaChaPoly: {
    encrypt: (k, n, ad, pt) => chacha20poly1305(k, chachaPolyNonce(n), ad).encrypt(pt),
    decrypt: (k, n, ad, ct) => chacha20poly1305(k, chachaPolyNonce(n), ad).decrypt(ct),
  },
  AESGCM: {
    encrypt: (k, n, ad, pt) => gcm(k, gcmNonce(n), ad).encrypt(pt),
    decrypt: (k, n, ad, ct) => gcm(k, gcmNonce(n), ad).decrypt(ct),
  },
};

type HashFn = typeof sha256;
const HASHES: Record<string, { fn: HashFn; len: number }> = {
  BLAKE2s: { fn: blake2s as unknown as HashFn, len: 32 },
  BLAKE2b: { fn: blake2b as unknown as HashFn, len: 64 },
  SHA256: { fn: sha256, len: 32 },
  SHA512: { fn: sha512 as unknown as HashFn, len: 64 },
};

export function vectorKeyPair(dh: string, secretKey: Uint8Array): NoiseKeyPair {
  const entry = CURVES[dh];
  if (!entry) throw new Error(`unknown DH ${dh}`);
  return { publicKey: entry.curve.getPublicKey(secretKey), dh: (remote) => entry.curve.getSharedSecret(secretKey, remote) };
}

/** A suite for a vector's DH/cipher/hash names, or null when the combination is unknown. */
export function vectorSuite(dh: string, cipher: string, hash: string): NoiseSuite | null {
  const c = CURVES[dh];
  const aead = CIPHERS[cipher];
  const h = HASHES[hash];
  if (!c || !aead || !h) return null;
  return {
    name: `${dh}_${cipher}_${hash}`,
    dhLen: c.len,
    hashLen: h.len,
    generateKeyPair: () => vectorKeyPair(dh, c.curve.utils.randomSecretKey()),
    encrypt: aead.encrypt,
    decrypt: aead.decrypt,
    hash: (data) => h.fn(data),
    hkdf: (ck, ikm, outputs) => noiseHkdf(h.fn, h.len, ck, ikm, outputs),
  };
}
