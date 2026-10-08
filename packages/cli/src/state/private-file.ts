// Small private JSON files under the state dir (credentials.json, workspaces.json): written atomically with mode 0600
// (open 'wx' 0600 + fchmod + fsync + rename, in a 0700 directory) and read only when they are a regular file owned by
// this user without group/other bits. A file that fails a check is refused, never "repaired" (fail closed): the
// person gets a message that says what to fix.
//
// A file this smurg cannot read is refused too, and NEVER written over (0.5.1, DESIGN B5; `versionedRecord`). Until
// 0.5.0 a `version` this smurg did not know made the file read as empty, and the next write replaced it: every link
// from a shared folder to its workspace (workspaces.json), or every login (credentials.json), gone without a word, and
// `smurg host` then made a NEW workspace for the folder. Every write here follows a read of the same file by the same
// command (the callers load, change, save), so refusing the read is what keeps the file as it is.
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { KeyFileError, ensurePrivateDirectory } from '@smurg/protocol/node';
import { CliError } from '../cli/errors.ts';
import { m } from '../i18n/index.ts';
import type { StateSubject, VersionedStateFile } from '../i18n/en.ts';
import { CLI_VERSION } from '../version.ts';

const MAX_BYTES = 1024 * 1024;

/**
 * The KeyFileError codes `stateProblem` has words of its own for: its text names the file or folder AND the reason.
 * Any other code gets `state.unusable`, which names the path only (the reason is then in the log alone).
 */
const KEY_FILE_CODES_WORDED: ReadonlySet<string> = new Set(['insecure-directory', 'insecure-permissions', 'not-owner', 'not-regular-file', 'wrong-size']);

/** Whether `stateProblem(err, …)` says the reason itself (see KEY_FILE_CODES_WORDED). */
export function stateProblemSaysWhy(err: unknown): boolean {
  return err instanceof KeyFileError && KEY_FILE_CODES_WORDED.has(err.code);
}

/** A state-dir problem as the person should read it (directory or file permissions, symlinks, other owners). */
export function stateProblem(err: unknown, subject: StateSubject): CliError {
  if (err instanceof KeyFileError) {
    const path = err.path;
    switch (err.code) {
      case 'insecure-directory':
        return new CliError(m('state.insecureDirectory', { subject, path }), { hint: m('state.insecureDirectory.hint', { path }), cause: err });
      case 'insecure-permissions':
        return new CliError(m('state.insecurePermissions', { subject, path }), { hint: m('state.insecurePermissions.hint', { path }), cause: err });
      case 'not-owner':
        return new CliError(m('state.notOwner', { subject, path }), { cause: err });
      case 'not-regular-file':
        return new CliError(m('state.notRegularFile', { subject, path }), { cause: err });
      case 'wrong-size':
        return new CliError(m('state.damaged', { subject, path }), { cause: err });
      default:
        return new CliError(m('state.unusable', { subject, path }), { cause: err });
    }
  }
  if (err instanceof CliError) return err;
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
  return new CliError(m('state.noAccess', { subject, code }), { cause: err });
}

/** A file that is there and is not what this smurg reads: refused, left as it is, and the hint says what it holds. */
function badFormat(path: string, what: StateSubject): CliError {
  return new CliError(m('state.badFormat', { subject: what, path }), { hint: m('state.badFormat.hint', { file: what === 'workspaces' ? 'workspaces' : 'credentials' }) });
}

/**
 * The content of a versioned private file (what `readPrivateJson` returned) when it is one this smurg reads: an object
 * whose `version` is `version`; null when the file does not exist. Anything else is a refusal that changes nothing:
 *  - a `version` that is a number above `version`: a NEWER smurg wrote the file; the way forward is `smurg update`;
 *  - everything else (not an object, no `version`, one that is not a number, a lower one): not in the expected format.
 * Never "empty": a caller that took such a file for empty would write over it.
 */
export function versionedRecord(raw: unknown, path: string, what: VersionedStateFile, version: number): Record<string, unknown> | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw badFormat(path, what);
  const found = raw['version'];
  if (found === version) return raw;
  if (typeof found === 'number' && Number.isFinite(found) && found > version) {
    throw new CliError(m('state.newer', { subject: what, path, current: CLI_VERSION }), { hint: m('state.newer.hint') });
  }
  throw badFormat(path, what);
}

/**
 * `value` when it is the list a versioned file holds at `key` (absent: an empty one, nothing is there that could be
 * lost); something else in its place is the refusal of a file not in its format: read as "empty", the next write
 * would put an empty list where it stood.
 */
export function listField(record: Record<string, unknown>, key: string, path: string, what: VersionedStateFile): readonly unknown[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badFormat(path, what);
  return value;
}

// ---- entries this smurg cannot read (0.5.1)
//
// Inside a file this smurg reads (its `version` is the one it knows), ONE entry can still be something it cannot read:
// a later smurg wrote a field in another form, or the entry was damaged. Until 0.5.0 such an entry was skipped without
// a word and was gone at the next write. Now the loaders keep it (state/workspaces.ts, state/credentials.ts: every
// write puts it back exactly as it was, at its place), this smurg does not use it, and the command says so ONCE per
// file: how many entries of which file. The loaders have no terminal; the command's context lends them its own.

/** Told how many entries of which file were not read. */
export type UnreadEntriesTeller = (what: VersionedStateFile, path: string, count: number) => void;

const unreadTellers = new WeakMap<object, { readonly tell: UnreadEntriesTeller; readonly told: Set<string> }>();

/** From now on `tell` hears, once per file, of entries a loader given `paths` (this very object) could not read. */
export function tellUnreadEntries(paths: object, tell: UnreadEntriesTeller): void {
  unreadTellers.set(paths, { tell, told: new Set() });
}

/** A loader's report. Said once per command (the `paths` object of its context) and file; never for a count of 0. */
export function reportUnreadEntries(paths: object, what: VersionedStateFile, path: string, count: number): void {
  if (count <= 0) return;
  const teller = unreadTellers.get(paths);
  if (teller === undefined || teller.told.has(path)) return;
  teller.told.add(path);
  teller.tell(what, path, count);
}

/** `value` when it is the object a versioned file must hold at `key`; else the refusal of a file not in its format. */
export function recordField(record: Record<string, unknown>, key: string, path: string, what: VersionedStateFile): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw badFormat(path, what);
  return value;
}

/** Parsed JSON of `path`, or null when it does not exist. */
export async function readPrivateJson(path: string, what: StateSubject): Promise<unknown> {
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
    if (st.size > MAX_BYTES) throw new CliError(m('state.tooLarge', { subject: what, path }));
    const text = await handle.readFile({ encoding: 'utf8' });
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw badFormat(path, what);
    }
  } finally {
    await handle.close();
  }
}

/** Replaces `path` atomically with `value` as JSON, mode 0600; creates the private directory when needed. */
export async function writePrivateJson(path: string, value: unknown, what: StateSubject): Promise<void> {
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
