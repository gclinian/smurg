// Noise rev-34 state machine and suites on @noble/* (ARCHITECTURE §4.2, docs/research/noise.md).
// Browser-safe: nothing here may import a Node built-in (the node:crypto AEAD suite lives in ../node/).
export { NoiseError, type NoiseErrorCode } from './errors.ts';
export {
  NOISE_BASE_PATTERNS,
  applyPskModifiers,
  parseHandshakePattern,
  resolveHandshakePattern,
  type HandshakePattern,
  type NoisePreToken,
  type NoiseToken,
} from './patterns.ts';
export {
  X25519_KEY_BYTES,
  chachaPolyNonce,
  nobleSuite,
  noiseHkdf,
  x25519KeyPair,
  type NoiseKeyPair,
  type NoiseSuite,
  type RawNoiseKeyPair,
} from './suite.ts';
export {
  CipherState,
  HandshakeState,
  SymmetricState,
  type HandshakeOptions,
  type TransportKeys,
} from './state.ts';
