// Guarded mutations of the shared folder. A session's agent or shell can swap any directory of the share for a
// symlink at any moment (yjs-monaco.md verification item 1), so every operation here:
//  1. resolves (or re-validates) the path through PathGuard immediately before the syscall,
//  2. performs one path-based syscall, and
//  3. checks afterwards that what happened happened inside the root, undoing it when it did not.
// The window between 1 and 2 cannot be closed without openat()/renameat2(), which Node does not offer; 3 turns a lost
// race into a refused request instead of an escape.
//
// Deletion never walks a tree members can still write: the entry is first renamed into `<share>/.smurg/trash`
// (atomic, same volume, and unreachable for members other than the host: PathGuard hides .smurg), and only there is
// it removed recursively. A recursive delete in place would follow a directory that was swapped for a symlink
// halfway through and delete files outside the share.
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SmurgError, baseNameOfRelPath, foldPathName, isSmurgDirName, relPathSegments, type FileRef, type RootRef } from '@smurg/protocol';
import { PathDeniedError } from '../core/errors.ts';
import type { FileIdentity, PathGuard, Principal, ResolvedPath } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { errnoCode, identityOf, isInside, lstatOrNull, realpathOrNull, sameObject } from '../workspace/fs-util.ts';
import { joinRel } from './util.ts';

/** Directories below `<share>/.smurg` that the daemon owns (never renamed or deleted through file.*). */
const DAEMON_DIRS: ReadonlySet<string> = new Set(['worktrees', 'uploads', 'trash']);

/**
 * `<share>/.smurg` itself, its daemon directories, a worktree root, and anything inside the staging and trash
 * directories. Only the host can reach them at all (they are hidden from everyone else); even the host must not move
 * them away under the daemon's feet (worktrees are removed with worktree.remove).
 */
export function isDaemonOwnedPath(root: RootRef, path: string): boolean {
  if (root.kind !== 'main') return false;
  const segments = relPathSegments(path);
  if (segments.length === 0 || !isSmurgDirName(segments[0] as string)) return false;
  if (segments.length === 1) return true;
  const second = foldPathName(segments[1] as string);
  if (!DAEMON_DIRS.has(second)) return false;
  if (second === 'uploads' || second === 'trash') return true;
  return segments.length <= 3; // .smurg/worktrees, .smurg/worktrees/<id>
}

export function daemonOwnedError(): SmurgError {
  return new SmurgError('forbidden', '這個資料夾由 smurg 管理，不能直接修改', { reason: 'daemon-owned' });
}

export function notFoundError(reason: string): SmurgError {
  return new SmurgError('not_found', reason === 'parent-missing' ? '上層資料夾不存在' : '找不到指定的項目', { reason });
}

export function existsError(): SmurgError {
  return new SmurgError('conflict', '已經有同名的檔案或資料夾', { reason: 'exists' });
}

/** `<share>/.smurg/trash`, created 0700 when missing. Refuses anything that is not the real directory. */
export async function ensureTrashDir(mainRealPath: string): Promise<string> {
  const smurgDir = join(mainRealPath, '.smurg');
  const trash = join(smurgDir, 'trash');
  const smurgStat = await lstatOrNull(smurgDir);
  if (smurgStat === null || smurgStat === 'not-directory' || !smurgStat.isDirectory()) {
    throw new SmurgError('internal', undefined, { reason: 'smurg-dir-missing' });
  }
  const existing = await lstatOrNull(trash);
  if (existing === null) await mkdir(trash, { mode: 0o700 }).catch((err: unknown) => (errnoCode(err) === 'EEXIST' ? undefined : Promise.reject(err)));
  const st = await lstatOrNull(trash);
  if (st === null || st === 'not-directory' || !st.isDirectory() || (await realpathOrNull(trash)) !== trash) {
    throw new SmurgError('internal', undefined, { reason: 'trash-dir-invalid' });
  }
  return trash;
}

/** Empties the trash (leftovers of a delete interrupted by a crash). Nothing in it is reachable for guests. */
export async function emptyTrash(trashDir: string): Promise<void> {
  for (const name of await readdir(trashDir).catch(() => [] as string[])) {
    await rm(join(trashDir, name), { recursive: true, force: true }).catch(() => {});
  }
}

export interface GuardContext {
  readonly paths: PathGuard;
  readonly principal: Principal;
}

/**
 * Deletes a resolved entry (file, symlink or directory tree): re-validate → rename into the trash → verify that the
 * object that arrived is the one we resolved (else put it back and refuse) → remove it there. A directory on another
 * volume (a mount point inside the share) cannot be renamed into the trash and is refused.
 */
export async function deleteResolved(resolved: ResolvedPath, trashDir: string, guard: GuardContext): Promise<void> {
  const options = { principal: guard.principal, forWrite: true, mustExist: true, finalSymlink: 'self' as const };
  const fresh = await guard.paths.revalidate(resolved, options);
  const expected = fresh.identity as FileIdentity;
  const parked = join(trashDir, newId('del'));
  try {
    await rename(fresh.realPath, parked);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') throw notFoundError('vanished');
    if (code !== 'EXDEV') throw err;
    if (expected.kind === 'dir') throw new SmurgError('bad_request', '無法刪除位於其他磁碟區的資料夾', { reason: 'cross-device' });
    // A single file or link on another volume: one unlink right after the re-validation.
    await guard.paths.revalidate(fresh, options);
    await unlink(fresh.realPath);
    return;
  }
  const arrived = await lstatOrNull(parked);
  if (arrived === null || arrived === 'not-directory' || !sameObject(identityOf(arrived), expected)) {
    // Something else was at the path when rename() ran (a parent swapped for a symlink): give it back untouched.
    await rename(parked, fresh.realPath).catch(() => {});
    throw new PathDeniedError('changed', fresh.ref.path);
  }
  await rm(parked, { recursive: true, force: true });
}

/**
 * Moves `from` to the (checked, not existing or same-object) `to` in the same root. Regular files are moved with
 * link() + unlink(), so a file that appears at `to` in the meantime makes link() fail with EEXIST instead of being
 * overwritten; directories and links use rename(). Afterwards the moved object must sit at `to` inside the root, or
 * the move is undone.
 */
export async function moveResolved(from: ResolvedPath, to: ResolvedPath, guard: GuardContext): Promise<void> {
  const fromOptions = { principal: guard.principal, forWrite: true, mustExist: true, finalSymlink: 'self' as const };
  const toOptions = { principal: guard.principal, forWrite: true, finalSymlink: 'self' as const };
  const source = await guard.paths.revalidate(from, fromOptions);
  const target = await guard.paths.revalidate(to, toOptions);
  const identity = source.identity as FileIdentity;
  const sameEntry = target.exists && target.identity !== null && sameObject(target.identity, identity);
  if (target.exists && !sameEntry) throw existsError();
  // Onto the same entry, only the spelling changes (case on APFS, Unicode normalisation): the new name is the one
  // requested, not the entry's current one (PathGuard hands out paths as the file system spells them).
  const destination = sameEntry ? join(target.parentRealPath, baseNameOfRelPath(target.ref.path)) : target.realPath;
  let linked = false;
  if (identity.kind === 'file' && !sameEntry) {
    try {
      await link(source.realPath, target.realPath);
      linked = true;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EEXIST') throw existsError();
      if (code === 'ENOENT') throw notFoundError('vanished');
      // No hard links on this file system (ExFAT, transfer.md §1.4): fall back to a checked rename below.
      if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EOPNOTSUPP' && code !== 'EMLINK') throw err;
    }
  }
  if (!linked) {
    if (!sameEntry && (await lstatOrNull(target.realPath)) !== null) throw existsError();
    try {
      await rename(source.realPath, destination);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') throw notFoundError('vanished');
      if (code === 'EINVAL') throw new SmurgError('bad_request', '不能把資料夾移到它自己裡面', { reason: 'into-itself' });
      if (code === 'ENOTEMPTY' || code === 'EEXIST') throw existsError();
      if (code === 'EXDEV') throw new SmurgError('bad_request', '無法在不同磁碟區之間移動', { reason: 'cross-device' });
      throw err;
    }
  }
  // Post-move check: the object must be at the checked location, and that location must still be inside the root.
  const placed = await lstatOrNull(destination);
  const parentReal = await realpathOrNull(target.parentRealPath);
  const inside = parentReal === target.parentRealPath && isInside(parentReal, target.root.realPath);
  if (placed === null || placed === 'not-directory' || !sameObject(identityOf(placed), identity) || !inside) {
    if (linked) await unlink(target.realPath).catch(() => {});
    else await rename(destination, source.realPath).catch(() => {});
    throw new PathDeniedError(inside ? 'changed' : 'outside-root', target.ref.path);
  }
  if (linked) {
    // The source name still links the same inode; remove exactly that name. Checked here rather than with
    // PathGuard.revalidate: the file now has TWO links (ours), which PathGuard's hard-link rule refuses, and audits, as
    // a security denial (review WEB-16: a red 「不允許存取有多個硬連結的檔案」 for every rename). The same checks: the
    // name is still the moved object, and its directory is still the one resolved, inside the root.
    const at = await lstatOrNull(source.realPath);
    const sourceParent = await realpathOrNull(source.parentRealPath);
    const unchanged = sourceParent === source.parentRealPath && isInside(sourceParent, source.root.realPath) && at !== null && at !== 'not-directory' && sameObject(identityOf(at), identity);
    if (!unchanged) {
      if (at === null) return; // already gone (someone removed the old name): the move is complete
      await unlink(target.realPath).catch(() => {}); // undo: the old name is not what we moved any more
      throw new PathDeniedError('changed', source.ref.path);
    }
    await unlink(source.realPath).catch((err: unknown) => {
      if (errnoCode(err) !== 'ENOENT') throw err;
    });
  }
}

/**
 * Creates one directory (its parent must exist): resolve for writing, mkdir, post-move check (PathGuard.checkPlaced
 * removes a directory that landed outside). Returns false when a directory is already there.
 */
export async function makeDirectory(ref: FileRef, guard: GuardContext): Promise<{ readonly created: boolean; readonly resolved: ResolvedPath }> {
  const options = { principal: guard.principal, forWrite: true, finalSymlink: 'deny' as const };
  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await guard.paths.resolve(ref, options);
    if (resolved.exists) {
      if (resolved.identity?.kind === 'dir') return { created: false, resolved };
      throw new SmurgError('conflict', '已經有同名的檔案', { reason: 'not-a-directory' });
    }
    try {
      await mkdir(resolved.realPath, { mode: 0o777 });
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EEXIST') continue; // someone made it meanwhile: resolve again and accept a directory
      if (code === 'ENOENT') throw notFoundError('parent-missing');
      throw err;
    }
    const st = await lstatOrNull(resolved.realPath);
    if (st === null || st === 'not-directory') throw new PathDeniedError('changed', resolved.ref.path);
    await guard.paths.checkPlaced(resolved, identityOf(st), options);
    return { created: true, resolved };
  }
  throw existsError();
}

/**
 * Creates every missing directory of `dirPath` (like mkdir -p), each level resolved through PathGuard for writing,
 * so a non-host cannot create e.g. `.claude/` on the way. Returns the paths that were created.
 */
export async function makeDirectories(root: RootRef, dirPath: string, guard: GuardContext): Promise<string[]> {
  const created: string[] = [];
  let current = '';
  for (const segment of relPathSegments(dirPath)) {
    current = joinRel(current, segment);
    const result = await makeDirectory({ root, path: current }, guard);
    if (result.created) created.push(current);
  }
  return created;
}

/**
 * Places a finished staging file at a resolved, non-existing target without ever replacing an existing file:
 * link() + unlink(staging) (EEXIST is the final arbiter, transfer.md §1.8), or on file systems without hard links an
 * `open(dest, O_EXCL)` placeholder followed by rename() (transfer.md §1.4, verified on ExFAT).
 */
export async function placeNoClobber(stagingPath: string, targetRealPath: string): Promise<void> {
  try {
    await link(stagingPath, targetRealPath);
    await unlink(stagingPath);
    return;
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST') throw existsError();
    if (code === 'ENOENT') throw notFoundError('parent-missing');
    if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EOPNOTSUPP' && code !== 'EMLINK') throw err;
  }
  const placeholder = await open(targetRealPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600).catch((err: unknown) => {
    if (errnoCode(err) === 'EEXIST') throw existsError();
    throw err;
  });
  await placeholder.close();
  await rename(stagingPath, targetRealPath);
}

/** `name (1).ext`, `name (2).ext`, … (transfer.md §1.8 onConflict 'rename'). */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  return `${stem} (${n})${ext}`;
}

/** lstat of a path, as a FileIdentity (null: missing). */
export async function identityAt(path: string): Promise<FileIdentity | null> {
  const st = await lstat(path).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return null;
    throw err;
  });
  return st === null ? null : identityOf(st);
}

/** The directory holding an absolute path. */
export function parentOf(absPath: string): string {
  return dirname(absPath);
}
