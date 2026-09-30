import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { concatBytes, utf8Encode } from '../bytes.ts';
import { generateCnfNonce, identityCnf, verifyIdentityCnf } from './identity-binding.ts';

describe('identity binding (cnf)', () => {
  it('is base64url(SHA-256("smurg-cnf" ‖ n ‖ device key)), cross-checked with OpenSSL', () => {
    const n = generateCnfNonce();
    const key = new Uint8Array(32).fill(7);
    const cnf = identityCnf(n, key);
    expect(cnf).toBe(createHash('sha256').update(concatBytes(utf8Encode('smurg-cnf'), n, key)).digest('base64url'));
    expect(cnf).toHaveLength(43);
    expect(verifyIdentityCnf(cnf, n, key)).toBe(true);
  });

  it('fails for another key, another nonce, or a malformed claim', () => {
    const n = generateCnfNonce();
    const key = new Uint8Array(32).fill(7);
    const cnf = identityCnf(n, key);
    expect(verifyIdentityCnf(cnf, n, new Uint8Array(32).fill(8))).toBe(false);
    expect(verifyIdentityCnf(cnf, generateCnfNonce(), key)).toBe(false);
    expect(verifyIdentityCnf(undefined, n, key)).toBe(false);
    expect(verifyIdentityCnf(cnf, n.subarray(1), key)).toBe(false);
    expect(() => identityCnf(new Uint8Array(16), key)).toThrow(RangeError);
  });
});
