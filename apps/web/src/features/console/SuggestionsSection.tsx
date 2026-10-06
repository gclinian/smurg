// Pending suggestions across every agent session (SPEC R11 "pending suggestions"; DESIGN §3.10, §5.7): an overview.
// A suggestion is text for an agent written by someone who may not message agents; it reaches the agent only when
// the host or a member with agent access accepts it, on its card in the session's conversation (R6: never
// automatically). Nothing is decided here: "Open" shows the card.
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSession, sessionTitle } from '../../lib/stores/sessions.ts';
import { selectSuggestionList } from '../../lib/stores/suggestions.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, EmptyState } from '../../ui/index.ts';
import { useOpenSession } from './open-session.ts';
import { t } from './strings.ts';

/** Characters of a suggestion shown here; the card in the conversation shows the whole text. */
const PREVIEW_CHARS = 400;

export function SuggestionsSection({ now }: { now: number }) {
  const stores = useStores();
  const pending = useStore(stores.suggestions, (state) => selectSuggestionList(state).filter((s) => s.status === 'pending'), shallowEqual);
  const status = useStore(stores.suggestions, (state) => state.status);
  const loadError = useStore(stores.suggestions, (state) => state.error);
  const sessions = useStore(stores.sessions);
  const open = useOpenSession();

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
            const session = selectSession(sessions, suggestion.sessionId);
            const text = suggestion.text.length > PREVIEW_CHARS ? `${suggestion.text.slice(0, PREVIEW_CHARS)}…` : suggestion.text;
            const author = suggestion.author.displayName;
            const topic = session?.kind === 'agent' ? session.topicName : undefined;
            return (
              <li key={suggestion.id} className="console-suggestion">
                <p className="console-suggestion__target">
                  {session === undefined
                    ? t('suggestions.unknownSession', { author })
                    : topic === undefined
                      ? t('suggestions.target', { author, title: sessionTitle(session) })
                      : t('suggestions.targetTopic', { author, topic, title: sessionTitle(session) })}
                  <span className="console-muted">{formatRelativeTime(suggestion.createdAt, now)}</span>
                  {session === undefined ? null : (
                    <Button size="sm" variant="ghost" aria-label={t('suggestions.openLabel', { author })} onClick={() => open(suggestion.sessionId, suggestion.id)}>
                      {t('suggestions.open')}
                    </Button>
                  )}
                </p>
                <p className="console-suggestion__text">{text}</p>
                {suggestion.source ? (
                  <p className="console-muted">
                    {suggestion.source.startLine === suggestion.source.endLine
                      ? t('suggestions.sourceLine', { path: suggestion.source.file.path, start: suggestion.source.startLine })
                      : t('suggestions.source', { path: suggestion.source.file.path, start: suggestion.source.startLine, end: suggestion.source.endLine })}
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
