// The queue of suggestions beside a terminal (SPEC R6 「看到建議佇列，可以採用、修改後採用、拒絕」), for everyone who may
// type into the session — the host and 可使用 agent members, on ANY session (protocol v2, `session.drive`): proposer,
// time, the text; accept, edit then accept, or reject with a reason. Accepting is the ONLY way a suggestion's text
// reaches the PTY (the daemon pastes it after its check). There is deliberately no "accept automatically" option
// anywhere (SPEC 「沒有自動採用選項」).
import { useState } from 'react';
import type { SessionInfo, Suggestion } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSuggestionsForSession } from '../../lib/stores/suggestions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Input, TextArea, useToast } from '../../ui/index.ts';
import { IconCheck, IconClose, IconEdit } from '../../ui/icons.tsx';
import { SuggestionCard } from './SuggestionCard.tsx';
import { t } from './strings.ts';
import { cleanSuggestionText, suggestionTextProblem, textProblemMessage } from './text.ts';

const HISTORY_SHOWN = 10;

type Mode = { readonly kind: 'view' } | { readonly kind: 'edit'; readonly text: string } | { readonly kind: 'reject'; readonly reason: string };

function QueueItem({ suggestion, session, now }: { suggestion: Suggestion; session: SessionInfo; now: number }) {
  const stores = useStores();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exited = session.status === 'exited';
  const author = suggestion.author.displayName;

  const act = async (action: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      toast.show({ tone: 'success', title: done });
      setMode({ kind: 'view' });
    } catch (failure) {
      setError(t('queue.failed', { message: describeError(failure) }));
    } finally {
      setBusy(false);
    }
  };

  const acceptEdited = (text: string): void => {
    const clean = cleanSuggestionText(text);
    const problem = suggestionTextProblem(clean);
    if (problem !== null) {
      setError(textProblemMessage(problem));
      return;
    }
    // Always the text the owner confirmed (review SEC-D-01): the daemon pastes exactly it, and records it as accepted when
    // it equals the suggestion's current text, accepted-modified otherwise (both texts are logged, R6.3).
    void act(() => stores.suggestions.accept(suggestion.id, clean), t('queue.accepted', { name: author }));
  };

  return (
    <li>
      <SuggestionCard suggestion={suggestion} heading={t('queue.from', { name: author })} now={now} showStatus={false}>
        {mode.kind === 'edit' ? (
          <div className="suggest-card__form">
            <TextArea label={t('queue.editLabel')} rows={5} value={mode.text} onChange={(event) => setMode({ kind: 'edit', text: event.currentTarget.value })} />
            <div className="suggest-card__actions">
              <Button size="sm" variant="ghost" onClick={() => setMode({ kind: 'view' })} disabled={busy}>
                {tApp('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" icon={<IconCheck />} loading={busy} disabled={exited} onClick={() => acceptEdited(mode.text)}>
                {t('queue.confirmEdit')}
              </Button>
            </div>
          </div>
        ) : mode.kind === 'reject' ? (
          <div className="suggest-card__form">
            <Input label={t('queue.reasonLabel')} maxLength={1000} value={mode.reason} onChange={(event) => setMode({ kind: 'reject', reason: event.currentTarget.value })} />
            <div className="suggest-card__actions">
              <Button size="sm" variant="ghost" onClick={() => setMode({ kind: 'view' })} disabled={busy}>
                {tApp('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={busy}
                onClick={() => {
                  const reason = mode.reason.replace(/[\r\n\t]+/g, ' ').trim();
                  void act(() => stores.suggestions.reject(suggestion.id, reason === '' ? undefined : reason), t('queue.rejected', { name: author }));
                }}
              >
                {t('queue.confirmReject')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="suggest-card__actions">
            <Button
              size="sm"
              variant="primary"
              icon={<IconCheck />}
              loading={busy}
              disabled={exited}
              // The text on screen when the owner clicked, not whatever the author may have changed it to since (SEC-D-01).
              onClick={() => void act(() => stores.suggestions.accept(suggestion.id, suggestion.text), t('queue.accepted', { name: author }))}
            >
              {t('queue.accept')}
            </Button>
            <Button size="sm" variant="secondary" icon={<IconEdit />} disabled={busy || exited} onClick={() => setMode({ kind: 'edit', text: suggestion.text })}>
              {t('queue.editAccept')}
            </Button>
            <Button size="sm" variant="ghost" icon={<IconClose />} disabled={busy} onClick={() => setMode({ kind: 'reject', reason: '' })}>
              {t('queue.reject')}
            </Button>
          </div>
        )}
        {error !== null ? (
          <Banner tone="danger" live="alert">
            {error}
          </Banner>
        ) : null}
      </SuggestionCard>
    </li>
  );
}

export interface OwnerQueueProps {
  readonly session: SessionInfo;
  readonly now: number;
  /** Pending suggestions on OTHER sessions this member decides on too, and a way to go there. */
  readonly othersPending: number;
  onShowOthers(): void;
}

export function OwnerQueue({ session, now, othersPending, onShowOthers }: OwnerQueueProps) {
  const stores = useStores();
  const forSession = useStore(stores.suggestions, (state) => selectSuggestionsForSession(state, session.id), shallowEqual);
  const pending = forSession.filter((suggestion) => suggestion.status === 'pending');
  const history = forSession
    .filter((suggestion) => suggestion.status !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt))
    .slice(0, HISTORY_SHOWN);

  return (
    <section className="suggest-section" aria-label={t('queue.title', { count: pending.length })}>
      <h3 className="suggest-section__title">{t('queue.title', { count: pending.length })}</h3>
      <p className="suggest-note">{t('queue.lead')}</p>
      {session.status === 'exited' && pending.length > 0 ? <p className="suggest-note">{t('queue.exited')}</p> : null}
      {pending.length === 0 ? (
        <p className="suggest-note" role="status">
          {t('queue.empty')}
        </p>
      ) : (
        <ol className="suggest-list">
          {pending.map((suggestion) => (
            <QueueItem key={suggestion.id} suggestion={suggestion} session={session} now={now} />
          ))}
        </ol>
      )}
      {othersPending > 0 ? (
        <div className="suggest-others">
          <span>{t('queue.others', { count: othersPending })}</span>
          <Button size="sm" variant="ghost" onClick={onShowOthers}>
            {t('queue.goOthers')}
          </Button>
        </div>
      ) : null}
      {history.length > 0 ? (
        <details className="suggest-history">
          <summary>{t('queue.history')}</summary>
          <ul className="suggest-list">
            {history.map((suggestion) => (
              <li key={suggestion.id}>
                <SuggestionCard suggestion={suggestion} heading={t('queue.from', { name: suggestion.author.displayName })} now={now} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
