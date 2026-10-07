// Questions (ARCHITECTURE §5.9; DESIGN §3.5): an agent's AskUserQuestion becomes a card everyone holding `discuss`
// votes and comments on; the decider submits. What reaches the agent on submit is composed in answer.ts from option
// INDEXES, counts and the agent's own labels; comments and other people's "Other" texts never do.
//
// Who has voted, the tally and the leading answer are `votes.ts` of @smurg/protocol; who decides and who may submit
// are `routing.ts`. Votes and comments travel as the small `question.changed`; the whole entity (`question.updated`)
// only when it is asked, answered or withdrawn, when the decider changes and when it escalates.
import {
  ANSWER_NOTE_MAX_CHARS,
  COMMENT_MAX_CHARS,
  OTHER_ANSWER_MAX_CHARS,
  QUESTION_COMMENTS_MAX,
  QUESTION_REMIND_INTERVAL_MS,
  QUESTION_VOTERS_MAX,
  SmurgError,
  can,
  lineEvent,
  mayAnswerInOwnWords,
  maySubmit,
  questionPartsSchema,
  questionTally,
  settledError,
  votersOf,
  type CardWithdrawnReason,
  type PayloadInputOf,
  type Question,
  type QuestionAnswer,
  type QuestionPart,
  type QuestionVote,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { AgentRequest, Principal, Req, UserId } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { DUPLICATE_REQUEST, SESSION_GONE } from './agent-sentences.ts';
import { composeAnswer, type SubmittedPart } from './answer.ts';
import type { CardsStore } from './cards-store.ts';
import { clipExcerpt, keptMentions, storeMentions, takeMentionTokens, tellSenderInboxFull } from './mentions.ts';
import { actingMember, cleanPersonText, currentDecider, refOf, type ActingMember } from './session-facts.ts';
import { isStubService } from '../core/stubs.ts';

type QuestionRequest = Extract<AgentRequest, { kind: 'question' }>;
type QuestionChange = Omit<PayloadInputOf<'question.changed'>, 'sessionId' | 'questionId'>;

/** The runner guarantees valid parts; a request that is not is refused towards the agent, never clipped. */
const QUESTION_NOT_VALID = 'This question could not be shown: ask one to four questions with distinct texts, each with two to four short options.';

function sameUser(a: UserRef | null, b: UserRef | null): boolean {
  return (a?.userId ?? null) === (b?.userId ?? null) && (a?.displayName ?? null) === (b?.displayName ?? null);
}

function sameParts(a: readonly QuestionPart[], b: readonly QuestionPart[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Questions {
  private readonly ctx: DaemonContext;
  private readonly store: CardsStore;
  /** When each question was last reminded about (once a minute per question). */
  private readonly remindedAt = new Map<string, number>();

  constructor(ctx: DaemonContext, store: CardsStore) {
    this.ctx = ctx;
    this.store = store;
  }

  // =================================================================================================================
  // From the agent
  // =================================================================================================================

  /** `agent.request` with an AskUserQuestion: a card. */
  raise(sessionId: string, request: QuestionRequest): void {
    const agents = this.ctx.services.agents;
    const existing = this.store.get(request.id);
    if (existing !== null) {
      // The runner never reuses an id; an echo of an open request changes nothing, anything else is refused.
      if (existing.kind === 'question' && existing.question.status === 'open' && existing.question.sessionId === sessionId) return;
      this.refuse(sessionId, request.id, DUPLICATE_REQUEST);
      return;
    }
    if (agents.get(sessionId) === null) {
      this.refuse(sessionId, request.id, SESSION_GONE);
      return;
    }
    const parts = questionPartsSchema.safeParse(request.parts);
    if (!parts.success) {
      this.refuse(sessionId, request.id, QUESTION_NOT_VALID);
      return;
    }
    const before = this.askedBeforeRestart(sessionId, parts.data);
    const draft: Question = {
      id: request.id,
      sessionId,
      askedAt: this.ctx.clock.now(),
      status: 'open',
      parts: parts.data,
      votes: [],
      comments: [],
      eligible: 0,
      decider: currentDecider(this.ctx, sessionId),
      ...(before === null ? {} : { previous: { askedAt: before.askedAt, tally: questionTally(before) } }),
    };
    const question: Question = { ...draft, eligible: this.eligibleOf(draft) };
    this.store.put({ kind: 'question', question });
    try {
      agents.append(sessionId, { kind: 'card', card: 'question', id: question.id });
    } catch (err) {
      this.ctx.log.error('the card event of a question was not appended', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
    this.announce(question, null, 'whole');
  }

  /** Claude Code withdrew the request (a stop, an end, a failure), or the daemon restarted. False: no open question has this id. */
  withdraw(id: string, reason: CardWithdrawnReason, by?: UserRef, options: { readonly silent?: boolean } = {}): boolean {
    const question = this.store.question(id);
    if (question === null || question.status !== 'open') return false;
    const next: Question = { ...question, status: 'withdrawn', withdrawn: { reason, ...(by === undefined ? {} : { by }), at: this.ctx.clock.now() } };
    this.remindedAt.delete(id);
    if (options.silent === true) this.store.put({ kind: 'question', question: next });
    else this.commit(next, question, 'whole');
    return true;
  }

  // =================================================================================================================
  // From people
  // =================================================================================================================

  vote(input: Req<'question.vote'>, principal: Principal): void {
    const member = this.discussing(principal);
    const question = this.requireOpen(input.questionId);
    const part = question.parts[input.part];
    if (part === undefined) throw this.unknownOption('unknown-part');
    const mine = question.votes.find((vote) => vote.userId === member.userId && vote.part === input.part);
    const at = this.ctx.clock.now();
    let vote: QuestionVote | null = null;
    if (input.options !== undefined) vote = { userId: member.userId, displayName: member.displayName, part: input.part, options: this.checkedOptions(part, input.options), at };
    else if (input.other !== undefined) vote = { userId: member.userId, displayName: member.displayName, part: input.part, other: cleanPersonText(input.other, OTHER_ANSWER_MAX_CHARS).text, at };
    if (vote === null && mine === undefined) return; // nothing to take back
    if (vote !== null && !question.votes.some((existing) => existing.userId === member.userId) && votersOf(question).any.length >= QUESTION_VOTERS_MAX) {
      throw new SmurgError('too_large', msg('question.tooManyVoters', { max: QUESTION_VOTERS_MAX }), { reason: 'too-many-voters' });
    }
    const votes = question.votes.filter((existing) => !(existing.userId === member.userId && existing.part === input.part));
    if (vote !== null) votes.push(vote);
    const draft: Question = { ...question, votes };
    const eligible = this.eligibleOf(draft);
    this.commit({ ...draft, eligible }, question, {
      ...(vote === null ? { voteRemoved: { userId: member.userId, part: input.part } } : { vote }),
      ...(eligible === question.eligible ? {} : { eligible }),
    });
  }

  comment(input: Req<'question.comment'>, principal: Principal): { readonly commentId: string } {
    const member = this.discussing(principal);
    const question = this.requireOpen(input.questionId);
    if (question.comments.length >= QUESTION_COMMENTS_MAX) {
      throw new SmurgError('too_large', msg('question.tooManyComments', { max: QUESTION_COMMENTS_MAX }), { reason: 'too-many-comments' });
    }
    const { text } = cleanPersonText(input.text, COMMENT_MAX_CHARS);
    const kept = keptMentions(this.ctx, text, input.mentions, member.userId);
    takeMentionTokens(this.ctx, member.userId, kept.length);
    const comment = { id: newId('cm'), from: refOf(member), text, at: this.ctx.clock.now(), ...(kept.length === 0 ? {} : { mentions: kept.map((mentioned) => mentioned.userId) }) };
    this.commit({ ...question, comments: [...question.comments, comment] }, question, { comment });
    storeMentions(this.ctx, { from: principal, kept, target: { kind: 'session', sessionId: question.sessionId }, anchor: { cardId: question.id }, text });
    return { commentId: comment.id };
  }

  /**
   * The decider; the host at any time; once escalated, every member with `session.drive`. Validated exactly like a
   * vote: option indexes of that part, one unless `multi`, every part answered. A free text and a note need
   * `session.drive`. The first submit wins.
   */
  async submit(input: Req<'question.submit'>, principal: Principal): Promise<Question> {
    const member = this.discussing(principal);
    const question = this.requireOpen(input.questionId);
    const decider = currentDecider(this.ctx, question.sessionId);
    const escalated = question.escalatedAt !== undefined;
    if (!maySubmit(member, { decider: decider?.userId ?? null, escalated })) {
      throw new AuthorizationError(msg('question.notDecider', { name: decider?.displayName ?? '' }), { reason: 'not-decider' });
    }
    if (input.answers.length !== question.parts.length) throw new SmurgError('bad_request', msg('question.incomplete'), { reason: 'incomplete' });
    const ownWords = mayAnswerInOwnWords(member.role);
    const submitted: SubmittedPart[] = [];
    const stored: QuestionAnswer['parts'] = [];
    const others: string[] = [];
    const otherAuthors: UserId[] = [];
    input.answers.forEach((answer, index) => {
      const part = question.parts[index] as QuestionPart;
      if ('options' in answer) {
        const options = this.checkedOptions(part, answer.options);
        submitted.push({ options });
        stored.push({ options });
        return;
      }
      if (!ownWords) throw new AuthorizationError(msg('question.otherNeedsAgentAccess'), { reason: 'other-needs-agent-access' });
      const { text } = cleanPersonText(answer.other, OTHER_ANSWER_MAX_CHARS);
      const author = answer.otherBy === undefined || answer.otherBy === member.userId ? null : this.otherAuthor(question, index, answer.otherBy, text);
      submitted.push({ other: text, ...(author === null ? {} : { otherBy: { ...author, role: this.ctx.members.roleOf(author.userId) } }) });
      stored.push({ other: text, ...(author === null ? {} : { otherBy: author }) });
      others.push(text);
      if (author !== null) otherAuthors.push(author.userId);
    });
    let note: string | undefined;
    if (input.note !== undefined) {
      if (!ownWords) throw new AuthorizationError(msg('question.otherNeedsAgentAccess'), { reason: 'other-needs-agent-access' });
      note = cleanPersonText(input.note, ANSWER_NOTE_MAX_CHARS).text;
    }
    const by = refOf(member);
    const tally = questionTally(question);
    // The agent first: when Claude Code withdrew the request meanwhile, nothing is settled here.
    try {
      this.ctx.services.agents.answerQuestion(question.sessionId, question.id, composeAnswer(question, submitted, note, by));
    } catch (err) {
      if (err instanceof SmurgError && err.code === 'conflict') throw settledError({ card: { kind: 'question', id: question.id }, sessionId: question.sessionId, status: 'withdrawn' }, msg('question.notOpen'));
      throw err;
    }
    const onBehalfOf = decider !== null && decider.userId !== by.userId ? decider : null;
    const answered: Question = {
      ...question,
      status: 'answered',
      decider,
      answer: { parts: stored, ...(note === undefined ? {} : { note }), by, ...(onBehalfOf === null ? {} : { onBehalfOf }), at: this.ctx.clock.now(), tally },
    };
    this.remindedAt.delete(question.id);
    this.commit(answered, question, 'whole');
    // "Submitted by Mei, Ian was away": only when the question had escalated.
    if (onBehalfOf !== null && escalated) this.line(question.sessionId, msg('conversation.submittedFor', { by: by.displayName, name: onBehalfOf.displayName }));
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'question.submit',
      outcome: 'ok',
      target: question.id,
      detail: {
        questionId: question.id,
        sessionId: question.sessionId,
        answers: stored.map((part) => (part.options === undefined ? 'other' : part.options.join(','))),
        tally: tally.map((row) => row.join(',')),
        escalated,
        ...(onBehalfOf === null ? {} : { onBehalfOf: onBehalfOf.userId }),
        ...(otherAuthors.length === 0 ? {} : { otherBy: otherAuthors }),
        ...(note === undefined ? {} : { note }),
        ...(others.length === 0 ? {} : { other: others.join('\n\n') }),
      },
      fullText: ['note', 'other'],
    });
    return structuredClone(answered);
  }

  /** The decider or the host: a mention for every eligible member who has not voted; once a minute per question. */
  remind(input: Req<'question.remind'>, principal: Principal): void {
    const member = this.discussing(principal);
    const question = this.requireOpen(input.questionId);
    this.requireDeciderOrHost(member, question);
    const now = this.ctx.clock.now();
    const last = this.remindedAt.get(question.id);
    if (last !== undefined && now - last < QUESTION_REMIND_INTERVAL_MS) {
      throw new SmurgError('rate_limited', msg('question.remind.tooSoon'), { reason: 'rate-limited', bucket: 'remind' });
    }
    this.remindedAt.set(question.id, now);
    const voted = new Set(votersOf(question).complete);
    const waiting = this.eligibleMembers(question).filter((userId) => userId !== member.userId && !voted.has(userId));
    let reminded = 0;
    if (!isStubService(this.ctx.services.inbox)) {
      const excerpt = clipExcerpt((question.parts[0] as QuestionPart).text);
      for (const userId of waiting) {
        const stored = this.ctx.services.inbox.addMention({ userId, from: principal.actor, target: { kind: 'session', sessionId: question.sessionId }, anchor: { cardId: question.id }, excerpt });
        if (stored === 'stored') reminded += 1;
        else tellSenderInboxFull(this.ctx, member.userId, this.ctx.members.userRef(userId)?.displayName ?? userId);
      }
    }
    this.ctx.audit.record({ actor: principal.actor, action: 'question.remind', outcome: 'ok', target: question.id, detail: { questionId: question.id, sessionId: question.sessionId, reminded, asked: waiting.length } });
  }

  /** The decider's client has the card on screen. Anyone but the decider or the host is refused; the host's own is not recorded. */
  seen(questionId: string, principal: Principal): void {
    const member = this.discussing(principal);
    const question = this.store.question(questionId);
    if (question === null) throw new SmurgError('not_found', msg('question.notFound'), { reason: 'unknown-question' });
    if (question.status !== 'open') return;
    const decider = this.requireDeciderOrHost(member, question);
    if (decider?.userId !== member.userId || question.deciderSeenAt !== undefined) return;
    const deciderSeenAt = this.ctx.clock.now();
    this.commit({ ...question, deciderSeenAt }, question, { deciderSeenAt });
  }

  // =================================================================================================================
  // Kept current by the module (events, the sweep)
  // =================================================================================================================

  /** The decider and `eligible` of the open questions (of one session, or of all), as they are now. */
  refresh(sessionId?: string): void {
    for (const question of this.store.openQuestions()) {
      if (sessionId !== undefined && question.sessionId !== sessionId) continue;
      const decider = currentDecider(this.ctx, question.sessionId);
      const eligible = this.eligibleOf(question);
      if (!sameUser(decider, question.decider)) {
        // A new decider has not seen the card yet.
        const { deciderSeenAt: _seen, ...rest } = question;
        this.commit({ ...(decider?.userId === question.decider?.userId ? question : rest), decider, eligible }, question, 'whole');
      } else if (eligible !== question.eligible) {
        this.commit({ ...question, eligible }, question, { eligible });
      }
    }
  }

  /** The question waited too long, or its decider is away: others may now submit for them. */
  escalate(id: string, at: number): void {
    const question = this.store.question(id);
    if (question === null || question.status !== 'open' || question.escalatedAt !== undefined) return;
    this.commit({ ...question, escalatedAt: at }, question, 'whole');
  }

  /** The votes of a member who was removed leave every open question. Returns how many went. */
  removeVotesOf(userId: UserId): number {
    let removed = 0;
    for (const question of this.store.openQuestions()) {
      const gone = question.votes.filter((vote) => vote.userId === userId);
      if (gone.length === 0) continue;
      removed += gone.length;
      const draft: Question = { ...question, votes: question.votes.filter((vote) => vote.userId !== userId) };
      const next: Question = { ...draft, eligible: this.eligibleOf(draft) };
      this.store.put({ kind: 'question', question: next });
      this.ctx.bus.emit('question.changed', { question: structuredClone(next), previous: structuredClone(question) });
      gone.forEach((vote, index) => {
        this.toWatchers(next.sessionId, 'question.changed', { sessionId: next.sessionId, questionId: next.id, voteRemoved: { userId, part: vote.part }, ...(index === gone.length - 1 && next.eligible !== question.eligible ? { eligible: next.eligible } : {}) });
      });
    }
    return removed;
  }

  /** Who the question waits for right now. */
  deciderOf(question: Question): UserRef | null {
    return currentDecider(this.ctx, question.sessionId);
  }

  // =================================================================================================================
  // Internals
  // =================================================================================================================

  private discussing(principal: Principal): ActingMember {
    const member = actingMember(this.ctx, principal);
    if (!can(member.role, 'discuss')) throw new AuthorizationError(undefined, { reason: 'capability' });
    return member;
  }

  private requireOpen(id: string): Question {
    const question = this.store.question(id);
    if (question === null) throw new SmurgError('not_found', msg('question.notFound'), { reason: 'unknown-question' });
    if (question.status === 'open') return question;
    const by = question.status === 'answered' ? question.answer?.by : question.withdrawn?.by;
    throw settledError({ card: { kind: 'question', id }, sessionId: question.sessionId, status: question.status, ...(by === undefined ? {} : { by }) }, msg('question.notOpen'));
  }

  /** The current decider, when `member` is the decider or the host; else the refusal. */
  private requireDeciderOrHost(member: ActingMember, question: Question): UserRef | null {
    const decider = currentDecider(this.ctx, question.sessionId);
    if (member.role !== 'host' && decider?.userId !== member.userId) {
      throw new AuthorizationError(msg('question.notDecider', { name: decider?.displayName ?? '' }), { reason: 'not-decider' });
    }
    return decider;
  }

  private unknownOption(reason: string): SmurgError {
    return new SmurgError('bad_request', msg('question.unknownOption'), { reason });
  }

  /** Indexes of that part's options, each once, exactly one unless the part is `multi`; in option order. */
  private checkedOptions(part: QuestionPart, options: readonly number[]): number[] {
    const unique = [...new Set(options)].sort((a, b) => a - b);
    if (unique.length !== options.length || unique.length === 0) throw this.unknownOption('duplicate-option');
    if (unique.some((option) => !Number.isInteger(option) || option < 0 || option >= part.options.length)) throw this.unknownOption('unknown-option');
    if (!part.multi && unique.length !== 1) throw this.unknownOption('single-select');
    return unique;
  }

  /**
   * `otherBy` names a member whose "Other" vote on that part the text came from. A name is put on a text only when
   * the submitted text IS that member's vote on that part (both cleaned the same way): a member who proposed nothing
   * there is refused, and a text the submitter changed is the submitter's own (null: no attribution anywhere, not on
   * the card, not in what the agent reads, not in the audit log).
   */
  private otherAuthor(question: Question, part: number, userId: UserId, text: string): UserRef | null {
    const author = this.ctx.members.userRef(userId);
    const proposed = question.votes.find((vote) => vote.userId === userId && vote.part === part && vote.other !== undefined);
    if (author === null || proposed === undefined) throw new SmurgError('bad_request', undefined, { reason: 'other-by' });
    return proposed.other === text ? author : null;
  }

  /** Members holding `discuss` who are online or have voted on any part. */
  private eligibleMembers(question: Pick<Question, 'parts' | 'votes'>): UserId[] {
    const voted = new Set(votersOf(question).any);
    const out = new Set<UserId>(voted);
    for (const member of this.ctx.members.routing()) {
      if (can(member.role, 'discuss') && this.ctx.hub.isOnline(member.userId)) out.add(member.userId);
    }
    return [...out];
  }

  private eligibleOf(question: Pick<Question, 'parts' | 'votes'>): number {
    return this.eligibleMembers(question).length;
  }

  /** The newest question of the session that was open when smurg restarted and asked exactly this. */
  private askedBeforeRestart(sessionId: string, parts: readonly QuestionPart[]): Question | null {
    const cards = this.store.ofSession(sessionId);
    for (let i = cards.length - 1; i >= 0; i -= 1) {
      const card = cards[i];
      if (card?.kind !== 'question') continue;
      if (card.question.withdrawn?.reason === 'restarted' && sameParts(card.question.parts, parts)) return card.question;
    }
    return null;
  }

  private refuse(sessionId: string, requestId: string, message: string): void {
    try {
      this.ctx.services.agents.decidePermission(sessionId, requestId, { allow: false, message });
    } catch {
      // Already withdrawn, or the session is gone: nothing waits for an answer.
    }
  }

  private line(sessionId: string, ref: ReturnType<typeof msg>): void {
    try {
      this.ctx.services.agents.append(sessionId, lineEvent(ref));
    } catch (err) {
      this.ctx.log.error('a system line was not appended', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private commit(next: Question, previous: Question, wire: 'whole' | QuestionChange): void {
    this.store.put({ kind: 'question', question: next });
    this.announce(next, previous, wire);
  }

  private announce(next: Question, previous: Question | null, wire: 'whole' | QuestionChange): void {
    this.ctx.bus.emit('question.changed', { question: structuredClone(next), previous: previous === null ? null : structuredClone(previous) });
    if (wire === 'whole') this.toWatchers(next.sessionId, 'question.updated', { question: next });
    else this.toWatchers(next.sessionId, 'question.changed', { sessionId: next.sessionId, questionId: next.id, ...wire });
  }

  private toWatchers<T extends 'question.updated' | 'question.changed'>(sessionId: string, type: T, payload: PayloadInputOf<T>): void {
    try {
      this.ctx.services.agents.toWatchers(sessionId, type, payload);
    } catch (err) {
      this.ctx.log.error('a question update was not sent', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}
