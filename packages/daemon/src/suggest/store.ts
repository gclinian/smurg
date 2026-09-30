// `suggestions.json` (ARCHITECTURE §7.1): every suggestion the daemon still keeps, pending ones first of all, so the
// queue survives a daemon restart. The text is validated with the protocol's suggestion schema on load and on every
// update (StateStore): a file edited to carry control characters stops the daemon instead of reaching a PTY.
import { z } from 'zod';
import { epochMsSchema, suggestionSchema, userIdSchema, type Suggestion } from '@smurg/protocol';

export const SUGGESTIONS_DOCUMENT = 'suggestions';
export const SUGGESTIONS_VERSION = 1;

export const storedSuggestionSchema = suggestionSchema.extend({
  /** Owner of the target session when the suggestion was made (sessions do not outlive the daemon). */
  sessionOwnerUserId: userIdSchema,
  /** When the author last changed the text (suggest.edit): a plain accept right after it is ambiguous (SEC-D-01). */
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

export function toSuggestion(stored: StoredSuggestion): Suggestion {
  const { sessionOwnerUserId: _owner, editedAt: _editedAt, ...suggestion } = stored;
  return suggestion;
}
