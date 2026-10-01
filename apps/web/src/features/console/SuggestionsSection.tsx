// Pending suggestions across every session (SPEC R11 「待處理的建議」): a read-only overview. Accepting or rejecting is
// done at the session, by the host or a 可使用 agent member (protocol v2 `session.drive`, R6: never automatically).
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSuggestionList } from '../../lib/stores/suggestions.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, EmptyState } from '../../ui/index.ts';
import { t } from './strings.ts';

/** Characters of a suggestion shown here; the owner sees the whole text in their queue. */
const PREVIEW_CHARS = 400;

export function SuggestionsSection({ now }: { now: number }) {
  const stores = useStores();
  const pending = useStore(stores.suggestions, (state) => selectSuggestionList(state).filter((s) => s.status === 'pending'), shallowEqual);
  const status = useStore(stores.suggestions, (state) => state.status);
  const loadError = useStore(stores.suggestions, (state) => state.error);
  const sessions = useStore(stores.sessions, (state) => state.sessions);

  return (
    <>
      <p className="console-hint">{t('suggestions.lead')}</p>
      {status === 'error' && loadError ? (
        <Banner tone="danger" live="none">
          {t('suggestions.loadFailed', { message: loadError })}
        </Banner>
      ) : null}
      {pending.length === 0 ? (
        <EmptyState compact title={t('suggestions.empty')} />
      ) : (
        <ul className="console-suggestions">
          {pending.map((suggestion) => {
            const session = sessions.get(suggestion.sessionId);
            const text = suggestion.text.length > PREVIEW_CHARS ? `${suggestion.text.slice(0, PREVIEW_CHARS)}…` : suggestion.text;
            return (
              <li key={suggestion.id} className="console-suggestion">
                <p className="console-suggestion__target">
                  {session
                    ? t('suggestions.target', { author: suggestion.author.displayName, owner: session.ownerName, title: session.title })
                    : t('suggestions.unknownSession', { author: suggestion.author.displayName })}
                  <span className="console-muted">{formatRelativeTime(suggestion.createdAt, now)}</span>
                </p>
                <p className="console-suggestion__text">{text}</p>
                {suggestion.source ? (
                  <p className="console-muted">
                    {t('suggestions.source', { path: suggestion.source.file.path, start: suggestion.source.startLine, end: suggestion.source.endLine })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
