// session.* and exec.* handlers (ARCHITECTURE §5.5; registry checks in brackets). The router has already checked the
// capability of the caller's CURRENT role; ownership is checked here with req.requireOwner (audited authz.denied), so
// a viewer's or collaborator's keystrokes never reach a PTY: they use suggestions (R6).
import type { DaemonContext } from '../core/context.ts';
import type { RequestContext, Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { SessionManagerImpl } from './session-manager.ts';

export function registerSessionHandlers(router: Router, ctx: DaemonContext, sessions: SessionManagerImpl): Disposable {
  const stack = new DisposableStack();
  /** Unknown sessions are not_found (the ids are visible to every member anyway); others must be the owner. */
  const requireOwner = (sessionId: string, req: RequestContext): void => {
    const owner = sessions.ownerOf(sessionId);
    if (owner === null) return; // the service answers not_found
    req.requireOwner(owner, 'session');
  };

  // [session.create.host | session.create.sandboxed] sandbox-by-role, api-key-sandboxed-only, login-own-guest-only
  stack.add(router.handle('session.create', async (payload, req) => ({ session: await sessions.create(payload, req.conn, req.principal) })));
  // [session.view]: every agent / terminal session, and the caller's own login sessions (D-12: nobody else's).
  stack.add(router.handle('session.list', (_payload, req) => ({ sessions: sessions.listFor(req.userId) })));
  // (owner) session-owner
  stack.add(
    router.handle('session.loginStatus', async (payload, req) => {
      requireOwner(payload.sessionId, req);
      return { login: await sessions.loginStatus(payload.sessionId, req.principal) };
    }),
  );
  // [session.view]: the viewer goes live only after the .ok went out (no gap, no duplicate).
  stack.add(
    router.handle('session.attach', async (payload, req) => {
      const start = await sessions.attach(payload, req.conn, req.principal);
      req.afterReply(() => start.afterReply());
      return start.result;
    }),
  );
  stack.add(router.on('session.detach', (payload, req) => sessions.detach(payload.sessionId, req.conn.channelId)));
  // (owner) session-owner; the host ends other people's sessions with admin.session.terminate.
  stack.add(
    router.handle('session.end', async (payload, req) => {
      requireOwner(payload.sessionId, req);
      await sessions.end(payload, req.principal);
      return {};
    }),
  );
  // [session.create.sandboxed] own-guest-dir
  stack.add(router.handle('session.importConfig', (payload, req) => sessions.importConfig(payload, req.principal)));
  // (owner) session-owner: everyone else is refused and audited.
  stack.add(
    router.on('exec.input', (payload, req) => {
      requireOwner(payload.sessionId, req);
      sessions.input(payload, req.conn, req.principal);
    }),
  );
  stack.add(
    router.on('exec.resize', (payload, req) => {
      requireOwner(payload.sessionId, req);
      sessions.resize(payload, req.conn, req.principal);
    }),
  );

  // Viewers are keyed by the logical channel: they survive a resume, and go with the channel for good.
  stack.add(ctx.bus.on('channel.discarded', (event) => {
    if (event.purpose === 'interactive') sessions.detachChannel(event.channelId);
  }));
  return stack;
}
