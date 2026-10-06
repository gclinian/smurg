// A suggestion in the conversation, where it was made (UX §5.3): an Editor's text for the agent, which reaches the
// agent only when a member with agent access accepts it (as it is, or edited). Its author may edit or withdraw it
// while it waits. An accepted suggestion is the author's message further down; the card stays as one line.
import { memo, useRef, useState } from 'react';
import { SUGGESTION_TEXT_MAX_CHARS, REASON_MAX_CHARS, type Suggestion } from '@smurg/protocol';
import { formatTime } from '../../lib/format.ts';
import { kindLabel } from '../../lib/session-status.ts';
import { useStore } from '../../lib/store.ts';
import { useCapabilities, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Button, Card, KindIcon } from '../../ui/index.ts';
import { Markdown } from '../markdown/index.ts';
import { lateAnswerText, settledOf } from './cards.ts';
import { useAction, useConversationEnv, useMarkSeen, useSessionFacts } from './env.tsx';
import { t } from './strings.ts';
import { cardDomId, lineRange } from './text.ts';

function settledText(suggestion: Suggestion): string {
  const time = suggestion.resolvedAt === undefined ? '' : formatTime(suggestion.resolvedAt);
  const by = suggestion.decidedBy?.displayName ?? t('card.late.someone');
  if (suggestion.closedReason !== undefined) return t(`sug.settled.closed.${suggestion.closedReason}`, { name: suggestion.author.displayName });
  switch (suggestion.status) {
    case 'accepted':
      return t('sug.settled.accepted', { name: by, time });
    case 'accepted-modified':
      return t('sug.settled.acceptedEdited', { name: by, time });
    case 'rejected':
      return suggestion.rejectReason ? t('sug.settled.rejectedWith', { name: by, time, reason: suggestion.rejectReason }) : t('sug.settled.rejected', { name: by, time });
    default:
      return t('sug.settled.withdrawn', { name: suggestion.author.displayName });
  }
}

function Source({ suggestion }: { suggestion: Suggestion }) {
  const commands = useCommands();
  const source = suggestion.source;
  if (source === undefined) return null;
  const label =
    source.startLine === source.endLine
      ? t('sug.sourceLine', { path: source.file.path, line: source.startLine })
      : t('sug.source', { path: source.file.path, range: lineRange(source.startLine, source.endLine) });
  return (
    <p className="conv-card__who">
      <button
        type="button"
        className="conv-link"
        onClick={() => {
          void commands.dispatch('openInCodeMode', { root: source.file.root, file: source.file.path, line: source.startLine, sessionId: suggestion.sessionId }).catch(() => {});
        }}
      >
        {label}
      </button>
    </p>
  );
}

export const SuggestionCard = memo(function SuggestionCard({ suggestionId }: { suggestionId: string }) {
  const stores = useStores();
  const caps = useCapabilities();
  const { sessionId, self, mentionNames } = useConversationEnv();
  const suggestion = useStore(stores.conversations, (state) => state.conversations.get(sessionId)?.suggestions.get(suggestionId));
  const facts = useSessionFacts(sessionId);
  const ref = useRef<HTMLElement>(null);
  const pending = suggestion?.status === 'pending';
  useMarkSeen(ref, { sessionId, cardId: suggestionId, ...(suggestion === undefined ? {} : { authorId: suggestion.author.userId }) }, pending);

  const [late, setLate] = useState<string | null>(null);
  const action = useAction((error) => {
    const settled = settledOf(error);
    if (settled === null) return false;
    setLate(lateAnswerText(settled));
    return true;
  });
  /** What the text box under the card is for, when one is open. */
  const [mode, setMode] = useState<'accept' | 'reject' | 'edit' | null>(null);
  const [draft, setDraft] = useState('');

  const icon = <KindIcon kind="suggestion" label={kindLabel('suggestion')} />;
  if (suggestion === undefined) {
    return (
      <Card ref={ref} id={cardDomId(suggestionId)} title={kindLabel('suggestion')} icon={icon} className="conv-card">
        <p className="conv-card__who">{t('card.missing')}</p>
      </Card>
    );
  }
  const title = t('sug.title', { name: suggestion.author.displayName });

  if (!pending) {
    const accepted = suggestion.status === 'accepted' || suggestion.status === 'accepted-modified';
    return (
      <Card ref={ref} id={cardDomId(suggestionId)} title={title} icon={icon} settled className="conv-card conv-card--suggestion">
        <p className="conv-card__who">
          <strong>{settledText(suggestion)}</strong>
        </p>
        {/* An accepted suggestion is its author's message below; anything else keeps what was proposed. */}
        {accepted ? null : (
          <details className="conv-q__more">
            <summary>{kindLabel('suggestion')}</summary>
            <div className="conv-sug__text">
              <Markdown text={suggestion.text} breaks mentions={mentionNames} headingBase={4} />
            </div>
          </details>
        )}
      </Card>
    );
  }

  const isAuthor = suggestion.author.userId === self?.userId;
  const canDecide = caps.canDrive;
  const start = (next: 'accept' | 'reject' | 'edit'): void => {
    setLate(null);
    setDraft(next === 'reject' ? '' : suggestion.text);
    setMode(next);
  };
  const run = (request: () => Promise<Suggestion>): void => {
    // The card settles with the reply (the daemon's `suggest.updated` says the same a moment later).
    void action.run(async () => stores.conversations.applySuggestion(await request())).then((ok) => {
      if (ok) setMode(null);
    });
  };
  const confirm = (): void => {
    const text = draft.trim();
    if (mode === 'accept' && text !== '') run(() => stores.suggestions.accept(suggestionId, text === suggestion.text ? undefined : text));
    else if (mode === 'reject') run(() => stores.suggestions.reject(suggestionId, text === '' ? undefined : text));
    else if (mode === 'edit' && text !== '') run(() => stores.suggestions.edit(suggestionId, text));
  };

  const waiting = facts?.responsibleName != null ? t('sug.waiting.responsible', { name: facts.responsibleName }) : t('sug.waiting.all');
  const footer = (
    <>
      {mode !== null ? (
        <div className="conv-sug__edit">
          <textarea
            className="ui-input ui-textarea"
            rows={mode === 'reject' ? 1 : 3}
            // The box appears because its button was pressed: the person continues there.
            autoFocus
            aria-label={mode === 'reject' ? t('sug.reject.label', { name: suggestion.author.displayName }) : t('sug.edit.label')}
            placeholder={mode === 'reject' ? t('sug.reject.label', { name: suggestion.author.displayName }) : undefined}
            maxLength={mode === 'reject' ? REASON_MAX_CHARS : SUGGESTION_TEXT_MAX_CHARS}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className="conv-card__actions">
            <Button variant="primary" size="sm" loading={action.busy} disabled={mode !== 'reject' && draft.trim() === ''} onClick={confirm}>
              {mode === 'accept' ? t('sug.acceptEdited') : mode === 'reject' ? t('sug.reject.confirm') : t('sug.edit.save')}
            </Button>
            <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => setMode(null)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="conv-card__actions">
          {canDecide ? (
            <>
              <Button variant="primary" size="sm" disabled={action.busy} onClick={() => run(() => stores.suggestions.accept(suggestionId))}>
                {t('sug.accept')}
              </Button>
              <Button size="sm" disabled={action.busy} onClick={() => start('accept')}>
                {t('sug.editAccept')}
              </Button>
              <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => start('reject')}>
                {t('sug.reject')}
              </Button>
            </>
          ) : null}
          {isAuthor ? (
            <>
              <Button size="sm" disabled={action.busy} onClick={() => start('edit')}>
                {t('sug.edit')}
              </Button>
              <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => run(() => stores.suggestions.withdraw(suggestionId))}>
                {t('sug.withdraw')}
              </Button>
            </>
          ) : null}
        </div>
      )}
      <p className="conv-card__who">{canDecide ? t('sug.reaches') : waiting}</p>
      {late !== null ? (
        <p className="conv-card__who" role="status">
          {late}
        </p>
      ) : null}
      {action.error !== null ? (
        <p className="conv-card__problem" role="alert">
          {t('actionFailed', { message: action.error })}
        </p>
      ) : null}
    </>
  );

  return (
    <Card ref={ref} id={cardDomId(suggestionId)} title={title} icon={icon} tone="info" meta={formatTime(suggestion.createdAt)} className="conv-card conv-card--suggestion" footer={footer}>
      <div className="conv-sug__text">
        <Markdown text={suggestion.text} breaks mentions={mentionNames} headingBase={4} />
      </div>
      {suggestion.cleaned === true ? <p className="conv-card__who">{t('sug.cleaned')}</p> : null}
      <Source suggestion={suggestion} />
    </Card>
  );
});
