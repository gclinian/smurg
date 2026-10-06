// What happens when a member goes (ARCHITECTURE §3 "When a member goes"): ONE place, driven by the bus events
// `member.kicked`, `member.left` and `member.role-changed`, so a kick, a leave or a demotion from any path (the admin
// handlers, the control socket, tests) ends in the same state. In this order:
//
//   1. ConversationService.memberRemoved   votes, the always-allowed kinds they added to sessions, a permission mode
//                                          they loosened, their queued messages (a kicked member's undelivered message
//                                          stops its turn)
//   2. TopicService.memberRemoved          the kinds they allowed for whole topics, items they armed, plan records
//                                          that name them
//   3. SessionManager.teardownUser         per session: end (terminals, free sessions), hand over to the host (topic
//                                          sessions; stopped first after a kick), clear them as responsible person and
//                                          as fallback decider
//   4. UploadService.abortAllForUser       (not for a role change)
//
// and one `session.handover` audit entry per handed-over session, with what was removed. A service that is still a
// stub (its module is not composed) is skipped. Each step has a time budget, so a kick answers within R2's 3 s.
import { can, type Role } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { ConversationRemoval, MemberChange, TopicRemoval, UserId, UserTeardown } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';

/** How long kick / leave wait for one step before answering (R2: 3 s for the whole kick). */
export const TEARDOWN_TIMEOUT_MS = 2_500;

async function withTimeout<T>(label: string, ctx: DaemonContext, work: () => Promise<T> | T): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TEARDOWN_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([Promise.resolve().then(work), timeout]);
    if (outcome === 'timeout') {
      ctx.log.warn('user teardown step timed out', { step: label });
      return null;
    }
    return outcome as T;
  } catch (err) {
    ctx.log.error('user teardown step failed', { step: label, error: err instanceof Error ? err.name : 'unknown' });
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The capabilities whose loss takes something away: what a member put in place, opened, or was asked to decide. */
const LOSABLE = ['session.create', 'session.drive', 'discuss'] as const;

/**
 * Whether a role change needs the teardown at all: only when it took one of `session.create`, `session.drive` or
 * `discuss` away. A promotion (and Editor ⇄ nothing-lost changes) removes nothing.
 */
export function roleChangeLoses(from: Role, to: Role): boolean {
  return LOSABLE.some((capability) => can(from, capability) && !can(to, capability));
}

export interface MemberTeardownResult {
  readonly conversation: ConversationRemoval | null;
  readonly topics: TopicRemoval | null;
  readonly sessions: UserTeardown | null;
}

/**
 * Runs the four steps for one member. `to`: the new role of a role change. Never throws; a failed or slow step is
 * logged and the others still run.
 */
export async function teardownMember(ctx: DaemonContext, userId: UserId, change: MemberChange, to?: Role): Promise<MemberTeardownResult> {
  const { conversation, topics, sessions, uploads } = ctx.services;
  const removedConversation = isStubService(conversation) ? null : await withTimeout('conversation', ctx, () => conversation.memberRemoved(userId, change, to));
  const removedTopics = isStubService(topics) ? null : await withTimeout('topics', ctx, () => topics.memberRemoved(userId, change, to));
  const [torn] = await Promise.all([
    isStubService(sessions) ? Promise.resolve(null) : withTimeout('sessions', ctx, () => sessions.teardownUser(userId, change, to)),
    isStubService(uploads) || change === 'role-changed' ? Promise.resolve(null) : withTimeout('uploads', ctx, () => uploads.abortAllForUser(userId)),
  ]);
  auditHandover(ctx, userId, change, to, removedConversation, removedTopics, torn);
  return { conversation: removedConversation, topics: removedTopics, sessions: torn };
}

function auditHandover(
  ctx: DaemonContext,
  userId: UserId,
  change: MemberChange,
  to: Role | undefined,
  conversation: ConversationRemoval | null,
  topics: TopicRemoval | null,
  sessions: UserTeardown | null,
): void {
  const host = ctx.members.hostUserId();
  const removed = {
    rules: [...(conversation?.rules ?? []), ...(topics?.rules ?? [])].slice(0, 50),
    armedItems: (topics?.disarmed ?? []).map((item) => `${item.topicId}/${item.itemId}`).slice(0, 50),
    queuedMessages: conversation?.messages ?? 0,
    votes: conversation?.votes ?? 0,
    modesReset: (conversation?.modesReset ?? []).slice(0, 50),
  };
  const anythingRemoved = removed.rules.length > 0 || removed.armedItems.length > 0 || removed.queuedMessages > 0 || removed.votes > 0 || removed.modesReset.length > 0;
  const base = { from: userId, to: host, reason: change, ...(to === undefined ? {} : { role: to }) };
  const handedOver = sessions?.handedOver ?? [];
  for (const session of handedOver) {
    ctx.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'session.handover',
      outcome: 'ok',
      target: session.sessionId,
      detail: { ...base, sessionId: session.sessionId, topicId: session.topicId, stopped: session.stopped, modeReset: removed.modesReset.includes(session.sessionId), removed },
    });
  }
  // Nothing passed to the host, but what the member put in place went: the log still says so, once.
  if (handedOver.length === 0 && (anythingRemoved || (sessions?.cleared.length ?? 0) > 0)) {
    ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'session.handover', outcome: 'ok', target: userId, detail: { ...base, removed, cleared: (sessions?.cleared ?? []).slice(0, 50) } });
  }
}
