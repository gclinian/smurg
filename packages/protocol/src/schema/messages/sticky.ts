import { z } from 'zod';
import { noteNameSchema } from '../../notes.ts';
import { NOTES_MAX, SHORT_TEXT_MAX_CHARS } from '../limits.ts';
import { noteInfoSchema, sourceStatesSchema } from '../sticky.ts';
import { emptyPayloadSchema } from './channel.ts';
import { agentSessionResultSchema } from './sessions.ts';

// sticky.* (ARCHITECTURE §5.12, protocol 7: DESIGN 0.8.0 D2, D3.5). The sticky notes are the Markdown files of
// `notes/` in the main workspace; the daemon keeps an index of them (each note's links and flags, nothing else of its
// content) and tells every member who may read files only what changed.

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
