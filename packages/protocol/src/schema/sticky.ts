import { z } from 'zod';
import { foldNoteName, noteNameSchema } from '../notes.ts';
import { cleanedTextSchema, reasonTextSchema, userRefSchema, wireTextSchema } from './entities.ts';
import { FEEDBACK_TEXT_MAX_CHARS, NOTE_INFO_BUILDS_MAX, NOTE_LINKS_MAX, OUTSIDE_NAME_MAX_CHARS } from './limits.ts';
import { epochMsSchema, lineTextSchema, opaqueIdSchema, sha256HexSchema } from './primitives.ts';

// The entities of the sticky notes (DESIGN 0.8.0 D2, D4, D5, D6; ARCHITECTURE §5.12): what the index says of a note,
// the state of an outside source, and what the daemon's `sticky.json` stores (the feedback, the sources' cursors, the
// builds). The whole stored shape is here from protocol 7's first step on, so the steps that fill it change no
// stored shape.

// ---------------------------------------------------------------------------------------------------------------
// The index (D2.2, D2.4)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One file of `notes/` that is a sticky note, as every member who may read files sees it: its name on disk, the names
 * it links to (`wikiLinks`: in order, each once, at most NOTE_LINKS_MAX) and its flags. Nothing else of its content
 * (no excerpt, no size, no time). A note that was not read for its links has none: `oversized` (over
 * NOTE_MAX_BYTES), `unreadable` (not a regular file with one link that a member without rights may read, or not
 * UTF-8), `shadowed` (its name folds equal to the name of another file of `notes/`, which is the note). `builds`: the
 * topics made from it (D5.2), the newest NOTE_INFO_BUILDS_MAX.
 */
export const noteInfoSchema = z
  .strictObject({
    name: noteNameSchema,
    links: z.array(noteNameSchema).max(NOTE_LINKS_MAX),
    oversized: z.literal(true).optional(),
    unreadable: z.literal(true).optional(),
    shadowed: z.literal(true).optional(),
    builds: z.array(opaqueIdSchema).max(NOTE_INFO_BUILDS_MAX).optional(),
  })
  .refine((note) => [note.oversized, note.unreadable, note.shadowed].filter((flag) => flag === true).length <= 1, 'a sticky note has at most one of oversized, unreadable, shadowed')
  .refine((note) => (note.oversized === undefined && note.unreadable === undefined && note.shadowed === undefined) || note.links.length === 0, 'a sticky note that was not read has no links')
  .refine((note) => new Set(note.links.map(foldNoteName)).size === note.links.length, 'a sticky note names each link once');
export type NoteInfo = z.infer<typeof noteInfoSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Outside sources (D6)
// ---------------------------------------------------------------------------------------------------------------

/** The two outside sources the host may connect (`smurg connect slack|discord`). */
export const OUTSIDE_SOURCES = ['slack', 'discord'] as const;
export const outsideSourceSchema = z.enum(OUTSIDE_SOURCES);
export type OutsideSource = z.infer<typeof outsideSourceSchema>;

/** Slack: a channel id (public `C…`, private `G…`), a user id (`U…`, `W…` in an organisation), a message's `ts`. */
export const SLACK_CHANNEL_PATTERN = /^[CG][A-Z0-9]{8,31}$/;
export const SLACK_USER_PATTERN = /^[UW][A-Z0-9]{8,31}$/;
export const SLACK_TS_PATTERN = /^[0-9]{1,16}\.[0-9]{1,16}$/;
/** Discord: every id (a channel, a user, a message) is a snowflake. */
export const DISCORD_ID_PATTERN = /^[0-9]{17,20}$/;

/**
 * The channel a host connects (`smurg connect slack|discord --channel <id>`), checked by the command when it is typed
 * and by the daemon again whenever it reads the entry of `~/.smurg/connectors.json` (DESIGN 0.8.0 D6.2): an id that
 * fails is never put into a URL that carries the token (a file edited by hand or by an agent, `C0123/../x`).
 */
export function isOutsideChannelId(source: OutsideSource, id: string): boolean {
  return (source === 'slack' ? SLACK_CHANNEL_PATTERN : DISCORD_ID_PATTERN).test(id);
}

/** The longest bot token smurg takes (Slack's are about 60 characters, Discord's about 72). */
export const OUTSIDE_TOKEN_MAX_CHARS = 256;
/** A Slack bot token (`xoxb-`: a bot's, never a person's `xoxp-`, D6.1) and a Discord bot token (no fixed prefix). */
const SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{1,250}$/;
const DISCORD_BOT_TOKEN = /^[A-Za-z0-9._-]{20,256}$/;

/**
 * A bot token of the source's form: the characters a token has, nothing a header or a URL would read otherwise, at most
 * OUTSIDE_TOKEN_MAX_CHARS. Checked by `smurg connect` and by the daemon before it puts a token into a request.
 */
export function isOutsideBotToken(source: OutsideSource, token: string): boolean {
  return token.length <= OUTSIDE_TOKEN_MAX_CHARS && (source === 'slack' ? SLACK_BOT_TOKEN : DISCORD_BOT_TOKEN).test(token);
}

export const slackChannelIdSchema = z.string().regex(SLACK_CHANNEL_PATTERN, 'not a Slack channel id');
export const slackUserIdSchema = z.string().regex(SLACK_USER_PATTERN, 'not a Slack user id');
export const slackTsSchema = z.string().regex(SLACK_TS_PATTERN, 'not a Slack message time');
export const discordIdSchema = z.string().regex(DISCORD_ID_PATTERN, 'not a Discord id');

/**
 * What an outside source is doing, for the host to see that it works (D6.4): `reading` its channel once a minute,
 * `waiting-for-room` while an outside budget of D4.5 is full, `failing` with the sentence that says why.
 */
export const SOURCE_STATES = ['reading', 'waiting-for-room', 'failing'] as const;
export const sourceStateSchema = z
  .strictObject({ source: outsideSourceSchema, state: z.enum(SOURCE_STATES), problem: wireTextSchema.optional() })
  .refine((source) => (source.state === 'failing') === (source.problem !== undefined), 'a failing source says why, and only a failing one');
export type SourceState = z.infer<typeof sourceStateSchema>;

/** The connected sources, each once. Empty while none is connected. */
export const sourceStatesSchema = z
  .array(sourceStateSchema)
  .max(OUTSIDE_SOURCES.length)
  .refine((sources) => new Set(sources.map((source) => source.source)).size === sources.length, 'each source once');

/**
 * Where an outside source goes on reading (D6.3): the channel the cursor belongs to and the newest message read. A
 * cursor of another channel is not used: a channel reads from now on. One per source.
 */
export const stickyCursorsSchema = z.strictObject({
  slack: z.strictObject({ channel: slackChannelIdSchema, after: slackTsSchema }).optional(),
  discord: z.strictObject({ channel: discordIdSchema, after: discordIdSchema }).optional(),
});
export type StickyCursors = z.infer<typeof stickyCursorsSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Feedback (D4.3)
// ---------------------------------------------------------------------------------------------------------------

/** Feedback as it is stored, shown and quoted: the output of `agentText()` (`cleaned` when it removed something). */
export const feedbackTextSchema = cleanedTextSchema(FEEDBACK_TEXT_MAX_CHARS);

/** A person outside the workspace as named after cleaning (nothing unseen, white space collapsed, D6.3). */
export const outsideNameSchema = lineTextSchema(OUTSIDE_NAME_MAX_CHARS, 1);

/**
 * Who wrote feedback: a member, or a person outside the workspace who wrote in the connected Slack or Discord channel
 * (never a member: no role, no mention, no inbox, no avatar). Their outside id has the form of their source's ids.
 */
export const feedbackAuthorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), user: userRefSchema }),
  z
    .strictObject({ kind: z.literal('outside'), source: outsideSourceSchema, name: outsideNameSchema, externalId: z.string().max(32) })
    .refine((author) => (author.source === 'slack' ? SLACK_USER_PATTERN : DISCORD_ID_PATTERN).test(author.externalId), "not an id of the source's users"),
]);
export type FeedbackAuthor = z.infer<typeof feedbackAuthorSchema>;

/** `waiting` for a member with agent access; `accepted` or `rejected` by one; `withdrawn` by its author. */
export const FEEDBACK_STATUSES = ['waiting', 'accepted', 'rejected', 'withdrawn'] as const;
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

/**
 * Feedback on a sticky note (D4.3). `note` names the note it is on; `text` is exactly what is shown and what an
 * accept quotes. `cleaned`: `agentText` removed invisible characters; `cut`: an outside message was longer than
 * FEEDBACK_TEXT_MAX_CHARS and was cut. `decidedBy` and `decidedAt` exactly when it was accepted or rejected;
 * `rejectReason` (a person's words) only with a rejection.
 */
export const feedbackSchema = z
  .strictObject({
    id: opaqueIdSchema,
    note: noteNameSchema,
    text: feedbackTextSchema,
    cleaned: z.literal(true).optional(),
    cut: z.literal(true).optional(),
    author: feedbackAuthorSchema,
    status: feedbackStatusSchema,
    createdAt: epochMsSchema,
    decidedBy: userRefSchema.optional(),
    decidedAt: epochMsSchema.optional(),
    rejectReason: reasonTextSchema.optional(),
  })
  .refine((entry) => (entry.status === 'accepted' || entry.status === 'rejected') === (entry.decidedBy !== undefined), 'decidedBy goes with an accept or a reject')
  .refine((entry) => (entry.decidedBy === undefined) === (entry.decidedAt === undefined), 'decidedBy and decidedAt go together')
  .refine((entry) => entry.rejectReason === undefined || entry.status === 'rejected', 'only a rejection has a reason')
  .refine((entry) => entry.cut === undefined || entry.author.kind === 'outside', 'only an outside message is cut');
export type Feedback = z.infer<typeof feedbackSchema>;

/** The characters one entry adds to the bound FEEDBACK_STORED_MAX_CHARS: its text and its reason. */
export function feedbackStoredChars(entry: Pick<Feedback, 'text' | 'rejectReason'>): number {
  return entry.text.length + (entry.rejectReason?.length ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Builds (D5.2)
// ---------------------------------------------------------------------------------------------------------------

/** A topic made with "Build this" from a sticky note: by whom, when, and the hash of the spec they confirmed. */
export const noteBuildSchema = z.strictObject({
  note: noteNameSchema,
  topicId: opaqueIdSchema,
  by: userRefSchema,
  at: epochMsSchema,
  hash: sha256HexSchema,
});
export type NoteBuild = z.infer<typeof noteBuildSchema>;
