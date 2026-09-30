// Encrypted channel: frames, DATA records, transports and the v2 handshake drivers (ARCHITECTURE §4, §4.2;
// noise.md Verification V-C). Hello, verdict and application messages are opaque bytes here; their msgpack encoding
// belongs to ../codec.ts. Browser-safe: no Node built-ins.
export { ChannelError, isChannelError, type ChannelErrorCode, type HandshakeStage } from './errors.ts';
export {
  CHANNEL_FRAME,
  HANDSHAKE_WIRE_VERSION,
  MAX_HANDSHAKE_FRAME_BYTES,
  VERDICT,
  genericAbortFrame,
  isGenericAbortFrame,
  type ChannelFrameType,
} from './frames.ts';
export { RecordOpener, RecordSealer } from './records.ts';
export {
  createMemoryTransportPair,
  transportFromWebSocket,
  type MemoryDirection,
  type MemoryTransportPair,
  type MemoryTransportPairOptions,
  type Transport,
  type TransportCloseEvent,
  type WebSocketLike,
  type WebSocketTransportOptions,
} from './transport.ts';
export type { ChannelCloseEvent, SecureChannel } from './secure-channel.ts';
export {
  MAX_CLIENT_HELLO_BYTES,
  clientConnect,
  daemonAccept,
  type AdmitContext,
  type AdmitDecision,
  type ClientConnectOptions,
  type ClientConnectResult,
  type ClientTrust,
  type DaemonAcceptOptions,
  type DaemonAcceptResult,
  type DaemonInviteKey,
} from './handshake.ts';
export { CNF_NONCE_BYTES, generateCnfNonce, identityCnf, verifyIdentityCnf } from './identity-binding.ts';
