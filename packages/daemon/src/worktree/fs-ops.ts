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
