// The public names of the crypto layer stay reachable from the package entry points. The barrel uses `export *`, so
// a name that another module also exports would silently disappear at runtime; this fails loudly instead.
import { describe, expect, it } from 'vitest';

const BARREL = [
  // bytes.ts
  'EMPTY_BYTES', 'concatBytes', 'equalBytes', 'utf8Encode', 'utf8Decode', 'toHex', 'fromHex', 'toBase64Url', 'fromBase64Url', 'randomBytes',
  // invite.ts
  'INVITE_SECRET_BYTES', 'INVITE_ID_BYTES', 'INVITE_PSK_BYTES', 'DAEMON_FINGERPRINT_BYTES', 'HANDSHAKE_MODE_BYTES', 'InviteLinkError',
  'daemonKeyFingerprint', 'formatFingerprintForDisplay', 'generateInviteSecret', 'deriveInviteKeys', 'buildInviteFragment',
  'parseInviteFragment', 'inviteWebOrigin', 'buildInviteUrl', 'parseInviteUrl', 'buildNoisePrologue', 'handshakeModeFromByte',
  // noise/
  'NoiseError', 'NOISE_BASE_PATTERNS', 'resolveHandshakePattern', 'nobleSuite', 'x25519KeyPair', 'chachaPolyNonce',
  'CipherState', 'SymmetricState', 'HandshakeState',
  // channel/
  'ChannelError', 'isChannelError', 'CHANNEL_FRAME', 'VERDICT', 'genericAbortFrame', 'isGenericAbortFrame', 'RecordSealer',
  'RecordOpener', 'createMemoryTransportPair', 'transportFromWebSocket', 'clientConnect', 'daemonAccept', 'MAX_CLIENT_HELLO_BYTES',
  'CNF_NONCE_BYTES', 'generateCnfNonce', 'identityCnf', 'verifyIdentityCnf',
];
const NODE = ['nodeCryptoSuite', 'withNodeCryptoAead', 'KeyFileError', 'writeKeyFile', 'readKeyFile', 'ensurePrivateDirectory',
  'loadOrCreateDaemonIdentity', 'loadDaemonIdentity', 'loadOrCreateCliDeviceKey', 'pinDaemonKey', 'readPinnedDaemonKey'];
const BROWSER = ['webCryptoX25519KeyPair', 'createDeviceKeyRecord', 'deviceKeyPairFromRecord', 'isUsableDeviceKeyRecord',
  'openIndexedDbKeyValueStore', 'createMemoryKeyValueStore', 'createDeviceKeyStore', 'createDaemonPinStore', 'KeyStoreError'];

describe('entry points expose the crypto layer', () => {
  it.each([
    ['@smurg/protocol', '../index.ts', BARREL],
    ['@smurg/protocol/node', '../node/index.ts', NODE],
    ['@smurg/protocol/browser', '../browser/index.ts', BROWSER],
  ] as const)('%s', async (_entry, path, names) => {
    const mod = (await import(path)) as Record<string, unknown>;
    expect(names.filter((name) => mod[name] === undefined)).toEqual([]);
  });
});
