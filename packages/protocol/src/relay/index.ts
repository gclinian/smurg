// `@smurg/protocol/relay`: everything the relay Worker shares with daemon, CLI and web.
// It must not depend on the crypto code (ARCHITECTURE §1): only zod and ../constants.ts are allowed here, which
// test/entry-boundaries.test.ts enforces.
export * from './binary.ts';
export * from './close-codes.ts';
export * from './device-login.ts';
export * from './frames.ts';
export * from './http.ts';
export * from './routes.ts';
export {
  CLOSE_REASON_MAX_BYTES,
  HOST_OFFLINE_DEADLINE_MS,
  IDENTITY_CNF_MEMBER,
  IDENTITY_TOKEN_AUDIENCE_PREFIX,
  IDENTITY_TOKEN_TTL_SECONDS,
  IDENTITY_TOKEN_TYP,
  MAX_RELAY_FRAME,
  PONG_WATCHDOG_MS,
  RELAY_CLIENT_SWEEP_MS,
  RELAY_CONN_PREFIX_BYTES,
  RELAY_CONTROL_MAX_CHARS,
  RELAY_HOST_TIMEOUT_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_PLATFORM_MAX_MESSAGE,
  WORKSPACE_ID_MAX_LENGTH,
  WORKSPACE_ID_MIN_LENGTH,
} from '../constants.ts';
