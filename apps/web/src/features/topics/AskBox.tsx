// The box a column's text for an agent is written in: "Ask the agent to revise" at the foot of the spec and plan
// columns, and "Ask about this result, or tell Claude what to change" at the foot of a result report. One line says
// where the text goes (a message for a member with agent access, a suggestion for anyone else); a refusal is one line
// under the box and the text stays (UX §13: nothing is retried silently, nothing typed is lost).
//
// Enter sends, Shift+Enter is a new line, never while an input method is composing; Escape closes a box that can be
// closed and returns the focus to whatever opened it.
import { MESSAGE_TEXT_MAX_CHARS } from '@smurg/protocol';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useConnectionState } from '../../lib/workspace/context.tsx';
import { Button, IconButton } from '../../ui/index.ts';
import { IconClose, IconSend } from '../../ui/icons.tsx';
import { t } from './strings.ts';

/** Unsent text per box, kept while the page lives (closing a box or a column loses nothing). */
const drafts = new Map<string, string>();

/** For tests: forget every unsent text. */
export function clearAskDrafts(): void {
  drafts.clear();
}

export interface AskBoxProps {
  /** Names the unsent text: `revise:<topic id>:spec`, `follow-up:<topic id>:<item id>`. */
  readonly draftKey: string;
  /** The text box's accessible name. */
  readonly label: string;
  readonly placeholder: string;
  /** Where the text goes, in one line. */
  readonly hint?: ReactNode;
  readonly sendLabel: string;
  /** What the text is about (a quoted section), with the control that removes it. */
  readonly quote?: { readonly label: string; onRemove(): void } | null;
  /** Put into the box when it opens empty ("Ask the agent to fix it"). */
  readonly initialText?: string;
  readonly autoFocus?: boolean;
  /** Sends the text. A rejection is shown under the box and the text stays. */
  onSend(text: string): Promise<void>;
  /** The box can be closed (Escape, the close button). */
  onClose?(): void;
  /** Under the box, after the error: e.g. "Restart discussion" when the discussion is closed. */
  readonly errorAction?: (error: unknown) => ReactNode;
}

export function AskBox({ draftKey, label, placeholder, hint, sendLabel, quote, initialText, autoFocus = false, onSend, onClose, errorAction }: AskBoxProps) {
  const id = useId();
  const online = useConnectionState().kind === 'online';
  const [text, setText] = useState(() => drafts.get(draftKey) ?? initialText ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const change = (next: string): void => {
    setText(next);
    if (next === '') drafts.delete(draftKey);
    else drafts.set(draftKey, next);
  };

  const tooLong = text.length > MESSAGE_TEXT_MAX_CHARS;
  const sendable = online && !busy && text.trim() !== '' && !tooLong && !text.includes('\u0000');

  const send = async (): Promise<void> => {
    if (!sendable) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSend(text);
      if (!alive.current) {
        drafts.delete(draftKey);
        return;
      }
      change('');
    } catch (error) {
      if (alive.current) setFailure(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // Enter sends; never while an input method is composing (the Enter that picks a candidate is not a send).
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send();
  };

  const problem = tooLong ? t('ask.tooLong', { max: MESSAGE_TEXT_MAX_CHARS }) : failure !== null ? t('ask.failed', { reason: describeError(failure) }) : null;

  return (
    <div className="topics-ask" data-ask={draftKey}>
      {quote ? (
        <div className="topics-ask__quote">
          <span>{quote.label}</span>
          <IconButton size="sm" label={t('ask.removeQuote')} icon={<IconClose />} onClick={quote.onRemove} />
        </div>
      ) : null}
      <div className="topics-ask__box">
        <label htmlFor={id} className="ui-visually-hidden">
          {label}
        </label>
        <textarea
          ref={box}
          id={id}
          className="topics-ask__input"
          rows={2}
          value={text}
          placeholder={placeholder}
          disabled={!online}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem !== null ? `${id}-problem` : hint ? `${id}-hint` : undefined}
          onChange={(event) => change(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div className="topics-ask__actions">
          {onClose ? (
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('ask.close')}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" icon={<IconSend />} loading={busy} disabled={!sendable} onClick={() => void send()}>
            {sendLabel}
          </Button>
        </div>
      </div>
      {problem !== null ? (
        <p id={`${id}-problem`} className="topics-ask__problem" role="alert">
          {problem} {failure !== null ? errorAction?.(failure) : null}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="topics-ask__hint">
          {online ? hint : t('ask.offline')}
        </p>
      ) : null}
    </div>
  );
}
