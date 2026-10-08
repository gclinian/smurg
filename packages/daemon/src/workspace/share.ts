// Preparing the shared folder (ARCHITECTURE §7.1): inside it the daemon creates only `.smurg/`, with a `.gitignore`
// of its own that ignores everything in it, and adds `.smurg/` to `.git/info/exclude` (never the user's .gitignore).
// It also refuses share locations that would expose the daemon's own secrets or the whole home directory to guests:
// ~/.smurg must stay outside the shared folder (§2 rule 3).
//
// `.smurg/.gitignore` (0.5.2): the folder ignores itself, whatever order the host types `git init`, `git add -A` and
// `git commit` in while sharing, and whatever a root .gitignore says (`!.smurg/` beats info/exclude, not a nested
// .gitignore). Written at every start when it is missing (ignoreSmurgDir, once the state folder was accepted: a
// refused start leaves the shared folder as it was): created, never through a link, never over a file the host made.
// The exclude line is still written, at the start and when a repository appears while sharing (the worktree module,
// observeGit), for gits and tools that read only that.
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { errnoCode, isInside, lstatOrNull } from './fs-util.ts';

/** Why a folder cannot be shared (ShareError.reason). Codes: the CLI words them in the host's language. */
export const SHARE_ERROR_REASONS = [
  'not-found',
  'not-a-directory',
  'filesystem-root',
  'home-directory',
  'contains-home',
  'contains-homes',
  'state-dir-inside-share',
  'share-inside-state-dir',
  'smurg-not-a-directory',
] as const;
export type ShareErrorReason = (typeof SHARE_ERROR_REASONS)[number];

/** English, for the daemon's log; whoever shows it to a person switches on `reason`. */
const SHARE_ERROR_MESSAGES: Readonly<Record<ShareErrorReason, string>> = {
  'not-found': 'the shared folder does not exist',
  'not-a-directory': 'the shared folder is not a directory',
  'filesystem-root': 'the file system root cannot be shared',
  'home-directory': 'the whole home directory cannot be shared',
  'contains-home': 'a folder that contains the home directory cannot be shared',
  'contains-homes': 'a folder that contains the home directories cannot be shared',
  'state-dir-inside-share': 'the daemon state directory must not be inside the shared folder',
  'share-inside-state-dir': 'the shared folder must not be inside the daemon state directory',
  'smurg-not-a-directory': '.smurg in the shared folder is not a directory',
};

export class ShareError extends Error {
  readonly reason: ShareErrorReason;

  constructor(reason: ShareErrorReason) {
    super(SHARE_ERROR_MESSAGES[reason]);
    this.name = 'ShareError';
    this.reason = reason;
  }
}

/** Where the accounts' home directories live (macOS, Linux). */
export const HOMES_PARENTS: readonly string[] = Object.freeze(['/Users', '/home', '/root', '/var/root']);

export interface PreparedShare {
  readonly realPath: string;
  readonly name: string;
  readonly isGitRepo: boolean;
}

/** `written`: created now; `ours`: smurg's from an earlier start; `other`: something the host made, left alone; `failed`: could not be created. */
export type SmurgIgnoreOutcome = 'written' | 'ours' | 'other' | 'failed';

/**
 * Validates the share location against the state dir and the home directory, creates `<share>/.smurg` (0700) and
 * the git exclude entry. `homeDir` is injectable so tests never depend on the real home.
 */
export async function prepareShare(
  shareDir: string,
  stateDir: string,
  options: { readonly homeDir?: string; /** TEST ONLY: default HOMES_PARENTS. */ readonly homesParents?: readonly string[] } = {},
): Promise<PreparedShare> {
  const share = await realpath(shareDir).catch(() => {
    throw new ShareError('not-found');
  });
  if (!(await lstat(share)).isDirectory()) throw new ShareError('not-a-directory');
  if (share === '/') throw new ShareError('filesystem-root');
  const home = await realpath(options.homeDir ?? homedir()).catch(() => null);
  if (home !== null && share === home) throw new ShareError('home-directory');
  // A folder that CONTAINS the home (/Users, the parent of a fake home) would hand every guest ~/.ssh,
  // ~/.aws, ~/.claude …; PathGuard allows everything inside the share. Refused whatever SMURG_HOME is.
  if (home !== null && isInside(home, share)) throw new ShareError('contains-home');
  // Nor the parent of everybody's homes (other accounts on this machine), even when the host's own home is elsewhere.
  for (const homes of options.homesParents ?? HOMES_PARENTS) {
    const real = await realpath(homes).catch(() => null);
    if (real !== null && isInside(real, share)) throw new ShareError('contains-homes');
  }
  const state = await realpath(stateDir).catch(() => stateDir);
  if (isInside(state, share)) throw new ShareError('state-dir-inside-share');
  if (isInside(share, state)) throw new ShareError('share-inside-state-dir');

  const smurgDir = join(share, '.smurg');
  const existing = await lstatOrNull(smurgDir);
  if (existing === null) await mkdir(smurgDir, { mode: 0o700 });
  else if (existing === 'not-directory' || !existing.isDirectory()) throw new ShareError('smurg-not-a-directory');

  const git = await gitKind(join(share, '.git'));
  if (git === 'dir') await excludeSmurgDir(join(share, '.git'));
  return { realPath: share, name: basename(share) || share, isGitRepo: git !== 'none' };
}

/** The name and the content of the `.gitignore` smurg writes into `<share>/.smurg`. */
export const SMURG_GITIGNORE_NAME = '.gitignore';
export const SMURG_GITIGNORE_TEXT = "# Written by smurg: git ignores smurg's own folder (the share lock, trash, uploads, worktrees).\n*\n";

/**
 * Creates `<share>/.smurg/.gitignore` holding `*` when nothing is there (O_CREAT | O_EXCL | O_NOFOLLOW: never through
 * a link, never over an entry that exists). An entry that is there is left as it is; read only to say whether it is
 * ours. Never throws. `.smurg` itself was checked by prepareShare (a real directory).
 */
export async function ignoreSmurgDir(shareRealPath: string): Promise<SmurgIgnoreOutcome> {
  const path = join(shareRealPath, '.smurg', SMURG_GITIGNORE_NAME);
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
  } catch (err) {
    if (errnoCode(err) !== 'EEXIST') return 'failed';
    return (await readSmall(path)) === SMURG_GITIGNORE_TEXT ? 'ours' : 'other';
  }
  try {
    await handle.writeFile(SMURG_GITIGNORE_TEXT, 'utf8');
    return 'written';
  } catch {
    return 'failed';
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A small regular file's text, never through a link; null for anything else. */
async function readSmall(path: string): Promise<string | null> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
  if (handle === null) return null;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > 4096) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * What `<share>/.git` is right now, from file calls only (no git process): what the worktree module compares to
 * notice that the folder became a repository while it is shared, or stopped being one (0.5.2).
 *  - `kind`: gitKind (a git directory, a gitfile, or neither);
 *  - `exists`: something is at `.git` at all; `plain`: it is a real directory, not reached through a link (what
 *    worktree mode needs);
 *  - `dev` / `ino`: which entry it is (0 when there is none): a `.git` replaced by another one is a change.
 */
export interface GitObservation {
  readonly kind: 'dir' | 'file' | 'none';
  readonly exists: boolean;
  readonly plain: boolean;
  readonly dev: number;
  readonly ino: number;
}

export async function observeGit(shareRealPath: string): Promise<GitObservation> {
  const gitPath = join(shareRealPath, '.git');
  const st = await lstatOrNull(gitPath);
  if (st === null || st === 'not-directory') return { kind: 'none', exists: false, plain: false, dev: 0, ino: 0 };
  const kind = await gitKind(gitPath);
  const plain = st.isDirectory() && (await realpath(gitPath).catch(() => null)) === gitPath;
  return { kind, exists: true, plain, dev: st.dev, ino: st.ino };
}

export function sameGitObservation(a: GitObservation, b: GitObservation): boolean {
  return a.kind === b.kind && a.exists === b.exists && a.plain === b.plain && a.dev === b.dev && a.ino === b.ino;
}

/**
 * What `<share>/.git` is: a git directory (it has a HEAD file, or a HEAD symlink into refs/), a gitfile (`gitdir: …`, a linked worktree or a
 * submodule) or neither. Merely existing is not enough (git's own rule): an empty `.git` directory or
 * file is no repository, and taking it for one would offer worktree mode on a folder git does not know.
 */
export async function gitKind(gitPath: string): Promise<'dir' | 'file' | 'none'> {
  const st = await lstatOrNull(gitPath);
  if (st === null || st === 'not-directory') return 'none';
  if (st.isDirectory()) {
    // git's own rule (validate_headref): HEAD is a regular file, or a symlink into refs/ (core.preferSymlinkRefs, older
    // repositories; it dangles while the branch is unborn or after `git gc` packed the ref).
    const headPath = join(gitPath, 'HEAD');
    const head = await lstatOrNull(headPath);
    if (head === null || head === 'not-directory') return 'none';
    if (head.isFile()) return 'dir';
    if (!head.isSymbolicLink()) return 'none';
    const target = await readlink(headPath).catch(() => null);
    return target !== null && target.startsWith('refs/') ? 'dir' : 'none';
  }
  if (!st.isFile() || st.size === 0) return 'none';
  const handle = await open(gitPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return 'none';
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').startsWith('gitdir:') ? 'file' : 'none';
  } finally {
    await handle.close();
  }
}

const EXCLUDE_LINE = '/.smurg/';

/** Appends `/.smurg/` to .git/info/exclude unless an equivalent line is there. Never follows a symlink. */
export async function excludeSmurgDir(gitDir: string): Promise<void> {
  const infoDir = join(gitDir, 'info');
  const info = await lstatOrNull(infoDir);
  if (info === null) await mkdir(infoDir, { mode: 0o755 });
  else if (info === 'not-directory' || !info.isDirectory()) return;
  const excludePath = join(infoDir, 'exclude');
  const st = await lstatOrNull(excludePath);
  if (st !== null && (st === 'not-directory' || !st.isFile())) return;
  if (st !== null) {
    const text = await readFile(excludePath, 'utf8');
    if (text.split(/\r?\n/).some((line) => ['.smurg', '.smurg/', '/.smurg', '/.smurg/'].includes(line.trim()))) return;
  }
  const handle = await open(excludePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o644);
  try {
    const prefix = st !== null && st.size > 0 ? '\n' : '';
    await handle.appendFile(`${prefix}# smurg: daemon-owned directory (worktrees, staging)\n${EXCLUDE_LINE}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}
