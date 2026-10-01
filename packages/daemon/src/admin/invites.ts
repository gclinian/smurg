// Invites (SPEC R2, R3; ARCHITECTURE §4.1). The daemon stores { inviteId, psk, role, expiry, uses } — never the
// secret `s`: the URL (which contains `s` in its fragment) exists only in the return value of create() and is shown
// to the host once. It is never logged or audited.
//
// Consumption is part of admit(): synchronous check-and-consume after msg3 authenticated (noise.md V1/V8). An invite
// is used up at maxUses, dead after expiresAt, and refused when revoked; all three stay on file so a client gets a
// precise, encrypted verdict instead of the generic ABORT.
import {
  SmurgError,
  buildInviteUrl,
  deriveInviteKeys,
  fromHex,
  generateInviteSecret,
  toHex,
  type DaemonInviteKey,
  type GuestRole,
  type InviteInfo,
  type Role,
} from '@smurg/protocol';
import type { AuditLog, InviteRecord, InviteService, PersistentDocument, Principal, UserId } from '../core/interfaces.ts';
import { newId, type Clock } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import type { WorkspaceState } from '../core/workspace-state.ts';

/** Invites without an explicit expiry expire after this (a standing credential is the wrong default). */
export const DEFAULT_INVITE_TTL_SEC = 7 * 24 * 3600;
/** Dead invites are kept this long (precise verdicts), then pruned at start. */
const DEAD_INVITE_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface InviteDeps {
  readonly state: PersistentDocument<WorkspaceState>;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly workspaceId: string;
  readonly webOrigin: string;
  readonly hostUserId: UserId;
  readonly daemonPublicKey: Uint8Array;
}

export function inviteInfoOf(record: InviteRecord): InviteInfo {
  return {
    id: record.id,
    role: record.role,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.maxUses === undefined ? {} : { maxUses: record.maxUses }),
    uses: record.uses,
    revoked: record.revoked,
  };
}

export class InviteServiceImpl implements InviteService {
  private readonly deps: InviteDeps;
  private keyCache: { readonly source: readonly InviteRecord[]; readonly keys: DaemonInviteKey[] } | null = null;

  constructor(deps: InviteDeps) {
    this.deps = deps;
  }

  /** Removes invites that have been unusable for a long time. */
  prune(): void {
    const now = this.deps.clock.now();
    const dead = (record: InviteRecord): boolean => {
      const deadSince = record.revoked ? record.createdAt : record.expiresAt !== undefined && record.expiresAt <= now ? record.expiresAt : null;
      return deadSince !== null && now - deadSince > DEAD_INVITE_RETENTION_MS;
    };
    if (!this.records().some(dead)) return;
    this.deps.state.update((draft) => {
      draft.invites = draft.invites.filter((record) => !dead(record));
    });
  }

  create(input: { readonly role: GuestRole; readonly expiresInSec?: number; readonly maxUses?: number }, by: Principal): { readonly invite: InviteInfo; readonly url: string } {
    if (by.kind !== 'system' && by.role !== 'host') throw new SmurgError('forbidden');
    if (!['runner', 'editor', 'viewer'].includes(input.role)) throw new SmurgError('bad_request', undefined, { reason: 'role' });
    const expiresInSec = input.expiresInSec ?? DEFAULT_INVITE_TTL_SEC;
    const now = this.deps.clock.now();
    const { record, url } = this.mint({
      role: input.role,
      createdAt: now,
      expiresAt: now + expiresInSec * 1000,
      ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
      createdBy: by.userId,
      host: false,
    });
    this.deps.audit.record({
      actor: by.actor,
      action: 'invite.create',
      outcome: 'ok',
      target: record.id,
      detail: { role: record.role, expiresAt: record.expiresAt ?? null, maxUses: record.maxUses ?? null },
    });
    return { invite: inviteInfoOf(record), url };
  }

  createHostInvite(): { readonly invite: InviteInfo; readonly url: string } {
    const now = this.deps.clock.now();
    // Only the newest host link is valid: an old one printed in a scrollback cannot be used later.
    if (this.records().some((record) => record.host && !record.revoked && record.uses === 0)) {
      this.deps.state.update((draft) => {
        for (const record of draft.invites) if (record.host && !record.revoked && record.uses === 0) record.revoked = true;
      });
    }
    const { record, url } = this.mint({
      role: 'host',
      createdAt: now,
      boundUserId: this.deps.hostUserId,
      expiresAt: now + DEFAULT_INVITE_TTL_SEC * 1000,
      maxUses: 1,
      createdBy: null,
      host: true,
    });
    this.deps.audit.record({ actor: SYSTEM_ACTOR, action: 'invite.create', outcome: 'ok', target: record.id, detail: { role: 'host', host: true } });
    return { invite: inviteInfoOf(record), url };
  }

  list(): InviteInfo[] {
    return this.records().map(inviteInfoOf);
  }

  revoke(inviteId: string, by: Principal): void {
    if (by.kind !== 'system' && by.role !== 'host') throw new SmurgError('forbidden');
    const record = this.get(inviteId);
    if (!record) throw new SmurgError('not_found');
    if (!record.revoked) {
      this.deps.state.update((draft) => {
        for (const item of draft.invites) if (item.id === inviteId) item.revoked = true;
      });
    }
    this.deps.audit.record({ actor: by.actor, action: 'invite.revoke', outcome: 'ok', target: inviteId, detail: { role: record.role } });
  }

  get(inviteId: string): InviteRecord | null {
    return this.records().find((record) => record.id === inviteId) ?? null;
  }

  byKeyId(keyId: Uint8Array): InviteRecord | null {
    const hex = toHex(keyId);
    return this.records().find((record) => record.keyIdHex === hex) ?? null;
  }

  handshakeKeys(): DaemonInviteKey[] {
    const source = this.records();
    if (this.keyCache?.source !== source) {
      this.keyCache = { source, keys: source.map((record) => ({ inviteId: fromHex(record.keyIdHex), psk: fromHex(record.pskHex) })) };
    }
    return this.keyCache.keys;
  }

  unusableReason(record: InviteRecord, now: number): 'revoked' | 'expired' | 'used-up' | null {
    if (record.revoked) return 'revoked';
    if (record.expiresAt !== undefined && now >= record.expiresAt) return 'expired';
    if (record.maxUses !== undefined && record.uses >= record.maxUses) return 'used-up';
    return null;
  }

  consume(inviteId: string, now: number): InviteRecord {
    const record = this.get(inviteId);
    if (!record) throw new SmurgError('not_found');
    const reason = this.unusableReason(record, now);
    if (reason !== null) throw new SmurgError('conflict', undefined, { reason });
    const next = this.deps.state.update((draft) => {
      for (const item of draft.invites) if (item.id === inviteId) item.uses += 1;
    });
    return next.invites.find((item) => item.id === inviteId) as InviteRecord;
  }

  private records(): readonly InviteRecord[] {
    return this.deps.state.get().invites;
  }

  private mint(input: {
    readonly role: Role;
    /** One clock reading for createdAt and expiresAt: the lifetime is exactly what was asked for. */
    readonly createdAt: number;
    readonly boundUserId?: UserId;
    readonly expiresAt?: number;
    readonly maxUses?: number;
    readonly createdBy: UserId | null;
    readonly host: boolean;
  }): { readonly record: InviteRecord; readonly url: string } {
    const secret = generateInviteSecret();
    const { inviteId, psk } = deriveInviteKeys(secret);
    const record: InviteRecord = {
      // Unrelated to the Noise invite id: knowing that id lets anyone forge a msg1 that passes the pre-DH filter.
      id: newId('inv'),
      keyIdHex: toHex(inviteId),
      pskHex: toHex(psk),
      role: input.role,
      ...(input.boundUserId === undefined ? {} : { boundUserId: input.boundUserId }),
      createdAt: input.createdAt,
      createdBy: input.createdBy,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
      uses: 0,
      revoked: false,
      host: input.host,
    };
    this.deps.state.update((draft) => {
      draft.invites.push({ ...record });
    });
    const url = buildInviteUrl(this.deps.webOrigin, this.deps.workspaceId, this.deps.daemonPublicKey, secret);
    secret.fill(0);
    return { record, url };
  }
}
