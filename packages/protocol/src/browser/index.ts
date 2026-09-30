// `@smurg/protocol/browser`: browser-only helpers (they also run in Node's WebCrypto for tests). Device keys and
// pinned daemon keys on IndexedDB (noise.md §1.6, device-key-v2). No Node built-ins.
export { webCryptoDh, webCryptoX25519KeyPair, type WebCryptoNoiseKeyPair } from './webcrypto-key.ts';
export {
  createDeviceKeyRecord,
  deviceKeyPairFromRecord,
  isUsableDeviceKeyRecord,
  selfTestDeviceKey,
  type CreateDeviceKeyOptions,
  type DeviceKeyKind,
  type DeviceKeyPair,
  type DeviceKeyRecord,
} from './device-key.ts';
export {
  DAEMON_PIN_STORE,
  DEVICE_KEY_STORE,
  SMURG_KEYS_DB_NAME,
  createMemoryKeyValueStore,
  openIndexedDbKeyValueStore,
  type IndexedDbKeyValueStore,
  type KeyStoreName,
  type KeyValueStore,
} from './kv.ts';
export {
  KeyStoreError,
  createDaemonPinStore,
  createDeviceKeyStore,
  type DaemonPinStore,
  type DeviceKeyStore,
  type DeviceKeyStoreOptions,
  type KeyStoreErrorCode,
  type LoadOrCreateResult,
  type LoadedDeviceKey,
} from './key-stores.ts';
