// Filesystem helpers shared by PathGuard and RootRegistry. They only ever describe what exists; decisions live in
// the callers.
import type { Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import type { FileIdentity } from '../core/interfaces.ts';

// ---------------------------------------------------------------------------------------------------------------
// Unicode spellings of one name (ARCHITECTURE §7.4: every FileRef path is NFC). APFS compares names
// normalisation-insensitively: an NFC request reaches an entry stored as NFD (`cafe` + U+0301, as macOS tools write it).
// ext4 and the other Linux file systems compare bytes: `café` and `cafe` + U+0301 are two different entries there, and a
// directory may hold an NFD name that no NFC request would ever reach (a zip or a git checkout made on a Mac). PathGuard
// maps an NFC request onto the ONE entry of the directory that spells it differently; the listings leave out the
// names that no request can address (otherSpellings / unaddressableNames).
// ---------------------------------------------------------------------------------------------------------------

const NON_ASCII = /[^\u0000-\u007f]/;
/**
 * A non-ASCII character, or one of the three ASCII characters that are the NFC form of a non-ASCII one (U+037E GREEK
 * QUESTION MARK → `;`, U+1FEF GREEK VARIA → `` ` ``, U+212A KELVIN SIGN → `K`; checked over every code point): only
 * then can another string normalise (NFC) to the name. Keeps the directory scan off every ASCII miss.
 */
const MAY_HAVE_OTHER_SPELLING = /[^\u0000-\u007f]|[;`K]/;

/**
 * The entries of `dir` whose names are not `name` but normalise (NFC) to it. Empty when `name` cannot have another
 * spelling or the directory cannot be listed. Only for normalisation-sensitive file systems (not needed on APFS).
 */
export async function otherSpellings(dir: string, name: string): Promise<string[]> {
  if (!MAY_HAVE_OTHER_SPELLING.test(name)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return [];
    throw err;
  }
  return names.filter((entry) => entry !== name && NON_ASCII.test(entry) && entry.normalize('NFC') === name);
}

/**
 * The names of one directory that no (NFC) request can address, so listings leave them out: on a normalisation-
 * sensitive file system, a non-NFC name whose NFC form is also on disk (the NFC entry is what the request reaches), and
 * non-NFC names that share their NFC form with another non-NFC name (ambiguous: PathGuard reaches neither). Always
 * empty on APFS, where two such names cannot coexist.
 */
export function unaddressableNames(names: readonly string[]): Set<string> {
  const byForm = new Map<string, string[]>();
  for (const name of names) {
    if (!NON_ASCII.test(name)) continue;
    const nfc = name.normalize('NFC');
    if (nfc === name) continue;
    const group = byForm.get(nfc);
    if (group) group.push(name);
    else byForm.set(nfc, [name]);
  }
  const out = new Set<string>();
  if (byForm.size === 0) return out;
  const present = new Set(names);
  for (const [nfc, group] of byForm) if (present.has(nfc) || group.length > 1) for (const name of group) out.add(name);
  return out;
}

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
