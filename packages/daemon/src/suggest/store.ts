// `suggestions.json` (ARCHITECTURE §7.1): every suggestion the daemon still keeps, pending ones first of all, so the
// queue survives a daemon restart. The text is validated with the protocol's suggestion schema on load and on every
// update (StateStore): a file edited to carry control characters stops the daemon instead of reaching an agent.
import { z } from 'zod';
import { epochMsSchema, suggestionSchema, userIdSchema, type Suggestion } from '@smurg/protocol';
import { declareDocument, defineStep, type DocumentStep } from '../core/state-store.ts';
import { suggestionsShapeV040, type SuggestionsV040 } from '../frozen/v0.4.0.ts';

export const SUGGESTIONS_DOCUMENT = 'suggestions';
export const SUGGESTIONS_VERSION = 1;

export const storedSuggestionSchema = suggestionSchema.extend({
  /** Who had opened the target session when the suggestion was made (the audit entries name them). */
  sessionOwnerUserId: userIdSchema,
  /** When the author last changed the text (suggest.edit): a plain accept right after it is ambiguous. */
  editedAt: epochMsSchema.optional(),
});
export type StoredSuggestion = z.infer<typeof storedSuggestionSchema>;

export const suggestionsDocumentSchema = z.strictObject({
  version: z.literal(SUGGESTIONS_VERSION),
  suggestions: z.array(storedSuggestionSchema).max(1_000),
});
export type SuggestionsDocument = z.infer<typeof suggestionsDocumentSchema>;

export function initialSuggestionsDocument(): SuggestionsDocument {
  return { version: SUGGESTIONS_VERSION, suggestions: [] };
}

/**
 * suggestions.json of smurg 0.4.0 → today's: 0.5.0 made `origin` required. A 0.4.0 entry was made from a code
 * selection when it has a `source`, else typed in the composer (the rule of today's own create()). Every entry is
 * carried, with its text, status and decision as they are; nothing else is added (`cleaned`, topic, item, mentions
 * and `decidedBy` stay absent). An entry that was still pending is NOT decided here: the suggest module closes it at
 * its start as it closes every pending suggestion whose session is gone (`rejected`, `session-ended`, by the system),
 * so no text of 0.4.0 reaches an agent.
 */
export const suggestionsStepFromV040: DocumentStep = defineStep({
  from: '0.4.0',
  sinceShapes: 1,
  shape: suggestionsShapeV040,
  upgrade: (old: SuggestionsV040) => ({
    ...old,
    suggestions: old.suggestions.map((entry) => ({ ...entry, origin: entry.source === undefined ? ('composer' as const) : ('selection' as const) })),
  }),
});

/** Declared by the suggest module. */
export const suggestionsDocument = declareDocument({ name: SUGGESTIONS_DOCUMENT, schema: suggestionsDocumentSchema, init: initialSuggestionsDocument, steps: [suggestionsStepFromV040] });

export function toSuggestion(stored: StoredSuggestion): Suggestion {
  const { sessionOwnerUserId: _owner, editedAt: _editedAt, ...suggestion } = stored;
  return suggestion;
}
