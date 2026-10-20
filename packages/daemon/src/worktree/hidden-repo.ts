// smurg's own history of a shared folder that has no `.git` (DESIGN 0.6.0 D14; ARCHITECTURE §5.7): a git directory at
// `<share>/.smurg/git` whose work tree is the shared folder itself, never a `.git` in the user's folder. Topics then
// work as with a repository: each snapshot records the folder as it is, a worktree is a shared clone of the snapshot
// before it, and a merge lands in the folder. Every command on it runs with the hardened runner of git.ts.
//
//  - Created lazily and crash-safely (ensureHiddenRepo): made under a temporary name, recorded in worktrees.json, then
//    renamed into place. A `.smurg/git` without a record is never adopted: its config could make the DAEMON run code,
//    and nothing says what it holds. A record without `.smurg/git` starts anew only when no record of it remains open.
//  - Checked before every command (integrity.ts verifyHiddenRepo): its config and HEAD as smurg left them, nothing that
//    redirects it or rewrites its history (alternates, grafts, shallow, replace refs).
//  - What it holds (hiddenExcludeLines, written before every snapshot): not `.smurg`, not the dependency and cache
//    folders, not the host-private files (GENERATED from the protocol's lists, at any depth, and every listed file
//    PathGuard calls host-private under any spelling), not the shared directories, not a nested repository (a folder
//    that is a git repository of its own would be a gitlink, an empty folder in every checkout). The clones get the
//    same lines, so what an agent installs in its checkout is never committed.
//  - Bounded (listFolder): a folder of more than HIDDEN_MAX_FILES files or HIDDEN_MAX_BYTES is refused before anything is
//    written; a snapshot's commands get HIDDEN_SNAPSHOT_TIMEOUT_MS; the history is repacked when it holds many loose
//    objects (never pruned: clones read its objects).
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HOST_PERSONAL_FILES,
  HOST_PRIVATE_DIR_NAMES,
  HOST_PRIVATE_FILE_NAMES,
  SmurgError,
  checkRelPath,
  isHostPrivatePath,
  isSmurgDirName,
  relPathSegments,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { Logger } from '../core/logger.ts';
import { firstLine, requireOk, type GitIdentity, type GitRunner } from './git.ts';
import { splitNul } from './git-parse.ts';
import { hiddenRepoHashes, verifyHiddenRepo, type HiddenRepoHashes } from './integrity.ts';
import { excludePattern } from './names.ts';

/** `<share>/.smurg/<HIDDEN_DIR_NAME>`. */
export const HIDDEN_DIR_NAME = 'git';
/** Files a snapshot records at most (the listing's count). */
export const HIDDEN_MAX_FILES = 50_000;
/** Bytes a snapshot records at most (the sum of the listed files' sizes). */
export const HIDDEN_MAX_BYTES = 1024 * 1024 * 1024;
/** The deadline of each command of a snapshot (listing, add, commit, repack): longer than a first snapshot of a big folder. */
export const HIDDEN_SNAPSHOT_TIMEOUT_MS = 240_000;
/** stdout of the listing (the runner's 4 MiB default would cut 50,000 paths); a cut listing counts as too large. */
export const HIDDEN_LISTING_MAX_BYTES = 64 * 1024 * 1024;
/** Loose objects after which a snapshot repacks the history (`git repack -A -d`: unreachable objects stay loose). */
export const HIDDEN_LOOSE_OBJECTS_MAX = 10_000;

/** Folders and files no snapshot records: what a dependency manager or a tool makes, at any depth. */
export const HIDDEN_DEFAULT_EXCLUDES: readonly string[] = Object.freeze(['node_modules/', '.venv/', '__pycache__/', '.DS_Store']);

const NEW_DIR = /^git\.new-[0-9a-f]{16}$/;

export function hiddenGitDir(shareReal: string): string {
  return join(shareReal, '.smurg', HIDDEN_DIR_NAME);
}

/** A gitignore glob that matches exactly `name` (no wildcard of git's means anything in it). */
function literalGlob(name: string): string {
  return name.replace(/[*?[\]\\!#]/g, (char) => `\\${char}`).replace(/ $/, '\\ ');
}

/**
 * The host-private names as exclude lines, generated from the protocol's lists so they cannot drift from
 * isHostPrivatePath: a name without a slash as it is (it matches at any depth: `.envrc`, `CLAUDE.local.md`), a folder
 * with a trailing slash (`.git/`), a path with a slash in the unanchored form (`**\/.claude/settings.local.json`: an
 * exclude line with a slash in it is anchored to the top otherwise).
 */
export function hostPrivateExcludeLines(): string[] {
  const lines: string[] = [];
  for (const name of HOST_PRIVATE_FILE_NAMES) lines.push(literalGlob(name));
  for (const dir of HOST_PRIVATE_DIR_NAMES) lines.push(`${literalGlob(dir)}/`);
  for (const path of HOST_PERSONAL_FILES) lines.push(path.includes('/') ? `**/${path.split('/').map(literalGlob).join('/')}` : literalGlob(path));
  return lines;
}

export interface HiddenExcludeInput {
  /** The host settings' shared directories (linked read-only into every worktree, never recorded). */
  readonly sharedDirs: readonly string[];
  /** Folders that are git repositories of their own (never recorded). */
  readonly nestedRepos?: readonly string[];
  /** Files the listing found that PathGuard calls host-private under a spelling the generated lines do not match. */
  readonly hostPrivate?: readonly string[];
  /** For a clone's `.git/info/exclude`: without `/.smurg/` (meaningless there). */
  readonly forClone?: boolean;
}

/**
 * The exclude lines of smurg's own history (`<G>/info/exclude`, rewritten before every snapshot) and of each of its
 * clones (fs-ops.ts writeExclude): pure. The folder's own `.gitignore` files apply as in any repository.
 */
export function hiddenExcludeLines(input: HiddenExcludeInput): string[] {
  const lines: string[] = ['# smurg: what its own history of this folder never records (DESIGN 0.6.0 D14)'];
  if (input.forClone !== true) lines.push('/.smurg/');
  lines.push(...HIDDEN_DEFAULT_EXCLUDES, ...hostPrivateExcludeLines());
  const anchored = (path: string, dir: boolean): string | null => {
    const checked = checkRelPath(path);
    if (!checked.ok || checked.path.length === 0) return null;
    return `${excludePattern(checked.path)}${dir ? '/' : ''}`;
  };
  for (const dir of input.sharedDirs) {
    const line = anchored(dir, true);
    if (line !== null) lines.push(line);
  }
  for (const nested of input.nestedRepos ?? []) {
    const line = anchored(nested, true);
    if (line !== null) lines.push(line);
  }
  for (const file of input.hostPrivate ?? []) {
    const line = anchored(file, false);
    if (line !== null) lines.push(line);
  }
  return [...new Set(lines)];
}

/** Writes `<gitDir>/info/exclude` (never through a link: the folder and the file are checked, O_NOFOLLOW). */
export async function writeHiddenExclude(gitDir: string, lines: readonly string[]): Promise<void> {
  const info = join(gitDir, 'info');
  const st = await lstat(info).catch(() => null);
  if (st === null) await mkdir(info, { mode: 0o700 });
  else if (!st.isDirectory()) throw hiddenChanged('info-not-a-directory');
  const handle = await open(join(info, 'exclude'), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${lines.join('\n')}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

export function hiddenChanged(problem: string): SmurgError {
  return new SmurgError('conflict', msg('worktree.hidden.changed'), { reason: 'hidden-repo-changed', problem });
}

export function hiddenUnknown(): SmurgError {
  return new SmurgError('conflict', msg('worktree.hidden.unknown'), { reason: 'hidden-repo-unknown' });
}

export function hiddenGone(): SmurgError {
  return new SmurgError('conflict', msg('worktree.hidden.gone'), { reason: 'hidden-repo-gone' });
}

// ---------------------------------------------------------------------------------------------------------------
// Creation and what is found
// ---------------------------------------------------------------------------------------------------------------

/** What smurg's own history is on disk, from file calls only (no git). */
export type HiddenOnDisk = 'absent' | 'present';

/** `.smurg` as the real directory smurg made (no link on the way): otherwise nothing below it is used. */
async function smurgDirOf(shareReal: string): Promise<string> {
  const dir = join(shareReal, '.smurg');
  const st = await lstat(dir).catch(() => null);
  if (st === null) {
    await mkdir(dir, { mode: 0o700 }).catch(() => {});
  } else if (!st.isDirectory()) throw hiddenChanged('smurg-dir-not-a-directory');
  if ((await realpath(dir).catch(() => null)) !== dir) throw hiddenChanged('smurg-dir-moved');
  return dir;
}

/** Whether `<share>/.smurg/git` exists (anything at that name counts: it is checked when used). */
export async function hiddenOnDisk(shareReal: string): Promise<HiddenOnDisk> {
  return (await lstat(hiddenGitDir(shareReal)).catch(() => null)) === null ? 'absent' : 'present';
}

/**
 * What stops smurg from using its own history as it is found, without creating or changing anything (null: it can be
 * used, or made at the next thing that needs it):
 *  - `.smurg/git` and its record: checked (`worktree.hidden.changed` when it is not what smurg left);
 *  - `.smurg/git` and NO record (worktrees.json was set aside, another workspace of this folder made it, a copy): never
 *    adopted (`worktree.hidden.unknown`);
 *  - a record and no `.smurg/git` while worktrees or open merge requests of it remain: they can only be rejected
 *    (`worktree.hidden.gone`); with none, the next use starts anew.
 */
export async function hiddenProblem(shareReal: string, record: HiddenRepoHashes | undefined, openRecords: boolean): Promise<SmurgError | null> {
  const onDisk = await hiddenOnDisk(shareReal);
  if (onDisk === 'present') {
    if (record === undefined) return hiddenUnknown();
    try {
      await verifyHiddenRepo(hiddenGitDir(shareReal), record);
      return null;
    } catch (err) {
      if (err instanceof SmurgError) return err;
      throw err;
    }
  }
  return record !== undefined && openRecords ? hiddenGone() : null;
}

export interface EnsureHiddenInput {
  readonly git: GitRunner;
  readonly shareReal: string;
  /** An empty daemon-owned template directory (no sample hooks, no template config). */
  readonly template: string;
  /** worktrees.json `hidden` as it is now. */
  readonly record: (HiddenRepoHashes & { readonly createdAt: number }) | undefined;
  /** Worktrees or open merge requests made from smurg's own history remain. */
  readonly openRecords: boolean;
  /** Stores (and writes) the new record, or removes it (undefined). */
  readonly save: (record: (HiddenRepoHashes & { readonly createdAt: number }) | undefined) => Promise<void>;
  readonly now: () => number;
  readonly excludeLines: readonly string[];
  readonly log: Logger;
}

/**
 * smurg's own history, ready to use (DESIGN 0.6.0 D14 "Creation, crash-safe"). Runs on the worktree module's `main`
 * queue. When none is there (and none is owed to open records):
 *   1. leftovers `.smurg/git.new-*` of a crash are removed (never followed through a link);
 *   2. `.smurg/git.new-<16 hex>` (0700) is made, `git init` with the folder as work tree, `core.worktree` unset (the
 *      runner always names the work tree), the exclude file written;
 *   3. the record (when, the hashes of config and HEAD) is stored and written;
 *   4. the directory is renamed to `.smurg/git` (refused, and the record removed, when something is there by then);
 *   5. the log says so.
 * Throws `worktree.hidden.unknown` / `.gone` / `.changed` (see hiddenProblem).
 */
export async function ensureHiddenRepo(input: EnsureHiddenInput): Promise<{ readonly created: boolean }> {
  const { shareReal, git } = input;
  const smurgDir = await smurgDirOf(shareReal);
  const gitDir = hiddenGitDir(shareReal);
  // 1. a crash's leftovers (smurg's own names only; a link is removed as a link)
  for (const name of await readdir(smurgDir).catch(() => [] as string[])) {
    if (!NEW_DIR.test(name)) continue;
    const path = join(smurgDir, name);
    const st = await lstat(path).catch(() => null);
    if (st === null) continue;
    if (st.isDirectory()) await rm(path, { recursive: true, force: true }).catch(() => {});
    else await unlink(path).catch(() => {});
    input.log.info("a half-made history of smurg's was removed", { module: 'worktree', name });
  }
  const problem = await hiddenProblem(shareReal, input.record, input.openRecords);
  if (problem !== null) throw problem;
  if ((await hiddenOnDisk(shareReal)) === 'present') return { created: false };

  // 2. made under a name nobody uses
  const fresh = join(smurgDir, `git.new-${randomBytes(8).toString('hex')}`);
  await mkdir(fresh, { mode: 0o700 });
  try {
    requireOk(await git.run({ gitDir: fresh, workTree: shareReal, args: ['init', '--quiet', `--template=${input.template}`], timeoutMs: 60_000 }), 'createWorktree');
    // git wrote the work tree as an absolute `core.worktree`: every command names it anyway (exit 5: it was not set).
    const unset = await git.run({ gitDir: fresh, args: ['config', '--unset', 'core.worktree'], timeoutMs: 30_000 });
    if (unset.code !== 0 && unset.code !== 5) requireOk(unset, 'configureWorktree');
    await writeHiddenExclude(fresh, input.excludeLines);
    // 3. the record, before the name: a crash after it leaves a record and no `.smurg/git`, which starts anew
    const hashes = await hiddenRepoHashes(fresh);
    await input.save({ createdAt: input.now(), ...hashes });
  } catch (err) {
    await rm(fresh, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // 4. into place; something that appeared there meanwhile is not adopted
  if ((await lstat(gitDir).catch(() => null)) !== null) {
    await rm(fresh, { recursive: true, force: true }).catch(() => {});
    await input.save(undefined);
    throw hiddenUnknown();
  }
  try {
    await rename(fresh, gitDir);
  } catch (err) {
    await rm(fresh, { recursive: true, force: true }).catch(() => {});
    await input.save(undefined);
    if ((await lstat(gitDir).catch(() => null)) !== null) throw hiddenUnknown();
    throw err;
  }
  // 5.
  input.log.info("smurg's own history of the shared folder was created", { module: 'worktree' });
  return { created: true };
}

/** `<G>/index.lock` at the start of a command on the `main` queue is a crash's: only smurg runs git there, one command at a time. */
export async function removeStaleLock(gitDir: string, log: Logger): Promise<void> {
  const lock = join(gitDir, 'index.lock');
  const st = await lstat(lock).catch(() => null);
  if (st === null) return;
  if (st.isDirectory()) await rm(lock, { recursive: true, force: true }).catch(() => {});
  else await unlink(lock).catch(() => {});
  log.warn("a stale index.lock of smurg's own history was removed", { module: 'worktree' });
}

// ---------------------------------------------------------------------------------------------------------------
// The listing (the size bound, nested repositories, host-private files)
// ---------------------------------------------------------------------------------------------------------------

export interface FolderListing {
  /** Files listed (what a snapshot would record), and the bytes of those that were measured. */
  readonly files: number;
  readonly bytes: number;
  /** Over HIDDEN_MAX_FILES or HIDDEN_MAX_BYTES (or a listing that was cut): refused before anything is written. */
  readonly tooLarge: boolean;
  /** Folders that are git repositories of their own (untracked, or gitlinks of an earlier snapshot). */
  readonly nested: readonly string[];
  /** Listed files PathGuard calls host-private (excluded by name before the snapshot). */
  readonly hostPrivate: readonly string[];
  /** Entries of the history's index that must leave it (gitlinks, host-private files, anything below `.smurg`). */
  readonly untrack: readonly string[];
  /** The three largest top-level entries of what was measured. */
  readonly largest: readonly { readonly name: string; readonly bytes: number }[];
}

export interface HiddenRun {
  readonly git: GitRunner;
  readonly gitDir: string;
  readonly shareReal: string;
  readonly timeoutMs: number;
  readonly log: Logger;
  /** The size bound (default HIDDEN_MAX_FILES, HIDDEN_MAX_BYTES) and the repack rule (HIDDEN_LOOSE_OBJECTS_MAX). */
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly looseObjectsMax?: number;
}

const SLASH = 0x2f;
const DOT_GIT = Buffer.from('/.git', 'utf8');

/**
 * `git ls-files -z --cached --others --exclude-standard` of the folder in smurg's history, then the daemon's own `lstat`
 * of each path, bounded: every file is measured while the files are within their bound (so a folder refused for its
 * bytes is told its real size and largest entries), none after the first file beyond it. An untracked folder that is
 * a repository is listed with a trailing `/` (git does not look into it); a listed path that is a folder on disk is a
 * gitlink of an earlier snapshot; a listed path below a folder that holds a `.git` of its own (a tracked file of a
 * folder that became a repository, or that an earlier version of smurg recorded) belongs to that repository too.
 */
export async function listFolder(run: HiddenRun): Promise<FolderListing> {
  const maxFiles = run.maxFiles ?? HIDDEN_MAX_FILES;
  const maxBytes = run.maxBytes ?? HIDDEN_MAX_BYTES;
  const listed = await run.git.run({
    gitDir: run.gitDir,
    workTree: run.shareReal,
    args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    readOnly: true,
    maxStdoutBytes: HIDDEN_LISTING_MAX_BYTES,
    timeoutMs: run.timeoutMs,
  });
  if (!listed.truncated) requireOk(listed, 'listChanges');
  const fields = splitNul(listed.stdout);
  // A cut listing ends in a partial path: it is not measured.
  if (listed.truncated) fields.pop();
  const nested = new Set<string>();
  const hostPrivate: string[] = [];
  const untrack = new Set<string>();
  const top = new Map<string, number>();
  let files = 0;
  let bytes = 0;
  let measuring = true;
  const share = Buffer.from(`${run.shareReal}/`, 'utf8');
  const seen = new Set<string>();
  /** Folders of the listing (by their bytes) and whether each holds a `.git` of its own. */
  const holdsGit = new Map<string, boolean>();
  /** The highest folder above `raw` that is a repository of its own (null: none). */
  const repositoryAbove = async (raw: Buffer): Promise<string | null> => {
    for (let at = raw.indexOf(SLASH); at > 0 && at < raw.length - 1; at = raw.indexOf(SLASH, at + 1)) {
      const dir = raw.subarray(0, at);
      const key = dir.toString('latin1');
      let found = holdsGit.get(key);
      if (found === undefined) {
        found = (await lstat(Buffer.concat([share, dir, DOT_GIT])).catch(() => null)) !== null;
        holdsGit.set(key, found);
      }
      if (found) return dir.toString('utf8');
    }
    return null;
  };
  for (const raw of fields) {
    const path = raw.toString('utf8');
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    const segments = relPathSegments(path.endsWith('/') ? path.slice(0, -1) : path);
    if (segments.length === 0) continue;
    // Never smurg's own folder (a `.gitignore` of the folder can un-ignore it over the exclude file).
    if (isSmurgDirName(segments[0] as string)) {
      untrack.add('.smurg');
      continue;
    }
    if (raw[raw.length - 1] === SLASH) {
      nested.add(segments.join('/'));
      continue;
    }
    // Inside a repository of its own: it leaves the history with that folder, which is named (DESIGN 0.6.0 D14). (Not
    // looked at once the listing is beyond its bound: that refusal names no nested repository.)
    const above = measuring && segments.length > 1 ? await repositoryAbove(raw) : null;
    if (above !== null) {
      nested.add(above);
      untrack.add(above);
      continue;
    }
    if (isHostPrivatePath(path)) {
      hostPrivate.push(path);
      untrack.add(path);
      continue;
    }
    files += 1;
    if (!measuring) continue;
    const st = await lstat(Buffer.concat([share, raw])).catch(() => null);
    if (st === null) continue; // removed since: the snapshot records it as removed
    if (st.isDirectory()) {
      // a path of the index that is a folder now: a repository of its own that an earlier snapshot recorded
      files -= 1;
      nested.add(segments.join('/'));
      untrack.add(segments.join('/'));
      continue;
    }
    const size = st.isFile() ? st.size : 0;
    bytes += size;
    const name = segments[0] as string;
    top.set(name, (top.get(name) ?? 0) + size);
    // Past the files' bound the listing is refused whatever else is measured; within it every file counts, so the
    // refusal of a folder that is too large in bytes says its whole size and its real largest entries.
    if (files > maxFiles) measuring = false;
  }
  for (const repo of nested) untrack.add(repo);
  const largest = [...top.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, size]) => ({ name, bytes: size }));
  return {
    files,
    bytes,
    tooLarge: listed.truncated || files > maxFiles || bytes > maxBytes,
    nested: [...nested].sort(),
    hostPrivate,
    untrack: [...untrack],
    largest,
  };
}

/** 1536 → "1.5 KB" (binary units, as the bound's "1 GB" is meant). */
export function sizeText(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} bytes`;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export function tooLargeError(listing: FolderListing, bound: Pick<HiddenRun, 'maxFiles' | 'maxBytes'> = {}): SmurgError {
  const largest = listing.largest.map((entry) => `${entry.name} (${sizeText(entry.bytes)})`).join(', ');
  return new SmurgError(
    'conflict',
    msg('worktree.hidden.tooLarge', {
      size: sizeText(listing.bytes),
      files: listing.files.toLocaleString('en-US'),
      // (the defaults read "1 GB" and "50,000")
      maxSize: sizeText(bound.maxBytes ?? HIDDEN_MAX_BYTES),
      maxFiles: (bound.maxFiles ?? HIDDEN_MAX_FILES).toLocaleString('en-US'),
      largest: largest.length > 0 ? largest : '-',
    }),
    { reason: 'hidden-too-large', files: listing.files, bytes: listing.bytes },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------------------------

export interface SnapshotInput {
  /** Exclude lines without what this listing finds (sharedDirs: hiddenExcludeLines). */
  readonly sharedDirs: readonly string[];
  /** Fixed English (one shared history); trailers included. */
  readonly message: string;
  readonly identity: GitIdentity;
  /** false: the warm-up (the bound and `git add -A`, no commit). */
  readonly commit: boolean;
}

export interface SnapshotOutcome {
  /** HEAD after the snapshot (null: the warm-up of a history without a commit). */
  readonly head: string | null;
  /** A commit was made (false: nothing changed since the last snapshot, or the warm-up). */
  readonly created: boolean;
  readonly listing: FolderListing;
}

const GROUP_MAX = 200;

/**
 * Records the shared folder as it is now (DESIGN 0.6.0 D14 "Snapshots"). The caller verified the history and runs this
 * on the `main` queue: exclude file, the bound (nothing is written when it refuses), what must leave the index, `git
 * add -A`, nothing below `.smurg` in the index, then `git commit` as `identity` when something changed (or when there is
 * no commit yet), then the repack rule.
 */
export async function snapshotFolder(run: HiddenRun, input: SnapshotInput): Promise<SnapshotOutcome> {
  const { git, gitDir, shareReal, timeoutMs } = run;
  const common = { gitDir, workTree: shareReal, timeoutMs } as const;
  await writeHiddenExclude(gitDir, hiddenExcludeLines({ sharedDirs: input.sharedDirs }));
  const listing = await listFolder(run);
  if (listing.tooLarge) throw tooLargeError(listing, run);
  await writeHiddenExclude(gitDir, hiddenExcludeLines({ sharedDirs: input.sharedDirs, nestedRepos: listing.nested, hostPrivate: listing.hostPrivate }));
  await untrack(run, listing.untrack);
  const added = await git.run({ ...common, args: ['add', '-A'], abortable: false });
  // What git says about a file it could not add (one the host cannot read, say) names it: the host finds it in the
  // daemon's log (the refusal itself only says which step failed).
  if (added.code !== 0 && !added.truncated) run.log.warn("a snapshot of the shared folder into smurg's own history failed", { module: 'worktree', git: added.stderr.split('\n', 1)[0]?.slice(0, 300) ?? '' });
  requireOk(added, 'stage');
  // A folder's `.gitignore` can un-ignore a host-private file over the exclude file (`!.envrc`), and `add -A` takes it
  // again: whatever of it is in the index now goes out again (it would be in every checkout, and kept for ever).
  const cached = requireOk(await git.run({ ...common, args: ['ls-files', '-z', '--cached'], readOnly: true, maxStdoutBytes: HIDDEN_LISTING_MAX_BYTES }), 'listChanges');
  const hostPrivate = splitNul(cached.stdout)
    .map((entry) => entry.toString('utf8'))
    .filter((entry) => entry.length > 0 && isHostPrivatePath(entry));
  if (hostPrivate.length > 0) {
    run.log.warn("a .gitignore of the shared folder lets a host-private file in: it was kept out of smurg's history", { module: 'worktree', count: hostPrivate.length });
    await untrack(run, hostPrivate);
  }
  // A folder's `.gitignore` can un-ignore `.smurg` over the exclude file: whatever of it got in goes out again.
  const ours = await git.run({ ...common, args: ['ls-files', '-z', '--cached', '--', '.smurg'], readOnly: true, maxStdoutBytes: 1024 * 1024 });
  if (ours.truncated || (ours.code === 0 && ours.stdout.length > 0)) {
    run.log.warn("a .gitignore of the shared folder lets .smurg in: it was kept out of smurg's history", { module: 'worktree' });
    requireOk(await git.run({ ...common, args: ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.smurg'], abortable: false }), 'stage');
  }
  const headBefore = await headOf(run);
  if (!input.commit) return { head: headBefore, created: false, listing };
  if (headBefore !== null) {
    const staged = await git.run({ ...common, args: ['diff', '--cached', '--quiet', '--no-ext-diff', headBefore], abortable: false });
    if (staged.code === 0) return { head: headBefore, created: false, listing };
    if (staged.code !== 1) requireOk(staged, 'checkChanges');
  }
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  requireOk(
    await git.run({ ...common, identity: input.identity, input: message, args: ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--allow-empty', '-F', '-'], abortable: false }),
    'commit',
  );
  const head = await headOf(run);
  if (head === null) throw new SmurgError('internal', msg('git.stepFailed', { step: 'readCommit' }), { reason: 'git-failed', step: 'readCommit' });
  await repackWhenLoose(run);
  return { head, created: true, listing };
}

/** HEAD of smurg's history (null: no commit yet). */
export async function headOf(run: Pick<HiddenRun, 'git' | 'gitDir'>): Promise<string | null> {
  const result = await run.git.run({ gitDir: run.gitDir, args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code !== 0) return null;
  const head = firstLine(result);
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? head : null;
}

async function untrack(run: HiddenRun, paths: readonly string[]): Promise<void> {
  for (let at = 0; at < paths.length; at += GROUP_MAX) {
    const group = paths.slice(at, at + GROUP_MAX);
    requireOk(await run.git.run({ gitDir: run.gitDir, workTree: run.shareReal, args: ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...group], timeoutMs: run.timeoutMs, abortable: false }), 'stage');
  }
}

/** `git count-objects -v` says more than HIDDEN_LOOSE_OBJECTS_MAX loose objects: `git repack -A -d -q` (never prune, never gc). */
export async function repackWhenLoose(run: HiddenRun, max = run.looseObjectsMax ?? HIDDEN_LOOSE_OBJECTS_MAX): Promise<boolean> {
  const counted = await run.git.run({ gitDir: run.gitDir, args: ['count-objects', '-v'], readOnly: true, maxStdoutBytes: 64 * 1024, timeoutMs: run.timeoutMs });
  if (counted.code !== 0) return false;
  const loose = /^count:\s*(\d+)$/m.exec(counted.stdout.toString('utf8'));
  if (loose === null || Number(loose[1]) <= max) return false;
  requireOk(await run.git.run({ gitDir: run.gitDir, args: ['repack', '-A', '-d', '-q'], timeoutMs: run.timeoutMs, abortable: false }), 'stage');
  run.log.info("smurg's own history was repacked", { module: 'worktree', loose: Number(loose[1]) });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Cloud-synced folders
// ---------------------------------------------------------------------------------------------------------------

/** Folders below the home that a cloud service syncs (iCloud Drive, the File Provider services, Dropbox). */
export const CLOUD_SYNCED_DIRS: readonly string[] = Object.freeze(['Library/Mobile Documents', 'Library/CloudStorage', 'Dropbox']);

/** Whether the shared folder (its realpath) lies in a folder a cloud service syncs (`StartPreflight.cloudSynced`). */
export function isCloudSynced(shareReal: string, home: string | null): boolean {
  if (home === null || home.length === 0) return false;
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  return CLOUD_SYNCED_DIRS.some((dir) => {
    const prefix = `${base}/${dir}`;
    return shareReal === prefix || shareReal.startsWith(`${prefix}/`);
  });
}
