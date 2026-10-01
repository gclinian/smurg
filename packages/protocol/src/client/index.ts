// `@smurg/protocol/client`: the client SDK used by the web app, the CLI and every test (SPEC R1, R3, §7.2;
// ARCHITECTURE §4, §6). Browser-safe: no Node built-ins; WebSocket and fetch are injected or taken from globalThis
// (test/entry-boundaries.test.ts enforces it).
export { Connection, type ConnectionOptions } from './connection.ts';
export {
  AckWindow,
  DEFAULT_TRANSFER_REQUEST_TIMEOUT_MS,
  TransferConnection,
  bitmapHas,
  missingChunks,
  uploadChunkCount,
  uploadChunkRange,
  uploadRootHash,
  waitForBufferedAmount,
  type ActiveDownload,
  type BufferedAmountOptions,
  type DownloadChunk,
  type DownloadOptions,
  type TransferConnectionOptions,
} from './transfer.ts';
export {
  DEFAULT_MAX_OUTBOX_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SILENCE_RECONNECT_MS,
  type CommonConnectionOptions,
  type ConnectionDiagnostic,
  type InviteTrust,
} from './engine.ts';
export {
  isTerminalState,
  type ConnectionCloseReason,
  type ConnectionRejectReason,
  type ConnectionState,
  type ConnectionStateKind,
  type HostOfflineReason,
  type RelayUnreachableCause,
  type RetryCause,
} from './state.ts';
export { ConnectionEndedError, describeState, waitForState, type StateSource, type WaitOptions } from './wait.ts';
export {
  isTransferTypeName,
  type ChannelClosedReason,
  type ClientKind,
  type EventHandler,
  type EventMeta,
  type InteractiveEventType,
  type InteractiveNotifyType,
  type InteractiveRequestFn,
  type InteractiveRequestType,
  type NotifyOptions,
  type RequestOptions,
  type TransferEventType,
  type TransferNotifyType,
  type TransferRequestFn,
  type TransferRequestType,
} from './message-types.ts';
export {
  CLIENT_REQUEST_FAILURES,
  ClientRequestError,
  RelayApiError,
  isClientRequestError,
  isRelayApiError,
  type ClientRequestFailure,
} from './errors.ts';
export {
  RelayApi,
  type ConnectionRelay,
  type IdentityTokenGrant,
  type RelayApiOptions,
  type RelayAuth,
  type RelayFetch,
  type RelaySession,
  type RelayUser,
  type WorkspaceClaim,
} from './relay-api.ts';
export {
  PinStoreError,
  createMemoryDeviceKeyProvider,
  createMemoryPinStore,
  createMemoryResumeStore,
  deviceKeyProviderFromStore,
  isResumeState,
  staticDeviceKeyProvider,
  type DeviceKeyProvider,
  type PinStore,
  type ResumeState,
  type ResumeStore,
} from './storage.ts';
export { RESUME_SEQ_SKIP } from './outbox.ts';
export { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.ts';
export {
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
  sendableBytes,
  type ClientWebSocket,
  type ClientWebSocketCloseEvent,
  type ClientWebSocketConstructor,
  type ClientWebSocketFactory,
  type ClientWebSocketMessageEvent,
  type HeaderWebSocketConstructor,
} from './websocket.ts';
