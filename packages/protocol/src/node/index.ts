// `@smurg/protocol/node`: Node-only helpers for the daemon and the CLI. Never imported by browser code.
export { nodeChaChaPolyDecrypt, nodeChaChaPolyEncrypt, nodeCryptoSuite, withNodeCryptoAead } from './aead.ts';
export {
  KeyFileError,
  ensurePrivateDirectory,
  readKeyFile,
  writeKeyFile,
  type KeyFileErrorCode,
  type WriteKeyFileOptions,
} from './key-file.ts';
export {
  CLI_DEVICE_KEY_FILE,
  DAEMON_IDENTITY_KEY_FILE,
  DAEMON_PIN_DIR,
  loadDaemonIdentity,
  loadOrCreateCliDeviceKey,
  loadOrCreateDaemonIdentity,
  loadOrCreateStaticKey,
  loadStaticKey,
  pinDaemonKey,
  readPinnedDaemonKey,
  type LoadedStaticKey,
  type PinDaemonKeyOptions,
} from './identity.ts';
