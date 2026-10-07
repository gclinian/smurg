// TEST ONLY. In-memory WorktreeManager: worktrees and merge requests without git. It emits `worktree.changed` and
// `merge.changed` as the real module does. With a root registry (a real test daemon) an acquired worktree is a real
// directory under .smurg/worktrees/<id>, registered as a root (an item worktree with its `item`), so file requests
// and PathGuard work on it; the topic's folder is copied into an item worktree, like a checkout of HEAD would hold it.
// Without a registry the handle carries a synthetic root.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SmurgError,
  rootRefKey,
  topicDirPath,
  topicReportPath,
  worktreeRoot,
  type MergeRequest,
  type UserRef,
  type WorktreeInfo,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { Principal, Req, Res, RootInfo, SnapshotResult, WorktreeHandle, WorktreeManager } from '../interfaces.ts';
import { buildMergeRequest, buildWorktree } from './build.ts';
import { CallLog, fakeId, type FakeEnv } from './env.ts';

function userRef(principal: Principal): UserRef {
  if (principal.actor.kind === 'user') return { userId: principal.actor.userId, displayName: principal.actor.displayName };
  return { userId: principal.userId ?? 'dev:host', displayName: 'Host' };
}

function fakeCommit(seed: string): string {
  return createHash('sha1').update(seed).digest('hex');
}

export class FakeWorktreeManager implements WorktreeManager {
  readonly log = new CallLog();
  /** What `mainState` answers. */
  main: Awaited<ReturnType<WorktreeManager['mainState']>> = { isRepo: true, hasCommit: true, gitOk: true, branch: 'main', busy: false, free: 64 };
  /** What the next `snapshot` of a worktree answers instead of a draft (a policy refusal), once. */
  readonly refuseSnapshot = new Map<string, Extract<SnapshotResult, { ok: false }>>();
  /** What the next `snapshot` calls of a worktree throw instead of answering, one per call (a file that changed while the tree was read, git out of time). */
  readonly failSnapshot = new Map<string, unknown[]>();
  /** What `snapshot` reports as changed: files, additions, deletions, byHand. */
  snapshotStats: { files: number; additions: number; deletions: number; byHand: { path: string; by: UserRef[] }[] } = { files: 1, additions: 1, deletions: 0, byHand: [] };
  /** What `updateFromMain` reports as conflicted. */
  conflictedFiles: string[] = [];
  /** Blob ids of the main workspace's HEAD as the last `commitMainPaths` left them (tests may set them). */
  readonly head = new Map<string, string>();
  /** What `diffMainPaths` answers per path (tests set it); a path without an entry does not differ. */
  readonly mainDiffs = new Map<string, { diff: string; truncated?: boolean }>();
  /** Item worktrees that hold edits no snapshot has yet (`unmerged` then lists them without a request). */
  readonly unsavedEdits = new Set<string>();
  private readonly env: FakeEnv;
  private readonly worktrees = new Map<string, WorktreeInfo>();
  private readonly roots = new Map<string, RootInfo>();
  private readonly requests = new Map<string, MergeRequest>();
  private commits = 0;

  constructor(env: FakeEnv) {
    this.env = env;
  }

  // ---- drivers -----------------------------------------------------------------------------------------------------

  /** Puts a merge request (new or changed) and emits `merge.changed`. */
  putRequest(request: MergeRequest): MergeRequest {
    this.requests.set(request.id, structuredClone(request));
    this.env.bus.emit('merge.changed', { request: structuredClone(request) });
    return request;
  }

  /** Puts a worktree the fake did not make itself (what the worktree module still has after a restart of the daemon); no event, no root. */
  adopt(worktree: WorktreeInfo): void {
    this.worktrees.set(worktree.id, structuredClone(worktree));
  }

  /** The request turned out to conflict with the main workspace. */
  conflict(requestId: string, files: readonly string[]): MergeRequest {
    return this.putRequest({ ...this.needRequest(requestId), status: 'conflict', conflictFiles: [...files] });
  }

  // ---- today's surface ---------------------------------------------------------------------------------------------

  list(): WorktreeInfo[] {
    return [...this.worktrees.values()].map((worktree) => structuredClone(worktree));
  }

  get(worktreeId: string): WorktreeInfo | null {
    const worktree = this.worktrees.get(worktreeId);
    return worktree ? structuredClone(worktree) : null;
  }

  async acquireForSession(input: { readonly owner: Principal; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle> {
    this.log.record('acquireForSession', input);
    if (input.worktreeId !== undefined) {
      const kept = this.needWorktree(input.worktreeId);
      return this.handle(this.putWorktree({ ...kept, sessionId: input.sessionId, kept: false }));
    }
    const owner = userRef(input.owner);
    const id = fakeId('wt');
    const worktree = this.putWorktree(buildWorktree({ id, ownerUserId: owner.userId, ownerName: owner.displayName, branch: `smurg/${owner.displayName.toLowerCase()}/${id}`, sessionId: input.sessionId, createdAt: this.env.clock.now() }));
    await this.materialise(worktree, undefined);
    return this.handle(worktree);
  }

  async releaseFromSession(worktreeId: string, sessionId: string, options: { readonly keep: boolean }): Promise<void> {
    this.log.record('releaseFromSession', worktreeId, sessionId, options);
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) return;
    // A work item's worktree outlives its sessions: only `releaseItem` removes it.
    if (worktree.itemId !== undefined) return;
    if (options.keep) {
      const kept = { ...worktree, kept: true };
      delete kept.sessionId;
      this.putWorktree(kept);
    } else await this.drop(worktreeId);
  }

  async remove(worktreeId: string, principal: Principal): Promise<void> {
    this.log.record('remove', worktreeId, principal);
    this.needWorktree(worktreeId);
    await this.drop(worktreeId);
  }

  async requestMerge(input: Req<'worktree.merge.request'>, principal: Principal): Promise<MergeRequest> {
    this.log.record('requestMerge', input, principal);
    const worktree = this.needWorktree(input.worktreeId);
    const draft = [...this.requests.values()].reverse().find((request) => request.worktreeId === worktree.id && request.status === 'draft');
    if (draft) return this.putRequest({ ...draft, status: 'pending', requestedBy: userRef(principal), ...(input.message === undefined ? {} : { message: input.message }) });
    return this.putRequest(
      buildMergeRequest({
        id: fakeId('mr'),
        worktreeId: worktree.id,
        requestedBy: userRef(principal),
        message: input.message,
        commit: this.nextCommit(worktree.id),
        topicId: worktree.topicId,
        itemId: worktree.itemId,
        createdAt: this.env.clock.now(),
      }),
    );
  }

  listMerges(_principal: Principal): MergeRequest[] {
    return [...this.requests.values()].map((request) => structuredClone(request));
  }

  async diff(input: Req<'worktree.merge.diff'>, principal: Principal): Promise<Res<'worktree.merge.diff'>> {
    this.log.record('diff', input, principal);
    this.needRequest(input.requestId);
    return { diff: 'diff --git a/src/app.ts b/src/app.ts\n+changed\n', truncated: false, files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }] };
  }

  async fileDiff(input: Req<'worktree.merge.fileDiff'>, principal: Principal): Promise<Res<'worktree.merge.fileDiff'>> {
    this.log.record('fileDiff', input, principal);
    this.needRequest(input.requestId);
    return { path: input.path, diff: `diff --git a/${input.path} b/${input.path}\n+changed\n`, truncated: false, binary: false };
  }

  async approve(input: Req<'worktree.merge.approve'>, principal: Principal): Promise<MergeRequest> {
    this.log.record('approve', input, principal);
    const request = this.needRequest(input.requestId);
    if (request.status !== 'pending' && request.status !== 'draft') throw new SmurgError('conflict', undefined, { reason: 'not-open' });
    return this.putRequest({ ...request, status: 'merged', decidedAt: this.env.clock.now(), ...(request.requestedBy === undefined ? { requestedBy: userRef(principal) } : {}) });
  }

  async reject(input: Req<'worktree.merge.reject'>, principal: Principal): Promise<MergeRequest> {
    this.log.record('reject', input, principal);
    const request = this.needRequest(input.requestId);
    return this.putRequest({ ...request, status: 'rejected', decidedAt: this.env.clock.now(), ...(input.reason === undefined ? {} : { rejectReason: input.reason }) });
  }

  // ---- work items --------------------------------------------------------------------------------------------------

  async acquireForItem(input: { readonly topic: { readonly id: string; readonly slug: string }; readonly itemId: string; readonly owner: Principal }): Promise<WorktreeHandle> {
    this.log.record('acquireForItem', input);
    const existing = [...this.worktrees.values()].find((worktree) => worktree.topicId === input.topic.id && worktree.itemId === input.itemId);
    if (existing) {
      // A retry reuses the worktree; a report file that is already there is removed.
      const root = this.roots.get(existing.id);
      if (root && this.env.roots !== undefined) await rm(join(root.realPath, topicReportPath(input.topic.slug, input.itemId)), { force: true });
      return this.handle(existing);
    }
    const owner = userRef(input.owner);
    const worktree = this.putWorktree(
      buildWorktree({ id: fakeId('wt'), ownerUserId: owner.userId, ownerName: owner.displayName, branch: `smurg/${input.topic.slug}/${input.itemId}`, topicId: input.topic.id, itemId: input.itemId, createdAt: this.env.clock.now() }),
    );
    await this.materialise(worktree, { topicId: input.topic.id, topicSlug: input.topic.slug, itemId: input.itemId });
    return this.handle(worktree);
  }

  async snapshot(input: { readonly worktreeId: string; readonly message: string; readonly topicSlug?: string }): Promise<SnapshotResult> {
    this.log.record('snapshot', input);
    const worktree = this.needWorktree(input.worktreeId);
    const failure = this.failSnapshot.get(worktree.id)?.shift();
    if (failure !== undefined) throw failure;
    const refusal = this.refuseSnapshot.get(worktree.id);
    if (refusal) {
      this.refuseSnapshot.delete(worktree.id);
      return refusal;
    }
    // A new version replaces the worktree's older draft.
    for (const request of [...this.requests.values()]) if (request.worktreeId === worktree.id && request.status === 'draft') this.requests.delete(request.id);
    const request = this.putRequest(
      buildMergeRequest({ id: fakeId('mr'), worktreeId: worktree.id, requestedBy: undefined, message: input.message, commit: this.nextCommit(worktree.id), status: 'draft', topicId: worktree.topicId, itemId: worktree.itemId, createdAt: this.env.clock.now() }),
    );
    return { ok: true, request, files: this.snapshotStats.files, additions: this.snapshotStats.additions, deletions: this.snapshotStats.deletions, byHand: this.snapshotStats.byHand.map((entry) => ({ path: entry.path, by: [...entry.by] })) };
  }

  setReviewed(requestId: string, reviewed: boolean): MergeRequest {
    this.log.record('setReviewed', requestId, reviewed);
    return this.putRequest({ ...this.needRequest(requestId), reviewed });
  }

  async commitMainPaths(input: { readonly paths: readonly string[]; readonly message: string; readonly trailers: readonly string[]; readonly as: Principal }): Promise<{ readonly commit: string; readonly created: boolean; readonly branch: string; readonly blobs: Readonly<Record<string, string>> }> {
    this.log.record('commitMainPaths', input);
    const blobs: Record<string, string> = {};
    let created = false;
    for (const path of input.paths) {
      const blob = await this.blobOf(path);
      if (this.head.get(path) !== blob) created = true;
      this.head.set(path, blob);
      blobs[path] = blob;
    }
    return { commit: this.nextCommit('main'), created, branch: this.main.branch ?? 'main', blobs };
  }

  async headBlobs(paths: readonly string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(paths.map((path) => [path, this.head.get(path) ?? null]));
  }

  async mainState(): Promise<Awaited<ReturnType<WorktreeManager['mainState']>>> {
    return { ...this.main };
  }

  async updateFromMain(worktreeId: string): Promise<{ readonly mergeParent: string; readonly conflicted: readonly string[] }> {
    this.log.record('updateFromMain', worktreeId);
    this.needWorktree(worktreeId);
    return { mergeParent: fakeCommit(`main:${this.commits}`), conflicted: [...this.conflictedFiles] };
  }

  async diffMainPaths(input: { readonly paths: readonly string[]; readonly against: 'head' | Readonly<Record<string, string | null>>; readonly maxBytes: number }): Promise<{ readonly path: string; readonly diff: string; readonly truncated: boolean }[]> {
    this.log.record('diffMainPaths', input);
    if (!this.main.isRepo) return [];
    return input.paths.flatMap((path) => {
      const entry = this.mainDiffs.get(path);
      if (entry === undefined) return [];
      const cut = Buffer.byteLength(entry.diff, 'utf8') > input.maxBytes;
      return [{ path, diff: cut ? Buffer.from(entry.diff, 'utf8').subarray(0, input.maxBytes).toString('utf8').replace(/\uFFFD$/u, '') : entry.diff, truncated: cut || entry.truncated === true }];
    });
  }

  async setOwner(worktreeId: string, owner: Principal): Promise<void> {
    this.log.record('setOwner', worktreeId, owner);
    const next = userRef(owner);
    this.putWorktree({ ...this.needWorktree(worktreeId), ownerUserId: next.userId, ownerName: next.displayName });
  }

  async releaseItem(worktreeId: string): Promise<void> {
    this.log.record('releaseItem', worktreeId);
    this.unsavedEdits.delete(worktreeId);
    await this.drop(worktreeId);
  }

  unmerged(topicId: string): WorktreeInfo[] {
    return [...this.worktrees.values()]
      .filter((worktree) => worktree.topicId === topicId && worktree.itemId !== undefined)
      .filter((worktree) => {
        if (this.unsavedEdits.has(worktree.id)) return true;
        const newest = [...this.requests.values()].reverse().find((request) => request.worktreeId === worktree.id);
        return newest !== undefined && newest.status !== 'merged';
      })
      .map((worktree) => structuredClone(worktree));
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  private putWorktree(worktree: WorktreeInfo): WorktreeInfo {
    this.worktrees.set(worktree.id, structuredClone(worktree));
    this.env.bus.emit('worktree.changed', { worktreeId: worktree.id, worktree: structuredClone(worktree) });
    return worktree;
  }

  private needWorktree(worktreeId: string): WorktreeInfo {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) throw new SmurgError('not_found', msg('worktree.notFound'));
    return worktree;
  }

  private needRequest(requestId: string): MergeRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new SmurgError('not_found', msg('merge.notFound'));
    return request;
  }

  private nextCommit(seed: string): string {
    this.commits += 1;
    return fakeCommit(`${seed}:${this.commits}`);
  }

  private handle(worktree: WorktreeInfo): WorktreeHandle {
    const root = this.roots.get(worktree.id);
    if (!root) throw new Error(`fake worktree ${worktree.id} has no root`);
    return { worktree: structuredClone(worktree), root };
  }

  /** A real, registered directory when the daemon's root registry is there; else a synthetic root. */
  private async materialise(worktree: WorktreeInfo, item: { topicId: string; topicSlug: string; itemId: string } | undefined): Promise<void> {
    const ref = worktreeRoot(worktree.id);
    const registry = this.env.roots;
    if (registry === undefined) {
      this.roots.set(worktree.id, { ref, key: rootRefKey(ref), realPath: `/fake/worktrees/${worktree.id}`, ownerUserId: worktree.ownerUserId, sharedLinks: [], registeredAt: this.env.clock.now(), ...(item === undefined ? {} : { item }) });
      return;
    }
    const dir = join(registry.worktreesDir, worktree.id);
    await mkdir(dir, { recursive: true });
    if (item !== undefined) {
      // What a checkout of HEAD would hold of the topic: its folder as the main workspace has it now.
      await cp(join(registry.main.realPath, topicDirPath(item.topicSlug)), join(dir, topicDirPath(item.topicSlug)), { recursive: true }).catch(() => {});
      await rm(join(dir, topicReportPath(item.topicSlug, item.itemId)), { force: true });
    }
    this.roots.set(worktree.id, await registry.registerWorktree({ worktreeId: worktree.id, dir, ownerUserId: worktree.ownerUserId, sharedLinks: [], ...(item === undefined ? {} : { item }) }));
  }

  private async drop(worktreeId: string): Promise<void> {
    if (!this.worktrees.delete(worktreeId)) return;
    // As the real manager: a removed worktree takes its DRAFT requests with it, silently (no `merge.changed`; the
    // `worktree.changed` below is the announcement). Requests somebody asked for stay decidable.
    for (const [id, request] of this.requests) if (request.worktreeId === worktreeId && request.status === 'draft') this.requests.delete(id);
    const root = this.roots.get(worktreeId);
    this.roots.delete(worktreeId);
    if (root && this.env.roots !== undefined) {
      await this.env.roots.unregisterWorktree(worktreeId);
      await rm(root.realPath, { recursive: true, force: true });
    }
    this.env.bus.emit('worktree.changed', { worktreeId, worktree: null });
  }

  /** The blob id of a file of the main workspace: a hash of its content when there is a real folder, else of its path. */
  private async blobOf(path: string): Promise<string> {
    const main = this.env.roots?.main.realPath;
    const content = main === undefined ? null : await readFile(join(main, path)).catch(() => null);
    return createHash('sha1').update(content ?? `missing:${path}`).digest('hex');
  }
}
