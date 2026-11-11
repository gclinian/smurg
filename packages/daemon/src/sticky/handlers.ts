// sticky.* handlers (ARCHITECTURE §5.12, DESIGN 0.8.0 D2.4, D2.5, D3.5; registry checks in brackets). Every capability
// is the router's, checked against the caller's CURRENT role before the handler runs.
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { StickyServiceImpl } from './service.ts';

export function registerStickyHandlers(router: Router, service: StickyServiceImpl): Disposable {
  const stack = new DisposableStack();
  // [file.read]: one list-rule page of the index.
  stack.add(router.handle('sticky.list', (payload) => service.list(payload)));
  // [file.write] path-guard, host-only-paths: through the file service, as the caller.
  stack.add(router.handle('sticky.create', (payload, req) => service.create(payload, req.principal)));
  // [session.create]: the running Claude for the sticky notes, or one started for the caller.
  stack.add(router.handle('sticky.assistant.start', async (_payload, req) => ({ session: await service.startAssistant(req.principal) })));
  return stack;
}
