// What I proposed (SPEC R6): while a suggestion is pending I can still edit or withdraw it; afterwards I see the
// outcome — accepted, accepted after editing (with the text that was actually sent), rejected (with the reason), or
// withdrawn.
import { useState } from 'react';
import type { SessionInfo, Suggestion } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectAuthoredBy } from '../../lib/stores/suggestions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, TextArea, useToast } from '../../ui/index.ts';
import { IconClose, IconEdit } from '../../ui/icons.tsx';
import { SuggestionCard } from './SuggestionCard.tsx';
import { t } from './strings.ts';
import { cleanSuggestionText, suggestionTextProblem, textProblemMessage } from './text.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';

const PAGE = 10;

function AuthoredItem({ suggestion, target, now }: { suggestion: Suggestion; target: string; now: number }) {
  const stores = useStores();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = suggestion.status === 'pending';

  const save = async (): Promise<void> => {
    if (editing === null) return;
    const clean = cleanSuggestionText(editing);
    const problem = suggestionTextProblem(clean);
    if (problem !== null) {
      setError(textProblemMessage(problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stores.suggestions.edit(suggestion.id, clean);
      setEditing(null);
    } catch (failure) {
      setError(t('mine.failed', { message: describeError(failure) }));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await stores.suggestions.withdraw(suggestion.id);
      toast.show({ tone: 'info', title: t('mine.withdrawn') });
    } catch (failure) {
      setError(t('mine.failed', { message: describeError(failure) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <SuggestionCard suggestion={suggestion} heading={t('mine.to', { target })} now={now}>
        {pending && editing !== null ? (
          <div className="suggest-card__form">
            <TextArea label={t('mine.editLabel')} rows={4} value={editing} onChange={(event) => setEditing(event.currentTarget.value)} />
            <div className="suggest-card__actions">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                {tApp('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
                {t('mine.save')}
              </Button>
            </div>
          </div>
        ) : pending ? (
          <div className="suggest-card__actions">
            <Button size="sm" variant="ghost" icon={<IconEdit />} disabled={busy} onClick={() => setEditing(suggestion.text)}>
              {t('mine.edit')}
            </Button>
            <Button size="sm" variant="ghost" icon={<IconClose />} loading={busy} onClick={() => void withdraw()}>
              {t('mine.withdraw')}
            </Button>
          </div>
        ) : null}
        {error !== null ? (
          <Banner tone="danger" live="alert">
            {error}
          </Banner>
        ) : null}
      </SuggestionCard>
    </li>
  );
}

export interface AuthoredListProps {
  readonly userId: string;
  readonly sessions: ReadonlyMap<string, SessionInfo>;
  readonly now: number;
}

export function AuthoredList({ userId, sessions, now }: AuthoredListProps) {
  const stores = useStores();
  const mine = useStore(stores.suggestions, (state) => selectAuthoredBy(state, userId), shallowEqual);
  const [shown, setShown] = useState(PAGE);
  if (mine.length === 0) return null;
  // Pending first (they can still change), then newest.
  const ordered = [...mine].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt - a.createdAt);
  const visible = ordered.slice(0, shown);
  return (
    <section className="suggest-section" aria-label={t('mine.title')}>
      <h3 className="suggest-section__title">{t('mine.title')}</h3>
      <ul className="suggest-list">
        {visible.map((suggestion) => {
          const session = sessions.get(suggestion.sessionId);
          const target = session ? t('session.label', { owner: session.ownerName, title: plainSessionTitle(session) }) : t('mine.unknownSession');
          return <AuthoredItem key={suggestion.id} suggestion={suggestion} target={target} now={now} />;
        })}
      </ul>
      {ordered.length > shown ? (
        <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
          {t('mine.more', { count: ordered.length - shown })}
        </Button>
      ) : null}
    </section>
  );
}
