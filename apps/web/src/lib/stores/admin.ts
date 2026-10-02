// Host console data (SPEC R2, R11; ARCHITECTURE §5.8): members with their devices, invites, the audit log and the
// host settings. Loaded only while the member holds `admin` (the host); for everyone else it stays idle. Hiding the
// console is cosmetic: the daemon refuses admin.* from anyone else.
import {
  can,
  type AuditEntry,
  type GuestRole,
  type HostSettings,
  type HostSettingsPatch,
  type InviteInfo,
  type MemberWithDevices,
  type Role,
} from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, readyState, withGeneration, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface AdminState extends Loadable {
  /** False for everyone but the host: nothing below is loaded then. */
  readonly enabled: boolean;
  readonly members: readonly MemberWithDevices[];
  readonly invites: readonly InviteInfo[];
  readonly settings: HostSettings | null;
  /** Newest first. */
  readonly audit: readonly AuditEntry[];
  readonly auditHasMore: boolean;
  readonly auditLoadingOlder: boolean;
}

export interface CreatedInvite {
  readonly invite: InviteInfo;
  /** Contains the one-time secret: show it once, never log or persist it. */
  readonly url: string;
}

export interface AdminStore extends ReadableStore<AdminState> {
  reload(): Promise<void>;
  refreshMembers(): Promise<void>;
  createInvite(input: { role: GuestRole; expiresInSec?: number; maxUses?: number }): Promise<CreatedInvite>;
  revokeInvite(inviteId: string): Promise<void>;
  setRole(userId: string, role: GuestRole): Promise<void>;
  /** The member loses access within seconds; their sessions end and their device keys are revoked (R2). */
  kick(userId: string): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
  loadOlderAudit(): Promise<void>;
  setSettings(patch: HostSettingsPatch): Promise<HostSettings>;
}

export const AUDIT_PAGE_SIZE = 200;
export const AUDIT_MAX_ENTRIES = 2_000;
/** presence.state bursts (joins, leaves) are folded into one member refresh. */
export const MEMBER_REFRESH_DELAY_MS = 500;

export const INITIAL_ADMIN_STATE: AdminState = Object.freeze({
  status: 'idle',
  error: null,
  enabled: false,
  members: [],
  invites: [],
  settings: null,
  audit: [],
  auditHasMore: false,
  auditLoadingOlder: false,
});

export const selectActiveInvites = (state: AdminState, now: number): InviteInfo[] =>
  state.invites.filter((invite) => !invite.revoked && (invite.expiresAt === undefined || invite.expiresAt > now) && (invite.maxUses === undefined || invite.uses < invite.maxUses));

function mergeAudit(a: readonly AuditEntry[], b: readonly AuditEntry[]): AuditEntry[] {
  const byId = new Map<string, AuditEntry>();
  for (const entry of [...a, ...b]) byId.set(entry.id, entry);
  return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, AUDIT_MAX_ENTRIES);
}

export function createAdminArea(): { store: AdminStore; lifecycle: AreaLifecycle } {
  const state = createStore<AdminState>(INITIAL_ADMIN_STATE);
  let ctx: StoreContext | null = null;
  let memberTimer: unknown = null;
  let inviteTimer: unknown = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('admin store is not bound to a connection');
    return ctx;
  };
  const isAdmin = (role: Role | null): boolean => role !== null && can(role, 'admin');

  const refreshMembers = async (): Promise<void> => {
    const c = context();
    if (!isAdmin(c.role())) return;
    await withGeneration(
      c,
      () => c.conn.request('admin.member.list', {}),
      ({ members }) => state.setState((previous) => ({ ...previous, members })),
    );
  };

  const refreshInvites = async (): Promise<void> => {
    const c = context();
    await withGeneration(
      c,
      () => c.conn.request('admin.invite.list', {}),
      ({ invites }) => state.setState((previous) => ({ ...previous, invites })),
    );
  };

  const load = async (): Promise<void> => {
    const c = context();
    if (!isAdmin(c.role())) {
      state.setState(INITIAL_ADMIN_STATE);
      return;
    }
    await loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable, enabled: true })),
      () =>
        Promise.all([
          c.conn.request('admin.member.list', {}),
          c.conn.request('admin.invite.list', {}),
          c.conn.request('admin.settings.get', {}),
          c.conn.request('admin.audit.query', { limit: AUDIT_PAGE_SIZE }),
        ]),
      ([{ members }, { invites }, { settings }, { entries }]) =>
        state.setState((previous) => ({
          ...previous,
          ...readyState(),
          enabled: true,
          members,
          invites,
          settings,
          audit: mergeAudit(previous.audit, entries),
          auditHasMore: entries.length >= AUDIT_PAGE_SIZE,
        })),
    );
  };

  const scheduleMemberRefresh = (): void => {
    if (!ctx || !isAdmin(ctx.role()) || memberTimer !== null) return;
    memberTimer = ctx.scheduler.setTimeout(() => {
      memberTimer = null;
      refreshMembers().catch((error: unknown) => ctx?.reportError('admin', error));
    }, MEMBER_REFRESH_DELAY_MS);
  };

  /** An invite was used, created or revoked (the audit stream says so): re-list them, coalesced. */
  const scheduleInviteRefresh = (): void => {
    if (!ctx || !isAdmin(ctx.role()) || inviteTimer !== null) return;
    inviteTimer = ctx.scheduler.setTimeout(() => {
      inviteTimer = null;
      refreshInvites().catch((error: unknown) => ctx?.reportError('admin', error));
    }, MEMBER_REFRESH_DELAY_MS);
  };

  const store: AdminStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    refreshMembers,
    async createInvite(input) {
      const result = await context().conn.request('admin.invite.create', input);
      await refreshInvites().catch((error: unknown) => ctx?.reportError('admin', error));
      return { invite: result.invite, url: result.url };
    },
    async revokeInvite(inviteId) {
      await context().conn.request('admin.invite.revoke', { inviteId });
      await refreshInvites();
    },
    async setRole(userId, role) {
      const { member } = await context().conn.request('admin.member.setRole', { userId, role });
      state.setState((previous) => ({
        ...previous,
        members: previous.members.map((m) => (m.userId === member.userId ? { ...m, ...member } : m)),
      }));
    },
    async kick(userId) {
      await context().conn.request('admin.member.kick', { userId });
      await refreshMembers();
    },
    async terminateSession(sessionId) {
      await context().conn.request('admin.session.terminate', { sessionId });
    },
    async loadOlderAudit() {
      const c = context();
      const current = state.getState();
      const oldest = current.audit.at(-1);
      if (current.auditLoadingOlder || !current.auditHasMore || oldest === undefined) return;
      state.setState({ ...current, auditLoadingOlder: true });
      try {
        await withGeneration(
          c,
          () => c.conn.request('admin.audit.query', { limit: AUDIT_PAGE_SIZE, before: oldest.at }),
          ({ entries }) =>
            state.setState((previous) => ({
              ...previous,
              audit: mergeAudit(previous.audit, entries),
              auditHasMore: entries.length >= AUDIT_PAGE_SIZE && previous.audit.length + entries.length < AUDIT_MAX_ENTRIES,
            })),
        );
      } finally {
        state.setState((previous) => ({ ...previous, auditLoadingOlder: false }));
      }
    },
    async setSettings(patch) {
      const { settings } = await context().conn.request('admin.settings.set', patch);
      state.setState((previous) => ({ ...previous, settings }));
      return settings;
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offAudit = c.conn.on('admin.audit.entry', ({ entry }) => {
        if (!state.getState().enabled) return;
        state.setState((previous) => ({ ...previous, audit: mergeAudit([entry], previous.audit) }));
        // The invites table must not keep showing a used single-use link as "1 use left / active" until a reload.
        if (entry.action === 'auth.join' || entry.action.startsWith('invite.')) scheduleInviteRefresh();
      });
      // Joins, leaves, kicks and role changes all show up in presence: refresh the member list after them.
      const offPresence = c.conn.on('presence.state', () => scheduleMemberRefresh());
      return () => {
        offAudit();
        offPresence();
        if (memberTimer !== null) c.scheduler.clearTimeout(memberTimer);
        memberTimer = null;
        if (inviteTimer !== null) c.scheduler.clearTimeout(inviteTimer);
        inviteTimer = null;
      };
    },
    reset() {
      state.setState(INITIAL_ADMIN_STATE);
    },
    load,
    onRoleChange(role) {
      if (isAdmin(role)) {
        load().catch((error: unknown) => ctx?.reportError('admin', error));
      } else {
        state.setState(INITIAL_ADMIN_STATE);
      }
    },
  };
  return { store, lifecycle };
}
