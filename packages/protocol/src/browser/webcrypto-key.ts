// Adapter from a WebCrypto X25519 CryptoKeyPair (private key non-extractable) to a NoiseKeyPair. DH goes through
// the async `deriveBits`; the state machine awaits it. Runs in browsers and in Node's WebCrypto.
import type { NoiseKeyPair } from '../noise/suite.ts';

export interface WebCryptoNoiseKeyPair extends NoiseKeyPair {
  /** Whether script could export the private key. False for every key this package creates for use. */
  readonly privateExtractable: boolean;
}

/** DH with a private CryptoKey; low-order peer keys make deriveBits throw (OperationError / DataError). */
export function webCryptoDh(subtle: SubtleCrypto, privateKey: CryptoKey): (remotePublicKey: Uint8Array) => Promise<Uint8Array> {
  return async (remotePublicKey: Uint8Array): Promise<Uint8Array> => {
    const remote = await subtle.importKey('raw', remotePublicKey.slice() as Uint8Array<ArrayBuffer>, { name: 'X25519' }, true, []);
    return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: remote }, privateKey, 256));
  };
}

export async function webCryptoX25519KeyPair(
  pair: CryptoKeyPair,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<WebCryptoNoiseKeyPair> {
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKey, privateExtractable: pair.privateKey.extractable, dh: webCryptoDh(subtle, pair.privateKey) };
}
