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
//
// smurg's own history (0.6.0, DESIGN D14, hidden-repo.ts): when NOTHING is at `<share>/.git` and the git executable is
// usable, the main repository is `<share>/.smurg/git` with the shared folder as its work tree, and topics work as with
// a repository. Its HEAD is the folder as the last snapshot recorded it: a snapshot is taken at Start (the checkpoint),
// before a new worktree (its base), before a merge (what the merge is made against) and before an update from the main
// workspace. Records say which repository they belong to (`repo: 'smurg'`; absent: the folder's own `.git`), and every
// operation on a record uses its repository, whatever the folder has now. A merge of smurg's history is made against
// the merge base its review recorded (`base`). The executable is still looked for lazily (lookForGit): by the Start
// dialog, the host's own worktree request, a merge view and what works on smurg's history; never at the start of
// sharing, never on a timer; a teammate's worktree request while that was not done is refused (`unchecked`).
//
// Without a usable git program (0.6.0, DESIGN D15) work items run directly in the shared folder (the topics module):
// `workState()` says `direct` with the reason, and worktrees are refused with it as in 0.5.2.
//
// smurg merges by itself (0.7.0, DESIGN 0.7.0 D7): `autoMerge` decides a work item's draft (or a conflict nobody
// requested) with the same body as the host's `approve` (`decide`, on the `main` queue), on the host's standing consent:
// only into the branch the item's Start committed on while it still holds the checkpoint, never over a staged index
// (which `approve` now names too), with the policy of a member's request, after a look at the locks of the request's own
// files before any snapshot, and "still in order" asked by the topics module at entry and just before `git merge`. The
// commit's author is the host, its committer smurg (SMURG_COMMITTER), its message ends with smurg's trailer, the audit
// entry is `worktree.merge.auto`. Waits and holds are outcomes; a conflict says who changed the other side
// (people-changes.ts). What a crash left in smurg's own history (a merge or revert under way) is aborted before the first
// command of a run on it; in the folder's own `.git` such a state is the host's and only named.
//
// The host's undo (0.7.0, DESIGN 0.7.0 D14, undo.ts): merged work items are taken back out of the main workspace with
// ONE commit, after a trial that touches nothing (in smurg's own history after a snapshot of the folder, so a saved edit
// nobody recorded yet stays), the reports kept; later merges of any topic on the same lines go with it, people's later
// changes on them, edits in the way, staged changes, a git operation under way or another branch stop it, each named.
// The record written before the folder is touched (`worktrees.json.undo`) is settled before any merge after a crash.
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_MERGE_PATHS_MAX,
  ITEM_ID_PATTERN,
  LIST_MAX_ITEMS,
  MAIN_ROOT,
  MERGE_FILES_MAX,
  PAGE_LIMIT_MAX,
  PREFLIGHT_NESTED_REPOS_MAX,
  REPORT_BY_HAND_MAX,
  REVIEWERS_MAX,
  SmurgError,
  TOPIC_SLUG_PATTERN,
  UNDO_ITEMS_MAX,
  foldRelPath,
  gitCommitSchema,
  isInTopicDir,
  isRelPathWithin,
  isSessionOver,
  mergeMessageSchema,
  opaqueIdSchema,
  topicReportPath,
  wireText,
  type MergeRequest,
  type PayloadOf,
  type ResultInputOf,
  type UserRef,
  type WorkState,
  type WorktreeInfo,
} from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type {
  AutoMergeInput,
  AutoMergeOutcome,
  DaemonEvents,
  HistoryState,
  MainState,
  MemberRecord,
  PeopleChange,
  PersistentDocument,
  Principal,
  RootInfo,
  SnapshotResult,
  StartFolderFacts,
  UndoApply,
  UndoAsk,
  UndoDone,
  UndoFacts,
  UndoItem,
  UndoItemKey,
  WorktreeHandle,
  WorktreeManager,
} from '../core/interfaces.ts';
import { diskReport, nodeStatfs, type StatfsFunction } from '../files/disk.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, isHostPrincipal, principalCan, userActor } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { excludeSmurgDir, isRepositoryFolder, observeGit, sameGitObservation, type GitObservation } from '../workspace/share.ts';
import { ensureWorktreesDir, filesWithConflictMarkers, linkSharedDirs, plainFileKind, removeEntryBelow, removeWorktreeDir, sweepRemovals, untrackedInTheWay, writeExclude } from './fs-ops.ts';
import { GIT_MIN_VERSION, GitRunner, GitUnavailableError, findGit, firstLine, gitVersionAtLeast, listedPaths, requireOk, type GitIdentity } from './git.ts';
import { parseMergeTree, parseNameOnly, parseNameStatus, parseStatusPaths } from './git-parse.ts';
import {
  HIDDEN_LOOSE_OBJECTS_MAX,
  HIDDEN_MAX_BYTES,
  HIDDEN_MAX_FILES,
  HIDDEN_SNAPSHOT_TIMEOUT_MS,
  ensureHiddenRepo,
  hiddenExcludeLines,
  hiddenChanged,
  hiddenGitDir,
  hiddenGone,
  hiddenOnDisk,
  hiddenProblem,
  isCloudSynced,
  listFolder,
  removeStaleLock,
  sizeText,
  snapshotFolder,
  tooLargeError,
  writeHiddenExclude,
  type HiddenRun,
} from './hidden-repo.ts';
import { pinnedHashes, verifyHiddenRepo, verifyWorktreeRepo } from './integrity.ts';
import { blobsAt, busyMarker, checkpointMessage, commitMainPaths, currentBranch, diffMainPaths, hasStagedChanges, headPlace, isAncestor, smurgMergeLeftover } from './main-repo.ts';
import { AUTO_MERGE_TRAILER, MERGE_REF_PREFIX, SMURG_COMMITTER, gitIdentity, itemBranch, mergeRef, newMergeId, newWorktreeId, worktreeBranch } from './names.ts';
import { PEOPLE_PER_PATH_MAX, peopleChanges } from './people-changes.ts';
import {
  DEFAULT_REVIEW_LIMITS,
  changedNames,
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
  type StoredHiddenRepo,
  type StoredWorktree,
  type WorktreesDocument,
} from './store.ts';
import {
  HIDDEN_UNDO_MESSAGE,
  changesBetween,
  checkoutFromIndex,
  commitOnHead,
  firstParentLine,
  indexTree,
  mergeTouches,
  messageOf,
  nextOnLine,
  notAsIn,
  parentOf,
  revertTrial,
  treeOf,
  undoMessage,
  withFilesOf,
  type RevertTrial,
  type UndoMergeCommit,
} from './undo.ts';
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
  /** Each command of a snapshot of smurg's own history (DESIGN 0.6.0 D14: longer than a first snapshot of a big folder). */
  readonly hiddenSnapshotTimeoutMs: number;
  /** What smurg's own history records at most (DESIGN 0.6.0 D14: 50,000 files, 1 GiB); beyond it a snapshot is refused. */
  readonly hiddenMaxFiles: number;
  readonly hiddenMaxBytes: number;
  /** Loose objects after which smurg's own history is repacked. */
  readonly hiddenLooseObjectsMax: number;
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
  hiddenSnapshotTimeoutMs: HIDDEN_SNAPSHOT_TIMEOUT_MS,
  hiddenMaxFiles: HIDDEN_MAX_FILES,
  hiddenMaxBytes: HIDDEN_MAX_BYTES,
  hiddenLooseObjectsMax: HIDDEN_LOOSE_OBJECTS_MAX,
});

export interface WorktreeModuleOptions {
  /**
   * Absolute path of the git executable. Default: the first `git` on the daemon's PATH at start (how the host runs
   * git anyway; it only ever runs with the fixed environment of git.ts).
   */
  readonly gitPath?: string;
  readonly limits?: Partial<WorktreeLimits>;
  /** The free space of the disk before a clone of smurg's own history (default: node's statfs; tests inject one). */
  readonly statfs?: StatfsFunction;
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
 * Why `<share>/.git` as it is seen cannot hold worktrees (null: it is a plain git directory). Nothing there (0.6.0:
 * only asked when records of the folder's own repository wait for it, else smurg's own history is used), or a
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

/** Messages of the snapshots smurg's own history takes (fixed English, one shared history; DESIGN 0.6.0 D14). */
export const HIDDEN_WORKTREE_MESSAGE = 'smurg: the shared folder for a new worktree';
export function hiddenMergeMessage(branch: string): string {
  return `smurg: the shared folder before merging ${branch}`;
}
export function hiddenUpdateMessage(branch: string): string {
  return `smurg: the shared folder before updating ${branch}`;
}

/** Who smurg's own snapshots of the warm-up are written as (nothing is committed then: only objects and the index). */
const SMURG_IDENTITY: GitIdentity = Object.freeze({ name: 'smurg', email: 'daemon@smurg.invalid' });

/** `worktree.unavailable.unchecked`: no `.git`, and git was not looked for yet (a teammate's request never looks). */
function uncheckedState(): Extract<Available, { ok: false }> {
  return notAvailable('unchecked', msg('worktree.unavailable.unchecked'));
}

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

/**
 * Who decides a merge request (DESIGN 0.7.0 D7): the host's own `approve`, or smurg's `autoMerge` on the host's
 * standing consent (`host`: the host's member record, the merge commit's author).
 */
type How = { readonly kind: 'host'; readonly principal: Principal } | { readonly kind: 'auto'; readonly host: MemberRecord; readonly input: AutoMergeInput };

/** Who decides a request, and `whose` work the activity feed and the merge commit then name. */
interface Decider {
  readonly how: How;
  readonly whose: string;
}

/**
 * What deciding a request did: for the host the request as the decision left it (merged, or marked as a conflict; every
 * refusal is thrown, as in 0.6.0); for smurg's own try an outcome (DESIGN 0.7.0 D7: waits and holds are never errors).
 */
type Decided = { readonly kind: 'decided'; readonly merge: StoredMerge } | AutoMergeOutcome;

const GONE: AutoMergeOutcome = Object.freeze({ kind: 'gone' });

/** Where an undo runs (DESIGN 0.7.0 D14): the history of the items asked for, usable now; or why it cannot run at all. */
type UndoWhere = { readonly history: 'folder' | 'smurg'; readonly git: GitRunner; readonly repo: MainRepo } | { readonly facts: UndoFacts };

/** One merge an undo may take back: whose it is, where it lies on the main workspace's first-parent line (0: HEAD). */
interface UndoMerge extends UndoMergeCommit {
  readonly key: string;
  readonly topicId: string;
  readonly itemId: string;
  readonly topicSlug: string;
  readonly requestId?: string;
  readonly position: number;
}

/** What computing an undo found: the facts, and for the apply the head it was computed against and the tree the folder becomes. */
interface ComputedUndo {
  readonly facts: UndoFacts;
  readonly pre: string | null;
  readonly target: string | null;
  readonly merges: readonly UndoMerge[];
  readonly changes: readonly { readonly letter: string; readonly path: string }[];
}

/** The key of a work item in an undo's sets. */
function undoKey(item: UndoItemKey): string {
  return `${item.topicId}\u0000${item.itemId}`;
}
function undoKeyParts(key: string): UndoItemKey {
  const at = key.indexOf('\u0000');
  return { topicId: key.slice(0, at), itemId: key.slice(at + 1) };
}

/** The subject of an undo commit smurg finishes after a crash (the topics module's own words were not kept). */
function recoverySubject(requests: readonly StoredMerge[]): string {
  const slugs = [...new Set(requests.map((request) => request.topicSlug ?? 'a topic'))];
  const items = requests.map((request) => request.itemId ?? request.id);
  if (slugs.length === 1) return `smurg: undo work item${items.length === 1 ? '' : 's'} ${items.join(', ')} of ${slugs[0] as string}`;
  return `smurg: undo work items ${requests.map((request) => `${request.itemId ?? request.id} of ${request.topicSlug ?? 'a topic'}`).join(', ')}`;
}

/** Activity kinds that wrote a file (who changed a path of smurg's own history, DESIGN 0.7.0 D7). */
const WRITE_KINDS: ReadonlySet<string> = new Set(['agent.edit', 'human.edit', 'file.create', 'file.delete', 'file.rename', 'file.upload', 'external.change']);
/** Pages of the activity log read back for one snapshot's writers. */
const WRITERS_PAGES_MAX = 20;

export class WorktreeManagerImpl implements WorktreeManager {
  private readonly ctx: DaemonContext;
  private readonly options: WorktreeModuleOptions;
  readonly limits: WorktreeLimits;
  private doc: PersistentDocument<WorktreesDocument> | null = null;
  private available: Available = notAvailable('starting', msg('worktree.unavailable.starting'));
  /** What the git executable is, whatever the folder is; null: not looked for yet. */
  private gitBinary: GitBinary | null = null;
  /** A runner of the git executable once it is known to run (smurg's own history, a record of it, an item's clone). */
  private runner: GitRunner | null = null;
  /** git was looked for since the last detection: the next look detects again although `.git` did not change. */
  private binaryChanged = false;
  /** `workState()` as it was last announced (`work.changed`). */
  private workKey = '';
  /** The bytes and nested repositories of the last listing of the folder (smurg's own history: the disk check). */
  private lastListing: { readonly bytes: number; readonly nested: readonly string[] } | null = null;
  /** The warm-up of the Start dialog that is queued or running (one at a time). */
  private warmingUp: Promise<void> | null = null;
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
  /** What a crash left in smurg's own history was looked at in this run (DESIGN 0.7.0 D7): once, before its first command. */
  private hiddenSettled: Promise<void> | null = null;

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
    // The daemon's own stores, whatever the folder is (no git process): what a stopped daemon left in staging goes.
    this.templateDir = await this.ctx.state.privateDir('git-template');
    this.stagingDir = await this.ctx.state.privateDir('git-staging');
    await sweepStaging(this.stagingDir);
    // The start's look at `.git` is the first shared look: a refresh asked while it runs (the topics module's sweep
    // ticks from its registration on) waits for it, rather than looking beside it and being overwritten by it.
    const look = this.firstLook();
    this.refreshing = look;
    await look;
    if (this.refreshing === look) this.refreshing = null;
    await this.reconcile();
    if (this.available.ok) this.refsSwept = true;
    // An undo a crash cut short in the folder's own git (DESIGN 0.7.0 D14 step 7) is settled before any merge; one of
    // smurg's own history is settled before the first command of the run on it (abortHiddenLeftovers).
    const interrupted = this.requireDoc().get().undo;
    if (interrupted !== undefined && interrupted.repo === undefined && this.available.ok && this.available.repo.kind === 'folder') {
      await this.serial.run('main', () => this.settleUndoNow()).catch((err: unknown) =>
        this.ctx.log.error('an interrupted undo could not be looked at when sharing started', { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' }),
      );
    }
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
    this.announceWork();
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
   * (The daemon's staging stores are swept at the start only, start(): later, a commit or a diff could be using them.)
   * Nothing at `.git` (0.6.0): smurg's own history with the git executable already known, never a look for it here.
   */
  private async detect(observed: GitObservation, _options: { readonly atStart: boolean }): Promise<Available> {
    const ctx = this.ctx;
    const share = ctx.roots.main.realPath;
    if (!observed.exists) {
      // Nothing at `.git` (0.6.0, DESIGN D14): smurg's own history, once git is known to run. git is never looked for
      // here (the start, the sweep and a teammate's request must not run it in a folder that is no repository):
      // lookForGit does that for the requests that may.
      if (this.gitBinary === null) return uncheckedState();
      const binary = binaryUnavailable(this.gitBinary);
      if (binary !== null) return binary;
      if (this.runner === null) return uncheckedState();
      if (!(await ensureWorktreesDir(share, ctx.roots.worktreesDir))) {
        return notAvailable('worktrees-dir-unusable', msg('worktree.unavailable.worktreesDirUnusable'));
      }
      return { ok: true, git: this.runner, repo: { git: this.runner, gitDir: hiddenGitDir(share), kind: 'smurg' } };
    }
    const folder = folderUnavailable(observed);
    if (folder !== null) return folder;
    const gitDir = join(share, '.git');
    const gitPath = this.options.gitPath ?? (await findGit(process.env['PATH']));
    if (gitPath === null) {
      this.gitBinary = { kind: 'not-found' };
      this.runner = null;
      return binaryUnavailable(this.gitBinary) as Available;
    }
    const git = new GitRunner({ gitPath, home: await ctx.state.privateDir('git-home'), signal: ctx.stopping });
    this.gitBinary = binaryOf(await git.version().catch(() => null));
    const binary = binaryUnavailable(this.gitBinary);
    this.runner = binary === null ? git : null;
    if (binary !== null) return binary;
    if (!(await ensureWorktreesDir(share, ctx.roots.worktreesDir))) {
      return notAvailable('worktrees-dir-unusable', msg('worktree.unavailable.worktreesDirUnusable'));
    }
    return { ok: true, git, repo: { git, gitDir, kind: 'folder' } };
  }

  /**
   * The git executable (`mainState().gitOk`, and the first reason Start names), also when the folder is no repository:
   * looked for once in a run when nothing has looked yet, never again on a timer or on a request.
   */
  private gitBinaryNow(): Promise<GitBinary> {
    if (this.gitBinary !== null) return Promise.resolve(this.gitBinary);
    this.binaryLook ??= (async (): Promise<GitBinary> => {
      let binary: GitBinary;
      let runner: GitRunner | null = null;
      try {
        const gitPath = this.options.gitPath ?? (await findGit(process.env['PATH']));
        if (gitPath === null) binary = { kind: 'not-found' };
        else {
          const git = new GitRunner({ gitPath, home: await this.ctx.state.privateDir('git-home'), signal: this.ctx.stopping });
          binary = binaryOf(await git.version().catch(() => null));
          if (binary.kind === 'ok') runner = git;
        }
      } catch {
        binary = { kind: 'cannot-run' };
      }
      if (this.gitBinary === null) {
        this.gitBinary = binary;
        this.runner = runner;
        this.binaryChanged = true;
      }
      this.announceWork();
      return this.gitBinary;
    })();
    return this.binaryLook;
  }

  /**
   * The git executable, looked for (once a run) by a request that may (DESIGN 0.6.0 D14): the Start dialog and Start,
   * the host's own worktree request, a merge view, what works on a record of smurg's own history, the scheduler for a
   * pin of a Start; then worktree mode is detected again with what was found. Never a teammate's new worktree, never
   * the start of sharing or the sweep.
   */
  private async lookForGit(): Promise<void> {
    if (this.stopped || this.doc === null) return;
    if (this.gitBinary === null) await this.gitBinaryNow();
    for (let round = 0; round < GIT_LOOKS_MAX && this.binaryChanged && !this.stopped; round++) await this.refreshGitState();
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
    if (this.stopped || (before !== null && sameGitObservation(first, before) && (!this.observedFailed || timer) && !this.binaryChanged)) return;
    this.binaryChanged = false;
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
        // (0.6.0: "available" stays only for the history this observation means: the folder's own `.git` when
        // something is there, smurg's own history when nothing is; the other one is about what was there before.)
        const kind = seen.observed.exists ? 'folder' : 'smurg';
        if (!this.available.ok || this.available.repo.kind !== kind) this.available = notAvailable('check-failed', msg('worktree.unavailable.checkFailed'));
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
    this.announceWork();
  }

  /** `work.changed` when `workState()` is not what was last announced (HostState.work: every member is told). */
  private announceWork(): void {
    if (this.stopped || this.doc === null) return;
    const work = this.workState();
    const key = JSON.stringify(work);
    if (key === this.workKey) return;
    const first = this.workKey === '';
    this.workKey = key;
    if (!first) this.ctx.bus.emit('work.changed', { work });
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
      // Nothing at `.git` is smurg's own history (detect); anything else that is no plain git directory is refused.
      const folder = observed.exists ? folderUnavailable(observed) : null;
      if (folder !== null) return folder;
      // smurg's folder is kept out of a repository that appeared while sharing (prepareShare did it for the one that
      // was there at the start), before git runs there.
      if (observed.exists && (!options.atStart || round > 1)) {
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
    if (this.smurgTrackedTold || this.stopped || available.repo.kind !== 'folder') return;
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
    // smurg's own history: only one that is there as smurg left it (never made for this).
    if (repo.kind === 'smurg' && (await this.knownRepoOf({ repo: 'smurg' })) === null) return;
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
    const available = this.forNewWork();
    return available.ok ? null : this.refusal(available);
  }

  // =================================================================================================================
  // Sessions
  // =================================================================================================================

  async acquireForSession(input: { readonly owner: Principal; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle> {
    const member = this.memberOf(input.owner);
    await this.refreshGitState();
    // The host's own worktree request may look for git (DESIGN 0.6.0 D14: smurg's own history needs it); a teammate's
    // new worktree never does, and is refused with `worktree.unavailable.unchecked` while no look was made.
    if (input.worktreeId === undefined && isHostPrincipal(input.owner)) await this.lookForGit();
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
    // Its own repository must be usable (smurg's own history or the folder's `.git`, whatever the folder has now).
    await this.repoOf(record);
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

  /**
   * A fresh clone at the main workspace's HEAD: for a session (its first user) or for a work item. With smurg's own
   * history (DESIGN 0.6.0 D14) its HEAD is first a snapshot of the folder as it is now (the worktree's base), the disk
   * is checked, the clone is made of that history's git dir, and its exclude file gets that history's lines.
   * `history`: an item's Start's (its pin): a new worktree only of that repository.
   */
  private async create(member: MemberRecord, target: { readonly sessionId: string } | { readonly item: StoredItem }, history?: 'folder' | 'smurg'): Promise<WorktreeHandle> {
    let source: { readonly git: GitRunner; readonly repo: MainRepo };
    // smurg's own history may be made for this worktree only when new work uses it now.
    let mayMakeHidden = false;
    if (history === 'smurg') {
      const now = this.forNewWork();
      if (now.ok && now.repo.kind === 'smurg') {
        source = { git: now.git, repo: now.repo };
        mayMakeHidden = true;
      } else source = await this.repoOf({ repo: 'smurg' });
    } else {
      source = this.requireAvailableForWork();
      if (history === 'folder' && source.repo.kind !== 'folder') throw new SmurgError('conflict', msg('worktree.unavailable.gitDirGone'), { reason: 'git-dir-gone' });
      mayMakeHidden = source.repo.kind === 'smurg';
    }
    const { git, repo } = source;
    const hidden = repo.kind === 'smurg';
    const item = 'item' in target ? target.item : undefined;
    const records = this.records();
    if (records.length >= this.limits.maxWorktrees) throw new SmurgError('conflict', msg('worktree.limit'), { reason: 'worktree-limit' });
    // Work items' worktrees are the workspace's, not a member's: they neither count toward the limit nor meet it.
    if (item === undefined && records.filter((record) => record.item === undefined && record.ownerUserId === member.userId).length >= this.limits.maxWorktreesPerOwner) {
      throw new SmurgError('conflict', msg('worktree.limitOwner'), { reason: 'worktree-limit-owner' });
    }
    const folderBase = hidden ? null : await mainHead(repo);
    if (!hidden && folderBase === null) throw new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' });
    const share = this.ctx.roots.main.realPath;
    if (!(await ensureWorktreesDir(share, this.ctx.roots.worktreesDir))) {
      throw new SmurgError('conflict', msg('worktree.unavailable.worktreesDirUnusable'), { reason: 'worktrees-dir-unusable' });
    }
    const id = newWorktreeId();
    const dir = this.dirOf(id);
    const gitDir = join(dir, '.git');
    const branch = item !== undefined ? itemBranch(item.topicSlug, item.itemId) : worktreeBranch(member.userId, id);
    const timeoutMs = this.limits.gitTimeoutMs;
    const auditDetail = {
      ...(item !== undefined ? { topicId: item.topicId, itemId: item.itemId } : { sessionId: (target as { sessionId: string }).sessionId }),
      ...(hidden ? { history: 'smurg' } : {}),
    };
    let registered = false;
    try {
      const clone = async (): Promise<string> => {
        let base = folderBase;
        if (hidden) {
          // On the `main` queue: the snapshot, the disk check and the clone, with no merge or repack in between.
          if (mayMakeHidden) await this.ensureHidden(git);
          else {
            await this.verifyHidden();
            await removeStaleLock(repo.gitDir, this.ctx.log);
          }
          base = (await this.snapshotHidden(git, { message: HIDDEN_WORKTREE_MESSAGE, identity: gitIdentity(member.userId, member.displayName) })).head;
          await this.diskCheck();
        }
        if (base === null) throw new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' });
        // smurg's own history is cloned from its git dir (the folder has no `.git` to find).
        requireOk(await git.clone({ source: hidden ? repo.gitDir : share, dest: dir, cwd: this.ctx.roots.worktreesDir, template: this.templateDir, timeoutMs }), 'createWorktree');
        // The clone gets no remote pointing back at the host's repository.
        requireOk(await git.run({ gitDir, args: ['remote', 'remove', 'origin'], timeoutMs }), 'configureWorktree');
        requireOk(await git.run({ gitDir, workTree: dir, args: ['checkout', '--quiet', '-b', branch, base], timeoutMs }), 'checkout');
        return base;
      };
      const base = hidden ? await this.serial.run('main', clone) : await clone();
      const linked = await linkSharedDirs(dir, share, this.ctx.settings.get().sharedDirs);
      for (const skip of linked.skipped) this.ctx.log.warn('shared directory not linked', { module: 'worktree', worktree: id, path: skip.path, reason: skip.reason });
      await writeExclude(gitDir, linked.links, hidden ? this.cloneExcludeLines() : []);
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
        ...(hidden ? { repo: 'smurg' as const } : {}),
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

  /** What a clone of smurg's own history never commits (its `.git/info/exclude`, with the shared links after it). */
  private cloneExcludeLines(nestedRepos: readonly string[] = this.lastListing?.nested ?? []): string[] {
    return hiddenExcludeLines({ sharedDirs: this.sharedDirs(), nestedRepos, forClone: true });
  }

  /**
   * The folder's nested repositories as the last listing found them. A restart forgets that listing: the folder is
   * listed again first (on the `main` queue, as a snapshot lists it, G's exclude file left as a snapshot leaves it),
   * so a clone's commit after a restart still leaves out what an agent wrote where the folder has a repository of its
   * own (0.6.0's review: such a write reached the diff, and the merge wrote it into the user's nested repository).
   */
  private async nestedReposNow(git: GitRunner): Promise<readonly string[]> {
    if (this.lastListing !== null) return this.lastListing.nested;
    return this.serial.run('main', async () => {
      if (this.lastListing !== null) return this.lastListing.nested;
      await this.verifyHidden();
      const run = this.hiddenRun(git);
      await writeHiddenExclude(run.gitDir, hiddenExcludeLines({ sharedDirs: this.sharedDirs() }));
      const listing = await listFolder(run);
      await writeHiddenExclude(run.gitDir, hiddenExcludeLines({ sharedDirs: this.sharedDirs(), nestedRepos: listing.nested, hostPrivate: listing.hostPrivate }));
      this.lastListing = { bytes: listing.bytes, nested: listing.nested };
      return listing.nested;
    });
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

  async acquireForItem(input: { readonly topic: { readonly id: string; readonly slug: string }; readonly itemId: string; readonly owner: Principal; readonly history?: 'folder' | 'smurg' }): Promise<WorktreeHandle> {
    const member = this.memberOf(input.owner);
    // The three become a ref name, a path and a root's facts: only the protocol's own forms.
    if (!opaqueIdSchema.safeParse(input.topic.id).success || !TOPIC_SLUG_PATTERN.test(input.topic.slug) || !ITEM_ID_PATTERN.test(input.itemId)) {
      throw new SmurgError('bad_request', undefined, { reason: 'bad-work-item' });
    }
    const item: StoredItem = { topicId: input.topic.id, topicSlug: input.topic.slug, itemId: input.itemId };
    await this.refreshGitState();
    // An item's worktree is for a Start someone made (it looked for git): this may look too (after a restart).
    await this.lookForGit();
    return this.serial.run('create', async () => {
      const existing = this.records().find((record) => record.item?.topicId === item.topicId && record.item.itemId === item.itemId);
      if (existing) return this.serial.run(`wt:${existing.id}`, () => this.reuseForItem(existing.id));
      return this.create(member, { item }, input.history);
    });
  }

  /** A retry: the item's worktree as it is, without the report of the attempt before. */
  private async reuseForItem(worktreeId: string): Promise<WorktreeHandle> {
    const record = this.record(worktreeId);
    if (!record || record.item === undefined) throw NOT_FOUND();
    await this.repoOf(record);
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
    // (any usable git: the look is at the worktree's own repository, whichever history it was cloned from)
    if (this.stopped || this.runner === null) return;
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
    if (this.runner === null) return;
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
    const git = this.runner;
    if (!record || record.item === undefined || git === null || this.stopped) return;
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
    // A clone of smurg's own history: its exclude file is written again before every commit (DESIGN 0.6.0 D14), with
    // the folder's nested repositories also after a restart.
    const cloneLines = record.repo === 'smurg' ? this.cloneExcludeLines(await this.nestedReposNow(options.git)) : null;
    const beforeStage = cloneLines !== null ? () => writeExclude(join(dir, '.git'), record.sharedDirs.map((path) => ({ path, mainPath: path })), cloneLines) : undefined;
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
        ...(beforeStage !== undefined ? { beforeStage } : {}),
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
    // The worktree's own repository (smurg's own history, or the folder's `.git`), whatever the folder has now.
    const { git, repo } = await this.repoOf(record);
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
            detail: { requestId: updated.id, worktreeId: current.id, branch: current.branch, commit, fromDraft: true, ...(updated.message !== undefined ? { message: updated.message } : {}), ...(updated.repo === 'smurg' ? { history: 'smurg' } : {}) },
          });
          this.publishMerge(updated, principal);
          await this.persist();
          return toMergeRequest(updated);
        }
        // 2. Bring exactly that commit into the main repository, under a ref of its own.
        if (repo.kind === 'smurg') await this.verifyHidden();
        const requestId = newMergeId();
        const ref = await this.fetchCommit(git, repo, current, commit, requestId);
        try {
          const head = await mainHead(repo);
          if (head === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
          const base = await reviewBase(repo, head, commit);
          const files = await reviewFiles(repo, base, commit);
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
            // smurg's own history: the merge base this version's review shows (every view and the approval check it).
            ...(repo.kind === 'smurg' ? { repo: 'smurg' as const, base } : {}),
          };
          this.storeMerge(stored);
          this.ctx.audit.record({
            actor: principal.actor,
            action: 'worktree.merge.request',
            outcome: 'ok',
            target: requestId,
            detail: { requestId, worktreeId: current.id, branch: current.branch, commit, files: files.length, ...(stored.message !== undefined ? { message: stored.message } : {}), ...(stored.repo === 'smurg' ? { history: 'smurg' } : {}) },
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
    const known = this.record(input.worktreeId);
    if (!known) throw NOT_FOUND();
    const { git, repo } = await this.repoOf(known);
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
        if (repo.kind === 'smurg') await this.verifyHidden();
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
          const base = await reviewBase(repo, head, commit);
          const files = await reviewFiles(repo, base, commit);
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
            ...(repo.kind === 'smurg' ? { repo: 'smurg' as const, base } : {}),
          };
          this.storeMerge(stored);
          this.ctx.audit.record({
            actor: SYSTEM_ACTOR,
            action: 'worktree.merge.request',
            outcome: 'ok',
            target: requestId,
            detail: {
              requestId,
              worktreeId: record.id,
              branch: record.branch,
              commit,
              files: files.length,
              draft: true,
              ...(record.item !== undefined ? { topicId: record.item.topicId, itemId: record.item.itemId } : {}),
              ...(stored.repo === 'smurg' ? { history: 'smurg' } : {}),
            },
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
    const known = this.record(worktreeId);
    if (!known) throw NOT_FOUND();
    const { git, repo } = await this.repoOf(known);
    return this.serial.run(`wt:${worktreeId}`, async () => {
      const record = this.record(worktreeId);
      if (!record) throw NOT_FOUND();
      // What people typed into files of the worktree and is not on disk yet belongs to its work.
      const docs = this.ctx.services.docs;
      if (!isStubService(docs)) await docs.flushAll();
      // smurg's own history: the folder as it is now is what the worktree is brought up to date with (a snapshot).
      const mainCommit =
        repo.kind === 'smurg'
          ? await this.serial.run('main', async () => {
              await this.verifyHidden();
              await removeStaleLock(repo.gitDir, this.ctx.log);
              return (await this.snapshotHidden(git, { message: hiddenUpdateMessage(record.branch), identity: gitIdentity(record.ownerUserId, record.ownerName) })).head;
            })
          : await mainHead(repo);
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
    const { repo } = await this.repoOf(merge);
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
    const { repo } = await this.repoOf(merge);
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
    // The request's own repository (smurg's own history, or the folder's `.git`), looked at before the queue.
    const { git, repo } = await this.repoOf(this.requireMerge(input.requestId));
    return this.serial.run('main', async () => {
      const decided = await this.decide(input.requestId, { kind: 'host', principal }, git, repo);
      // The host's refusals are thrown (as in 0.6.0): what comes back is the request as the decision left it.
      if (decided.kind !== 'decided') throw new SmurgError('internal', undefined, { reason: 'merge-decision' });
      return toMergeRequest(decided.merge);
    });
  }

  async autoMerge(input: AutoMergeInput): Promise<AutoMergeOutcome> {
    // The host's standing consent, applied by smurg: anyone else named is the caller's mistake, never a merge.
    const host = input.host.userId === this.ctx.members.hostUserId() ? this.ctx.members.active(input.host.userId) : null;
    if (host === null) throw new AuthorizationError(undefined, { reason: 'not-the-host' });
    const how: How = { kind: 'auto', host, input };
    const known = this.doc?.get().merges.find((merge) => merge.id === input.requestId);
    if (known === undefined || known.itemId === undefined) return GONE;
    let source: { readonly git: GitRunner; readonly repo: MainRepo };
    try {
      source = await this.repoOf(known);
    } catch (err) {
      return this.autoFailed(err, how, known);
    }
    return this.serial.run('main', async () => {
      try {
        const decided = await this.decide(input.requestId, how, source.git, source.repo);
        if (decided.kind === 'decided') throw new SmurgError('internal', undefined, { reason: 'merge-decision' });
        return decided;
      } catch (err) {
        return this.autoFailed(err, how, this.doc?.get().merges.find((merge) => merge.id === input.requestId) ?? known);
      }
    });
  }

  pendingMergeParent(worktreeId: string): string | null {
    return this.record(worktreeId)?.merge?.parent ?? null;
  }

  /**
   * An automatic try that ended in an error (DESIGN 0.7.0 D7, D8): audited as `worktree.merge.auto` with outcome
   * `error`. smurg's own history changed or gone is the host's to see (`history-changed`); anything else is tried again
   * by the queue's next pass (`retry`; a second one in a row the queue holds as `merge-failed`). The daemon stopping
   * ends the pass.
   */
  private autoFailed(err: unknown, how: How, merge: StoredMerge): AutoMergeOutcome {
    if (err instanceof SmurgError && err.detail?.['reason'] === 'stopping') throw err;
    const reason = err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : 'failed';
    if (!(err instanceof SmurgError)) this.ctx.log.error('an automatic merge failed', { module: 'worktree', request: merge.id, error: err instanceof Error ? err.name : 'unknown' });
    this.auditDecision(how, merge, 'error', { reason });
    return reason.startsWith('hidden-repo-') ? { kind: 'hold', reason: 'history-changed' } : { kind: 'wait', reason: 'retry' };
  }

  /**
   * The one body of a merge decision (DESIGN 0.7.0 D7), on the `main` queue, for the host's `approve` and smurg's
   * `autoMerge`: every check of 0.6.0's approval runs in both, and `how` says what differs (which requests, the branch
   * guard, the cheap look at the locks, the policy without the host's waiver, the audit's action and actor, waits and
   * holds as outcomes instead of refusals, "still in order" asked at entry and just before `git merge`, the commit's
   * committer and trailer). In this order:
   *  1. what may be decided; the commit exists; 2. the branch guard (automatic, folder git); 3. no git operation under
   *  way, no undo left unsettled (automatic); 4. nothing staged (folder git); 4b. the locks of the request's own files
   *  (automatic, before any snapshot); 5. what the merge is made against (smurg's own history: a snapshot) and the
   *  recorded base; 6. the policy; 7. the trial (a conflict marks the request, and says who changed the other side);
   *  8. the locks of every file the merge touches; 9. local changes and entries in the way; 9b. (automatic) the branch
   *  and the head again, then "still in order", then 10. `git merge` with nothing awaited in between; 11. the record.
   */
  private async decide(requestId: string, how: How, git: GitRunner, repo: MainRepo): Promise<Decided> {
    const auto = how.kind === 'auto' ? how.input : null;
    const hidden = repo.kind === 'smurg';
    const share = this.ctx.roots.main.realPath;
    const host = how.kind === 'auto' ? how.host : this.memberOf(how.principal);

    // 1. What may be decided: the host decides any open request (0.6.0); smurg only a draft, or a conflict nobody
    //    requested (a request somebody made is the host's row, R-SAFE S12), and only while it is still in order.
    let found: StoredMerge;
    if (auto !== null) {
      const current = this.doc?.get().merges.find((merge) => merge.id === requestId);
      if (current === undefined || current.itemId === undefined || !(current.status === 'draft' || (current.status === 'conflict' && current.requestedBy === undefined))) return GONE;
      if (!auto.stillInOrder()) return GONE;
      found = current;
    } else {
      found = this.requireMerge(requestId);
      if (found.status !== 'pending' && found.status !== 'conflict' && found.status !== 'draft') throw new SmurgError('conflict', msg('merge.notPending'), { reason: 'not-pending', status: found.status });
    }
    if (hidden) {
      await this.verifyHidden();
      await removeStaleLock(repo.gitDir, this.ctx.log);
    }
    if (!(await commitExists(repo, found.commit))) {
      if (auto === null) throw new SmurgError('conflict', msg('merge.commitGone'), { reason: 'commit-gone' });
      this.auditDecision(how, found, 'error', { reason: 'commit-gone' });
      return { kind: 'hold', reason: 'merge-failed' };
    }

    // 2. The branch guard (folder git, automatic only; U1 M12): only into the branch the Start committed on, while it
    //    still holds the Start's checkpoint. The host's own approve merges where the host is, as in 0.6.0.
    if (auto !== null && !hidden) {
      const guard = await this.branchGuard(repo, auto.pin);
      if (guard !== null) return { kind: 'hold', reason: 'branch', ...guard };
    }

    // 3. Another git operation under way: the host's, or a merge smurg itself began and did not finish (its message
    //    carries smurg's trailer: named, never touched). An undo the start could not settle holds every automatic merge.
    const marker = await busyMarker(repo);
    if (marker !== null) {
      if (auto === null) throw new SmurgError('conflict', msg('merge.mainBusy'), { reason: 'main-busy', marker });
      const leftover = !hidden && marker === 'MERGE_HEAD' ? await smurgMergeLeftover(repo, AUTO_MERGE_TRAILER) : null;
      const of = leftover === null ? undefined : this.requireDoc().get().merges.find((merge) => merge.commit === leftover.commit);
      return {
        kind: 'wait',
        reason: 'git-busy',
        marker,
        ...(leftover === null ? {} : { smurgMerge: { commit: leftover.commit, ...(of === undefined ? {} : { requestId: of.id, ...(of.topicId !== undefined && of.itemId !== undefined ? { topicId: of.topicId, itemId: of.itemId } : {}) }) } }),
      };
    }
    if (auto !== null && this.requireDoc().get().undo !== undefined) {
      // (looked at again first: the host may have finished it or put the files back since, DESIGN 0.7.0 D14 step 7)
      await this.settleUndoNow().catch(() => {});
      if (this.requireDoc().get().undo !== undefined) return { kind: 'hold', reason: 'undo-interrupted' };
    }

    // 4. Nothing staged (folder git): git's merge refuses any staged change, also in a file it does not touch (U2 A8).
    if (!hidden) {
      const head = await mainHead(repo);
      if (head !== null && (await hasStagedChanges(repo, head))) {
        if (auto === null) throw new SmurgError('conflict', msg('merge.staged'), { reason: 'staged' });
        return { kind: 'hold', reason: 'staged' };
      }
    }

    // 4b. The cheap look first (automatic, R-ENG E8): the request's own files against the locks of the main workspace,
    //     before any snapshot, trial or `git status`. Someone typing makes no hidden commit and no trial per retry.
    if (auto !== null) {
      const typing = await this.ownFilesLocked(repo, found);
      if (typing !== null) return typing;
    }

    // 5. What the merge is made against. smurg's own history (DESIGN 0.6.0 D14): the folder as it is now, as the host;
    //    a person's edit since the item's base is a change on that side (a conflict is named, the folder untouched).
    let pre: string | null;
    if (hidden) {
      const docs = this.ctx.services.docs;
      if (!isStubService(docs)) await docs.flushAll();
      pre = (await this.snapshotHidden(git, { message: hiddenMergeMessage(this.branchOf(found)), identity: gitIdentity(host.userId, host.displayName) })).head;
    } else pre = await mainHead(repo);
    if (pre === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
    const base = await reviewBase(repo, pre, found.commit);
    // ...and against the base the review recorded: a history changed since makes the merge differ from what was
    // reviewed. Unless the request's commit is in the history already (its base is the commit itself): smurg
    // stopped after `git merge` and before it recorded the request merged. The merge below is then "Already up to
    // date" and only records it, as with the folder's own repository (0.6.0's review).
    if (hidden && found.base !== undefined && base !== found.base && base !== found.commit) {
      if (auto === null) throw hiddenChanged('merge-base');
      this.auditDecision(how, found, 'error', { reason: 'hidden-repo-changed', problem: 'merge-base' });
      return { kind: 'hold', reason: 'history-changed' };
    }
    const files = await reviewFiles(repo, base, found.commit);

    // 6. Policy again: the requester's role may have changed since the request. A draft nobody asked for is held to
    //    what a member's request is held to, whoever approves it; smurg never merges under the host-only waiver of the
    //    host's own request (R-SAFE S12).
    const requesterIsHost = auto === null && found.requestedBy !== undefined && this.ctx.members.roleOf(found.requestedBy.userId) === 'host';
    const violation = await checkMergePolicy(repo, files, { requesterIsHost, ...(found.topicSlug !== undefined ? { topicSlug: found.topicSlug } : {}), recorded: this.recordedScripts(found.worktreeId), timeoutMs: this.limits.gitTimeoutMs });
    if (violation) {
      this.auditDecision(how, found, 'denied', { reason: violation.reason, paths: violation.paths.slice(0, 20) });
      if (auto === null) throw policyError(violation);
      return { kind: 'hold', reason: 'policy', paths: violation.paths.slice(0, AUTO_MERGE_PATHS_MAX) };
    }
    const merge = found;
    // Whose work the activity feed and the merge commit name: who asked, or for a draft the worktree's owner.
    const whose = merge.requestedBy?.displayName ?? this.ownerNameOf(merge);
    const decider: Decider = { how, whose };
    const docs = this.ctx.services.docs;
    if (!isStubService(docs)) await docs.flushAll();

    // 7. Decide without touching the main workspace: merge-tree writes objects only.
    const timeoutMs = this.limits.mergeTimeoutMs;
    const trial = await git.run({
      gitDir: repo.gitDir,
      attrSource: pre,
      // smurg's own history: exactly the base the review showed (git 2.40), not one derived from history again.
      args: ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ...(hidden ? ['--merge-base', base] : []), pre, merge.commit],
      maxStdoutBytes: 64 * 1024 * 1024,
      timeoutMs,
    });
    if (trial.truncated || (trial.code !== 0 && trial.code !== 1)) requireOk(trial, 'trialMerge');
    const outcome = parseMergeTree(trial.stdout);
    if (trial.code === 1) return this.conflicted(decider, merge, outcome.conflicted.map((path) => path.path), repo, base, pre);

    // 8. What the merge would change in the main working tree: nothing locked, nothing with local changes.
    const changes = parseNameStatus(
      requireOk(await git.run({ gitDir: repo.gitDir, args: ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', pre, outcome.tree], readOnly: true, maxStdoutBytes: 64 * 1024 * 1024, timeoutMs }), 'listMergeChanges').stdout,
    ).map((change) => ({ letter: change.letter, path: change.path.path }));
    const touched = changes.map((change) => change.path);
    if (auto === null) this.assertNotLocked(how, merge, touched);
    else {
      const typing = this.lockedOf(touched);
      // (no `denied` entry per attempt: the queue records the wait, DESIGN 0.7.0 D8)
      if (typing !== null) return typing;
    }
    // 9. Uncommitted changes the merge would overwrite are the host's to handle first (git would refuse them too;
    //    this names them), and so are untracked or IGNORED entries where the merge adds something: git would overwrite
    //    an ignored file silently (SPEC goal 3: no silent overwrite). Names git cannot print as UTF-8 are left to git's
    //    own refusal (recoverFailedMerge). Nothing is overwritten, whoever decides.
    const dirty = await this.dirtyPaths(repo, git, pre);
    const adds = await untrackedInTheWay(share, changes);
    if (auto === null) {
      const inTheWay = new Set(touched.filter((path) => dirty.has(path)));
      for (const path of adds) inTheWay.add(path);
      if (inTheWay.size > 0) return { kind: 'decided', merge: await this.markConflict(decider, merge, [...inTheWay], 'local-changes') };
    } else {
      const added = new Set(adds);
      const local = touched.filter((path) => dirty.has(path) && !added.has(path));
      // In smurg's own history the snapshot above recorded the folder: a change found now was saved after it, and the
      // next try's snapshot records it (there is nothing for the host to commit). In the folder's own git it is the
      // host's to commit or undo.
      if (local.length > 0) return hidden ? { kind: 'wait', reason: 'retry' } : { kind: 'hold', reason: 'local-changes', paths: local.slice(0, AUTO_MERGE_PATHS_MAX) };
      if (adds.length > 0) return { kind: 'hold', reason: 'in-the-way', paths: adds.slice(0, AUTO_MERGE_PATHS_MAX) };
    }

    // 9b. Just before the merge (automatic; R-SAFE S3, R-ENG E1): the branch guard again and the head as the trial saw
    //     it, then "still in order", then `git merge` is spawned with nothing awaited in between. What is left is the
    //     time `git merge` itself runs: a Pause or a setting that lands then finds the merge done.
    if (auto !== null) {
      if (!hidden && (await this.branchGuard(repo, auto.pin)) !== null) return { kind: 'wait', reason: 'retry' };
      if ((await mainHead(repo)) !== pre) return { kind: 'wait', reason: 'retry' };
      if (!auto.stillInOrder()) return GONE;
    }

    // 10. Merge exactly that commit. Attributes come from the host's own HEAD, never from the incoming commit: a
    //     worktree's .gitattributes cannot pick a filter or merge driver of the host's config for the daemon to run.
    //     smurg's merge is the host's standing consent applied by smurg: author the host, committer smurg, a trailer.
    const actor = how.kind === 'auto' ? SYSTEM_ACTOR : how.principal.actor;
    const fileService = this.ctx.services.files;
    if (!isStubService(fileService) && touched.length <= 5_000) for (const path of touched) fileService.expectChange({ root: MAIN_ROOT, path }, actor);
    const message = `${mergeCommitMessage(this.branchOf(merge), whose, merge.message)}${auto !== null ? `\n\n${AUTO_MERGE_TRAILER}` : ''}`;
    const result = await git.run({
      gitDir: repo.gitDir,
      workTree: share,
      attrSource: pre,
      identity: gitIdentity(host.userId, host.displayName),
      ...(auto !== null ? { committer: SMURG_COMMITTER } : {}),
      // --no-overwrite-ignore: the check above already names such files; this keeps git from overwriting one that
      // appeared since.
      args: ['merge', '--quiet', '--no-ff', '--no-edit', '--no-verify', '--no-stat', '--no-overwrite-ignore', '-m', message, merge.commit],
      timeoutMs,
      abortable: false,
    });
    if (result.code !== 0) return this.recoverFailedMerge(decider, merge, repo, git, pre, base);

    // 11. Recorded. "Already up to date" (smurg stopped after an earlier `git merge` and before its record): the merge
    //     commit is the one whose second parent is the request's commit.
    const post = await mainHead(repo);
    const mergeCommit = post !== null && post !== pre ? post : await this.mergeCommitOf(repo, merge.commit, pre);
    const updated = this.updateMerge(merge.id, (draft) => {
      draft.status = 'merged';
      draft.decidedAt = this.ctx.clock.now();
      delete draft.conflictFiles;
      if (mergeCommit !== null) draft.mergeCommit = mergeCommit;
      // smurg merged it on the host's consent: nobody asked, and the record says so (`requestedBy` stays absent).
      if (auto !== null) draft.auto = true;
      // Approving a draft implies the request: once it is merged, the host is who asked.
      else draft.requestedBy ??= { userId: host.userId, displayName: host.displayName };
    });
    const overlap = auto === null ? [] : await this.overlapOf(repo, merge, auto.pin.commit, pre).catch(() => []);
    this.auditDecision(how, updated, 'ok', {
      files: touched.length,
      ...(updated.mergeCommit !== undefined ? { mergeCommit: updated.mergeCommit } : {}),
      ...(auto !== null ? { overlap } : {}),
    });
    this.publishMerge(updated, how.kind === 'auto' ? SYSTEM_PRINCIPAL : how.principal, whose);
    await this.persist();
    await this.deleteRef(repo, mergeRef(merge.id));
    if (auto === null) return { kind: 'decided', merge: updated };
    return { kind: 'merged', request: toMergeRequest(updated), ...(updated.mergeCommit !== undefined ? { mergeCommit: updated.mergeCommit } : {}), files: touched.length, overlap };
  }

  /**
   * DESIGN 0.7.0 D7 step 2: HEAD on `refs/heads/<pin.branch>` and the Start's checkpoint an ancestor of it (null), or
   * what the host is told (the Start's branch and where HEAD is now: a branch, or the short commit of a detached HEAD).
   */
  private async branchGuard(repo: MainRepo, pin: AutoMergeInput['pin']): Promise<{ readonly expected?: string; readonly current: string } | null> {
    const place = await headPlace(repo);
    if (pin.branch === undefined) return { current: place.current };
    if (place.branch !== pin.branch) return { expected: pin.branch, current: place.current };
    const head = await mainHead(repo);
    if (head === null || !(await isAncestor(repo, pin.commit, head))) return { expected: pin.branch, current: place.current };
    return null;
  }

  /** DESIGN 0.7.0 D7 step 4b: a lock of the main workspace on one of the request's own files (git objects only). */
  private async ownFilesLocked(repo: MainRepo, merge: StoredMerge): Promise<AutoMergeOutcome | null> {
    const locks = this.ctx.services.locks;
    if (isStubService(locks)) return null; // no lock manager composed: no lock can exist
    let base = merge.base;
    if (base === undefined) {
      const head = await mainHead(repo);
      if (head === null) return null;
      base = await reviewBase(repo, head, merge.commit);
    }
    return this.lockedOf((await changedNames(repo, base, merge.commit)).paths);
  }

  /** `wait: typing` with the first lock, when a file of `paths` is locked in the main workspace (null: none is). */
  private lockedOf(paths: readonly string[]): AutoMergeOutcome | null {
    const locks = this.ctx.services.locks;
    if (isStubService(locks)) return null;
    const locked = paths.filter((path) => locks.get({ root: MAIN_ROOT, path }) !== null);
    if (locked.length === 0) return null;
    const first = locks.get({ root: MAIN_ROOT, path: locked[0] as string });
    return { kind: 'wait', reason: 'typing', paths: locked.slice(0, AUTO_MERGE_PATHS_MAX), ...(first !== null ? { lock: first } : {}) };
  }

  /**
   * The merge commit that carried `commit` into the main workspace when git found it already merged (a merge smurg made
   * and did not get to record): the newest merge since `commit` whose second parent it is (null: none).
   */
  private async mergeCommitOf(repo: MainRepo, commit: string, head: string): Promise<string | null> {
    const listed = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-list', '--merges', '--parents', '--max-count=1000', head, `^${commit}`], readOnly: true, maxStdoutBytes: 1024 * 1024 }).catch(() => null);
    if (listed === null || listed.code !== 0 || listed.truncated) return null;
    for (const line of listed.stdout.toString('utf8').split('\n')) {
      const [merge, , second] = line.trim().split(' ');
      if (merge !== undefined && second === commit && gitCommitSchema.safeParse(merge).success) return merge;
    }
    return null;
  }

  /**
   * DESIGN 0.7.0 D7 step 11 (U2 exp1 #3): the paths the item changed that the main workspace changed too since the item
   * started, at most 20. Since the item's worktree was made (its base, which a Start's checkpoint is for the first
   * items), not since the base an update from the main workspace moved: R-SAFE's resolve-over-person run shows that one
   * gives nothing where a person's line was replaced. Recorded, never a reason to wait.
   */
  private async overlapOf(repo: MainRepo, merge: StoredMerge, startCommit: string, pre: string): Promise<string[]> {
    const worktreeBase = this.record(merge.worktreeId)?.baseCommit;
    const since = worktreeBase !== undefined && (await commitExists(repo, worktreeBase)) ? worktreeBase : startCommit;
    if (!(await commitExists(repo, since))) return [];
    const item = await changedNames(repo, since, merge.commit);
    const main = new Set((await changedNames(repo, since, pre)).paths);
    return item.paths.filter((path) => main.has(path)).slice(0, AUTO_MERGE_PATHS_MAX);
  }

  /**
   * The trial did not merge: the request is marked `conflict` (0.6.0's markConflict, so the plan and the merge list say
   * so). For smurg's own try (DESIGN 0.7.0 D7 step 7, R-SAFE S2) who changed the other side is looked at too.
   */
  private async conflicted(decider: Decider, merge: StoredMerge, paths: readonly string[], repo: MainRepo, base: string, pre: string): Promise<Decided> {
    const marked = await this.markConflict(decider, merge, paths, 'conflict');
    if (decider.how.kind !== 'auto') return { kind: 'decided', merge: marked };
    const conflictedPaths = [...new Set(paths)];
    let people: PeopleChange[];
    try {
      people = await this.peopleOf(repo, base, pre, conflictedPaths);
    } catch (err) {
      // Who changed it cannot be told: nothing shows the other side is only work items' merges, so a person decides.
      this.ctx.log.warn('who changed the other side of a conflict could not be read; a person decides', { module: 'worktree', request: merge.id, error: err instanceof Error ? err.name : 'unknown' });
      people = conflictedPaths.map((path) => ({ path, by: [], outside: true }));
    }
    return { kind: 'conflict', request: toMergeRequest(marked), paths: conflictedPaths, people };
  }

  /** people-changes.ts over this workspace: the work items' recorded merges, the members, the activity log. */
  private peopleOf(repo: MainRepo, from: string, to: string, paths: readonly string[]): Promise<PeopleChange[]> {
    const workItemMerges = new Set(
      this.requireDoc()
        .get()
        .merges.filter((merge) => merge.status === 'merged' && merge.mergeCommit !== undefined && merge.itemId !== undefined)
        .map((merge) => merge.mergeCommit as string),
    );
    const members = this.ctx.members.list({ includeKicked: true }).map((member) => ({ userId: member.userId, displayName: member.displayName }));
    return peopleChanges({ repo, from, to, paths, workItemMerges, members, writers: (wanted, fromMs, toMs) => this.writersOf(wanted, fromMs, toMs), timeoutMs: this.limits.gitTimeoutMs });
  }

  /**
   * Who wrote paths of the main workspace between two instants, from the activity log (smurg's own history, DESIGN 0.7.0
   * D7): a person by name; an agent session's write by its responsible person (else its owner); a change of an
   * outside program, or by nobody the log names, as `outside`. Paged backwards from `toMs`, at most WRITERS_PAGES_MAX
   * pages: what lies further back is not named (and so counts as outside).
   */
  private async writersOf(paths: readonly string[], fromMs: number, toMs: number): Promise<Map<string, { by: UserRef[]; outside: boolean }>> {
    const out = new Map<string, { by: UserRef[]; outside: boolean }>();
    const activity = this.ctx.services.activity;
    if (isStubService(activity)) return out;
    const wanted = new Set(paths);
    let before = toMs;
    for (let page = 0; page < WRITERS_PAGES_MAX; page += 1) {
      const { events } = await activity.list({ limit: PAGE_LIMIT_MAX, before }, SYSTEM_PRINCIPAL);
      for (const event of events) {
        if (event.at < fromMs) return out;
        if (event.file === undefined || event.file.root.kind !== 'main' || !WRITE_KINDS.has(event.kind)) continue;
        const touched = [event.file.path, ...(event.renamedFrom !== undefined ? [event.renamedFrom] : [])].filter((path) => wanted.has(path));
        if (touched.length === 0) continue;
        const who = event.kind === 'external.change' ? null : this.writerOf(event.actor);
        for (const path of touched) {
          let known = out.get(path);
          if (known === undefined) out.set(path, (known = { by: [], outside: false }));
          if (who === null) known.outside = true;
          else if (known.by.length < PEOPLE_PER_PATH_MAX && !known.by.some((user) => user.userId === who.userId)) known.by.push(who);
        }
      }
      const last = events.at(-1);
      if (events.length < PAGE_LIMIT_MAX || last === undefined) return out;
      before = last.at;
    }
    return out;
  }

  /** The person an activity entry's writer stands for (null: nobody smurg can name). */
  private writerOf(actor: DaemonEvents['activity.recorded']['entry']['actor']): UserRef | null {
    if (actor.kind === 'user') return { userId: actor.userId, displayName: actor.displayName };
    if (actor.kind !== 'agent') return null;
    const sessions = this.ctx.services.sessions;
    const session = isStubService(sessions) ? null : sessions.get(actor.sessionId);
    const responsible = session !== null && 'responsible' in session ? session.responsible : null;
    return responsible !== null ? { userId: responsible.userId, displayName: responsible.displayName } : this.ctx.members.userRef(actor.ownerUserId);
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
      const refRepo = await this.knownRepoOf(merge);
      const whose = merge.requestedBy?.displayName ?? this.ownerNameOf(merge);
      // The worktree is not touched at all (R9.3); only the main repository's review ref goes.
      const updated = this.updateMerge(merge.id, (draft) => {
        draft.status = 'rejected';
        draft.decidedAt = this.ctx.clock.now();
        if (input.reason !== undefined && input.reason.length > 0) draft.rejectReason = input.reason;
      });
      this.auditDecision({ kind: 'host', principal }, updated, 'ok', input.reason !== undefined ? { reason: input.reason } : {});
      this.publishMerge(updated, principal, whose);
      await this.persist();
      if (refRepo !== null) await this.deleteRef(refRepo, mergeRef(merge.id));
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
    for (const merge of dropped) {
      const repo = await this.knownRepoOf(merge);
      if (repo !== null) await this.deleteRef(repo, mergeRef(merge.id));
    }
  }

  /**
   * A record's repository as it is known now, without looking again (for the `main` queue, where a look would wait for
   * the queue itself): null when it cannot be used now.
   */
  private async knownRepoOf(record: { readonly repo?: 'smurg' | undefined }): Promise<MainRepo | null> {
    if (record.repo === 'smurg') {
      if (this.runner === null) return null;
      try {
        await this.verifyHidden();
      } catch {
        return null;
      }
      return this.hiddenRepo(this.runner);
    }
    return this.available.ok && this.available.repo.kind === 'folder' ? this.available.repo : null;
  }

  private async review(repo: MainRepo, merge: StoredMerge): Promise<{ base: string; files: ReviewFile[] }> {
    if (!(await commitExists(repo, merge.commit))) throw new SmurgError('not_found', msg('merge.commitGone'), { reason: 'commit-gone' });
    // A merged request is shown against the main workspace as it was before the merge.
    const against = merge.status === 'merged' && merge.mergeCommit !== undefined ? `${merge.mergeCommit}^1` : await mainHead(repo);
    if (against === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
    const base = await reviewBase(repo, against, merge.commit);
    // smurg's own history: the base this version's review recorded (DESIGN 0.6.0 D14); another one is a changed history,
    // unless the commit is in the history already (a merge smurg did not get to record: nothing is left to show).
    if (repo.kind === 'smurg' && merge.base !== undefined && base !== merge.base && base !== merge.commit) throw hiddenChanged('merge-base');
    return { base, files: await reviewFiles(repo, base, merge.commit, DEFAULT_REVIEW_LIMITS) };
  }

  private assertNotLocked(how: How, merge: StoredMerge, touched: readonly string[]): void {
    const locks = this.ctx.services.locks;
    if (isStubService(locks)) return; // no lock manager composed: no lock can exist
    const locked = touched.filter((path) => locks.get({ root: MAIN_ROOT, path }) !== null);
    if (locked.length === 0) return;
    const first = locks.get({ root: MAIN_ROOT, path: locked[0] as string });
    this.auditDecision(how, merge, 'denied', { reason: 'files-locked', paths: locked.slice(0, 20) });
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

  /**
   * `git merge` failed after merge-tree said it would not: a conflict that appeared meanwhile, or a refusal (a file
   * someone saved since the trial). With a merge under way it is undone and named as a conflict; without, the host is
   * told "merge failed" (0.6.0) and smurg's own try waits for the next pass (DESIGN 0.7.0 D7 step 10).
   */
  private async recoverFailedMerge(decider: Decider, merge: StoredMerge, repo: MainRepo, git: GitRunner, pre: string, base: string): Promise<Decided> {
    const head = await lstat(join(repo.gitDir, 'MERGE_HEAD')).catch(() => null);
    if (head !== null) {
      const workTree = this.ctx.roots.main.realPath;
      const unmerged = await git.run({ gitDir: repo.gitDir, workTree, attrSource: pre, args: ['diff', '--name-only', '-z', '--diff-filter=U', '--no-ext-diff', '--ignore-submodules=all'], readOnly: true, maxStdoutBytes: 16 * 1024 * 1024 });
      const conflicted = unmerged.code === 0 && !unmerged.truncated ? parseNameOnly(unmerged.stdout).map((path) => path.path) : [];
      // Our own merge created this state: undo it so the main workspace is as it was.
      await git.run({ gitDir: repo.gitDir, workTree, attrSource: pre, args: ['merge', '--abort'], timeoutMs: this.limits.mergeTimeoutMs, abortable: false });
      return this.conflicted(decider, merge, conflicted, repo, base, pre);
    }
    const now = await mainHead(repo);
    this.ctx.log.error('merge failed', { module: 'worktree', request: merge.id, headMoved: now !== pre });
    this.auditDecision(decider.how, merge, 'error', { reason: 'merge-failed' });
    if (decider.how.kind === 'auto') return { kind: 'wait', reason: 'retry' };
    throw new SmurgError('conflict', msg('merge.failed'), { reason: 'merge-failed' });
  }

  private async markConflict(decider: Decider, merge: StoredMerge, paths: readonly string[], reason: 'conflict' | 'local-changes'): Promise<StoredMerge> {
    const updated = this.updateMerge(merge.id, (draft) => {
      draft.status = 'conflict';
      draft.decidedAt = this.ctx.clock.now();
      draft.conflictFiles = [...new Set(paths)].slice(0, MERGE_FILES_MAX);
    });
    this.auditDecision(decider.how, updated, 'error', { reason, conflictFiles: (updated.conflictFiles ?? []).slice(0, 50), count: updated.conflictFiles?.length ?? 0 });
    this.publishMerge(updated, decider.how.kind === 'auto' ? SYSTEM_PRINCIPAL : decider.how.principal, decider.whose);
    await this.persist();
    return updated;
  }

  /**
   * One audit entry of a decision. The host's: `worktree.merge.approve` / `.reject`, as the host. smurg's own try
   * (DESIGN 0.7.0 D7, R-ENG E12): `worktree.merge.auto` as the system, on behalf of the host, with the consent it
   * applies, whatever its outcome (merged, a conflict, a denial, an error): never an `approve` entry.
   */
  private auditDecision(how: How, merge: StoredMerge, outcome: 'ok' | 'denied' | 'error', detail: Record<string, unknown>): void {
    const auto = how.kind === 'auto';
    const action = auto ? 'worktree.merge.auto' : merge.status === 'rejected' ? 'worktree.merge.reject' : 'worktree.merge.approve';
    this.ctx.audit.record({
      actor: auto ? SYSTEM_ACTOR : how.principal.actor,
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
        ...(auto ? { consent: how.input.consent, onBehalfOf: how.host.userId } : {}),
        // (DESIGN 0.6.0 D14: what uses smurg's own history says so)
        ...(merge.repo === 'smurg' ? { history: 'smurg' } : {}),
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
  // Undo (DESIGN 0.7.0 D14, undo.ts)
  // =================================================================================================================

  async undoPreview(input: UndoAsk): Promise<UndoFacts> {
    const host = this.undoHost(input.host);
    const where = await this.undoWhere(input);
    if ('facts' in where) return where.facts;
    return this.serial.run('main', async () => (await this.computeUndo(where, input, host)).facts);
  }

  async undo(input: UndoApply): Promise<UndoDone> {
    const host = this.undoHost(input.host);
    const where = await this.undoWhere(input);
    if ('facts' in where) {
      // Nothing of it can be done in this folder now: the topics module refuses it with what the preview says.
      input.confirm(where.facts);
      throw new SmurgError('conflict', msg('undo.notOk'), { reason: 'not-ok' });
    }
    return this.serial.run('main', async () => {
      // Steps 0 to 4 again against the head the apply has (smurg's own history: after a new snapshot), then the topics
      // module's yes (the token, nothing in the way; it claims the items), with nothing awaited in between.
      const computed = await this.computeUndo(where, input, host);
      input.confirm(computed.facts);
      if (computed.pre === null || computed.target === null || !computed.facts.clean || computed.facts.unavailable !== null) throw new SmurgError('conflict', msg('undo.notOk'), { reason: 'not-ok' });
      return this.applyUndo(where, computed, input, host);
    });
  }

  /** Undo is the host's: anyone else named is the caller's mistake, never an undo. */
  private undoHost(ref: UserRef): MemberRecord {
    const host = ref.userId === this.ctx.members.hostUserId() ? this.ctx.members.active(ref.userId) : null;
    if (host === null) throw new AuthorizationError(undefined, { reason: 'not-the-host' });
    return host;
  }

  /** The history of the items asked for (one: an undo is one commit in one history), usable now. */
  private async undoWhere(input: UndoAsk): Promise<UndoWhere> {
    const histories = new Set(input.asked.map((key) => input.items.find((item) => item.topicId === key.topicId && item.itemId === key.itemId)?.history ?? 'folder'));
    const history = histories.size === 1 ? ([...histories][0] as 'folder' | 'smurg') : null;
    if (history === null) return { facts: this.undoUnavailable('folder', this.undoReasons(input), msg('undo.unavailable.notFound')) };
    try {
      const { git, repo } = await this.repoOf(history === 'smurg' ? { repo: 'smurg' } : {});
      return { history, git, repo };
    } catch (err) {
      if (err instanceof SmurgError && err.detail?.['reason'] === 'stopping') throw err;
      // smurg's own history changed or gone, the folder's `.git` gone: its words of 0.6.0
      const text = err instanceof SmurgError && err.text !== undefined ? err.text : msg('worktree.unavailable.checkFailed');
      return { facts: this.undoUnavailable(history, this.undoReasons(input), text) };
    }
  }

  /** The items asked for, and every merged item of their plans built on them (the topics module's closure). */
  private undoReasons(input: UndoAsk): Map<string, 'asked' | 'built-on' | 'same-lines'> {
    const why = new Map<string, 'asked' | 'built-on' | 'same-lines'>();
    for (const key of input.asked) why.set(undoKey(key), 'asked');
    for (const key of input.withBuiltOn(input.asked)) if (!why.has(undoKey(key))) why.set(undoKey(key), 'built-on');
    return why;
  }

  private undoUnavailable(history: 'folder' | 'smurg', why: ReadonlyMap<string, 'asked' | 'built-on' | 'same-lines'>, unavailable: MessageRef): UndoFacts {
    return {
      history,
      items: [...why].map(([key, reason]) => ({ ...undoKeyParts(key), why: reason })),
      merges: [],
      clean: false,
      changedSince: [],
      typing: [],
      uncommitted: [],
      staged: false,
      busy: false,
      branch: null,
      unavailable,
      files: 0,
    };
  }

  /**
   * DESIGN 0.7.0 D14 steps 0 to 4, on the `main` queue (the caller holds it). Nothing of the folder or of its index is
   * touched: in smurg's own history the folder is recorded first (a snapshot as the host), and everything after is
   * computed against the head that snapshot leaves.
   */
  private async computeUndo(where: Extract<UndoWhere, { readonly history: string }>, input: UndoAsk, host: MemberRecord): Promise<ComputedUndo> {
    const { git, repo, history } = where;
    const hidden = repo.kind === 'smurg';
    const share = this.ctx.roots.main.realPath;
    const timeoutMs = this.limits.mergeTimeoutMs;
    const why = this.undoReasons(input);
    const nothing = (unavailable: MessageRef, pre: string | null = null): ComputedUndo => ({ facts: this.undoUnavailable(history, why, unavailable), pre, target: null, merges: [], changes: [] });

    // 0. An undo a crash cut short is settled first; one the folder still holds half-way stops every other one.
    if (this.requireDoc().get().undo !== undefined) await this.settleUndoNow();
    if (this.requireDoc().get().undo !== undefined) return nothing(msg('undo.unavailable.interrupted'));
    // smurg's own history: the folder as it is now is recorded FIRST, and all of it is computed against that (R-SAFE
    // S1: computed against the last snapshot, the undo commit took back saved edits nobody had recorded yet).
    const docs = this.ctx.services.docs;
    if (!isStubService(docs)) await docs.flushAll();
    let pre: string | null;
    if (hidden) {
      await this.verifyHidden();
      await removeStaleLock(repo.gitDir, this.ctx.log);
      pre = (await this.snapshotHidden(git, { message: HIDDEN_UNDO_MESSAGE, identity: gitIdentity(host.userId, host.displayName) })).head;
    } else pre = await mainHead(repo);
    if (pre === null) return nothing(msg('undo.unavailable.notFound'));
    const line = await firstParentLine(repo, pre, timeoutMs);
    if (line === null) return nothing(msg('undo.unavailable.notFound'), pre);

    // 1. The merge commits of every merged item of this history: each request's merge commit, else what topics.json
    //    recorded (worktrees.json keeps only the newest decided merges), else the merge whose second parent is the
    //    request's commit (U2 exp3). Each must lie on the main workspace's first-parent line.
    const known = new Map(input.items.map((item): [string, UndoItem] => [undoKey(item), item]));
    const doc = this.requireDoc().get();
    const parents = new Map<string, string | null>();
    const ofItem = new Map<string, { readonly merges: readonly UndoMerge[]; readonly complete: boolean }>();
    for (const item of input.items) {
      const key = undoKey(item);
      if (item.history !== history || ofItem.has(key)) continue;
      const requests = doc.merges.filter((merge) => merge.topicId === item.topicId && merge.itemId === item.itemId && merge.status === 'merged' && merge.undone === undefined && (merge.repo === 'smurg') === hidden);
      const found: { readonly commit: string; readonly requestId?: string; readonly topicSlug: string }[] = [];
      let complete = true;
      for (const request of requests) {
        const commit = request.mergeCommit ?? (item.mergedAs?.requestId === request.id ? item.mergedAs.commit : undefined) ?? (await this.mergeCommitOf(repo, request.commit, pre)) ?? undefined;
        if (commit === undefined) complete = false;
        else found.push({ commit, requestId: request.id, topicSlug: request.topicSlug ?? item.topicSlug });
      }
      if (requests.length === 0) {
        if (item.mergedAs?.commit !== undefined) found.push({ commit: item.mergedAs.commit, topicSlug: item.topicSlug });
        else complete = false;
      }
      const merges: UndoMerge[] = [];
      for (const entry of found) {
        const position = line.get(entry.commit);
        if (position !== undefined && !parents.has(entry.commit)) parents.set(entry.commit, await parentOf(repo, entry.commit));
        const parent = position === undefined ? null : (parents.get(entry.commit) ?? null);
        if (position === undefined || parent === null) {
          complete = false;
          continue;
        }
        merges.push({ key, topicId: item.topicId, itemId: item.itemId, topicSlug: entry.topicSlug, commit: entry.commit, parent, position, ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }) });
      }
      ofItem.set(key, { merges, complete: complete && merges.length > 0 });
    }
    /** The merges of these items, newest first (null: one of them has a merge smurg cannot find on the line). */
    const mergesOf = (keys: Iterable<string>): UndoMerge[] | null => {
      const out = new Map<string, UndoMerge>();
      for (const key of keys) {
        const entry = ofItem.get(key);
        if (entry === undefined || !entry.complete) return null;
        for (const merge of entry.merges) if (!out.has(merge.commit)) out.set(merge.commit, merge);
      }
      return [...out.values()].sort((a, b) => a.position - b.position);
    };
    const tooMany = (): ComputedUndo => nothing(msg('undo.unavailable.tooMany', { max: UNDO_ITEMS_MAX }), pre);

    // 2. + 3. What goes with them, and the trial (objects only). (a) the plans' dependents that are merged (the topics
    //    module's closure, `built-on`); (b) later merges of ANY topic whose revert must come first: added newest first,
    //    those that touch a conflicted file, until the trial is clean, then each whose removal keeps it clean is removed
    //    again (`same-lines`, U2 exp5: a file-level rule gives false positives, the trial does not); what is built on
    //    those goes too, and the trial is made again. (c) what still conflicts is a change outside the work items.
    let merges: UndoMerge[] = [];
    let trial: RevertTrial = { clean: false, conflicted: [] };
    let tried: string[] = [];
    let incomplete = false;
    for (let round = 0; round <= UNDO_ITEMS_MAX; round += 1) {
      if (why.size > UNDO_ITEMS_MAX) return tooMany();
      const set = mergesOf(why.keys());
      if (set === null) {
        incomplete = true;
        merges = [];
        break;
      }
      if (set.length > UNDO_ITEMS_MAX) return tooMany();
      merges = set;
      trial = await revertTrial(repo, pre, merges, timeoutMs);
      tried = [];
      if (trial.clean) break;
      const oldest = Math.max(...merges.map((merge) => merge.position));
      const candidates: { readonly key: string; readonly newest: number }[] = [];
      for (const [key, entry] of ofItem) {
        if (why.has(key) || !entry.complete) continue;
        const later = entry.merges.filter((merge) => merge.position < oldest);
        let touches = false;
        for (const merge of later) {
          if (await mergeTouches(repo, merge, trial.conflicted, timeoutMs)) {
            touches = true;
            break;
          }
        }
        if (touches) candidates.push({ key, newest: Math.min(...entry.merges.map((merge) => merge.position)) });
      }
      candidates.sort((a, b) => a.newest - b.newest);
      tried = candidates.map((candidate) => candidate.key);
      const added: string[] = [];
      let cleanWith = false;
      for (const candidate of candidates) {
        added.push(candidate.key);
        if ((await revertTrial(repo, pre, mergesOf([...why.keys(), ...added]) ?? [], timeoutMs)).clean) {
          cleanWith = true;
          break;
        }
      }
      if (!cleanWith) break;
      for (const key of [...added]) {
        const without = added.filter((other) => other !== key);
        if ((await revertTrial(repo, pre, mergesOf([...why.keys(), ...without]) ?? [], timeoutMs)).clean) added.splice(added.indexOf(key), 1);
      }
      for (const key of added) why.set(key, 'same-lines');
      for (const key of input.withBuiltOn([...why.keys()].map(undoKeyParts))) if (!why.has(undoKey(key))) why.set(undoKey(key), 'built-on');
    }
    const clean = !incomplete && trial.clean;

    // The tree the folder becomes: the trial's, with the undone items' reports as the head has them (they stay).
    let target: string | null = null;
    let changes: { readonly letter: string; readonly path: string }[] = [];
    if (clean && trial.clean) {
      const reports = [...why.keys()].flatMap((key) => {
        const item = known.get(key);
        return item === undefined ? [] : [topicReportPath(item.topicSlug, item.itemId)];
      });
      target = await withFilesOf(repo, { tree: trial.tree, head: pre, paths: reports, stagingDir: this.stagingDir, timeoutMs });
      changes = await changesBetween(repo, pre, target, timeoutMs);
    }
    const touched = target !== null ? changes.map((change) => change.path) : [...new Set((await Promise.all(merges.map((merge) => changedNames(repo, merge.parent, merge.commit)))).flatMap((names) => names.paths))];

    // (c) Who changed the lines it cannot take back (people-changes.ts, D7): a member, or someone outside smurg.
    let changedSince: PeopleChange[] = [];
    if (!incomplete && !trial.clean && merges.length > 0) {
      const oldest = merges.reduce((older, merge) => (merge.position > older.position ? merge : older));
      const all = tried.length > 0 ? await revertTrial(repo, pre, mergesOf([...why.keys(), ...tried]) ?? merges, timeoutMs) : trial;
      const paths = [...new Set([...trial.conflicted, ...(all.clean ? [] : all.conflicted)])];
      try {
        changedSince = await this.peopleOf(repo, oldest.commit, pre, paths);
      } catch {
        changedSince = paths.map((path) => ({ path, by: [], outside: true }));
      }
    }

    // 4. The main workspace, as for a merge, but reported, not waited on (undo is a person's act).
    const typing: { path: string; names: UserRef[] }[] = [];
    const locks = this.ctx.services.locks;
    if (!isStubService(locks)) {
      for (const path of touched) {
        if (typing.length >= AUTO_MERGE_PATHS_MAX) break;
        const lock = locks.get({ root: MAIN_ROOT, path });
        if (lock === null) continue;
        const names = lock.kind === 'human' ? lock.holders.map((holder) => ({ userId: holder.userId, displayName: holder.displayName })) : [this.ctx.members.userRef(lock.ownerUserId)].filter((user): user is UserRef => user !== null);
        typing.push({ path, names: names.slice(0, PEOPLE_PER_PATH_MAX) });
      }
    }
    let uncommitted: string[] = [];
    let staged = false;
    let branch: { readonly expected: string; readonly current: string } | null = null;
    if (!hidden) {
      const dirty = await this.dirtyPaths(repo, git, pre);
      const inTheWay = target !== null ? await untrackedInTheWay(share, changes) : [];
      uncommitted = [...new Set([...touched.filter((path) => dirty.has(path)), ...inTheWay])];
      staged = await hasStagedChanges(repo, pre);
      const place = await headPlace(repo);
      const expected = [...why.keys()].map((key) => known.get(key)?.branch).find((name): name is string => name !== undefined);
      if (expected !== undefined && place.branch !== expected) branch = { expected, current: place.current };
    }
    const busy = (await busyMarker(repo)) !== null;
    // A merge smurg cannot find (not on the line, its records gone) is said as such, unless another branch explains it;
    // the record an apply writes names requests, so at least one of them must be one smurg knows.
    const unavailable = incomplete
      ? branch === null
        ? msg('undo.unavailable.notFound')
        : null
      : !merges.some((merge) => merge.requestId !== undefined)
        ? msg('undo.unavailable.notFound')
        : !clean && changedSince.length === 0
          ? msg('undo.notOk')
          : null;
    return {
      facts: {
        history,
        items: [...why].map(([key, reason]) => ({ ...undoKeyParts(key), why: reason })),
        merges: merges.map((merge) => ({ topicId: merge.topicId, itemId: merge.itemId, commit: merge.commit, ...(merge.requestId === undefined ? {} : { requestId: merge.requestId }) })),
        clean,
        changedSince,
        typing,
        uncommitted,
        staged,
        busy,
        branch,
        unavailable,
        files: touched.length,
      },
      pre,
      target,
      merges,
      changes,
    };
  }

  /**
   * DESIGN 0.7.0 D14 step 6 (the caller holds the `main` queue and the topics module said yes): the record, on disk
   * before the folder is touched; `read-tree -m -u <pre> <target>`, which refuses a touched file that holds an edit git
   * does not have; ONE commit as the host; every request `undone`.
   */
  private async applyUndo(where: Extract<UndoWhere, { readonly history: string }>, computed: ComputedUndo, input: UndoApply, host: MemberRecord): Promise<UndoDone> {
    const { git, repo } = where;
    const hidden = repo.kind === 'smurg';
    const share = this.ctx.roots.main.realPath;
    const timeoutMs = this.limits.mergeTimeoutMs;
    const pre = computed.pre as string;
    const target = computed.target as string;
    const requestIds = [...new Set(computed.merges.flatMap((merge) => (merge.requestId === undefined ? [] : [merge.requestId])))];
    if (requestIds.length === 0 || requestIds.length > UNDO_ITEMS_MAX) throw new SmurgError('conflict', msg('undo.notOk'), { reason: 'not-ok' });
    const doc = this.requireDoc();
    doc.update((draft) => {
      draft.undo = { requestIds, pre, target, ...(hidden ? { repo: 'smurg' as const } : {}), at: this.ctx.clock.now() };
    });
    try {
      await doc.flush();
    } catch (err) {
      doc.update((draft) => {
        delete draft.undo;
      });
      throw err;
    }
    // What the undo writes into the main workspace is the host's act, not a program's (the watcher's attribution).
    const files = this.ctx.services.files;
    const actor = userActor(host);
    if (!isStubService(files) && computed.changes.length <= 5_000) for (const change of computed.changes) files.expectChange({ root: MAIN_ROOT, path: change.path }, actor);
    const read = await git.run({ gitDir: repo.gitDir, workTree: share, attrSource: pre, args: ['read-tree', '-m', '-u', pre, target], timeoutMs, abortable: false });
    if (read.code !== 0) {
      // git refused (a file it changes was edited since the look: "not uptodate"). It checks before it writes: when the
      // index is still `pre`'s and no file it changes holds the undo's version, nothing of the undo was written and the
      // record goes, the person's edit stays. Anything else is what the folder holds decides (step 7).
      this.ctx.log.warn('an undo was refused by git: a file it changes holds an edit git does not have', { module: 'worktree', git: read.stderr.split('\n', 1)[0]?.slice(0, 300) ?? '' });
      const index = await indexTree(repo, timeoutMs).catch(() => null);
      const untouched =
        index !== null &&
        index === (await treeOf(repo, pre)) &&
        (await notAsIn(repo, { workTree: share, commit: target, paths: computed.changes.map((change) => change.path), attrSource: pre, timeoutMs }).catch(() => null))?.size === computed.changes.length;
      if (untouched) {
        doc.update((draft) => {
          delete draft.undo;
        });
        await this.persist();
      } else await this.settleUndoNow();
      throw new SmurgError('conflict', msg('undo.changed'), { reason: 'changed' });
    }
    let commit: string;
    try {
      commit = await commitOnHead(repo, { tree: target, parent: pre, message: undoMessage(input.subject, computed.merges), identity: gitIdentity(host.userId, host.displayName), timeoutMs });
    } catch (err) {
      // The commit did not land: what the folder holds decides (case b makes it now; else the host is told, case d).
      await this.settleUndoNow().catch(() => {});
      const marked = this.requireDoc().get().merges.find((merge) => merge.id === requestIds[0])?.undone;
      if (marked === undefined) throw err;
      return { facts: computed.facts, commit: marked.commit, files: computed.changes.length };
    }
    this.recordUndone(requestIds, commit, { userId: host.userId, displayName: host.displayName });
    await this.persist();
    return { facts: computed.facts, commit, files: computed.changes.length };
  }

  /** Each request is `undone` by `commit`; the record goes; every member hears of each (`merge.changed`). */
  private recordUndone(requestIds: readonly string[], commit: string, by: UserRef): void {
    const at = this.ctx.clock.now();
    const ids = new Set(requestIds);
    this.requireDoc().update((draft) => {
      for (const merge of draft.merges) if (ids.has(merge.id) && merge.status === 'merged') merge.undone = { commit, at, by: { userId: by.userId, displayName: by.displayName } };
      delete draft.undo;
    });
    for (const merge of this.requireDoc().get().merges) if (ids.has(merge.id)) this.publishMerge(merge);
  }

  /**
   * DESIGN 0.7.0 D14 step 7 for whichever history the record is of (the caller holds the `main` queue, or it is the
   * start). smurg's own history is settled before the first command of a run on it (abortHiddenLeftovers); here again
   * when the record is still there.
   */
  private async settleUndoNow(): Promise<void> {
    const record = this.doc?.get().undo;
    if (record === undefined) return;
    if (record.repo === 'smurg') {
      // (git was not looked for yet in this run: the first use of that history settles it)
      if (this.runner === null) return;
      try {
        await this.verifyHidden();
      } catch {
        return;
      }
      if (this.doc?.get().undo === undefined) return;
      await this.settleUndoIn(this.hiddenRepo(this.runner), this.runner);
      return;
    }
    const available = this.available;
    if (!available.ok || available.repo.kind !== 'folder') return;
    await this.settleUndoIn(available.repo, available.git);
  }

  /**
   * An undo record still in worktrees.json (a crash during the apply, R-SAFE S11), settled by what the history and the
   * folder hold:
   *  (a) the first commit after `pre` on the line is the undo (its parent `pre`, its tree `target`, its words naming
   *      every merge): recorded now;
   *  (b) HEAD is `pre` and the index's tree is `target`: the commit was not made; smurg makes it now, as the host, with
   *      the same words, and records it;
   *  (c) HEAD is `pre`, the index's tree is `pre`'s, and every file the undo changes is in the folder as in `pre`:
   *      nothing was changed; the record goes;
   *  (d) anything else, between the two. In smurg's own history, where nobody but smurg runs git: the index becomes
   *      `target`, every file that still holds `pre`'s version gets `target`'s, a file that holds neither is a
   *      person's edit since and stays (the next snapshot records it), and the commit is made as in (b). In the
   *      folder's own git the record stays and every automatic merge and every undo is held (`undo-interrupted`) until
   *      the host has made the folder one of (a), (b), (c).
   */
  private async settleUndoIn(repo: MainRepo, git: GitRunner): Promise<void> {
    const doc = this.requireDoc();
    const record = doc.get().undo;
    if (record === undefined) return;
    const share = this.ctx.roots.main.realPath;
    const timeoutMs = this.limits.mergeTimeoutMs;
    const hidden = repo.kind === 'smurg';
    const requests = record.requestIds.flatMap((id) => {
      const merge = doc.get().merges.find((candidate) => candidate.id === id);
      return merge === undefined ? [] : [merge];
    });
    const hostId = this.ctx.members.hostUserId();
    const host = this.ctx.members.userRef(hostId) ?? { userId: hostId, displayName: 'host' };
    const recovered = (kind: 'a' | 'b' | 'c' | 'd', commit: string | null): void => {
      this.ctx.log.warn(commit === null ? 'an undo a crash cut short had changed nothing; its record went' : 'an undo a crash cut short was recorded', { module: 'worktree', case: kind });
      this.ctx.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'worktree.merge.undo',
        outcome: commit === null ? 'error' : 'ok',
        target: record.requestIds[0] ?? 'undo',
        detail: { reason: 'recovered-after-crash', case: kind, requestIds: [...record.requestIds], ...(commit === null ? { applied: false } : { commit }), onBehalfOf: host.userId, ...(hidden ? { history: 'smurg' } : {}) },
      });
    };
    const head = await mainHead(repo);
    if (head !== null && head !== record.pre) {
      const next = await nextOnLine(repo, head, record.pre, timeoutMs);
      if (next !== null && (await parentOf(repo, next)) === record.pre && (await treeOf(repo, next)) === record.target) {
        const body = (await messageOf(repo, next)) ?? '';
        const named = requests.every((request) => request.mergeCommit === undefined || body.includes(`This reverts commit ${request.mergeCommit},`));
        if (body.startsWith('smurg: undo') && named) {
          this.recordUndone(record.requestIds, next, host);
          await this.persist();
          recovered('a', next);
          return;
        }
      }
    }
    const held = (): void => this.ctx.log.warn('an undo a crash cut short is still in the main workspace; merges wait for the host', { module: 'worktree', history: hidden ? 'smurg' : 'folder' });
    if (head !== record.pre) {
      held();
      return;
    }
    const finish = async (kind: 'b' | 'd'): Promise<void> => {
      const merges = await this.recordedMerges(repo, requests, record.pre);
      const commit = await commitOnHead(repo, { tree: record.target, parent: record.pre, message: undoMessage(recoverySubject(requests), merges), identity: gitIdentity(host.userId, host.displayName), timeoutMs });
      this.recordUndone(record.requestIds, commit, host);
      await this.persist();
      recovered(kind, commit);
    };
    const index = await indexTree(repo, timeoutMs);
    if (index === record.target) {
      await finish('b');
      return;
    }
    const changes = await changesBetween(repo, record.pre, record.target, timeoutMs);
    const touched = changes.map((change) => change.path);
    if (index !== null && index === (await treeOf(repo, record.pre))) {
      const changed = await notAsIn(repo, { workTree: share, commit: record.pre, paths: touched, ...(hidden ? {} : { attrSource: record.pre }), timeoutMs });
      if (changed.size === 0) {
        doc.update((draft) => {
          delete draft.undo;
        });
        await this.persist();
        recovered('c', null);
        return;
      }
    }
    if (!hidden) {
      held();
      return;
    }
    const changed = await notAsIn(repo, { workTree: share, commit: record.pre, paths: touched, timeoutMs });
    const asBefore = touched.filter((path) => !changed.has(path));
    const removed = new Set(changes.filter((change) => change.letter === 'D').map((change) => change.path));
    requireOk(await git.run({ gitDir: repo.gitDir, args: ['read-tree', record.target], timeoutMs, abortable: false }), 'stage');
    await checkoutFromIndex(repo, { workTree: share, paths: asBefore.filter((path) => !removed.has(path)), timeoutMs });
    for (const path of asBefore) if (removed.has(path)) await removeEntryBelow(share, path);
    await finish('d');
  }

  /** The merges of these requests with what each was merged into, newest first on `pre`'s first-parent line. */
  private async recordedMerges(repo: MainRepo, requests: readonly StoredMerge[], pre: string): Promise<UndoMergeCommit[]> {
    const line = (await firstParentLine(repo, pre, this.limits.mergeTimeoutMs)) ?? new Map<string, number>();
    const out: (UndoMergeCommit & { readonly position: number })[] = [];
    for (const request of requests) {
      const commit = request.mergeCommit ?? (await this.mergeCommitOf(repo, request.commit, pre));
      const parent = commit === null ? null : await parentOf(repo, commit);
      if (commit !== null && parent !== null) out.push({ commit, parent, position: line.get(commit) ?? Number.MAX_SAFE_INTEGER });
    }
    return out.sort((a, b) => a.position - b.position).map(({ commit, parent }) => ({ commit, parent }));
  }

  // =================================================================================================================
  // The main workspace's own files (the checkpoint of a Start, the pin check, "Show the changes")
  // =================================================================================================================

  async commitMainPaths(input: { readonly paths: readonly string[]; readonly message: string; readonly trailers: readonly string[]; readonly as: Principal }): Promise<{
    readonly commit: string;
    readonly created: boolean;
    readonly branch: string;
    readonly blobs: Readonly<Record<string, string>>;
    readonly history: 'folder' | 'smurg';
  }> {
    const member = this.memberOf(input.as);
    // A Start's checkpoint may look for git (Start looked already: smurg's own history needs it).
    await this.refreshGitState();
    if (this.observed !== null && !this.observed.exists) await this.lookForGit();
    const { git, repo } = await this.availableNow();
    const identity = gitIdentity(member.userId, member.displayName);
    if (repo.kind === 'smurg') {
      // smurg's own history (DESIGN 0.6.0 D14): the checkpoint records the WHOLE folder as it is (the Start dialog says
      // so, `start.smurgHistory`), as the member who pressed Start; the history is made first when it is not there.
      return this.serial.run('main', async () => {
        await this.ensureHidden(git);
        const snapshot = await this.snapshotHidden(git, { message: checkpointMessage(input.message, input.trailers), identity });
        const at = await blobsAt(repo, snapshot.head, input.paths, this.limits.gitTimeoutMs);
        const blobs: Record<string, string> = {};
        for (const path of input.paths) {
          const blob = at[path];
          if (blob !== null && blob !== undefined) blobs[path] = blob;
          // What the member confirmed is a file: a snapshot that left it out (a `.gitignore` of the folder) is not its checkpoint.
          else if ((await plainFileKind(this.ctx.roots.main.realPath, path)) === 'file') throw new SmurgError('conflict', msg('plan.start.commit.ignored', { path }), { reason: 'git-ignored', path });
        }
        return { commit: snapshot.head, created: snapshot.created, branch: (await currentBranch(repo)) ?? 'HEAD', blobs, history: 'smurg' as const };
      });
    }
    // On the queue of merges: a merge and the checkpoint never interleave their steps.
    const result = await this.serial.run('main', () =>
      commitMainPaths({ repo, workTree: this.ctx.roots.main.realPath, paths: input.paths, message: input.message, trailers: input.trailers, identity, timeoutMs: this.limits.gitTimeoutMs }),
    );
    return { ...result, history: 'folder' as const };
  }

  async headBlobs(paths: readonly string[], options: { readonly history?: 'folder' | 'smurg' } = {}): Promise<Record<string, string | null>> {
    const none = (): Record<string, string | null> => Object.fromEntries(paths.map((path) => [path, null]));
    await this.refreshGitState();
    if (this.stopped) return none();
    const repo = await this.historyRepo(options.history).catch(() => null);
    if (repo === null) return none();
    const head = await mainHead(repo);
    return head === null ? none() : blobsAt(repo, head, paths, this.limits.gitTimeoutMs);
  }

  /**
   * The repository of a history as it can be read now, never made (null: none to read): `smurg` (verified), `folder`
   * (the folder's own while worktree mode uses it), or by default the one new work uses now.
   */
  private async historyRepo(history: 'folder' | 'smurg' | undefined): Promise<MainRepo | null> {
    const available = this.forNewWork();
    const kind = history ?? (available.ok ? available.repo.kind : null);
    if (kind === null) return null;
    if (kind === 'folder') return available.ok && available.repo.kind === 'folder' ? available.repo : null;
    if (this.runner === null || this.gitBinary?.kind !== 'ok') return null;
    const record = this.hiddenRecord();
    if (record === undefined || (await hiddenOnDisk(this.ctx.roots.main.realPath)) === 'absent') return null;
    await verifyHiddenRepo(hiddenGitDir(this.ctx.roots.main.realPath), record);
    return this.hiddenRepo(this.runner);
  }

  workState(): WorkState {
    // Only what is known: never a git run (a teammate's request must not make smurg look for git, DESIGN 0.6.0 D14).
    const binary = this.gitBinary === null ? null : binaryUnavailable(this.gitBinary);
    if (binary !== null) return { history: 'direct', reason: wireText(binary.error.text ?? msg('worktree.unavailable.gitCannotRun')) };
    // Something at `.git` (a repository, or one git does not take: Start says why) is the folder's own history; so is
    // nothing at all while records of the folder's own repository wait for it (gitDirGone: put it back).
    const observed = this.observed;
    const atGit = observed === null ? this.ctx.workspace.info.isGitRepo : observed.exists;
    if (atGit || this.folderRecordsWait()) return { history: 'folder' };
    return this.gitBinary?.kind === 'ok' ? { history: 'smurg' } : { history: 'unchecked' };
  }

  /** MainState.history: how items started now would run (an unchecked folder counts as its own, with its refusal). */
  private historyNow(): MainState['history'] {
    const work = this.workState();
    return work.history === 'unchecked' ? 'folder' : work.history;
  }

  async mainState(): Promise<MainState> {
    await this.refreshGitState();
    // The Start dialog and Start may look for git (0.5.2's preflight already did for a folder that is no repository):
    // smurg's own history needs it.
    if (this.observed !== null && !this.observed.exists) await this.lookForGit();
    const isRepo = this.ctx.workspace.info.isGitRepo;
    const free = Math.max(0, this.limits.maxWorktrees - this.records().length);
    const available = this.forNewWork();
    if (!available.ok) {
      // git itself first (`git init` needs it), then what the folder lacks (a `.git` that went, when worktrees or
      // open merge requests are on record: refusal).
      const binary = await this.gitBinaryNow();
      const unusable = binaryUnavailable(binary);
      const reason = unusable?.error ?? this.refusal(available);
      return { isRepo, hasCommit: false, gitOk: binary.kind === 'ok', unavailable: reason.text ?? msg('worktree.unavailable.checkFailed'), branch: null, busy: false, free, history: unusable !== null ? 'direct' : this.historyNow() };
    }
    const repo = available.repo;
    if (repo.kind === 'smurg') {
      // Nothing is made here (the Start dialog's prepareStart does): what stops its use as it is found.
      try {
        const problem = await this.hiddenProblemNow();
        const there = problem === null && (await hiddenOnDisk(this.ctx.roots.main.realPath)) === 'present';
        const head = there ? await mainHead(repo).catch(() => null) : null;
        return { isRepo: false, hasCommit: head !== null, gitOk: true, unavailable: problem?.text ?? null, branch: null, busy: there && (await busyMarker(repo)) !== null, free, history: 'smurg' };
      } catch {
        return { isRepo: false, hasCommit: false, gitOk: true, unavailable: msg('worktree.unavailable.checkFailed'), branch: null, busy: false, free, history: 'smurg' };
      }
    }
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
        history: 'folder',
      };
    } catch {
      return { isRepo, hasCommit: false, gitOk: false, unavailable: msg('worktree.unavailable.checkFailed'), branch: null, busy: false, free, history: 'folder' };
    }
  }

  async prepareStart(): Promise<StartFolderFacts> {
    const nothing: StartFolderFacts = { nestedRepos: [], cloudSynced: false, problem: null };
    // (the Start dialog looked already, mainState: this is the same look)
    await this.refreshGitState();
    if (this.observed !== null && !this.observed.exists) await this.lookForGit();
    const available = this.forNewWork();
    if (this.stopped || !available.ok || available.repo.kind !== 'smurg') return nothing;
    const git = available.git;
    const cloudSynced = isCloudSynced(this.ctx.roots.main.realPath, this.home());
    try {
      // The history is made when it is not there (cheap), and the folder listed: the bound and nested repositories.
      const listing = await this.serial.run('main', async () => {
        await this.ensureHidden(git);
        const run = this.hiddenRun(git);
        await writeHiddenExclude(run.gitDir, hiddenExcludeLines({ sharedDirs: this.sharedDirs() }));
        const listed = await listFolder(run);
        this.lastListing = { bytes: listed.bytes, nested: listed.nested };
        return listed;
      });
      const nestedRepos = listing.nested.slice(0, PREFLIGHT_NESTED_REPOS_MAX);
      if (listing.tooLarge) return { nestedRepos, cloudSynced, problem: tooLargeError(listing, this.hiddenRun(git)).text ?? null };
      // The expensive part (hashing every file into objects) while the person reads the dialog.
      this.warmUp(git);
      return { nestedRepos, cloudSynced, problem: null };
    } catch (err) {
      if (err instanceof SmurgError && err.text !== undefined && err.detail?.['reason'] !== 'stopping') return { nestedRepos: [], cloudSynced, problem: err.text };
      if (err instanceof SmurgError && err.detail?.['reason'] === 'stopping') return nothing;
      this.ctx.log.warn("smurg's own history could not be prepared for the Start dialog", { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
      return { nestedRepos: [], cloudSynced, problem: msg('worktree.unavailable.checkFailed') };
    }
  }

  /** The Start dialog's warm-up: the bound and `git add -A` without a commit, on the `main` queue (a Start waits for it there). */
  private warmUp(git: GitRunner): void {
    if (this.warmingUp !== null || this.stopped) return;
    const run = this.serial
      .run('main', async () => {
        if (this.stopped) return;
        await this.ensureHidden(git);
        const outcome = await snapshotFolder(this.hiddenRun(git), { sharedDirs: this.sharedDirs(), message: '', identity: SMURG_IDENTITY, commit: false });
        this.lastListing = { bytes: outcome.listing.bytes, nested: outcome.listing.nested };
      })
      .catch((err: unknown) => {
        this.ctx.log.warn("the warm-up of smurg's own history did not finish; Start takes the whole snapshot", { module: 'worktree', reason: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : err instanceof Error ? err.name : 'unknown' });
      })
      .finally(() => {
        if (this.warmingUp === run) this.warmingUp = null;
      });
    this.warmingUp = run;
  }

  async historyState(history: 'folder' | 'smurg' | 'direct'): Promise<HistoryState> {
    if (this.stopped || this.doc === null) return 'unknown';
    await this.refreshGitState();
    // A pin of these histories was made where git ran (or, for `direct`, by the host who saw it does not): looking is
    // what Start did too.
    await this.lookForGit();
    if (this.gitBinary === null) return 'unknown';
    const unusable = binaryUnavailable(this.gitBinary) !== null;
    if (history === 'direct') return unusable ? 'usable' : 'changed';
    if (unusable) return 'changed';
    const share = this.ctx.roots.main.realPath;
    if (history === 'smurg') {
      if (this.runner === null) return 'unknown';
      const record = this.hiddenRecord();
      if (record === undefined) return 'changed';
      const problem = await hiddenProblem(share, record, true).catch(() => null);
      return problem === null && (await hiddenOnDisk(share)) === 'present' ? 'usable' : 'changed';
    }
    const observed = this.observed;
    if (observed === null) return 'unknown';
    if (!observed.exists || !(observed.kind === 'dir' && observed.plain)) return 'changed';
    return this.available.ok && this.available.repo.kind === 'folder' ? 'usable' : 'unknown';
  }

  async diffMainPaths(input: { readonly paths: readonly string[]; readonly against: 'head' | Readonly<Record<string, string | null>>; readonly maxBytes: number }): Promise<{ readonly path: string; readonly diff: string; readonly truncated: boolean }[]> {
    await this.refreshGitState();
    if (this.stopped) throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });
    // smurg's own history is read as it is (never made here): without one there is nothing to compare with.
    const repo = await this.historyRepo(undefined).catch(() => null);
    if (repo === null) return [];
    return diffMainPaths({
      repo,
      workTree: this.ctx.roots.main.realPath,
      stagingRoot: this.stagingDir,
      paths: input.paths,
      against: input.against,
      maxBytes: input.maxBytes,
      timeoutMs: this.limits.gitTimeoutMs,
    });
  }

  // =================================================================================================================
  // smurg's own history of a folder without `.git` (DESIGN 0.6.0 D14)
  // =================================================================================================================

  private hiddenRecord(): StoredHiddenRepo | undefined {
    return this.doc?.get().hidden;
  }

  /** Worktrees or open merge requests made from smurg's own history remain. */
  private openHiddenRecords(): boolean {
    const doc = this.doc?.get();
    return doc !== undefined && (doc.worktrees.some((record) => record.repo === 'smurg') || doc.merges.some((merge) => merge.repo === 'smurg' && isOpenMerge(merge)));
  }

  /** Worktrees or open merge requests of the folder's OWN repository remain (a `.git` that went strands them: gitDirGone). */
  private folderRecordsWait(): boolean {
    const doc = this.doc?.get();
    return doc !== undefined && (doc.worktrees.some((record) => record.repo === undefined) || doc.merges.some((merge) => merge.repo === undefined && isOpenMerge(merge)));
  }

  private hiddenRepo(git: GitRunner): MainRepo {
    return { git, gitDir: hiddenGitDir(this.ctx.roots.main.realPath), kind: 'smurg' };
  }

  private hiddenRun(git: GitRunner): HiddenRun {
    return {
      git,
      gitDir: hiddenGitDir(this.ctx.roots.main.realPath),
      shareReal: this.ctx.roots.main.realPath,
      timeoutMs: this.limits.hiddenSnapshotTimeoutMs,
      log: this.ctx.log,
      maxFiles: this.limits.hiddenMaxFiles,
      maxBytes: this.limits.hiddenMaxBytes,
      looseObjectsMax: this.limits.hiddenLooseObjectsMax,
    };
  }

  private sharedDirs(): readonly string[] {
    return this.ctx.settings.get().sharedDirs;
  }

  private home(): string | null {
    return this.ctx.config.sessions.hostHome ?? homedir();
  }

  /** What stops the use of smurg's own history as it is found now (no git, nothing made). */
  private hiddenProblemNow(): Promise<SmurgError | null> {
    return hiddenProblem(this.ctx.roots.main.realPath, this.hiddenRecord(), this.openHiddenRecords());
  }

  /**
   * smurg's own history, made when it is not there and checked; a stale `index.lock` goes. Runs on the `main` queue
   * (only smurg runs git there, one command at a time).
   */
  private async ensureHidden(git: GitRunner): Promise<void> {
    const share = this.ctx.roots.main.realPath;
    await ensureHiddenRepo({
      git,
      shareReal: share,
      template: this.templateDir,
      record: this.hiddenRecord(),
      openRecords: this.openHiddenRecords(),
      save: async (record) => {
        this.requireDoc().update((draft) => {
          if (record === undefined) delete draft.hidden;
          else draft.hidden = { createdAt: record.createdAt, configHash: record.configHash, headHash: record.headHash };
        });
        // The record is on disk before the history gets its name (a crash in between starts anew).
        await this.requireDoc().flush();
      },
      now: () => this.ctx.clock.now(),
      excludeLines: hiddenExcludeLines({ sharedDirs: this.sharedDirs() }),
      log: this.ctx.log,
    });
    const record = this.hiddenRecord();
    if (record === undefined) throw hiddenGone();
    await verifyHiddenRepo(hiddenGitDir(share), record);
    await removeStaleLock(hiddenGitDir(share), this.ctx.log);
    await this.settleHidden(git);
  }

  /** An existing history for what works on a record of it: checked, never made (gone: `worktree.hidden.gone`). */
  private async verifyHidden(): Promise<void> {
    const share = this.ctx.roots.main.realPath;
    const problem = await hiddenProblem(share, this.hiddenRecord(), true);
    if (problem !== null) throw problem;
    if ((await hiddenOnDisk(share)) === 'absent') throw hiddenGone();
    if (this.runner !== null) await this.settleHidden(this.runner);
  }

  /**
   * smurg's own history after a crash (DESIGN 0.7.0 D7, U4 (3)): a merge or a revert git is in the middle of in
   * `.smurg/git` can only be smurg's own (no person and no agent runs git there: the deny rules of 0.6.0 D8a), left by a
   * crash, and it would hold every merge with words the host cannot act on. Before the first command of a run on that
   * history (smurg looks for git lazily there, so "at the start" is the first use), it is aborted (`merge --abort` /
   * `revert --abort`, which keeps every file the half-done step did not touch), logged and audited: outcome `error`,
   * reason `recovered-after-crash`, as `worktree.merge.auto` when the message carries smurg's trailer, else as the
   * host's `worktree.merge.approve` (an interrupted revert as `worktree.merge.undo`). A `.git` of the folder is the
   * host's and never touched (decide's step 3 names smurg's own leftover there).
   */
  private settleHidden(git: GitRunner): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.hiddenSettled ??= this.abortHiddenLeftovers(git).catch((err: unknown) => {
      this.ctx.log.error("what a crash left in smurg's own history could not be undone", { module: 'worktree', error: err instanceof Error ? err.name : 'unknown' });
    });
    return this.hiddenSettled;
  }

  private async abortHiddenLeftovers(git: GitRunner): Promise<void> {
    const share = this.ctx.roots.main.realPath;
    const repo: MainRepo = { git, gitDir: hiddenGitDir(share), kind: 'smurg' };
    for (const step of ['merge', 'revert'] as const) {
      const marker = step === 'merge' ? 'MERGE_HEAD' : 'REVERT_HEAD';
      if ((await lstat(join(repo.gitDir, marker)).catch(() => null)) === null) continue;
      const automatic = step === 'merge' && (await smurgMergeLeftover(repo, AUTO_MERGE_TRAILER)) !== null;
      const head = await mainHead(repo).catch(() => null);
      const result = await git.run({ gitDir: repo.gitDir, workTree: share, ...(head !== null ? { attrSource: head } : {}), args: [step, '--abort'], timeoutMs: this.limits.mergeTimeoutMs, abortable: false });
      const aborted = result.code === 0;
      if (aborted) this.ctx.log.warn(`smurg's own history held a ${step} a crash had left; it was undone`, { module: 'worktree', marker });
      else this.ctx.log.error(`smurg's own history holds a ${step} a crash left, and it could not be undone`, { module: 'worktree', marker });
      this.ctx.audit.record({
        actor: SYSTEM_ACTOR,
        action: step === 'revert' ? 'worktree.merge.undo' : automatic ? 'worktree.merge.auto' : 'worktree.merge.approve',
        outcome: 'error',
        target: marker,
        detail: { reason: 'recovered-after-crash', marker, aborted, history: 'smurg' },
      });
    }
    // An undo a crash cut short in smurg's own history (DESIGN 0.7.0 D14 step 7): settled before anything else runs here.
    if (this.doc?.get().undo?.repo === 'smurg') await this.settleUndoIn(repo, git);
  }

  /** A snapshot of the folder into smurg's own history (the caller holds the `main` queue and ran ensureHidden). */
  private async snapshotHidden(git: GitRunner, input: { readonly message: string; readonly identity: GitIdentity }): Promise<{ readonly head: string; readonly created: boolean }> {
    const outcome = await snapshotFolder(this.hiddenRun(git), { sharedDirs: this.sharedDirs(), message: input.message, identity: input.identity, commit: true });
    this.lastListing = { bytes: outcome.listing.bytes, nested: outcome.listing.nested };
    if (outcome.head === null) throw new SmurgError('internal', msg('git.stepFailed', { step: 'commit' }), { reason: 'git-failed', step: 'commit' });
    return { head: outcome.head, created: outcome.created };
  }

  /**
   * Before a clone of smurg's own history: the free disk space with the upload rule (files/disk.ts: statfs, the host's
   * reserve) against the size of the last snapshot. Refused with `worktree.hidden.noSpace`.
   */
  private async diskCheck(): Promise<void> {
    const bytes = this.lastListing?.bytes ?? 0;
    const statfs = this.options.statfs ?? nodeStatfs;
    const snapshot = await statfs(this.ctx.roots.worktreesDir).catch(() => null);
    if (snapshot === null) {
      this.ctx.log.warn('the free disk space could not be read before a clone of smurg\'s own history', { module: 'worktree' });
      return;
    }
    const report = diskReport(snapshot, this.ctx.settings.get(), 0, bytes);
    if (report.ok) return;
    throw new SmurgError('conflict', msg('worktree.hidden.noSpace', { needed: sizeText(bytes), free: sizeText(Math.max(0, report.availableBytes - report.reserveBytes)) }), {
      reason: 'hidden-no-space',
      neededBytes: bytes,
      availableBytes: report.availableBytes,
      reserveBytes: report.reserveBytes,
    });
  }

  /**
   * The repository a record belongs to, usable now (DESIGN 0.6.0 D14 "Records say which repository"): smurg's own
   * history (checked; git looked for when no look did yet: the record says it ran) whatever the folder has now, or
   * the folder's own `.git` (refused with what is wrong with it, gitDirGone when it went).
   */
  private async repoOf(record: { readonly repo?: 'smurg' | undefined }): Promise<{ readonly git: GitRunner; readonly repo: MainRepo }> {
    if (this.stopped) throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });
    if (record.repo === 'smurg') {
      await this.lookForGit();
      const binary = this.gitBinary === null ? uncheckedState() : binaryUnavailable(this.gitBinary);
      if (binary !== null) throw binary.error;
      if (this.runner === null) throw uncheckedState().error;
      await this.verifyHidden();
      return { git: this.runner, repo: this.hiddenRepo(this.runner) };
    }
    await this.refreshGitState();
    const available = this.available;
    if (available.ok && available.repo.kind === 'folder') return { git: available.git, repo: available.repo };
    if (available.ok) throw new SmurgError('conflict', msg('worktree.unavailable.gitDirGone'), { reason: 'git-dir-gone' });
    throw this.refusal(available);
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
    // (records of the folder's own repository that wait for its `.git` decide `workState()`)
    this.announceWork();
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
        : merge.status === 'merged' && merge.auto === true
          ? // smurg merged it by itself (DESIGN 0.7.0 D7): the entry is smurg's, and names whose work item it was.
            msg('activity.mergeAuto', { item: merge.itemId ?? this.branchOf(merge), starter: requester })
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
    const available = this.forNewWork();
    if (!available.ok) throw this.refusal(available);
    return { git: available.git, repo: available.repo };
  }

  /**
   * Worktree mode for NEW work (a worktree, a Start's checkpoint): smurg's own history is not used while records of
   * the folder's own repository wait for its `.git` (they would be stranded: 0.5.2's gitDirGone, "put it back").
   */
  private forNewWork(): Available {
    const available = this.available;
    if (available.ok && available.repo.kind === 'smurg' && this.folderRecordsWait()) return notAvailable('git-dir-gone', msg('worktree.unavailable.gitDirGone'));
    return available;
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
    const reason = state.error.detail?.['reason'];
    if (reason !== 'not-a-git-repo' && reason !== 'unchecked') return state.error;
    // (0.6.0: only records of the folder's OWN repository count; smurg's own history keeps its records itself.)
    if (!this.folderRecordsWait()) return state.error;
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
