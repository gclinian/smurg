import { MAX_CHUNK_SIZE, MAX_DOC_BYTES, MSGPACK_MAX_STR_LENGTH } from '../constants.ts';

// Schema-level limits of the message catalog. They sit below the codec limits (MSGPACK_* in constants.ts, and
// MAX_APP_MESSAGE for a whole Envelope), so a field that is too long is rejected by name instead of by the decoder.
// Each value is part of the protocol: changing one is a protocol change.

const KiB = 1024;
const MiB = 1024 * KiB;

// Identifiers --------------------------------------------------------------------------------------------------

/** Daemon-issued ids (sessions, docs, uploads, suggestions, worktrees, …): `[A-Za-z0-9_-]{1,64}`. */
export const OPAQUE_ID_MAX_CHARS = 64;
/** Envelope `id`: 1–64 printable ASCII characters, chosen by the sender of a request. */
export const ENVELOPE_ID_MAX_CHARS = 64;
/** Longest message type name, e.g. `worktree.merge.approve.ok`. */
export const MESSAGE_TYPE_MAX_CHARS = 64;

// Paths --------------------------------------------------------------------------------------------------------

/** A relative path inside a root, in UTF-16 units (after NFC). */
export const REL_PATH_MAX_CHARS = 4_096;
/**
 * One path segment, in UTF-16 units. That is APFS's NAME_MAX; Linux counts 255 *bytes*, which is stricter and is
 * checked by the daemon's PathGuard on Linux (a 255-byte name is never more than 255 UTF-16 units).
 */
export const PATH_SEGMENT_MAX_UNITS = 255;

// Free text (UTF-16 units) -------------------------------------------------------------------------------------

/** Titles, file-system names shown as text, device names, branch names. */
export const SHORT_TEXT_MAX_CHARS = 256;
/** Reject reasons, skip reasons, close messages. */
export const REASON_MAX_CHARS = 1_000;
/** Activity-feed summaries. */
export const ACTIVITY_SUMMARY_MAX_CHARS = 500;
/** A suggestion for an agent (R6), including a code selection from the editor. */
export const SUGGESTION_TEXT_MAX_CHARS = 64 * KiB;
/** Merge request message. */
export const MERGE_MESSAGE_MAX_CHARS = 4_000;
/** Text of an agent → member notification (`activity.notify`). */
export const NOTIFY_TEXT_MAX_CHARS = 2_000;
/** Audit `target` (usually a path or an id). */
export const AUDIT_TARGET_MAX_CHARS = 4_200;
/** ETag of a single-file download (size + mtime + inode, formatted by the daemon). */
export const ETAG_MAX_CHARS = 128;

// Large text, in UTF-8 bytes (msgpack's maxStrLength counts bytes) --------------------------------------------

/** Each of humanText / agentText / baseText in a conflict hunk; the daemon truncates and sets `truncated`. */
export const CONFLICT_TEXT_MAX_BYTES = 64 * KiB;
/** Unified diff of a merge request; the daemon truncates and sets `truncated`. Equals msgpack's string limit. */
export const MERGE_DIFF_MAX_BYTES = MSGPACK_MAX_STR_LENGTH;

// Binary fields ------------------------------------------------------------------------------------------------

/** `file.read` result and `file.write` content (interactive channel; bigger files use the transfer channel). */
export const FILE_CONTENT_MAX_BYTES = MAX_DOC_BYTES;
/** One `doc.sync` message (the initial step 2 of a 5 MiB document is about 5.2 MB, yjs-monaco.md F23). */
export const DOC_SYNC_MAX_BYTES = MAX_CHUNK_SIZE;
/** One `doc.awareness` update (the daemon's snapshot to a late joiner carries every participant). */
export const DOC_AWARENESS_MAX_BYTES = 256 * KiB;
/** One `exec.input` (keystrokes or a paste). */
export const EXEC_INPUT_MAX_BYTES = 1 * MiB;
/** One `exec.output` (the coalescer flushes at 64 KiB; the post-snapshot gap can be up to the 2 MiB raw tail). */
export const EXEC_OUTPUT_MAX_BYTES = 4 * MiB;
/** `session.attach` result data: a serialized mirror (5000 lines of scrollback) or a raw delta. */
export const TERMINAL_ATTACH_MAX_BYTES = MAX_CHUNK_SIZE;
/** `doc.conflict.get`: the full text an agent/process wrote (a document is at most MAX_DOC_BYTES). */
export const CONFLICT_AGENT_VERSION_MAX_BYTES = MAX_DOC_BYTES;

// Collections --------------------------------------------------------------------------------------------------

/** Entries in one `file.tree` result; the daemon sets `truncated` when a directory has more. */
export const FILE_TREE_MAX_ENTRIES = 10_000;
/** `file.tree` depth (1 = direct children). */
export const FILE_TREE_MAX_DEPTH = 32;
/** Changes in one `file.changed` event (the daemon splits bigger bursts). */
export const FILE_CHANGES_MAX = 10_000;
/**
 * Entries in one `file.upload.plan`; a client splits larger folder drops into several plans. Measured on Node 22:
 * decoding + validating 50,000 entries blocks the daemon's event loop for ~50 ms (msgpack alone ~16 ms), 10,000 for
 * ~10 ms, which keeps typing and terminals responsive (ARCHITECTURE §0 rule 5).
 */
export const UPLOAD_PLAN_MAX_ENTRIES = 10_000;
/** `skipped` entries in `file.download.end`. */
export const DOWNLOAD_SKIPPED_MAX = 10_000;
/** Members, sessions, suggestions, worktrees, merge requests, locks, invites and conflicts in one list result. */
export const LIST_MAX_ITEMS = 1_000;
/** `limit` of `activity.list` and `admin.audit.query`. */
export const PAGE_LIMIT_MAX = 500;
/** Hunks in one ConflictRecord; the daemon reports the rest in `hunksOmitted`. */
export const CONFLICT_HUNKS_MAX = 64;
/** Files in one merge diff summary. */
export const MERGE_FILES_MAX = 10_000;
/** Devices per member in `admin.member.list`. */
export const DEVICES_PER_MEMBER_MAX = 100;
/** Shared read-only directories (D12) in the host settings. */
export const SHARED_DIRS_MAX = 64;
/** Keys in an audit entry's `detail`. */
export const AUDIT_DETAIL_MAX_KEYS = 64;

// Terminal ------------------------------------------------------------------------------------------------------

export const TERMINAL_COLS_MAX = 1_000;
export const TERMINAL_ROWS_MAX = 1_000;

// Handshake (ARCHITECTURE §4.2) --------------------------------------------------------------------------------

/** Compact JWS of the relay identity token. */
export const IDENTITY_TOKEN_MAX_CHARS = 4_096;
/**
 * An encoded ClientHello. Stricter than the channel's MAX_CLIENT_HELLO_BYTES (what fits in Noise msg3): a real hello
 * is well under 5 KiB, so anything bigger is refused before parsing.
 */
export const CLIENT_HELLO_MAX_BYTES = 8 * KiB;

// Decoding -----------------------------------------------------------------------------------------------------

/** Deepest nesting of arrays/maps the codec accepts; the catalog itself needs fewer than 10 levels. */
export const DECODED_MAX_DEPTH = 32;
