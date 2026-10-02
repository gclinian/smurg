// Members and devices (SPEC R2, R3; ARCHITECTURE §3, §4). The in-memory copy of state.json is authoritative, so
// admit() can decide and record synchronously; persistence follows asynchronously (serialized atomic writes).
//
// Kick (R2): every device key of the member is revoked (SPEC R3: a revoked device key can no longer connect), their channels get
// channel.closed{kicked} and a relay peer.kick, and member.kicked is emitted. A kicked member can only come back
// through an invite created AFTER the kick, with a NEW device key: an old multi-use link cannot undo a kick.
import { createHash } from 'node:crypto';
import { SmurgError, isGuestRole, toHex, type DeviceInfo, type GuestRole, type Member, type MemberWithDevices } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AuditLog, ClientKind, DeviceRecord, EventBus, Hub, MemberDirectory, MemberRecord, PersistentDocument, Principal, UserId } from '../core/interfaces.ts';
import { toDisposable, type Clock, type Disposable } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { agentPrincipalFor, userPrincipal } from '../core/permissions.ts';
import type { WorkspaceState } from '../core/workspace-state.ts';

/** Presence colours: distinct, readable on light and dark backgrounds. */
/**
 * Member colours (presence cursors, avatars): 12 distinguishable hues, each with at least 3:1 contrast on white AND on
 * the dark editor background #1e1e1e (tested with the locks module's contrast helper in test/members.test.ts).
 */
export const MEMBER_COLORS: readonly string[] = Object.freeze(['#e6194b', '#2e8b3e', '#4363d8', '#d2691e', '#a03cc8', '#0f9d9a', '#f032e6', '#9a6324', '#4a6fa8', '#d45087', '#008080', '#b8860b']);

export function deviceIdOf(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, 16).toString('base64url');
}

export interface MemberDeps {
  readonly state: PersistentDocument<WorkspaceState>;
  readonly audit: AuditLog;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly hostUserId: UserId;
  readonly hostName: string;
}

export class MemberDirectoryImpl implements MemberDirectory {
  private readonly deps: MemberDeps;
  private hub: Hub | null = null;
  private readonly listeners = new Set<(userId: UserId) => void>();

  constructor(deps: MemberDeps) {
    this.deps = deps;
  }

  /** The hub exists after the directory (it asks the directory for roles). */
  setHub(hub: Hub): void {
    this.hub = hub;
  }

  /**
   * Makes the configured host the one and only `host`: creates their record, re-activates it, and demotes any other
   * record that claims the host role (a workspace hosted earlier by another account must not keep that power).
   */
  ensureHost(): void {
    const now = this.deps.clock.now();
    const state = this.deps.state.get();
    const needsChange =
      !state.members.some((m) => m.userId === this.deps.hostUserId && m.role === 'host' && m.status === 'active') ||
      state.members.some((m) => m.userId !== this.deps.hostUserId && m.role === 'host');
    if (!needsChange) return;
    this.deps.state.update((draft) => {
      for (const member of draft.members) {
        if (member.userId !== this.deps.hostUserId && member.role === 'host') {
          member.role = 'viewer';
          this.deps.log.warn('demoted a stale host record', {});
        }
      }
      const existing = draft.members.find((m) => m.userId === this.deps.hostUserId);
      if (existing) {
        existing.role = 'host';
        existing.status = 'active';
        delete existing.kickedAt;
      } else {
        draft.members.push({
          userId: this.deps.hostUserId,
          displayName: this.deps.hostName,
          role: 'host',
          color: this.pickColor(this.deps.hostUserId, draft.members),
          joinedAt: now,
          lastSeenAt: now,
          status: 'active',
        });
      }
    });
  }

  get(userId: UserId): MemberRecord | null {
    return this.deps.state.get().members.find((m) => m.userId === userId) ?? null;
  }

  active(userId: UserId): MemberRecord | null {
    const member = this.get(userId);
    return member && member.status === 'active' ? member : null;
  }

  list(options: { readonly includeKicked?: boolean } = {}): MemberRecord[] {
    return this.deps.state.get().members.filter((m) => options.includeKicked || m.status === 'active');
  }

  roleOf(userId: UserId): MemberRecord['role'] | null {
    return this.active(userId)?.role ?? null;
  }

  hostUserId(): UserId {
    return this.deps.hostUserId;
  }

  toMember(record: MemberRecord): Member {
    return {
      userId: record.userId,
      displayName: record.displayName,
      ...(record.avatarUrl === undefined ? {} : { avatarUrl: record.avatarUrl }),
      role: record.role,
      color: record.color,
      online: this.hub?.isOnline(record.userId) ?? false,
      joinedAt: record.joinedAt,
    };
  }

  toMemberWithDevices(record: MemberRecord): MemberWithDevices {
    const devices: DeviceInfo[] = this.devicesOf(record.userId)
      .slice(-100)
      .map((d) => ({ deviceId: d.deviceId, name: d.name, kind: d.kind, addedAt: d.addedAt, lastSeenAt: d.lastSeenAt, revoked: d.revoked }));
    return { ...this.toMember(record), devices };
  }

  principalOf(userId: UserId): Principal | null {
    const member = this.active(userId);
    return member ? userPrincipal(member) : null;
  }

  agentPrincipal(sessionId: string, ownerUserId: UserId): Principal | null {
    const owner = this.active(ownerUserId);
    return owner ? agentPrincipalFor(sessionId, owner) : null;
  }

  device(deviceId: string): DeviceRecord | null {
    return this.deps.state.get().devices.find((d) => d.deviceId === deviceId) ?? null;
  }

  deviceByKey(publicKey: Uint8Array): DeviceRecord | null {
    const hex = toHex(publicKey);
    return this.deps.state.get().devices.find((d) => d.publicKeyHex === hex) ?? null;
  }

  devicesOf(userId: UserId): DeviceRecord[] {
    return this.deps.state.get().devices.filter((d) => d.userId === userId);
  }

  setRole(userId: UserId, role: GuestRole, by: Principal): Member {
    if (by.kind !== 'system' && by.role !== 'host') throw new SmurgError('forbidden');
    const target = this.active(userId);
    if (!target) throw new SmurgError('not_found', msg('member.notFound'), { reason: 'unknown-member' });
    if (userId === this.deps.hostUserId || target.role === 'host') throw new SmurgError('bad_request', msg('member.hostRoleFixed'), { reason: 'host' });
    if (!isGuestRole(role)) throw new SmurgError('bad_request', undefined, { reason: 'role' });
    const from = target.role;
    if (from === role) return this.toMember(target);
    this.deps.state.update((draft) => {
      for (const member of draft.members) if (member.userId === userId) member.role = role;
    });
    this.deps.audit.record({ actor: by.actor, action: 'member.role', outcome: 'ok', target: userId, detail: { from, to: role } });
    // The new role applies to the very next message (the router reads it per message); closing the channels also
    // gives the client a fresh Welcome with the new role and ends any queued state built for the old one.
    this.hub?.closeUser(userId, 'role-changed');
    this.notify(userId);
    this.deps.bus.emit('member.role-changed', { userId, from, to: role, by: by.actor });
    return this.toMember(this.active(userId) as MemberRecord);
  }

  kick(userId: UserId, by: Principal): void {
    if (by.kind !== 'system' && by.role !== 'host') throw new SmurgError('forbidden');
    const target = this.active(userId);
    if (!target) throw new SmurgError('not_found', msg('member.notFound'), { reason: 'unknown-member' });
    if (userId === this.deps.hostUserId || target.role === 'host') throw new SmurgError('bad_request', msg('member.hostNotRemovable'), { reason: 'host' });
    const now = this.deps.clock.now();
    const revoked = this.devicesOf(userId).filter((d) => !d.revoked);
    this.deps.state.update((draft) => {
      for (const member of draft.members) {
        if (member.userId !== userId) continue;
        member.status = 'kicked';
        member.kickedAt = now;
      }
      for (const device of draft.devices) {
        if (device.userId !== userId || device.revoked) continue;
        device.revoked = true;
        device.revokedAt = now;
      }
    });
    this.deps.audit.record({ actor: by.actor, action: 'member.kick', outcome: 'ok', target: userId, detail: { devices: revoked.length } });
    for (const device of revoked) {
      this.deps.audit.record({ actor: by.actor, action: 'device.revoke', outcome: 'ok', target: device.deviceId, detail: { userId, reason: 'kick' } });
    }
    // Encrypted channel.closed{kicked} first, then the relay drops the sockets (order matters for the client).
    this.hub?.closeUser(userId, 'kicked');
    this.notify(userId);
    for (const device of revoked) {
      const updated = this.device(device.deviceId);
      if (updated) this.deps.bus.emit('device.revoked', { device: updated, by: by.actor });
    }
    this.deps.bus.emit('member.kicked', { userId, by: by.actor, revokedDevices: revoked.map((d) => d.deviceId) });
  }

  onChange(listener: (userId: UserId) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  admitMember(input: {
    readonly userId: UserId;
    readonly displayName: string;
    readonly avatarUrl?: string;
    readonly role: MemberRecord['role'];
    readonly at: number;
  }): { readonly member: MemberRecord; readonly joined: boolean } {
    const existing = this.get(input.userId);
    if (existing && existing.status === 'active') {
      if (existing.displayName !== input.displayName || existing.avatarUrl !== input.avatarUrl) {
        this.deps.state.update((draft) => {
          for (const member of draft.members) {
            if (member.userId !== input.userId) continue;
            member.displayName = input.displayName;
            if (input.avatarUrl === undefined) delete member.avatarUrl;
            else member.avatarUrl = input.avatarUrl;
          }
        });
        this.notify(input.userId);
      }
      return { member: this.get(input.userId) as MemberRecord, joined: false };
    }
    this.deps.state.update((draft) => {
      draft.members = draft.members.filter((m) => m.userId !== input.userId);
      draft.members.push({
        userId: input.userId,
        displayName: input.displayName,
        ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
        role: input.role,
        color: existing?.color ?? this.pickColor(input.userId, draft.members),
        joinedAt: input.at,
        lastSeenAt: input.at,
        status: 'active',
      });
    });
    this.notify(input.userId);
    return { member: this.get(input.userId) as MemberRecord, joined: true };
  }

  addDevice(input: {
    readonly userId: UserId;
    readonly publicKey: Uint8Array;
    readonly name: string;
    readonly kind: ClientKind;
    readonly inviteId: string;
    readonly at: number;
  }): DeviceRecord {
    const existing = this.deviceByKey(input.publicKey);
    if (existing) {
      if (existing.userId !== input.userId || existing.revoked) throw new SmurgError('conflict', undefined, { reason: 'device-bound' });
      this.touch(input.userId, existing.deviceId, input.at);
      return this.device(existing.deviceId) as DeviceRecord;
    }
    const record: DeviceRecord = {
      deviceId: deviceIdOf(input.publicKey),
      userId: input.userId,
      publicKeyHex: toHex(input.publicKey),
      name: input.name,
      kind: input.kind,
      addedAt: input.at,
      lastSeenAt: input.at,
      revoked: false,
      inviteId: input.inviteId,
    };
    this.deps.state.update((draft) => {
      draft.devices.push({ ...record });
    });
    this.notify(input.userId);
    return record;
  }

  touch(userId: UserId, deviceId: string, at: number): void {
    this.deps.state.update((draft) => {
      for (const member of draft.members) if (member.userId === userId) member.lastSeenAt = Math.max(member.lastSeenAt, at);
      for (const device of draft.devices) if (device.deviceId === deviceId) device.lastSeenAt = Math.max(device.lastSeenAt, at);
    });
  }

  private notify(userId: UserId): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(userId);
      } catch (err) {
        this.deps.log.error('member listener failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  private pickColor(userId: UserId, members: readonly { readonly color: string; readonly userId: string }[]): string {
    const used = new Set(members.filter((m) => m.userId !== userId).map((m) => m.color));
    const start = createHash('sha256').update(userId).digest()[0] as number;
    for (let i = 0; i < MEMBER_COLORS.length; i++) {
      const color = MEMBER_COLORS[(start + i) % MEMBER_COLORS.length] as string;
      if (!used.has(color)) return color;
    }
    return MEMBER_COLORS[start % MEMBER_COLORS.length] as string;
  }
}
