import { z } from 'zod';
import { roleSchema } from '../roles.ts';
import {
  cleanedTextSchema,
  itemIdSchema,
  mentionsSchema,
  messageOriginSchema,
  rememberedRuleToolSchema,
  rulePatternSchema,
  userRefSchema,
} from './entities.ts';
import {
  ANSWER_NOTE_MAX_CHARS,
  COMMAND_MAX_BYTES,
  COMMENT_MAX_CHARS,
  DENY_MESSAGE_MAX_CHARS,
  EVENT_TEXT_MAX_BYTES,
  FALLBACK_TEXT_MAX_CHARS,
  MESSAGE_TEXT_MAX_CHARS,
  OPTION_DESCRIPTION_MAX_CHARS,
  OPTION_LABEL_MAX_CHARS,
  OTHER_ANSWER_MAX_CHARS,
  PERMISSION_INPUT_MAX_BYTES,
  PERMISSION_REASON_MAX_CHARS,
  QUESTION_COMMENTS_MAX,
  QUESTION_HEADER_MAX_CHARS,
  QUESTION_OPTIONS_MAX,
  QUESTION_PARTS_MAX,
  QUESTION_TEXT_MAX_CHARS,
  QUESTION_VOTERS_MAX,
  SMURG_TEXT_MAX_BYTES,
  TOOL_NAME_MAX_CHARS,
  URL_MAX_CHARS,
  WIRE_TEXT_REF_MAX_CHARS,
} from './limits.ts';
import { messageRefSchema } from './message-ref.ts';
import { fileRefSchema, rootRefSchema } from './paths.ts';
import { displayNameSchema, epochMsSchema, indexSchema, largeTextSchema, lineTextSchema, multilineTextSchema, opaqueIdSchema, userIdSchema } from './primitives.ts';

// The conversation of an agent session (ARCHITECTURE §5.9): an append-only log of immutable events with a sequence
// number, and the cards that change after they appear (questions, permission requests; suggestions are in
// entities.ts). The daemon NORMALISES: nothing of Claude Code's own shapes travels; every string is clipped to a named
// limit; every body that came from an agent or a tool went through `mask()` first.

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

/** The English rendering that travels next to a message reference. */
export const fallbackTextSchema = lineTextSchema(FALLBACK_TEXT_MAX_CHARS);

/**
 * A message reference that rides inside events and lists: bounded as a whole (its JSON is at most
 * WIRE_TEXT_REF_MAX_CHARS characters), where a bare MessageRef may carry sixteen parameters of a thousand characters.
 */
export const wireRefSchema = messageRefSchema.refine((ref) => JSON.stringify(ref).length <= WIRE_TEXT_REF_MAX_CHARS, 'message reference too large');

/** A sentence the daemon originated: a wire catalog reference with its English rendering (`wireText()` builds one). */
export const wireTextSchema = z.strictObject({ text: wireRefSchema, fallback: fallbackTextSchema });
export type WireText = z.infer<typeof wireTextSchema>;

/** What smurg itself told the agent (`topics/prompts.ts` holds the fixed texts). */
export const SMURG_PURPOSES = [
  'write-spec',
  'generate-plan',
  'update-plan',
  'start-item',
  'continue-item',
  'retry-item',
  'fix-plan',
  'fix-report',
  'nudge-report',
  'resolve-conflict',
  'conversation-lost',
  'restart-discussion',
] as const;
export const smurgPurposeSchema = z.enum(SMURG_PURPOSES);
export type SmurgPurpose = z.infer<typeof smurgPurposeSchema>;

export const TOOL_VERBS = ['read', 'edit', 'create', 'run', 'search', 'fetch', 'task', 'smurg', 'todo', 'other'] as const;
export const toolVerbSchema = z.enum(TOOL_VERBS);
export type ToolVerb = z.infer<typeof toolVerbSchema>;

/**
 * What a tool card shows. `target`: a path relative to the root, the command (whole, never shortened), a pattern, a
 * URL, a description or a tool name. `file`: only for a path inside a root that is not host-private. `outside`: a
 * path outside every root; then there is no target, no file and no body.
 */
export const toolViewSchema = z.strictObject({
  name: lineTextSchema(TOOL_NAME_MAX_CHARS, 1),
  verb: toolVerbSchema,
  target: largeTextSchema(COMMAND_MAX_BYTES).optional(),
  file: fileRefSchema.optional(),
  outside: z.literal(true).optional(),
});
export type ToolView = z.infer<typeof toolViewSchema>;

export const TOOL_BODY_KINDS = ['diff', 'output', 'list', 'text'] as const;

/** A tool's result. File contents of reads and matched lines of searches are never here. */
export const toolResultViewSchema = z.strictObject({
  additions: indexSchema.optional(),
  deletions: indexSchema.optional(),
  exitCode: z.int().optional(),
  matches: indexSchema.optional(),
  durationMs: indexSchema.optional(),
  body: z.strictObject({ kind: z.enum(TOOL_BODY_KINDS), text: largeTextSchema(EVENT_TEXT_MAX_BYTES), truncated: z.boolean() }).optional(),
});
export type ToolResultView = z.infer<typeof toolResultViewSchema>;

export const CARD_KINDS = ['question', 'permission', 'suggestion'] as const;
export const cardKindSchema = z.enum(CARD_KINDS);
export type CardKind = z.infer<typeof cardKindSchema>;

/** A pointer to a card (the event log holds where it appeared; the entity holds its state). */
export const cardRefSchema = z.strictObject({ kind: cardKindSchema, id: opaqueIdSchema });
export type CardRef = z.infer<typeof cardRefSchema>;

export const TURN_OUTCOMES = ['completed', 'interrupted', 'error', 'max-turns', 'budget'] as const;
export const turnOutcomeSchema = z.enum(TURN_OUTCOMES);
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

export const DELIVERY_STATES = ['queued', 'started', 'completed', 'cancelled'] as const;
export const NOTICE_LEVELS = ['info', 'warning', 'error'] as const;
export const NOTICE_ACTIONS = ['restart-agent', 'retry'] as const;
export const POINTER_TARGETS = ['spec', 'plan', 'report'] as const;

/** The text of a person's message as stored and sent: the output of `agentText()`. */
export const messageTextSchema = cleanedTextSchema(MESSAGE_TEXT_MAX_CHARS);

/** The body of one event kind, without `seq` and `at` (what a module hands to `AgentSessions.append`). */
export const conversationEventBodySchemas = {
  /** A system line (`conversation.*`). */
  line: z.strictObject({ kind: z.literal('line'), text: wireRefSchema, fallback: fallbackTextSchema }),
  notice: z.strictObject({
    kind: z.literal('notice'),
    level: z.enum(NOTICE_LEVELS),
    text: wireRefSchema,
    fallback: fallbackTextSchema,
    action: z.enum(NOTICE_ACTIONS).optional(),
  }),
  /** A person's words, exactly as the agent got them (under the header line that names `from`). */
  message: z.strictObject({
    kind: z.literal('message'),
    messageId: opaqueIdSchema,
    from: z.strictObject({ userId: userIdSchema, displayName: displayNameSchema, role: roleSchema }),
    text: messageTextSchema,
    /** Invisible characters were removed. */
    cleaned: z.literal(true).optional(),
    origin: messageOriginSchema,
    /** The message is an accepted suggestion of `from`. */
    suggestion: z.strictObject({ id: opaqueIdSchema, acceptedBy: userRefSchema, modified: z.boolean() }).optional(),
    mentions: mentionsSchema.optional(),
  }),
  /** What smurg itself told the agent; `by`: the member who asked for it, when one did. */
  smurg: z.strictObject({
    kind: z.literal('smurg'),
    messageId: opaqueIdSchema,
    purpose: smurgPurposeSchema,
    by: userRefSchema.optional(),
    text: largeTextSchema(SMURG_TEXT_MAX_BYTES),
  }),
  delivery: z.strictObject({ kind: z.literal('delivery'), messageId: opaqueIdSchema, state: z.enum(DELIVERY_STATES) }),
  'turn.started': z.strictObject({ kind: z.literal('turn.started'), turnId: opaqueIdSchema }),
  'turn.finished': z.strictObject({
    kind: z.literal('turn.finished'),
    turnId: opaqueIdSchema,
    outcome: turnOutcomeSchema,
    durationMs: indexSchema,
    stoppedBy: userRefSchema.optional(),
  }),
  /** One finished text block of the agent (clipped at EVENT_TEXT_MAX_BYTES: `truncated`; cut by a stop: `aborted`). */
  text: z.strictObject({
    kind: z.literal('text'),
    turnId: opaqueIdSchema,
    blockId: opaqueIdSchema,
    text: largeTextSchema(EVENT_TEXT_MAX_BYTES),
    aborted: z.literal(true).optional(),
    truncated: z.literal(true).optional(),
    parentToolUseId: opaqueIdSchema.optional(),
  }),
  'tool.started': z.strictObject({
    kind: z.literal('tool.started'),
    turnId: opaqueIdSchema,
    toolUseId: opaqueIdSchema,
    tool: toolViewSchema,
    /** The subagent (Task) this call belongs to. */
    parentToolUseId: opaqueIdSchema.optional(),
  }),
  /** `turnId`: the turn of its `tool.started`, so a page that begins with a result still knows where it belongs. */
  'tool.finished': z.strictObject({ kind: z.literal('tool.finished'), turnId: opaqueIdSchema, toolUseId: opaqueIdSchema, ok: z.boolean(), result: toolResultViewSchema }),
  /** Where a card appeared. */
  card: z.strictObject({ kind: z.literal('card'), card: cardKindSchema, id: opaqueIdSchema }),
  /** The "next step" card: the spec, the plan or a result report now exists. */
  pointer: z.strictObject({
    kind: z.literal('pointer'),
    target: z.enum(POINTER_TARGETS),
    topicId: opaqueIdSchema,
    itemId: itemIdSchema.optional(),
    version: z.int().min(1).optional(),
  }),
} as const;

export const CONVERSATION_EVENT_KINDS = Object.freeze(Object.keys(conversationEventBodySchemas)) as readonly (keyof typeof conversationEventBodySchemas)[];
export type ConversationEventKind = keyof typeof conversationEventBodySchemas;

const eventStamp = { seq: z.int().min(1), at: epochMsSchema };

/** One event of a conversation. `seq` starts at 1 and never repeats within a session. */
export const conversationEventSchema = z.discriminatedUnion('kind', [
  conversationEventBodySchemas.line.extend(eventStamp),
  conversationEventBodySchemas.notice.extend(eventStamp),
  conversationEventBodySchemas.message.extend(eventStamp),
  conversationEventBodySchemas.smurg.extend(eventStamp),
  conversationEventBodySchemas.delivery.extend(eventStamp),
  conversationEventBodySchemas['turn.started'].extend(eventStamp),
  conversationEventBodySchemas['turn.finished'].extend(eventStamp),
  conversationEventBodySchemas.text.extend(eventStamp),
  conversationEventBodySchemas['tool.started'].extend(eventStamp),
  conversationEventBodySchemas['tool.finished'].extend(eventStamp),
  conversationEventBodySchemas.card.extend(eventStamp),
  conversationEventBodySchemas.pointer.extend(eventStamp),
]);
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
/** One kind of event: `ConversationEventOf<'message'>`. */
export type ConversationEventOf<K extends ConversationEventKind> = Extract<ConversationEvent, { kind: K }>;
/** An event before the session stamps it (no `seq`, no `at`). */
export type ConversationEventInput = { [K in ConversationEventKind]: Omit<ConversationEventOf<K>, 'seq' | 'at'> }[ConversationEventKind];

/**
 * The text of a block that is streaming right now (never stored). `parentToolUseId`: the subagent (Task) the block
 * belongs to, as on its later `text` event. A block the agent only thinks in is never here.
 */
export const streamingBlockSchema = z.strictObject({
  turnId: opaqueIdSchema,
  blockId: opaqueIdSchema,
  text: largeTextSchema(EVENT_TEXT_MAX_BYTES),
  parentToolUseId: opaqueIdSchema.optional(),
});
export type StreamingBlock = z.infer<typeof streamingBlockSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Questions (ARCHITECTURE §5.9)
// ---------------------------------------------------------------------------------------------------------------

export const QUESTION_STATUSES = ['open', 'answered', 'withdrawn'] as const;
export const CARD_WITHDRAWN_REASONS = ['stopped', 'ended', 'failed', 'restarted'] as const;
export const cardWithdrawnReasonSchema = z.enum(CARD_WITHDRAWN_REASONS);
export type CardWithdrawnReason = z.infer<typeof cardWithdrawnReasonSchema>;

/** Indexes into one part's options. */
export const optionIndexesSchema = z.array(z.int().min(0).max(QUESTION_OPTIONS_MAX - 1)).min(1).max(QUESTION_OPTIONS_MAX);

export const questionPartSchema = z.strictObject({
  header: lineTextSchema(QUESTION_HEADER_MAX_CHARS),
  text: multilineTextSchema(QUESTION_TEXT_MAX_CHARS, 1),
  multi: z.boolean(),
  options: z
    .array(z.strictObject({ label: lineTextSchema(OPTION_LABEL_MAX_CHARS, 1), description: multilineTextSchema(OPTION_DESCRIPTION_MAX_CHARS) }))
    .min(2)
    .max(QUESTION_OPTIONS_MAX),
});
export type QuestionPart = z.infer<typeof questionPartSchema>;

/**
 * The parts of one question: 1 to QUESTION_PARTS_MAX, their texts distinct (Claude Code keys the answer by the
 * question text). The runner refuses an AskUserQuestion that does not pass this before a card exists; nothing is
 * ever clipped to make it pass.
 */
export const questionPartsSchema = z
  .array(questionPartSchema)
  .min(1)
  .max(QUESTION_PARTS_MAX)
  .refine((parts) => new Set(parts.map((part) => part.text)).size === parts.length, 'the texts of the parts are distinct');

/**
 * One member's vote on one part: `options` (indexes) or `other` (their own words). Any member holding `discuss` may
 * vote either way: an "Other" text is shown to people only and the daemon never sends it to the agent; it reaches the
 * agent only when a member with `session.drive` submits it as the answer or copies it into the note.
 */
export const questionVoteSchema = z
  .strictObject({
    userId: userIdSchema,
    displayName: displayNameSchema,
    part: z.int().min(0).max(QUESTION_PARTS_MAX - 1),
    options: optionIndexesSchema.optional(),
    other: cleanedTextSchema(OTHER_ANSWER_MAX_CHARS).optional(),
    at: epochMsSchema,
  })
  .refine((vote) => (vote.options === undefined) !== (vote.other === undefined), 'a vote has options or other');
export type QuestionVote = z.infer<typeof questionVoteSchema>;

/** Comments are for the team: the daemon never sends them to the agent. */
export const questionCommentSchema = z.strictObject({
  id: opaqueIdSchema,
  from: userRefSchema,
  text: cleanedTextSchema(COMMENT_MAX_CHARS),
  at: epochMsSchema,
  mentions: mentionsSchema.optional(),
});
export type QuestionComment = z.infer<typeof questionCommentSchema>;

/** Per part, per option, then the count of "Other". */
export const questionTallySchema = z.array(z.array(indexSchema).min(3).max(QUESTION_OPTIONS_MAX + 1)).min(1).max(QUESTION_PARTS_MAX);

export const questionAnswerSchema = z.strictObject({
  parts: z
    .array(
      z
        .strictObject({ options: optionIndexesSchema.optional(), other: cleanedTextSchema(OTHER_ANSWER_MAX_CHARS).optional(), otherBy: userRefSchema.optional() })
        .refine((part) => (part.options === undefined) !== (part.other === undefined), 'an answer has options or other'),
    )
    .min(1)
    .max(QUESTION_PARTS_MAX),
  /** The decider's note for the agent (members with `session.drive` only). */
  note: cleanedTextSchema(ANSWER_NOTE_MAX_CHARS).optional(),
  by: userRefSchema,
  /**
   * The decider at that moment, whenever the submitter was someone else (the host at any time; after escalation a
   * member with `session.drive`). The line `conversation.submittedFor` is written only when the question had escalated.
   */
  onBehalfOf: userRefSchema.optional(),
  at: epochMsSchema,
  tally: questionTallySchema,
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/**
 * An agent's multiple-choice question (Claude Code's AskUserQuestion). Everyone holding `discuss` votes and comments;
 * the decider submits. The texts of the parts are distinct. `eligible`: members holding `discuss` who are online or
 * have voted on any part ("3 of 4 voted"; who has voted, the tally and the leading answer are `votes.ts`).
 * `previous`: the same question was open when smurg restarted. `withdrawn.by`: the person who stopped the turn or
 * ended the session, when a person did.
 */
export const questionSchema = z.strictObject({
  id: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  askedAt: epochMsSchema,
  status: z.enum(QUESTION_STATUSES),
  parts: questionPartsSchema,
  votes: z.array(questionVoteSchema).max(QUESTION_VOTERS_MAX * QUESTION_PARTS_MAX),
  comments: z.array(questionCommentSchema).max(QUESTION_COMMENTS_MAX),
  eligible: indexSchema,
  /** Kept current by the daemon (routing.ts `deciderOf`). */
  decider: userRefSchema.nullable(),
  /** The decider had the card on screen. */
  deciderSeenAt: epochMsSchema.optional(),
  /** Others who may now submit for the decider (the host, members with `session.drive`). */
  escalatedAt: epochMsSchema.optional(),
  previous: z.strictObject({ askedAt: epochMsSchema, tally: questionTallySchema }).optional(),
  answer: questionAnswerSchema.optional(),
  withdrawn: z.strictObject({ reason: cardWithdrawnReasonSchema, by: userRefSchema.optional(), at: epochMsSchema }).optional(),
});
export type Question = z.infer<typeof questionSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Permission requests (ARCHITECTURE §5.9)
// ---------------------------------------------------------------------------------------------------------------

export const PERMISSION_STATUSES = ['open', 'allowed', 'denied', 'withdrawn'] as const;
export const PERMISSION_WHATS = ['command', 'edit', 'fetch', 'outside', 'other'] as const;
export type PermissionWhat = (typeof PERMISSION_WHATS)[number];
/** Why "Always allow this kind" is not offered. */
export const NO_ALWAYS_REASONS = ['interpreter', 'fetches-code', 'one-word', 'host-only', 'no-suggestion'] as const;
export type NoAlwaysReason = (typeof NO_ALWAYS_REASONS)[number];
/**
 * smurg's own tool gate asked for the card (not Claude Code's mode or rules), about a shell command in a folder whose
 * Claude Code project settings run scripts: `writes-settings-script`, the command changes a place where one of those
 * scripts is (the script, or a folder that holds it); `may-reach-settings-script`, smurg cannot tell whether the
 * command leaves them alone.
 */
export const PERMISSION_GATE_REASONS = ['writes-settings-script', 'may-reach-settings-script'] as const;
export type PermissionGateReason = (typeof PERMISSION_GATE_REASONS)[number];
export const ALWAYS_SCOPES = ['session', 'topic'] as const;
export const alwaysScopeSchema = z.enum(ALWAYS_SCOPES);
export type AlwaysScope = z.infer<typeof alwaysScopeSchema>;

/** A rule as the card offers it and as it is remembered: `Bash(<pattern>)` / `WebFetch(<pattern>)`. */
export const offeredRuleSchema = z.strictObject({ tool: rememberedRuleToolSchema, pattern: rulePatternSchema });
export type OfferedRule = z.infer<typeof offeredRuleSchema>;

/**
 * An agent asks before it runs something. A person never allows what they cannot see: `command` is whole, `change` is
 * the unified diff the edit would make, `input` is the whole input of any other tool. `path` (the absolute path of an
 * `outside` request) is only in the copy sent to the host. `hostOnly`: a label on requests smurg recognises as
 * reaching beyond the shared project (only the host may allow them); it is not a boundary.
 */
export const permissionRequestSchema = z.strictObject({
  id: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  askedAt: epochMsSchema,
  status: z.enum(PERMISSION_STATUSES),
  tool: lineTextSchema(TOOL_NAME_MAX_CHARS, 1),
  what: z.enum(PERMISSION_WHATS),
  command: largeTextSchema(COMMAND_MAX_BYTES).optional(),
  file: fileRefSchema.optional(),
  change: z.strictObject({ text: largeTextSchema(EVENT_TEXT_MAX_BYTES) }).optional(),
  outside: z.literal(true).optional(),
  path: largeTextSchema(COMMAND_MAX_BYTES).optional(),
  url: lineTextSchema(URL_MAX_CHARS).optional(),
  input: largeTextSchema(PERMISSION_INPUT_MAX_BYTES).optional(),
  root: rootRefSchema,
  /** Claude Code's own English reason (with `gate`: the gate's own English sentence, which `gate` stands for). */
  reason: multilineTextSchema(PERMISSION_REASON_MAX_CHARS).optional(),
  /** Present when smurg's own tool gate asked for this card: why. A client shows its own sentence for it. */
  gate: z.enum(PERMISSION_GATE_REASONS).optional(),
  hostOnly: z.boolean(),
  /** Present only when "Always allow this kind" is offered. */
  alwaysRule: offeredRuleSchema.optional(),
  noAlways: z.enum(NO_ALWAYS_REASONS).optional(),
  escalatedAt: epochMsSchema.optional(),
  decision: z
    .strictObject({
      by: userRefSchema,
      at: epochMsSchema,
      always: alwaysScopeSchema.optional(),
      /** With a denial: what the agent should do instead (the agent reads it). */
      message: cleanedTextSchema(DENY_MESSAGE_MAX_CHARS).optional(),
    })
    .optional(),
  withdrawn: z.strictObject({ reason: cardWithdrawnReasonSchema, at: epochMsSchema }).optional(),
});
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
