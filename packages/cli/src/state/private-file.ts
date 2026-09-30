// Small private JSON files under the state dir (credentials.json, workspaces.json): written atomically with mode 0600
// (open 'wx' 0600 + fchmod + fsync + rename, in a 0700 directory) and read only when they are a regular file owned by
// this user without group/other bits. A file that fails a check is refused, never "repaired" (fail closed): the
// person gets a zh-TW message that says what to fix.
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { KeyFileError, ensurePrivateDirectory } from '@smurg/protocol/node';
import { CliError } from '../cli/errors.ts';

const MAX_BYTES = 1024 * 1024;

/** The zh-TW explanation of a state-dir problem (directory or file permissions, symlinks, other owners). */
export function stateProblem(err: unknown, what: string): CliError {
  if (err instanceof KeyFileError) {
    switch (err.code) {
      case 'insecure-directory':
        return new CliError(`${what}所在的資料夾權限不安全（其他使用者可以存取）：${err.path}`, { hint: `請執行 chmod 700 ${err.path}，或改用新的 SMURG_HOME。`, cause: err });
      case 'insecure-permissions':
        return new CliError(`${what}的權限不安全（其他使用者可以讀取）：${err.path}`, { hint: `請執行 chmod 600 ${err.path}。`, cause: err });
      case 'not-owner':
        return new CliError(`${what}屬於其他使用者：${err.path}`, { cause: err });
      case 'not-regular-file':
        return new CliError(`${what}不是一般檔案（可能是 symlink）：${err.path}`, { cause: err });
      case 'wrong-size':
        return new CliError(`${what}已損毀：${err.path}`, { cause: err });
      default:
        return new CliError(`${what}無法使用：${err.path}`, { cause: err });
    }
  }
  if (err instanceof CliError) return err;
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
  return new CliError(`無法存取${what}（${code}）`, { cause: err });
}

/** Parsed JSON of `path`, or null when it does not exist. */
export async function readPrivateJson(path: string, what: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw stateProblem(new KeyFileError('not-regular-file', path, 'symlink'), what);
    throw stateProblem(err, what);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw stateProblem(new KeyFileError('not-regular-file', path, 'not a file'), what);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw stateProblem(new KeyFileError('not-owner', path, 'owner'), what);
    if ((st.mode & 0o077) !== 0) throw stateProblem(new KeyFileError('insecure-permissions', path, 'mode'), what);
    if (st.size > MAX_BYTES) throw new CliError(`${what}太大，可能已損毀：${path}`);
    const text = await handle.readFile({ encoding: 'utf8' });
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CliError(`${what}的格式不正確：${path}`, { hint: '可以刪除這個檔案後重新執行（需要重新登入或重新分享）。' });
    }
  } finally {
    await handle.close();
  }
}

/** Replaces `path` atomically with `value` as JSON, mode 0600; creates the private directory when needed. */
export async function writePrivateJson(path: string, value: unknown, what: string): Promise<void> {
  const dir = dirname(path);
  try {
    await ensurePrivateDirectory(dir);
  } catch (err) {
    throw stateProblem(err, what);
  }
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  let published = false;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    published = true;
  } catch (err) {
    throw stateProblem(err, what);
  } finally {
    if (!published) await unlink(tmp).catch(() => {});
  }
}

/** Removes `path` if it exists. */
export async function removePrivateFile(path: string): Promise<void> {
  await unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

// ---- tiny validators (the CLI has no schema library of its own)

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string, max = 8192): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
