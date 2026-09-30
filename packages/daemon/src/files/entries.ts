// FileEntry construction (ARCHITECTURE §5.2) from the lstat facts PathGuard already took, plus the decorations
// (read-only, lock, lastModifiedBy). Special files (FIFOs, sockets, devices) have no FileEntry kind and are left out
// of every listing.
import type { Actor, FileEntry, LockInfo } from '@smurg/protocol';
import type { FileIdentity } from '../core/interfaces.ts';

export interface EntryDecorations {
  readonly readOnly?: boolean;
  readonly lock?: LockInfo | null;
  readonly lastModifiedBy?: Actor | null;
}

/**
 * `name` and `path` must already be NFC and valid (checkRelPath). Directories report size 0: a directory's st_size
 * is a file-system detail (APFS: bytes of its entries), not something a person can use.
 */
export function entryFromIdentity(name: string, path: string, identity: FileIdentity, decorations: EntryDecorations = {}): FileEntry | null {
  if (identity.kind === 'other') return null;
  const entry: FileEntry = {
    name,
    path,
    kind: identity.kind,
    size: identity.kind === 'dir' ? 0 : identity.size,
    mtime: Math.floor(identity.mtimeMs),
  };
  if (decorations.readOnly) entry.readOnly = true;
  if (decorations.lock) entry.lock = decorations.lock;
  if (decorations.lastModifiedBy) entry.lastModifiedBy = decorations.lastModifiedBy;
  return entry;
}
