// WorktreeManager (SPEC R9, D6, D12; ARCHITECTURE §5.7, §5.10, §11 D-2). A "worktree" is a shared clone at
// <share>/.smurg/worktrees/<id> on its own branch, started at the main workspace's HEAD: objects are shared read-only
// through alternates, so a session in it never writes into the main repository (§11 D-2). Each worktree is registered
// as a root (with its read-only shared links) BEFORE any session or client uses it, and unregistered when it is
// removed. There are two kinds:
//  - a SESSION's worktree (`session.create {mode: 'worktree'}`), on smurg/<owner>/<id>: kept or removed when its
//    session ends, at most `maxWorktreesPerOwner` per member;
//  - a WORK ITEM's worktree (`acquireForItem`), on smurg/<topic slug>/<item id>: the item's, not a session's. A retry
//    reuses it, no session's end removes it, only `releaseItem` (merged and reviewed, or archived) and an explicit
//    removal do; it does not count toward the owner's limit. Its root carries the item, so PathGuard lets no person
//    write the topic's folder there.
//
// Merge flow (contract review C6): a request (by any member with worktree.merge.request: the host, Agent access,
// §11 D-15) commits the worktree's working tree as the requester and fetches that commit into
// refs/smurg/merge/<requestId> of the main repository; diff, fileDiff and approve work on exactly that commit. The
// commit is staged in a daemon-private object store and, unless the host requested it, verified blob by blob against
// the worktree before the clone gets it (stage-commit.ts: git could be raced into reading a file outside the
// worktree). The HOST approves: `git merge-tree` decides first, without touching the main workspace,
// so a conflicting merge leaves it exactly as it was and lists the conflicting files; so do local changes, untracked
// or ignored files the merge would overwrite (git overwrites ignored ones silently); a clean one is merged with
// `git merge`. Rejecting never touches the worktree.
//
// A work item's changes are a merge request too (protocol 4): `snapshot` is the same first half, run by the daemon,
// and makes a request in the state `draft` (nobody asked yet). A new snapshot REPLACES the worktree's earlier draft
// and a request of it that ended in a conflict: they are removed, under a new id, never changed in place, because the
// host merges exactly the commit they reviewed (an approve of a replaced request answers "not found"). The host may
// approve a draft directly; `worktree.merge.request` turns the draft with the working tree's commit into a pending
// request under the same id.
//
// A conflict (ARCHITECTURE §7.8 "A conflict"): `updateFromMain` commits the worktree's work, merges the main
// workspace's HEAD into the working tree without committing and remembers that HEAD; the next commit of the working
// tree has it as second parent and is refused while a conflicted file still has a marker line (update-from-main.ts).
//
// The folder while it is shared (0.5.2): whether `<share>/.git` is a repository is looked at again (refreshGitState)
// when Start asks (mainState), when a worktree is acquired, before a merge request is made, shown or decided, before
// a snapshot, an update from the main workspace and a commit or diff of the main workspace's files, by the
// scheduler's pin check and every few seconds on the topics module's sweep: file calls only while nothing changed.
// A look that failed is tried again by each of these but the sweep. A repository that appeared gets the exclude line and
// the detection of git (the git executable, its version, the worktrees folder): worktree mode can become available
// without a restart. A `.git` that went, or that is no plain git directory any more, makes worktree mode unavailable;
// nothing is deleted or moved (worktrees, kept worktrees and merge requests stay as records). The git executable is
// looked for only at the start, when a repository appears, and once when a folder that is no repository is first
// asked about: never on a timer (on a Mac without the Command Line Tools, running /usr/bin/git puts a system prompt on
// the host's screen).
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ITEM_ID_PATTERN,
  LIST_MAX_ITEMS,
  MAIN_ROOT,
  MERGE_FILES_MAX,
  REPORT_BY_HAND_MAX,
  REVIEWERS_MAX,
  SmurgError,
  TOPIC_SLUG_PATTERN,
  foldRelPath,
  isInTopicDir,
  isRelPathWithin,
  isSessionOver,
  mergeMessageSchema,
  opaqueIdSchema,
  topicReportPath,
  type MergeRequest,
  type PayloadOf,
  type ResultInputOf,
  type UserRef,
  type WorktreeInfo,
} from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { DaemonEvents, MainState, MemberRecord, PersistentDocument, Principal, RootInfo, SnapshotResult, WorktreeHandle, WorktreeManager } from '../core/interfaces.ts';
import { SYSTEM_ACTOR, isHostPrincipal, principalCan, userActor } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { excludeSmurgDir, isRepositoryFolder, observeGit, sameGitObservation, type GitObservation } from '../workspace/share.ts';
import { ensureWorktreesDir, filesWithConflictMarkers, linkSharedDirs, removeEntryBelow, removeWorktreeDir, sweepRemovals, untrackedInTheWay, writeExclude } from './fs-ops.ts';
import { GIT_MIN_VERSION, GitRunner, GitUnavailableError, findGit, firstLine, gitVersionAtLeast, listedPaths, requireOk, type GitIdentity } from './git.ts';
import { parseMergeTree, parseNameOnly, parseNameStatus, parseStatusPaths } from './git-parse.ts';
import { pinnedHashes, verifyWorktreeRepo } from './integrity.ts';
import { blobsAt, busyMarker, commitMainPaths, currentBranch, diffMainPaths } from './main-repo.ts';
import { MERGE_REF_PREFIX, gitIdentity, itemBranch, mergeRef, newMergeId, newWorktreeId, worktreeBranch } from './names.ts';
import {
  DEFAULT_REVIEW_LIMITS,
  checkMergePolicy,
  commitExists,
  isWithheldFile,
  mainHead,
  policyError,
  reviewBase,
  reviewFiles,
  singleFileDiff,
  unifiedDiff,
  unifiedDiffOfFiles,
  withheldEntry,
  type MainRepo,
  type PolicyViolation,
  type ReviewFile,
} from './review.ts';
import { KeyedSerializer } from './serial.ts';
import { stageCommit, sweepStaging } from './stage-commit.ts';
import {
  HAND_EDIT_PATHS_MAX,
  WORKTREES_DOCUMENT,
  initialWorktreesDocument,
  toMergeRequest,
  toWorktreeInfo,
  worktreesDocumentSchema,
  type StoredItem,
  type StoredMerge,
  type StoredWorktree,
  type WorktreesDocument,
} from './store.ts';
import { mergeMainIntoWorktree } from './update-from-main.ts';

export interface WorktreeLimits {
  /** Every worktree of the workspace, work items' included. */
  readonly maxWorktrees: number;
  /** Session worktrees per member (a work item's worktree does not count). */
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
  /**
   * How long after the last write in a work item's worktree the daemon looks (one `git status`) whether the tree
   * still differs from its last commit: until then it counts as holding unmerged work.
   */
  readonly treeCheckDelayMs: number;
}

export const DEFAULT_WORKTREE_LIMITS: WorktreeLimits = Object.freeze({
  maxWorktrees: 64,
  maxWorktreesPerOwner: 8,
  maxOpenMergesPerWorktree: 20,
  maxDecidedMerges: 300,
  gitTimeoutMs: 120_000,
  mergeTimeoutMs: 300_000,
  statusOutputBytes: 32 * 1024 * 1024,
  treeCheckDelayMs: 2_000,
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

/** What the git executable was found to be: at the start, when a repository appeared, or once when first asked. */
type GitBinary = { readonly kind: 'ok'; readonly version: string } | { readonly kind: 'not-found' } | { readonly kind: 'cannot-run' } | { readonly kind: 'too-old'; readonly version: string };

const MIN_VERSION_TEXT = GIT_MIN_VERSION.join('.');

/** Why the git executable cannot be used (null: it can). */
function binaryUnavailable(binary: GitBinary): Extract<Available, { ok: false }> | null {
  switch (binary.kind) {
    case 'ok':
      return null;
    case 'not-found':
      return notAvailable('git-not-found', msg('worktree.unavailable.gitNotFound', { minVersion: MIN_VERSION_TEXT }));
    case 'cannot-run':
      return notAvailable('git-unusable', msg('worktree.unavailable.gitCannotRun'));
    case 'too-old':
      return notAvailable('git-too-old', msg('worktree.unavailable.gitTooOld', { version: binary.version, minVersion: MIN_VERSION_TEXT }));
  }
}

/**
 * Why `<share>/.git` as it is seen cannot hold worktrees (null: it is a plain git directory). Nothing there, or a
 * directory git does not take for a repository (no HEAD): not a repository yet (`git init` makes it one). A gitfile
 * (a linked worktree, a submodule), a link, or anything else: not an ordinary folder. The second is exactly what
 * people are told is a repository (isRepositoryFolder: `WorkspaceInfo.isGitRepo`), so no page says "run git init"
 * where this says the `.git` is not an ordinary folder.
 */
function folderUnavailable(observed: GitObservation): Extract<Available, { ok: false }> | null {
  if (observed.kind === 'dir' && observed.plain) return null;
  if (isRepositoryFolder(observed)) return notAvailable('git-dir-not-directory', msg('worktree.unavailable.gitDirNotDirectory'));
  return notAvailable('not-a-git-repo', msg('worktree.unavailable.notAGitRepo'));
}

/** How many times one look at `.git` detects again when `.git` changed while git ran (then the look failed). */
const GIT_LOOKS_MAX = 3;

/**
 * Commit messages smurg writes itself are fixed English (one shared git history; DESIGN A.5). A message the member
 * typed is used as it is.
 */
export function worktreeCommitMessage(displayName: string): string {
  return `smurg: worktree changes by ${displayName}`;
}

export function mergeCommitMessage(branch: string, requesterName: string, body: string | undefined): string {
  return `Merge ${branch} (${requesterName})${body ? `\n\n${body}` : ''}`;
}

/** The commit `updateFromMain` makes of the worktree's work before it merges the main workspace into it. */
export const UPDATE_COMMIT_MESSAGE = 'smurg: work before merging the main workspace';

function notAvailable(reason: string, message: MessageRef): Extract<Available, { ok: false }> {
  return { ok: false, error: new SmurgError('conflict', message, { reason }) };
}

const NOT_FOUND = (): SmurgError => new SmurgError('not_found', msg('worktree.notFound'), { reason: 'unknown-worktree' });
const MERGE_NOT_FOUND = (): SmurgError => new SmurgError('not_found', msg('merge.notFound'), { reason: 'unknown-merge-request' });

/** A commit of the working tree is refused while files the daemon merged still have conflict markers. */
function markersError(files: readonly string[]): SmurgError {
  return new SmurgError('conflict', msg('report.changes.markers', { files: listedPaths(files) }), { reason: 'conflict-markers', paths: files.slice(0, 20), count: files.length });
}

/** Activity kinds that are a person's own edit of a file (`ReportInfo.changes.byHand`). */
const HAND_EDIT_KINDS: ReadonlySet<string> = new Set(['human.edit', 'file.create', 'file.delete', 'file.rename', 'file.upload']);

/** Paths a refused snapshot names (`SnapshotResult.files`). */
const SNAPSHOT_FILES_MAX = 50;

/**
 * What the daemon knows about a work item's working tree without running git (`unmerged` is asked synchronously): the
 * branch head it last saw, and whether the tree differs from that commit. A write in the tree (the watcher, an
 * agent's tool, the activity feed) sets `dirty` at once; a little after the last write the daemon looks with
 * `git status` and corrects it (an edit that was taken back, an event that arrived after the commit that already
 * holds it). No entry: not looked at yet (after a restart, until the check in the background has run), which counts
 * as "may hold unmerged work".
 */
interface TreeState {
  head: string;
  dirty: boolean;
}

type Committed = { readonly commit: string; readonly created: boolean } | { readonly markers: string[] };

/** The host deciding a request, and `whose` work the activity feed then names. */
interface Decider {
  readonly principal: Principal;
  readonly whose: string;
}

export class WorktreeManagerImpl implements WorktreeManager {
  private readonly ctx: DaemonContext;
  private readonly options: WorktreeModuleOptions;
  readonly limits: WorktreeLimits;
  private doc: PersistentDocument<WorktreesDocument> | null = null;
  private available: Available = notAvailable('starting', msg('worktree.unavailable.starting'));
  /** What the git executable is, whatever the folder is; null: not looked for yet. */
  private gitBinary: GitBinary | null = null;
  /** The one look for the git executable a folder that is no repository gets (mainState), while it runs. */
  private binaryLook: Promise<GitBinary> | null = null;
  /** What the last look at `<share>/.git` saw (null: not looked yet); `observedFailed`: the detection after it threw. */
  private observed: GitObservation | null = null;
  private observedFailed = false;
  /** The look at `<share>/.git` that is running (callers at the same time share it). */
  private refreshing: Promise<void> | null = null;
  /** The running look is the sweep's (`timer`): it does not repeat a look that failed, so a request does not share it then. */
  private refreshingForSweep = false;
  /** The stray review refs were swept in this run (once, the first time worktree mode is available). */
  private refsSwept = false;
  /** The host was told that the repository tracks files below `.smurg/` (once a run). */
  private smurgTrackedTold = false;
  private templateDir = '';
  /** Daemon-private staging stores of merge-request commits (stage-commit.ts) and of diffs of main files. */
  private stagingDir = '';
  private readonly serial = new KeyedSerializer();
  private readonly trees = new Map<string, TreeState>();
  /** Writes seen per worktree: a look at a tree counts only when none arrived while it ran. */
  private readonly writes = new Map<string, number>();
  /** The pending look at a tree after its last write (one timer per item worktree, restarted by every write). */
  private readonly treeChecks = new Map<string, ReturnType<typeof setTimeout>>();
  private inspection: Promise<void> = Promise.resolve();
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
    // The start's look at `.git` is the first shared look: a refresh asked while it runs (the topics module's sweep
    // ticks from its registration on) waits for it, rather than looking beside it and being overwritten by it.
    const look = this.firstLook();
    this.refreshing = look;
    await look;
    if (this.refreshing === look) this.refreshing = null;
    await this.reconcile();
    if (this.available.ok) this.refsSwept = true;
    // What the item worktrees hold is looked at in the background: until then `unmerged` lists them all. So is
    // whether the repository tracks smurg's own folder (the host is told once).
    const available = this.available;
    const previous = this.inspection;
    this.inspection = Promise.all([previous, this.inspectItemWorktrees(), available.ok ? this.lookForTrackedSmurg(available) : undefined]).then(() => {});
  }

  /**
   * The start's look at `.git` and at git (never rejects). A look that threw is one that failed, like a later one
   * (lookAgain): worktree mode is off with "try again in a moment", and the next request looks again (the sweep does
   * not). It is not "git does not run": git may be fine, and only sharing again would get past that sentence.
   */
  private async firstLook(): Promise<void> {
    const seen: { observed: GitObservation | null } = { observed: null };
    try {
      const available = await this.detectSettled(await observeGit(this.ctx.roots.main.realPath), { atStart: true }, seen);
      this.available = available;
    } catch (err) {
      this.ctx.log.error('the shared folder\'s git state could not be looked at when sharing started; worktree mode is off until a request looks again', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      this.available = notAvailable('check-failed', msg('worktree.unavailable.checkFailed'));
      this.observedFailed = true;
    }
    if (seen.observed !== null) {
      this.observed = seen.observed;
      this.ctx.workspace.noteGitRepo(isRepositoryFolder(seen.observed));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.treeChecks.values()) clearTimeout(timer);
    this.treeChecks.clear();
    // Operations on the main repository run to their end (a killed merge would leave the host's repo half-merged); so
    // does a look at `.git` that is under way (it assigns nothing once the module stopped).
    await Promise.race([Promise.all([this.serial.idle(), this.inspection, this.refreshing]), new Promise((resolve) => setTimeout(resolve, 15_000).unref?.())]);
    await this.doc?.flush().catch(() => {});
  }

  /** Resolves when the check of the item worktrees after a start (or after worktree mode became available) has finished (tests). */
  inspected(): Promise<void> {
    return this.inspection;
  }

  /**
   * Whether worktree mode can run in the folder as it was seen: the folder first (no git process for a folder that is
   * no repository), then the git executable (found on the daemon's PATH, runs, new enough), then the worktrees folder.
   * Only at the start are the daemon's staging stores swept: later, a commit or a diff could be using them.
   */
  private async detect(observed: GitObservation, options: { readonly atStart: boolean }): Promise<Available> {
    const ctx = this.ctx;
    const folder = folderUnavailable(observed);
    if (folder !== null) return folder;
    const share = ctx.roots.main.realPath;
    const gitDir = join(share, '.git');
    const gitPath = this.options.gitPath ?? (await findGit(process.env['PATH']));
    if (gitPath === null) {
      this.gitBinary = { kind: 'not-found' };
      return binaryUnavailable(this.gitBinary) as Available;
    }
    const home = await ctx.state.privateDir('git-home');
    this.templateDir = await ctx.state.privateDir('git-template');
    this.stagingDir = await ctx.state.privateDir('git-staging');
    if (options.atStart) await sweepStaging(this.stagingDir);
    const git = new GitRunner({ gitPath, home, signal: ctx.stopping });
    this.gitBinary = binaryOf(await git.version().catch(() => null));
    const binary = binaryUnavailable(this.gitBinary);
    if (binary !== null) return binary;
    if (!(await ensureWorktreesDir(share, ctx.roots.worktreesDir))) {
      return notAvailable('worktrees-dir-unusable', msg('worktree.unavailable.worktreesDirUnusable'));
    }
    return { ok: true, git, repo: { git, gitDir } };
  }

  /**
   * The git executable (`mainState().gitOk`, and the first reason Start names), also when the folder is no repository:
   * looked for once in a run when nothing has looked yet, never again on a timer or on a request.
   */
  private gitBinaryNow(): Promise<GitBinary> {
    if (this.gitBinary !== null) return Promise.resolve(this.gitBinary);
    this.binaryLook ??= (async (): Promise<GitBinary> => {
      let binary: GitBinary;
      try {
        const gitPath = this.options.gitPath ?? (await findGit(process.env['PATH']));
        binary = gitPath === null ? { kind: 'not-found' } : binaryOf(await new GitRunner({ gitPath, home: await this.ctx.state.privateDir('git-home'), signal: this.ctx.stopping }).version().catch(() => null));
      } catch {
        binary = { kind: 'cannot-run' };
      }
      this.gitBinary ??= binary;
      return this.gitBinary;
    })();
    return this.binaryLook;
  }

  /**
   * Looks at `<share>/.git` again (WorktreeManager.refreshGitState). `timer`: the topics module's sweep, which never
   * repeats a detection that threw (it would run git every few seconds); a request does (Start, a worktree asked
   * for, a merge request made, shown or decided, a snapshot, an update from the main workspace: availableNow).
   * Callers at the same time share one look, but for one case: a request that finds the sweep's look running after a
   * look that failed waits for it and then looks itself (the sweep's look leaves the failure as it is, and the request
   * would be refused with "try again in a moment" for a folder that is fine). Never rejects.
   */
  refreshGitState(options: { readonly timer?: boolean } = {}): Promise<void> {
    if (this.stopped || this.doc === null) return Promise.resolve();
    const timer = options.timer === true;
    if (this.refreshing !== null) {
      if (timer || !this.refreshingForSweep || !this.observedFailed) return this.refreshing;
      return this.refreshing.then(() => this.refreshGitState());
    }
    this.refreshingForSweep = timer;
    const run = this.lookAgain(timer)
      .catch((err: unknown) => {
        // What lookAgain's catch left: worktree mode that was available stays available; one that was not says "try
        // again in a moment" (check-failed), and whether the folder is a repository follows what was seen.
        this.ctx.log.warn('the shared folder\'s git state could not be looked at; worktree mode stays on if it was on, and is off until a request looks again otherwise', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      })
      .finally(() => {
        if (this.refreshing === run) this.refreshing = null;
      });
    this.refreshing = run;
    return run;
  }

  private async lookAgain(timer: boolean): Promise<void> {
    const first = await observeGit(this.ctx.roots.main.realPath);
    const before = this.observed;
    if (this.stopped || (before !== null && sameGitObservation(first, before) && (!this.observedFailed || timer))) return;
    const seen: { observed: GitObservation | null } = { observed: first };
    let available: Available;
    try {
      // `.git` went, or is no plain git directory any more: worktree mode is off, with no git process. Nothing is
      // deleted or moved: the worktrees, kept worktrees and merge requests stay as records (they work again when the
      // repository is back). A plain git directory appeared, or `.git` is another one now: git is looked for (the
      // host just ran it there).
      available = await this.detectSettled(first, { atStart: false }, seen);
      // The first time worktree mode is available in this run: the review refs a crash left behind (on the main
      // queue: no request is between its fetch and its record). A request's ref can only be made while worktree mode
      // is available, so after a first sweep there is nothing left to sweep.
      if (available.ok && !this.refsSwept && !this.stopped) {
        const ready = available;
        await this.serial.run('main', () => this.sweepReviewRefs(ready));
        this.refsSwept = true;
      }
    } catch (err) {
      if (!this.stopped && seen.observed !== null) {
        // What was known stays when it was "available" (a request tries again). A reason found earlier is about the
        // `.git` that was there then: Start says to try again in a moment, not, say, "not a git repository" in a
        // folder that is one.
        this.observed = seen.observed;
        this.observedFailed = true;
        this.ctx.workspace.noteGitRepo(isRepositoryFolder(seen.observed));
        if (!this.available.ok) this.available = notAvailable('check-failed', msg('worktree.unavailable.checkFailed'));
      }
      throw err;
    }
    if (this.stopped || seen.observed === null) return;
    this.observed = seen.observed;
    this.observedFailed = false;
    this.ctx.workspace.noteGitRepo(isRepositoryFolder(seen.observed));
    const previous = this.available;
    this.available = available;
    const reasonOf = (state: Available): string => (state.ok ? 'available' : String(state.error.detail?.['reason']));
    if (reasonOf(previous) !== reasonOf(available)) {
      this.ctx.log.info(available.ok ? 'worktree mode is available' : 'worktree mode is unavailable', { module: 'worktree', ...(available.ok ? {} : { reason: reasonOf(available) }) });
    }
    if (available.ok && !previous.ok) {
      // What start() looks at once worktree mode is available, safe at any time: the item worktrees not looked at
      // yet (read-only, each on its own queue) and whether the repository tracks smurg's own folder (told once).
      // Never the sweeps of interrupted removals and of the staging stores: now they could delete work in flight.
      const inspection = this.inspection;
      this.inspection = Promise.all([inspection, this.inspectItemWorktrees(), this.lookForTrackedSmurg(available)]).then(() => {});
    }
  }

  /**
   * Worktree mode on `.git` as it was seen: the folder first (no git process for one that is no plain git directory),
   * then git, on the main repository's queue. Once git has answered, `.git` is looked at again: one that changed
   * meanwhile (moved away, replaced by a link or by another repository) is looked at anew, at most GIT_LOOKS_MAX
   * times, so the answer is about the `.git` that is there. `seen.observed` is the last observation (what a look that
   * throws keeps).
   */
  private async detectSettled(first: GitObservation, options: { readonly atStart: boolean }, seen: { observed: GitObservation | null }): Promise<Available> {
    const share = this.ctx.roots.main.realPath;
    let observed = first;
    seen.observed = observed;
    for (let round = 1; ; round++) {
      const folder = folderUnavailable(observed);
      if (folder !== null) return folder;
      // smurg's folder is kept out of a repository that appeared while sharing (prepareShare did it for the one that
      // was there at the start), before git runs there.
      if (!options.atStart || round > 1) {
        await excludeSmurgDir(join(share, '.git')).catch((err: unknown) =>
          this.ctx.log.warn('.smurg could not be added to .git/info/exclude', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' }),
        );
      }
      const detecting = observed;
      const available = await this.serial.run('main', () => this.detect(detecting, options));
      const after = await observeGit(share);
      if (sameGitObservation(after, observed)) return available;
      observed = after;
      seen.observed = observed;
      if (round >= GIT_LOOKS_MAX) throw new Error('the shared folder\'s .git kept changing while it was looked at');
    }
  }

  /**
   * One `git ls-files` of `.smurg` in the main repository when worktree mode becomes available: files there were
   * committed by a `git add -A` while sharing with a smurg before 0.5.2 (the share lock marker changes at every start
   * and stop, and every item worktree checks it out). The host is told once (`worktree.smurg-tracked`, the log).
   */
  private async lookForTrackedSmurg(available: Extract<Available, { ok: true }>): Promise<void> {
    if (this.smurgTrackedTold || this.stopped) return;
    const listed = await available.git
      .run({ gitDir: available.repo.gitDir, workTree: this.ctx.roots.main.realPath, args: ['ls-files', '-z', '--', '.smurg'], readOnly: true, maxStdoutBytes: 64 * 1024 })
      .catch(() => null);
    if (listed === null || (listed.code !== 0 && !listed.truncated) || this.smurgTrackedTold) return;
    const count = listed.stdout.toString('utf8').split('\0').filter((path) => path.length > 0).length;
    if (count === 0) return;
    this.smurgTrackedTold = true;
    this.ctx.log.warn('the repository tracks files below .smurg (git rm -r --cached .smurg, then a commit, untracks them)', { module: 'worktree', count });
    this.ctx.bus.emit('worktree.smurg-tracked', { count });
  }

  /**
   * After a restart: every session died with the daemon, so session worktrees in use become kept ones; records whose
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
        // A work item's worktree is never a "kept" one: it stays the item's.
        keep.push(record.item !== undefined ? rest : { ...rest, kept: true });
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
        draft.worktrees = structuredClone(keep);
      });
      await doc.flush();
    }
    if (this.available.ok) await this.sweepReviewRefs(this.available);
  }

  /**
   * A request's commit is fetched into `refs/smurg/merge/<id>` of the HOST's repository before the request is stored
   * (and the ref goes when storing fails). A daemon that died in between left a ref no request names, for ever: at
   * the start every ref below `refs/smurg/merge/` that no stored request names is removed. Nothing else of the
   * repository is listed or touched; when the refs cannot be listed, none is removed.
   */
  private async sweepReviewRefs(available: Extract<Available, { ok: true }>): Promise<void> {
    const repo = available.repo;
    const prefix = MERGE_REF_PREFIX;
    const listed = await repo.git.run({ gitDir: repo.gitDir, args: ['for-each-ref', '--format=%(refname)', prefix], readOnly: true, maxStdoutBytes: 4 * 1024 * 1024 }).catch(() => null);
    if (listed === null || listed.code !== 0 || listed.truncated) {
      this.ctx.log.warn('review refs could not be listed; none was swept', { module: 'worktree' });
      return;
    }
    const named = new Set(this.requireDoc().get().merges.map((merge) => mergeRef(merge.id)));
    const stray = listed.stdout.toString('utf8').split('\n').filter((ref) => ref.startsWith(prefix) && ref.length > prefix.length && !named.has(ref));
    for (const ref of stray) await this.deleteRef(repo, ref);
    if (stray.length > 0) this.ctx.log.info('removed review refs no merge request names', { module: 'worktree', count: stray.length });
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

  /** Every request, drafts included, newest first. */
  listMerges(_principal: Principal): MergeRequest[] {
    return [...this.requireDoc().get().merges]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LIST_MAX_ITEMS)
      .map(toMergeRequest);
  }

  /** Why worktree mode is unavailable, as a refusal says it now (null when it is available). */
  unavailableReason(): SmurgError | null {
    return this.available.ok ? null : this.refusal(this.available);
  }

  // =================================================================================================================
  // Sessions
  // =================================================================================================================

  async acquireForSession(input: { readonly owner: Principal; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle> {
    const member = this.memberOf(input.owner);
    await this.refreshGitState();
    if (input.worktreeId !== undefined) {
      const worktreeId = input.worktreeId;
      return this.serial.run(`wt:${worktreeId}`, () => this.resume(member, worktreeId, input.sessionId));
    }
    // One creation at a time: the limits are counted and the clone made without another one in between.
    return this.serial.run('create', () => this.create(member, { sessionId: input.sessionId }));
  }

  async releaseFromSession(worktreeId: string, sessionId: string, options: { readonly keep: boolean }): Promise<void> {
    await this.serial.run(`wt:${worktreeId}`, async () => {
      const record = this.record(worktreeId);
      if (!record || record.sessionId !== sessionId) return; // released already, or taken over
      // A work item's worktree outlives every session in it, whatever `keep` says: only releaseItem removes it.
      if (record.item !== undefined) {
        const updated = this.updateWorktree(worktreeId, (draft) => {
          delete draft.sessionId;
        });
        if (updated) this.publishWorktree(updated);
        await this.persist();
        return;
      }
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
      await this.removeInternal(record, owner ? userActor(owner) : SYSTEM_ACTOR);
    });
  }

  private async resume(member: MemberRecord, worktreeId: string, sessionId: string): Promise<WorktreeHandle> {
    const record = this.record(worktreeId);
    if (!record) throw NOT_FOUND();
    if (record.ownerUserId !== member.userId) throw new AuthorizationError(msg('worktree.ownerOnlySessions'), { reason: 'not-owner:worktree' });
    if (record.sessionId !== undefined && record.sessionId !== sessionId && this.sessionLive(record.sessionId)) {
      throw new SmurgError('conflict', msg('worktree.usedByAnotherSession'), { reason: 'worktree-in-use' });
    }
    this.requireAvailableForWork();
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

  /** A fresh clone at the main workspace's HEAD: for a session (its first user) or for a work item. */
  private async create(member: MemberRecord, target: { readonly sessionId: string } | { readonly item: StoredItem }): Promise<WorktreeHandle> {
    const { git, repo } = this.requireAvailableForWork();
    const item = 'item' in target ? target.item : undefined;
    const records = this.records();
    if (records.length >= this.limits.maxWorktrees) throw new SmurgError('conflict', msg('worktree.limit'), { reason: 'worktree-limit' });
    // Work items' worktrees are the workspace's, not a member's: they neither count toward the limit nor meet it.
    if (item === undefined && records.filter((record) => record.item === undefined && record.ownerUserId === member.userId).length >= this.limits.maxWorktreesPerOwner) {
      throw new SmurgError('conflict', msg('worktree.limitOwner'), { reason: 'worktree-limit-owner' });
    }
    const base = await mainHead(repo);
    if (base === null) throw new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' });
    const share = this.ctx.roots.main.realPath;
    if (!(await ensureWorktreesDir(share, this.ctx.roots.worktreesDir))) {
      throw new SmurgError('conflict', msg('worktree.unavailable.worktreesDirUnusable'), { reason: 'worktrees-dir-unusable' });
    }
    const id = newWorktreeId();
    const dir = this.dirOf(id);
    const gitDir = join(dir, '.git');
    const branch = item !== undefined ? itemBranch(item.topicSlug, item.itemId) : worktreeBranch(member.userId, id);
    const timeoutMs = this.limits.gitTimeoutMs;
    const auditDetail = item !== undefined ? { topicId: item.topicId, itemId: item.itemId } : { sessionId: (target as { sessionId: string }).sessionId };
    let registered = false;
    try {
      requireOk(await git.clone({ source: share, dest: dir, cwd: this.ctx.roots.worktreesDir, template: this.templateDir, timeoutMs }), 'createWorktree');
      // The clone gets no remote pointing back at the host's repository.
      requireOk(await git.run({ gitDir, args: ['remote', 'remove', 'origin'], timeoutMs }), 'configureWorktree');
      requireOk(await git.run({ gitDir, workTree: dir, args: ['checkout', '--quiet', '-b', branch, base], timeoutMs }), 'checkout');
      const linked = await linkSharedDirs(dir, share, this.ctx.settings.get().sharedDirs);
      for (const skip of linked.skipped) this.ctx.log.warn('shared directory not linked', { module: 'worktree', worktree: id, path: skip.path, reason: skip.reason });
      await writeExclude(gitDir, linked.links);
      // A result report that is already there (committed earlier, or planted) is not this start's: the agent writes its own.
      if (item !== undefined) await this.removeStaleReport(dir, item);
      const hashes = await pinnedHashes(gitDir);
      const record: StoredWorktree = {
        id,
        ownerUserId: member.userId,
        ownerName: member.displayName,
        branch,
        ...(item !== undefined ? { item: { ...item } } : { sessionId: (target as { sessionId: string }).sessionId }),
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
      if (item !== undefined) this.trees.set(id, { head: base, dirty: false });
      this.ctx.audit.record({
        actor: userActor(member),
        action: 'worktree.create',
        outcome: 'ok',
        target: id,
        detail: { worktreeId: id, branch, baseCommit: base, ...auditDetail, sharedDirs: record.sharedDirs, skippedSharedDirs: linked.skipped.map((skip) => skip.path) },
      });
      this.publishWorktree(record);
      await this.persist();
      return { worktree: toWorktreeInfo(record), root };
    } catch (err) {
      if (registered) await this.ctx.roots.unregisterWorktree(id).catch(() => {});
      this.forgetTree(id);
      await removeWorktreeDir(this.ctx.roots.worktreesDir, id).catch(() => {});
      this.ctx.audit.record({ actor: userActor(member), action: 'worktree.create', outcome: 'error', target: id, detail: { worktreeId: id, ...auditDetail, reason: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : 'failed' } });
      if (err instanceof SmurgError) throw err;
      this.ctx.log.error('worktree creation failed', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      throw new SmurgError('internal', msg('worktree.createFailed'), { reason: 'worktree-create-failed' });
    }
  }

  private registerRoot(record: StoredWorktree): Promise<RootInfo> {
    return this.ctx.roots.registerWorktree({
      worktreeId: record.id,
      dir: this.dirOf(record.id),
      ownerUserId: record.ownerUserId,
      sharedLinks: record.sharedDirs.map((path) => ({ path, mainPath: path })),
      ...(record.item !== undefined ? { item: { ...record.item } } : {}),
    });
  }

  // =================================================================================================================
  // Work items
  // =================================================================================================================

  async acquireForItem(input: { readonly topic: { readonly id: string; readonly slug: string }; readonly itemId: string; readonly owner: Principal }): Promise<WorktreeHandle> {
    const member = this.memberOf(input.owner);
    // The three become a ref name, a path and a root's facts: only the protocol's own forms.
    if (!opaqueIdSchema.safeParse(input.topic.id).success || !TOPIC_SLUG_PATTERN.test(input.topic.slug) || !ITEM_ID_PATTERN.test(input.itemId)) {
      throw new SmurgError('bad_request', undefined, { reason: 'bad-work-item' });
    }
    const item: StoredItem = { topicId: input.topic.id, topicSlug: input.topic.slug, itemId: input.itemId };
    await this.refreshGitState();
    return this.serial.run('create', async () => {
      const existing = this.records().find((record) => record.item?.topicId === item.topicId && record.item.itemId === item.itemId);
      if (existing) return this.serial.run(`wt:${existing.id}`, () => this.reuseForItem(existing.id));
      return this.create(member, { item });
    });
  }

  /** A retry: the item's worktree as it is, without the report of the attempt before. */
  private async reuseForItem(worktreeId: string): Promise<WorktreeHandle> {
    const record = this.record(worktreeId);
    if (!record || record.item === undefined) throw NOT_FOUND();
    this.requireAvailableForWork();
    const dir = this.dirOf(record.id);
    await verifyWorktreeRepo(dir, record);
    const root = this.ctx.roots.get({ kind: 'worktree', worktreeId }) ?? (await this.registerRoot(record));
    await this.removeStaleReport(dir, record.item);
    return { worktree: toWorktreeInfo(record), root };
  }

  /** Removes `specs/<slug>/reports/<item id>.md` from an item worktree, never through a link. */
  private async removeStaleReport(dir: string, item: StoredItem): Promise<void> {
    const outcome = await removeEntryBelow(dir, topicReportPath(item.topicSlug, item.itemId));
    // A link where the topic's folder should be: the report the agent writes would land somewhere else. Fail closed.
    if (outcome === 'blocked') throw new SmurgError('conflict', msg('worktree.createFailed'), { reason: 'report-path-blocked' });
  }

  async setOwner(worktreeId: string, owner: Principal): Promise<void> {
    const member = this.memberOf(owner);
    await this.serial.run(`wt:${worktreeId}`, async () => {
      const record = this.record(worktreeId);
      if (!record) throw NOT_FOUND();
      if (record.ownerUserId === member.userId && record.ownerName === member.displayName) return;
      const updated = this.updateWorktree(worktreeId, (draft) => {
        draft.ownerUserId = member.userId;
        draft.ownerName = member.displayName;
      });
      if (updated) this.publishWorktree(updated);
      await this.persist();
    });
  }

  async releaseItem(worktreeId: string): Promise<void> {
    await this.serial.run(`wt:${worktreeId}`, async () => {
      const record = this.record(worktreeId);
      if (!record) return; // released already
      if (record.item === undefined) throw new SmurgError('bad_request', undefined, { reason: 'not-an-item-worktree' });
      await this.removeInternal(record, SYSTEM_ACTOR);
    });
  }

  unmerged(topicId: string): WorktreeInfo[] {
    const merged = new Set(
      this.requireDoc()
        .get()
        .merges.filter((merge) => merge.status === 'merged')
        .map((merge) => `${merge.worktreeId} ${merge.commit}`),
    );
    return this.records()
      .filter((record) => record.item?.topicId === topicId)
      .filter((record) => {
        const state = this.trees.get(record.id);
        // Not looked at yet (right after a start): it may hold anything.
        if (state === undefined || state.dirty) return true;
        // Commits on its branch that no merged request carried into the main workspace.
        return state.head !== record.baseCommit && !merged.has(`${record.id} ${state.head}`);
      })
      .map(toWorktreeInfo);
  }

  /**
   * Something wrote in a worktree (the watcher, an agent's tool, the activity feed): its working tree may differ from
   * what the daemon last committed. For a work item's worktree the daemon looks once the writes have stopped.
   */
  noteChange(worktreeId: string): void {
    const record = this.record(worktreeId);
    if (!record || record.item === undefined) return;
    this.writes.set(worktreeId, (this.writes.get(worktreeId) ?? 0) + 1);
    const state = this.trees.get(worktreeId);
    if (state) state.dirty = true;
    if (this.stopped || !this.available.ok) return;
    const pending = this.treeChecks.get(worktreeId);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.treeChecks.delete(worktreeId);
      void this.serial
        .run(`wt:${worktreeId}`, () => this.lookAtTree(worktreeId))
        .catch((err: unknown) => this.ctx.log.warn('item worktree could not be checked; it counts as holding unmerged work', { module: 'worktree', worktree: worktreeId, error: err instanceof Error ? err.name : 'unknown' }));
    }, this.limits.treeCheckDelayMs);
    timer.unref?.();
    this.treeChecks.set(worktreeId, timer);
  }

  /** `activity.recorded`: a person's own edit of a file in a work item's worktree is remembered for its report. */
  noteActivity(entry: DaemonEvents['activity.recorded']['entry']): void {
    const file = entry.file;
    if (file === undefined || file.root.kind !== 'worktree') return;
    const worktreeId = file.root.worktreeId;
    this.noteChange(worktreeId);
    if (entry.actor.kind !== 'user' || !HAND_EDIT_KINDS.has(entry.kind)) return;
    const record = this.record(worktreeId);
    if (!record || record.item === undefined) return;
    const slug = record.item.topicSlug;
    const by: UserRef = { userId: entry.actor.userId, displayName: entry.actor.displayName };
    const paths = [file.path, ...(entry.renamedFrom !== undefined ? [entry.renamedFrom] : [])].filter((path) => path.length > 0 && !isInTopicDir(path, slug));
    const known = record.handEdits ?? [];
    if (paths.every((path) => known.some((edit) => edit.path === path && edit.by.some((user) => user.userId === by.userId)))) return;
    this.updateWorktree(worktreeId, (draft) => {
      const edits = draft.handEdits ?? [];
      for (const path of paths) {
        const edit = edits.find((candidate) => candidate.path === path);
        if (edit === undefined) edits.push({ path, by: [by] });
        else if (!edit.by.some((user) => user.userId === by.userId) && edit.by.length < REVIEWERS_MAX) edit.by.push(by);
      }
      // The newest are the ones a report is most likely to show.
      draft.handEdits = edits.slice(-HAND_EDIT_PATHS_MAX);
    });
  }

  /**
   * The scripts the trust gate records right now for the main workspace (where a merge lands) and for the worktree
   * the change comes from: what a host-confirmed project hook runs. (A composition without a trust gate has no such
   * scripts; a gate that fails fails the request.) After a merge the gate looks at the files again and asks the host.
   */
  private recordedScripts(worktreeId: string): ReadonlySet<string> {
    const trust = this.ctx.services.projectTrust;
    if (isStubService(trust)) return new Set();
    return new Set([...trust.protectedPaths(MAIN_ROOT), ...trust.protectedPaths({ kind: 'worktree', worktreeId })]);
  }

  /**
   * The files of a change that people also edited by hand in the worktree, at most REPORT_BY_HAND_MAX. A hand edit
   * names what the person's request named: a file, or a FOLDER they renamed, moved into place or deleted, which is an
   * edit of every file below it (names compared as a case-insensitive file system compares them).
   */
  private byHandOf(record: StoredWorktree, files: readonly ReviewFile[]): { path: string; by: UserRef[] }[] {
    const edits = record.handEdits ?? [];
    if (edits.length === 0) return [];
    const changed = [...new Set(files.flatMap((entry) => [entry.file.path, ...(entry.file.oldPath !== undefined ? [entry.file.oldPath] : [])]))].map((path) => ({ path, folded: foldRelPath(path) }));
    // In the order the hand edits were made (the newest are the ones a report is most likely to show).
    const byPath = new Map<string, UserRef[]>();
    for (const edit of edits) {
      const folder = foldRelPath(edit.path);
      for (const file of changed) {
        if (!isRelPathWithin(file.folded, folder)) continue;
        let people = byPath.get(file.path);
        if (people === undefined) byPath.set(file.path, (people = []));
        for (const user of edit.by) if (people.length < REVIEWERS_MAX && !people.some((known) => known.userId === user.userId)) people.push({ ...user });
      }
    }
    return [...byPath].slice(-REPORT_BY_HAND_MAX).map(([path, by]) => ({ path, by }));
  }

  /** After a start: the branch head and whether the working tree has uncommitted changes, for every item worktree. */
  private async inspectItemWorktrees(): Promise<void> {
    if (!this.available.ok) return;
    for (const record of this.records()) {
      if (this.stopped) return;
      if (record.item === undefined || this.trees.has(record.id)) continue;
      await this.serial
        .run(`wt:${record.id}`, () => this.lookAtTree(record.id))
        .catch((err: unknown) => this.ctx.log.warn('item worktree could not be checked; it counts as holding unmerged work', { module: 'worktree', worktree: record.id, error: err instanceof Error ? err.name : 'unknown' }));
    }
  }

  /**
   * The truth about a work item's working tree, from git: its branch head and whether `git status` finds anything
   * (what `git add --all` would commit: ignored files are nobody's work). Runs on the worktree's queue, so no commit
   * of the daemon is half-way; a write that arrives while it runs leaves the tree marked as written (its own look
   * follows).
   */
  private async lookAtTree(worktreeId: string): Promise<void> {
    const record = this.record(worktreeId);
    if (!record || record.item === undefined || !this.available.ok || this.stopped) return;
    const git = this.available.git;
    const dir = this.dirOf(worktreeId);
    const gitDir = join(dir, '.git');
    const writesBefore = this.writes.get(worktreeId) ?? 0;
    await verifyWorktreeRepo(dir, record);
    const timeoutMs = this.limits.gitTimeoutMs;
    const head = firstLine(requireOk(await git.run({ gitDir, args: ['rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`], readOnly: true, timeoutMs }), 'readCommit'));
    const status = await git.run({
      gitDir,
      workTree: dir,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'],
      readOnly: true,
      maxStdoutBytes: 1024 * 1024,
      timeoutMs,
    });
    if (!status.truncated) requireOk(status, 'checkChanges');
    if (this.record(worktreeId) === null) return;
    const writtenMeanwhile = (this.writes.get(worktreeId) ?? 0) !== writesBefore;
    this.trees.set(worktreeId, { head, dirty: writtenMeanwhile || status.truncated || status.stdout.length > 0 });
  }

  // =================================================================================================================
  // Removal
  // =================================================================================================================

  async remove(worktreeId: string, principal: Principal): Promise<void> {
    const record = this.record(worktreeId);
    if (!record) throw NOT_FOUND();
    // The host, or the member the worktree is for WHILE they may open sessions (what gave them the worktree). The
    // owner record alone decides nothing: a member who lost agent access keeps no say over the folder, whatever a
    // record still says (one written by an earlier version, or one a hand-over to the host did not reach).
    if (!isHostPrincipal(principal)) {
      const owner = principal.kind === 'user' && principal.userId !== null && principal.userId === record.ownerUserId;
      if (!owner) throw new AuthorizationError(msg('worktree.removeOwnerOrHost'), { reason: 'not-owner:worktree' });
      if (!principalCan(principal, 'session.create')) throw new AuthorizationError(msg('worktree.removeOwnerOrHost'), { reason: 'capability' });
    }
    await this.serial.run(`wt:${worktreeId}`, async () => {
      const current = this.record(worktreeId);
      if (!current) throw NOT_FOUND();
      if (this.inUse(current)) throw new SmurgError('conflict', msg('worktree.inUse'), { reason: 'worktree-in-use' });
      await this.removeInternal(current, principal.actor);
    });
  }

  private async removeInternal(record: StoredWorktree, actor: Principal['actor']): Promise<void> {
    // PathGuard stops resolving the root first: nothing reads or writes a directory that is being deleted.
    await this.ctx.roots.unregisterWorktree(record.id);
    // A draft is the daemon's snapshot of this working tree: it goes with it, BEFORE the removal is announced (whoever
    // hears of the removal finds the requests as they will stay). Requests somebody asked for stay decidable: their
    // commit lives in the main repository.
    await this.serial.run('main', () => this.dropRequests((merge) => merge.worktreeId === record.id && merge.status === 'draft'));
    this.requireDoc().update((draft) => {
      draft.worktrees = draft.worktrees.filter((item) => item.id !== record.id);
    });
    this.forgetTree(record.id);
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
    this.ctx.audit.record({
      actor,
      action: 'worktree.remove',
      outcome: removed ? 'ok' : 'error',
      target: record.id,
      detail: { worktreeId: record.id, branch: record.branch, ownerUserId: record.ownerUserId, ...(record.item !== undefined ? { topicId: record.item.topicId, itemId: record.item.itemId } : {}) },
    });
  }

  // =================================================================================================================
  // Merge requests
  // =================================================================================================================

  /**
   * Commits the worktree's working tree onto its branch (the first step of a merge request, of a snapshot and of
   * updateFromMain). After updateFromMain the commit has the merged HEAD of the main workspace as its second parent,
   * and is not made while a file the daemon merged still has conflict markers (`markers`).
   */
  private async commitWorktree(record: StoredWorktree, options: { readonly git: GitRunner; readonly identity: GitIdentity; readonly message: string; readonly verify: boolean }): Promise<Committed> {
    const dir = this.dirOf(record.id);
    await verifyWorktreeRepo(dir, record);
    const pending = record.merge;
    if (pending !== undefined) {
      const markers = await filesWithConflictMarkers(dir, pending.conflicted);
      if (markers.length > 0) return { markers };
    }
    // What is written from here on may not be in this commit: the mark is cleared BEFORE the tree is read, and a
    // write that arrives while it is read sets it again.
    const state = this.trees.get(record.id);
    const wasDirty = state?.dirty ?? true;
    const writesBefore = this.writes.get(record.id) ?? 0;
    if (state) state.dirty = false;
    let result;
    try {
      // Staged in a daemon-private store and verified blob by blob before the clone gets it (stage-commit.ts).
      result = await stageCommit({
        git: options.git,
        workTree: dir,
        branch: record.branch,
        identity: options.identity,
        message: options.message,
        stagingRoot: this.stagingDir,
        verify: options.verify,
        ...(pending !== undefined ? { secondParent: pending.parent } : {}),
        limits: { timeoutMs: this.limits.gitTimeoutMs },
      });
    } catch (err) {
      if (state) state.dirty = state.dirty || wasDirty;
      throw err;
    }
    if (state) state.head = result.commit;
    else if (record.item !== undefined) this.trees.set(record.id, { head: result.commit, dirty: (this.writes.get(record.id) ?? 0) !== writesBefore });
    if (pending !== undefined) {
      // The two-parent commit is on the branch: the merge is recorded in git now.
      this.updateWorktree(record.id, (draft) => {
        delete draft.merge;
      });
    }
    return result;
  }

  async requestMerge(input: PayloadOf<'worktree.merge.request'>, principal: Principal): Promise<MergeRequest> {
    const record = this.record(input.worktreeId);
    if (!record) throw NOT_FOUND();
    if (principal.userId === null || !principalCan(principal, 'worktree.merge.request')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const open = this.requireDoc()
      .get()
      .merges.filter((merge) => merge.worktreeId === record.id && (merge.status === 'pending' || merge.status === 'conflict')).length;
    if (open >= this.limits.maxOpenMergesPerWorktree) throw new SmurgError('conflict', msg('merge.tooManyOpen'), { reason: 'too-many-open-merges' });
    const member = this.memberOf(principal);
    const { git, repo } = await this.availableNow();
    const timeoutMs = this.limits.gitTimeoutMs;
    const requesterIsHost = isHostPrincipal(principal);

    return this.serial.run(`wt:${record.id}`, async () => {
      const current = this.record(record.id);
      if (!current) throw NOT_FOUND();
      // 1. Commit the working tree as the requester (nothing to commit is fine); unless the host requested it, every
      //    new blob is verified against the worktree first.
      const committed = await this.commitWorktree(current, {
        git,
        identity: gitIdentity(member.userId, member.displayName),
        message: input.message?.trim() ? input.message : worktreeCommitMessage(member.displayName),
        verify: !requesterIsHost,
      });
      if ('markers' in committed) throw markersError(committed.markers);
      const commit = committed.commit;
      return this.serial.run('main', async () => {
        // The daemon's own snapshot of exactly this commit: it becomes the request (same id, same ref).
        const draft = this.requireDoc()
          .get()
          .merges.find((merge) => merge.worktreeId === current.id && merge.status === 'draft' && merge.commit === commit);
        if (draft !== undefined) {
          const updated = this.updateMerge(draft.id, (item) => {
            item.status = 'pending';
            item.requestedBy = { userId: member.userId, displayName: member.displayName };
            if (input.message !== undefined && input.message.length > 0) item.message = input.message;
          });
          this.ctx.audit.record({
            actor: principal.actor,
            action: 'worktree.merge.request',
            outcome: 'ok',
            target: updated.id,
            detail: { requestId: updated.id, worktreeId: current.id, branch: current.branch, commit, fromDraft: true, ...(updated.message !== undefined ? { message: updated.message } : {}) },
          });
          this.publishMerge(updated, principal);
          await this.persist();
          return toMergeRequest(updated);
        }
        // 2. Bring exactly that commit into the main repository, under a ref of its own.
        const requestId = newMergeId();
        const ref = await this.fetchCommit(git, repo, current, commit, requestId);
        try {
          const head = await mainHead(repo);
          if (head === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
          const files = await reviewFiles(repo, await reviewBase(repo, head, commit), commit);
          const violation = await checkMergePolicy(repo, files, { requesterIsHost, ...(current.item !== undefined ? { topicSlug: current.item.topicSlug } : {}), recorded: this.recordedScripts(current.id), timeoutMs });
          if (violation) {
            this.auditRefusedRequest(principal.actor, current, commit, violation, false);
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
            ...itemFacts(current),
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

  async snapshot(input: { readonly worktreeId: string; readonly message: string; readonly topicSlug?: string }): Promise<SnapshotResult> {
    const { git, repo } = await this.availableNow();
    const timeoutMs = this.limits.gitTimeoutMs;
    return this.serial.run(`wt:${input.worktreeId}`, async () => {
      const current = this.record(input.worktreeId);
      if (!current) throw NOT_FOUND();
      const topicSlug = current.item?.topicSlug ?? input.topicSlug;
      if (topicSlug !== undefined && !TOPIC_SLUG_PATTERN.test(topicSlug)) throw new SmurgError('bad_request', undefined, { reason: 'bad-work-item' });
      // 1. The working tree as a commit of the worktree's owner (the member who started the item; the host after a
      //    handover), always verified: sessions write this tree while it is read.
      const committed = await this.commitWorktree(current, { git, identity: gitIdentity(current.ownerUserId, current.ownerName), message: input.message, verify: true });
      if ('markers' in committed) {
        await this.persist();
        return { ok: false, reason: 'conflict-markers', files: committed.markers.slice(0, SNAPSHOT_FILES_MAX) };
      }
      const commit = committed.commit;
      return this.serial.run('main', async () => {
        const record = this.record(current.id) ?? current;
        const head = await mainHead(repo);
        if (head === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
        // Nothing changed since the last snapshot: it stands.
        const same = this.requireDoc()
          .get()
          .merges.find((merge) => merge.worktreeId === record.id && merge.status === 'draft' && merge.commit === commit);
        if (same !== undefined) {
          const files = await reviewFiles(repo, await reviewBase(repo, head, commit), commit);
          await this.persist();
          return { ok: true, request: toMergeRequest(same), ...changeCounts(files), byHand: this.byHandOf(record, files) };
        }
        // 2. Exactly that commit in the main repository, under a ref of its own.
        const requestId = newMergeId();
        const ref = await this.fetchCommit(git, repo, record, commit, requestId);
        try {
          const files = await reviewFiles(repo, await reviewBase(repo, head, commit), commit);
          // 3. The policy of a request nobody of the host's rank made: no host-only paths, not the topic's two files.
          const violation = await checkMergePolicy(repo, files, { requesterIsHost: false, ...(topicSlug !== undefined ? { topicSlug } : {}), recorded: this.recordedScripts(record.id), timeoutMs });
          if (violation) {
            this.auditRefusedRequest(SYSTEM_ACTOR, record, commit, violation, true);
            await this.deleteRef(repo, ref);
            await this.persist();
            // The daemon's directory and links out of the project are, like host-only paths, the host's alone to merge.
            return { ok: false, reason: violation.reason === 'spec-files' ? 'spec-files' : 'host-only-paths', files: violation.paths.slice(0, SNAPSHOT_FILES_MAX) };
          }
          // 4. This snapshot replaces what it supersedes: the worktree's earlier draft, and a request of it that ended
          //    in a conflict (this commit contains that one's).
          await this.dropRequests((merge) => merge.worktreeId === record.id && (merge.status === 'draft' || merge.status === 'conflict'));
          const stored: StoredMerge = {
            id: requestId,
            worktreeId: record.id,
            ownerUserId: record.ownerUserId,
            ...(mergeMessageSchema.safeParse(input.message).success ? { message: input.message } : {}),
            commit,
            status: 'draft',
            ...itemFacts(record),
            ...(record.item === undefined && topicSlug !== undefined ? { topicSlug } : {}),
            createdAt: this.ctx.clock.now(),
          };
          this.storeMerge(stored);
          this.ctx.audit.record({
            actor: SYSTEM_ACTOR,
            action: 'worktree.merge.request',
            outcome: 'ok',
            target: requestId,
            detail: { requestId, worktreeId: record.id, branch: record.branch, commit, files: files.length, draft: true, ...(record.item !== undefined ? { topicId: record.item.topicId, itemId: record.item.itemId } : {}) },
          });
          this.publishMerge(stored);
          await this.persist();
          return { ok: true, request: toMergeRequest(stored), ...changeCounts(files), byHand: this.byHandOf(record, files) };
        } catch (err) {
          await this.deleteRef(repo, ref);
          throw err;
        }
      });
    });
  }

  setReviewed(requestId: string, reviewed: boolean): MergeRequest {
    const merge = this.requireMerge(requestId);
    if ((merge.reviewed === true) === reviewed) return toMergeRequest(merge);
    const updated = this.updateMerge(requestId, (draft) => {
      if (reviewed) draft.reviewed = true;
      else delete draft.reviewed;
    });
    this.publishMerge(updated);
    void this.persist();
    return toMergeRequest(updated);
  }

  async updateFromMain(worktreeId: string): Promise<{ readonly mergeParent: string; readonly conflicted: readonly string[] }> {
    const { git, repo } = await this.availableNow();
    return this.serial.run(`wt:${worktreeId}`, async () => {
      const record = this.record(worktreeId);
      if (!record) throw NOT_FOUND();
      // What people typed into files of the worktree and is not on disk yet belongs to its work.
      const docs = this.ctx.services.docs;
      if (!isStubService(docs)) await docs.flushAll();
      const mainCommit = await mainHead(repo);
      if (mainCommit === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
      // 1. The worktree's work is a commit on its branch; the working tree is clean against it. (An earlier update
      //    that was resolved but never committed is committed here, with its own second parent.)
      const committed = await this.commitWorktree(record, { git, identity: gitIdentity(record.ownerUserId, record.ownerName), message: UPDATE_COMMIT_MESSAGE, verify: true });
      if ('markers' in committed) throw markersError(committed.markers);
      // 2. + 3. Merge the main workspace's HEAD without committing; git's merge state ends, files and markers stay.
      const dir = this.dirOf(record.id);
      const files = this.ctx.services.files;
      let outcome;
      try {
        outcome = await mergeMainIntoWorktree({
          git,
          workTree: dir,
          head: committed.commit,
          mainCommit,
          timeoutMs: this.limits.mergeTimeoutMs,
          // The files the merge brings are smurg's own change of the worktree, not a program of its sessions.
          beforeMerge: (paths) => {
            if (isStubService(files) || paths.length > 5_000) return;
            for (const path of paths) files.expectChange({ root: { kind: 'worktree', worktreeId: record.id }, path }, SYSTEM_ACTOR, 30_000);
          },
        });
      } catch (err) {
        // Whatever state the failed merge left: the tree is no longer known to equal its last commit.
        this.noteChange(record.id);
        throw err;
      }
      if (!outcome.merged) {
        await this.persist();
        return { mergeParent: mainCommit, conflicted: [] };
      }
      this.noteChange(record.id);
      const conflicted = outcome.conflicted.slice(0, MERGE_FILES_MAX);
      this.updateWorktree(record.id, (draft) => {
        draft.merge = { parent: mainCommit, conflicted };
      });
      await this.persist();
      return { mergeParent: mainCommit, conflicted };
    });
  }

  async diff(input: PayloadOf<'worktree.merge.diff'>, principal: Principal): Promise<ResultInputOf<'worktree.merge.diff'>> {
    const merge = this.requireMergeVisible(input.requestId, principal);
    const { repo } = await this.availableNow();
    const { base, files } = await this.review(repo, merge);
    // Host-private files are the host's alone: for everyone else they are listed as hidden and left out of the text.
    const withheld = isHostPrincipal(principal) ? new Set<ReviewFile>() : new Set(files.filter((entry) => isWithheldFile(entry.file)));
    const { diff, truncated } =
      withheld.size === 0
        ? await unifiedDiff(repo, base, merge.commit, this.limits.gitTimeoutMs)
        : await unifiedDiffOfFiles(repo, base, merge.commit, files.filter((entry) => !withheld.has(entry)), this.limits.gitTimeoutMs);
    return { diff, truncated, files: files.map((entry) => (withheld.has(entry) ? withheldEntry(entry.file) : entry.file)) };
  }

  async fileDiff(input: PayloadOf<'worktree.merge.fileDiff'>, principal: Principal): Promise<ResultInputOf<'worktree.merge.fileDiff'>> {
    const merge = this.requireMergeVisible(input.requestId, principal);
    const { repo } = await this.availableNow();
    const { base, files } = await this.review(repo, merge);
    // Only a path of this request's file list: never a pathspec the client made up.
    const entry = files.find((item) => item.file.path === input.path);
    if (!entry) throw new SmurgError('bad_request', msg('merge.pathNotInDiff'), { reason: 'path-not-in-diff' });
    if (!isHostPrincipal(principal) && isWithheldFile(entry.file)) return { path: entry.file.path, diff: '', truncated: false, binary: false, hidden: true };
    const { diff, truncated } = await singleFileDiff(repo, base, merge.commit, entry, this.limits.gitTimeoutMs);
    return { path: entry.file.path, diff, truncated, binary: entry.file.binary === true };
  }

  async approve(input: PayloadOf<'worktree.merge.approve'>, principal: Principal): Promise<MergeRequest> {
    if (!principalCan(principal, 'worktree.merge.decide') || principal.kind === 'system') throw new AuthorizationError(undefined, { reason: 'capability' });
    const { git, repo } = await this.availableNow();
    return this.serial.run('main', async () => {
      const found = this.requireMerge(input.requestId);
      if (found.status !== 'pending' && found.status !== 'conflict' && found.status !== 'draft') throw new SmurgError('conflict', msg('merge.notPending'), { reason: 'not-pending', status: found.status });
      if (!(await commitExists(repo, found.commit))) throw new SmurgError('conflict', msg('merge.commitGone'), { reason: 'commit-gone' });
      const share = this.ctx.roots.main.realPath;
      const pre = await mainHead(repo);
      if (pre === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
      await this.assertMainIdle(repo);
      const base = await reviewBase(repo, pre, found.commit);
      const files = await reviewFiles(repo, base, found.commit);
      // Policy again: the requester's role may have changed since the request. A draft nobody asked for is held to
      // what a member's request is held to, whoever approves it.
      const requesterIsHost = found.requestedBy !== undefined && this.ctx.members.roleOf(found.requestedBy.userId) === 'host';
      const violation = await checkMergePolicy(repo, files, { requesterIsHost, ...(found.topicSlug !== undefined ? { topicSlug: found.topicSlug } : {}), recorded: this.recordedScripts(found.worktreeId), timeoutMs: this.limits.gitTimeoutMs });
      if (violation) {
        this.auditDecision(principal, found, 'denied', { reason: violation.reason, paths: violation.paths.slice(0, 20) });
        throw policyError(violation);
      }
      const host = this.memberOf(principal);
      const merge = found;
      // Whose work the activity feed and the merge commit name: who asked, or for a draft the worktree's owner.
      const whose = merge.requestedBy?.displayName ?? this.ownerNameOf(merge);
      const decider: Decider = { principal, whose };
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
      if (trial.truncated || (trial.code !== 0 && trial.code !== 1)) requireOk(trial, 'trialMerge');
      const outcome = parseMergeTree(trial.stdout);
      if (trial.code === 1) return this.markConflict(decider, merge, outcome.conflicted.map((path) => path.path), 'conflict');

      // 2. What the merge would change in the main working tree: nothing locked, nothing with local changes.
      const changes = parseNameStatus(
        requireOk(await git.run({ gitDir: repo.gitDir, args: ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', pre, outcome.tree], readOnly: true, maxStdoutBytes: 64 * 1024 * 1024, timeoutMs }), 'listMergeChanges').stdout,
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
      if (inTheWay.size > 0) return this.markConflict(decider, merge, [...inTheWay], 'local-changes');

      // 3. Merge exactly that commit. Attributes come from the host's own HEAD, never from the incoming commit: a
      //    worktree's .gitattributes cannot pick a filter or merge driver of the host's config for the daemon to run.
      const fileService = this.ctx.services.files;
      if (!isStubService(fileService) && touched.length <= 5_000) for (const path of touched) fileService.expectChange({ root: MAIN_ROOT, path }, principal.actor);
      const message = mergeCommitMessage(this.branchOf(merge), whose, merge.message);
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
      if (result.code !== 0) return this.recoverFailedMerge(decider, merge, repo, git, pre);
      const post = await mainHead(repo);
      const updated = this.updateMerge(merge.id, (draft) => {
        draft.status = 'merged';
        // Approving a draft implies the request: once it is merged, the host is who asked.
        draft.requestedBy ??= { userId: host.userId, displayName: host.displayName };
        draft.decidedAt = this.ctx.clock.now();
        delete draft.conflictFiles;
        if (post !== null && post !== pre) draft.mergeCommit = post;
      });
      this.auditDecision(principal, updated, 'ok', { files: touched.length, ...(updated.mergeCommit !== undefined ? { mergeCommit: updated.mergeCommit } : {}) });
      this.publishMerge(updated, principal, whose);
      await this.persist();
      await this.deleteRef(repo, mergeRef(merge.id));
      return toMergeRequest(updated);
    });
  }

  async reject(input: PayloadOf<'worktree.merge.reject'>, principal: Principal): Promise<MergeRequest> {
    if (!principalCan(principal, 'worktree.merge.decide') || principal.kind === 'system') throw new AuthorizationError(undefined, { reason: 'capability' });
    // `.git` is looked at first (the look never rejects), so the review ref goes when the repository is there, also
    // after a look that failed. Rejecting itself needs no repository: it works while worktree mode is off, and the
    // ref then stays where it is (in a `.git` that was moved away, for one).
    await this.refreshGitState();
    return this.serial.run('main', async () => {
      const merge = this.requireMerge(input.requestId);
      if (merge.status !== 'pending' && merge.status !== 'conflict' && merge.status !== 'draft') throw new SmurgError('conflict', msg('merge.notPending'), { reason: 'not-pending', status: merge.status });
      const whose = merge.requestedBy?.displayName ?? this.ownerNameOf(merge);
      // The worktree is not touched at all (R9.3); only the main repository's review ref goes.
      const updated = this.updateMerge(merge.id, (draft) => {
        draft.status = 'rejected';
        draft.decidedAt = this.ctx.clock.now();
        if (input.reason !== undefined && input.reason.length > 0) draft.rejectReason = input.reason;
      });
      this.auditDecision(principal, updated, 'ok', input.reason !== undefined ? { reason: input.reason } : {});
      this.publishMerge(updated, principal, whose);
      await this.persist();
      if (this.available.ok) await this.deleteRef(this.available.repo, mergeRef(merge.id));
      return toMergeRequest(updated);
    });
  }

  // ---- merge helpers ----------------------------------------------------------------------------------------------

  /** `git fetch <worktree> <branch>:refs/smurg/merge/<id>` into the main repository; the ref must then be `commit`. */
  private async fetchCommit(git: GitRunner, repo: MainRepo, record: StoredWorktree, commit: string, requestId: string): Promise<string> {
    const ref = mergeRef(requestId);
    requireOk(
      await git.run({
        gitDir: repo.gitDir,
        args: ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-gc', this.dirOf(record.id), `+refs/heads/${record.branch}:${ref}`],
        timeoutMs: this.limits.gitTimeoutMs,
        abortable: false,
      }),
      'fetchChanges',
    );
    try {
      const fetched = firstLine(requireOk(await git.run({ gitDir: repo.gitDir, args: ['rev-parse', '--verify', `${ref}^{commit}`], readOnly: true }), 'readCommit'));
      if (fetched !== commit) throw new SmurgError('conflict', msg('worktree.changedDuringRequest'), { reason: 'worktree-changed' });
    } catch (err) {
      await this.deleteRef(repo, ref);
      throw err;
    }
    return ref;
  }

  private auditRefusedRequest(actor: Principal['actor'], record: StoredWorktree, commit: string, violation: PolicyViolation, draft: boolean): void {
    this.ctx.audit.record({
      actor,
      action: 'worktree.merge.request',
      outcome: 'denied',
      target: record.id,
      detail: { worktreeId: record.id, commit, reason: violation.reason, paths: violation.paths.slice(0, 20), count: violation.paths.length, ...(draft ? { draft: true } : {}) },
    });
  }

  /** Removes the requests `drop` picks, with their review refs. Runs on the `main` queue: no decision is half-way. */
  private async dropRequests(drop: (merge: StoredMerge) => boolean): Promise<void> {
    const dropped = this.requireDoc().get().merges.filter(drop);
    if (dropped.length === 0) return;
    const ids = new Set(dropped.map((merge) => merge.id));
    this.requireDoc().update((draft) => {
      draft.merges = draft.merges.filter((merge) => !ids.has(merge.id));
    });
    if (this.available.ok) for (const merge of dropped) await this.deleteRef(this.available.repo, mergeRef(merge.id));
  }

  private async review(repo: MainRepo, merge: StoredMerge): Promise<{ base: string; files: ReviewFile[] }> {
    if (!(await commitExists(repo, merge.commit))) throw new SmurgError('not_found', msg('merge.commitGone'), { reason: 'commit-gone' });
    // A merged request is shown against the main workspace as it was before the merge.
    const against = merge.status === 'merged' && merge.mergeCommit !== undefined ? `${merge.mergeCommit}^1` : await mainHead(repo);
    if (against === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
    const base = await reviewBase(repo, against, merge.commit);
    return { base, files: await reviewFiles(repo, base, merge.commit, DEFAULT_REVIEW_LIMITS) };
  }

  private async assertMainIdle(repo: MainRepo): Promise<void> {
    const marker = await busyMarker(repo);
    if (marker !== null) throw new SmurgError('conflict', msg('merge.mainBusy'), { reason: 'main-busy', marker });
  }

  private assertNotLocked(principal: Principal, merge: StoredMerge, touched: readonly string[]): void {
    const locks = this.ctx.services.locks;
    if (isStubService(locks)) return; // no lock manager composed: no lock can exist
    const locked = touched.filter((path) => locks.get({ root: MAIN_ROOT, path }) !== null);
    if (locked.length === 0) return;
    const first = locks.get({ root: MAIN_ROOT, path: locked[0] as string });
    this.auditDecision(principal, merge, 'denied', { reason: 'files-locked', paths: locked.slice(0, 20) });
    throw new SmurgError('locked', msg('merge.lockedFiles', { paths: listedPaths(locked) }), {
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
      'checkMain',
    );
    return new Set(parseStatusPaths(result.stdout));
  }

  /** `git merge` failed after merge-tree said it would not: a conflict that appeared meanwhile, or a refusal. */
  private async recoverFailedMerge(decider: Decider, merge: StoredMerge, repo: MainRepo, git: GitRunner, pre: string): Promise<MergeRequest> {
    const head = await lstat(join(repo.gitDir, 'MERGE_HEAD')).catch(() => null);
    if (head !== null) {
      const workTree = this.ctx.roots.main.realPath;
      const unmerged = await git.run({ gitDir: repo.gitDir, workTree, attrSource: pre, args: ['diff', '--name-only', '-z', '--diff-filter=U', '--no-ext-diff', '--ignore-submodules=all'], readOnly: true, maxStdoutBytes: 16 * 1024 * 1024 });
      const conflicted = unmerged.code === 0 && !unmerged.truncated ? parseNameOnly(unmerged.stdout).map((path) => path.path) : [];
      // Our own merge created this state: undo it so the main workspace is as it was.
      await git.run({ gitDir: repo.gitDir, workTree, attrSource: pre, args: ['merge', '--abort'], timeoutMs: this.limits.mergeTimeoutMs, abortable: false });
      return this.markConflict(decider, merge, conflicted, 'conflict');
    }
    const now = await mainHead(repo);
    this.ctx.log.error('merge failed', { module: 'worktree', request: merge.id, headMoved: now !== pre });
    this.auditDecision(decider.principal, merge, 'error', { reason: 'merge-failed' });
    throw new SmurgError('conflict', msg('merge.failed'), { reason: 'merge-failed' });
  }

  private async markConflict(decider: Decider, merge: StoredMerge, paths: readonly string[], reason: 'conflict' | 'local-changes'): Promise<MergeRequest> {
    const updated = this.updateMerge(merge.id, (draft) => {
      draft.status = 'conflict';
      draft.decidedAt = this.ctx.clock.now();
      draft.conflictFiles = [...new Set(paths)].slice(0, MERGE_FILES_MAX);
    });
    this.auditDecision(decider.principal, updated, 'error', { reason, conflictFiles: (updated.conflictFiles ?? []).slice(0, 50), count: updated.conflictFiles?.length ?? 0 });
    this.publishMerge(updated, decider.principal, decider.whose);
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
      detail: {
        requestId: merge.id,
        worktreeId: merge.worktreeId,
        commit: merge.commit,
        status: merge.status,
        ...(merge.requestedBy !== undefined ? { requestedBy: merge.requestedBy.userId } : {}),
        ...(merge.itemId !== undefined ? { topicId: merge.topicId, itemId: merge.itemId } : {}),
        ...detail,
      },
    });
  }

  private async deleteRef(repo: MainRepo, ref: string): Promise<void> {
    const result = await repo.git.run({ gitDir: repo.gitDir, args: ['update-ref', '-d', ref], abortable: false }).catch(() => null);
    if (result === null || result.code !== 0) this.ctx.log.warn('merge ref not deleted', { module: 'worktree', ref });
  }

  private branchOf(merge: StoredMerge): string {
    return this.record(merge.worktreeId)?.branch ?? `worktree ${merge.worktreeId}`;
  }

  /** The display name of the worktree's owner (as it is now; the request keeps who owned it when it was made). */
  private ownerNameOf(merge: StoredMerge): string {
    return this.record(merge.worktreeId)?.ownerName ?? this.ctx.members.get(merge.ownerUserId)?.displayName ?? merge.ownerUserId;
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

  /** `file.read`: every member reads a request's changes (a result report shows them); what is withheld is per file. */
  private requireMergeVisible(requestId: string, principal: Principal): StoredMerge {
    if (principal.userId === null || !principalCan(principal, 'file.read')) throw new AuthorizationError(undefined, { reason: 'capability' });
    return this.requireMerge(requestId);
  }

  // =================================================================================================================
  // The main workspace's own files (the checkpoint of a Start, the pin check, "Show the changes")
  // =================================================================================================================

  async commitMainPaths(input: { readonly paths: readonly string[]; readonly message: string; readonly trailers: readonly string[]; readonly as: Principal }): Promise<{ readonly commit: string; readonly created: boolean; readonly branch: string; readonly blobs: Readonly<Record<string, string>> }> {
    const member = this.memberOf(input.as);
    const { repo } = await this.availableNow();
    // On the queue of merges: a merge and the checkpoint never interleave their steps.
    return this.serial.run('main', () =>
      commitMainPaths({
        repo,
        workTree: this.ctx.roots.main.realPath,
        paths: input.paths,
        message: input.message,
        trailers: input.trailers,
        identity: gitIdentity(member.userId, member.displayName),
        timeoutMs: this.limits.gitTimeoutMs,
      }),
    );
  }

  async headBlobs(paths: readonly string[]): Promise<Record<string, string | null>> {
    const none = (): Record<string, string | null> => Object.fromEntries(paths.map((path) => [path, null]));
    await this.refreshGitState();
    if (!this.available.ok || this.stopped) return none();
    const repo = this.available.repo;
    const head = await mainHead(repo);
    return head === null ? none() : blobsAt(repo, head, paths, this.limits.gitTimeoutMs);
  }

  async mainState(): Promise<MainState> {
    await this.refreshGitState();
    const isRepo = this.ctx.workspace.info.isGitRepo;
    const free = Math.max(0, this.limits.maxWorktrees - this.records().length);
    const available = this.available;
    if (!available.ok) {
      // git itself first (`git init` needs it), then what the folder lacks (a `.git` that went, when worktrees or
      // open merge requests are on record: refusal).
      const binary = await this.gitBinaryNow();
      const reason = binaryUnavailable(binary)?.error ?? this.refusal(available);
      return { isRepo, hasCommit: false, gitOk: binary.kind === 'ok', unavailable: reason.text ?? msg('worktree.unavailable.checkFailed'), branch: null, busy: false, free };
    }
    const repo = available.repo;
    try {
      const head = await mainHead(repo);
      return {
        isRepo: true,
        hasCommit: head !== null,
        gitOk: true,
        unavailable: head === null ? msg('worktree.unavailable.noCommit') : null,
        branch: await currentBranch(repo),
        busy: (await busyMarker(repo)) !== null,
        free,
      };
    } catch {
      return { isRepo, hasCommit: false, gitOk: false, unavailable: msg('worktree.unavailable.checkFailed'), branch: null, busy: false, free };
    }
  }

  async diffMainPaths(input: { readonly paths: readonly string[]; readonly against: 'head' | Readonly<Record<string, string | null>>; readonly maxBytes: number }): Promise<{ readonly path: string; readonly diff: string; readonly truncated: boolean }[]> {
    await this.refreshGitState();
    if (!this.available.ok) return [];
    if (this.stopped) throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });
    return diffMainPaths({
      repo: this.available.repo,
      workTree: this.ctx.roots.main.realPath,
      stagingRoot: this.stagingDir,
      paths: input.paths,
      against: input.against,
      maxBytes: input.maxBytes,
      timeoutMs: this.limits.gitTimeoutMs,
    });
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
    if (!this.doc) throw new SmurgError('internal', msg('worktree.notStarted'), { reason: 'not-started' });
    return this.doc;
  }

  private records(): readonly StoredWorktree[] {
    return this.doc?.get().worktrees ?? [];
  }

  private record(worktreeId: string): StoredWorktree | null {
    return this.records().find((record) => record.id === worktreeId) ?? null;
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

  /**
   * `by`: a request or decision someone just made, which also goes into everyone's activity feed (`whose`: the name
   * the entry gives the worktree; default: who asked for the merge). A snapshot and a review mark are announced
   * without an entry: their report is what people see.
   */
  private publishMerge(merge: StoredMerge, by?: Principal, whose?: string): void {
    const request = toMergeRequest(merge);
    this.ctx.bus.emit('merge.changed', { request });
    this.ctx.hub.broadcast('worktree.merge.updated', { request });
    if (by !== undefined) this.mergeActivity(merge, by, whose ?? merge.requestedBy?.displayName ?? this.ownerNameOf(merge));
  }

  private mergeActivity(merge: StoredMerge, by: Principal, requester: string): void {
    const activity = this.ctx.services.activity;
    if (isStubService(activity)) return;
    const text =
      merge.status === 'pending'
        ? msg('activity.mergeRequested')
        : merge.status === 'merged'
          ? msg('activity.mergeMerged', { requester })
          : merge.status === 'rejected'
            ? msg('activity.mergeRejected', { requester })
            : msg('activity.mergeConflict', { requester, count: merge.conflictFiles?.length ?? 0 });
    try {
      activity.record({ actor: by.actor, kind: 'merge', text });
    } catch (err) {
      this.ctx.log.error('merge activity failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private forgetTree(worktreeId: string): void {
    this.trees.delete(worktreeId);
    this.writes.delete(worktreeId);
    const pending = this.treeChecks.get(worktreeId);
    if (pending !== undefined) clearTimeout(pending);
    this.treeChecks.delete(worktreeId);
  }

  private requireAvailable(): { git: GitRunner; repo: MainRepo } {
    if (this.stopped) throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });
    if (!this.available.ok) throw this.refusal(this.available);
    return { git: this.available.git, repo: this.available.repo };
  }

  /**
   * Worktree mode for a request that did not look yet (a merge request made, shown or decided, a snapshot, an update
   * from the main workspace, a commit of the main workspace's files): `.git` is looked at first, so a look that failed
   * is tried again by the request that is refused for it, and a `.git` that came back counts at once. File calls only
   * while nothing changed and no look failed.
   */
  private async availableNow(): Promise<{ git: GitRunner; repo: MainRepo }> {
    await this.refreshGitState();
    return this.requireAvailable();
  }

  /**
   * Worktree mode for a session or a work item that asks for a worktree (a new one, a kept one, an item's own): refused
   * with the reason Start names (mainState). That is git itself first, when it is known to be missing, too old or not
   * running (it is known once Start was asked, or a repository was looked at), then what the folder lacks. Never a
   * look for git of its own: a teammate's request runs no git in a folder that is no repository.
   */
  private requireAvailableForWork(): { git: GitRunner; repo: MainRepo } {
    if (!this.stopped && !this.available.ok && this.gitBinary !== null) {
      const binary = binaryUnavailable(this.gitBinary);
      if (binary !== null) throw binary.error;
    }
    return this.requireAvailable();
  }

  /**
   * What a refusal says now. A folder that is no repository while a worktree is on record, or a merge request that is
   * still open (isOpenMerge), had a `.git` that went (moved away, deleted): `git init` would make another repository,
   * which those worktrees do not belong to and in which those requests can no longer be merged. So the sentence says
   * to put `.git` back, and never to run `git init`. Requests that were decided (merged, rejected) are history: a new
   * repository strands nothing of them, so a folder with only those is simply not a repository, and `git init` is the
   * cure. Decided when it is said, not when `.git` was looked at: the records change while worktree mode is off (a
   * worktree removed, a request rejected).
   */
  private refusal(state: Extract<Available, { ok: false }>): SmurgError {
    if (state.error.detail?.['reason'] !== 'not-a-git-repo') return state.error;
    const doc = this.doc?.get();
    if (doc === undefined || (doc.worktrees.length === 0 && !doc.merges.some(isOpenMerge))) return state.error;
    return new SmurgError('conflict', msg('worktree.unavailable.gitDirGone'), { reason: 'git-dir-gone' });
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
    return session !== null && !isSessionOver(session);
  }

  /**
   * Whether a session that is not over works in the worktree: the session it was acquired for, or, for a work item's
   * worktree (which no session holds), any session of its topic whose root it is.
   */
  private inUse(record: StoredWorktree): boolean {
    if (record.sessionId !== undefined && this.sessionLive(record.sessionId)) return true;
    if (record.item === undefined) return false;
    const sessions = this.ctx.services.sessions;
    if (isStubService(sessions)) return false;
    return sessions.list({ topicId: record.item.topicId }).some((session) => !isSessionOver(session) && session.root.kind === 'worktree' && session.root.worktreeId === record.id);
  }
}

/** What `git version` said (null: it did not run, or said nothing readable). */
function binaryOf(version: readonly [number, number, number] | null): GitBinary {
  if (version === null) return { kind: 'cannot-run' };
  return gitVersionAtLeast(version, GIT_MIN_VERSION) ? { kind: 'ok', version: version.join('.') } : { kind: 'too-old', version: version.join('.') };
}

/**
 * A merge request nobody decided yet: a `draft` (a snapshot nobody asked to merge), a `pending` one, and one that
 * ended in a `conflict` (it can be approved again). `merged` and `rejected` are decided.
 */
function isOpenMerge(merge: Pick<StoredMerge, 'status'>): boolean {
  return merge.status === 'draft' || merge.status === 'pending' || merge.status === 'conflict';
}

/** What a request carries of the work item its worktree belongs to. */
function itemFacts(record: StoredWorktree): Pick<StoredMerge, 'topicId' | 'itemId' | 'topicSlug'> {
  return record.item === undefined ? {} : { topicId: record.item.topicId, itemId: record.item.itemId, topicSlug: record.item.topicSlug };
}

function changeCounts(files: readonly ReviewFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const entry of files) {
    additions += entry.file.additions;
    deletions += entry.file.deletions;
  }
  return { files: files.length, additions, deletions };
}

export { GitUnavailableError };
