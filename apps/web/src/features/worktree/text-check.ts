// Client-side checks of the texts this feature sends, with the protocol's own schemas (the daemon validates again):
// a merge request's message (multi-line) and a rejection reason (one line). Returns a zh-TW problem or null.
import { MERGE_MESSAGE_MAX_CHARS, REASON_MAX_CHARS, mergeMessageSchema, reasonTextSchema } from '@smurg/protocol';
import { t } from './strings.ts';

export function mergeMessageProblem(text: string): string | null {
  if (text.length > MERGE_MESSAGE_MAX_CHARS) return t('text.tooLong', { max: MERGE_MESSAGE_MAX_CHARS });
  return mergeMessageSchema.safeParse(text).success ? null : t('text.invalidMultiline');
}

export function reasonProblem(text: string): string | null {
  if (text.length > REASON_MAX_CHARS) return t('text.tooLong', { max: REASON_MAX_CHARS });
  return reasonTextSchema.safeParse(text).success ? null : t('text.invalidLine');
}
