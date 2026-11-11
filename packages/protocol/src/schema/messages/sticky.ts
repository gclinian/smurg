import { z } from 'zod';
import { noteNameSchema } from '../../notes.ts';
import { personTextSchema, reasonTextSchema } from '../entities.ts';
import { FEEDBACK_MAX, FEEDBACK_TEXT_MAX_CHARS, NOTES_MAX, SHORT_TEXT_MAX_CHARS } from '../limits.ts';
import { opaqueIdSchema } from '../primitives.ts';
import { feedbackSchema, noteInfoSchema, sourceStatesSchema } from '../sticky.ts';
import { emptyPayloadSchema } from './channel.ts';
import { agentSessionResultSchema } from './sessions.ts';

// sticky.* (ARCHITECTURE §5.12, protocol 7: DESIGN 0.8.0 D2, D3.5, D4). The sticky notes are the Markdown files of
// `notes/` in the main workspace; the daemon keeps an index of them (each note's links and flags, nothing else of its
// content) and tells every member who may read files only what changed. Feedback on a note (`sticky.feedback.*`)
// reaches no agent until a member with `session.drive` accepts it: then it goes once, quoted, to Claude for the sticky
// notes as that member's own message (`composeFeedback` of agent-text.ts, in `sticky.feedback.accept` only).

/**
 * The index, in the daemon's order (by name, code unit by code unit). THE list rule: a reply is closed at
 * LIST_REPLY_MAX_BYTES; `hasMore` then, and `after` (the last note's name) continues. `truncated`: `notes/` holds more
 * sticky notes than NOTES_MAX, and the rest are not listed. `sources`: the outside sources the host connected (D6.4).
 */
export const stickyListPayloadSchema = z.strictObject({ after: noteNameSchema.optional() });
export const stickyListResultSchema = z.strictObject({
  notes: z.array(noteInfoSchema).max(NOTES_MAX),
  hasMore: z.boolean(),
  truncated: z.boolean(),
  sources: sourceStatesSchema,
});

/**
 * To every member who may read files, only when a note's links or flags changed, a note appeared or went, or
 * `truncated` or a source's state changed: the notes that are new or changed, the names of those that went.
 */
export const stickyChangedPayloadSchema = z.strictObject({
  upserted: z.array(noteInfoSchema).max(NOTES_MAX),
  removed: z.array(noteNameSchema).max(NOTES_MAX),
  truncated: z.boolean(),
  sources: sourceStatesSchema.optional(),
});

/**
 * A new, empty sticky note `notes/<name>.md`, written as the caller (the folder `notes` is made when it is missing).
 * The name is checked by the daemon (`sticky.name.invalid`), so a person is told the rule; a name that folds equal to
 * an existing note's is refused (`conflict`, reason `exists`).
 */
export const stickyCreatePayloadSchema = z.strictObject({ name: z.string().max(SHORT_TEXT_MAX_CHARS) });
export const stickyCreateResultSchema = z.strictObject({ note: noteInfoSchema });

/** Claude for the sticky notes: the running one, or one started now for the caller (one per workspace, D3.5). */
export const stickyAssistantStartPayloadSchema = emptyPayloadSchema;
export const stickyAssistantStartResultSchema = agentSessionResultSchema;

// ---------------------------------------------------------------------------------------------------------------
// Feedback (D4.4)
// ---------------------------------------------------------------------------------------------------------------

/** Feedback as it arrives: any text but NUL, not blank. The daemon stores, shows and quotes `agentText(text).text`. */
export const feedbackInputTextSchema = personTextSchema(FEEDBACK_TEXT_MAX_CHARS);

/**
 * Anyone in the workspace (`feedback.give`, a Viewer too), on a note the index holds (else `not_found`,
 * `sticky.note.missing`). Waiting feedback is never dropped to make room: past a bound the create is refused (`conflict`,
 * reason `feedback-full`). Rate bucket: `suggestion`.
 */
export const stickyFeedbackCreatePayloadSchema = z.strictObject({ note: noteNameSchema, text: feedbackInputTextSchema });
export const stickyFeedbackResultSchema = z.strictObject({ feedback: feedbackSchema });

/** Its author, while it waits. The entry is removed at once (the audit log keeps it); the reply says `withdrawn`. */
export const stickyFeedbackWithdrawPayloadSchema = z.strictObject({ feedbackId: opaqueIdSchema });

/**
 * `session.drive`, while it waits: ONE message to Claude for the sticky notes, as the caller, that quotes it
 * (`composeFeedback`); `accepted` only once that message was sent. With no Claude for the sticky notes: `conflict`,
 * reason `no-assistant`.
 */
export const stickyFeedbackAcceptPayloadSchema = z.strictObject({ feedbackId: opaqueIdSchema });

/** `session.drive`, while it waits. Nothing is sent to any agent. `reason`: a person's words, shown to everyone. */
export const stickyFeedbackRejectPayloadSchema = z.strictObject({ feedbackId: opaqueIdSchema, reason: reasonTextSchema.optional() });

/**
 * Every feedback the daemon keeps, oldest first. THE list rule: a reply is closed at LIST_REPLY_MAX_BYTES; `hasMore`
 * then, and `after` (the last entry's id) continues.
 */
export const stickyFeedbackListPayloadSchema = z.strictObject({ after: opaqueIdSchema.optional() });
export const stickyFeedbackListResultSchema = z.strictObject({ feedback: z.array(feedbackSchema).max(FEEDBACK_MAX), hasMore: z.boolean() });

/** To every member: one entry as it is now, or the id of one that is gone (withdrawn, or dropped at a bound). */
export const stickyFeedbackUpdatedPayloadSchema = z.union([z.strictObject({ feedback: feedbackSchema }), z.strictObject({ removed: opaqueIdSchema })]);
