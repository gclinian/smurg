// Relay signing keys (Ed25519, EdDSA JWTs) and the published JWKS.
//
// RELAY_SIGNING_KEY (a secret) is either one private JWK, or `{ "keys": [ <active private JWK>, <older JWKs>… ] }`.
// The first key signs; every key is published in /.well-known/jwks.json and accepted when verifying, which is how a
// key is rotated without logging everybody out. `kid` is always the RFC 7638 thumbprint (ARCHITECTURE §6).
import {
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  createLocalJWKSet,
  importJWK,
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { isRecord } from '../lib/http.ts';

export type SigningKeys = {
  kid: string;
  privateKey: CryptoKey;
  /** Public keys only: never contains `d`. */
  jwks: { keys: JWK[] };
  keySet: JWTVerifyGetKey;
};

export class SigningKeyError extends Error {
  override readonly name = 'SigningKeyError';
}

const MAX_KEYS = 8;

let cached: { source: string; keys: Promise<SigningKeys> } | null = null;

/** Parsed keys, cached per isolate for the exact secret value (a changed secret is re-parsed). */
export function signingKeys(raw: string | undefined): Promise<SigningKeys> {
  if (!raw) return Promise.reject(new SigningKeyError('RELAY_SIGNING_KEY is not set'));
  if (cached?.source === raw) return cached.keys;
  const keys = parseSigningKeys(raw);
  const entry = { source: raw, keys };
  cached = entry;
  keys.catch(() => {
    if (cached === entry) cached = null;
  });
  return keys;
}

export async function parseSigningKeys(raw: string): Promise<SigningKeys> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SigningKeyError('RELAY_SIGNING_KEY is not JSON');
  }
  const list: unknown[] = isRecord(parsed) && Array.isArray(parsed['keys']) ? parsed['keys'] : [parsed];
  if (list.length === 0 || list.length > MAX_KEYS) throw new SigningKeyError(`expected 1..${MAX_KEYS} keys`);

  const publicJwks: JWK[] = [];
  let privateKey: CryptoKey | undefined;
  for (const [index, entry] of list.entries()) {
    if (!isRecord(entry) || entry['kty'] !== 'OKP' || entry['crv'] !== 'Ed25519' || typeof entry['x'] !== 'string') {
      throw new SigningKeyError(`key ${index} is not an Ed25519 JWK`);
    }
    const publicJwk: JWK = { kty: 'OKP', crv: 'Ed25519', x: entry['x'] };
    const kid = await calculateJwkThumbprint(publicJwk);
    if (publicJwks.some((k) => k.kid === kid)) throw new SigningKeyError(`key ${index} is listed twice`);
    publicJwks.push({ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' });
    if (index === 0) {
      if (typeof entry['d'] !== 'string') throw new SigningKeyError('the first key must be a private key');
      privateKey = await importPrivate({ ...publicJwk, d: entry['d'] });
    }
  }
  const active = publicJwks[0];
  if (!privateKey || !active?.kid) throw new SigningKeyError('no signing key');

  // A JWK whose `d` does not belong to its `x` would publish a key that verifies nothing: refuse it at load time
  // (Node's importer already notices, workerd's may not).
  const probe = await new CompactSign(new Uint8Array([0x73, 0x6d])).setProtectedHeader({ alg: 'EdDSA' }).sign(privateKey);
  try {
    await compactVerify(probe, await importJWK(active, 'EdDSA'));
  } catch {
    throw new SigningKeyError('the private key does not match its public key');
  }

  return { kid: active.kid, privateKey, jwks: { keys: publicJwks }, keySet: createLocalJWKSet({ keys: publicJwks }) };
}

async function importPrivate(jwk: JWK): Promise<CryptoKey> {
  let key: CryptoKey | Uint8Array;
  try {
    key = await importJWK(jwk, 'EdDSA');
  } catch {
    throw new SigningKeyError('the first key cannot be imported');
  }
  if (key instanceof Uint8Array) throw new SigningKeyError('the first key is not an asymmetric key');
  return key;
}
