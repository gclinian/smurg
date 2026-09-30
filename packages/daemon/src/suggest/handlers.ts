// suggest.* handlers (ARCHITECTURE §5.6; registry checks in brackets). suggest.create and suggest.list carry a
// capability the router has checked; the other four are `owner-checked-in-handler`: the ownership rule is enforced
// here with req.requireOwner (audited authz.denied) before the service runs, and again inside the service.
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { SuggestionServiceImpl } from './suggestion-service.ts';

export function registerSuggestionHandlers(router: Router, _ctx: DaemonContext, service: SuggestionServiceImpl): Disposable {
  const stack = new DisposableStack();

  // [suggest.create] target-session-not-own (in the service: it needs the session's owner)
  stack.add(router.handle('suggest.create', async (payload, req) => ({ suggestion: await service.create(payload, req.principal) })));

  // (author) suggestion-author-pending
  stack.add(
    router.handle('suggest.edit', async (payload, req) => {
      const parties = service.parties(payload.suggestionId);
      if (parties) req.requireOwner(parties.authorUserId, 'suggestion');
      return { suggestion: await service.edit(payload, req.principal) };
    }),
  );
  stack.add(
    router.handle('suggest.withdraw', async (payload, req) => {
      const parties = service.parties(payload.suggestionId);
      if (parties) req.requireOwner(parties.authorUserId, 'suggestion');
      return { suggestion: await service.withdraw(payload, req.principal) };
    }),
  );

  // (session owner) suggestion-session-owner. accept is the only road of suggestion text into a PTY.
  stack.add(
    router.handle('suggest.accept', async (payload, req) => {
      const parties = service.parties(payload.suggestionId);
      if (parties) req.requireOwner(parties.sessionOwnerUserId, 'session');
      return { suggestion: await service.accept(payload, req.principal) };
    }),
  );
  stack.add(
    router.handle('suggest.reject', async (payload, req) => {
      const parties = service.parties(payload.suggestionId);
      if (parties) req.requireOwner(parties.sessionOwnerUserId, 'session');
      return { suggestion: await service.reject(payload, req.principal) };
    }),
  );

  // [session.view]: only suggestions the caller is a party of (the host sees all).
  stack.add(router.handle('suggest.list', (payload, req) => ({ suggestions: service.list(payload, req.principal) })));

  return stack;
}
