import { z } from 'zod';

// Roles and capabilities (ARCHITECTURE §3, which encodes the table in SPEC §8).
//
// This is the only place the matrix exists. The daemon enforces it (Router → can()); the web app uses it only to hide
// UI. Roles are deliberately NOT ranked: SPEC §8 is not monotone (the host cannot open a sandboxed session, which a
// runner can), so "role >= editor" style comparisons would grant things the table does not. Always ask can().

/**
 * Workspace roles in the column order of SPEC §8: 主人, 可執行 agent, 可編輯, 旁觀.
 * The order is for display only; never derive permissions from it.
 */
export const ROLES = ['host', 'runner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles a host can hand out through invites and `admin.member.setRole` (`Exclude<Role, 'host'>`). */
export const GUEST_ROLES = ['runner', 'editor', 'viewer'] as const;
export type GuestRole = (typeof GUEST_ROLES)[number];

export const roleSchema = z.enum(ROLES);
export const guestRoleSchema = z.enum(GUEST_ROLES);

/** SPEC §8 column headings, for UI labels (zh-TW). */
export const ROLE_LABELS_ZH_TW: Readonly<Record<Role, string>> = Object.freeze({
  host: '主人',
  runner: '可執行 agent',
  editor: '可編輯',
  viewer: '旁觀',
});

export const CAPABILITIES = [
  'file.read', // browse tree, open docs, view sessions
  'file.download',
  'file.write', // edit, create, rename, delete, upload
  'session.view',
  'session.create.sandboxed', // own agent session / terminal, inside srt
  'session.create.host', // unsandboxed host session
  'suggest.create',
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
  'file.read': { host: true, runner: true, editor: true, viewer: true },
  'file.download': { host: true, runner: true, editor: true, viewer: true },
  'session.view': { host: true, runner: true, editor: true, viewer: true },
  'file.write': { host: true, runner: true, editor: true, viewer: false },
  'suggest.create': { host: true, runner: true, editor: true, viewer: false },
  'session.create.sandboxed': { host: false, runner: true, editor: false, viewer: false },
  'session.create.host': { host: true, runner: false, editor: false, viewer: false },
  'worktree.merge.request': { host: true, runner: true, editor: false, viewer: false },
  'worktree.merge.decide': { host: true, runner: false, editor: false, viewer: false },
  'lock.force-release': { host: true, runner: false, editor: false, viewer: false },
  admin: { host: true, runner: false, editor: false, viewer: false },
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

/**
 * The capability that `session.create` needs for this role, which also decides whether the session is sandboxed:
 * host → `session.create.host` (unsandboxed, D3), runner → `session.create.sandboxed`. A client never chooses
 * `sandboxed` (ARCHITECTURE §5.5). `null` means the role may not create sessions at all.
 */
export function sessionCreateCapability(role: Role): 'session.create.host' | 'session.create.sandboxed' | null {
  if (can(role, 'session.create.host')) return 'session.create.host';
  if (can(role, 'session.create.sandboxed')) return 'session.create.sandboxed';
  return null;
}
