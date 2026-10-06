// TEST ONLY. In-memory ConversationService and SuggestionService. They keep cards and suggestions and emit
// `question.changed`, `permission.changed` and `suggestion.changed` exactly as the real modules do; a new card gets
// its `card` event in the (fake) session's conversation, and every change of a card goes to the session's watchers as
// the WHOLE entity (`question.updated`, `permission.updated` with the host's copy, `suggest.updated`; the real
// conversation module sends the small `question.changed` for a vote or a comment). They do NOT apply the rules of
// ARCHITECTURE §3 (who may submit, what is offered), they do not listen to `agent.request`, and they never answer the
// agent (`answerQuestion` / `decidePermission`): tests of other modules put the state they need with the drivers
// (`ask`, `request`, `settleQuestion`, …).
import {
  MESSAGE_TEXT_MAX_CHARS,
  SmurgError,
  agentText,
  agentTextWithin,
  cardRefSchema,
  composeRevise,
  encodedSize,
  questionTally,
  settledError,
  takeListPage,
  takeWithinBytes,
  type CardRef,
  type PermissionRequest,
  type Question,
  type Role,
  type Suggestion,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type {
  AgentSessions,
  ConversationRemoval,
  ConversationService,
  MemberChange,
  MessageOrigin,
  Principal,
  Req,
  Res,
  SuggestionService,
  UserId,
} from '../interfaces.ts';
import { buildPermission, buildQuestion, buildSuggestion, type Overrides } from './build.ts';
import { CallLog, fakeId, type FakeEnv } from './env.ts';

function userRef(principal: Principal): UserRef {
  if (principal.actor.kind === 'user') return { userId: principal.actor.userId, displayName: principal.actor.displayName };
  return { userId: principal.userId ?? 'dev:host', displayName: 'Host' };
}

function drives(principal: Principal): boolean {
  return principal.kind === 'system' || principal.role === 'host' || principal.role === 'agent';
}

/** Takes cards by the page rule, the named ones first, then (with includeOpen) the open ones. */
function takeCards<T extends { id: string }>(
  kind: CardRef['kind'],
  all: readonly T[],
  refs: readonly CardRef[],
  isOpen: (card: T) => boolean,
  options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly atLeastOne?: boolean },
): { taken: T[]; more: CardRef[]; bytes: number } {
  const wanted = new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id));
  const candidates = all.filter((card) => wanted.has(card.id) || (options.includeOpen && isOpen(card)));
  const result = takeWithinBytes(candidates, options.budgetBytes, options.atLeastOne === true ? { atLeastOne: true } : {});
  return { taken: result.taken, more: result.rest.map((card) => cardRefSchema.parse({ kind, id: card.id })), bytes: result.bytes };
}

export class FakeSuggestionService implements SuggestionService {
  readonly log = new CallLog();
  private readonly env: FakeEnv;
  private readonly agents: AgentSessions | null;
  private readonly suggestions = new Map<string, Suggestion>();

  /** With `agents`, an accept sends the text to the session as a message of the author (as the real module does). */
  constructor(env: FakeEnv, agents: AgentSessions | null = null) {
    this.env = env;
    this.agents = agents;
  }

  /**
   * Puts a suggestion (a test-built one or an update): bus `suggestion.changed`; a NEW one gets its `card` event in the
   * session's conversation; `suggest.updated` goes to the session's watchers and to its author.
   */
  put(suggestion: Suggestion): Suggestion {
    const previous = this.suggestions.get(suggestion.id) ?? null;
    this.suggestions.set(suggestion.id, structuredClone(suggestion));
    this.env.bus.emit('suggestion.changed', { suggestion: structuredClone(suggestion), previous });
    if (this.agents !== null && this.agents.get(suggestion.sessionId) !== null) {
      if (previous === null) this.agents.append(suggestion.sessionId, { kind: 'card', card: 'suggestion', id: suggestion.id });
      this.agents.toWatchers(suggestion.sessionId, 'suggest.updated', { suggestion: structuredClone(suggestion) });
    }
    return suggestion;
  }

  async create(input: Req<'suggest.create'> & { readonly origin?: MessageOrigin; readonly topicId?: string; readonly itemId?: string; readonly cleaned?: boolean }, principal: Principal): Promise<Suggestion> {
    this.log.record('create', input, principal);
    const cleaned = agentText(input.text);
    return this.put(
      buildSuggestion({
        id: fakeId('sg'),
        sessionId: input.sessionId,
        author: userRef(principal),
        text: cleaned.text,
        cleaned: cleaned.cleaned || input.cleaned === true ? true : undefined,
        origin: input.origin ?? (input.source === undefined ? 'composer' : 'selection'),
        topicId: input.topicId,
        itemId: input.itemId,
        mentions: input.mentions,
        source: input.source,
        createdAt: this.env.clock.now(),
      }),
    );
  }

  async edit(input: Req<'suggest.edit'>, principal: Principal): Promise<Suggestion> {
    this.log.record('edit', input, principal);
    return this.put({ ...this.pending1(input.suggestionId), text: agentText(input.text).text });
  }

  async withdraw(input: Req<'suggest.withdraw'>, principal: Principal): Promise<Suggestion> {
    this.log.record('withdraw', input, principal);
    return this.put({ ...this.pending1(input.suggestionId), status: 'withdrawn', resolvedAt: this.env.clock.now() });
  }

  async accept(input: Req<'suggest.accept'>, principal: Principal): Promise<Suggestion> {
    this.log.record('accept', input, principal);
    const suggestion = this.pending1(input.suggestionId);
    const finalText = input.text === undefined ? suggestion.text : agentText(input.text).text;
    const modified = finalText !== suggestion.text;
    const decidedBy = userRef(principal);
    if (this.agents !== null) {
      await this.agents.send(suggestion.sessionId, {
        kind: 'person',
        from: { kind: 'user', actor: { kind: 'user', ...suggestion.author }, userId: suggestion.author.userId, role: 'editor' },
        text: finalText,
        cleaned: suggestion.cleaned === true,
        origin: suggestion.origin,
        suggestion: { id: suggestion.id, acceptedBy: decidedBy, modified },
      });
    }
    return this.put({ ...suggestion, status: modified ? 'accepted-modified' : 'accepted', resolvedAt: this.env.clock.now(), finalText, decidedBy });
  }

  async reject(input: Req<'suggest.reject'>, principal: Principal): Promise<Suggestion> {
    this.log.record('reject', input, principal);
    return this.put({
      ...this.pending1(input.suggestionId),
      status: 'rejected',
      resolvedAt: this.env.clock.now(),
      decidedBy: userRef(principal),
      ...(input.reason === undefined ? {} : { rejectReason: input.reason }),
    });
  }

  list(input: Req<'suggest.list'>, _principal: Principal): Res<'suggest.list'> {
    const all = [...this.suggestions.values()]
      .filter((suggestion) => input.sessionId === undefined || suggestion.sessionId === input.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((suggestion) => structuredClone(suggestion));
    const page = takeListPage(all, input.after, (suggestion) => suggestion.id);
    return { suggestions: page.items, hasMore: page.hasMore };
  }

  cards(sessionId: string, refs: readonly CardRef[], options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly atLeastOne?: boolean }): { readonly suggestions: Suggestion[]; readonly more: CardRef[]; readonly bytes: number } {
    const all = [...this.suggestions.values()].filter((suggestion) => suggestion.sessionId === sessionId);
    const result = takeCards('suggestion', all, refs, (suggestion) => suggestion.status === 'pending', options);
    return { suggestions: result.taken.map((suggestion) => structuredClone(suggestion)), more: result.more, bytes: result.bytes };
  }

  pending(): Suggestion[] {
    return [...this.suggestions.values()].filter((suggestion) => suggestion.status === 'pending').map((suggestion) => structuredClone(suggestion));
  }

  private pending1(id: string): Suggestion {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) throw new SmurgError('not_found', msg('suggest.notFound'));
    if (suggestion.status !== 'pending') {
      throw settledError({ card: { kind: 'suggestion', id }, sessionId: suggestion.sessionId, status: suggestion.status, ...(suggestion.decidedBy === undefined ? {} : { by: suggestion.decidedBy }) }, msg('suggest.notPending'));
    }
    return suggestion;
  }
}

export class FakeConversationService implements ConversationService {
  readonly log = new CallLog();
  /** What `memberRemoved` answers (tests set it). */
  removal: ConversationRemoval = { rules: [], modesReset: [], votes: 0, messages: 0 };
  private readonly env: FakeEnv;
  private readonly agents: AgentSessions | null;
  private readonly suggestionService: SuggestionService | null;
  private readonly questions = new Map<string, Question>();
  private readonly permissions = new Map<string, PermissionRequest>();

  /** With `agents`, messages really go to the (fake) session; with `suggestions`, an Editor's text becomes a suggestion. */
  constructor(env: FakeEnv, agents: AgentSessions | null = null, suggestions: SuggestionService | null = null) {
    this.env = env;
    this.agents = agents;
    this.suggestionService = suggestions;
  }

  // ---- drivers -----------------------------------------------------------------------------------------------------

  /** A question card appears: stored, bus `question.changed`, a `card` event in the session, `question.updated` to its watchers. */
  ask(question: Overrides<Question> & { readonly sessionId: string }): Question {
    return this.putQuestion(buildQuestion({ id: fakeId('q'), askedAt: this.env.clock.now(), ...question }));
  }

  /** Stores a question (new or changed): bus `question.changed`; `question.updated` to the watchers; a new one gets its `card` event. */
  putQuestion(question: Question): Question {
    const previous = this.questions.get(question.id) ?? null;
    this.questions.set(question.id, structuredClone(question));
    this.env.bus.emit('question.changed', { question: structuredClone(question), previous });
    if (this.agents !== null && this.agents.get(question.sessionId) !== null) {
      if (previous === null) this.agents.append(question.sessionId, { kind: 'card', card: 'question', id: question.id });
      this.agents.toWatchers(question.sessionId, 'question.updated', { question: structuredClone(question) });
    }
    return question;
  }

  /** A permission card appears: stored, bus `permission.changed`, a `card` event, `permission.updated` to the watchers (the host's copy with `path`). */
  request(request: Overrides<PermissionRequest> & { readonly sessionId: string }): PermissionRequest {
    return this.putPermission(buildPermission({ id: fakeId('pr'), askedAt: this.env.clock.now(), ...request }));
  }

  putPermission(request: PermissionRequest): PermissionRequest {
    const previous = this.permissions.get(request.id) ?? null;
    this.permissions.set(request.id, structuredClone(request));
    this.env.bus.emit('permission.changed', { request: structuredClone(request), previous });
    if (this.agents !== null && this.agents.get(request.sessionId) !== null) {
      if (previous === null) this.agents.append(request.sessionId, { kind: 'card', card: 'permission', id: request.id });
      this.agents.toWatchers(request.sessionId, 'permission.updated', { request: this.copyFor(request, false) }, { request: this.copyFor(request, true) });
    }
    return request;
  }

  /** The question is answered or withdrawn. */
  settleQuestion(id: string, patch: Partial<Question>): Question {
    return this.putQuestion({ ...this.needQuestion(id), ...patch });
  }

  /** The request is allowed, denied or withdrawn. */
  settlePermission(id: string, patch: Partial<PermissionRequest>): PermissionRequest {
    const request = this.permissions.get(id);
    if (!request) throw new SmurgError('not_found', msg('permission.notFound'));
    return this.putPermission({ ...request, ...patch });
  }

  // ---- ConversationService -----------------------------------------------------------------------------------------

  async send(input: Req<'session.message.send'>, principal: Principal): Promise<{ readonly messageId: string }> {
    this.log.record('send', input, principal);
    return this.deliver(principal, input.sessionId, input.text, input.origin ?? 'composer', input.mentions);
  }

  async sendAs(
    principal: Principal,
    input: { readonly sessionId: string; readonly text: string; readonly origin: MessageOrigin; readonly mentions?: readonly UserId[]; readonly target?: 'spec' | 'plan'; readonly quote?: { readonly heading?: string; readonly text: string }; readonly topicId?: string; readonly itemId?: string },
  ): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    this.log.record('sendAs', principal, input);
    // The stored, shown and sent text is made here, before a message is sent or a suggestion is created.
    const composed = input.target === undefined ? agentTextWithin(input.text, MESSAGE_TEXT_MAX_CHARS) : composeRevise({ target: input.target, text: input.text, ...(input.quote === undefined ? {} : { quote: input.quote }) }, MESSAGE_TEXT_MAX_CHARS);
    if (!composed.ok) throw new SmurgError(composed.reason === 'blank' ? 'bad_request' : 'too_large', undefined, { reason: composed.reason });
    if (drives(principal)) return this.deliver(principal, input.sessionId, composed.text, input.origin, input.mentions, composed.cleaned);
    if (this.suggestionService === null) {
      return { suggestion: buildSuggestion({ id: fakeId('sg'), sessionId: input.sessionId, author: userRef(principal), text: composed.text, cleaned: composed.cleaned ? true : undefined, origin: input.origin, topicId: input.topicId, itemId: input.itemId }) };
    }
    const suggestion = await this.suggestionService.create(
      { sessionId: input.sessionId, text: composed.text, cleaned: composed.cleaned, origin: input.origin, ...(input.topicId === undefined ? {} : { topicId: input.topicId }), ...(input.itemId === undefined ? {} : { itemId: input.itemId }), ...(input.mentions === undefined ? {} : { mentions: [...input.mentions] }) },
      principal,
    );
    return { suggestion };
  }

  vote(input: Req<'question.vote'>, principal: Principal): void {
    this.log.record('vote', input, principal);
    const question = this.openQuestion(input.questionId);
    const me = userRef(principal);
    const votes = question.votes.filter((vote) => !(vote.userId === me.userId && vote.part === input.part));
    if (input.options !== undefined) votes.push({ ...me, part: input.part, options: input.options, at: this.env.clock.now() });
    else if (input.other !== undefined) votes.push({ ...me, part: input.part, other: agentText(input.other).text, at: this.env.clock.now() });
    this.putQuestion({ ...question, votes });
  }

  comment(input: Req<'question.comment'>, principal: Principal): { readonly commentId: string } {
    this.log.record('comment', input, principal);
    const question = this.openQuestion(input.questionId);
    const commentId = fakeId('cm');
    this.putQuestion({
      ...question,
      comments: [...question.comments, { id: commentId, from: userRef(principal), text: agentText(input.text).text, at: this.env.clock.now(), ...(input.mentions === undefined ? {} : { mentions: input.mentions }) }],
    });
    return { commentId };
  }

  async submit(input: Req<'question.submit'>, principal: Principal): Promise<Question> {
    this.log.record('submit', input, principal);
    const question = this.openQuestion(input.questionId);
    const by = userRef(principal);
    return this.putQuestion({
      ...question,
      status: 'answered',
      answer: {
        parts: input.answers.map((answer) => ('options' in answer ? { options: answer.options } : { other: agentText(answer.other).text })),
        ...(input.note === undefined ? {} : { note: agentText(input.note).text }),
        by,
        // Whenever the submitter is not the decider.
        ...(question.decider !== null && question.decider.userId !== by.userId ? { onBehalfOf: question.decider } : {}),
        at: this.env.clock.now(),
        tally: questionTally(question),
      },
    });
  }

  remind(input: Req<'question.remind'>, principal: Principal): void {
    this.log.record('remind', input, principal);
    this.needQuestion(input.questionId);
  }

  seen(questionId: string, principal: Principal): void {
    this.log.record('seen', questionId, principal);
    const question = this.questions.get(questionId);
    if (question && question.deciderSeenAt === undefined) this.putQuestion({ ...question, deciderSeenAt: this.env.clock.now() });
  }

  async decide(input: Req<'permission.decide'>, principal: Principal): Promise<PermissionRequest> {
    this.log.record('decide', input, principal);
    const request = this.permissions.get(input.requestId);
    if (!request) throw new SmurgError('not_found', msg('permission.notFound'));
    if (request.status !== 'open') {
      throw settledError({ card: { kind: 'permission', id: request.id }, sessionId: request.sessionId, status: request.status, ...(request.decision === undefined ? {} : { by: request.decision.by }) }, msg('permission.notOpen'));
    }
    return this.putPermission({
      ...request,
      status: input.decision === 'deny' ? 'denied' : 'allowed',
      decision: {
        by: userRef(principal),
        at: this.env.clock.now(),
        ...(input.decision === 'allow-always' ? { always: input.scope ?? 'session' } : {}),
        ...(input.message === undefined ? {} : { message: agentText(input.message).text }),
      },
    });
  }

  question(id: string): Question | null {
    const question = this.questions.get(id);
    return question ? structuredClone(question) : null;
  }

  permission(id: string, forHost: boolean): PermissionRequest | null {
    const request = this.permissions.get(id);
    return request ? this.copyFor(request, forHost) : null;
  }

  openQuestions(): Question[] {
    return [...this.questions.values()].filter((question) => question.status === 'open').map((question) => structuredClone(question));
  }

  openPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].filter((request) => request.status === 'open').map((request) => structuredClone(request));
  }

  answeredQuestions(sessionId: string): Question[] {
    return [...this.questions.values()].filter((question) => question.sessionId === sessionId && question.status === 'answered').map((question) => structuredClone(question));
  }

  cards(
    sessionId: string,
    refs: readonly CardRef[],
    options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly forHost: boolean; readonly atLeastOne?: boolean },
  ): { readonly questions: Question[]; readonly permissions: PermissionRequest[]; readonly more: CardRef[]; readonly bytes: number } {
    const questions = takeCards('question', [...this.questions.values()].filter((question) => question.sessionId === sessionId), refs, (question) => question.status === 'open', options);
    const permissions = takeCards(
      'permission',
      [...this.permissions.values()].filter((request) => request.sessionId === sessionId).map((request) => this.copyFor(request, options.forHost)),
      refs,
      (request) => request.status === 'open',
      { includeOpen: options.includeOpen, budgetBytes: Math.max(0, options.budgetBytes - questions.bytes), ...(options.atLeastOne === true && questions.taken.length === 0 ? { atLeastOne: true } : {}) },
    );
    return {
      questions: questions.taken.map((question) => structuredClone(question)),
      permissions: permissions.taken,
      more: [...questions.more, ...permissions.more],
      bytes: encodedSize(questions.taken) + encodedSize(permissions.taken),
    };
  }

  memberRemoved(userId: UserId, change: MemberChange, to?: Role): ConversationRemoval {
    this.log.record('memberRemoved', userId, change, to);
    return this.removal;
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private needQuestion(id: string): Question {
    const question = this.questions.get(id);
    if (!question) throw new SmurgError('not_found', msg('question.notFound'));
    return question;
  }

  /** The question, when it is still open; else the refusal every late vote, comment and submit gets. */
  private openQuestion(id: string): Question {
    const question = this.needQuestion(id);
    if (question.status === 'open') return question;
    const by = question.status === 'answered' ? question.answer?.by : question.withdrawn?.by;
    throw settledError({ card: { kind: 'question', id }, sessionId: question.sessionId, status: question.status, ...(by === undefined ? {} : { by }) }, msg('question.notOpen'));
  }

  /** Everyone but the host gets an `outside` request without its absolute path. */
  private copyFor(request: PermissionRequest, forHost: boolean): PermissionRequest {
    const copy = structuredClone(request);
    if (!forHost) delete copy.path;
    return copy;
  }

  private async deliver(principal: Principal, sessionId: string, raw: string, origin: MessageOrigin, mentions: readonly UserId[] | undefined, alreadyCleaned = false): Promise<{ readonly messageId: string }> {
    const cleaned = agentText(raw);
    if (this.agents === null) return { messageId: fakeId('m') };
    const sent = await this.agents.send(sessionId, { kind: 'person', from: principal, text: cleaned.text, cleaned: cleaned.cleaned || alreadyCleaned, origin, ...(mentions === undefined ? {} : { mentions }) });
    return { messageId: sent.messageId };
  }
}
