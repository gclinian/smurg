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

// Conversations, cards, topics, inbox (protocol 4; ARCHITECTURE §5.5, §5.9–§5.11) ------------------------------------

/** A person's message to an agent, in UTF-16 units (equal to the suggestion limit). Checked again after `agentText()`. */
export const MESSAGE_TEXT_MAX_CHARS = 64 * KiB;
/** Agent text of one block, a diff or output body, a permission card's `change`: UTF-8 bytes; the daemon clips. */
export const EVENT_TEXT_MAX_BYTES = 256 * KiB;
/** What smurg itself tells an agent (fixed sentences plus at most one quotation of SMURG_QUOTE_MAX_BYTES). */
export const SMURG_TEXT_MAX_BYTES = 32 * KiB;
/** Command output kept in a tool card: the first and the last bytes. */
export const TOOL_OUTPUT_HEAD_BYTES = 64 * KiB;
export const TOOL_OUTPUT_TAIL_BYTES = 16 * KiB;
/** A fetch result or the answer of another MCP server kept in a tool card. */
export const TOOL_FETCH_BODY_BYTES = 16 * KiB;
/** Names of matching files a search card lists. */
export const TOOL_SEARCH_FILES_MAX = 200;
/** A command as a tool card's target and on a permission card: never shortened; a longer one is denied, not shown. */
export const COMMAND_MAX_BYTES = 64 * KiB;
/** The whole input of an `other` tool on a permission card (pretty-printed JSON). */
export const PERMISSION_INPUT_MAX_BYTES = 64 * KiB;
/** A tool's name. */
export const TOOL_NAME_MAX_CHARS = 64;
/** A URL on a permission card. */
export const URL_MAX_CHARS = 2_048;
/** The English rendering that travels next to a message reference (`fallback`); the daemon clips. */
export const FALLBACK_TEXT_MAX_CHARS = 1_000;
/** A message reference inside a conversation event, a plan, a report or a preflight: its JSON, in characters. */
export const WIRE_TEXT_REF_MAX_CHARS = 2_000;

/** THE page rule: a reply that carries events or cards holds at most this many events AND this many bytes. */
export const EVENTS_PAGE_MAX = 500;
export const EVENTS_PAGE_MAX_BYTES = 2 * MiB;
/** `session.watch { haveSeq }` further behind than this answers with the newest page instead. */
export const EVENTS_CATCH_UP_MAX = 2_000;
/** A live `session.events` batch is closed by time, count or bytes, whichever comes first. */
export const EVENTS_BATCH_MAX = 64;
export const EVENTS_BATCH_MAX_BYTES = 512 * KiB;
export const EVENTS_BATCH_MS = 100;
/** Text deltas of one block are coalesced for this long; one delta carries at most DELTA_TEXT_MAX_BYTES. */
export const DELTA_COALESCE_MS = 200;
export const DELTA_TEXT_MAX_BYTES = 64 * KiB;
/** A client that saw a gap in a block's deltas watches the session again at most once in this span. */
export const DELTA_REWATCH_MIN_MS = 2_000;
/** Blocks that stream at the same time in one `session.watch` reply (a turn with parallel subagents). */
export const STREAMING_BLOCKS_MAX = 8;
/** Cards asked for in one `session.cards.get`. */
export const CARDS_GET_MAX = 20;
/** Card references (`moreCards`) in one reply. */
export const CARD_REFS_MAX = 1_000;
/** THE list rule: `session.list`, `suggest.list`, `topic.list`, `inbox.list` and `admin.claudeConfig.get` close a reply at this size (`hasMore`). */
export const LIST_REPLY_MAX_BYTES = 4 * MiB;

export const QUESTION_PARTS_MAX = 4;
export const QUESTION_OPTIONS_MAX = 4;
export const QUESTION_HEADER_MAX_CHARS = 64;
export const QUESTION_TEXT_MAX_CHARS = 4_000;
export const OPTION_LABEL_MAX_CHARS = 200;
export const OPTION_DESCRIPTION_MAX_CHARS = 1_000;
/** Members whose votes one question holds (one vote per member and part). */
export const QUESTION_VOTERS_MAX = 50;
export const QUESTION_COMMENTS_MAX = 100;
export const COMMENT_MAX_CHARS = 1_000;
export const OTHER_ANSWER_MAX_CHARS = 500;
export const ANSWER_NOTE_MAX_CHARS = 1_000;
/** A denial's message for the agent ("what to do instead") and Claude Code's own reason on a permission card. */
export const DENY_MESSAGE_MAX_CHARS = 1_000;
export const PERMISSION_REASON_MAX_CHARS = 1_000;
/** Mentions that may accompany one text. */
export const MENTIONS_PER_TEXT_MAX = 10;
/** Pending suggestions of one author in one session. */
export const SUGGESTIONS_PENDING_PER_AUTHOR_MAX = 20;
/** A quoted section sent with `topic.revise`. */
export const QUOTE_TEXT_MAX_CHARS = 4_000;
export const QUOTE_HEADING_MAX_CHARS = 200;

/** Always-allowed kinds, per session and per topic. */
export const REMEMBERED_RULES_MAX = 50;
export const RULE_PATTERN_MAX_CHARS = 200;
/** The host's own Claude Code allow rules shown to the host and to members with agent access. */
export const HOST_RULES_MAX = 500;
export const HOST_RULE_MAX_CHARS = 500;

export const TOPICS_MAX = 200;
export const TOPIC_NAME_MAX_CHARS = 120;
export const TOPIC_SLUG_MAX_CHARS = 48;
export const HAND_EDITS_MAX = 20;
export const PLAN_ITEMS_MAX = 40;
/** Items of one PlanInfo: those in the file plus started ones that were removed from it (`inPlan: false`). */
export const PLAN_INFO_ITEMS_MAX = 2 * PLAN_ITEMS_MAX;
export const ITEM_ID_MAX_CHARS = 40;
export const ITEM_TITLE_MAX_CHARS = 120;
export const ITEM_SUMMARY_MAX_CHARS = 2_000;
export const ITEM_TOUCHES_MAX = 16;
export const ITEM_GLOB_MAX_CHARS = 200;
export const SPLIT_REASON_MAX_CHARS = 500;
export const PLAN_WARNINGS_MAX = 40;
export const PLAN_WAITING_FOR_MAX = 20;
export const REVIEWERS_MAX = 20;
export const PREFLIGHT_BLOCKERS_MAX = 10;
export const PREFLIGHT_ALSO_IN_FOLDER_MAX = 20;
export const PREFLIGHT_EDITING_NOW_MAX = 20;
/** `plan.changes`: the diff of SPEC.md or PLAN.md since the last Start, UTF-8 bytes; the daemon truncates and sets `truncated`. */
export const PLAN_CHANGES_DIFF_MAX_BYTES = 512 * KiB;
/** Worktrees named in the refusal of an archive that has unmerged changes (one per work item). */
export const UNMERGED_WORKTREES_MAX = PLAN_INFO_ITEMS_MAX;

/** One section of a result report, UTF-8 bytes. */
export const REPORT_SECTION_MAX_BYTES = 64 * KiB;
export const REPORT_CHECKS_MAX = 100;
export const REPORT_CHECK_TEXT_MAX_CHARS = 2_000;
/** Follow-ups a report shows, and how much of each question and answer (the session holds the whole text). */
export const REPORT_FOLLOW_UPS_MAX = 50;
export const REPORT_FOLLOW_UP_TEXT_MAX_BYTES = 16 * KiB;
export const REPORT_BY_HAND_MAX = 50;

export const INBOX_ITEMS_MAX = 1_000;
export const INBOX_KEY_MAX_CHARS = 200;
export const INBOX_EXCERPT_MAX_CHARS = 300;
export const INBOX_ALSO_FOR_MAX = 5;
/** Stored notes (mentions, results of my own suggestions) per member. */
export const INBOX_NOTES_PER_MEMBER_MAX = 200;
/** Keys in one `inbox.seen`. */
export const INBOX_SEEN_KEYS_MAX = 200;

/** A display name as a model reads it (`agentSafeName`), in code points. */
export const AGENT_SAFE_NAME_MAX = 40;
/** A quotation inside a message smurg sends to an agent (the decisions of a lost discussion). */
export const SMURG_QUOTE_MAX_BYTES = 8 * KiB;

/** `admin.claudeConfig.get`: entries per list, characters per entry, the raw file, scripts a file's commands name. */
export const CLAUDE_CONFIG_LIST_MAX = 100;
export const CLAUDE_CONFIG_ENTRY_MAX_CHARS = 2_000;
export const CLAUDE_CONFIG_TEXT_MAX_BYTES = 256 * KiB;
export const CLAUDE_CONFIG_SCRIPTS_MAX = 20;
export const CLAUDE_CONFIG_FILES_MAX = 3;

/** Host settings (ARCHITECTURE §5.8). */
export const MAX_LIVE_AGENTS_RANGE = { min: 2, max: 32 } as const;
export const ESCALATE_AFTER_MS_RANGE = { min: 60_000, max: 3_600_000 } as const;
export const ESCALATE_AFTER_MS_DEFAULT = 5 * 60_000;
/** A report escalates after this many times `escalateAfterMs`. */
export const REPORT_ESCALATION_FACTOR = 6;
/** A person offline for this long escalates their open question or permission request at once. */
export const ESCALATE_OFFLINE_MS = 60_000;

/** Per member and minute (ARCHITECTURE §5.9 "Rates"): a refusal is `rate_limited`. */
export const RATE_LIMITS_PER_MINUTE = { vote: 30, comment: 10, suggestion: 10, mention: 20 } as const;
/** `notify_member` of one agent session, per minute. */
export const AGENT_NOTIFY_PER_MINUTE = 10;
/** `question.remind`: once per question in this span. */
export const QUESTION_REMIND_INTERVAL_MS = 60_000;
