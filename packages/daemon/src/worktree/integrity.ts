// Before the daemon runs git inside a worktree it checks that the clone's git directory is still the one it made.
// The worktree is written by the sessions running in it (PathGuard makes .git host-only for members, but a session's
// agent or shell can write anything there, so the daemon does not rely on it): a tampered repository could
// otherwise make the DAEMON run code through repository config (core.fsmonitor, filter/diff/merge drivers,
// core.alternateRefsCommand, include.path) or redirect it to another repository (a .git symlink, `commondir`,
// alternates). Fail closed: any difference refuses the operation.
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';

/** Files of the clone's git dir the daemon pins by content. */
export const PINNED_GIT_FILES = Object.freeze({ config: 'config', head: 'HEAD', alternates: join('objects', 'info', 'alternates') });

/** Files whose mere presence would redirect the repository or add config (linked-worktree machinery). */
const FORBIDDEN_GIT_ENTRIES = ['commondir', 'gitdir', 'config.worktree'];

const MAX_PINNED_BYTES = 64 * 1024;

export class WorktreeTamperedError extends SmurgError {
  constructor(problem: string) {
    super('conflict', msg('worktree.tampered'), { reason: 'worktree-tampered', problem });
    this.name = 'WorktreeTamperedError';
  }
}

/** Reads a small regular file without following a symlink; null when missing. */
async function readPinned(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WorktreeTamperedError('unreadable');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_PINNED_BYTES) throw new WorktreeTamperedError('not-a-plain-file');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface PinnedHashes {
  readonly configHash: string;
  readonly headHash: string;
  readonly alternatesHash: string;
}

/** Hashes of the pinned files as they are now (after the daemon set the clone up). */
export async function pinnedHashes(gitDir: string): Promise<PinnedHashes> {
  const hashOf = async (name: string): Promise<string> => {
    const bytes = await readPinned(join(gitDir, name));
    if (bytes === null) throw new WorktreeTamperedError(`missing-${name}`);
    return sha256Hex(bytes);
  };
  return {
    configHash: await hashOf(PINNED_GIT_FILES.config),
    headHash: await hashOf(PINNED_GIT_FILES.head),
    alternatesHash: await hashOf(PINNED_GIT_FILES.alternates),
  };
}

/**
 * Throws WorktreeTamperedError unless `<dir>` is a real directory at exactly `dir`, `<dir>/.git` a real directory
 * (not a symlink, not a gitfile), the pinned files unchanged, and nothing that redirects the repository present.
 */
export async function verifyWorktreeRepo(dir: string, expected: PinnedHashes): Promise<void> {
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory()) throw new WorktreeTamperedError('worktree-missing');
  if ((await realpath(dir).catch(() => null)) !== dir) throw new WorktreeTamperedError('worktree-moved');
  const gitDir = join(dir, '.git');
  const gitStat = await lstat(gitDir).catch(() => null);
  if (gitStat === null || !gitStat.isDirectory()) throw new WorktreeTamperedError('git-dir-replaced');
  if ((await realpath(gitDir).catch(() => null)) !== gitDir) throw new WorktreeTamperedError('git-dir-moved');
  for (const entry of FORBIDDEN_GIT_ENTRIES) {
    if ((await lstat(join(gitDir, entry)).catch(() => null)) !== null) throw new WorktreeTamperedError(`unexpected-${entry.replaceAll('/', '-')}`);
  }
  const now = await pinnedHashes(gitDir);
  if (now.configHash !== expected.configHash) throw new WorktreeTamperedError('config-changed');
  if (now.headHash !== expected.headHash) throw new WorktreeTamperedError('head-changed');
  if (now.alternatesHash !== expected.alternatesHash) throw new WorktreeTamperedError('alternates-changed');
}

// ---------------------------------------------------------------------------------------------------------------------
// smurg's own history of a folder without `.git` (DESIGN 0.6.0 D14, hidden-repo.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Entries of smurg's own history whose mere presence redirects it, adds config or rewrites what its history says. */
const FORBIDDEN_HIDDEN_ENTRIES = [
  'commondir',
  'gitdir',
  'config.worktree',
  join('info', 'attributes'),
  join('info', 'grafts'),
  'shallow',
  join('objects', 'info', 'alternates'),
  join('objects', 'info', 'http-alternates'),
];

/** The hashes of smurg's own history as smurg made it (worktrees.json `hidden`). */
export interface HiddenRepoHashes {
  readonly configHash: string;
  readonly headHash: string;
}

function hiddenRepoChanged(problem: string): SmurgError {
  return new SmurgError('conflict', msg('worktree.hidden.changed'), { reason: 'hidden-repo-changed', problem });
}

/** Hashes of `config` and `HEAD` of a history smurg just made. */
export async function hiddenRepoHashes(gitDir: string): Promise<HiddenRepoHashes> {
  const hashOf = async (name: string): Promise<string> => {
    let bytes: Buffer | null;
    try {
      bytes = await readPinned(join(gitDir, name));
    } catch {
      throw hiddenRepoChanged(`${name}-not-a-plain-file`);
    }
    if (bytes === null) throw hiddenRepoChanged(`missing-${name}`);
    return sha256Hex(bytes);
  };
  return { configHash: await hashOf('config'), headHash: await hashOf('HEAD') };
}

/**
 * Before every command on smurg's own history (DESIGN 0.6.0 D14 "Integrity"): `gitDir` is a real directory at exactly
 * that path (no link on the way), `config` and `HEAD` are plain files with the recorded hashes (HEAD is the symbolic ref
 * smurg never changes), nothing redirects it or rewrites what its history says (linked-worktree files, attributes,
 * grafts, `shallow`, alternates, replace refs, loose or packed). Throws `worktree.hidden.changed` otherwise (fail closed).
 */
export async function verifyHiddenRepo(gitDir: string, expected: HiddenRepoHashes): Promise<void> {
  const st = await lstat(gitDir).catch(() => null);
  if (st === null || !st.isDirectory()) throw hiddenRepoChanged('not-a-directory');
  if ((await realpath(gitDir).catch(() => null)) !== gitDir) throw hiddenRepoChanged('moved');
  for (const entry of FORBIDDEN_HIDDEN_ENTRIES) {
    if ((await lstat(join(gitDir, entry)).catch(() => null)) !== null) throw hiddenRepoChanged(`unexpected-${entry.replaceAll('/', '-')}`);
  }
  const replace = join(gitDir, 'refs', 'replace');
  const replaceStat = await lstat(replace).catch(() => null);
  if (replaceStat !== null && (!replaceStat.isDirectory() || (await readdir(replace).catch(() => ['?'])).length > 0)) throw hiddenRepoChanged('replace-refs');
  const packed = await readPinnedLarge(join(gitDir, 'packed-refs'));
  if (packed === 'unreadable' || (packed !== null && packed.includes('refs/replace/'))) throw hiddenRepoChanged('replace-refs');
  const now = await hiddenRepoHashes(gitDir);
  if (now.configHash !== expected.configHash) throw hiddenRepoChanged('config-changed');
  if (now.headHash !== expected.headHash) throw hiddenRepoChanged('head-changed');
}

/** A plain file's text (never through a link), at most 8 MiB; null when missing. */
async function readPinnedLarge(path: string): Promise<string | null | 'unreadable'> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return 'unreadable';
    return (await handle.readFile()).toString('latin1');
  } finally {
    await handle.close();
  }
}
