// Preparing the shared folder (ARCHITECTURE §7.1): inside it the daemon creates only `.smurg/` and adds `.smurg/` to
// `.git/info/exclude` (never the user's .gitignore). It also refuses share locations that would expose the daemon's
// own secrets or the whole home directory to guests: ~/.smurg must stay outside the shared folder (§2 rule 3).
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isInside, lstatOrNull } from './fs-util.ts';

export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareError';
  }
}

/** Where the accounts' home directories live (macOS, Linux). */
export const HOMES_PARENTS: readonly string[] = Object.freeze(['/Users', '/home', '/root', '/var/root']);

export interface PreparedShare {
  readonly realPath: string;
  readonly name: string;
  readonly isGitRepo: boolean;
}

/**
 * Validates the share location against the state dir and the home directory, creates `<share>/.smurg` (0700) and
 * the git exclude entry. `homeDir` is injectable so tests never depend on the real home.
 */
export async function prepareShare(
  shareDir: string,
  stateDir: string,
  options: { readonly homeDir?: string; /** TEST ONLY: default HOMES_PARENTS. */ readonly homesParents?: readonly string[] } = {},
): Promise<PreparedShare> {
  const share = await realpath(shareDir).catch(() => {
    throw new ShareError('the shared folder does not exist');
  });
  if (!(await lstat(share)).isDirectory()) throw new ShareError('the shared folder is not a directory');
  if (share === '/') throw new ShareError('the file system root cannot be shared');
  const home = await realpath(options.homeDir ?? homedir()).catch(() => null);
  if (home !== null && share === home) throw new ShareError('the whole home directory cannot be shared');
  // A folder that CONTAINS the home (review CLI-04: /Users, the parent of a fake home) would hand every guest ~/.ssh,
  // ~/.aws, ~/.claude …; PathGuard allows everything inside the share. Refused whatever SMURG_HOME is.
  if (home !== null && isInside(home, share)) throw new ShareError('a folder that contains the home directory cannot be shared');
  // Nor the parent of everybody's homes (other accounts on this machine), even when the host's own home is elsewhere.
  for (const homes of options.homesParents ?? HOMES_PARENTS) {
    const real = await realpath(homes).catch(() => null);
    if (real !== null && isInside(real, share)) throw new ShareError('a folder that contains the home directories cannot be shared');
  }
  const state = await realpath(stateDir).catch(() => stateDir);
  if (isInside(state, share)) throw new ShareError('the daemon state directory must not be inside the shared folder');
  if (isInside(share, state)) throw new ShareError('the shared folder must not be inside the daemon state directory');

  const smurgDir = join(share, '.smurg');
  const existing = await lstatOrNull(smurgDir);
  if (existing === null) await mkdir(smurgDir, { mode: 0o700 });
  else if (existing === 'not-directory' || !existing.isDirectory()) throw new ShareError('.smurg in the shared folder is not a directory');

  const git = await lstatOrNull(join(share, '.git'));
  const isGitRepo = git !== null && git !== 'not-directory' && (git.isDirectory() || git.isFile());
  if (git !== null && git !== 'not-directory' && git.isDirectory()) await excludeSmurgDir(join(share, '.git'));
  return { realPath: share, name: basename(share) || share, isGitRepo };
}

const EXCLUDE_LINE = '/.smurg/';

/** Appends `/.smurg/` to .git/info/exclude unless an equivalent line is there. Never follows a symlink. */
async function excludeSmurgDir(gitDir: string): Promise<void> {
  const infoDir = join(gitDir, 'info');
  const info = await lstatOrNull(infoDir);
  if (info === null) await mkdir(infoDir, { mode: 0o755 });
  else if (info === 'not-directory' || !info.isDirectory()) return;
  const excludePath = join(infoDir, 'exclude');
  const st = await lstatOrNull(excludePath);
  if (st !== null && (st === 'not-directory' || !st.isFile())) return;
  if (st !== null) {
    const text = await readFile(excludePath, 'utf8');
    if (text.split(/\r?\n/).some((line) => ['.smurg', '.smurg/', '/.smurg', '/.smurg/'].includes(line.trim()))) return;
  }
  const handle = await open(excludePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o644);
  try {
    const prefix = st !== null && st.size > 0 ? '\n' : '';
    await handle.appendFile(`${prefix}# smurg: daemon-owned directory (worktrees, staging)\n${EXCLUDE_LINE}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}
