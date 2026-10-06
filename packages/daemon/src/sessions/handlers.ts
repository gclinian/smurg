// session.* and exec.* handlers (ARCHITECTURE §5.5, §11 D-15; registry checks in brackets). The router has already
// checked the capability of the caller's CURRENT role: `session.drive` (the host, Agent access) types into any session,
// so an editor's or viewer's keystrokes never reach a PTY (they use suggestions, R6). What only the session's owner
// (the member who opened it) may do is checked here with req.requireOwner (audited authz.denied).
import { takeListPage } from '@smurg/protocol';
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

  // [session.create]: the session runs like the host's own; the caller becomes its owner.
  stack.add(router.handle('session.create', async (payload, req) => ({ session: await sessions.create(payload, req.conn, req.principal) })));
  // [session.view]: every session (with `topicId`: every agent session of that topic), by THE list rule.
  stack.add(
    router.handle('session.list', (payload) => {
      const page = takeListPage(sessions.list(payload.topicId === undefined ? {} : { topicId: payload.topicId }), payload.after, (session) => session.id);
      return { sessions: page.items, hasMore: page.hasMore };
    }),
  );
  // [session.drive]: any session.
  stack.add(router.handle('session.loginStatus', async (payload, req) => ({ login: await sessions.loginStatus(payload.sessionId, req.principal) })));
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
  // [session.drive]: any session.
  stack.add(router.on('exec.input', (payload, req) => sessions.input(payload, req.conn, req.principal)));
  // (owner) session-owner: the PTY follows its owner's viewport (resize policy `owner`); everyone else is refused and
  // audited.
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
