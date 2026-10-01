// Handlers of every admin.* request (all require `admin`, checked by the router) and channel.leave, plus the live
// audit feed (admin.audit.entry to host connections only) and the per-user teardown that kick, leave and demotion
// share (the sessions the member opened killed, uploads aborted: R2's 3 s / R4's 5 s).
import { SmurgError, can, type Role } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { Router, UserId } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';

/** How long kick / leave wait for sessions before answering (R2: 3 s for the whole kick). */
const TEARDOWN_TIMEOUT_MS = 2_500;

async function withTimeout(label: string, ctx: DaemonContext, work: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TEARDOWN_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([work().then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') ctx.log.warn('user teardown step timed out', { step: label });
  } catch (err) {
    ctx.log.error('user teardown step failed', { step: label, error: err instanceof Error ? err.name : 'unknown' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ends everything a member runs on the host: the sessions they opened (killTree; they run as the host's OS user,
 * §11 D-15), their uploads. Stub services (features not built yet) are skipped.
 */
export async function teardownUser(ctx: DaemonContext, userId: UserId, reason: 'kicked' | 'left' | 'role-changed'): Promise<void> {
  const steps: Promise<void>[] = [];
  const sessions = ctx.services.sessions;
  if (!isStubService(sessions)) steps.push(withTimeout('sessions', ctx, () => sessions.killAllForUser(userId, reason)));
  const uploads = ctx.services.uploads;
  if (!isStubService(uploads) && reason !== 'role-changed') steps.push(withTimeout('uploads', ctx, () => uploads.abortAllForUser(userId)));
  await Promise.all(steps);
}

/** Whether `role` may open sessions (the host, 「可使用 agent」): a member set below it loses the sessions they opened. */
function mayOwnSessions(role: Role): boolean {
  return can(role, 'session.create');
}

/**
 * Writes the state after an admin change that is already in force in memory (kick, role, invite revoke: all fail
 * closed while the daemon runs). When the disk refuses the write, the change is NOT undone; the store keeps re-writing
 * it, and the host is told exactly that instead of a bare `internal` (review REL-14).
 */
async function persistApplied(ctx: DaemonContext, what: string): Promise<SmurgError | null> {
  try {
    await ctx.state.flush();
    return null;
  } catch (err) {
    ctx.log.error('admin change applied but not saved', { change: what, error: err instanceof Error ? err.name : 'unknown' });
    return new SmurgError(
      'internal',
      `${what}已生效，但無法寫入狀態檔（磁碟已滿或沒有寫入權限？）。smurg 會持續重試；在寫入成功前停止 smurg，重新啟動後這個變更會消失。`,
      { reason: 'state-not-saved', applied: true },
    );
  }
}

export function registerAdminHandlers(router: Router, ctx: DaemonContext): Disposable {
  const stack = new DisposableStack();

  // Teardown is driven by the events, so a kick / leave / demotion from ANY path (handlers, the local control
  // socket, tests) ends the member's sessions; the handlers then await the same promise before answering.
  const teardowns = new Map<UserId, Promise<void>>();
  const startTeardown = (userId: UserId, reason: 'kicked' | 'left' | 'role-changed'): void => {
    const previous = teardowns.get(userId) ?? Promise.resolve();
    const next = previous.then(() => teardownUser(ctx, userId, reason));
    teardowns.set(userId, next);
    void next.finally(() => {
      if (teardowns.get(userId) === next) teardowns.delete(userId);
    });
  };
  const awaitTeardown = async (userId: UserId): Promise<void> => {
    await teardowns.get(userId);
  };
  stack.add(ctx.bus.on('member.kicked', (event) => startTeardown(event.userId, 'kicked')));
  stack.add(ctx.bus.on('member.left', (event) => startTeardown(event.userId, 'left')));
  stack.add(
    ctx.bus.on('member.role-changed', (event) => {
      if (mayOwnSessions(event.from) && !mayOwnSessions(event.to)) startTeardown(event.userId, 'role-changed');
    }),
  );

  stack.add(
    router.handle('admin.invite.create', async (payload, req) => {
      const created = ctx.invites.create(payload, req.principal);
      // On disk before the host can hand the link out: a crash must not leave a link the daemon forgot.
      try {
        await ctx.state.flush();
      } catch (err) {
        // The link is never shown, so nobody holds its secret: retire it rather than list a live invite no one has.
        ctx.invites.revoke(created.invite.id, SYSTEM_PRINCIPAL);
        ctx.log.error('invite not saved; not handed out', { error: err instanceof Error ? err.name : 'unknown' });
        throw new SmurgError('internal', '無法寫入狀態檔（磁碟已滿或沒有寫入權限？），邀請連結沒有建立。', { reason: 'state-not-saved', applied: false });
      }
      return created;
    }),
  );
  stack.add(router.handle('admin.invite.list', () => ({ invites: ctx.invites.list() })));
  stack.add(
    router.handle('admin.invite.revoke', async (payload, req) => {
      ctx.invites.revoke(payload.inviteId, req.principal);
      const unsaved = await persistApplied(ctx, '撤銷邀請');
      if (unsaved) throw unsaved;
      return {};
    }),
  );

  stack.add(router.handle('admin.member.list', () => ({ members: ctx.members.list().map((m) => ctx.members.toMemberWithDevices(m)) })));
  stack.add(
    router.handle('admin.member.setRole', async (payload, req) => {
      const member = ctx.members.setRole(payload.userId, payload.role, req.principal);
      const unsaved = await persistApplied(ctx, '角色變更');
      await awaitTeardown(payload.userId);
      if (unsaved) throw unsaved;
      return { member };
    }),
  );
  stack.add(
    router.handle('admin.member.kick', async (payload, req) => {
      ctx.members.kick(payload.userId, req.principal);
      const unsaved = await persistApplied(ctx, '踢出成員');
      await awaitTeardown(payload.userId);
      if (unsaved) throw unsaved;
      return {};
    }),
  );

  stack.add(
    router.handle('admin.session.terminate', async (payload, req) => {
      await ctx.services.sessions.terminate(payload.sessionId, req.principal);
      return {};
    }),
  );

  stack.add(router.handle('admin.audit.query', async (payload) => ({ entries: await ctx.audit.query(payload) })));
  stack.add(router.handle('admin.settings.get', () => ({ settings: ctx.settings.get() })));
  stack.add(router.handle('admin.settings.set', async (payload, req) => ({ settings: await ctx.settings.update(payload, req.principal) })));

  stack.add(
    router.handle('channel.leave', async (_payload, req) => {
      // The host stops sharing with `smurg stop`; leaving is for guests (R4 「客人離開」).
      if (req.role === 'host') return {};
      ctx.audit.record({ actor: req.principal.actor, action: 'member.leave', outcome: 'ok', target: req.userId });
      ctx.bus.emit('member.left', { userId: req.userId, by: req.principal.actor });
      await awaitTeardown(req.userId);
      return {};
    }),
  );

  // Every member works with the PublicSettings (lock timeouts, upload chunk size, shared dirs): push changes to all
  // connected (and resumable) channels instead of leaving them stale until a reconnect.
  stack.add(ctx.bus.on('settings.changed', () => ctx.hub.broadcast('channel.settingsUpdated', { settings: ctx.settings.public() })));
  // Live audit feed for the host console; the hub's registry check keeps it to members holding `admin`.
  stack.add(ctx.audit.subscribe((entry) => ctx.hub.broadcast('admin.audit.entry', { entry }, { capability: 'admin' })));
  // A member's own record changed without a channel close (e.g. a new display name from the relay): tell them.
  // Role changes close the channels instead, so the logical channels this would reach are already gone.
  stack.add(
    ctx.members.onChange((userId) => {
      const member = ctx.members.active(userId);
      if (member) ctx.hub.sendToUser(userId, 'channel.memberUpdated', { member: ctx.members.toMember(member) });
    }),
  );
  return stack;
}
