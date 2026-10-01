// What the member's role allows, for HIDING UI only (ARCHITECTURE §3): the daemon enforces every request no matter
// what the UI shows. Built on the one roles matrix of @smurg/protocol (`can`), never on role comparisons.
//
// Protocol v2 (owner decision 2026-10-01): there is no guest sandbox. The host and members with the role 「可使用 agent」
// (`agent`) open sessions (`session.create`) that run as the host — the host's computer, the host's Claude account —
// and may type into ANY session and decide its suggestions (`session.drive`). Editors suggest; viewers watch.
import { can, capabilitiesOf, type Capability, type Role, type SessionInfo } from '@smurg/protocol';

export type { Capability, Role };

/** Null (not admitted yet) and anything unknown are denied: fail closed. */
export function canRole(role: Role | null | undefined, capability: Capability): boolean {
  return role !== null && role !== undefined && can(role, capability);
}

export interface Capabilities {
  readonly role: Role | null;
  can(capability: Capability): boolean;
  /** Whether 「新增 session」 is offered (host and 可使用 agent). */
  readonly canCreateSession: boolean;
  /** Whether the member may type into any session and accept / reject its suggestions (host and 可使用 agent). */
  readonly canDrive: boolean;
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
      canCreateSession: canRole(role, 'session.create'),
      canDrive: canRole(role, 'session.drive'),
      isHost: role === 'host',
      all: role === null ? [] : capabilitiesOf(role),
    });
    cache.set(role, caps);
  }
  return caps;
}

/**
 * Whether this member types into `session` themselves (its terminal takes their keystrokes, its suggestions wait for
 * their decision): any running session for a role with `session.drive`. Everyone else watches; editors suggest.
 */
export function drivesSession(caps: Pick<Capabilities, 'canDrive'>, session: Pick<SessionInfo, 'status'>): boolean {
  return caps.canDrive && session.status !== 'exited';
}

/**
 * Whether handing `role` to someone needs the host's explicit confirmation of the risk first: a member with it runs
 * anything on the host's computer, with the host's Claude account (the console's role pickers ask).
 */
export function isRiskyRole(role: Role): boolean {
  return role !== 'host' && can(role, 'session.create');
}
