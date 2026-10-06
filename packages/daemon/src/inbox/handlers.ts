// inbox.* handlers (ARCHITECTURE §5.11; registry checks in brackets). All three carry the capability `none`: every
// member has an inbox, a Viewer too (mentions reach every role). [own-inbox]: a request names no member. Whose inbox
// it is about is the caller, taken from the connection (`req.principal`), never from the payload.
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { InboxServiceImpl } from './inbox-service.ts';

export function registerInboxHandlers(router: Router, _ctx: DaemonContext, service: InboxServiceImpl): Disposable {
  const stack = new DisposableStack();

  // [own-inbox] THE list rule: one page in key order, `hasMore`, continue with `after` (the last key).
  stack.add(router.handle('inbox.list', (payload, req) => service.list(req.principal, payload)));

  // [own-inbox] A notify: clears `unread`; a mention or a result opened this way leaves the inbox.
  stack.add(router.on('inbox.seen', (payload, req) => service.seen(req.principal, payload.keys)));

  // [own-inbox] Mentions and results only; anything that waits leaves when it is settled (`inbox.notDismissable`).
  stack.add(
    router.handle('inbox.dismiss', (payload, req) => {
      service.dismiss(req.principal, payload.key);
      return {};
    }),
  );

  return stack;
}
