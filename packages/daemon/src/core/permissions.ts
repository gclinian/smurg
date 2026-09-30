// Principals and the few permission facts that are not capabilities. The capability table itself lives in
// @smurg/protocol (roles.ts: can(), registry: mayInvoke / mayReceive) and is enforced by the Router; this file only
// builds principals and answers "is this the host" style questions, always failing closed.
import { can, type Actor, type Capability, type Role } from '@smurg/protocol';
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

/** 「Claude（<owner>）」: how an agent appears in presence, locks, the activity feed and the audit log. */
export function agentDisplayName(ownerDisplayName: string): string {
  return `Claude（${ownerDisplayName}）`;
}

export function agentPrincipalFor(sessionId: string, owner: MemberRecord): Principal | null {
  if (owner.status !== 'active') return null;
  return Object.freeze({
    kind: 'agent',
    actor: { kind: 'agent' as const, sessionId, ownerUserId: owner.userId, displayName: agentDisplayName(owner.displayName) },
    userId: owner.userId,
    role: owner.role,
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
