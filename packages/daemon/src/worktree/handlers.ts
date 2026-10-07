// worktree.* handlers (ARCHITECTURE §5.7, §11 D-15; registry checks in brackets). The router has checked the
// capability of the caller's CURRENT role where the registry names one; the ownership checks the registry leaves to
// handlers are done here with req.requireOwnerOrHost (audited authz.denied) BEFORE the service runs, and again inside
// the service (so no other caller can skip them).
//
// Also the module's bus listeners: what wrote in a worktree (the file watcher, an agent's tool, the activity feed)
// tells the manager that its working tree may hold work no commit has, and a person's own edit in a work item's
// worktree is remembered for the item's result report (`changes.byHand`).
import { LIST_MAX_ITEMS } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';
import type { WorktreeManagerImpl } from './worktree-manager.ts';

export function registerWorktreeHandlers(router: Router, ctx: DaemonContext, manager: WorktreeManagerImpl): Disposable {
  const stack = new DisposableStack();

  stack.add(
    ctx.bus.on('file.changed', (event) => {
      if (event.root.kind === 'worktree' && event.changes.length > 0) manager.noteChange(event.root.worktreeId);
    }),
  );
  stack.add(
    ctx.bus.on('agent.tool.post', (event) => {
      if (event.file !== null && event.file.root.kind === 'worktree') manager.noteChange(event.file.root.worktreeId);
    }),
  );
  stack.add(ctx.bus.on('activity.recorded', (event) => manager.noteActivity(event.entry)));

  // [file.read]
  stack.add(router.handle('worktree.list', () => ({ worktrees: manager.list().slice(0, LIST_MAX_ITEMS) })));

  // (owner) worktree-owner-or-host, and an owner only while they may open sessions (the service refuses a member
  // the record still names who lost agent access); refused while a session uses it.
  stack.add(
    router.handle('worktree.remove', async (payload, req) => {
      const worktree = manager.get(payload.worktreeId);
      if (worktree) req.requireOwnerOrHost(worktree.ownerUserId, 'worktree');
      await manager.remove(payload.worktreeId, req.principal);
      return {};
    }),
  );

  // [worktree.merge.request]: any worktree (the host and Agent access may type into any session anyway, §11 D-15).
  stack.add(router.handle('worktree.merge.request', async (payload, req) => ({ request: await manager.requestMerge(payload, req.principal) })));

  // [file.read]
  stack.add(router.handle('worktree.merge.list', (_payload, req) => ({ requests: manager.listMerges(req.principal) })));

  // [file.read] host-private-withheld: every member reads a request's changes (a result report shows them); a file
  // on a host-private path is listed as hidden and its diff withheld from everyone but the host; the text is masked.
  stack.add(router.handle('worktree.merge.diff', (payload, req) => manager.diff(payload, req.principal)));
  stack.add(router.handle('worktree.merge.fileDiff', (payload, req) => manager.fileDiff(payload, req.principal)));

  // [worktree.merge.decide]
  stack.add(router.handle('worktree.merge.approve', async (payload, req) => ({ request: await manager.approve(payload, req.principal) })));
  stack.add(router.handle('worktree.merge.reject', async (payload, req) => ({ request: await manager.reject(payload, req.principal) })));

  return stack;
}
