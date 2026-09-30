// Before the daemon runs git inside a worktree it checks that the clone's git directory is still the one it made.
// The worktree is guest-controlled (the sandbox keeps a guest out of <worktree>/.git and PathGuard makes .git
// host-only, but the daemon itself is not sandboxed, so it does not rely on either): a tampered repository could
// otherwise make the DAEMON run code through repository config (core.fsmonitor, filter/diff/merge drivers,
// core.alternateRefsCommand, include.path) or redirect it to another repository (a .git symlink, `commondir`,
// alternates). Fail closed: any difference refuses the operation.
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError } from '@smurg/protocol';

/** Files of the clone's git dir the daemon pins by content. */
export const PINNED_GIT_FILES = Object.freeze({ config: 'config', head: 'HEAD', alternates: join('objects', 'info', 'alternates') });

/** Files whose mere presence would redirect the repository or add config (linked-worktree machinery). */
const FORBIDDEN_GIT_ENTRIES = ['commondir', 'gitdir', 'config.worktree'];

const MAX_PINNED_BYTES = 64 * 1024;

export class WorktreeTamperedError extends SmurgError {
  constructor(problem: string) {
    super('conflict', 'worktree 的 git 資料夾已被變更，為了安全已拒絕操作；請主人檢查或刪除這個 worktree', { reason: 'worktree-tampered', problem });
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
