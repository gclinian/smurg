// What the member's role allows, for HIDING UI only (ARCHITECTURE §3): the daemon enforces every request no matter
// what the UI shows. Built on the one roles matrix of @smurg/protocol (`can`), never on role comparisons: SPEC §8 is
// not monotone (the host cannot open a sandboxed session, a runner can).
import { can, capabilitiesOf, sessionCreateCapability, type Capability, type Role } from '@smurg/protocol';

export type { Capability, Role };

/** Null (not admitted yet) and anything unknown are denied: fail closed. */
export function canRole(role: Role | null | undefined, capability: Capability): boolean {
  return role !== null && role !== undefined && can(role, capability);
}

export interface Capabilities {
  readonly role: Role | null;
  can(capability: Capability): boolean;
  /** Which session a 「新增 session」 button creates: unsandboxed host session, sandboxed runner session, or none. */
  readonly sessionCreate: 'session.create.host' | 'session.create.sandboxed' | null;
  readonly isHost: boolean;
  /** Every capability the role has, in the protocol's order. */
  readonly all: readonly Capability[];
}

const cache = new Map<Role | null, Capabilities>();

export function capabilitiesForRole(role: Role | null): Capabilities {
  let caps = cache.get(role);
  if (!caps) {
    caps = Object.freeze({
      role,
      can: (capability: Capability) => canRole(role, capability),
      sessionCreate: role === null ? null : sessionCreateCapability(role),
      isHost: role === 'host',
      all: role === null ? [] : capabilitiesOf(role),
    });
    cache.set(role, caps);
  }
  return caps;
}
