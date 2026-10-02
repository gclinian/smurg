// lock.*, presence.*, activity.* handlers (ARCHITECTURE §5.4) and the bus wiring of the locks module. The router has
// checked the capability; path-guard and the human-lock-holder rule are checked here (registry `checks`).
import { LIST_MAX_ITEMS, can, fileRefKey, type FileRef, type LockInfo, type Role } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { ActivityFeedImpl } from './activity.ts';
import { isHiddenFromGuests } from './keys.ts';
import type { LockManagerImpl } from './lock-manager.ts';
import type { PresenceServiceImpl } from './presence.ts';

export interface LockModuleParts {
  readonly locks: LockManagerImpl;
  readonly presence: PresenceServiceImpl;
  readonly activity: ActivityFeedImpl;
}

/** A lock (or event) about `<share>/.smurg/**` reaches the host only: its name alone is hidden from guests. */
export function visibleTo(role: Role, file: FileRef): boolean {
  return role === 'host' || !isHiddenFromGuests(file);
}

function visibleLocks(locks: readonly LockInfo[], role: Role): LockInfo[] {
  return locks.filter((lock) => visibleTo(role, lock.file)).slice(0, LIST_MAX_ITEMS);
}

export function registerLockHandlers(router: Router, ctx: DaemonContext, parts: LockModuleParts): Disposable {
  const { locks, presence, activity } = parts;
  const stack = new DisposableStack();

  stack.add(router.handle('lock.list', (_payload, req) => ({ locks: visibleLocks(locks.list(), req.role) })));

  // "Let the agent go first": the caller leaves the human lock (the others keep editing and keep it).
  stack.add(
    router.handle('lock.release', async (payload, req) => {
      const resolved = await ctx.paths.resolve(payload.file, { principal: req.principal });
      await locks.resolveSpelling(resolved.ref);
      const lock = locks.get(resolved.ref);
      if (lock === null) return {};
      if (lock.kind !== 'human' || !lock.holders.some((holder) => holder.userId === req.userId)) {
        throw req.deny('not-lock-holder', { target: fileRefKey(resolved.ref), detail: { lockKind: lock.kind } });
      }
      locks.leaveHuman(resolved.ref, req.userId, 'yield');
      return {};
    }),
  );

  stack.add(
    router.handle('lock.forceRelease', async (payload, req) => {
      const resolved = await ctx.paths.resolve(payload.file, { principal: req.principal });
      await locks.resolveSpelling(resolved.ref);
      locks.forceRelease(resolved.ref, req.principal);
      return {};
    }),
  );

  stack.add(
    router.on('presence.update', async (payload, req) => {
      if (payload.activeFile === undefined) return;
      const token = presence.beginUpdate(req.conn);
      if (payload.activeFile === null) {
        presence.updateIfLatest(req.conn, token, null);
        return;
      }
      const resolved = await ctx.paths.resolve(payload.activeFile, { principal: req.principal, allowRoot: true });
      presence.updateIfLatest(req.conn, token, resolved.ref);
    }),
  );

  stack.add(router.handle('activity.list', (payload, req) => activity.list(payload, req.principal)));

  // ---- bus → clients -------------------------------------------------------------------------------------------

  stack.add(
    ctx.bus.on('lock.changed', (event) => {
      const hidden = isHiddenFromGuests(event.file);
      ctx.hub.broadcast('lock.state', { file: event.file, lock: event.lock }, hidden ? { filter: (_recipient, role) => role === 'host' } : {});
    }),
  );
  stack.add(activity.attach(ctx.bus));

  // ---- bus → locks ---------------------------------------------------------------------------------------------

  stack.add(ctx.bus.on('settings.changed', () => locks.settingsChanged()));
  stack.add(
    ctx.bus.on('session.exited', (event) => {
      locks.releaseAllForSession(event.session.id, 'session-ended');
      presence.removeAgent(event.session.id);
    }),
  );
  stack.add(ctx.bus.on('member.kicked', (event) => locks.releaseAllForUser(event.userId)));
  stack.add(ctx.bus.on('member.left', (event) => locks.releaseAllForUser(event.userId)));
  stack.add(
    ctx.bus.on('member.role-changed', (event) => {
      // Somebody who may no longer write is no longer editing: fail closed on the human lock.
      if (!can(event.to, 'file.write')) locks.leaveAllHuman(event.userId);
      presence.changed();
    }),
  );

  // ---- bus → presence ------------------------------------------------------------------------------------------

  stack.add(ctx.bus.on('conn.opened', (event) => presence.connectionOpened(event.conn)));
  stack.add(ctx.bus.on('conn.closed', (event) => presence.connectionClosed(event.conn)));
  stack.add(ctx.bus.on('member.joined', () => presence.changed()));
  stack.add(ctx.bus.on('member.kicked', () => presence.changed()));
  stack.add(ctx.bus.on('member.left', () => presence.changed()));
  stack.add(ctx.members.onChange(() => presence.changed()));
  stack.add(ctx.bus.on('session.created', (event) => presence.sessionChanged(event.session)));
  stack.add(ctx.bus.on('session.updated', (event) => presence.sessionChanged(event.session)));
  stack.add(
    ctx.bus.on('agent.tool.pre', (event) => {
      if (event.outcome === 'granted' && event.file !== null) presence.setAgentActiveFile(event.sessionId, event.file);
    }),
  );
  return stack;
}
