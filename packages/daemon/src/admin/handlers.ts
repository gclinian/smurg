// Handlers of every admin.* request (all require `admin`, checked by the router) and channel.leave, plus the live
// audit feed (admin.audit.entry to host connections only) and the per-user teardown that kick, leave and demotion
// share (admin/teardown.ts: what the member put in place goes, the sessions they opened end or pass to the host,
// uploads aborted: R2's 3 s / R4's 5 s). The handlers of protocol 4 (Claude Code's project settings, the host's own
// rules, redaction) delegate to ProjectTrust, HostRules and AgentSessions.
import { SmurgError, type Role } from '@smurg/protocol';
import { msg, type AdminChange } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { MemberChange, Router, UserId } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { roleChangeLoses, teardownMember } from './teardown.ts';

/**
 * Writes the state after an admin change that is already in force in memory (kick, role, invite revoke: all fail
 * closed while the daemon runs). When the disk refuses the write, the change is NOT undone; the store keeps re-writing
 * it, and the host is told exactly that instead of a bare `internal`.
 */
async function persistApplied(ctx: DaemonContext, change: AdminChange): Promise<SmurgError | null> {
  try {
    await ctx.state.flush();
    return null;
  } catch (err) {
    ctx.log.error('admin change applied but not saved', { change, error: err instanceof Error ? err.name : 'unknown' });
    return new SmurgError('internal', msg('admin.appliedNotSaved', { change }), { reason: 'state-not-saved', applied: true });
  }
}

export function registerAdminHandlers(router: Router, ctx: DaemonContext): Disposable {
  const stack = new DisposableStack();

  // Teardown is driven by the events, so a kick / leave / demotion from ANY path (handlers, the local control
  // socket, tests) ends the member's sessions; the handlers then await the same promise before answering.
  const teardowns = new Map<UserId, Promise<void>>();
  const startTeardown = (userId: UserId, change: MemberChange, to?: Role): void => {
    const previous = teardowns.get(userId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await teardownMember(ctx, userId, change, to);
    });
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
      // A promotion takes nothing away; a demotion that loses session.create, session.drive or discuss does.
      if (roleChangeLoses(event.from, event.to)) startTeardown(event.userId, 'role-changed', event.to);
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
        throw new SmurgError('internal', msg('admin.inviteNotSaved'), { reason: 'state-not-saved', applied: false });
      }
      return created;
    }),
  );
  stack.add(router.handle('admin.invite.list', () => ({ invites: ctx.invites.list() })));
  stack.add(
    router.handle('admin.invite.revoke', async (payload, req) => {
      ctx.invites.revoke(payload.inviteId, req.principal);
      const unsaved = await persistApplied(ctx, 'invite-revoke');
      if (unsaved) throw unsaved;
      return {};
    }),
  );

  stack.add(router.handle('admin.member.list', () => ({ members: ctx.members.list().map((m) => ctx.members.toMemberWithDevices(m)) })));
  stack.add(
    router.handle('admin.member.setRole', async (payload, req) => {
      const member = ctx.members.setRole(payload.userId, payload.role, req.principal);
      const unsaved = await persistApplied(ctx, 'role-change');
      await awaitTeardown(payload.userId);
      if (unsaved) throw unsaved;
      return { member };
    }),
  );
  stack.add(
    router.handle('admin.member.kick', async (payload, req) => {
      ctx.members.kick(payload.userId, req.principal);
      const unsaved = await persistApplied(ctx, 'kick');
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

  // ---- Claude Code on the host (ARCHITECTURE §5.8): the trust gate, the host's own rules, redaction ---------------
  stack.add(router.handle('admin.claudeConfig.get', (payload) => ctx.services.projectTrust.describe(payload)));
  stack.add(
    router.handle('admin.claudeConfig.decide', async (payload, req) => {
      await ctx.services.projectTrust.decide(payload, req.principal);
      return {};
    }),
  );
  stack.add(router.handle('admin.hostRules.get', () => ctx.services.hostRules.view()));
  stack.add(
    router.handle('admin.hostRules.seen', async (_payload, req) => {
      await ctx.services.hostRules.markSeen(req.principal);
      return {};
    }),
  );
  stack.add(
    router.handle('admin.transcript.redact', async (payload, req) => {
      // Agent sessions only: a terminal has no conversation.
      if (ctx.services.agents.get(payload.sessionId) === null) {
        const session = ctx.services.sessions.get(payload.sessionId);
        throw session === null ? new SmurgError('not_found', msg('session.notFound')) : new SmurgError('bad_request', msg('session.notAgent'), { reason: 'not-an-agent' });
      }
      await ctx.services.agents.redact(payload.sessionId, payload.seq, req.principal);
      ctx.audit.record({ actor: req.principal.actor, action: 'transcript.redact', outcome: 'ok', target: payload.sessionId, detail: { sessionId: payload.sessionId, seq: payload.seq } });
      return {};
    }),
  );

  stack.add(
    router.handle('channel.leave', async (_payload, req) => {
      // The host stops sharing with `smurg stop`; leaving is for guests (SPEC R4).
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
