import { z } from 'zod';

// Roles and capabilities (ARCHITECTURE §3, which encodes the table in SPEC §8 as changed on 2026-10-01, §11 D-15: no
// guest sandbox; the role "Agent access" (`agent`)). Labels: `roleLabel(locale, role)` in `@smurg/protocol/i18n`.
//
// This is the only place the matrix exists. The daemon enforces it (Router → can()); the web app uses it only to hide
// UI. Roles are deliberately NOT ranked: never write "role >= editor" style comparisons, always ask can().

/**
 * Workspace roles in the column order of SPEC §8: Host, Agent access, Editor, Viewer.
 * The order is for display only; never derive permissions from it.
 * `agent` ("Agent access", ARCHITECTURE §11 D-15): opens agent and terminal sessions that run exactly like the host's
 * own (the host's OS user, unsandboxed, the host's Claude Code login) and types into any session. It is NOT an Actor of
 * kind 'agent' (a Claude Code session); the two are different types.
 */
export const ROLES = ['host', 'agent', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles a host can hand out through invites and `admin.member.setRole` (`Exclude<Role, 'host'>`). */
export const GUEST_ROLES = ['agent', 'editor', 'viewer'] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];

export const roleSchema = z.enum(ROLES);
export const guestRoleSchema = z.enum(GUEST_ROLES);

export const CAPABILITIES = [
  'file.read', // browse tree, open docs, view sessions
  'file.download',
  'file.write', // edit, create, rename, delete, upload
  'session.view',
  // Open agent / terminal sessions (the host's OS user, unsandboxed, the host's Claude login: D-15). Also: create a
  // topic, restart its discussion, start work items, archive a topic (each opens or ends agent sessions).
  'session.create',
  // Type into a terminal; send a message to an agent, stop its turn, answer its permission requests, accept or reject
  // suggestions, change who is responsible, the permission mode, always-allowed kinds, ask for the plan (D-15).
  'session.drive',
  'suggest.create',
  'discuss', // vote, comment, mention, be responsible, review a result report
  'worktree.merge.request',
  'worktree.merge.decide',
  'lock.force-release',
  'admin', // invites, roles, kick, audit, terminate any session, settings
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const capabilitySchema = z.enum(CAPABILITIES);

type Matrix = { readonly [C in Capability]: { readonly [R in Role]: boolean } };

// Written out cell by cell (not derived) so a reviewer can hold it next to ARCHITECTURE §3 and SPEC §8;
// roles.test.ts checks every cell against a transcription of the SPEC table.
const MATRIX: Matrix = {
  'file.read': { host: true, agent: true, editor: true, viewer: true },
  'file.download': { host: true, agent: true, editor: true, viewer: true },
  'session.view': { host: true, agent: true, editor: true, viewer: true },
  'file.write': { host: true, agent: true, editor: true, viewer: false },
  'suggest.create': { host: true, agent: true, editor: true, viewer: false },
  discuss: { host: true, agent: true, editor: true, viewer: false },
  'session.create': { host: true, agent: true, editor: false, viewer: false },
  'session.drive': { host: true, agent: true, editor: false, viewer: false },
  'worktree.merge.request': { host: true, agent: true, editor: false, viewer: false },
  'worktree.merge.decide': { host: true, agent: false, editor: false, viewer: false },
  'lock.force-release': { host: true, agent: false, editor: false, viewer: false },
  admin: { host: true, agent: false, editor: false, viewer: false },
};

for (const row of Object.values(MATRIX)) Object.freeze(row);
/** The capability matrix, frozen. Prefer can(); this is exported for tests and for rendering a permissions table. */
export const CAPABILITY_MATRIX: Matrix = Object.freeze(MATRIX);

/**
 * Whether `role` has `capability`. Anything that is not a known role or capability (a corrupted state file, a value
 * that skipped validation) is denied instead of throwing: fail closed.
 */
export function can(role: Role, capability: Capability): boolean {
  if (!Object.hasOwn(CAPABILITY_MATRIX, capability)) return false;
  const row = CAPABILITY_MATRIX[capability];
  return Object.hasOwn(row, role) && row[role] === true;
}

/** Every capability `role` has, in CAPABILITIES order. */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return CAPABILITIES.filter((capability) => can(role, capability));
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isGuestRole(value: unknown): value is GuestRole {
  return typeof value === 'string' && (GUEST_ROLES as readonly string[]).includes(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}
