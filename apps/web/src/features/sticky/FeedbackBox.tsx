// "Give feedback" under a sticky note (DESIGN 0.8.0 D7.8): a box for everyone, a Viewer too (`feedback.give`), with
// the one line that says what becomes of it: everyone in the workspace sees it, and it reaches Claude only when a
// member with agent access accepts it. What is typed and not sent yet stays with the note for the life of the page
// (the sticky store's map, never the browser's storage), so it is still there when the person comes back. One press
// gives one feedback: a second press while the first is on its way does nothing. Ctrl+Enter (Cmd+Enter) gives it too.
import { FEEDBACK_TEXT_MAX_CHARS } from '@smurg/protocol';
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Button } from '../../ui/index.ts';
import { t } from './strings.ts';
import './sticky.css';

export interface FeedbackBoxProps {
  /** The sticky note the feedback is on (its name on disk). */
  readonly note: string;
}

export function FeedbackBox({ note }: FeedbackBoxProps) {
  const stores = useStores();
  const [text, setText] = useState(() => stores.sticky.feedbackDraft(note));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);
  const boxId = useId();
  const hintId = useId();

  const change = (value: string): void => {
    setText(value);
    stores.sticky.setFeedbackDraft(note, value);
  };

  const give = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    // Trailing blank lines and spaces are nobody's meaning; the rest is sent as typed.
    const value = text.trimEnd();
    if (running.current || value.trim() === '') return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await stores.sticky.giveFeedback(note, value);
      change('');
    } catch (error) {
      setProblem(t('feedback.failed', { reason: describeError(error) }));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void give();
    }
  };

  return (
    <form className="sticky-feedback__box" onSubmit={(event) => void give(event)}>
      <label htmlFor={boxId} className="ui-visually-hidden">
        {t('feedback.box', { note })}
      </label>
      <textarea
        id={boxId}
        className="ui-input ui-textarea sticky-feedback__input"
        rows={2}
        maxLength={FEEDBACK_TEXT_MAX_CHARS}
        value={text}
        aria-describedby={hintId}
        aria-invalid={problem !== null ? true : undefined}
        onChange={(event) => change(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="sticky-feedback__send">
        <p id={hintId} className="sticky-feedback__hint">
          {t('feedback.hint')}
        </p>
        <Button type="submit" size="sm" loading={busy} disabled={text.trim() === ''}>
          {t('feedback.give')}
        </Button>
      </div>
      {problem !== null ? (
        <p className="sticky-feedback__problem" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
