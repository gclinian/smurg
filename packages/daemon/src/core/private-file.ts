// Opening a file of the workspace folder (ARCHITECTURE §7.1): never through a symlink, only a regular file, ours, with
// no group/other permission bit. Every refusal is a StateFileError with its kind (core/state-file-error.ts): `insecure`
// with the cause, or `cannot-open` with the errno. Nothing is ever repaired (no chmod, no unlink).
//
// One function for the documents, the stamp, the kept copies, audit.jsonl, audit-text.jsonl and activity.jsonl, so
// that "what is refused" is the same for all of them.
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { StateFileError, errnoCodeOf } from './state-file-error.ts';

const GROUP_OTHER_BITS = 0o077;

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** What a private file's metadata must say; throws the `insecure` refusal otherwise. `what`: "state file", "audit log". */
export function assertPrivateFileStat(path: string, st: Stats, what: string): void {
  if (st.isSymbolicLink()) throw new StateFileError({ kind: 'insecure', cause: 'symlink', path, message: `${what} is a symlink` });
  if (!st.isFile()) throw new StateFileError({ kind: 'insecure', cause: 'not-a-file', path, message: `${what} is not a regular file` });
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) throw new StateFileError({ kind: 'insecure', cause: 'owner', path, message: `${what} is owned by another user` });
  if ((st.mode & GROUP_OTHER_BITS) !== 0) {
    const mode = st.mode & 0o777;
    throw new StateFileError({ kind: 'insecure', cause: 'mode', mode, path, message: `${what} mode ${mode.toString(8)} grants group/other access` });
  }
}

export interface OpenPrivateOptions {
  /** For the messages: "state file", "audit log", "activity log", … */
  readonly what: string;
  /** Mode of a file this call creates (O_CREAT). Default 0600. */
  readonly createMode?: number;
}

/**
 * Opens `path` with `flags` plus O_NOFOLLOW (and O_NONBLOCK for a read-only open: a FIFO in the file's place must not
 * hang the start), then checks it through the handle. Returns null when the file does not exist and `flags` has no
 * O_CREAT. The caller closes the handle.
 */
export async function openPrivateFile(path: string, flags: number, options: OpenPrivateOptions): Promise<FileHandle | null> {
  const readOnly = (flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR)) === 0;
  let handle: FileHandle;
  try {
    handle = await open(path, flags | fsConstants.O_NOFOLLOW | (readOnly ? fsConstants.O_NONBLOCK : 0), options.createMode ?? 0o600);
  } catch (source) {
    const code = errnoCodeOf(source);
    if (code === 'ENOENT' && (flags & fsConstants.O_CREAT) === 0) return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new StateFileError({ kind: 'insecure', cause: 'symlink', path, message: `${options.what} is a symlink`, source });
    // A socket or a device in the file's place fails to open with its own errno: say what is there, not the errno.
    const there = await lstat(path).catch(() => null);
    if (there !== null && !there.isFile() && !there.isSymbolicLink()) {
      throw new StateFileError({ kind: 'insecure', cause: 'not-a-file', path, message: `${options.what} is not a regular file`, source });
    }
    throw new StateFileError({ kind: 'cannot-open', errno: code ?? 'unknown', path, message: `cannot open the ${options.what} (${code ?? 'unknown'})`, source });
  }
  try {
    assertPrivateFileStat(path, await handle.stat(), options.what);
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/**
 * Looks at `path` without reading it: null when it does not exist, otherwise the refusal it would get (or nothing).
 * Used by phase 1 of a start, which collects EVERY insecure file before it reports.
 */
export async function inspectPrivateFile(path: string, what: string): Promise<{ readonly exists: boolean; readonly refusal: StateFileError | null }> {
  try {
    const handle = await openPrivateFile(path, fsConstants.O_RDONLY, { what });
    if (handle === null) return { exists: false, refusal: null };
    await handle.close().catch(() => {});
    return { exists: true, refusal: null };
  } catch (err) {
    if (err instanceof StateFileError) return { exists: true, refusal: err };
    throw err;
  }
}
