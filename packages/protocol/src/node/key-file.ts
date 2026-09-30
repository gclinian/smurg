// Raw 32-byte key files (ARCHITECTURE §4.2 "Device keys", §7.1; noise.md §1.6 CLI bullet).
//
// Writing: open(tmp, 'wx', 0o600) + fchmod + write + fsync + (rename | link) — writeFile's `mode` applies only on
// creation, so rewriting an existing 0644 file in place would keep it world-readable (verified pitfall).
// Creation without `overwrite` publishes with link(), which fails if the target exists: two processes racing to
// create the daemon identity can never silently replace each other's key.
// Reading: O_NOFOLLOW, a regular file owned by us, no group/other permission bits, exact size, and a private
// parent directory. Anything else is refused (fail closed); nothing is ever "repaired" by chmod.
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes, toHex } from '../bytes.ts';

export type KeyFileErrorCode =
  | 'missing' // the file does not exist
  | 'exists' // create-only write, but the file is already there
  | 'not-regular-file' // a symlink, directory, device, …
  | 'insecure-permissions' // group/other bits set on the file
  | 'insecure-directory' // the directory is not ours or grants group/other access
  | 'not-owner' // owned by another user
  | 'wrong-size'; // not exactly the expected number of bytes

export class KeyFileError extends Error {
  readonly code: KeyFileErrorCode;
  readonly path: string;

  constructor(code: KeyFileErrorCode, path: string, message: string, options?: { cause?: unknown }) {
    super(`${message}: ${path}`, options);
    this.name = 'KeyFileError';
    this.code = code;
    this.path = path;
  }
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_OTHER_BITS = 0o077;

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

async function assertPrivateDirectory(dir: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') throw new KeyFileError('missing', dir, 'directory does not exist', { cause });
    throw cause;
  }
  const uid = currentUid();
  if (!st.isDirectory()) throw new KeyFileError('insecure-directory', dir, 'not a directory (or a symlink)');
  if (uid !== undefined && st.uid !== uid) throw new KeyFileError('insecure-directory', dir, 'directory is owned by another user');
  if ((st.mode & GROUP_OTHER_BITS) !== 0) {
    throw new KeyFileError('insecure-directory', dir, `directory mode ${(st.mode & 0o777).toString(8)} grants group/other access`);
  }
}

/**
 * Creates `dir` (and missing parents) with mode 0700, then verifies the final directory is a real directory owned by
 * us without group/other access. An existing directory with looser permissions is refused, not chmod-ed.
 */
export async function ensurePrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await assertPrivateDirectory(dir);
}

export interface WriteKeyFileOptions {
  /** Replace an existing file atomically (rename). Default false: create only (link), 'exists' if present. */
  overwrite?: boolean;
}

/** Writes `bytes` to `path` with mode 0600 (see the file comment). The directory must already be private. */
export async function writeKeyFile(path: string, bytes: Uint8Array, options: WriteKeyFileOptions = {}): Promise<void> {
  const dir = dirname(path);
  await assertPrivateDirectory(dir);
  const tmp = join(dir, `.${basename(path)}.${toHex(randomBytes(8))}.tmp`);
  let published = false;
  try {
    const handle = await open(tmp, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.overwrite) {
      await rename(tmp, path);
      published = true;
    } else {
      try {
        await link(tmp, path);
      } catch (cause) {
        if (errnoCode(cause) === 'EEXIST') throw new KeyFileError('exists', path, 'key file already exists', { cause });
        throw cause;
      }
    }
    await syncDirectory(dir);
  } finally {
    if (!published) await unlink(tmp).catch(() => {});
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Best effort: makes the new directory entry durable; not every platform allows fsync on a directory.
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // ignore
  }
}

/** Reads a key file after the checks in the file comment. */
export async function readKeyFile(path: string, expectedBytes = 32): Promise<Uint8Array> {
  await assertPrivateDirectory(dirname(path));
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === 'ENOENT') throw new KeyFileError('missing', path, 'key file does not exist', { cause });
    if (code === 'ELOOP' || code === 'EMLINK') throw new KeyFileError('not-regular-file', path, 'key file is a symlink', { cause });
    throw cause;
  }
  try {
    const st = await handle.stat();
    const uid = currentUid();
    if (!st.isFile()) throw new KeyFileError('not-regular-file', path, 'key file is not a regular file');
    if (uid !== undefined && st.uid !== uid) throw new KeyFileError('not-owner', path, 'key file is owned by another user');
    if ((st.mode & GROUP_OTHER_BITS) !== 0) {
      throw new KeyFileError('insecure-permissions', path, `key file mode ${(st.mode & 0o777).toString(8)} grants group/other access`);
    }
    if (st.size !== expectedBytes) throw new KeyFileError('wrong-size', path, `key file must be exactly ${expectedBytes} bytes`);
    const out = new Uint8Array(expectedBytes);
    const { bytesRead } = await handle.read(out, 0, expectedBytes, 0);
    if (bytesRead !== expectedBytes) throw new KeyFileError('wrong-size', path, 'key file changed while reading');
    return out;
  } finally {
    await handle.close();
  }
}
