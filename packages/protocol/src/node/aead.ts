// node:crypto (OpenSSL) ChaCha20-Poly1305 behind the NoiseSuite interface: about 6x less CPU than noble for the
// daemon's bulk traffic (noise.md §1.5). Byte-identical to noble; aead.test.ts proves it by running every published
// *_ChaChaPoly_* vector through the state machine with this AEAD.
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { NOISE_TAG_BYTES } from '../constants.ts';
import { chachaPolyNonce, nobleSuite, type NoiseSuite } from '../noise/suite.ts';

const ALGORITHM = 'chacha20-poly1305';

export function nodeChaChaPolyEncrypt(key: Uint8Array, nonce: number, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = createCipheriv(ALGORITHM, key, chachaPolyNonce(nonce), { authTagLength: NOISE_TAG_BYTES });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  const body = cipher.update(plaintext);
  const tail = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(body.length + tail.length + tag.length);
  out.set(body, 0);
  out.set(tail, body.length);
  out.set(tag, body.length + tail.length);
  return out;
}

/** Throws on authentication failure (including ciphertexts shorter than the tag). Returns a fresh buffer. */
export function nodeChaChaPolyDecrypt(key: Uint8Array, nonce: number, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length < NOISE_TAG_BYTES) throw new Error('ciphertext shorter than the authentication tag');
  const bodyLength = ciphertext.length - NOISE_TAG_BYTES;
  const decipher = createDecipheriv(ALGORITHM, key, chachaPolyNonce(nonce), { authTagLength: NOISE_TAG_BYTES });
  decipher.setAAD(ad, { plaintextLength: bodyLength });
  decipher.setAuthTag(ciphertext.subarray(bodyLength));
  const body = decipher.update(ciphertext.subarray(0, bodyLength));
  const tail = decipher.final(); // throws when the tag does not verify
  // Copy out of the Buffers (which may be slices of a shared pool) into a plaintext buffer of our own.
  const out = new Uint8Array(body.length + tail.length);
  out.set(body, 0);
  out.set(tail, body.length);
  return out;
}

/** Any suite with its AEAD replaced by node:crypto ChaCha20-Poly1305 (the suite's cipher must be ChaChaPoly). */
export function withNodeCryptoAead(base: NoiseSuite): NoiseSuite {
  if (!base.name.includes('_ChaChaPoly_')) throw new TypeError(`suite ${base.name} does not use ChaChaPoly`);
  return Object.freeze({ ...base, encrypt: nodeChaChaPolyEncrypt, decrypt: nodeChaChaPolyDecrypt });
}

/** `25519_ChaChaPoly_BLAKE2s` with node:crypto AEAD. X25519 and BLAKE2s stay on noble. Use on the daemon and CLI. */
export const nodeCryptoSuite: NoiseSuite = withNodeCryptoAead(nobleSuite);
