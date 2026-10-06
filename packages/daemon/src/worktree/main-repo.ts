// What the daemon does with a few named files of the MAIN workspace through git (ARCHITECTURE §5.10 "Start", §5.7):
//  - the checkpoint commit of a topic's SPEC.md and PLAN.md (exactly the paths it is given, never `--all`: the
//    hardened runner ignores the host's global ignore file, so `--all` would take whatever else lies in the folder);
//  - the blob ids of files at HEAD (the scheduler's pin check);
//  - the diff of such files as they are now against HEAD or against the blobs a Start pinned ("Show the changes").
// All of it with the hardened runner of git.ts: no hooks, no host config, attributes from the host's own HEAD.
//
// Nothing here follows a symbolic link: the working-tree side of a diff is read by the daemon itself (a plain file,
// O_NOFOLLOW, every directory on the way a plain directory) and hashed into a daemon-private object store, never into
// the host's repository; the checkpoint takes regular files only.
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError, checkRelPath, isHostOnlyPath, isSmurgDirName, relPathSegments } from '@smurg/protocol';
import { msg, type GitStep } from '@smurg/protocol/i18n';
import { plainFileKind, readPlainFileBelow } from './fs-ops.ts';
import { firstLine, requireOk, type GitIdentity, type GitObjectStore, type GitResult } from './git.ts';
import { splitNul } from './git-parse.ts';
import { mainHead, maskedDiffText, type MainRepo } from './review.ts';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Files in <gitDir> whose presence means another git operation is in progress in the main workspace. */
export const BUSY_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock'] as const;

/** The first busy marker present in the main repository, or null. */
export async function busyMarker(repo: MainRepo): Promise<string | null> {
  for (const marker of BUSY_MARKERS) {
    if ((await lstat(join(repo.gitDir, marker)).catch(() => null)) !== null) return marker;
  }
  return null;
}

/** The branch HEAD is on (`main`), or null when HEAD is detached or unreadable. */
export async function currentBranch(repo: MainRepo): Promise<string | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], readOnly: true, maxStdoutBytes: 4096 }).catch(() => null);
  if (result === null || result.code !== 0) return null;
  const branch = firstLine(result);
  return branch.length > 0 && branch.length <= 200 ? branch : null;
}

/** How many paths one call may name (a topic has two; the bound keeps a command line short). */
export const MAIN_PATHS_MAX = 16;

/**
 * The paths as the protocol spells them. Refused (a programming error of the caller, never a member's input): too
 * many, not a relative path, or inside what only the host touches (`.git`, `.claude`, `.smurg`, …).
 */
function checkedPaths(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > MAIN_PATHS_MAX) throw new SmurgError('bad_request', undefined, { reason: 'bad-paths' });
  const out: string[] = [];
  for (const input of paths) {
    const checked = checkRelPath(input);
    if (!checked.ok || isHostOnlyPath(checked.path) || relPathSegments(checked.path).some(isSmurgDirName)) throw new SmurgError('bad_request', undefined, { reason: 'bad-paths' });
    if (!out.includes(checked.path)) out.push(checked.path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Blobs at HEAD
// ---------------------------------------------------------------------------------------------------------------

/** `git ls-tree -z <commit> -- <paths>`: `<mode> <type> <oid>\t<path>\0`. Only regular blobs count. */
function parseLsTree(output: Uint8Array): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const field of splitNul(output)) {
    const tab = field.indexOf(9);
    if (tab === -1) continue;
    const header = /^(\d{6}) (\w+) ([0-9a-f]+)$/.exec(field.subarray(0, tab).toString('latin1'));
    if (!header || header[2] !== 'blob' || !OID.test(header[3] as string)) continue;
    if (header[1] !== '100644' && header[1] !== '100755') continue;
    blobs.set(field.subarray(tab + 1).toString('utf8'), header[3] as string);
  }
  return blobs;
}

/** Blob ids of `paths` in `commit` (null: no regular file there). */
export async function blobsAt(repo: MainRepo, commit: string, paths: readonly string[], timeoutMs: number): Promise<Record<string, string | null>> {
  const wanted = checkedPaths(paths);
  const listed = requireOk(await repo.git.run({ gitDir: repo.gitDir, args: ['ls-tree', '-z', commit, '--', ...wanted], readOnly: true, timeoutMs }), 'readCommit');
  const blobs = parseLsTree(listed.stdout);
  return Object.fromEntries(wanted.map((path) => [path, blobs.get(path) ?? null]));
}

// ---------------------------------------------------------------------------------------------------------------
// The checkpoint commit
// ---------------------------------------------------------------------------------------------------------------

/**
 * Why the checkpoint could not be made, in the Start dialog's own words (`plan.start.commit.*`); the topics module
 * reads `detail.reason`: `git-busy` (another git operation is in progress), `git-ignored` (with `path`), and for
 * everything else `git-failed` with the `step` that failed.
 */
function commitFailed(step: GitStep): SmurgError {
  return new SmurgError('conflict', msg('plan.start.commit.failed', { step }), { reason: 'git-failed', step });
}

/** Runs one step of the checkpoint; a failure of git becomes `plan.start.commit.failed` naming the step. */
async function step(run: Promise<GitResult>, name: GitStep): Promise<GitResult> {
  let result: GitResult;
  try {
    result = await run;
  } catch (err) {
    if (err instanceof SmurgError && err.detail?.['reason'] === 'stopping') throw err;
    throw commitFailed(name);
  }
  if (result.truncated || result.code !== 0) throw commitFailed(name);
  return result;
}

/** One line of a commit message: no line breaks, no NUL, bounded. */
function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000\r\n]+/g, ' ').trim().slice(0, max);
}

/** The message with its trailers as ONE last paragraph (git reads the trailer block from the end of the message). */
export function checkpointMessage(message: string, trailers: readonly string[]): string {
  const subject = message.replace(/\u0000/g, '').trim();
  const lines = trailers.map((trailer) => oneLine(trailer, 400)).filter((trailer) => trailer.length > 0).slice(0, 100);
  return lines.length === 0 ? `${subject}\n` : `${subject}\n\n${lines.join('\n')}\n`;
}

export interface CommitMainPathsInput {
  readonly repo: MainRepo;
  /** realpath of the shared folder. */
  readonly workTree: string;
  readonly paths: readonly string[];
  readonly message: string;
  readonly trailers: readonly string[];
  readonly identity: GitIdentity;
  readonly timeoutMs: number;
}

export interface CommitMainPathsResult {
  readonly commit: string;
  readonly created: boolean;
  readonly branch: string;
  readonly blobs: Record<string, string>;
}

/**
 * Commits exactly `paths` of the main working tree onto the host's current branch, as `identity`. Whatever else is
 * staged or lies in the folder stays as it is. Nothing to commit is fine (`created: false`). A path that is neither in
 * the working tree nor tracked is left out (it has no blob in the answer); one that was removed is committed as
 * removed. The caller serializes it with merges; every command that writes the host's repository runs to its end
 * (never stopped half-way).
 */
export async function commitMainPaths(input: CommitMainPathsInput): Promise<CommitMainPathsResult> {
  const { repo, workTree, timeoutMs } = input;
  const git = repo.git;
  const paths = checkedPaths(input.paths);
  const marker = await busyMarker(repo);
  if (marker !== null) throw new SmurgError('conflict', msg('plan.start.commit.busy'), { reason: 'git-busy', marker });
  const head = await mainHead(repo);
  if (head === null) throw new SmurgError('conflict', msg('merge.mainNoCommits'), { reason: 'no-commits' });
  const common = { gitDir: repo.gitDir, workTree, attrSource: head, timeoutMs } as const;

  // Only regular files, each reached through plain folders: a link or a folder under one of these names is not a
  // checkpoint of the file (git would commit the link itself, never what the member read in the dialog).
  const present: string[] = [];
  const absent: string[] = [];
  for (const path of paths) {
    const kind = await plainFileKind(workTree, path);
    if (kind === 'other') throw commitFailed('stage');
    (kind === 'file' ? present : absent).push(path);
  }
  // A file that is gone is named to git only when git knows it (its removal is then what is committed).
  let tracked = new Set<string>();
  if (absent.length > 0) {
    const listed = await git.run({ ...common, args: ['ls-files', '-z', '--cached', '--', ...absent], readOnly: true }).catch(() => null);
    if (listed === null || listed.code !== 0 || listed.truncated) throw commitFailed('checkMain');
    tracked = new Set(splitNul(listed.stdout).map((field) => field.toString('utf8')));
  }
  const targets = paths.filter((path) => present.includes(path) || tracked.has(path));
  const branch = async (): Promise<string> => (await currentBranch(repo)) ?? 'HEAD';
  if (targets.length === 0) return { commit: head, created: false, branch: await branch(), blobs: {} };

  // A path git ignores cannot be committed by name; say which one instead of failing in `git add`. (`ls-files`, not
  // `check-ignore`: the latter refuses the literal pathspecs every daemon git command runs with.)
  if (present.length > 0) {
    const ignored = await git.run({ ...common, args: ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...present], readOnly: true }).catch(() => null);
    if (ignored === null || ignored.code !== 0 || ignored.truncated) throw commitFailed('checkMain');
    const ignoredNames = new Set(splitNul(ignored.stdout).map((field) => field.toString('utf8')));
    const ignoredPath = present.find((path) => ignoredNames.has(path));
    if (ignoredPath !== undefined) throw new SmurgError('conflict', msg('plan.start.commit.ignored', { path: ignoredPath }), { reason: 'git-ignored', path: ignoredPath });
  }

  await step(git.run({ ...common, args: ['add', '--', ...targets], abortable: false }), 'stage');
  const staged = await git.run({ ...common, args: ['diff', '--cached', '--quiet', '--no-ext-diff', head, '--', ...targets], abortable: false }).catch(() => null);
  if (staged === null || (staged.code !== 0 && staged.code !== 1)) throw commitFailed('checkChanges');
  const created = staged.code === 1;
  if (created) {
    // `-- <paths>`: only these paths are committed, from the working tree; other staged changes stay staged.
    await step(
      git.run({
        ...common,
        identity: input.identity,
        input: checkpointMessage(input.message, input.trailers),
        args: ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-F', '-', '--', ...targets],
        abortable: false,
      }),
      'commit',
    );
  }
  const commit = await mainHead(repo).catch(() => null);
  if (commit === null) throw commitFailed('readCommit');
  let at: Record<string, string | null>;
  try {
    at = await blobsAt(repo, commit, paths, timeoutMs);
  } catch {
    throw commitFailed('readCommit');
  }
  const blobs: Record<string, string> = {};
  for (const path of paths) {
    const blob = at[path];
    if (blob !== null && blob !== undefined) blobs[path] = blob;
    // What the member confirmed is a file: after the commit HEAD must hold it as one.
    else if (present.includes(path)) throw commitFailed('readCommit');
  }
  return { commit, created, branch: await branch(), blobs };
}

// ---------------------------------------------------------------------------------------------------------------
// The diff of files of the main workspace ("Show the changes")
// ---------------------------------------------------------------------------------------------------------------

/** The working-tree side of a diff is read whole before it is hashed: beyond this a file is reported as cut. */
export const MAIN_DIFF_FILE_MAX_BYTES = 32 * 1024 * 1024;

export interface DiffMainPathsInput {
  readonly repo: MainRepo;
  /** realpath of the shared folder. */
  readonly workTree: string;
  /** Daemon-private directory for the object store of one call (state dir, 0700). */
  readonly stagingRoot: string;
  readonly paths: readonly string[];
  readonly against: 'head' | Readonly<Record<string, string | null>>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

/**
 * Unified diffs of `paths` as they are in the main working tree now, against HEAD or against the given blobs (null:
 * the file did not exist then). Only the paths that differ; each cut at `maxBytes` and through mask().
 *
 * Both sides become trees in a daemon-private object store (the old blob by its id, the file as it is now hashed from
 * bytes the daemon read itself) and `git diff <old tree> <new tree> -- <path>` makes each diff: ordinary headers with
 * the file's own name, for an added, changed or removed file alike, and never a path outside `paths`.
 */
export async function diffMainPaths(input: DiffMainPathsInput): Promise<{ path: string; diff: string; truncated: boolean }[]> {
  const { repo, timeoutMs } = input;
  const git = repo.git;
  const paths = checkedPaths(input.paths);
  const maxBytes = Math.max(1, Math.floor(input.maxBytes));

  const head = await mainHead(repo);
  let before: Record<string, string | null>;
  if (input.against === 'head') {
    before = head === null ? Object.fromEntries(paths.map((path) => [path, null])) : await blobsAt(repo, head, paths, timeoutMs);
  } else {
    before = {};
    for (const path of paths) {
      const blob = Object.hasOwn(input.against, path) ? input.against[path] : null;
      if (blob !== null && blob !== undefined && !OID.test(blob)) throw new SmurgError('bad_request', undefined, { reason: 'bad-blob' });
      before[path] = blob ?? null;
    }
  }

  const stage = await mkdtemp(join(input.stagingRoot, 'd-'));
  try {
    const objectDir = join(stage, 'objects');
    await mkdir(objectDir, { mode: 0o700 });
    const storeWith = (index: string): GitObjectStore => ({ objectDir, alternates: [join(repo.gitDir, 'objects')], indexFile: join(stage, index) });

    // The files as they are now, as blobs of the private store.
    const after: Record<string, string | null> = {};
    const tooLarge = new Set<string>();
    for (const path of paths) {
      const bytes = await readPlainFileBelow(input.workTree, path, MAIN_DIFF_FILE_MAX_BYTES);
      if (bytes === 'too-large') {
        tooLarge.add(path);
        after[path] = null;
        continue;
      }
      if (bytes === null) {
        after[path] = null;
        continue;
      }
      // `--path`: the bytes become the blob `git add` would store for this file (the host's line-ending settings,
      // attributes from the host's HEAD), so a file that was just committed hashes to the blob HEAD holds. Without a
      // commit there is no trusted source of attributes (the working tree's `.gitattributes` is a member's to
      // write): the bytes are hashed as they are.
      const hashed = requireOk(
        await git.run({
          gitDir: repo.gitDir,
          workTree: input.workTree,
          ...(head !== null ? { attrSource: head } : {}),
          store: storeWith('index-new'),
          input: bytes,
          args: ['hash-object', '-w', '-t', 'blob', '--stdin', ...(head !== null ? [`--path=${path}`] : ['--no-filters'])],
          timeoutMs,
        }),
        'stage',
      );
      const oid = firstLine(hashed);
      if (!OID.test(oid)) throw new SmurgError('internal', msg('git.outputUnparsable'), { reason: 'git-output-unparsable' });
      after[path] = oid;
    }

    const differing = paths.filter((path) => tooLarge.has(path) || before[path] !== after[path]);
    if (differing.length === 0) return [];

    const treeOf = async (index: string, blobs: Record<string, string | null>): Promise<string> => {
      const store = storeWith(index);
      const entries = differing.flatMap((path) => (blobs[path] === null || blobs[path] === undefined ? [] : ['--cacheinfo', `100644,${blobs[path] as string},${path}`]));
      if (entries.length > 0) requireOk(await git.run({ gitDir: repo.gitDir, store, args: ['update-index', '--add', ...entries], timeoutMs }), 'stage');
      const tree = firstLine(requireOk(await git.run({ gitDir: repo.gitDir, store, args: ['write-tree'], timeoutMs }), 'stage'));
      if (!OID.test(tree)) throw new SmurgError('internal', msg('git.outputUnparsable'), { reason: 'git-output-unparsable' });
      return tree;
    };
    const oldTree = await treeOf('index-old', before);
    const newTree = await treeOf('index-new', after);

    const out: { path: string; diff: string; truncated: boolean }[] = [];
    for (const path of differing) {
      if (tooLarge.has(path)) {
        out.push({ path, diff: '', truncated: true });
        continue;
      }
      const result = await git.run({
        gitDir: repo.gitDir,
        store: storeWith('index-new'),
        args: ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', oldTree, newTree, '--', path],
        readOnly: true,
        maxStdoutBytes: maxBytes + 1,
        timeoutMs,
      });
      if (!result.truncated) requireOk(result, 'diff');
      const cut = result.truncated || result.stdout.length > maxBytes;
      const text = maskedDiffText(result.stdout.subarray(0, Math.min(result.stdout.length, maxBytes)), maxBytes, cut);
      if (text.diff.length === 0 && !text.truncated) continue;
      out.push({ path, diff: text.diff, truncated: text.truncated });
    }
    return out;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
