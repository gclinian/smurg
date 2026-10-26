// `inbox.json` (ARCHITECTURE §7.1, §5.11): the only things about an inbox that are stored. Everything else in a
// member's inbox is derived from what is open right now (derive.ts).
//
//   notes   mentions of the member, and what became of their own suggestions (rejected, accepted after an edit). A
//           note is unopened for as long as it is stored: opening it (`inbox.seen`) or dismissing it removes it.
//   seen    per derived item the member has looked at: the item's key and the STAMP it had then. An item is unread
//           without a mark, and again when its stamp moved on (derive.ts says what moves a stamp).
//
// The document is validated on load and on every update (StateStore): a file edited by hand to hold a control
// character or an unknown target stops the daemon instead of reaching a client.
import { z } from 'zod';
import { declareDocument } from '../core/state-store.ts';
import {
  INBOX_EXCERPT_MAX_CHARS,
  INBOX_ITEMS_MAX,
  INBOX_NOTES_PER_MEMBER_MAX,
  INBOX_RESULTS,
  actorSchema,
  consoleSectionSchema,
  epochMsSchema,
  inboxAnchorSchema,
  inboxKeySchema,
  itemIdSchema,
  multilineTextSchema,
  opaqueIdSchema,
  userIdSchema,
} from '@smurg/protocol';

export const INBOX_DOCUMENT = 'inbox';
export const INBOX_VERSION = 1;
/** A stamp is a few characters the derivation makes (a version, a status, an id). */
export const SEEN_STAMP_MAX_CHARS = 200;

/**
 * Where a stored mention was written: the six column kinds of 0.6.0, on purpose not the wire's `columnTargetSchema`
 * (0.7.0, DESIGN 0.7.0 D4, R-ENG E4). The wire gained the Result column (`result`), where nobody writes, so a stored
 * note never names it, and inbox.json keeps the shape 0.6.0 wrote: no step.
 */
export const storedColumnTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('spec'), topicId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('plan'), topicId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('report'), topicId: opaqueIdSchema, itemId: itemIdSchema }),
  z.strictObject({ kind: z.literal('changes'), requestId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('console'), section: consoleSectionSchema }),
]);
export type StoredColumnTarget = z.infer<typeof storedColumnTargetSchema>;

const mentionNoteSchema = z.strictObject({
  id: opaqueIdSchema,
  kind: z.literal('mention'),
  at: epochMsSchema,
  /** Who mentioned the member: a person or an agent. */
  from: actorSchema,
  /** What the mention was written in. */
  target: storedColumnTargetSchema,
  anchor: inboxAnchorSchema.optional(),
  /** The text around the mention. */
  excerpt: multilineTextSchema(INBOX_EXCERPT_MAX_CHARS),
});

const resultNoteSchema = z.strictObject({
  id: opaqueIdSchema,
  kind: z.literal('result'),
  at: epochMsSchema,
  /** Who rejected or edited the suggestion. */
  from: actorSchema,
  sessionId: opaqueIdSchema,
  suggestionId: opaqueIdSchema,
  outcome: z.enum(INBOX_RESULTS),
  /** The suggestion's text. */
  excerpt: multilineTextSchema(INBOX_EXCERPT_MAX_CHARS),
});

export const storedNoteSchema = z.discriminatedUnion('kind', [mentionNoteSchema, resultNoteSchema]);
export type StoredNote = z.infer<typeof storedNoteSchema>;
export type MentionNote = z.infer<typeof mentionNoteSchema>;
export type ResultNote = z.infer<typeof resultNoteSchema>;

export const memberBoxSchema = z.strictObject({
  /** Oldest first. */
  notes: z.array(storedNoteSchema).max(INBOX_NOTES_PER_MEMBER_MAX),
  /** Inbox key → the stamp the item had when the member looked at it. */
  seen: z.record(inboxKeySchema, z.string().max(SEEN_STAMP_MAX_CHARS)).refine((marks) => Object.keys(marks).length <= INBOX_ITEMS_MAX, 'too many seen marks'),
});
export type MemberBox = z.infer<typeof memberBoxSchema>;

export const inboxDocumentSchema = z.strictObject({
  version: z.literal(INBOX_VERSION),
  members: z.record(userIdSchema, memberBoxSchema),
});
export type InboxDocument = z.infer<typeof inboxDocumentSchema>;

export function initialInboxDocument(): InboxDocument {
  return { version: INBOX_VERSION, members: {} };
}

/** inbox.json (new in 0.5.0). Declared by the inbox module. */
export const inboxDocument = declareDocument({ name: INBOX_DOCUMENT, schema: inboxDocumentSchema, init: initialInboxDocument, canSetAside: true });

export function emptyBox(): MemberBox {
  return { notes: [], seen: {} };
}

/** The inbox key of a stored note: `mention:<id>` / `result:<id>`. */
export function noteKey(note: Pick<StoredNote, 'kind' | 'id'>): string {
  return `${note.kind}:${note.id}`;
}
