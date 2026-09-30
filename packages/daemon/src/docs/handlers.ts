// doc.* handlers (ARCHITECTURE §5.3). The Router has already checked the capability of each type (registry); what
// is left is resource level and lives in DocServiceImpl: path guard on open, doc-subscriber on sync / awareness /
// close, doc-content-needs-file.write on sync, host-only / read-only on conflict resolution.
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { DocServiceImpl } from './doc-service.ts';

export function registerDocHandlers(router: Router, docs: DocServiceImpl): Disposable {
  const stack = new DisposableStack();
  stack.add(
    router.handle('doc.open', async (payload, ctx) => {
      const start = await docs.open(payload.file, ctx.conn, ctx.principal);
      ctx.afterReply(() => start.afterReply()); // sync step 1 + awareness snapshot after the .ok
      return start.result;
    }),
  );
  stack.add(router.on('doc.sync', (payload, ctx) => docs.sync(payload, ctx.conn, ctx.principal)));
  stack.add(router.on('doc.awareness', (payload, ctx) => docs.awareness(payload, ctx.conn, ctx.principal)));
  stack.add(router.on('doc.close', (payload, ctx) => docs.close(payload, ctx.conn)));
  stack.add(router.handle('doc.conflict.list', (_payload, ctx) => ({ conflicts: docs.listConflicts(ctx.principal) })));
  stack.add(router.handle('doc.conflict.get', (payload, ctx) => docs.getConflict(payload.conflictId, ctx.principal)));
  stack.add(
    router.handle('doc.conflict.resolve', async (payload, ctx) => ({ conflict: await docs.resolveConflict(payload, ctx.principal) })),
  );
  return stack;
}
