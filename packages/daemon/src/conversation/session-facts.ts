// The facts every part of the conversation module reads about a session and a caller: is it an agent session, is it
// still open, who decides its questions right now, who is the member acting. One place, so a card, a refusal and a
// system line cannot disagree. The routing rules themselves are the pure functions of `@smurg/protocol` (routing.ts).
import {
  MESSAGE_TEXT_MAX_CHARS,
  SmurgError,
  agentTextWithin,
  deciderOf,
  type AgentSession,
  type Role,
  type RoutingMember,
  type SessionRouting,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { Principal } from '../core/interfaces.ts';
import { isStubService } from '../core/stubs.ts';

/** The agent session a request names. A terminal: `bad_request` reason `not-an-agent`. */
export function requireAgentSession(ctx: DaemonContext, sessionId: string): AgentSession {
  const session = ctx.services.agents.get(sessionId);
  if (session !== null) return session;
  if (!isStubService(ctx.services.sessions) && ctx.services.sessions.get(sessionId) !== null) {
    throw new SmurgError('bad_request', msg('session.notAgent'), { reason: 'not-an-agent' });
  }
  throw new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' });
}

function topicArchived(ctx: DaemonContext, session: AgentSession): boolean {
  if (session.endReason === 'archived') return true;
  if (session.topicId === undefined || isStubService(ctx.services.topics)) return false;
  return ctx.services.topics.get(session.topicId)?.archived === true;
}

/** An agent session that still takes messages: not ended (`conflict`, reason `ended`), its topic not archived (`archived`). */
export function requireOpenSession(ctx: DaemonContext, sessionId: string): AgentSession {
  const session = requireAgentSession(ctx, sessionId);
  if (topicArchived(ctx, session)) throw new SmurgError('conflict', msg('topic.archived'), { reason: 'archived' });
  if (session.status === 'ended') throw new SmurgError('conflict', msg('session.ended.noMessages'), { reason: 'ended' });
  return session;
}

/** What routing.ts needs of a session: who is responsible, and the stored fallback decider. */
export function routingOf(ctx: DaemonContext, sessionId: string): SessionRouting {
  const agents = ctx.services.agents;
  return { responsible: agents.get(sessionId)?.responsible?.userId ?? null, fallbackDecider: agents.facts(sessionId)?.fallbackDecider ?? null };
}

/** Who decides the session's questions right now (routing.ts `deciderOf` over the current members), or null. */
export function currentDecider(ctx: DaemonContext, sessionId: string): UserRef | null {
  const userId = deciderOf(routingOf(ctx, sessionId), ctx.members.routing());
  return userId === null ? null : ctx.members.userRef(userId);
}

export interface ActingMember extends RoutingMember {
  readonly displayName: string;
  readonly role: Role;
}

/** The ACTIVE member a principal acts as. Agents and the system never vote, comment, submit or decide. */
export function actingMember(ctx: DaemonContext, principal: Principal): ActingMember {
  const member = principal.kind === 'user' && principal.userId !== null ? ctx.members.active(principal.userId) : null;
  if (member === null) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
  return { userId: member.userId, displayName: member.displayName, role: member.role };
}

export function refOf(member: ActingMember): UserRef {
  return { userId: member.userId, displayName: member.displayName };
}

/**
 * Text a person wrote, as it is stored, shown and sent: `agentText`, not blank, within `maxChars`. `blank` is a
 * `bad_request`, `too-long` (quoting can add characters) `too_large`, both with `session.text.invalid`.
 */
export function cleanPersonText(raw: string, maxChars: number = MESSAGE_TEXT_MAX_CHARS): { readonly text: string; readonly cleaned: boolean } {
  const within = agentTextWithin(raw, maxChars);
  if (within.ok) return { text: within.text, cleaned: within.cleaned };
  throw new SmurgError(within.reason === 'blank' ? 'bad_request' : 'too_large', msg('session.text.invalid'), { reason: within.reason });
}
