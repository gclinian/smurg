import { z } from 'zod';
import {
  agentSessionSchema,
  hostStateSchema,
  loginStateSchema,
  permissionModeSchema,
  personTextSchema,
  mentionsSchema,
  rememberedRuleSchema,
  sessionInfoSchema,
  suggestionSchema,
  terminalColsSchema,
  terminalRowsSchema,
  terminalSessionSchema,
} from '../entities.ts';
import { cardRefSchema, conversationEventSchema, permissionRequestSchema, questionSchema, streamingBlockSchema } from '../conversation.ts';
import {
  CARDS_GET_MAX,
  CARD_REFS_MAX,
  DELTA_TEXT_MAX_BYTES,
  EVENTS_BATCH_MAX,
  EVENTS_PAGE_MAX,
  EXEC_INPUT_MAX_BYTES,
  EXEC_OUTPUT_MAX_BYTES,
  HOST_RULES_MAX,
  HOST_RULE_MAX_CHARS,
  LIST_MAX_ITEMS,
  MESSAGE_TEXT_MAX_CHARS,
  REMEMBERED_RULES_MAX,
  STREAMING_BLOCKS_MAX,
  TERMINAL_ATTACH_MAX_BYTES,
} from '../limits.ts';
import { byteCountSchema, bytesSchema, indexSchema, largeTextSchema, lineTextSchema, opaqueIdSchema, shortTextSchema, userIdSchema } from '../primitives.ts';
import { emptyPayloadSchema } from './channel.ts';

// session.* and exec.* (ARCHITECTURE §5.5, §5.9). A session is a TERMINAL (a plain shell in a PTY: attach, exec.*,
// output addressed by absolute byte offset) or an AGENT (a Claude Code conversation: watch, events addressed by `seq`).
// exec.* and file.* never share types or handlers (future two-way sync).

/** Main workspace, or a worktree: a new one, or `worktreeId` of a kept one to continue in (R9). */
export const sessionWorkspaceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('main') }),
  z.strictObject({ mode: z.literal('worktree'), worktreeId: opaqueIdSchema.optional() }),
]);

/** A person's message to an agent as it arrives (stored and sent as `agentText(text).text`). */
export const messageTextInputSchema = personTextSchema(MESSAGE_TEXT_MAX_CHARS);

/**
 * Needs `session.create` (host, Agent access). The session runs like the host's own whoever opens it (ARCHITECTURE §11
 * D-15). The caller is `openedBy`. An agent session made here is a FREE session (no topic): `responsible` is null,
 * `firstMessage` is the caller's first message.
 */
export const sessionCreatePayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('terminal'),
    workspace: sessionWorkspaceSchema,
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
    title: shortTextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    workspace: sessionWorkspaceSchema,
    title: shortTextSchema.optional(),
    firstMessage: messageTextInputSchema.optional(),
  }),
]);
export const sessionCreateResultSchema = z.strictObject({ session: sessionInfoSchema });

/**
 * Without `topicId`: terminals; agent sessions of topics that are not archived (ended ones included); free sessions.
 * With `topicId`: every agent session of that topic, archived or not (earlier attempts, earlier discussions).
 * Oldest first. THE list rule: a reply is closed at LIST_REPLY_MAX_BYTES or LIST_MAX_ITEMS; `hasMore` then, and
 * `after` (the last session's id) continues.
 */
export const sessionListPayloadSchema = z.strictObject({ topicId: opaqueIdSchema.optional(), after: opaqueIdSchema.optional() });
export const sessionListResultSchema = z.strictObject({ sessions: z.array(sessionInfoSchema).max(LIST_MAX_ITEMS), hasMore: z.boolean() });

/**
 * What every member may know of the host's side before a session exists: the workspace's account state and whether
 * the main folder's Claude Code project settings are used (the New topic dialog of a member who is not the host).
 */
export const sessionHostGetPayloadSchema = emptyPayloadSchema;
export const sessionHostGetResultSchema = hostStateSchema;
/** To everyone, whenever one of the two changes. */
export const sessionHostPayloadSchema = hostStateSchema;

/** Agent sessions: runs `claude auth status --json` in the session's environment ("Check login again"). */
export const sessionLoginStatusPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
export const sessionLoginStatusResultSchema = z.strictObject({ login: loginStateSchema });

/**
 * Terminal sessions only (an agent session: `bad_request` reason `not-a-terminal`).
 * `haveOffset`: the client still holds output up to this offset (a raw `delta` is possible if no resize happened
 * since). `cols`/`rows` (addition, both or neither): the client's viewport; for the owner (the member who opened the
 * session) this drives the PTY size (pty-packaging.md resize policy `owner`), for everyone else it is ignored, also
 * for the other members who may type into it (`session.drive`).
 */
export const sessionAttachPayloadSchema = z
  .strictObject({
    sessionId: opaqueIdSchema,
    haveOffset: byteCountSchema.optional(),
    cols: terminalColsSchema.optional(),
    rows: terminalRowsSchema.optional(),
  })
  .refine((p) => (p.cols === undefined) === (p.rows === undefined), 'cols and rows go together');

/**
 * `snapshot`: a serialized terminal (paint after a reset); `delta`: raw output since `haveOffset`. Live `exec.output`
 * continues at `nextOffset`.
 */
export const sessionAttachResultSchema = z.strictObject({
  session: terminalSessionSchema,
  mode: z.enum(['snapshot', 'delta']),
  data: bytesSchema({ max: TERMINAL_ATTACH_MAX_BYTES }),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  nextOffset: byteCountSchema,
});

export const sessionDetachPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });

export const sessionEndPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, keepWorktree: z.boolean().optional() });
export const sessionEndResultSchema = emptyPayloadSchema;

export const sessionStatePayloadSchema = z.strictObject({ session: sessionInfoSchema });

/** PTY output starting at absolute byte `offset`. */
export const execOutputPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  offset: byteCountSchema,
  data: bytesSchema({ min: 1, max: EXEC_OUTPUT_MAX_BYTES }),
});

/** Keystrokes / paste from a member who may drive the session (`session.drive`: any terminal session). */
export const execInputPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  data: bytesSchema({ min: 1, max: EXEC_INPUT_MAX_BYTES }),
});

/**
 * c→d from the owner (the member who opened the session): resize the PTY. d→c (addition): the PTY was resized; viewers render at exactly this size.
 * Sent in stream order with exec.output, so a viewer applies it between the right bytes.
 */
export const execResizePayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});

// ---------------------------------------------------------------------------------------------------------------
// Agent sessions: the conversation stream (ARCHITECTURE §5.9)
// ---------------------------------------------------------------------------------------------------------------

/** The cards a reply carries; cards that did not fit the page rule are named in `moreCards` (`session.cards.get`). */
const cardsResult = {
  questions: z.array(questionSchema).max(LIST_MAX_ITEMS),
  permissions: z.array(permissionRequestSchema).max(LIST_MAX_ITEMS),
  suggestions: z.array(suggestionSchema).max(LIST_MAX_ITEMS),
  moreCards: z.array(cardRefSchema).max(CARD_REFS_MAX),
};

/**
 * Agent sessions only (`session.notAgent`), also those of archived topics. Answers with ONE page (at most
 * EVENTS_PAGE_MAX events and EVENTS_PAGE_MAX_BYTES): the events after `haveSeq`, or the newest page without `haveSeq`
 * or when `haveSeq` is more than EVENTS_CATCH_UP_MAX events behind. Then the channel gets `session.events` and the card
 * updates of this session until `session.unwatch`, and `session.delta` only when `live` (default true). Watching
 * again changes `live`. A watcher is keyed by its logical channel.
 */
export const sessionWatchPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  haveSeq: indexSchema.optional(),
  live: z.boolean().optional(),
});
export const sessionWatchResultSchema = z.strictObject({
  session: agentSessionSchema,
  events: z.array(conversationEventSchema).max(EVENTS_PAGE_MAX),
  /** `seq` of the first event of the page (0: the page is empty). */
  firstSeq: indexSchema,
  /** `seq` the next live event will have. */
  nextSeq: z.int().min(1),
  /**
   * Events exist before the first event of the page. For an EMPTY page (the caller's `haveSeq` is current): events
   * exist at or before `haveSeq`. A reply to a watch with `haveSeq` CONTINUES the caller's window when it is empty or
   * `firstSeq === haveSeq + 1`; otherwise (the newest page) it REPLACES it.
   */
  hasEarlier: z.boolean(),
  /** There are more events after this page: continue with `session.history { afterSeq }`. */
  hasMore: z.boolean(),
  /** The text of blocks that are streaming right now (never a block the agent only thinks in). */
  streaming: z.array(streamingBlockSchema).max(STREAMING_BLOCKS_MAX),
  ...cardsResult,
});

export const sessionUnwatchPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });

/** Exactly one of `beforeSeq` (older pages) and `afterSeq` (catching up). The same page rule. */
export const sessionHistoryPayloadSchema = z
  .strictObject({
    sessionId: opaqueIdSchema,
    beforeSeq: z.int().min(1).optional(),
    afterSeq: indexSchema.optional(),
    limit: z.int().min(1).max(EVENTS_PAGE_MAX),
  })
  .refine((p) => (p.beforeSeq === undefined) !== (p.afterSeq === undefined), 'exactly one of beforeSeq and afterSeq');
/**
 * `hasEarlier` / `hasMore`: events exist before the first / after the last event of the page. For an empty page:
 * with `afterSeq`, `hasEarlier` says events exist at or before it (and `hasMore` is false); with `beforeSeq`,
 * `hasMore` says events exist at or after it (and `hasEarlier` is false).
 */
export const sessionHistoryResultSchema = z.strictObject({
  events: z.array(conversationEventSchema).max(EVENTS_PAGE_MAX),
  hasEarlier: z.boolean(),
  hasMore: z.boolean(),
  ...cardsResult,
});

/** The cards named, inside EVENTS_PAGE_MAX_BYTES (always at least one); the rest come back in `moreCards`. */
export const sessionCardsGetPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  cards: z.array(cardRefSchema).min(1).max(CARDS_GET_MAX),
});
export const sessionCardsGetResultSchema = z.strictObject(cardsResult);

/** To watchers. An event whose `seq` the client already has REPLACES it (redaction). */
export const sessionEventsPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  events: z.array(conversationEventSchema).min(1).max(EVENTS_BATCH_MAX),
});

/**
 * Volatile, to live watchers: text of a block that is streaming. `offset`: the number of characters (UTF-16 units)
 * of the block before `text`. `parentToolUseId`: the subagent (Task) the block belongs to, as on its `text` event.
 *
 * A delta the hub could not send is not lost text: the runner sends it again with the next delta, from the same
 * `offset`. A client that still sees a gap (`offset` beyond what it holds) stops appending to that block and waits for
 * the block's `text` event; it may watch again with its `haveSeq`, at most once per session in DELTA_REWATCH_MIN_MS.
 *
 * `thinking`: the agent thinks. Such a delta has `text` '' and `offset` 0 and makes no block: thinking is shown until
 * the next delta without `thinking` or the next event of that turn. While the agent thinks the runner repeats it once
 * per DELTA_COALESCE_MS, so a watcher that just arrived learns it; a watch reply's `streaming` never holds it.
 */
export const sessionDeltaPayloadSchema = z
  .strictObject({
    sessionId: opaqueIdSchema,
    turnId: opaqueIdSchema,
    blockId: opaqueIdSchema,
    offset: indexSchema,
    text: largeTextSchema(DELTA_TEXT_MAX_BYTES),
    thinking: z.literal(true).optional(),
    parentToolUseId: opaqueIdSchema.optional(),
  })
  .refine((delta) => delta.thinking === undefined || (delta.text === '' && delta.offset === 0), 'a thinking delta has no text and offset 0');

/** Checks: an agent session, not ended, its topic not archived. A `failed` or parked session is started by it. */
export const sessionMessageSendPayloadSchema = z.strictObject({
  sessionId: opaqueIdSchema,
  text: messageTextInputSchema,
  mentions: mentionsSchema.optional(),
  origin: z.enum(['composer', 'selection']).optional(),
});
export const sessionMessageSendResultSchema = z.strictObject({ messageId: opaqueIdSchema });

/** "Stop": ends the running turn. */
export const sessionInterruptPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
export const sessionInterruptResultSchema = emptyPayloadSchema;

/** "Try again": starts a `failed` session again. After three failed starts in a row: the host only. */
export const sessionRetryPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
export const sessionRetryResultSchema = z.strictObject({ session: agentSessionSchema });

/**
 * "Restart this session's agent now" (the action `restart-agent` of a notice): the session gives up its process now
 * when it is idle, else at its next idle moment; the next message starts it again with fresh launch files (a new
 * decision about the project settings, a changed rule). Nothing of the conversation is lost.
 */
export const sessionRestartPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });

/** The person must hold `discuss`; null: nobody is assigned. */
export const sessionResponsibleSetPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, userId: userIdSchema.nullable() });
export const agentSessionResultSchema = z.strictObject({ session: agentSessionSchema });

/** Refused for a discussion session (`session.mode.fixed`). */
export const sessionModeSetPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, mode: permissionModeSchema });

export const sessionRulesGetPayloadSchema = z.strictObject({ sessionId: opaqueIdSchema });
/**
 * `rules`: the session's and its topic's always-allowed kinds. `host`: the host's own Claude Code allow rules APPLY to
 * agent sessions (they run as the host); `state` says whether any were found, and `rules` (the complete list, masked)
 * is present only for the host and members with `session.drive`.
 */
export const sessionRulesGetResultSchema = z.strictObject({
  rules: z.array(rememberedRuleSchema).max(2 * REMEMBERED_RULES_MAX),
  host: z.strictObject({
    state: z.enum(['none', 'applied']),
    rules: z.array(lineTextSchema(HOST_RULE_MAX_CHARS, 1)).max(HOST_RULES_MAX).optional(),
  }),
});

export const sessionRuleRemovePayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, ruleId: opaqueIdSchema });

export const sessionRenamePayloadSchema = z.strictObject({ sessionId: opaqueIdSchema, title: shortTextSchema.pipe(z.string().min(1)) });
