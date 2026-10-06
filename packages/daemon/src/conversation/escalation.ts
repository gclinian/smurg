// What waits too long reaches the others who may settle it (ARCHITECTURE §3 "Who decides"; DESIGN §3.9): a question
// or a permission request gets `escalatedAt` after the host setting `escalateAfterMs`, or at once when the ONE person
// it waits for has been offline for `escalateOfflineMs`. From then on it is also in the inboxes of the host and every
// member with agent access (routing.ts); for a question they may submit for the decider.
//
// There is no timer per card: stored times are compared with `ctx.clock.now()`, on a real interval of
// `ctx.config.agents.escalationSweepMs` and on the events that can change the answer. The same sweep keeps
// `Question.decider` and `Question.eligible` current where no event says they changed (a cleared fallback decider).
import { permissionRecipients } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { UserId } from '../core/interfaces.ts';
import type { CardsStore } from './cards-store.ts';
import type { Permissions } from './permissions.ts';
import type { Questions } from './questions.ts';
import { routingOf } from './session-facts.ts';

export class Escalation {
  private readonly ctx: DaemonContext;
  private readonly store: CardsStore;
  private readonly questions: Questions;
  private readonly permissions: Permissions;
  /** Since when a member has had no connection. A member never seen online counts from the module's start. */
  private readonly offlineSince = new Map<UserId, number>();
  private startedAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly extra: (() => void)[] = [];

  constructor(ctx: DaemonContext, store: CardsStore, questions: Questions, permissions: Permissions) {
    this.ctx = ctx;
    this.store = store;
    this.questions = questions;
    this.permissions = permissions;
    this.startedAt = ctx.clock.now();
  }

  /** Something else the sweep does on every round (the coalesced gate audit). */
  onSweep(task: () => void): void {
    this.extra.push(task);
  }

  start(): void {
    this.startedAt = this.ctx.clock.now();
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sweep(), Math.max(1, this.ctx.config.agents.escalationSweepMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** A connection opened or closed: who is offline since when. */
  presenceChanged(userId: UserId): void {
    if (this.ctx.hub.isOnline(userId)) this.offlineSince.delete(userId);
    else if (!this.offlineSince.has(userId)) this.offlineSince.set(userId, this.ctx.clock.now());
  }

  /** One round: presence, escalations, deciders and `eligible`, and whatever else was registered. Never throws. */
  sweep(): void {
    try {
      this.trackPresence();
      this.escalateDue();
      this.questions.refresh();
    } catch (err) {
      this.ctx.log.error('the escalation sweep failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
    for (const task of this.extra) {
      try {
        task();
      } catch (err) {
        this.ctx.log.error('a sweep task failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  private trackPresence(): void {
    const now = this.ctx.clock.now();
    const members = new Set<UserId>();
    for (const member of this.ctx.members.routing()) {
      members.add(member.userId);
      if (this.ctx.hub.isOnline(member.userId)) this.offlineSince.delete(member.userId);
      else if (!this.offlineSince.has(member.userId)) this.offlineSince.set(member.userId, Math.min(now, this.startedAt));
    }
    for (const userId of [...this.offlineSince.keys()]) if (!members.has(userId)) this.offlineSince.delete(userId);
  }

  private offlineFor(userId: UserId, now: number): number {
    if (this.ctx.hub.isOnline(userId)) return 0;
    return now - (this.offlineSince.get(userId) ?? this.startedAt);
  }

  private escalateDue(): void {
    const now = this.ctx.clock.now();
    const after = this.ctx.settings.get().escalateAfterMs;
    const offlineAfter = this.ctx.config.agents.escalateOfflineMs;
    const members = this.ctx.members.routing();
    for (const question of this.store.openQuestions()) {
      if (question.escalatedAt !== undefined) continue;
      const decider = this.questions.deciderOf(question);
      const away = decider !== null && this.offlineFor(decider.userId, now) >= offlineAfter;
      if (now - question.askedAt >= after || away) this.questions.escalate(question.id, now);
    }
    for (const request of this.store.openPermissions()) {
      if (request.escalatedAt !== undefined) continue;
      // The offline rule applies when the request waits for exactly one person who is not the host-only answerer.
      const waitsFor = request.hostOnly ? [] : permissionRecipients({ hostOnly: false, escalated: false }, routingOf(this.ctx, request.sessionId), members);
      const responsible = routingOf(this.ctx, request.sessionId).responsible;
      const away = waitsFor.length === 1 && waitsFor[0] === responsible && this.offlineFor(responsible, now) >= offlineAfter;
      if (now - request.askedAt >= after || away) this.permissions.escalate(request.id, now);
    }
  }
}
