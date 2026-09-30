// Filesystem helpers shared by PathGuard and RootRegistry. They only ever describe what exists; decisions live in
// the callers.
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import type { FileIdentity } from '../core/interfaces.ts';

export function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/** lstat, or null when nothing is there (ENOENT). ENOTDIR is reported as 'not-directory'. */
export async function lstatOrNull(path: string): Promise<Stats | null | 'not-directory'> {
  try {
    return await lstat(path);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    if (code === 'ENOTDIR') return 'not-directory';
    throw err;
  }
}

export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
    throw err;
  }
}

export function identityOf(st: Stats): FileIdentity {
  const kind: FileIdentity['kind'] = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'other';
  return { dev: st.dev, ino: st.ino, kind, size: st.size, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode, nlink: st.nlink };
}

export function sameObject(a: Pick<FileIdentity, 'dev' | 'ino' | 'kind'>, b: Pick<FileIdentity, 'dev' | 'ino' | 'kind'>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.kind === b.kind;
}

/** `child` is `parent` or lies below it (both absolute and symlink-free). */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}
