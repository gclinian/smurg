// Binds the relay-signed identity token to the device key without giving the relay a stable device id
// (ARCHITECTURE §4.2): cnf = SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey). The client sends `cnf` to the relay
// when asking for the token and `n` inside the encrypted ClientHello; admit() recomputes it from the AUTHENTICATED
// static key. A fresh `n` per token keeps cnf unlinkable across tokens.
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, equalBytes, randomBytes, toBase64Url, utf8Encode } from '../bytes.ts';

export const CNF_NONCE_BYTES = 32;
const CNF_LABEL = utf8Encode('smurg-cnf');

export function generateCnfNonce(): Uint8Array {
  return randomBytes(CNF_NONCE_BYTES);
}

/** The `cnf` claim as base64url without padding (43 characters). */
export function identityCnf(nonce: Uint8Array, deviceStaticPublicKey: Uint8Array): string {
  if (!(nonce instanceof Uint8Array) || nonce.length !== CNF_NONCE_BYTES) throw new RangeError(`cnf nonce must be ${CNF_NONCE_BYTES} bytes`);
  if (!(deviceStaticPublicKey instanceof Uint8Array) || deviceStaticPublicKey.length !== 32) {
    throw new RangeError('device static public key must be 32 bytes');
  }
  return toBase64Url(sha256(concatBytes(CNF_LABEL, nonce, deviceStaticPublicKey)));
}

/** Constant-time check of a token's `cnf` claim against the nonce and the authenticated device key. */
export function verifyIdentityCnf(cnf: unknown, nonce: Uint8Array, deviceStaticPublicKey: Uint8Array): boolean {
  if (typeof cnf !== 'string') return false;
  let expected: string;
  try {
    expected = identityCnf(nonce, deviceStaticPublicKey);
  } catch {
    return false;
  }
  return equalBytes(utf8Encode(cnf), utf8Encode(expected));
}
