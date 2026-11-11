// `sticky.json` (ARCHITECTURE §7.1, DESIGN 0.8.0 D4.5): the one document of the sticky module, with its whole stored
// shape from the first version on: the feedback on sticky notes (D4.3), where each outside source goes on reading
// (D6.3) and the topics made from notes (D5.2). The index of the notes is never stored: it is read from `notes/`.
//
// No published smurg wrote it: no step. It cannot be set aside: its records are feedback that people wrote, so a
// damaged file stops the start instead of being put away. Validated on load and on every update (StateStore): a file
// edited by hand to hold a control character or a name that is no sticky note's stops the daemon.
import { z } from 'zod';
import { FEEDBACK_MAX, FEEDBACK_STORED_MAX_CHARS, NOTE_BUILDS_MAX, feedbackSchema, feedbackStoredChars, noteBuildSchema, stickyCursorsSchema } from '@smurg/protocol';
import { declareDocument } from '../core/state-store.ts';

export const STICKY_DOCUMENT = 'sticky';
export const STICKY_VERSION = 1;

export const stickyDocumentSchema = z.strictObject({
  version: z.literal(STICKY_VERSION),
  /** Oldest first. Waiting entries are never dropped; at the bounds the oldest decided ones go (D4.5). */
  feedback: z
    .array(feedbackSchema)
    .max(FEEDBACK_MAX)
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, 'each feedback once')
    .refine((entries) => entries.reduce((chars, entry) => chars + feedbackStoredChars(entry), 0) <= FEEDBACK_STORED_MAX_CHARS, 'feedback over its stored bound'),
  cursors: stickyCursorsSchema,
  /** Oldest first; the oldest goes beyond the bound. */
  builds: z.array(noteBuildSchema).max(NOTE_BUILDS_MAX),
});
export type StickyDocument = z.infer<typeof stickyDocumentSchema>;

export function initialStickyDocument(): StickyDocument {
  return { version: STICKY_VERSION, feedback: [], cursors: {}, builds: [] };
}

/** sticky.json (new in 0.8.0). Declared by the sticky module. */
export const stickyDocument = declareDocument({ name: STICKY_DOCUMENT, schema: stickyDocumentSchema, init: initialStickyDocument });
