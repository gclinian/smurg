// The node:crypto AEAD suite is byte-identical to noble: every published *_ChaChaPoly_* vector (all DH and hash
// combinations, 676 of them) runs through the state machine with node:crypto doing the AEAD.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it } from 'vitest';
import { EMPTY_BYTES, randomBytes, utf8Encode } from '../bytes.ts';
import { CipherState } from '../noise/state.ts';
import { chachaPolyNonce, nobleSuite } from '../noise/suite.ts';
import { loadVectorFile } from '../noise/testing/load-vectors.ts';
import { runNoiseVectors } from '../noise/testing/vectors.ts';
import { nodeChaChaPolyDecrypt, nodeChaChaPolyEncrypt, nodeCryptoSuite, withNodeCryptoAead } from './aead.ts';

describe('node:crypto ChaCha20-Poly1305 suite', () => {
  it('reproduces all 676 *_ChaChaPoly_* vectors of cacophony + snow through the state machine', { timeout: 180_000 }, async () => {
    const vectors = [...loadVectorFile('cacophony.txt').vectors, ...loadVectorFile('snow.txt').vectors].filter((v) =>
      /^Noise_[A-Za-z0-9+]+_[^_]+_ChaChaPoly_[^_]+$/.test(v.protocol_name),
    );
    expect(vectors).toHaveLength(676);
    let adapted = 0;
    const stats = await runNoiseVectors(vectors, {
      adaptSuite: (suite) => {
        adapted++;
        return withNodeCryptoAead(suite);
      },
    });
    expect(stats.failures).toEqual([]);
    expect(stats.pass).toBe(676);
    expect(adapted).toBe(676);
  });

  it('equals noble on random inputs of many sizes and decrypts noble output', () => {
    for (const size of [0, 1, 15, 16, 17, 63, 64, 65, 1000, 65_535]) {
      const key = randomBytes(32);
      const ad = randomBytes(size % 50);
      const pt = randomBytes(size);
      const n = size * 7919;
      const noble = chacha20poly1305(key, chachaPolyNonce(n), ad).encrypt(pt);
      expect(nodeChaChaPolyEncrypt(key, n, ad, pt)).toEqual(noble);
      expect(nodeChaChaPolyDecrypt(key, n, ad, noble)).toEqual(pt);
    }
  });

  it('fails closed on short, empty and tampered ciphertexts, and on a wrong nonce or AD', () => {
    const key = randomBytes(32);
    const cs = () => new CipherState(nodeCryptoSuite, key);
    for (const len of [0, 1, 15, 16]) {
      expect(() => cs().decryptWithAd(EMPTY_BYTES, new Uint8Array(len))).toThrow(/authentication tag mismatch/);
    }
    const ct = nodeChaChaPolyEncrypt(key, 3, utf8Encode('ad'), utf8Encode('hello'));
    for (let i = 0; i < ct.length; i++) {
      const bad = ct.slice();
      bad[i] = (bad[i] as number) ^ 1;
      expect(() => nodeChaChaPolyDecrypt(key, 3, utf8Encode('ad'), bad)).toThrow();
    }
    expect(() => nodeChaChaPolyDecrypt(key, 4, utf8Encode('ad'), ct)).toThrow();
    expect(() => nodeChaChaPolyDecrypt(key, 3, utf8Encode('AD'), ct)).toThrow();
  });

  it('returns plaintext in a buffer of its own', () => {
    const key = randomBytes(32);
    const pt = nodeChaChaPolyDecrypt(key, 0, EMPTY_BYTES, nodeChaChaPolyEncrypt(key, 0, EMPTY_BYTES, utf8Encode('abc')));
    expect(pt.byteOffset).toBe(0);
    expect(pt.buffer.byteLength).toBe(3);
  });

  it('keeps the noble suite name, DH and hash', () => {
    expect(nodeCryptoSuite.name).toBe(nobleSuite.name);
    expect(nodeCryptoSuite.hash).toBe(nobleSuite.hash);
    expect(() => withNodeCryptoAead({ ...nobleSuite, name: '25519_AESGCM_SHA256' })).toThrow(TypeError);
  });
});
