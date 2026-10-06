// Principals and the few permission facts that are not capabilities. The capability table itself lives in
// @smurg/protocol (roles.ts: can(), registry: mayInvoke / mayReceive) and is enforced by the Router; this file only
// builds principals and answers "is this the host" style questions, always failing closed.
import { agentDisplayName, can, type Actor, type Capability, type Role } from '@smurg/protocol';
import type { MemberRecord, Principal, UserId } from './interfaces.ts';

export const SYSTEM_ACTOR: Actor = Object.freeze({ kind: 'system' });

export const SYSTEM_PRINCIPAL: Principal = Object.freeze({ kind: 'system', actor: SYSTEM_ACTOR, userId: null, role: null });

export function userActor(member: Pick<MemberRecord, 'userId' | 'displayName'>): Actor {
  return { kind: 'user', userId: member.userId, displayName: member.displayName };
}

/** Principal of an active member; a kicked member has no principal (null). */
export function userPrincipal(member: MemberRecord): Principal | null {
  if (member.status !== 'active') return null;
  return Object.freeze({ kind: 'user', actor: userActor(member), userId: member.userId, role: member.role });
}

// `Claude (<label>)`: how an agent appears in presence, locks, the activity feed and the audit log. The one function
// that spells it lives in @smurg/protocol (names.ts); it is re-exported here for the daemon's modules.
export { agentDisplayName };

/**
 * The principal of an agent session whose daemon-internal owner is `owner`. `pathRights` is the session's (fixed at its
 * creation, never raised by a handover): with `'member'` the role is never `host`, whoever owns the session now, so a
 * session a member opened cannot write host-only paths after it passed to the host. `agentName`: the session's agent
 * name (`Claude (<label>)`); default: named after the owner.
 */
export function agentPrincipalFor(sessionId: string, owner: MemberRecord, options: { readonly agentName?: string; readonly pathRights: 'member' | 'host' }): Principal | null {
  if (owner.status !== 'active') return null;
  return Object.freeze({
    kind: 'agent',
    actor: { kind: 'agent' as const, sessionId, ownerUserId: owner.userId, displayName: options.agentName ?? agentDisplayName(owner.displayName) },
    userId: owner.userId,
    role: options.pathRights === 'member' && owner.role === 'host' ? 'agent' : owner.role,
  });
}

/** The host (and only the host) may write host-only paths and see <share>/.smurg. */
export function isHostPrincipal(principal: Principal): boolean {
  return principal.role === 'host' && principal.userId !== null;
}

/** Capability check for a principal (system principals act for the daemon itself and pass). */
export function principalCan(principal: Principal, capability: Capability): boolean {
  if (principal.kind === 'system') return true;
  return principal.role !== null && can(principal.role as Role, capability);
}

export function principalUserId(principal: Principal): UserId | null {
  return principal.userId;
}
