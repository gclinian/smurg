// How the locks module names a file. Per-file state must be keyed by the file ITSELF, not by the request's spelling
// (ARCHITECTURE §7.4): on a case-insensitive file system `README.md` and `readme.md` are one file, and a symlink
// inside the share is a second name for its target. Two layers:
//  1. lockKeyOf(): a synchronous key with every path segment case- and normalisation-folded (foldPathName). It
//     merges more names than a case-sensitive file system would; for a lock that only means "more locking", which is
//     the fail-closed direction.
//  2. canonicalFileRef(): the realpath of the spelling (symlinks resolved, on-disk case), mapped back to the most
//     specific root. The LockManager learns these asynchronously and re-keys locks that were taken under an alias.
import { join } from 'node:path';
import { foldPathName, isSmurgDirName, relPathSegments, rootRefKey, type FileRef } from '@smurg/protocol';
import type { PathGuard, RootRegistry } from '../core/interfaces.ts';

/** Synchronous identity key of a file: `<root key>:<folded path>`. */
export function lockKeyOf(ref: FileRef): string {
  const segments = relPathSegments(ref.path.normalize('NFC')).map(foldPathName);
  return `${rootRefKey(ref.root)}:${segments.join('/')}`;
}

/**
 * `<share>/.smurg/**` of the main root is hidden from everyone but the host (ARCHITECTURE §5.2): locks, presence and
 * activity about such a path must not reach other members, not even its name.
 */
export function isHiddenFromGuests(ref: FileRef): boolean {
  if (ref.root.kind !== 'main') return false;
  const first = relPathSegments(ref.path)[0];
  return first !== undefined && isSmurgDirName(first);
}

/**
 * The file's canonical FileRef: realpath (native: symlinks resolved, on-disk case) of the spelling inside its root,
 * mapped back with PathGuard.toFileRef to the most specific root (a path through a shared read-only link maps to the
 * main root). null when the root is unknown or the path leaves every root.
 */
export async function canonicalFileRef(deps: { readonly roots: RootRegistry; readonly paths: PathGuard }, ref: FileRef): Promise<FileRef | null> {
  const root = deps.roots.get(ref.root);
  if (root === null) return null;
  const segments = relPathSegments(ref.path);
  const abs = segments.length === 0 ? root.realPath : join(root.realPath, ...segments);
  return deps.paths.toFileRef(abs);
}
