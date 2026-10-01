// Linux (review GR-4): while a guest process runs in the share, the service's placeholders stand in the host's project
// (empty `.claude/`, `.vscode/`, `.idea/` directories of its own and srt's empty read-only `.mcp.json` / `.envrc` mount
// points; service.ts holdPlaceholderDirs, ARCHITECTURE §7.6 "Linux mount points on the host"). The host's git took them
// for the host's own files: `git add -A` committed srt's files into the host's repository (and srt's cleanup later
// deleted the now tracked files from the working tree), `git stash -u` and `git clean -fd` removed the placeholders,
// which ends every guest process there, and `git stash pop` brought srt's files back as the host's own. So while they
// exist they are listed in the share's `.git/info/exclude` (the file the daemon already keeps `/.smurg/` in, never the
// project's .gitignore), in one block of this service's own that goes with them. A block a crashed daemon left is
// removed by the next start's placeholder sweep.
//
// Ignored files are left alone by `git add -A`, `git stash -u`, `git clean -fd` and `git status`; `git add -f`,
// `git clean -x` and `git stash -a` still take them (HOSTING). Never follows a symlink; writes through a temp file and a
// rename, so the host's own lines are never half written.
import { closeSync, constants, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Logger } from '../core/logger.ts';
import { HOST_ONLY_DIR_NAMES, HOST_ONLY_FILE_NAMES } from './policy.ts';

/** The first line of the block; the lines after it that name a placeholder belong to it. */
export const PLACEHOLDER_EXCLUDE_HEADER = '# smurg: guest sandbox placeholders, only while a guest process runs (smurg removes these lines)';
/**
 * The names the block may list: the placeholders the service makes at the top of the share (`.git` is the repository
 * itself there, `.smurg` the daemon's own directory, which share.ts excludes with a line of its own).
 */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES].filter((name) => name !== '.git' && name !== '.smurg'));

function patternOf(name: string): string {
  return `/${name}`;
}

/** The text without this service's block, and the names the block listed. */
function splitBlock(text: string): { readonly rest: string; readonly names: string[] } {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.replace(/\r$/, '') === PLACEHOLDER_EXCLUDE_HEADER);
  if (start < 0) return { rest: text, names: [] };
  let end = start + 1;
  const names: string[] = [];
  while (end < lines.length) {
    const line = (lines[end] as string).replace(/\r$/, '');
    const name = line.startsWith('/') ? line.slice(1) : '';
    if (!PLACEHOLDER_NAMES.has(name)) break;
    names.push(name);
    end++;
  }
  lines.splice(start, end - start);
  return { rest: lines.join('\n'), names };
}

function withBlock(rest: string, names: readonly string[]): string {
  if (names.length === 0) return rest;
  const base = rest.length === 0 || rest.endsWith('\n') ? rest : `${rest}\n`;
  return `${base}${PLACEHOLDER_EXCLUDE_HEADER}\n${names.map(patternOf).join('\n')}\n`;
}

/** `<share>/.git/info` of a real git directory (a `.git` directory with a HEAD; never through a symlink), else null. */
async function infoDir(share: string): Promise<string | null> {
  const gitDir = join(share, '.git');
  const git = await lstat(gitDir).catch(() => null);
  if (git === null || !git.isDirectory()) return null;
  const head = await lstat(join(gitDir, 'HEAD')).catch(() => null);
  if (head === null || !(head.isFile() || head.isSymbolicLink())) return null;
  const info = join(gitDir, 'info');
  const st = await lstat(info).catch(() => null);
  if (st === null) {
    await mkdir(info, { mode: 0o755 }).catch(() => {});
    const made = await lstat(info).catch(() => null);
    return made !== null && made.isDirectory() ? info : null;
  }
  return st.isDirectory() ? info : null;
}

/**
 * Adds `names` (placeholders about to be made at the top of the share) to this service's block in the share's
 * `.git/info/exclude`. False when the share is no git repository or the file cannot be written (logged): the
 * placeholders are made anyway. Calls must not overlap (the service runs them one at a time).
 */
export async function addPlaceholderExcludes(share: string, names: readonly string[], log: Logger): Promise<boolean> {
  if (names.length === 0) return false;
  try {
    const info = await infoDir(share);
    if (info === null) return false;
    const path = join(info, 'exclude');
    const st = await lstat(path).catch(() => null);
    if (st !== null && !st.isFile()) return false;
    const text = st === null ? '' : await readFile(path, 'utf8');
    const { rest, names: listed } = splitBlock(text);
    const all = [...new Set([...listed, ...names])].filter((name) => PLACEHOLDER_NAMES.has(name)).sort();
    if (listed.length === all.length && all.every((name, i) => listed[i] === name) && text !== rest) return true;
    const temp = join(info, `exclude.smurg-${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, st === null ? 0o644 : st.mode & 0o777);
    try {
      await handle.writeFile(withBlock(rest, all), 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temp, path).catch(async (err: unknown) => {
      await unlink(temp).catch(() => {});
      throw err;
    });
    return true;
  } catch (err) {
    log.warn('could not list the sandbox placeholders in .git/info/exclude', { error: (err as NodeJS.ErrnoException)?.code ?? 'unknown' });
    return false;
  }
}

/**
 * Removes this service's block from the share's `.git/info/exclude` (synchronously: the service removes its
 * placeholders in the same turn). Nothing when there is none.
 */
export function removePlaceholderExcludes(share: string, log: Logger): void {
  const path = join(share, '.git', 'info', 'exclude');
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return;
    const text = readFileSync(path, 'utf8');
    const { rest } = splitBlock(text);
    if (rest === text) return;
    const temp = join(share, '.git', 'info', `exclude.smurg-${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, st.mode & 0o777);
    try {
      writeSync(fd, rest);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, path);
    } catch (err) {
      try {
        unlinkSync(temp);
      } catch {
        // gone
      }
      throw err;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
    if (code !== 'ENOENT' && code !== 'ENOTDIR') log.warn('could not remove the sandbox placeholders from .git/info/exclude', { error: code });
  }
}
