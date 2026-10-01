// suggest.* handlers (ARCHITECTURE §5.6, §11 D-15; registry checks in brackets). suggest.create, suggest.list,
// suggest.accept and suggest.reject carry a capability the router has checked (accept / reject: `session.drive`, any
// session); edit and withdraw are `owner-checked-in-handler`: the author rule is enforced here with req.requireOwner
// (audited authz.denied) before the service runs, and again inside the service.
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

  // [session.drive] suggestion-pending. accept is the only road of suggestion text into a PTY.
  stack.add(router.handle('suggest.accept', async (payload, req) => ({ suggestion: await service.accept(payload, req.principal) })));
  stack.add(router.handle('suggest.reject', async (payload, req) => ({ suggestion: await service.reject(payload, req.principal) })));

  // [session.view]: the caller's own suggestions; every suggestion for members who may decide them (session.drive).
  stack.add(router.handle('suggest.list', (payload, req) => ({ suggestions: service.list(payload, req.principal) })));

  return stack;
}
