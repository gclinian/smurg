// WorktreeManager (SPEC R9, D6, D12; ARCHITECTURE §5.7, §11 D-2). A "worktree" is a shared clone at
// <share>/.smurg/worktrees/<id> on its own branch smurg/<owner>/<id>, started at the main workspace's HEAD: objects are
// shared read-only through alternates, so a sandboxed guest needs only READ access to <share>/.git and can write
// nothing in the main repository (sandbox.md, verification section). Each worktree is registered as a root (with its
// read-only shared links) BEFORE any session or client uses it, and unregistered when it is removed.
//
// Merge flow (contract review C6): the OWNER's request commits the worktree's working tree as the owner and fetches
// that commit into refs/smurg/merge/<requestId> of the main repository; diff, fileDiff and approve work on exactly that
// commit. The commit is staged in a daemon-private object store and, for a guest's worktree, verified blob by blob
// against the worktree before the clone gets it (stage-commit.ts: the daemon's git is not sandboxed and could be raced
// into reading a host file). The HOST approves: `git merge-tree` decides first, without touching the main workspace,
// so a conflicting merge leaves it exactly as it was and lists the conflicting files; so do local changes, untracked
// or ignored files the merge would overwrite (git overwrites ignored ones silently); a clean one is merged with
// `git merge`. Rejecting never touches the worktree.
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LIST_MAX_ITEMS,
  MAIN_ROOT,
  MERGE_FILES_MAX,
  SmurgError,
  type MergeRequest,
  type PayloadOf,
  type ResultInputOf,
  type WorktreeInfo,
} from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { MemberRecord, PersistentDocument, Principal, RootInfo, WorktreeHandle, WorktreeManager } from '../core/interfaces.ts';
import { isHostPrincipal, principalCan, userActor } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { ensureWorktreesDir, linkSharedDirs, removeWorktreeDir, sweepRemovals, untrackedInTheWay, writeExclude } from './fs-ops.ts';
import { GIT_MIN_VERSION, GitRunner, GitUnavailableError, findGit, firstLine, gitVersionAtLeast, requireOk } from './git.ts';
import { parseMergeTree, parseNameOnly, parseNameStatus, parseStatusPaths } from './git-parse.ts';
import { pinnedHashes, verifyWorktreeRepo } from './integrity.ts';
import { gitIdentity, mergeRef, newMergeId, newWorktreeId, worktreeBranch } from './names.ts';
import {
  DEFAULT_REVIEW_LIMITS,
  checkMergePolicy,
  commitExists,
  mainHead,
  policyError,
  reviewBase,
  reviewFiles,
  singleFileDiff,
  unifiedDiff,
  type MainRepo,
  type ReviewFile,
} from './review.ts';
import { KeyedSerializer } from './serial.ts';
import { stageCommit, sweepStaging } from './stage-commit.ts';
import {
  WORKTREES_DOCUMENT,
  initialWorktreesDocument,
  toMergeRequest,
  toWorktreeInfo,
  worktreesDocumentSchema,
  type StoredMerge,
  type StoredWorktree,
  type WorktreesDocument,
} from './store.ts';

export interface WorktreeLimits {
  readonly maxWorktrees: number;
  readonly maxWorktreesPerOwner: number;
  /** Open (pending / conflict) merge requests per worktree. */
  readonly maxOpenMergesPerWorktree: number;
  /** Decided merge requests kept in worktrees.json (the audit log keeps every one). */
  readonly maxDecidedMerges: number;
  /** clone, add, commit, fetch, diff. */
  readonly gitTimeoutMs: number;
  /** merge-tree and merge in the main workspace. */
  readonly mergeTimeoutMs: number;
  /** `git status` of the main workspace before a merge. */
  readonly statusOutputBytes: number;
}

export const DEFAULT_WORKTREE_LIMITS: WorktreeLimits = Object.freeze({
  maxWorktrees: 64,
  maxWorktreesPerOwner: 8,
  maxOpenMergesPerWorktree: 20,
  maxDecidedMerges: 300,
  gitTimeoutMs: 120_000,
  mergeTimeoutMs: 300_000,
  statusOutputBytes: 32 * 1024 * 1024,
});

export interface WorktreeModuleOptions {
  /**
   * Absolute path of the git executable. Default: the first `git` on the daemon's PATH at start (how the host runs
   * git anyway; it only ever runs with the fixed environment of git.ts).
   */
  readonly gitPath?: string;
  readonly limits?: Partial<WorktreeLimits>;
}

type Available = { readonly ok: true; readonly git: GitRunner; readonly repo: MainRepo } | { readonly ok: false; readonly error: SmurgError };

function notAvailable(reason: string, message: string): Available {
  return { ok: false, error: new SmurgError('conflict', message, { reason }) };
}

const NOT_FOUND = (): SmurgError => new SmurgError('not_found', '找不到這個 worktree', { reason: 'unknown-worktree' });
const MERGE_NOT_FOUND = (): SmurgError => new SmurgError('not_found', '找不到這個合併請求', { reason: 'unknown-merge-request' });

/** Files in <gitDir> whose presence means another git operation is in progress in the main workspace. */
const BUSY_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock'];

export class WorktreeManagerImpl implements WorktreeManager {
  private readonly ctx: DaemonContext;
  private readonly options: WorktreeModuleOptions;
  readonly limits: WorktreeLimits;
  private doc: PersistentDocument<WorktreesDocument> | null = null;
  private available: Available = notAvailable('starting', 'worktree 功能尚未就緒');
  private templateDir = '';
  /** Daemon-private staging stores of merge-request commits (stage-commit.ts). */
  private stagingDir = '';
  private readonly serial = new KeyedSerializer();
  private stopped = false;

  constructor(ctx: DaemonContext, options: WorktreeModuleOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.limits = Object.freeze({ ...DEFAULT_WORKTREE_LIMITS, ...options.limits });
  }

  // =================================================================================================================
  // Lifecycle
  // =================================================================================================================

  /** Never throws for a workspace without git: worktree mode is then unavailable with a clear error. */
  async start(): Promise<void> {
    this.doc = await this.ctx.state.document(WORKTREES_DOCUMENT, worktreesDocumentSchema, initialWorktreesDocument);
    try {
      this.available = await this.probe();
    } catch (err) {
      this.ctx.log.error('worktree mode unavailable', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      this.available = notAvailable('git-unusable', 'git 無法使用，無法使用 worktree 模式');
    }
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Operations on the main repository run to their end (a killed merge would leave the host's repo half-merged).
    await Promise.race([this.serial.idle(), new Promise((resolve) => setTimeout(resolve, 15_000).unref?.())]);
    await this.doc?.flush().catch(() => {});
  }

  private async probe(): Promise<Available> {
    const ctx = this.ctx;
    if (!ctx.workspace.info.isGitRepo) return notAvailable('not-a-git-repo', '分享的資料夾不是 git 儲存庫，無法使用 worktree 模式');
    const share = ctx.roots.main.realPath;
    const gitDir = join(share, '.git');
    const gitStat = await lstat(gitDir).catch(() => null);
    if (gitStat === null || !gitStat.isDirectory() || (await realpath(gitDir).catch(() => null)) !== gitDir) {
      return notAvailable('git-dir-not-directory', '分享資料夾的 .git 不是一般的資料夾（例如 git worktree 或 submodule），無法使用 worktree 模式');
    }
    const gitPath = this.options.gitPath ?? (await findGit(process.env['PATH']));
    if (gitPath === null) return notAvailable('git-not-found', '找不到 git，無法使用 worktree 模式');
    const home = await ctx.state.privateDir('git-home');
    this.templateDir = await ctx.state.privateDir('git-template');
    this.stagingDir = await ctx.state.privateDir('git-staging');
    await sweepStaging(this.stagingDir);
    const git = new GitRunner({ gitPath, home, signal: ctx.stopping });
    const version = await git.version().catch(() => null);
    if (version === null) return notAvailable('git-unusable', 'git 無法執行，無法使用 worktree 模式');
    if (!gitVersionAtLeast(version, GIT_MIN_VERSION)) {
      return notAvailable('git-too-old', `git 版本太舊（需要 ${GIT_MIN_VERSION.join('.')} 以上），無法使用 worktree 模式`);
    }
    if (!(await ensureWorktreesDir(share, ctx.roots.worktreesDir))) {
      return notAvailable('worktrees-dir-unusable', '.smurg/worktrees 不是一般的資料夾，無法使用 worktree 模式');
    }
    return { ok: true, git, repo: { git, gitDir } };
  }

  /**
   * After a restart: every session died with the daemon, so worktrees in use become kept ones; records whose
   * directory is gone are dropped, roots without a record are unregistered (their directories are left alone and
   * logged: only an explicit removal deletes work).
   */
  private async reconcile(): Promise<void> {
    const doc = this.requireDoc();
    if (this.available.ok) {
      const swept = await sweepRemovals(this.ctx.roots.worktreesDir).catch(() => 0);
      if (swept > 0) this.ctx.log.info('finished interrupted worktree removals', { module: 'worktree', count: swept });
    }
    const keep: StoredWorktree[] = [];
    for (const record of doc.get().worktrees) {
      const dir = this.dirOf(record.id);
      const st = await lstat(dir).catch(() => null);
      if (st === null || !st.isDirectory()) {
        await this.ctx.roots.unregisterWorktree(record.id).catch(() => {});
        this.ctx.log.warn('worktree directory missing; record dropped', { module: 'worktree', worktree: record.id });
        continue;
      }
      if (this.ctx.roots.get({ kind: 'worktree', worktreeId: record.id }) === null) {
        await this.registerRoot(record).catch((err: unknown) =>
          this.ctx.log.error('worktree root could not be registered', { module: 'worktree', worktree: record.id, error: err instanceof Error ? err.name : 'unknown' }),
        );
      }
      if (record.sessionId === undefined) keep.push(record);
      else {
        const { sessionId: _ended, ...rest } = record;
        keep.push({ ...rest, kept: true });
      }
    }
    const known = new Set(keep.map((record) => record.id));
    for (const root of this.ctx.roots.list()) {
      if (root.ref.kind !== 'worktree' || known.has(root.ref.worktreeId)) continue;
      await this.ctx.roots.unregisterWorktree(root.ref.worktreeId).catch(() => {});
      this.ctx.log.warn('worktree root without a record unregistered; directory kept', { module: 'worktree', worktree: root.ref.worktreeId });
    }
    const before = doc.get().worktrees;
    if (keep.length !== before.length || keep.some((record, i) => record !== before[i])) {
      doc.update((draft) => {
        draft.worktrees = keep.map((record) => ({ ...record, sharedDirs: [...record.sharedDirs] }));
      });
      await doc.flush();
    }
  }

  // =================================================================================================================
  // Queries
  // =================================================================================================================

  list(): WorktreeInfo[] {
    return this.records()
      .slice(-LIST_MAX_ITEMS)
      .map(toWorktreeInfo);
  }

  get(worktreeId: string): WorktreeInfo | null {
    const record = this.record(worktreeId);
    return record ? toWorktreeInfo(record) : null;
  }

  listMerges(_principal: Principal): MergeRequest[] {
    return [...this.requireDoc().get().merges]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LIST_MAX_ITEMS)
      .map(toMergeRequest);
  }

  /** Why worktree mode is unavailable (null when it is available). */
  unavailableReason(): SmurgError | null {
    return this.available.ok ? null : this.available.error;
  }

  // =================================================================================================================
  // Sessions
  // =================================================================================================================

  acquireForSession(input: { readonly owner: Principal; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle> {
    const member = this.memberOf(input.owner);
    if (input.worktreeId !== undefined) {
      const worktreeId = input.worktreeId;
      return this.serial.run(`wt:${worktreeId}`, () => this.resume(member, worktreeId, input.sessionId));
    }
    return this.serial.run(`owner:${member.userId}`, () => this.create(member, input.sessionId));
  }

  async releaseFromSession(worktreeId: string, sessionId: string, options: { readonly keep: boolean }): Promise<void> {
    await this.serial.run(`wt:${worktreeId}`, async () => {
      const record = this.record(worktreeId);
      if (!record || record.sessionId !== sessionId) return; // released already, or taken over
      if (options.keep) {
        const updated = this.updateWorktree(worktreeId, (draft) => {
          delete draft.sessionId;
          draft.kept = true;
        });
        if (updated) this.publishWorktree(updated);
        await this.persist();
        return;
      }
      // session.end {keepWorktree: false}: the owner's decision (contract review C17).
      const owner = this.ctx.members.get(record.ownerUserId);
      await this.removeInternal(record, owner ? userActor(owner) : { kind: 'system' });
    });
  }

  private async resume(member: MemberRecord, worktreeId: string, sessionId: string): Promise<WorktreeHandle> {
    const record = this.record(worktreeId);
    if (!record) throw NOT_FOUND();
    if (record.ownerUserId !== member.userId) throw new AuthorizationError('只有 worktree 的擁有者可以在裡面開 session', { reason: 'not-owner:worktree' });
    if (record.sessionId !== undefined && record.sessionId !== sessionId && this.sessionLive(record.sessionId)) {
      throw new SmurgError('conflict', '這個 worktree 正被另一個 session 使用', { reason: 'worktree-in-use' });
    }
    this.requireAvailable();
    await verifyWorktreeRepo(this.dirOf(record.id), record);
    const root = this.ctx.roots.get({ kind: 'worktree', worktreeId }) ?? (await this.registerRoot(record));
    const updated = this.updateWorktree(worktreeId, (draft) => {
      draft.sessionId = sessionId;
      draft.kept = false;
    });
    if (!updated) throw NOT_FOUND();
    this.publishWorktree(updated);
    await this.persist();
    return { worktree: toWorktreeInfo(updated), root };
  }

  private async create(member: MemberRecord, sessionId: string): Promise<WorktreeHandle> {
    const { git, repo } = this.requireAvailable();
    const records = this.records();
    if (records.length >= this.limits.maxWorktrees) throw new SmurgError('conflict', 'worktree 數量已達上限，請先刪除不用的 worktree', { reason: 'worktree-limit' });
    if (records.filter((record) => record.ownerUserId === member.userId).length >= this.limits.maxWorktreesPerOwner) {
      throw new SmurgError('conflict', '你的 worktree 數量已達上限，請先刪除不用的 worktree', { reason: 'worktree-limit-owner' });
    }
    const base = await mainHead(repo);
    if (base === null) throw new SmurgError('conflict', '主工作區還沒有任何 commit，無法建立 worktree', { reason: 'no-commits' });
    const share = this.ctx.roots.main.realPath;
    if (!(await ensureWorktreesDir(share, this.ctx.roots.worktreesDir))) {
      throw new SmurgError('conflict', '.smurg/worktrees 不是一般的資料夾，無法建立 worktree', { reason: 'worktrees-dir-unusable' });
    }
    const id = newWorktreeId();
    const dir = this.dirOf(id);
    const gitDir = join(dir, '.git');
    const branch = worktreeBranch(member.userId, id);
    const timeoutMs = this.limits.gitTimeoutMs;
    let registered = false;
    try {
      requireOk(await git.clone({ source: share, dest: dir, cwd: this.ctx.roots.worktreesDir, template: this.templateDir, timeoutMs }), '建立 worktree');
      // The guest gets no remote pointing back at the host's repository.
      requireOk(await git.run({ gitDir, args: ['remote', 'remove', 'origin'], timeoutMs }), '設定 worktree');
      requireOk(await git.run({ gitDir, workTree: dir, args: ['checkout', '--quiet', '-b', branch, base], timeoutMs }), '取出檔案');
      const linked = await linkSharedDirs(dir, share, this.ctx.settings.get().sharedDirs);
      for (const skip of linked.skipped) this.ctx.log.warn('shared directory not linked', { module: 'worktree', worktree: id, path: skip.path, reason: skip.reason });
      await writeExclude(gitDir, linked.links);
      const hashes = await pinnedHashes(gitDir);
      const record: StoredWorktree = {
        id,
        ownerUserId: member.userId,
        ownerName: member.displayName,
        branch,
        sessionId,
        kept: false,
        createdAt: this.ctx.clock.now(),
        sharedDirs: linked.links.map((link) => link.mainPath),
        baseCommit: base,
        ...hashes,
      };
      const root = await this.registerRoot(record);
      registered = true;
      this.requireDoc().update((draft) => {
        draft.worktrees.push(record);
      });
      this.ctx.audit.record({
        actor: userActor(member),
        action: 'worktree.create',
        outcome: 'ok',
        target: id,
        detail: { worktreeId: id, branch, baseCommit: base, sessionId, sharedDirs: record.sharedDirs, skippedSharedDirs: linked.skipped.map((skip) => skip.path) },
      });
      this.publishWorktree(record);
      await this.persist();
      return { worktree: toWorktreeInfo(record), root };
    } catch (err) {
      if (registered) await this.ctx.roots.unregisterWorktree(id).catch(() => {});
      await removeWorktreeDir(this.ctx.roots.worktreesDir, id).catch(() => {});
      this.ctx.audit.record({ actor: userActor(member), action: 'worktree.create', outcome: 'error', target: id, detail: { worktreeId: id, reason: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : 'failed' } });
      if (err instanceof SmurgError) throw err;
      this.ctx.log.error('worktree creation failed', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      throw new SmurgError('internal', '無法建立 worktree', { reason: 'worktree-create-failed' });
    }
  }

  private registerRoot(record: StoredWorktree): Promise<RootInfo> {
    return this.ctx.roots.registerWorktree({
      worktreeId: record.id,
      dir: this.dirOf(record.id),
      ownerUserId: record.ownerUserId,
      sharedLinks: record.sharedDirs.map((path) => ({ path, mainPath: path })),
    });
  }

  // =================================================================================================================
  // Removal
  // =================================================================================================================

  async remove(worktreeId: string, principal: Principal): Promise<void> {
    const record = this.record(worktreeId);
    if (!record) throw NOT_FOUND();
    if (!isHostPrincipal(principal) && principal.userId !== record.ownerUserId) {
      throw new AuthorizationError('只有 worktree 的擁有者或主人可以刪除它', { reason: 'not-owner:worktree' });
    }
    await this.serial.run(`wt:${worktreeId}`, async () => {
      const current = this.record(worktreeId);
      if (!current) throw NOT_FOUND();
      if (current.sessionId !== undefined && this.sessionLive(current.sessionId)) {
        throw new SmurgError('conflict', '這個 worktree 正被 session 使用中，請先結束 session', { reason: 'worktree-in-use' });
      }
      await this.removeInternal(current, principal.actor);
    });
  }

  private async removeInternal(record: StoredWorktree, actor: Principal['actor']): Promise<void> {
    // PathGuard stops resolving the root first: nothing reads or writes a directory that is being deleted.
    await this.ctx.roots.unregisterWorktree(record.id);
    this.requireDoc().update((draft) => {
      draft.worktrees = draft.worktrees.filter((item) => item.id !== record.id);
    });
    this.ctx.bus.emit('worktree.changed', { worktreeId: record.id, worktree: null });
    this.ctx.hub.broadcast('worktree.removed', { worktreeId: record.id });
    await this.persist();
    let removed = true;
    try {
      await removeWorktreeDir(this.ctx.roots.worktreesDir, record.id);
    } catch (err) {
      removed = false;
      this.ctx.log.error('worktree directory removal failed', { module: 'worktree', worktree: record.id, error: err instanceof Error ? err.name : 'unknown' });
    }
    this.ctx.audit.record({ actor, action: 'worktree.remove', outcome: removed ? 'ok' : 'error', target: record.id, detail: { worktreeId: record.id, branch: record.branch, ownerUserId: record.ownerUserId } });
  }

  // =================================================================================================================
  // Merge requests
  // =================================================================================================================

  async requestMerge(input: PayloadOf<'worktree.merge.request'>, principal: Principal): Promise<MergeRequest> {
    const record = this.record(input.worktreeId);
    if (!record) throw NOT_FOUND();
    if (principal.userId === null || principal.userId !== record.ownerUserId) {
      throw new AuthorizationError('只有 worktree 的擁有者可以提出合併請求', { reason: 'not-owner:worktree' });
    }
    if (!principalCan(principal, 'worktree.merge.request')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const open = this.requireDoc()
      .get()
      .merges.filter((merge) => merge.worktreeId === record.id && (merge.status === 'pending' || merge.status === 'conflict')).length;
    if (open >= this.limits.maxOpenMergesPerWorktree) throw new SmurgError('conflict', '這個 worktree 待處理的合併請求太多了', { reason: 'too-many-open-merges' });
    const { git, repo } = this.requireAvailable();
    const member = this.memberOf(principal);
    const timeoutMs = this.limits.gitTimeoutMs;

    return this.serial.run(`wt:${record.id}`, async () => {
      const current = this.record(record.id);
      if (!current) throw NOT_FOUND();
      const dir = this.dirOf(current.id);
      await verifyWorktreeRepo(dir, current);
      // 1. Commit the working tree as the owner (nothing to commit is fine). Staged in a daemon-private store and,
      //    unless the host owns the worktree, verified blob by blob before the clone gets it (stage-commit.ts).
      const { commit } = await stageCommit({
        git,
        workTree: dir,
        branch: current.branch,
        identity: gitIdentity(member.userId, member.displayName),
        message: input.message?.trim() ? input.message : `smurg：${member.displayName} 的 worktree 變更`,
        stagingRoot: this.stagingDir,
        verify: !isHostPrincipal(principal),
        limits: { timeoutMs },
      });
      // 2. Bring exactly that commit into the main repository, under a ref of its own.
      return this.serial.run('main', async () => {
        const requestId = newMergeId();
        const ref = mergeRef(requestId);
        requireOk(
          await git.run({
            gitDir: repo.gitDir,
            args: ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-gc', dir, `+refs/heads/${current.branch}:${ref}`],
            timeoutMs,
            abortable: false,
          }),
          '把變更取回主工作區',
        );
        try {
          const fetched = firstLine(requireOk(await git.run({ gitDir: repo.gitDir, args: ['rev-parse', '--verify', `${ref}^{commit}`], readOnly: true }), '讀取 commit'));
          if (fetched !== commit) throw new SmurgError('conflict', 'worktree 在提出請求時被變更了，請再試一次', { reason: 'worktree-changed' });
          const head = await mainHead(repo);
          if (head === null) throw new SmurgError('conflict', '主工作區還沒有任何 commit', { reason: 'no-commits' });
          const files = await reviewFiles(repo, await reviewBase(repo, head, commit), commit);
          const violation = await checkMergePolicy(repo, files, isHostPrincipal(principal), timeoutMs);
          if (violation) {
            this.ctx.audit.record({
              actor: principal.actor,
              action: 'worktree.merge.request',
              outcome: 'denied',
              target: current.id,
              detail: { worktreeId: current.id, commit, reason: violation.reason, paths: violation.paths.slice(0, 20), count: violation.paths.length },
            });
            throw policyError(violation);
          }
          const stored: StoredMerge = {
            id: requestId,
            worktreeId: current.id,
            ownerUserId: current.ownerUserId,
            requestedBy: { userId: member.userId, displayName: member.displayName },
            ...(input.message !== undefined && input.message.length > 0 ? { message: input.message } : {}),
            commit,
            status: 'pending',
            createdAt: this.ctx.clock.now(),
          };
          this.storeMerge(stored);
          this.ctx.audit.record({
            actor: principal.actor,
            action: 'worktree.merge.request',
            outcome: 'ok',
            target: requestId,
            detail: { requestId, worktreeId: current.id, branch: current.branch, commit, files: files.length, ...(stored.message !== undefined ? { message: stored.message } : {}) },
          });
          this.publishMerge(stored, principal);
          await this.persist();
          return toMergeRequest(stored);
        } catch (err) {
          await this.deleteRef(repo, ref);
          throw err;
        }
      });
    });
  }

  async diff(input: PayloadOf<'worktree.merge.diff'>, principal: Principal): Promise<ResultInputOf<'worktree.merge.diff'>> {
    const merge = this.requireMergeVisible(input.requestId, principal);
    const { repo } = this.requireAvailable();
    const { base, files } = await this.review(repo, merge);
    const { diff, truncated } = await unifiedDiff(repo, base, merge.commit, this.limits.gitTimeoutMs);
    return { diff, truncated, files: files.map((entry) => entry.file) };
  }

  async fileDiff(input: PayloadOf<'worktree.merge.fileDiff'>, principal: Principal): Promise<ResultInputOf<'worktree.merge.fileDiff'>> {
    const merge = this.requireMergeVisible(input.requestId, principal);
    const { repo } = this.requireAvailable();
    const { base, files } = await this.review(repo, merge);
    // Only a path of this request's file list: never a pathspec the client made up.
    const entry = files.find((item) => item.file.path === input.path);
    if (!entry) throw new SmurgError('bad_request', '這個檔案不在合併請求的變更清單中', { reason: 'path-not-in-diff' });
    const { diff, truncated } = await singleFileDiff(repo, base, merge.commit, entry, this.limits.gitTimeoutMs);
    return { path: entry.file.path, diff, truncated, binary: entry.file.binary === true };
  }

  async approve(input: PayloadOf<'worktree.merge.approve'>, principal: Principal): Promise<MergeRequest> {
    if (!principalCan(principal, 'worktree.merge.decide') || principal.kind === 'system') throw new AuthorizationError(undefined, { reason: 'capability' });
    const { git, repo } = this.requireAvailable();
    return this.serial.run('main', async () => {
      const merge = this.requireMerge(input.requestId);
      if (merge.status !== 'pending' && merge.status !== 'conflict') throw new SmurgError('conflict', '這個合併請求已經處理過了', { reason: 'not-pending', status: merge.status });
      if (!(await commitExists(repo, merge.commit))) throw new SmurgError('conflict', '找不到這個合併請求的 commit', { reason: 'commit-gone' });
      const share = this.ctx.roots.main.realPath;
      const pre = await mainHead(repo);
      if (pre === null) throw new SmurgError('conflict', '主工作區還沒有任何 commit', { reason: 'no-commits' });
      await this.assertMainIdle(repo);
      const base = await reviewBase(repo, pre, merge.commit);
      const files = await reviewFiles(repo, base, merge.commit);
      // Policy again: the requester's role may have changed since the request.
      const violation = await checkMergePolicy(repo, files, this.ctx.members.roleOf(merge.requestedBy.userId) === 'host', this.limits.gitTimeoutMs);
      if (violation) {
        this.auditDecision(principal, merge, 'denied', { reason: violation.reason, paths: violation.paths.slice(0, 20) });
        throw policyError(violation);
      }
      const docs = this.ctx.services.docs;
      if (!isStubService(docs)) await docs.flushAll();

      // 1. Decide without touching the main workspace: merge-tree writes objects only.
      const timeoutMs = this.limits.mergeTimeoutMs;
      const trial = await git.run({
        gitDir: repo.gitDir,
        attrSource: pre,
        args: ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', pre, merge.commit],
        maxStdoutBytes: 64 * 1024 * 1024,
        timeoutMs,
      });
      if (trial.truncated || (trial.code !== 0 && trial.code !== 1)) requireOk(trial, '試算合併');
      const outcome = parseMergeTree(trial.stdout);
      if (trial.code === 1) return this.markConflict(principal, merge, outcome.conflicted.map((path) => path.path), 'conflict');

      // 2. What the merge would change in the main working tree: nothing locked, nothing with local changes.
      const changes = parseNameStatus(
        requireOk(await git.run({ gitDir: repo.gitDir, args: ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', pre, outcome.tree], readOnly: true, maxStdoutBytes: 64 * 1024 * 1024, timeoutMs }), '列出合併會改的檔案').stdout,
      ).map((change) => ({ letter: change.letter, path: change.path.path }));
      const touched = changes.map((change) => change.path);
      this.assertNotLocked(principal, merge, touched);
      // Uncommitted changes the merge would overwrite are the host's to handle first (git would refuse them too;
      // this names them), and so are untracked or IGNORED entries where the merge adds something: git would overwrite
      // an ignored file silently (SPEC goal 3: no silent overwrite). Names git cannot print as UTF-8 are left to git's
      // own refusal (recoverFailedMerge).
      const dirty = await this.dirtyPaths(repo, git, pre);
      const inTheWay = new Set(touched.filter((path) => dirty.has(path)));
      for (const path of await untrackedInTheWay(share, changes)) inTheWay.add(path);
      if (inTheWay.size > 0) return this.markConflict(principal, merge, [...inTheWay], 'local-changes');

      // 3. Merge exactly that commit. Attributes come from the host's own HEAD, never from the incoming commit: a
      //    guest's .gitattributes cannot pick a filter or merge driver of the host's config for the daemon to run.
      const fileService = this.ctx.services.files;
      if (!isStubService(fileService) && touched.length <= 5_000) for (const path of touched) fileService.expectChange({ root: MAIN_ROOT, path }, principal.actor);
      const host = this.memberOf(principal);
      const message = `合併 ${this.branchOf(merge)}（${merge.requestedBy.displayName}）${merge.message ? `\n\n${merge.message}` : ''}`;
      const result = await git.run({
        gitDir: repo.gitDir,
        workTree: share,
        attrSource: pre,
        identity: gitIdentity(host.userId, host.displayName),
        // --no-overwrite-ignore: the check above already names such files; this keeps git from overwriting one that
        // appeared since.
        args: ['merge', '--quiet', '--no-ff', '--no-edit', '--no-verify', '--no-stat', '--no-overwrite-ignore', '-m', message, merge.commit],
        timeoutMs,
        abortable: false,
      });
      if (result.code !== 0) return this.recoverFailedMerge(principal, merge, repo, git, pre);
      const post = await mainHead(repo);
      const updated = this.updateMerge(merge.id, (draft) => {
        draft.status = 'merged';
        draft.decidedAt = this.ctx.clock.now();
        delete draft.conflictFiles;
        if (post !== null && post !== pre) draft.mergeCommit = post;
      });
      this.auditDecision(principal, updated, 'ok', { files: touched.length, ...(updated.mergeCommit !== undefined ? { mergeCommit: updated.mergeCommit } : {}) });
      this.publishMerge(updated, principal);
      await this.persist();
      await this.deleteRef(repo, mergeRef(merge.id));
      return toMergeRequest(updated);
    });
  }

  async reject(input: PayloadOf<'worktree.merge.reject'>, principal: Principal): Promise<MergeRequest> {
    if (!principalCan(principal, 'worktree.merge.decide') || principal.kind === 'system') throw new AuthorizationError(undefined, { reason: 'capability' });
    return this.serial.run('main', async () => {
      const merge = this.requireMerge(input.requestId);
      if (merge.status !== 'pending' && merge.status !== 'conflict') throw new SmurgError('conflict', '這個合併請求已經處理過了', { reason: 'not-pending', status: merge.status });
      // The worktree is not touched at all (R9.3); only the main repository's review ref goes.
      const updated = this.updateMerge(merge.id, (draft) => {
        draft.status = 'rejected';
        draft.decidedAt = this.ctx.clock.now();
        if (input.reason !== undefined && input.reason.length > 0) draft.rejectReason = input.reason;
      });
      this.auditDecision(principal, updated, 'ok', input.reason !== undefined ? { reason: input.reason } : {});
      this.publishMerge(updated, principal);
      await this.persist();
      if (this.available.ok) await this.deleteRef(this.available.repo, mergeRef(merge.id));
      return toMergeRequest(updated);
    });
  }

  // ---- merge helpers ----------------------------------------------------------------------------------------------

  private async review(repo: MainRepo, merge: StoredMerge): Promise<{ base: string; files: ReviewFile[] }> {
    if (!(await commitExists(repo, merge.commit))) throw new SmurgError('not_found', '找不到這個合併請求的 commit', { reason: 'commit-gone' });
    // A merged request is shown against the main workspace as it was before the merge.
    const against = merge.status === 'merged' && merge.mergeCommit !== undefined ? `${merge.mergeCommit}^1` : await mainHead(repo);
    if (against === null) throw new SmurgError('conflict', '主工作區還沒有任何 commit', { reason: 'no-commits' });
    const base = await reviewBase(repo, against, merge.commit);
    return { base, files: await reviewFiles(repo, base, merge.commit, DEFAULT_REVIEW_LIMITS) };
  }

  private async assertMainIdle(repo: MainRepo): Promise<void> {
    for (const marker of BUSY_MARKERS) {
      if ((await lstat(join(repo.gitDir, marker)).catch(() => null)) !== null) {
        throw new SmurgError('conflict', '主工作區正在進行其他 git 操作（merge、rebase 等），請先完成再合併', { reason: 'main-busy', marker });
      }
    }
  }

  private assertNotLocked(principal: Principal, merge: StoredMerge, touched: readonly string[]): void {
    const locks = this.ctx.services.locks;
    if (isStubService(locks)) return; // no lock manager composed: no lock can exist
    const locked = touched.filter((path) => locks.get({ root: MAIN_ROOT, path }) !== null);
    if (locked.length === 0) return;
    const first = locks.get({ root: MAIN_ROOT, path: locked[0] as string });
    this.auditDecision(principal, merge, 'denied', { reason: 'files-locked', paths: locked.slice(0, 20) });
    throw new SmurgError('locked', `合併會修改正被編輯或鎖定的檔案，請等它們釋放後再試：${locked.slice(0, 10).join('、')}`, {
      reason: 'files-locked',
      paths: locked.slice(0, 20),
      count: locked.length,
      ...(first ? { lock: first } : {}),
    });
  }

  /**
   * Paths with uncommitted changes (index or working tree, untracked included) in the main workspace. `status` runs
   * clean filters on modified files: attributes come from the host's HEAD, not from a .gitattributes a member wrote.
   */
  private async dirtyPaths(repo: MainRepo, git: GitRunner, attrSource: string): Promise<Set<string>> {
    const result = requireOk(
      await git.run({
        gitDir: repo.gitDir,
        workTree: this.ctx.roots.main.realPath,
        attrSource,
        // Never descend into nested repositories: `status` would run there with THEIR config (core.fsmonitor, …).
        args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
        readOnly: true,
        maxStdoutBytes: this.limits.statusOutputBytes,
        timeoutMs: this.limits.mergeTimeoutMs,
      }),
      '檢查主工作區',
    );
    return new Set(parseStatusPaths(result.stdout));
  }

  /** `git merge` failed after merge-tree said it would not: a conflict that appeared meanwhile, or a refusal. */
  private async recoverFailedMerge(principal: Principal, merge: StoredMerge, repo: MainRepo, git: GitRunner, pre: string): Promise<MergeRequest> {
    const head = await lstat(join(repo.gitDir, 'MERGE_HEAD')).catch(() => null);
    if (head !== null) {
      const workTree = this.ctx.roots.main.realPath;
      const unmerged = await git.run({ gitDir: repo.gitDir, workTree, attrSource: pre, args: ['diff', '--name-only', '-z', '--diff-filter=U', '--no-ext-diff', '--ignore-submodules=all'], readOnly: true, maxStdoutBytes: 16 * 1024 * 1024 });
      const conflicted = unmerged.code === 0 && !unmerged.truncated ? parseNameOnly(unmerged.stdout).map((path) => path.path) : [];
      // Our own merge created this state: undo it so the main workspace is as it was.
      await git.run({ gitDir: repo.gitDir, workTree, attrSource: pre, args: ['merge', '--abort'], timeoutMs: this.limits.mergeTimeoutMs, abortable: false });
      return this.markConflict(principal, merge, conflicted, 'conflict');
    }
    const now = await mainHead(repo);
    this.ctx.log.error('merge failed', { module: 'worktree', request: merge.id, headMoved: now !== pre });
    this.auditDecision(principal, merge, 'error', { reason: 'merge-failed' });
    throw new SmurgError('conflict', '合併失敗，主工作區沒有被修改；請檢查主工作區的狀態後再試', { reason: 'merge-failed' });
  }

  private async markConflict(principal: Principal, merge: StoredMerge, paths: readonly string[], reason: 'conflict' | 'local-changes'): Promise<MergeRequest> {
    const updated = this.updateMerge(merge.id, (draft) => {
      draft.status = 'conflict';
      draft.decidedAt = this.ctx.clock.now();
      draft.conflictFiles = [...new Set(paths)].slice(0, MERGE_FILES_MAX);
    });
    this.auditDecision(principal, updated, 'error', { reason, conflictFiles: (updated.conflictFiles ?? []).slice(0, 50), count: updated.conflictFiles?.length ?? 0 });
    this.publishMerge(updated, principal);
    await this.persist();
    return toMergeRequest(updated);
  }

  private auditDecision(principal: Principal, merge: StoredMerge, outcome: 'ok' | 'denied' | 'error', detail: Record<string, unknown>): void {
    const action = merge.status === 'rejected' ? 'worktree.merge.reject' : 'worktree.merge.approve';
    this.ctx.audit.record({
      actor: principal.actor,
      action,
      outcome,
      target: merge.id,
      detail: { requestId: merge.id, worktreeId: merge.worktreeId, commit: merge.commit, status: merge.status, requestedBy: merge.requestedBy.userId, ...detail },
    });
  }

  private async deleteRef(repo: MainRepo, ref: string): Promise<void> {
    const result = await repo.git.run({ gitDir: repo.gitDir, args: ['update-ref', '-d', ref], abortable: false }).catch(() => null);
    if (result === null || result.code !== 0) this.ctx.log.warn('merge ref not deleted', { module: 'worktree', ref });
  }

  private branchOf(merge: StoredMerge): string {
    return this.record(merge.worktreeId)?.branch ?? `worktree ${merge.worktreeId}`;
  }

  private storeMerge(merge: StoredMerge): void {
    this.requireDoc().update((draft) => {
      draft.merges.push(merge);
      const decided = draft.merges.filter((item) => item.status === 'merged' || item.status === 'rejected');
      const excess = decided.length - this.limits.maxDecidedMerges;
      if (excess > 0) {
        const drop = new Set(decided.sort((a, b) => a.createdAt - b.createdAt).slice(0, excess).map((item) => item.id));
        draft.merges = draft.merges.filter((item) => !drop.has(item.id));
      }
    });
  }

  private requireMerge(requestId: string): StoredMerge {
    const merge = this.requireDoc()
      .get()
      .merges.find((item) => item.id === requestId);
    if (!merge) throw MERGE_NOT_FOUND();
    return merge;
  }

  /** merge-request-owner-or-host: the worktree's owner or the host. */
  private requireMergeVisible(requestId: string, principal: Principal): StoredMerge {
    const merge = this.requireMerge(requestId);
    if (!isHostPrincipal(principal) && principal.userId !== merge.ownerUserId) {
      throw new AuthorizationError('只有 worktree 的擁有者或主人可以查看這個 diff', { reason: 'not-owner:merge-request' });
    }
    return merge;
  }

  // =================================================================================================================
  // State
  // =================================================================================================================

  /**
   * Writes worktrees.json. Every change is audited and published BEFORE this runs, and a failed write is logged, not
   * thrown: the in-memory document stays authoritative (the next change rewrites the whole file), and what git did
   * (a clone, a commit, a merge into the host's workspace) cannot be undone by an error answer.
   */
  private async persist(): Promise<void> {
    try {
      await this.requireDoc().flush();
    } catch (err) {
      this.ctx.log.error('worktrees.json write failed', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private requireDoc(): PersistentDocument<WorktreesDocument> {
    if (!this.doc) throw new SmurgError('internal', 'worktree 功能尚未就緒', { reason: 'not-started' });
    return this.doc;
  }

  private records(): readonly StoredWorktree[] {
    return this.doc?.get().worktrees ?? [];
  }

  private record(worktreeId: string): StoredWorktree | null {
    return this.records().find((record) => record.id === worktreeId) ?? null;
  }

  /** The owner / merge-request owner of a merge request (for handlers' ownership checks). */
  mergeOwner(requestId: string): string | null {
    return this.doc?.get().merges.find((item) => item.id === requestId)?.ownerUserId ?? null;
  }

  private updateWorktree(worktreeId: string, mutate: (draft: StoredWorktree) => void): StoredWorktree | null {
    this.requireDoc().update((draft) => {
      const item = draft.worktrees.find((record) => record.id === worktreeId);
      if (item) mutate(item);
    });
    return this.record(worktreeId);
  }

  private updateMerge(requestId: string, mutate: (draft: StoredMerge) => void): StoredMerge {
    this.requireDoc().update((draft) => {
      const item = draft.merges.find((merge) => merge.id === requestId);
      if (item) mutate(item);
    });
    return this.requireMerge(requestId);
  }

  private publishWorktree(record: StoredWorktree): void {
    const worktree = toWorktreeInfo(record);
    this.ctx.bus.emit('worktree.changed', { worktreeId: record.id, worktree });
    this.ctx.hub.broadcast('worktree.updated', { worktree });
  }

  /** `by`: a request or decision someone just made, which also goes into everyone's activity feed (review WEB-11). */
  private publishMerge(merge: StoredMerge, by?: Principal): void {
    const request = toMergeRequest(merge);
    this.ctx.bus.emit('merge.changed', { request });
    this.ctx.hub.broadcast('worktree.merge.updated', { request });
    if (by !== undefined) this.mergeActivity(merge, by);
  }

  private mergeActivity(merge: StoredMerge, by: Principal): void {
    const activity = this.ctx.services.activity;
    if (isStubService(activity)) return;
    const requester = merge.requestedBy.displayName;
    const summary =
      merge.status === 'pending'
        ? '請求把自己的 worktree 合併到主工作區'
        : merge.status === 'merged'
          ? `把${requester}的 worktree 合併到主工作區`
          : merge.status === 'rejected'
            ? `拒絕合併${requester}的 worktree`
            : `合併${requester}的 worktree 時發生衝突（${merge.conflictFiles?.length ?? 0} 個檔案），主工作區沒有改變`;
    try {
      activity.record({ actor: by.actor, kind: 'merge', summary });
    } catch (err) {
      this.ctx.log.error('merge activity failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private requireAvailable(): { git: GitRunner; repo: MainRepo } {
    if (this.stopped) throw new SmurgError('conflict', 'daemon 正在停止', { reason: 'stopping' });
    if (!this.available.ok) throw this.available.error;
    return { git: this.available.git, repo: this.available.repo };
  }

  private dirOf(worktreeId: string): string {
    return join(this.ctx.roots.worktreesDir, worktreeId);
  }

  private memberOf(principal: Principal): MemberRecord {
    const member = principal.kind === 'user' && principal.userId !== null ? this.ctx.members.active(principal.userId) : null;
    if (!member) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
    return member;
  }

  private sessionLive(sessionId: string): boolean {
    const sessions = this.ctx.services.sessions;
    if (isStubService(sessions)) return false;
    const session = sessions.get(sessionId);
    return session !== null && session.status !== 'exited';
  }
}

export { GitUnavailableError };
