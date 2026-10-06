// ConversationService (ARCHITECTURE §5.9, §7.2; DESIGN §3.4–§3.6, §3.9): the collaborative layer of an agent session's
// conversation. It turns what an agent asks (`agent.request` on the bus) into cards or answers it itself, takes what
// people do about a card (votes, comments, the answer, the decision), sends people's messages to agents, and keeps
// every card for late joiners.
//
//   messages.ts      session.message.send, sendAs: a message, or a suggestion for a member without agent access
//   questions.ts     AskUserQuestion → a question card; votes, comments, submit, remind; answer.ts composes the note
//   permissions.ts   a permission request → a card or an automatic answer; decide; the rule check; the re-lock
//   escalation.ts    the sweep: what waits too long, who is away
//   membership.ts    what goes with a member who was removed
//   cards-store.ts   cards.json per session
//   gate-audit.ts    the tool gate's refusals, one audit entry per session, row and minute
//
// The lines this module writes: `conversation.submittedFor`, `conversation.rule.added`, `conversation.rule.added.topic`
// (core/interfaces.ts says which method writes which line; everything else about a session is AgentSessions').
import { encodedSize, takeWithinBytes, type CardRef, type PermissionRequest, type Question, type Role, type Suggestion } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { ConversationRemoval, ConversationService, MemberChange, Principal, Req, UserId } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { isStubService } from '../core/stubs.ts';
import { CardsStore, cardIsOpen, type Card, type CardsLimits } from './cards-store.ts';
import { Escalation } from './escalation.ts';
import { GATE_AUDIT_WINDOW_MS, GateAudit } from './gate-audit.ts';
import { removeMember } from './membership.ts';
import { Messages, type SendAsInput } from './messages.ts';
import { Permissions } from './permissions.ts';
import { Questions } from './questions.ts';

export interface ConversationModuleOptions {
  /** How many settled cards and how many characters of cards.json a session keeps. */
  readonly cards?: Partial<CardsLimits>;
  /** The window of the coalesced `permission.auto-deny` audit entries. */
  readonly gateAuditWindowMs?: number;
}

export class ConversationServiceImpl implements ConversationService {
  private readonly ctx: DaemonContext;
  private readonly store: CardsStore;
  private readonly messages: Messages;
  private readonly questions: Questions;
  private readonly permissions: Permissions;
  private readonly escalation: Escalation;
  private readonly gate: GateAudit;
  /** Work started for the agent runtime that nothing awaits (a removed rule, a reset mode): awaited at stop. */
  private readonly background = new Set<Promise<unknown>>();
  private started = false;

  constructor(ctx: DaemonContext, options: ConversationModuleOptions = {}) {
    this.ctx = ctx;
    this.store = new CardsStore(ctx, options.cards);
    this.messages = new Messages(ctx);
    this.questions = new Questions(ctx, this.store);
    this.permissions = new Permissions(ctx, this.store);
    this.escalation = new Escalation(ctx, this.store, this.questions, this.permissions);
    this.gate = new GateAudit(ctx, options.gateAuditWindowMs ?? GATE_AUDIT_WINDOW_MS);
    this.escalation.onSweep(() => this.gate.flushDue());
  }

  // =================================================================================================================
  // Lifecycle
  // =================================================================================================================

  /**
   * Loads the cards, then withdraws the ones that were still open (`restarted`): no request survives a restart of the
   * daemon, and the runner announces no withdrawal for one. Nobody is connected yet, so nothing is sent.
   */
  async start(): Promise<void> {
    await this.store.start();
    for (const card of this.store.openCards()) {
      if (card.kind === 'question') this.questions.withdraw(card.question.id, 'restarted', undefined, { silent: true });
      else this.permissions.withdraw(card.request.id, 'restarted', { silent: true });
    }
    await this.store.flush();
    this.escalation.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.escalation.stop();
    this.gate.flush();
    await Promise.allSettled([...this.background]);
    await this.store.flush();
  }

  /** Bus wiring: what the agent runtime announces, what changes who decides, who is online. */
  attach(): Disposable {
    const stack = new DisposableStack();
    const bus = this.ctx.bus;
    stack.add(
      bus.on('agent.request', (event) => {
        if (event.request.kind === 'question') this.guard(() => this.questions.raise(event.sessionId, event.request as Extract<typeof event.request, { kind: 'question' }>));
        else this.track(this.permissions.raise(event.sessionId, event.request));
      }),
    );
    stack.add(
      bus.on('agent.request.withdrawn', (event) => {
        this.guard(() => {
          if (!this.questions.withdraw(event.requestId, event.reason, event.by)) this.permissions.withdraw(event.requestId, event.reason);
        });
      }),
    );
    stack.add(bus.on('agent.tool.gate', (event) => this.guard(() => this.gate.denied(event))));
    stack.add(bus.on('agent.turn.finished', (event) => this.guard(() => this.gate.flush(event.sessionId))));
    stack.add(
      bus.on('session.exited', (event) => {
        if (event.session.kind !== 'agent') return;
        this.guard(() => {
          // The runner withdraws a session's open requests itself; this is the net under it.
          for (const card of this.store.ofSession(event.session.id)) {
            if (!cardIsOpen(card)) continue;
            if (card.kind === 'question') this.questions.withdraw(card.question.id, 'ended');
            else this.permissions.withdraw(card.request.id, 'ended');
          }
          this.gate.flush(event.session.id);
        });
      }),
    );
    // Who is responsible changed (or anything else about the session): the decider of its open questions.
    stack.add(
      bus.on('session.updated', (event) => {
        if (event.session.kind === 'agent') this.guard(() => this.questions.refresh(event.session.id));
      }),
    );
    // A topic was deleted: its sessions' cards go from memory BEFORE the transcripts (and the files with them) go.
    stack.add(bus.on('topic.removed', (event) => this.guard(() => this.store.dropSessions(event.sessionIds))));
    for (const name of ['member.joined', 'member.kicked', 'member.left', 'member.role-changed'] as const) {
      stack.add(bus.on(name, () => this.guard(() => this.questions.refresh())));
    }
    for (const name of ['conn.opened', 'conn.closed'] as const) {
      stack.add(
        bus.on(name, (event) => {
          if (event.conn.purpose !== 'interactive') return;
          this.guard(() => {
            this.escalation.presenceChanged(event.conn.userId);
            this.questions.refresh();
          });
        }),
      );
    }
    stack.add(bus.on('settings.changed', (event) => event.settings.escalateAfterMs !== event.previous.escalateAfterMs && this.escalation.sweep()));
    return stack;
  }

  // =================================================================================================================
  // ConversationService
  // =================================================================================================================

  send(input: Req<'session.message.send'>, principal: Principal): Promise<{ readonly messageId: string }> {
    return this.messages.send(input, principal);
  }

  sendAs(principal: Principal, input: SendAsInput): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }> {
    return this.messages.sendAs(principal, input);
  }

  vote(input: Req<'question.vote'>, principal: Principal): void {
    this.questions.vote(input, principal);
  }

  comment(input: Req<'question.comment'>, principal: Principal): { readonly commentId: string } {
    return this.questions.comment(input, principal);
  }

  submit(input: Req<'question.submit'>, principal: Principal): Promise<Question> {
    return this.questions.submit(input, principal);
  }

  remind(input: Req<'question.remind'>, principal: Principal): void {
    this.questions.remind(input, principal);
  }

  seen(questionId: string, principal: Principal): void {
    this.questions.seen(questionId, principal);
  }

  decide(input: Req<'permission.decide'>, principal: Principal): Promise<PermissionRequest> {
    return this.permissions.decide(input, principal);
  }

  question(id: string): Question | null {
    const question = this.store.question(id);
    return question === null ? null : structuredClone(question);
  }

  permission(id: string, forHost: boolean): PermissionRequest | null {
    const request = this.store.permission(id);
    return request === null ? null : this.permissions.copyFor(request, forHost);
  }

  openQuestions(): Question[] {
    return this.store.openQuestions().map((question) => structuredClone(question));
  }

  /** The host's copies. */
  openPermissions(): PermissionRequest[] {
    return this.store.openPermissions().map((request) => structuredClone(request));
  }

  answeredQuestions(sessionId: string): Question[] {
    return this.store.ofSession(sessionId).flatMap((card) => (card.kind === 'question' && card.question.status === 'answered' ? [structuredClone(card.question)] : []));
  }

  /**
   * The cards `refs` name plus (with `includeOpen`) the session's open ones, in the order they appeared, while they
   * fit `budgetBytes`; the rest in `more`. Questions first, then permission requests in what is left.
   */
  cards(
    sessionId: string,
    refs: readonly CardRef[],
    options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly forHost: boolean; readonly atLeastOne?: boolean },
  ): { readonly questions: Question[]; readonly permissions: PermissionRequest[]; readonly more: CardRef[]; readonly bytes: number } {
    const wanted = new Set(refs.filter((ref) => ref.kind !== 'suggestion').map((ref) => `${ref.kind}:${ref.id}`));
    const picked = this.store.ofSession(sessionId).filter((card: Card) => {
      const id = card.kind === 'question' ? card.question.id : card.request.id;
      return wanted.has(`${card.kind}:${id}`) || (options.includeOpen && cardIsOpen(card));
    });
    const questions = picked.flatMap((card) => (card.kind === 'question' ? [card.question] : []));
    const requests = picked.flatMap((card) => (card.kind === 'permission' ? [this.permissions.copyFor(card.request, options.forHost)] : []));
    const takenQuestions = takeWithinBytes(questions, options.budgetBytes, options.atLeastOne === true ? { atLeastOne: true } : {});
    const takenRequests = takeWithinBytes(requests, Math.max(0, options.budgetBytes - takenQuestions.bytes), options.atLeastOne === true && takenQuestions.taken.length === 0 ? { atLeastOne: true } : {});
    const taken = { questions: takenQuestions.taken.map((question) => structuredClone(question)), permissions: takenRequests.taken };
    return {
      ...taken,
      more: [...takenQuestions.rest.map((question) => ({ kind: 'question' as const, id: question.id })), ...takenRequests.rest.map((request) => ({ kind: 'permission' as const, id: request.id }))],
      bytes: encodedSize(taken.questions) + encodedSize(taken.permissions),
    };
  }

  /** Called by the core's teardown only. The runtime's own work for it (rules, mode, a stop) goes on behind the answer. */
  memberRemoved(userId: UserId, change: MemberChange, to?: Role): ConversationRemoval {
    return removeMember(this.ctx, this.questions, userId, change, to, (work) => this.track(work));
  }

  // =================================================================================================================
  // For tests and the module
  // =================================================================================================================

  /** One round of the sweep now (tests; the timer calls the same). */
  sweep(): void {
    this.escalation.sweep();
  }

  /** Everything this service started in the background is done and every card is on disk. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await this.store.flush();
  }

  get isStarted(): boolean {
    return this.started;
  }

  // =================================================================================================================
  // Internals
  // =================================================================================================================

  /** A bus listener never throws. */
  private guard(work: () => void): void {
    try {
      if (isStubService(this.ctx.services.agents)) return;
      work();
    } catch (err) {
      this.ctx.log.error('a conversation listener failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((err: unknown) => {
      this.ctx.log.error('background work of the conversation module failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }
}
