// worktree.* handlers (ARCHITECTURE §5.7, §11 D-15; registry checks in brackets). The router has checked the
// capability of the caller's CURRENT role where the registry names one; the ownership checks the registry leaves to
// handlers are done here with req.requireOwnerOrHost (audited authz.denied) BEFORE the service runs, and again inside
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

  // [worktree.merge.request]: any worktree (the host and 「可使用 agent」 may type into any session anyway, §11 D-15).
  stack.add(router.handle('worktree.merge.request', async (payload, req) => ({ request: await manager.requestMerge(payload, req.principal) })));

  // [file.read]
  stack.add(router.handle('worktree.merge.list', (_payload, req) => ({ requests: manager.listMerges(req.principal) })));

  // [worktree.merge.request]: whoever may request a merge may review any request.
  stack.add(router.handle('worktree.merge.diff', (payload, req) => manager.diff(payload, req.principal)));
  stack.add(router.handle('worktree.merge.fileDiff', (payload, req) => manager.fileDiff(payload, req.principal)));

  // [worktree.merge.decide]
  stack.add(router.handle('worktree.merge.approve', async (payload, req) => ({ request: await manager.approve(payload, req.principal) })));
  stack.add(router.handle('worktree.merge.reject', async (payload, req) => ({ request: await manager.reject(payload, req.principal) })));

  return stack;
}
