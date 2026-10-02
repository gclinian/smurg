// Tells the author when someone decided (SPEC R6 "the author is told the outcome"; the host or any member with agent access may, and the
// suggestion does not say who, so the notice does not name anyone). A notice is shown only for a
// suggestion this client saw PENDING and now sees accepted / rejected: never for what the first load (or a reload after
// a full resync) already found resolved long ago — but a suggestion decided while this client was disconnected is
// still announced when the reload brings it back (the last seen status survives the store's reset).
import { useEffect } from 'react';
import type { Suggestion } from '@smurg/protocol';
import { useStores } from '../../lib/workspace/context.tsx';
import { useToast } from '../../ui/index.ts';
import { t } from './strings.ts';
import { resolutionReason } from './text.ts';

const EXCERPT_CHARS = 80;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

export function useResolutionNotices(userId: string | null): void {
  const stores = useStores();
  const toast = useToast();
  useEffect(() => {
    if (userId === null) return;
    const lastSeen = new Map<string, Suggestion['status']>();
    const scan = (announce: boolean): void => {
      for (const suggestion of stores.suggestions.getState().suggestions.values()) {
        const previous = lastSeen.get(suggestion.id);
        lastSeen.set(suggestion.id, suggestion.status);
        if (!announce || previous !== 'pending' || suggestion.author.userId !== userId) continue;
        if (suggestion.status === 'pending' || suggestion.status === 'withdrawn') continue;
        const text = excerpt(suggestion.status === 'accepted-modified' && suggestion.finalText !== undefined ? suggestion.finalText : suggestion.text);
        if (suggestion.status === 'rejected') {
          const reason = resolutionReason(suggestion);
          toast.show({
            tone: 'warning',
            title: t('notice.rejected'),
            // The suggestion on its own line, then the reason (they ran together).
            description: reason !== null ? t('notice.quoteReason', { text, reason }) : t('notice.quote', { text }),
          });
        } else {
          toast.show({
            tone: 'success',
            title: suggestion.status === 'accepted-modified' ? t('notice.acceptedModified') : t('notice.accepted'),
            description: text,
          });
        }
      }
    };
    scan(false);
    return stores.suggestions.subscribe(() => scan(true));
  }, [stores, toast, userId]);
}
