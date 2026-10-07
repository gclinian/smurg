// A multiple-choice question of the agent (UX §5.1, DESIGN §5.12 item 13). Everyone but viewers votes and comments
// and sees the others' choices live; the decider submits. What a role cannot do is absent, with the sentence that
// says who can; the daemon enforces all of it again.
//
// The counts, "n of m voted" and the prefilled answer come from @smurg/protocol's votes.ts (never a tally of our own).
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ANSWER_NOTE_MAX_CHARS,
  COMMENT_MAX_CHARS,
  OTHER_ANSWER_MAX_CHARS,
  allVoted,
  can,
  leadingAnswer,
  mayAnswerInOwnWords,
  maySubmit,
  questionTally,
  votersOf,
  type Question,
} from '@smurg/protocol';
import { formatAge, formatAnd, formatTime, gapAfter } from '../../lib/format.ts';
import { kindLabel } from '../../lib/session-status.ts';
import { useStore } from '../../lib/store.ts';
import type { QuestionAnswerInput } from '../../lib/stores/conversations.ts';
import { useNow } from '../../lib/use-now.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Avatar, AvatarStack, Badge, Button, Card, KindIcon, Select, cx, type SelectOption } from '../../ui/index.ts';
import { IconComment, IconInfo } from '../../ui/icons.tsx';
import { PlainText } from '../markdown/index.ts';
import { lateAnswerText, settledOf } from './cards.ts';
import { useAction, useConversationEnv, useMarkSeen, useSessionFacts, type SessionFacts } from './env.tsx';
import { MentionField } from './MentionField.tsx';
import { mentionsIn, personOf, withAgentAccess, type Person } from './people.ts';
import { t } from './strings.ts';
import { cardDomId } from './text.ts';

type Part = Question['parts'][number];
type Vote = Question['votes'][number];

/** What the decider chose in "Submit a different answer": an option, someone's "Other" text, or their own words. */
type Chosen = { readonly kind: 'option'; readonly option: number } | { readonly kind: 'other'; readonly by: string | null; readonly text: string };

function votersAsPeople(votes: readonly Vote[], people: readonly Person[]) {
  return votes.map((vote) => ({ id: vote.userId, name: vote.displayName, color: personOf(people, vote.userId)?.color }));
}

/** "On the server", "Dark mode, Offline mode", or the Other text: one part of a submitted answer in words. */
function answerPartText(part: Part, answer: NonNullable<Question['answer']>['parts'][number] | undefined): string {
  if (answer === undefined) return '';
  if (answer.other !== undefined) return answer.otherBy === undefined ? answer.other : t('q.settled.otherBy', { text: answer.other, name: answer.otherBy.displayName });
  return (answer.options ?? []).map((index) => part.options[index]?.label ?? '').join(', ');
}

interface PartViewProps {
  readonly question: Question;
  readonly index: number;
  readonly tally: readonly number[];
  readonly leading: readonly number[];
  readonly people: readonly Person[];
  readonly selfId: string | null;
  /** May vote (holds `discuss`) and the card is open; otherwise the part is read. */
  readonly voting: boolean;
  readonly busy: boolean;
  /** "Add to the note" on an Other text (the decider with agent access). */
  readonly onAddToNote: ((text: string) => void) | null;
  onVote(part: number, vote: { options: number[] } | { other: string }): void;
}

function PartView({ question, index, tally, leading, people, selfId, voting, busy, onAddToNote, onVote }: PartViewProps) {
  const part = question.parts[index] as Part;
  const group = useId();
  const votes = question.votes.filter((vote) => vote.part === index);
  const mine = votes.find((vote) => vote.userId === selfId);
  const voters = new Set(votes.map((vote) => vote.userId)).size;
  const others = votes.filter((vote) => vote.other !== undefined);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState(mine?.other ?? '');
  const [otherProblem, setOtherProblem] = useState(false);
  const otherChecked = otherOpen || mine?.other !== undefined;
  const label = question.parts.length > 1 ? t('q.voteFor', { question: part.text }) : t('q.vote');

  const choose = (option: number, checked: boolean): void => {
    setOtherOpen(false);
    if (!part.multi) {
      onVote(index, { options: [option] });
      return;
    }
    const current = new Set(mine?.options ?? []);
    if (checked) current.add(option);
    else current.delete(option);
    // A vote names at least one option: the last one stays.
    if (current.size > 0) onVote(index, { options: [...current].sort((a, b) => a - b) });
  };

  const voteOther = (): void => {
    const text = otherText.trim();
    if (text === '') {
      setOtherProblem(true);
      return;
    }
    setOtherProblem(false);
    onVote(index, { other: text });
  };

  return (
    <div className="conv-q__part">
      {question.parts.length > 1 ? <p className="conv-q__partno">{t('q.part', { number: index + 1, count: question.parts.length })}</p> : null}
      <p className="conv-q__text">{part.text}</p>
      {part.multi && voting ? <p className="conv-card__who">{t('q.multi')}</p> : null}
      <div className="conv-q__opts" role={part.multi ? 'group' : 'radiogroup'} aria-label={label}>
        {part.options.map((option, optionIndex) => {
          const count = tally[optionIndex] ?? 0;
          const chosenBy = votes.filter((vote) => vote.options?.includes(optionIndex));
          const checked = mine?.options?.includes(optionIndex) === true && !otherOpen;
          const names = chosenBy.map((vote) => vote.displayName);
          return (
            <label key={optionIndex} className={cx('conv-q-opt', checked && 'conv-q-opt--mine', !voting && 'conv-q-opt--read')}>
              {voting ? (
                <input
                  type={part.multi ? 'checkbox' : 'radio'}
                  name={group}
                  checked={checked}
                  disabled={busy}
                  onChange={(event) => choose(optionIndex, event.currentTarget.checked)}
                />
              ) : null}
              <span className="conv-q-opt__main">
                <span className="conv-q-opt__label">
                  {option.label}
                  {leading.includes(optionIndex) ? (
                    <Badge tone="info" className="conv-q-opt__lead">
                      {t('q.leading')}
                    </Badge>
                  ) : null}
                </span>
                {option.description !== '' ? <span className="conv-q-opt__desc">{option.description}</span> : null}
              </span>
              <span className="conv-q-opt__votes" title={count === 0 ? t('q.noVotes') : t('q.votesFor', { count, names: formatAnd(names) })}>
                <AvatarStack people={votersAsPeople(chosenBy, people)} label={t('q.votesFor', { count, names: formatAnd(names) })} />
                <span className="conv-q-opt__count">{count}</span>
              </span>
              <span className="conv-q-opt__bar" style={{ width: `${voters === 0 ? 0 : Math.round((count / voters) * 100)}%` }} aria-hidden="true" />
            </label>
          );
        })}
        {voting || others.length > 0 ? (
          <div className={cx('conv-q-opt', 'conv-q-opt--other', otherChecked && 'conv-q-opt--mine', !voting && 'conv-q-opt--read')}>
            {voting ? (
              <input
                type={part.multi ? 'checkbox' : 'radio'}
                name={group}
                aria-label={t('q.other')}
                checked={otherChecked}
                disabled={busy}
                onChange={(event) => setOtherOpen(event.currentTarget.checked)}
              />
            ) : null}
            <span className="conv-q-opt__main">
              <span className="conv-q-opt__label">{t('q.other')}</span>
            </span>
            <span className="conv-q-opt__votes">
              <AvatarStack people={votersAsPeople(others, people)} label={t('q.votesFor', { count: others.length, names: formatAnd(others.map((vote) => vote.displayName)) })} />
              <span className="conv-q-opt__count">{tally[part.options.length] ?? 0}</span>
            </span>
            <span className="conv-q-opt__texts">
              {others.map((vote) => (
                <span key={vote.userId} className="conv-q-quote">
                  <span>{t('q.other.by', { name: vote.displayName, text: vote.other ?? '' })}</span>
                  {onAddToNote !== null ? (
                    <button type="button" className="conv-link" onClick={() => onAddToNote(`${vote.displayName}: ${vote.other ?? ''}`)}>
                      {t('q.addToNote')}
                    </button>
                  ) : null}
                </span>
              ))}
              {voting && otherChecked ? (
                <span className="conv-q__other">
                  <input
                    className="ui-input"
                    type="text"
                    aria-label={t('q.other.label')}
                    placeholder={t('q.other.placeholder')}
                    value={otherText}
                    maxLength={OTHER_ANSWER_MAX_CHARS}
                    aria-invalid={otherProblem || undefined}
                    onChange={(event) => setOtherText(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                        event.preventDefault();
                        voteOther();
                      }
                    }}
                  />
                  <Button size="sm" disabled={busy} onClick={voteOther}>
                    {t('q.other.save')}
                  </Button>
                </span>
              ) : null}
              {otherProblem ? (
                <span className="conv-card__problem" role="alert">
                  {t('q.other.needText')}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Comments({ question, people, names, canComment, onAddToNote, onComment, busy }: {
  question: Question;
  people: readonly Person[];
  names: readonly string[];
  canComment: boolean;
  onAddToNote: ((text: string) => void) | null;
  onComment(text: string): Promise<boolean>;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const count = question.comments.length;
  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;
    void onComment(trimmed).then((ok) => {
      if (ok) setText('');
    });
  };
  if (count === 0 && !canComment) return null;
  return (
    <details className="conv-thread" open={count <= 4 ? true : undefined}>
      <summary>
        <IconComment size={14} />
        {count === 0 ? t('q.comments.none') : t('q.comments', { count })}
      </summary>
      <div className="conv-thread__list">
        {question.comments.map((comment) => (
          <div key={comment.id} className="conv-thread__item">
            <Avatar name={comment.from.displayName} color={personOf(people, comment.from.userId)?.color} size="sm" decorative />
            <div>
              <b>{comment.from.displayName}</b> <time dateTime={new Date(comment.at).toISOString()}>{formatTime(comment.at)}</time>
              {onAddToNote !== null ? (
                <button type="button" className="conv-link conv-thread__tonote" onClick={() => onAddToNote(`${comment.from.displayName}: ${comment.text}`)}>
                  {t('q.addToNote')}
                </button>
              ) : null}
              <PlainText className="conv-thread__text" text={comment.text} mentions={names} />
            </div>
          </div>
        ))}
        {canComment ? (
          <div className="conv-thread__box">
            <MentionField value={text} onChange={setText} onSubmit={send} label={t('q.comment.label')} placeholder={t('q.comment.placeholder')} maxLength={COMMENT_MAX_CHARS} disabled={busy} className="ui-input" />
            <Button size="sm" disabled={busy || text.trim() === ''} onClick={send}>
              {t('q.comment.send')}
            </Button>
          </div>
        ) : null}
        <p className="conv-thread__note">
          <IconInfo size={12} />
          {t('q.comment.note')}
        </p>
      </div>
    </details>
  );
}

/** Who decides, in the words of the one who looks. */
function decideSentence(question: Question, facts: SessionFacts | null, selfId: string | null, canSubmit: boolean, canDiscuss: boolean, now: number): string {
  const decider = question.decider;
  if (decider === null) return t('q.decide.nobody');
  if (decider.userId === selfId) {
    if (facts?.responsibleId === selfId) return t('q.decide.responsible');
    if (facts?.openedById === selfId) return t('q.decide.opener');
    return t('q.decide.host');
  }
  const name = decider.displayName;
  if (canSubmit) return question.escalatedAt !== undefined ? t('q.decide.escalated', { name, age: formatAge(question.askedAt, now) }) : t('q.decide.hostToo', { name });
  if (!canDiscuss) return t('q.decide.viewer', { name });
  return facts?.responsibleId === decider.userId ? t('q.decide.other', { name }) : t('q.decide.otherOpener', { name });
}

function withdrawnText(question: Question): string {
  const withdrawn = question.withdrawn;
  switch (withdrawn?.reason) {
    case 'stopped':
      return withdrawn.by ? t('card.withdrawn.stoppedBy', { name: withdrawn.by.displayName }) : t('card.withdrawn.stopped');
    case 'ended':
      return withdrawn.by ? t('card.withdrawn.endedBy', { name: withdrawn.by.displayName }) : t('card.withdrawn.ended');
    case 'failed':
      return t('card.withdrawn.failed');
    default:
      return t('card.withdrawn.restarted');
  }
}

/** "Asked before: 2 votes for 'On the server'": the best option of the first part of the card this one replaces. */
function previousText(question: Question): string | null {
  const row = question.previous?.tally[0];
  const part = question.parts[0];
  if (row === undefined || part === undefined) return null;
  let best = -1;
  for (let index = 0; index < part.options.length; index++) if ((row[index] ?? 0) > (best === -1 ? 0 : (row[best] ?? 0))) best = index;
  if (best === -1) return null;
  return t('q.previous', { count: row[best] ?? 0, label: part.options[best]?.label ?? '' });
}

export const QuestionCard = memo(function QuestionCard({ questionId }: { questionId: string }) {
  const stores = useStores();
  const { sessionId, self, role, people, mentionNames } = useConversationEnv();
  const question = useStore(stores.conversations, (state) => state.conversations.get(sessionId)?.questions.get(questionId));
  const facts = useSessionFacts(sessionId);
  const ref = useRef<HTMLElement>(null);
  const selfId = self?.userId ?? null;
  const open = question?.status === 'open';
  const onScreen = useMarkSeen(ref, { sessionId, cardId: questionId }, open);
  const now = useNow(open ? 30_000 : 3_600_000);

  const [late, setLate] = useState<string | null>(null);
  const action = useAction((error) => {
    const settled = settledOf(error);
    if (settled === null) return false;
    setLate(lateAnswerText(settled));
    return true;
  });
  // A vote never blocks the answer (or the next vote): it has its own request state.
  const voting = useAction((error) => {
    const settled = settledOf(error);
    if (settled === null) return false;
    setLate(lateAnswerText(settled));
    return true;
  });
  const [chosen, setChosen] = useState<readonly (Chosen | null)[]>([]);
  const [different, setDifferent] = useState<readonly boolean[]>([]);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState<string | null>(null);

  const canDiscuss = role !== null && can(role, 'discuss');
  const isDecider = question?.decider != null && question.decider.userId === selfId;
  const escalated = question?.escalatedAt !== undefined;
  const canSubmit = open && role !== null && selfId !== null && maySubmit({ userId: selfId, role }, { decider: question?.decider?.userId ?? null, escalated });
  const ownWords = mayAnswerInOwnWords(role);

  // The decider (or the host) has the card on screen: everyone else sees that it was seen.
  const sawIt = open && onScreen && (isDecider || role === 'host') && question?.deciderSeenAt === undefined;
  useEffect(() => {
    if (sawIt) stores.conversations.seen(questionId);
  }, [sawIt, stores, questionId]);

  const tally = useMemo(() => (question ? questionTally(question) : []), [question]);
  const leading = useMemo(() => (question ? leadingAnswer(question) : []), [question]);

  if (question === undefined) {
    return (
      <Card ref={ref} id={cardDomId(questionId)} title={t('q.title')} icon={<KindIcon kind="question" label={kindLabel('question')} />} className="conv-card">
        <p className="conv-card__who">{t('card.missing')}</p>
      </Card>
    );
  }

  const voters = votersOf(question);
  const everyone = allVoted(question);
  const votedText = everyone ? t('q.allVoted', { count: question.eligible }) : t('q.voted', { voted: voters.complete.length, eligible: question.eligible });
  const icon = <KindIcon kind="question" label={kindLabel('question')} />;

  // ---- settled: one line, the rest behind it
  if (question.status !== 'open') {
    const answer = question.answer;
    const total = (answer?.tally[0] ?? []).reduce((sum, count) => sum + count, 0);
    return (
      <Card ref={ref} id={cardDomId(questionId)} title={t('q.title')} icon={icon} settled className="conv-card conv-card--question" meta={answer ? t('q.settled.tally', { count: total }) : undefined}>
        {question.parts.map((part, index) => (
          <p key={index} className="conv-q__settled">
            <span className="conv-q__settled-q">{part.text}</span>
            {gapAfter(part.text)}
            {answer ? <strong>{t('q.settled.answered', { answer: answerPartText(part, answer.parts[index]) })}</strong> : null}
          </p>
        ))}
        {answer ? (
          <p className="conv-card__who">
            {answer.onBehalfOf
              ? t('q.settled.byFor', { name: answer.by.displayName, decider: answer.onBehalfOf.displayName, time: formatTime(answer.at) })
              : t('q.settled.by', { name: answer.by.displayName, time: formatTime(answer.at) })}
          </p>
        ) : (
          <p className="conv-card__who">{withdrawnText(question)}</p>
        )}
        {answer?.note !== undefined ? <p className="conv-card__who">{t('q.settled.note', { note: answer.note })}</p> : null}
        {question.votes.length > 0 || question.comments.length > 0 ? (
          <details className="conv-q__more">
            <summary>{t('q.settled.show')}</summary>
            {question.parts.map((_, index) => (
              <PartView key={index} question={question} index={index} tally={tally[index] ?? []} leading={[]} people={people} selfId={selfId} voting={false} busy={false} onAddToNote={null} onVote={() => {}} />
            ))}
            <Comments question={question} people={people} names={mentionNames} canComment={false} onAddToNote={null} onComment={() => Promise.resolve(false)} busy={false} />
          </details>
        ) : null}
      </Card>
    );
  }

  // ---- open
  const addToNote = canSubmit && ownWords ? (text: string): void => setNote((previous) => (previous.trim() === '' ? text : `${previous.trimEnd()}\n${text}`).slice(0, ANSWER_NOTE_MAX_CHARS)) : null;

  const vote = (part: number, input: { options: number[] } | { other: string }): void => {
    setLate(null);
    setSaid(null);
    // The decider's click sets the vote AND the answer: an earlier "different answer" for that part goes.
    if (canSubmit) {
      setChosen((previous) => previous.map((entry, index) => (index === part ? null : entry)));
      setDifferent((previous) => previous.map((entry, index) => (index === part ? false : entry)));
    }
    void voting.run(() => stores.conversations.vote(questionId, part, input));
  };

  /** The answer of each part as it would be submitted now, or null while it has none. */
  const answers: (QuestionAnswerInput | null)[] = question.parts.map((_, index) => {
    const explicit = chosen[index] ?? null;
    if (explicit !== null) {
      if (explicit.kind === 'option') return { options: [explicit.option] };
      const text = explicit.text.trim();
      if (text === '') return null;
      return explicit.by === null ? { other: text } : { other: text, otherBy: explicit.by };
    }
    const mine = question.votes.find((entry) => entry.userId === selfId && entry.part === index);
    if (mine?.options !== undefined && mine.options.length > 0) return { options: [...mine.options] };
    if (mine?.other !== undefined && ownWords) return { other: mine.other };
    return leading[index] ?? null;
  });
  const answerLabel = (index: number): string => {
    const answer = answers[index];
    const part = question.parts[index] as Part;
    if (answer === null || answer === undefined) return t('q.answer.none');
    if ('other' in answer) return answer.other;
    return answer.options.map((option) => part.options[option]?.label ?? '').join(', ');
  };
  const complete = answers.every((answer) => answer !== null);
  const anyVotes = question.votes.length > 0;
  const tied = anyVotes && question.parts.some((_, index) => answers[index] === null);

  const submit = (): void => {
    if (!complete) return;
    setLate(null);
    const trimmed = note.trim();
    void action.run(() => stores.conversations.submit(questionId, answers as QuestionAnswerInput[], ownWords && trimmed !== '' ? trimmed : undefined));
  };

  const helpers = withAgentAccess(people).filter((person) => person.userId !== selfId);
  const whoCanWrite = t('q.editor', { names: formatAnd(helpers.map((person) => person.displayName)) });
  const askThem = (): void => {
    const mentions = helpers.map((person) => `@${person.displayName}`).join(' ');
    void action
      .run(() => stores.conversations.comment(questionId, t('q.askSubmit.text', { mentions }), helpers.map((person) => person.userId)))
      .then((ok) => {
        if (ok) setSaid(t('q.askSubmit.sent', { names: formatAnd(helpers.map((person) => person.displayName)) }));
      });
  };
  const remind = (): void => {
    void action.run(() => stores.conversations.remind(questionId)).then((ok) => {
      if (ok) setSaid(t('q.remind.sent'));
    });
  };

  const selectOptions = (index: number): SelectOption<string>[] => {
    const part = question.parts[index] as Part;
    const options: SelectOption<string>[] = [{ value: '', label: t('q.answer.choose') }, ...part.options.map((option, optionIndex) => ({ value: `o:${optionIndex}`, label: option.label }))];
    if (ownWords) {
      for (const entry of question.votes) if (entry.part === index && entry.other !== undefined) options.push({ value: `v:${entry.userId}`, label: t('q.answer.otherOf', { name: entry.displayName, text: entry.other }) });
      options.push({ value: 'own', label: t('q.answer.otherOwn') });
    }
    return options;
  };
  const selectValue = (index: number): string => {
    const explicit = chosen[index] ?? null;
    if (explicit === null) return '';
    if (explicit.kind === 'option') return `o:${explicit.option}`;
    return explicit.by === null ? 'own' : `v:${explicit.by}`;
  };
  const setChoice = (index: number, value: string): void => {
    let next: Chosen | null = null;
    if (value.startsWith('o:')) next = { kind: 'option', option: Number(value.slice(2)) };
    else if (value === 'own') next = { kind: 'other', by: null, text: '' };
    else if (value.startsWith('v:')) {
      const by = value.slice(2);
      next = { kind: 'other', by, text: question.votes.find((entry) => entry.userId === by && entry.part === index)?.other ?? '' };
    }
    setChosen((previous) => question.parts.map((_, at) => (at === index ? next : (previous[at] ?? null))));
  };

  const decider = question.decider;
  const submitLabel = decider !== null && !isDecider ? t('q.submitFor', { name: decider.displayName }) : question.parts.length > 1 ? t('q.submitAll') : t('q.submit');
  const previous = previousText(question);

  const footer = (
    <>
      <p className="conv-card__who">
        {decideSentence(question, facts, selfId, canSubmit, canDiscuss, now)}
        {canSubmit && tied ? <span className="conv-q__tie"> {t('q.tie')}</span> : null}
        {canSubmit && !anyVotes ? <span> {t('q.nobodyVoted')}</span> : null}
      </p>
      {!canSubmit && decider !== null && canDiscuss && !escalated ? (
        <p className="conv-card__who">{question.deciderSeenAt === undefined ? t('q.notSeen', { name: decider.displayName }) : t('q.seen', { name: decider.displayName })}</p>
      ) : null}
      {!canSubmit && escalated && decider !== null ? <p className="conv-card__who conv-card__who--warn">{t('card.escalated', { name: decider.displayName, age: formatAge(question.askedAt, now) })}</p> : null}
      {canSubmit ? (
        <>
          {question.parts.map((part, index) => (
            <div key={index} className="conv-q__submit">
              <span className="conv-q__answer">
                <span className="conv-q__answer-label">{question.parts.length > 1 ? t('q.answerFor', { question: part.text }) : t('q.answer')}</span> <strong>{answerLabel(index)}</strong>
              </span>
              {!part.multi && different[index] !== true ? (
                <button type="button" className="conv-link" onClick={() => setDifferent(question.parts.map((_, at) => at === index || different[at] === true))}>
                  {t('q.answer.different')}
                </button>
              ) : null}
              {different[index] === true ? (
                <Select
                  label={question.parts.length > 1 ? t('q.answerFor', { question: part.text }) : t('q.answer')}
                  hideLabel
                  options={selectOptions(index)}
                  value={selectValue(index)}
                  onChange={(value) => setChoice(index, value)}
                />
              ) : null}
              {chosen[index]?.kind === 'other' ? (
                <input
                  className="ui-input"
                  type="text"
                  aria-label={t('q.answer.otherText')}
                  placeholder={t('q.answer.otherText')}
                  maxLength={OTHER_ANSWER_MAX_CHARS}
                  value={(chosen[index] as Extract<Chosen, { kind: 'other' }>).text}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setChosen((entries) => entries.map((entry, at) => (at === index && entry?.kind === 'other' ? { ...entry, text } : entry)));
                  }}
                />
              ) : null}
            </div>
          ))}
          {ownWords ? (
            <textarea
              className="ui-input conv-q__note"
              // Two rows: the placeholder is a whole sentence ("Only this note and the answer reach Claude") and one
              // row cut it off in a column of ordinary width.
              rows={2}
              aria-label={t('q.note.label')}
              placeholder={t('q.note.placeholder')}
              maxLength={ANSWER_NOTE_MAX_CHARS}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          ) : (
            <p className="conv-card__who">
              {helpers.length > 0 ? (
                <>
                  {whoCanWrite}
                  {gapAfter(whoCanWrite)}
                  <button type="button" className="conv-link" disabled={action.busy} onClick={askThem}>
                    {t('q.askSubmit')}
                  </button>
                </>
              ) : null}
            </p>
          )}
          <div className="conv-card__actions">
            <Button variant="primary" disabled={!complete} loading={action.busy} onClick={submit}>
              {submitLabel}
            </Button>
          </div>
          <p className="conv-card__who conv-q__advice">{t('q.advice')}</p>
        </>
      ) : null}
      {(isDecider || role === 'host') && !everyone ? (
        <p className="conv-card__who">
          <button type="button" className="conv-link" disabled={action.busy} onClick={remind}>
            {t('q.remind')}
          </button>
        </p>
      ) : null}
      {said !== null ? (
        <p className="conv-card__who" role="status">
          {said}
        </p>
      ) : null}
      {late !== null ? (
        <p className="conv-card__who" role="status">
          {late}
        </p>
      ) : null}
      {(action.error ?? voting.error) !== null ? (
        <p className="conv-card__problem" role="alert">
          {t('actionFailed', { message: action.error ?? voting.error ?? '' })}
        </p>
      ) : null}
    </>
  );

  return (
    <Card ref={ref} id={cardDomId(questionId)} title={t('q.title')} icon={icon} tone="info" meta={votedText} className="conv-card conv-card--question" footer={footer}>
      {previous !== null ? <p className="conv-card__who">{previous}</p> : null}
      {question.parts.map((_, index) => (
        <PartView
          key={index}
          question={question}
          index={index}
          tally={tally[index] ?? []}
          leading={leading[index]?.options ?? []}
          people={people}
          selfId={selfId}
          voting={canDiscuss}
          busy={false}
          onAddToNote={addToNote}
          onVote={vote}
        />
      ))}
      <Comments
        question={question}
        people={people}
        names={mentionNames}
        canComment={canDiscuss}
        onAddToNote={addToNote}
        busy={action.busy}
        onComment={(text) => action.run(() => stores.conversations.comment(questionId, text, mentionsIn(text, people)))}
      />
    </Card>
  );
});
