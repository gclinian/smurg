// The suggestion composer under someone else's terminal (SPEC R6 「可編輯以上的角色可以對別人的 session 提建議」):
// text for the agent, optionally with the code selection it was made from. It only ever creates a suggestion; the
// session owner decides. There is no way to send text into another person's session from here.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { SessionInfo, Suggestion } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useCommand, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, IconButton, TextArea, useToast } from '../../ui/index.ts';
import { IconClose, IconFileText, IconSend } from '../../ui/icons.tsx';
import { t } from './strings.ts';
import { cleanSuggestionText, lineRange, suggestionTextProblem, textProblemMessage } from './text.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';

export type SuggestionSource = NonNullable<Suggestion['source']>;

export interface ComposerDraft {
  readonly text: string;
  readonly source: SuggestionSource | null;
}

export const EMPTY_DRAFT: ComposerDraft = Object.freeze({ text: '', source: null });

export interface ComposerProps {
  readonly session: SessionInfo;
  readonly draft: ComposerDraft;
  onChange(draft: ComposerDraft): void;
  /** Non-zero: take focus (a selection was just put into the draft), then call onFocused. */
  readonly focusToken: number;
  onFocused(): void;
}

export function Composer({ session, draft, onChange, focusToken, onFocused }: ComposerProps) {
  const stores = useStores();
  const toast = useToast();
  const openFile = useCommand('openFile');
  const hintId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  /** Why the text cannot be sent (shown at the text area). */
  const [textError, setTextError] = useState<string | null>(null);
  /** The daemon refused it. */
  const [sendError, setSendError] = useState<string | null>(null);
  const exited = session.status === 'exited';

  useEffect(() => {
    if (focusToken === 0) return;
    const node = area.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    onFocused();
    // onFocused is the panel's setter; only a new token asks for focus
  }, [focusToken]);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (busy || exited) return;
    const text = cleanSuggestionText(draft.text);
    const problem = suggestionTextProblem(text);
    if (problem !== null) {
      setTextError(textProblemMessage(problem));
      return;
    }
    setBusy(true);
    setTextError(null);
    setSendError(null);
    try {
      await stores.suggestions.create({ sessionId: session.id, text, ...(draft.source ? { source: draft.source } : {}) });
      onChange({ text: '', source: null });
      toast.show({ tone: 'success', title: t('composer.sent', { owner: session.ownerName }) });
    } catch (failure) {
      setSendError(t('composer.failed', { message: describeError(failure) }));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  if (exited) {
    return (
      <p className="suggest-note" role="status">
        {t('composer.exited')}
      </p>
    );
  }

  const source = draft.source;
  return (
    <form className="suggest-composer" onSubmit={(event) => void submit(event)} aria-describedby={hintId}>
      <TextArea
        ref={area}
        label={t('composer.label', { owner: session.ownerName, title: plainSessionTitle(session) })}
        placeholder={t('composer.placeholder')}
        rows={4}
        value={draft.text}
        onChange={(event) => {
          setTextError(null);
          onChange({ ...draft, text: event.currentTarget.value });
        }}
        onKeyDown={onKeyDown}
        error={textError ?? undefined}
      />
      {source ? (
        <div className="suggest-source">
          <button
            type="button"
            className="suggest-source__link"
            onClick={() => {
              openFile({ file: source.file, line: source.startLine }).catch(() => {
                // the editor may not be available; the chip is informational
              });
            }}
            aria-label={t('source.open', { path: source.file.path, line: source.startLine })}
          >
            <IconFileText />
            <span>{t('source.label', { path: source.file.path, range: lineRange(source.startLine, source.endLine) })}</span>
          </button>
          <IconButton size="sm" label={t('source.remove')} icon={<IconClose />} onClick={() => onChange({ ...draft, source: null })} />
        </div>
      ) : null}
      <p id={hintId} className="suggest-note">
        {t('composer.hint', { owner: session.ownerName })}
      </p>
      <div className="suggest-composer__actions">
        <span className="suggest-note">{t('composer.shortcut')}</span>
        <Button type="submit" variant="primary" size="sm" icon={<IconSend />} loading={busy} disabled={draft.text.trim() === ''}>
          {t('composer.send')}
        </Button>
      </div>
      {sendError !== null ? (
        <Banner tone="danger" live="alert">
          {sendError}
        </Banner>
      ) : null}
    </form>
  );
}
