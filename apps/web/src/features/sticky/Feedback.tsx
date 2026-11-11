// The feedback on a sticky note (DESIGN 0.8.0 D4, D7.8), under the note, for everyone: the box "Give feedback" (on a
// note the index lists), then what waits, oldest first, then what was decided, folded behind "Show N earlier". Each
// entry: its author (a member's name; a person outside the workspace by their name and "Slack" or "Discord", never an
// avatar), the time, and the text AS PLAIN TEXT (PlainText: every character, nothing interpreted, never Markdown or a
// link). The author withdraws their own while it waits.
//
// A member with agent access (`session.drive`) decides: Accept sends it once to Claude for the sticky notes, as their
// own message; Reject (with a reason everyone sees, or none) sends nothing. Before the click, "What Claude gets" shows,
// as plain text, the exact message the daemon's accept sends: the same pure function (composeFeedback of
// @smurg/protocol) with the same inputs, the entry's note, its text and its author (a member by the name the entry
// holds and their role now, as the members' presence has it). When the role is not known (the presence has not come,
// or the author is no member now), nothing is shown rather than a guess. An accept refused because Claude for the
// sticky notes is not running offers "Start Claude"; the member then accepts again (nothing is sent by itself).
//
// On a name the index does not hold (D7.6: a note renamed or gone, a link to one not written yet) the list is shown
// without the box, so that what waits there can still be decided.
import { REASON_MAX_CHARS, composeFeedback, errorReasonOf, isSmurgError, type Feedback, type FeedbackAuthorForAgent } from '@smurg/protocol';
import { memo, useId, useMemo, useRef, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectFeedbackOf } from '../../lib/stores/sticky.ts';
import { useCan, useCapabilities, useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Button, Input, Spinner } from '../../ui/index.ts';
import { PlainText } from '../markdown/index.ts';
import { FeedbackBox } from './FeedbackBox.tsx';
import { t } from './strings.ts';
import './sticky.css';

export interface NoteFeedbackProps {
  /** The sticky note (its name on disk), or a name the index does not hold. */
  readonly note: string;
  /** The box "Give feedback": only on a note the index lists (the daemon refuses feedback on any other name). */
  readonly box: boolean;
}

export function NoteFeedback({ note, box }: NoteFeedbackProps) {
  const stores = useStores();
  const status = useStore(stores.sticky, (state) => state.feedbackStatus);
  const error = useStore(stores.sticky, (state) => state.feedbackError);
  const feedback = useStore(stores.sticky, (state) => selectFeedbackOf(state, note));
  const canGive = useCan('feedback.give');
  const headingId = useId();
  const withBox = box && canGive;
  const earlier = feedback.settled.length;

  // Without the box there is nothing to show until there is feedback on this name.
  if (!withBox && feedback.waiting.length === 0 && earlier === 0) return null;
  return (
    <section className="sticky-feedback" aria-labelledby={headingId}>
      <h3 id={headingId} className="sticky-feedback__title">
        {t('feedback.title')}
      </h3>
      {withBox ? <FeedbackBox note={note} /> : null}
      {status === 'error' ? (
        <div className="sticky-feedback__line">
          <p className="sticky-feedback__problem" role="alert">
            {t('feedback.loadFailed', { reason: error ?? '' })}
          </p>
          <Button size="sm" variant="ghost" onClick={() => void stores.sticky.reloadFeedback().catch(() => {})}>
            {t('load.retry')}
          </Button>
        </div>
      ) : status !== 'ready' ? (
        <p className="sticky-feedback__line">
          <Spinner size={14} decorative />
          <span>{t('feedback.loading')}</span>
        </p>
      ) : null}
      {feedback.waiting.length > 0 ? (
        <ul className="sticky-feedback__list">
          {feedback.waiting.map((entry) => (
            <FeedbackEntry key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : null}
      {earlier > 0 ? (
        <details className="sticky-feedback__earlier">
          <summary>{t('feedback.earlier', { count: earlier })}</summary>
          <ul className="sticky-feedback__list">
            {feedback.settled.map((entry) => (
              <FeedbackEntry key={entry.id} entry={entry} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** Who wrote it: a member's name as the entry holds it; an outside author's name and where they wrote. */
function Author({ entry }: { entry: Feedback }) {
  if (entry.author.kind === 'member') return <span className="sticky-fb__who">{entry.author.user.displayName}</span>;
  return (
    <>
      <span className="sticky-fb__who">{entry.author.name}</span>
      <span className="sticky-fb__source">{t(entry.author.source === 'slack' ? 'feedback.source.slack' : 'feedback.source.discord')}</span>
    </>
  );
}

/** What became of a decided entry, by whom and when (and the reason of a rejection). */
function decision(entry: Feedback): string | null {
  const name = entry.decidedBy?.displayName ?? '';
  const time = entry.decidedAt === undefined ? '' : formatDateTime(entry.decidedAt);
  if (entry.status === 'accepted') return t('feedback.accepted', { name, time });
  if (entry.status === 'rejected') return entry.rejectReason === undefined ? t('feedback.rejected', { name, time }) : t('feedback.rejectedWith', { name, time, reason: entry.rejectReason });
  return null;
}

/**
 * The author as the daemon's accept names them (sticky/feedback.ts authorForAgent): an outsider as stored; a member by
 * the name the entry holds and their role now; null when that role is not known here.
 */
function useAuthorForAgent(entry: Feedback): FeedbackAuthorForAgent | null {
  const stores = useStores();
  const author = entry.author;
  const memberId = author.kind === 'member' ? author.user.userId : null;
  const role = useStore(stores.presence, (state) => (memberId === null ? null : (state.members.find((member) => member.userId === memberId)?.role ?? null)));
  return useMemo<FeedbackAuthorForAgent | null>(() => {
    if (author.kind === 'outside') return { kind: 'outside', source: author.source, name: author.name, externalId: author.externalId };
    return role === null ? null : { kind: 'member', userId: author.user.userId, displayName: author.user.displayName, role };
  }, [author, role]);
}

const FeedbackEntry = memo(function FeedbackEntry({ entry }: { entry: Feedback }) {
  const stores = useStores();
  const caps = useCapabilities();
  const canStart = useCan('session.create');
  const self = useMember();
  const waiting = entry.status === 'waiting';
  const canDecide = waiting && caps.canDrive;
  const isAuthor = waiting && entry.author.kind === 'member' && self !== null && entry.author.user.userId === self.userId;
  const forAgent = useAuthorForAgent(entry);
  // The exact message an accept sends (D4.6), only for whoever can accept it.
  const sent = useMemo(() => (canDecide && forAgent !== null ? composeFeedback({ note: entry.note, author: forAgent, text: entry.text }) : null), [canDecide, forAgent, entry]);

  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [noAssistant, setNoAssistant] = useState(false);
  const [starting, setStarting] = useState(false);

  /** One request at a time for this entry: a second press while one is on its way does nothing. */
  const run = (action: () => Promise<unknown>, done?: () => void): void => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    setNoAssistant(false);
    action()
      .then(
        () => done?.(),
        (error: unknown) => {
          setProblem(describeError(error));
          setNoAssistant(isSmurgError(error) && error.code === 'conflict' && errorReasonOf(error) === 'no-assistant');
        },
      )
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };

  const start = (): void => {
    setStarting(true);
    stores.sessions
      .startNotesAssistant()
      .then(
        () => {
          // Claude for the sticky notes runs: the member accepts again (nothing is sent by itself).
          setProblem(null);
          setNoAssistant(false);
        },
        (error: unknown) => setProblem(t('feedback.startFailed', { reason: describeError(error) })),
      )
      .finally(() => setStarting(false));
  };

  const settled = decision(entry);
  return (
    <li className="sticky-fb" data-status={entry.status}>
      <p className="sticky-fb__head">
        <Author entry={entry} />
        <time className="sticky-fb__time" dateTime={new Date(entry.createdAt).toISOString()}>
          {formatDateTime(entry.createdAt)}
        </time>
      </p>
      <PlainText className="sticky-fb__text" text={entry.text} />
      {entry.cut === true ? <p className="sticky-fb__note">{t('feedback.cut')}</p> : null}
      {entry.cleaned === true ? <p className="sticky-fb__note">{t('feedback.cleaned')}</p> : null}
      {settled !== null ? <p className="sticky-fb__decision">{settled}</p> : null}
      {rejecting && canDecide ? (
        <div className="sticky-fb__reject">
          {/* A reason is one line (the wire's reason text). The box appears because Reject was pressed: the person continues there. */}
          <Input label={t('feedback.reject.label')} maxLength={REASON_MAX_CHARS} autoFocus autoComplete="off" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
          <div className="sticky-fb__actions">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() => {
                const why = reason.trim();
                run(
                  () => stores.sticky.rejectFeedback(entry.id, why === '' ? undefined : why),
                  () => setRejecting(false),
                );
              }}
            >
              {t('feedback.reject.confirm')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
              {tApp('common.cancel')}
            </Button>
          </div>
        </div>
      ) : canDecide || isAuthor ? (
        <div className="sticky-fb__actions">
          {canDecide ? (
            <>
              <Button size="sm" loading={busy} onClick={() => run(() => stores.sticky.acceptFeedback(entry.id))}>
                {t('feedback.accept')}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setProblem(null);
                  setNoAssistant(false);
                  setReason('');
                  setRejecting(true);
                }}
              >
                {t('feedback.reject')}
              </Button>
            </>
          ) : null}
          {isAuthor ? (
            <Button size="sm" disabled={busy} onClick={() => run(() => stores.sticky.withdrawFeedback(entry.id))}>
              {t('feedback.withdraw')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {sent !== null && !rejecting ? (
        <details className="sticky-fb__sent">
          <summary>{t('feedback.preview')}</summary>
          <p className="sticky-fb__note">{t('feedback.preview.hint')}</p>
          <PlainText className="sticky-fb__message" text={sent} />
        </details>
      ) : null}
      {problem !== null ? (
        <p className="sticky-fb__problem" role="alert">
          {problem}
        </p>
      ) : null}
      {noAssistant && canStart ? (
        <div className="sticky-fb__actions">
          <Button size="sm" loading={starting} onClick={start}>
            {t('feedback.start')}
          </Button>
        </div>
      ) : null}
    </li>
  );
});
