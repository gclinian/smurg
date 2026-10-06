// The registry of roots PathGuard resolves against (ARCHITECTURE §5 RootRef, §7.4): the main shared folder, and
// each worktree the WorktreeManager registered together with the read-only shared-directory links it created (D12).
// PathGuard trusts a symlink that leaves a root ONLY if it is one of these recorded links and still points exactly
// where it pointed at registration. Records persist in state.json so the rule survives a daemon restart.
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAIN_ROOT, checkRelPath, isHostOnlyPath, itemIdSchema, opaqueIdSchema, rootRefKey, topicSlugSchema, type RootRef } from '@smurg/protocol';
import type { PersistentDocument, RegisterWorktreeRootInput, RootInfo, RootRegistry, SharedLink } from '../core/interfaces.ts';
import { toDisposable, type Clock, type Disposable } from '../core/lifecycle.ts';
import type { WorkspaceState } from '../core/workspace-state.ts';
import { isInside, lstatOrNull, realpathOrNull } from './fs-util.ts';

export class RootRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootRegistrationError';
  }
}

type Listener = (change: { readonly kind: 'added' | 'removed'; readonly root: RootInfo }) => void | Promise<void>;

/**
 * unregisterWorktree waits this long at most for the listeners of a removal (the file watcher releases the root's
 * native subscription before the worktree manager deletes the directory: files/watcher.ts header).
 */
export const ROOT_REMOVED_WAIT_MS = 15_000;

function freezeRoot(root: RootInfo): RootInfo {
  return Object.freeze({
    ...root,
    sharedLinks: Object.freeze(root.sharedLinks.map((link) => Object.freeze({ ...link }))),
    ...(root.item === undefined ? {} : { item: Object.freeze({ ...root.item }) }),
  });
}

export class RootRegistryImpl implements RootRegistry {
  readonly main: RootInfo;
  readonly worktreesDir: string;
  private readonly state: PersistentDocument<WorkspaceState>;
  private readonly clock: Clock;
  private readonly worktrees = new Map<string, RootInfo>();
  private readonly listeners = new Set<Listener>();

  private constructor(main: RootInfo, state: PersistentDocument<WorkspaceState>, clock: Clock) {
    this.main = main;
    this.worktreesDir = join(main.realPath, '.smurg', 'worktrees');
    this.state = state;
    this.clock = clock;
    for (const record of state.get().worktreeRoots) {
      this.worktrees.set(
        record.worktreeId,
        freezeRoot({
          ref: { kind: 'worktree', worktreeId: record.worktreeId },
          key: rootRefKey({ kind: 'worktree', worktreeId: record.worktreeId }),
          realPath: record.realPath,
          ownerUserId: record.ownerUserId,
          sharedLinks: record.sharedLinks,
          registeredAt: record.registeredAt,
          ...(record.item === undefined ? {} : { item: record.item }),
        }),
      );
    }
  }

  /** `shareDir` must be an existing directory; its realpath becomes the main root. */
  static async create(shareDir: string, state: PersistentDocument<WorkspaceState>, clock: Clock): Promise<RootRegistryImpl> {
    const real = await realpath(shareDir);
    const st = await lstat(real);
    if (!st.isDirectory()) throw new RootRegistrationError('the shared folder is not a directory');
    const main = freezeRoot({ ref: MAIN_ROOT, key: 'main', realPath: real, ownerUserId: null, sharedLinks: [], registeredAt: clock.now() });
    return new RootRegistryImpl(main, state, clock);
  }

  get(ref: RootRef): RootInfo | null {
    if (ref.kind === 'main') return this.main;
    if (ref.kind === 'worktree') return this.worktrees.get(ref.worktreeId) ?? null;
    return null;
  }

  list(): RootInfo[] {
    return [this.main, ...this.worktrees.values()];
  }

  async registerWorktree(input: RegisterWorktreeRootInput): Promise<RootInfo> {
    if (!opaqueIdSchema.safeParse(input.worktreeId).success) throw new RootRegistrationError('invalid worktree id');
    const worktreesReal = await realpathOrNull(this.worktreesDir);
    if (worktreesReal !== this.worktreesDir) throw new RootRegistrationError('.smurg/worktrees is missing or is a symlink');
    const expected = join(this.worktreesDir, input.worktreeId);
    const dirReal = await realpathOrNull(input.dir);
    const dirStat = await lstatOrNull(expected);
    if (dirReal !== expected || dirStat === null || dirStat === 'not-directory' || !dirStat.isDirectory()) {
      throw new RootRegistrationError('a worktree must be a real directory at .smurg/worktrees/<worktreeId>');
    }
    // An item worktree: its topic's folder becomes unwritable through smurg (PathGuard), so the facts must be well-formed.
    const item = input.item === undefined ? undefined : { topicId: input.item.topicId, topicSlug: input.item.topicSlug, itemId: input.item.itemId };
    if (item !== undefined && (!opaqueIdSchema.safeParse(item.topicId).success || !topicSlugSchema.safeParse(item.topicSlug).success || !itemIdSchema.safeParse(item.itemId).success)) {
      throw new RootRegistrationError('invalid work item of a worktree root');
    }
    const links: SharedLink[] = [];
    const seen = new Set<string>();
    for (const link of input.sharedLinks) {
      const path = checkRelPath(link.path);
      const mainPath = checkRelPath(link.mainPath);
      if (!path.ok || !mainPath.ok) throw new RootRegistrationError('invalid shared link path');
      if (seen.has(path.path.toLowerCase())) throw new RootRegistrationError('duplicate shared link');
      seen.add(path.path.toLowerCase());
      // Sharing a host-only directory (e.g. .git, .claude) or .smurg itself would hand guests what §5.2 protects.
      if (isHostOnlyPath(mainPath.path)) throw new RootRegistrationError('a host-only directory cannot be shared');
      const linkAbs = join(expected, path.path);
      if ((await realpathOrNull(dirname(linkAbs))) !== dirname(linkAbs)) throw new RootRegistrationError('a shared link parent is a symlink');
      const linkStat = await lstatOrNull(linkAbs);
      if (linkStat === null || linkStat === 'not-directory' || !linkStat.isSymbolicLink()) throw new RootRegistrationError('a shared link is not a symlink');
      const target = await realpathOrNull(linkAbs);
      const expectedTarget = await realpathOrNull(join(this.main.realPath, mainPath.path));
      if (target === null || expectedTarget === null || target !== expectedTarget) {
        throw new RootRegistrationError('a shared link does not point at its shared directory');
      }
      if (!isInside(target, this.main.realPath) || isInside(target, join(this.main.realPath, '.smurg'))) {
        throw new RootRegistrationError('a shared directory must be inside the shared folder');
      }
      const targetStat = await lstat(target);
      if (!targetStat.isDirectory()) throw new RootRegistrationError('a shared directory is not a directory');
      links.push({ path: path.path, mainPath: mainPath.path, targetRealPath: target });
    }
    const root = freezeRoot({
      ref: { kind: 'worktree', worktreeId: input.worktreeId },
      key: rootRefKey({ kind: 'worktree', worktreeId: input.worktreeId }),
      realPath: expected,
      ownerUserId: input.ownerUserId,
      sharedLinks: links,
      registeredAt: this.clock.now(),
      ...(item === undefined ? {} : { item }),
    });
    this.state.update((draft) => {
      draft.worktreeRoots = draft.worktreeRoots.filter((record) => record.worktreeId !== input.worktreeId);
      draft.worktreeRoots.push({
        worktreeId: input.worktreeId,
        realPath: root.realPath,
        ownerUserId: input.ownerUserId,
        sharedLinks: links.map((link) => ({ ...link })),
        registeredAt: root.registeredAt,
        ...(item === undefined ? {} : { item }),
      });
    });
    await this.state.flush();
    this.worktrees.set(input.worktreeId, root);
    this.emit({ kind: 'added', root });
    return root;
  }

  async unregisterWorktree(worktreeId: string): Promise<void> {
    const root = this.worktrees.get(worktreeId);
    if (!root) return;
    this.worktrees.delete(worktreeId);
    this.state.update((draft) => {
      draft.worktreeRoots = draft.worktreeRoots.filter((record) => record.worktreeId !== worktreeId);
    });
    await this.state.flush();
    await settledWithin(this.emit({ kind: 'removed', root }), ROOT_REMOVED_WAIT_MS);
  }

  onChange(listener: Listener): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  /** Calls every listener; returns the promises of those that answered with one (never rejecting). */
  private emit(change: { readonly kind: 'added' | 'removed'; readonly root: RootInfo }): Promise<void>[] {
    const waits: Promise<void>[] = [];
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(change);
        if (result instanceof Promise) waits.push(result.catch(() => {}));
      } catch {
        // A broken listener must not stop registration.
      }
    }
    return waits;
  }
}

/** Resolves once every promise settled or after `ms`, whichever comes first (the timer does not outlive it). */
async function settledWithin(promises: readonly Promise<void>[], ms: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([Promise.allSettled(promises), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
