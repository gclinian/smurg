// Feature module of src/worktree/ (ARCHITECTURE §7.2, §5.7, §5.10, §11 D-2): shared-clone worktrees (a session's, a
// work item's), their roots and read-only shared links, merge requests with the drafts behind result reports
// (worktree.*), the conflict path of a work item, and what a topic needs of the main repository (the checkpoint
// commit, blobs at HEAD, the diff of the spec and the plan) (SPEC R9, D6, D12). Slot: `worktrees` (WorktreeManager).
//
// start() never fails for a workspace without git (or without a usable git): worktree mode then answers every
// request with a clear `conflict` (detail.reason: not-a-git-repo, git-dir-gone, git-not-found, git-too-old, …), and
// the daemon runs.
// It runs before `sessions` (DEFAULT_FEATURE_MODULES), so worktrees are reconciled before any session can ask for one,
// and stops after it: sessions release their worktrees while this module is still up.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { toDisposable } from '../core/lifecycle.ts';
import { registerWorktreeHandlers } from './handlers.ts';
import { worktreesDocument } from './store.ts';
import { WorktreeManagerImpl, type WorktreeModuleOptions } from './worktree-manager.ts';

/** A worktree module with seams (git path, limits). Production uses worktreeModule. */
export function createWorktreeModule(options: WorktreeModuleOptions = {}): FeatureModule {
  const managers = new WeakMap<DaemonContext, WorktreeManagerImpl>();
  return {
    name: 'worktree',
    documents: [worktreesDocument],
    create: (ctx) => {
      const manager = new WorktreeManagerImpl(ctx, options);
      managers.set(ctx, manager);
      return { worktrees: manager };
    },
    register: (router, ctx) => {
      const manager = managers.get(ctx);
      if (!manager) return toDisposable(() => {});
      return registerWorktreeHandlers(router, ctx, manager);
    },
    start: async (ctx) => {
      await managers.get(ctx)?.start();
    },
    stop: async (ctx) => {
      try {
        await managers.get(ctx)?.stop();
      } catch (err) {
        ctx.log.error('worktree stop failed', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const worktreeModule: FeatureModule = createWorktreeModule();
