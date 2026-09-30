// Browser device-key records (noise.md §1.6 and Verification V-C, device-key-v2.ts).
//
// Measured in Chrome 153, Firefox 155 and WebKit 26.6:
//  * Chromium/Firefox store a non-extractable X25519 CryptoKeyPair in IndexedDB and post it to Workers.
//  * WebKit cannot structured-clone X25519 CryptoKeys at all: structuredClone throws, IndexedDB get() returns null,
//    postMessage fires `messageerror`. AES keys clone fine.
//  * "Non-extractable" only stops script from EXPORTING a key. Chromium and Firefox write the raw key bytes into the
//    profile's IndexedDB files in cleartext: this is NOT encryption at rest and must never be described as such.
//
// So one of three record kinds is chosen at creation by a structuredClone probe:
//  'webcrypto'  non-extractable X25519 CryptoKeyPair stored as is. Same-origin script can use it, never export it.
//  'wrapped'    (WebKit) non-extractable AES-GCM key-encryption key + wrapKey('pkcs8') ciphertext; every load
//               unwraps with extractable=false. Weaker against XSS: same-origin script could unwrap as extractable.
//  'raw'        no WebCrypto X25519: noble secret bytes.
// Every record read back from storage is re-validated (isUsableDeviceKeyRecord) and self-tested before use.
import { x25519 } from '@noble/curves/ed25519.js';
import { equalBytes } from '../bytes.ts';
import { x25519KeyPair, type NoiseKeyPair } from '../noise/suite.ts';
import { webCryptoDh, webCryptoX25519KeyPair } from './webcrypto-key.ts';

export type DeviceKeyKind = 'webcrypto' | 'wrapped' | 'raw';

export type DeviceKeyRecord =
  | { readonly kind: 'webcrypto'; readonly pair: CryptoKeyPair }
  | {
      readonly kind: 'wrapped';
      readonly kek: CryptoKey;
      readonly iv: Uint8Array;
      readonly wrapped: Uint8Array;
      readonly publicKey: Uint8Array;
    }
  | { readonly kind: 'raw'; readonly secretKey: Uint8Array };

export interface DeviceKeyPair extends NoiseKeyPair {
  readonly kind: DeviceKeyKind;
  /** False for 'webcrypto' and 'wrapped' (the key in use cannot be exported); 'raw' keys are plain bytes. */
  readonly privateExtractable: boolean;
}

const AES_GCM_IV_BYTES = 12;

/** Proves the key pair really does X25519 with its advertised public key (catches corrupted or mismatched records). */
export async function selfTestDeviceKey(keyPair: NoiseKeyPair): Promise<void> {
  const probe = x25519.utils.randomSecretKey();
  const ours = await keyPair.dh(x25519.getPublicKey(probe));
  const expected = x25519.getSharedSecret(probe, keyPair.publicKey);
  if (!equalBytes(ours, expected)) throw new Error('device key self-test failed');
}

function structuredCloneWorks(value: unknown): boolean {
  try {
    return structuredClone(value) != null;
  } catch {
    return false;
  }
}

export interface CreateDeviceKeyOptions {
  /** TEST ONLY: take the WebKit path even where X25519 keys can be cloned. */
  forceWrapped?: boolean;
}

/** Creates the strongest record the platform supports. Never throws: without WebCrypto X25519 it returns 'raw'. */
export async function createDeviceKeyRecord(
  subtle: SubtleCrypto = globalThis.crypto.subtle,
  options: CreateDeviceKeyOptions = {},
): Promise<DeviceKeyRecord> {
  try {
    const pair = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
    await selfTestDeviceKey(await webCryptoX25519KeyPair(pair, subtle));
    if (!options.forceWrapped && structuredCloneWorks(pair)) return { kind: 'webcrypto', pair };
    // X25519 works but cannot be persisted as a CryptoKey (WebKit): wrap a fresh key under a non-extractable AES key.
    const kek = (await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])) as CryptoKey;
    const temporary = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const wrapped = new Uint8Array(await subtle.wrapKey('pkcs8', temporary.privateKey, kek, { name: 'AES-GCM', iv }));
    const publicKey = new Uint8Array(await subtle.exportKey('raw', temporary.publicKey));
    const record: DeviceKeyRecord = { kind: 'wrapped', kek, iv, wrapped, publicKey };
    await selfTestDeviceKey(await deviceKeyPairFromRecord(record, subtle));
    return record;
  } catch {
    return { kind: 'raw', secretKey: x25519.utils.randomSecretKey() };
  }
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

function isBytes(value: unknown, length?: number): value is Uint8Array {
  return value instanceof Uint8Array && (length === undefined ? value.length > 0 : value.length === length);
}

/**
 * Structural re-validation of a record read back from storage. A platform that could not clone a CryptoKey yields
 * null inside the record (WebKit), which this rejects. It checks algorithms, key types and non-extractability too.
 */
export function isUsableDeviceKeyRecord(value: unknown): value is DeviceKeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  switch (r['kind']) {
    case 'raw':
      return isBytes(r['secretKey'], 32);
    case 'webcrypto': {
      const pair = r['pair'] as Partial<CryptoKeyPair> | null | undefined;
      if (!pair || !isCryptoKey(pair.privateKey) || !isCryptoKey(pair.publicKey)) return false;
      return (
        pair.privateKey.algorithm.name === 'X25519' &&
        pair.publicKey.algorithm.name === 'X25519' &&
        pair.privateKey.type === 'private' &&
        pair.publicKey.type === 'public' &&
        pair.privateKey.extractable === false &&
        pair.privateKey.usages.includes('deriveBits')
      );
    }
    case 'wrapped': {
      const kek = r['kek'];
      return (
        isCryptoKey(kek) &&
        kek.algorithm.name === 'AES-GCM' &&
        kek.extractable === false &&
        kek.usages.includes('unwrapKey') &&
        isBytes(r['iv'], AES_GCM_IV_BYTES) &&
        isBytes(r['wrapped']) &&
        isBytes(r['publicKey'], 32)
      );
    }
    default:
      return false;
  }
}

/** Turns a (validated) record into a key pair for the handshake. */
export async function deviceKeyPairFromRecord(
  record: DeviceKeyRecord,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<DeviceKeyPair> {
  if (record.kind === 'raw') {
    const raw = x25519KeyPair(record.secretKey);
    return { kind: 'raw', publicKey: raw.publicKey, privateExtractable: true, dh: raw.dh };
  }
  if (record.kind === 'webcrypto') {
    const pair = await webCryptoX25519KeyPair(record.pair, subtle);
    return { kind: 'webcrypto', publicKey: pair.publicKey, privateExtractable: pair.privateExtractable, dh: pair.dh };
  }
  const privateKey = await subtle.unwrapKey(
    'pkcs8',
    record.wrapped.slice() as Uint8Array<ArrayBuffer>,
    record.kek,
    { name: 'AES-GCM', iv: record.iv.slice() as Uint8Array<ArrayBuffer> },
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
  return { kind: 'wrapped', publicKey: record.publicKey.slice(), privateExtractable: privateKey.extractable, dh: webCryptoDh(subtle, privateKey) };
}
