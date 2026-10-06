// Wire-contract constants shared by protocol, daemon, cli, web and relay.
//
// This module has NO imports: the relay Worker, browsers and Node all load it, and `@smurg/protocol/relay` depends on
// it. Every value is part of the protocol; changing one is a protocol change (bump PROTOCOL_VERSION when peers of
// different builds could disagree). Relationships between the values are asserted in constants.test.ts.

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

// ---------------------------------------------------------------------------------------------------------------
// Versions and tags
// ---------------------------------------------------------------------------------------------------------------

/**
 * Version of the encrypted application protocol, sent in `ClientHello.protocolVersion` (ARCHITECTURE §4.2, §4.3).
 * 4 since agent sessions are conversations (smurg 0.5.0): `SessionInfo` is a union of terminal and agent sessions,
 * and topics, plans, result reports, questions, permission requests and the inbox joined the catalog. A daemon
 * answers another version with the verdict `version`; there is no compatibility code.
 */
export const PROTOCOL_VERSION = 4;

/** Leading bytes of every Noise prologue: `"smurg-noise/1" ‖ 0x00 ‖ u8 len(workspaceId) ‖ workspaceId ‖ …`. */
export const NOISE_PROLOGUE_TAG = 'smurg-noise/1';

// ---------------------------------------------------------------------------------------------------------------
// Noise transport framing (ARCHITECTURE §4.2, noise.md §1.5)
//   DATA frame = [0x10] { [u16be len][noise transport message] }+ ; record plaintext = [flags u8][body]
// ---------------------------------------------------------------------------------------------------------------

/** Largest Noise message (handshake or transport), fixed by the Noise specification. */
export const NOISE_MAX_MESSAGE_BYTES = 65_535;
/** ChaCha20-Poly1305 authentication tag appended to every transport message. */
export const NOISE_TAG_BYTES = 16;
/** First plaintext byte of a record; bit 0 is FIN (last record of an application message). */
export const RECORD_FLAGS_BYTES = 1;
/** u16be length that precedes each record inside a DATA frame. */
export const RECORD_LENGTH_BYTES = 2;
/** Frame type byte in front of every WebSocket binary message of a channel (HELLO, REPLY, FINISH, DATA, ABORT). */
export const FRAME_TYPE_BYTES = 1;
/** Largest application payload carried by one record: 65535 - 16 - 1 = 65518. */
export const MAX_RECORD_BODY = NOISE_MAX_MESSAGE_BYTES - NOISE_TAG_BYTES - RECORD_FLAGS_BYTES;
/** Bytes a record adds around its body: length prefix + flags + tag = 19. */
export const RECORD_OVERHEAD_BYTES = RECORD_LENGTH_BYTES + RECORD_FLAGS_BYTES + NOISE_TAG_BYTES;

/** Number of records one application message of `appMessageBytes` is split into (an empty message still takes one). */
export function noiseRecordCount(appMessageBytes: number): number {
  assertByteCount(appMessageBytes);
  return Math.max(1, Math.ceil(appMessageBytes / MAX_RECORD_BODY));
}

/** Size of the single DATA frame (one WebSocket message) that carries an application message of `appMessageBytes`. */
export function noiseDataFrameBytes(appMessageBytes: number): number {
  return FRAME_TYPE_BYTES + noiseRecordCount(appMessageBytes) * RECORD_OVERHEAD_BYTES + appMessageBytes;
}

function assertByteCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`byte count must be a non-negative safe integer, got ${n}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Transfers (ARCHITECTURE §5.2 transfer channel, transfer.md §1.2)
// ---------------------------------------------------------------------------------------------------------------

/** Upload/download chunk size used unless the host changes `PublicSettings.uploadChunkSize`. */
export const DEFAULT_CHUNK_SIZE = 4 * MiB;
/** Smallest chunk size a peer accepts. */
export const MIN_CHUNK_SIZE = 1 * MiB;
/** Largest chunk size a peer accepts; one chunk plus its Envelope must fit in MAX_APP_MESSAGE. */
export const MAX_CHUNK_SIZE = 8 * MiB;
/** SHA-256 digest carried per chunk and in the upload root hash. */
export const CHUNK_HASH_BYTES = 32;
/**
 * Most chunk hashes returned by one `file.upload.hashes` reply (4 MiB of hashes). Unbounded uploads (D15) would
 * otherwise exceed MSGPACK_MAX_BIN_LENGTH at about 1.1 TiB (transfer.md §1.3).
 */
export const UPLOAD_HASHES_PAGE_MAX = 131_072;
/** End-to-end ack window: at most this many un-acknowledged chunks per transfer. */
export const TRANSFER_WINDOW_CHUNKS = 4;
/** Browser sender pauses while `WebSocket.bufferedAmount` is above this. */
export const TRANSFER_BUFFERED_AMOUNT_MAX = 8 * MiB;
/** Poll interval for `bufferedAmount` (WebSocket has no drain event). */
export const TRANSFER_BUFFERED_POLL_MS = 5;

// ---------------------------------------------------------------------------------------------------------------
// Message and frame limits
// ---------------------------------------------------------------------------------------------------------------

/**
 * Largest decrypted application message (one msgpack Envelope). The channel's reassembly cap. An upload chunk of
 * MAX_CHUNK_SIZE with its Envelope (a few hundred bytes) fits with 32 KiB to spare.
 */
export const MAX_APP_MESSAGE = MAX_CHUNK_SIZE + 32 * KiB;

/** `<u32be connection id>` that the relay puts in front of tunnelled frames on host sockets (ARCHITECTURE §6). */
export const RELAY_CONN_PREFIX_BYTES = 4;

/**
 * Largest binary WebSocket message the relay forwards on either Durable Object; larger ones are answered with
 * `bye 1009`. Holds the DATA frame of a MAX_APP_MESSAGE plus the connection-id prefix.
 */
export const MAX_RELAY_FRAME = 8 * MiB + 64 * KiB;

/** Cloudflare's hard limit for a received WebSocket message (relay.md V3). MAX_RELAY_FRAME must stay below it. */
export const RELAY_PLATFORM_MAX_MESSAGE = 32 * MiB;

/** Longest relay control text frame (JSON) a peer parses; anything longer is rejected before JSON.parse. */
export const RELAY_CONTROL_MAX_CHARS = 4 * KiB;

/** WebSocket close reasons are limited to 123 bytes of UTF-8; workerd's `close()` throws above it (relay.md gotcha 13). */
export const CLOSE_REASON_MAX_BYTES = 123;

// ---------------------------------------------------------------------------------------------------------------
// msgpack decoder limits (ARCHITECTURE §4.3). Spread MSGPACK_DECODER_LIMITS into `new Decoder({...})`.
// ---------------------------------------------------------------------------------------------------------------

export const MSGPACK_MAX_BIN_LENGTH = 9 * MiB;
export const MSGPACK_MAX_STR_LENGTH = 1 * MiB;
export const MSGPACK_MAX_ARRAY_LENGTH = 1_000_000;
export const MSGPACK_MAX_MAP_LENGTH = 10_000;

export const MSGPACK_DECODER_LIMITS = {
  maxBinLength: MSGPACK_MAX_BIN_LENGTH,
  maxStrLength: MSGPACK_MAX_STR_LENGTH,
  maxArrayLength: MSGPACK_MAX_ARRAY_LENGTH,
  maxMapLength: MSGPACK_MAX_MAP_LENGTH,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Liveness (ARCHITECTURE §4 "Liveness", relay.md §1.2). R1: guests see "host offline" within 10 s.
// ---------------------------------------------------------------------------------------------------------------

/** Daemon, CLI and web send the text frame "ping" this often on relay sockets. */
export const RELAY_PING_INTERVAL_MS = 2_000;
/** A peer that has not received "pong" for this long terminates its socket and reconnects with jitter. */
export const PONG_WATCHDOG_MS = 6_000;
/** The WorkspaceDO alarm declares the host offline after this long without a host ping. */
export const RELAY_HOST_TIMEOUT_MS = 6_000;
/** The WorkspaceDO alarm closes client sockets whose last ping is older than this (sends `peer.close`). */
export const RELAY_CLIENT_SWEEP_MS = 30_000;
/** The daemon sends an encrypted `presence.heartbeat` this often on every interactive channel. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 3_000;
/** A client shows "The host is offline" after this long without any message from the daemon, even if the relay is silent. */
export const CLIENT_OFFLINE_THRESHOLD_MS = 8_000;
/** R1 acceptance bound: every guest must show the host as offline within this time after the host disconnects. */
export const HOST_OFFLINE_DEADLINE_MS = 10_000;

// ---------------------------------------------------------------------------------------------------------------
// Handshake and identity (ARCHITECTURE §4.2)
// ---------------------------------------------------------------------------------------------------------------

/** A Noise handshake must complete within this time or the connection is dropped. */
export const HANDSHAKE_DEADLINE_MS = 10_000;
/** Most failed handshakes the daemon accepts on one relay connection id (plus a global budget per minute). */
export const MAX_FAILED_HANDSHAKES_PER_CONN = 5;
/** Lifetime of the relay-signed identity token; the daemon verifies with this as `maxTokenAge`. */
export const IDENTITY_TOKEN_TTL_SECONDS = 300;
/** JWS `typ` of the identity token: the relay signs it, the daemon refuses any other type (no token-kind confusion). */
export const IDENTITY_TOKEN_TYP = 'smurg-identity+jwt';
/** `aud` of an identity token is this prefix + the workspace id: a token for one workspace is useless for another. */
export const IDENTITY_TOKEN_AUDIENCE_PREFIX = 'smurg-daemon:';
/** Member of the `cnf` claim that carries the blinded device-key commitment (identityCnf). */
export const IDENTITY_CNF_MEMBER = 'smurg-noise-static';

// ---------------------------------------------------------------------------------------------------------------
// Locks and documents (ARCHITECTURE §7.5, SPEC R8)
// ---------------------------------------------------------------------------------------------------------------

/** Default idle time after which a human leaves a file's shared edit lock (host setting `humanLockIdleMs`). */
export const HUMAN_LOCK_IDLE_MS = 30_000;
/** Default lifetime of an agent lock taken by PreToolUse (host setting `agentLockTimeoutMs`). */
export const AGENT_LOCK_TTL_MS = 60_000;
/** Largest file opened as a collaborative document; bigger files are refused with `too_large`. */
export const MAX_DOC_BYTES = 5 * MiB;
/** Human edits are written to disk this long after the last Yjs update… */
export const AUTOSAVE_DEBOUNCE_MS = 300;
/** …but never later than this after the first unsaved update. */
export const AUTOSAVE_MAX_WAIT_MS = 2_000;

// ---------------------------------------------------------------------------------------------------------------
// Disk reserve for uploads (ARCHITECTURE §5.2, SPEC R7): reserve = max(bytes, percent × total).
// ---------------------------------------------------------------------------------------------------------------

export const DISK_RESERVE_BYTES_DEFAULT = 5 * GiB;
export const DISK_RESERVE_PERCENT_DEFAULT = 5;

// ---------------------------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------------------------

/** Workspace ids are URL-safe (`[A-Za-z0-9_-]`) and appear in relay routes, invite links and the Noise prologue. */
export const WORKSPACE_ID_MIN_LENGTH = 16;
export const WORKSPACE_ID_MAX_LENGTH = 64;
