// File-system steps of the worktree module that are not git: the worktrees directory, the read-only shared links
// (D12), the clone's exclude file and removing a worktree. Everything is lstat-based and never follows a symlink it
// did not make: a worktree's content is guest-controlled (a tracked `assets` could be a symlink out of the share).
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { checkRelPath, isHostOnlyPath, isSmurgDirName, relPathSegments } from '@smurg/protocol';
import { excludePattern } from './names.ts';

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** `<share>/.smurg/worktrees` as a real (non-symlink) private directory; returns false when it cannot be one. */
export async function ensureWorktreesDir(shareReal: string, worktreesDir: string): Promise<boolean> {
  const smurg = join(shareReal, '.smurg');
  const smurgStat = await lstatOrNull(smurg);
  if (smurgStat === null) await mkdir(smurg, { mode: 0o700 }).catch(() => {});
  else if (!smurgStat.isDirectory()) return false;
  const st = await lstatOrNull(worktreesDir);
  if (st === null) await mkdir(worktreesDir, { mode: 0o700 }).catch((err: unknown) => {
    if (errnoCode(err) !== 'EEXIST') throw err;
  });
  else if (!st.isDirectory()) return false;
  return (await realpath(worktreesDir).catch(() => null)) === worktreesDir;
}

export interface SharedLinkPlan {
  /** Link location in the worktree (the same relative path as in the main root). */
  readonly path: string;
  readonly mainPath: string;
}

export interface LinkSharedDirsResult {
  readonly links: SharedLinkPlan[];
  /** Shared dirs that were not linked, with why (logged; never fatal). */
  readonly skipped: { readonly path: string; readonly reason: string }[];
}

/**
 * Links every shared directory of the main root into the fresh worktree at the same relative path, as an absolute
 * symlink to its realpath. A path that is tracked in the checkout (it exists), whose parent is not a plain directory,
 * or that names a host-only / daemon directory is skipped: linking it would replace project content or hand a guest
 * what §5.2 protects. RootRegistry.registerWorktree validates the result again before PathGuard trusts it.
 */
export async function linkSharedDirs(worktreeDir: string, shareReal: string, sharedDirs: readonly string[]): Promise<LinkSharedDirsResult> {
  const links: SharedLinkPlan[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const input of sharedDirs) {
    const checked = checkRelPath(input);
    if (!checked.ok) {
      skipped.push({ path: String(input), reason: 'invalid' });
      continue;
    }
    const path = checked.path;
    const segments = relPathSegments(path);
    if (isHostOnlyPath(path) || segments.some(isSmurgDirName)) {
      skipped.push({ path, reason: 'host-only' });
      continue;
    }
    const folded = path.toLowerCase();
    if (seen.has(folded)) continue;
    const target = await realpath(join(shareReal, ...segments)).catch(() => null);
    const targetStat = target === null ? null : await lstatOrNull(target);
    if (target === null || targetStat === null || !targetStat.isDirectory() || !isInside(target, shareReal) || isInside(target, join(shareReal, '.smurg'))) {
      skipped.push({ path, reason: 'not-a-shared-directory' });
      continue;
    }
    // Parents: plain directories only (create the missing ones; never descend through a link).
    let parent = worktreeDir;
    let ok = true;
    for (const segment of segments.slice(0, -1)) {
      const next = join(parent, segment);
      const st = await lstatOrNull(next);
      if (st === null) {
        await mkdir(next, { mode: 0o755 });
      } else if (!st.isDirectory()) {
        ok = false;
        break;
      }
      parent = next;
    }
    if (!ok) {
      skipped.push({ path, reason: 'parent-not-directory' });
      continue;
    }
    const linkPath = join(parent, segments.at(-1) as string);
    if ((await lstatOrNull(linkPath)) !== null) {
      skipped.push({ path, reason: 'exists-in-checkout' });
      continue;
    }
    await symlink(target, linkPath);
    seen.add(folded);
    links.push({ path, mainPath: path });
  }
  return { links, skipped };
}

/** Writes the clone's `.git/info/exclude` (a fresh clone from an empty template has none): the shared links. */
export async function writeExclude(gitDir: string, links: readonly SharedLinkPlan[]): Promise<void> {
  const info = join(gitDir, 'info');
  const st = await lstatOrNull(info);
  if (st === null) await mkdir(info, { mode: 0o755 });
  else if (!st.isDirectory()) throw new Error('.git/info is not a directory');
  const lines = ['# smurg: read-only links to the shared directories (D12), never committed', ...links.map((link) => excludePattern(link.path))];
  const handle = await open(join(info, 'exclude'), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(`${lines.join('\n')}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Makes every real directory below `dir` writable for its owner again (a guest may have chmod'ed some 0555). */
async function restoreWritable(dir: string, depth = 0): Promise<void> {
  if (depth > 64) return;
  await chmod(dir, 0o700).catch(() => {});
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const child = join(dir, name);
    const st = await lstatOrNull(child).catch(() => null);
    if (st?.isDirectory()) await restoreWritable(child, depth + 1);
  }
}

/**
 * Where a merge would ADD an entry that the main working tree already has but git does not track: an untracked or
 * IGNORED file (`git merge` overwrites ignored files without a word: a host's `.env`, a local dataset), or a
 * non-directory (file, symlink) where the merge needs a directory. `changes` is the merge's `--name-status` against
 * the host's HEAD in protocol spelling; entries the merge deletes or retypes are tracked ones git handles itself.
 * Checked top-down with lstat, never through a link. On a case-insensitive file system a different spelling of an
 * existing name counts as in the way (git could not check both out).
 */
export async function untrackedInTheWay(shareReal: string, changes: readonly { readonly letter: string; readonly path: string }[]): Promise<string[]> {
  // Tracked entries the merge removes or retypes, and every directory holding one: git replaces those itself (a file
  // that becomes a directory, a directory that becomes a link). Untracked leftovers inside such a directory are what
  // `git status` reports, and ignored ones make `git merge --no-overwrite-ignore` refuse.
  const replacedByMerge = new Set<string>();
  for (const change of changes) {
    if (change.letter !== 'D' && change.letter !== 'T') continue;
    const segments = relPathSegments(change.path);
    for (let depth = 1; depth <= segments.length; depth++) replacedByMerge.add(segments.slice(0, depth).join('/'));
  }
  const found = new Set<string>();
  // prefix → can hold the new entries (missing, a real directory, or a tracked entry the merge replaces)
  const prefixOk = new Map<string, boolean>();
  for (const change of changes) {
    if (change.letter !== 'A') continue;
    const segments = relPathSegments(change.path);
    let blocked = false;
    for (let depth = 1; depth < segments.length && !blocked; depth++) {
      const prefix = segments.slice(0, depth).join('/');
      let ok = prefixOk.get(prefix);
      if (ok === undefined) {
        const st = await lstatOrNull(join(shareReal, ...segments.slice(0, depth)));
        ok = st === null || st.isDirectory() || replacedByMerge.has(prefix);
        if (!ok) found.add(prefix);
        prefixOk.set(prefix, ok);
      }
      blocked = !ok;
    }
    if (blocked || replacedByMerge.has(change.path)) continue;
    if ((await lstatOrNull(join(shareReal, ...segments))) !== null) found.add(change.path);
  }
  return [...found];
}

/** `<id>.removing-<hex>`: a worktree on its way out (see removeWorktreeDir). */
const REMOVING = /^wt_[0-9a-f]{24}\.removing-[0-9a-f]{16}$/;

async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (err) {
    if (errnoCode(err) !== 'EACCES' && errnoCode(err) !== 'EPERM' && errnoCode(err) !== 'ENOTEMPTY') throw err;
    await restoreWritable(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
  }
}

/**
 * Removes `<worktreesDir>/<id>`. If the entry is not the real directory the daemon made (a symlink put in its
 * place), only the entry itself goes: nothing is ever removed through a link.
 *
 * The tree is first renamed to `<id>.removing-<hex>`, a name no session works in, and only then deleted. fs.rm walks
 * by path: a process that outlived its session (ARCHITECTURE §11 D-3) could otherwise swap a directory for a symlink
 * in the middle of the recursive delete and have the daemon delete through it.
 */
export async function removeWorktreeDir(worktreesDir: string, worktreeId: string): Promise<void> {
  const dir = join(worktreesDir, worktreeId);
  const st = await lstatOrNull(dir);
  if (st === null) return;
  if (!st.isDirectory() || (await realpath(dir).catch(() => null)) !== dir) {
    await unlink(dir).catch(() => {});
    return;
  }
  const doomed = join(worktreesDir, `${worktreeId}.removing-${randomBytes(8).toString('hex')}`);
  await rename(dir, doomed);
  const moved = await lstatOrNull(doomed);
  if (moved === null) return;
  // Swapped between the check and the rename: what moved is not the directory that was checked.
  if (!moved.isDirectory() || moved.dev !== st.dev || moved.ino !== st.ino) {
    await unlink(doomed).catch(() => {});
    return;
  }
  await removeTree(doomed);
}

/** Finishes removals a stopped daemon left half-done (`<id>.removing-<hex>`); returns how many were removed. */
export async function sweepRemovals(worktreesDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(worktreesDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!REMOVING.test(name)) continue;
    const path = join(worktreesDir, name);
    const st = await lstatOrNull(path);
    if (st === null) continue;
    if (st.isDirectory()) await removeTree(path);
    else await unlink(path).catch(() => {});
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------
// Single files below a root the daemon does not control the content of (a worktree, the shared folder). Path-based
// checks that bracket the operation, like stage-commit.ts: never through a symbolic link.
// ---------------------------------------------------------------------------------------------------------------

/** Whether every directory from `root` down `segments` is a real directory (no symlink on the way). */
async function plainDirsBelow(root: string, segments: readonly string[]): Promise<boolean> {
  let at = root;
  for (const segment of segments) {
    at = join(at, segment);
    const st = await lstatOrNull(at);
    if (st === null || !st.isDirectory()) return false;
  }
  return true;
}

/**
 * Removes whatever is at `<root>/<rel>` (a file or a link is unlinked, never followed; a directory is removed with
 * its content). `absent`: nothing was there. `blocked`: a directory on the way is missing its plain form (a symlink,
 * a file): nothing was touched, because the name then means a place outside `root`.
 */
export async function removeEntryBelow(root: string, rel: string): Promise<'removed' | 'absent' | 'blocked'> {
  const segments = relPathSegments(rel);
  if (segments.length === 0) return 'blocked';
  const parents = segments.slice(0, -1);
  let at = root;
  for (const segment of parents) {
    at = join(at, segment);
    const st = await lstatOrNull(at);
    if (st === null) return 'absent';
    if (!st.isDirectory()) return 'blocked';
  }
  const full = join(root, ...segments);
  const st = await lstatOrNull(full);
  if (st === null) return 'absent';
  if (st.isDirectory()) await removeTree(full);
  else await unlink(full);
  return 'removed';
}

/**
 * What is at `<root>/<rel>`: a regular `file` reached through plain directories only; `missing` (nothing is there, and
 * nothing on the way is a link); or `other`: a link, a folder, something behind a link. Only the first is read by
 * the daemon, only the first two are safe to name to git.
 */
export async function plainFileKind(root: string, rel: string): Promise<'file' | 'missing' | 'other'> {
  const segments = relPathSegments(rel);
  if (segments.length === 0) return 'other';
  if (await plainDirsBelow(root, segments.slice(0, -1))) {
    const st = await lstatOrNull(join(root, ...segments));
    if (st === null) return 'missing';
    return st.isFile() ? 'file' : 'other';
  }
  return (await missingBelow(root, segments)) ? 'missing' : 'other';
}

/**
 * The bytes of the regular file at `<root>/<rel>`, read without following a link. null: no regular file is there (it
 * is missing, a link, a directory, or a directory on the way is not a plain one). `too-large`: more than `maxBytes`.
 */
export async function readPlainFileBelow(root: string, rel: string, maxBytes: number): Promise<Buffer | null | 'too-large'> {
  const segments = relPathSegments(rel);
  if (segments.length === 0 || !(await plainDirsBelow(root, segments.slice(0, -1)))) return null;
  const full = join(root, ...segments);
  const before = await lstatOrNull(full);
  if (before === null || !before.isFile()) return null;
  if (before.size > maxBytes) return 'too-large';
  let handle;
  try {
    handle = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    if (st.size > maxBytes) return 'too-large';
    const bytes = await handle.readFile();
    return bytes.length > maxBytes ? 'too-large' : bytes;
  } finally {
    await handle.close();
  }
}

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const MARKER_SIZE = 7;

/** `head`: the first bytes of a line (at most MARKER_SIZE + 1, no line feed). git's `<<<<<<< x` / `>>>>>>> x`. */
function isConflictMarkerLine(head: Uint8Array): boolean {
  if (head.length < MARKER_SIZE) return false;
  const char = head[0];
  if (char !== LESS_THAN && char !== GREATER_THAN) return false;
  for (let i = 1; i < MARKER_SIZE; i++) if (head[i] !== char) return false;
  if (head.length === MARKER_SIZE) return true;
  const next = head[MARKER_SIZE];
  return next === 0x20 || next === 0x09 || next === 0x0d;
}

/** Whether a line of the open file starts with a conflict marker. Streams: a file of any size, constant memory. */
async function hasConflictMarkerLine(handle: Awaited<ReturnType<typeof open>>): Promise<boolean> {
  const chunk = Buffer.allocUnsafe(256 * 1024);
  const head = new Uint8Array(MARKER_SIZE + 1);
  let headLength = 0;
  // The rest of a line whose start already cannot be a marker.
  let skipping = false;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    let at = 0;
    while (at < bytesRead) {
      if (skipping) {
        const lineFeed = chunk.indexOf(0x0a, at);
        if (lineFeed === -1 || lineFeed >= bytesRead) break;
        at = lineFeed + 1;
        skipping = false;
        headLength = 0;
        continue;
      }
      const byte = chunk[at] as number;
      at += 1;
      if (byte === 0x0a) {
        if (isConflictMarkerLine(head.subarray(0, headLength))) return true;
        headLength = 0;
        continue;
      }
      if (headLength === 0 && byte !== LESS_THAN && byte !== GREATER_THAN) {
        skipping = true;
        continue;
      }
      head[headLength] = byte;
      headLength += 1;
      if (headLength === head.length) {
        if (isConflictMarkerLine(head)) return true;
        skipping = true;
      }
    }
  }
  return !skipping && isConflictMarkerLine(head.subarray(0, headLength));
}

/**
 * The files among `paths` (relative to `root`) that still have a line starting with `<<<<<<<` or `>>>>>>>`: what git
 * leaves in a file it could not merge. A path that is gone, or is no regular file any more, has none (the conflict
 * was resolved by removing it). A file that cannot be read safely counts as unresolved (fail closed).
 */
export async function filesWithConflictMarkers(root: string, paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    const segments = relPathSegments(path);
    if (segments.length === 0) continue;
    const parents = segments.slice(0, -1);
    const full = join(root, ...segments);
    const st = (await plainDirsBelow(root, parents)) ? await lstatOrNull(full) : null;
    if (st === null) {
      // Gone altogether is resolved; a parent that became a link is not something the daemon reads through.
      if (!(await missingBelow(root, segments))) found.push(path);
      continue;
    }
    if (!st.isFile()) continue;
    let handle;
    try {
      handle = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') found.push(path);
      continue;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || (await hasConflictMarkerLine(handle))) found.push(path);
    } catch {
      found.push(path);
    } finally {
      await handle.close();
    }
  }
  return found;
}

/**
 * Whether nothing can be at `<root>/<segments>`: an entry on the way is missing, or is a file (nothing lies below a
 * file). false when a symbolic link is on the way: what the name means then is not for the daemon to find out.
 */
async function missingBelow(root: string, segments: readonly string[]): Promise<boolean> {
  let at = root;
  for (let i = 0; i < segments.length; i++) {
    at = join(at, segments[i] as string);
    const st = await lstatOrNull(at);
    if (st === null) return true;
    if (i === segments.length - 1) return false;
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) return true;
  }
  return false;
}
