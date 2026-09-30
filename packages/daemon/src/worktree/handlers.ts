// worktree.* handlers (ARCHITECTURE §5.7; registry checks in brackets). The router has checked the capability of the
// caller's CURRENT role where the registry names one; the ownership checks the registry leaves to handlers are done
// here with req.requireOwner / requireOwnerOrHost (audited authz.denied) BEFORE the service runs, and again inside
// the service (so no other caller can skip them).
import { LIST_MAX_ITEMS } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { WorktreeManagerImpl } from './worktree-manager.ts';

export function registerWorktreeHandlers(router: Router, _ctx: DaemonContext, manager: WorktreeManagerImpl): Disposable {
  const stack = new DisposableStack();

  // [file.read]
  stack.add(router.handle('worktree.list', () => ({ worktrees: manager.list().slice(0, LIST_MAX_ITEMS) })));

  // (owner) worktree-owner-or-host; refused while a session uses it.
  stack.add(
    router.handle('worktree.remove', async (payload, req) => {
      const worktree = manager.get(payload.worktreeId);
      if (worktree) req.requireOwnerOrHost(worktree.ownerUserId, 'worktree');
      await manager.remove(payload.worktreeId, req.principal);
      return {};
    }),
  );

  // [worktree.merge.request] worktree-owner
  stack.add(
    router.handle('worktree.merge.request', async (payload, req) => {
      const worktree = manager.get(payload.worktreeId);
      if (worktree) req.requireOwner(worktree.ownerUserId, 'worktree');
      return { request: await manager.requestMerge(payload, req.principal) };
    }),
  );

  // [file.read]
  stack.add(router.handle('worktree.merge.list', (_payload, req) => ({ requests: manager.listMerges(req.principal) })));

  // (owner) merge-request-owner-or-host
  stack.add(
    router.handle('worktree.merge.diff', async (payload, req) => {
      const owner = manager.mergeOwner(payload.requestId);
      if (owner !== null) req.requireOwnerOrHost(owner, 'merge-request');
      return manager.diff(payload, req.principal);
    }),
  );
  stack.add(
    router.handle('worktree.merge.fileDiff', async (payload, req) => {
      const owner = manager.mergeOwner(payload.requestId);
      if (owner !== null) req.requireOwnerOrHost(owner, 'merge-request');
      return manager.fileDiff(payload, req.principal);
    }),
  );

  // [worktree.merge.decide]
  stack.add(router.handle('worktree.merge.approve', async (payload, req) => ({ request: await manager.approve(payload, req.principal) })));
  stack.add(router.handle('worktree.merge.reject', async (payload, req) => ({ request: await manager.reject(payload, req.principal) })));

  return stack;
}
