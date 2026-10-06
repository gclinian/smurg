// Names the worktree module gives to things on disk and in git. Pure functions.
import { randomBytes } from 'node:crypto';
import { ITEM_ID_PATTERN, TOPIC_SLUG_PATTERN } from '@smurg/protocol';
import type { GitIdentity } from './git.ts';
import { MERGE_ID_PATTERN, WORKTREE_ID_PATTERN } from './store.ts';

/**
 * `wt_<24 hex>`: lowercase hex, because the id is a directory name (`.smurg/worktrees/<id>`) and APFS is
 * case-insensitive; the protocol's random base64url ids could collide there by case alone (ARCHITECTURE §7.1).
 */
export function newWorktreeId(): string {
  const id = `wt_${randomBytes(12).toString('hex')}`;
  if (!WORKTREE_ID_PATTERN.test(id)) throw new Error('worktree id pattern');
  return id;
}

/** `mr_<24 hex>`: the id is a loose ref file (`refs/smurg/merge/<id>`), lowercase for the same reason. */
export function newMergeId(): string {
  const id = `mr_${randomBytes(12).toString('hex')}`;
  if (!MERGE_ID_PATTERN.test(id)) throw new Error('merge id pattern');
  return id;
}

/**
 * A git-ref-safe, readable component from a user id (`github:123` → `github-123`, `dev:amy` → `dev-amy`). Only for
 * display in branch names: uniqueness comes from the worktree id next to it.
 */
export function ownerSlug(userId: string): string {
  const slug = userId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 40)
    .replace(/[.-]+$/, '')
    .replace(/\.lock$/i, '');
  return slug.length > 0 ? slug : 'user';
}

const BRANCH_PATTERN = /^smurg\/[A-Za-z0-9_][A-Za-z0-9._-]{0,39}\/wt_[0-9a-f]{24}$/;

/** `smurg/<owner>/<id>` (ARCHITECTURE §5.7), validated against git's ref-name rules we rely on. */
export function worktreeBranch(ownerUserId: string, worktreeId: string): string {
  const branch = `smurg/${ownerSlug(ownerUserId)}/${worktreeId}`;
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || /\.lock(\/|$)/.test(branch)) throw new Error('unsafe branch name');
  return branch;
}

/**
 * `smurg/<topic slug>/<item id>`: the branch of a work item's worktree (ARCHITECTURE §5.10). Both parts are the
 * protocol's patterns (lowercase letters, digits and hyphens, starting with a letter or digit), which are valid ref
 * components as they are; anything else is refused, never repaired.
 */
export function itemBranch(topicSlug: string, itemId: string): string {
  if (!TOPIC_SLUG_PATTERN.test(topicSlug) || !ITEM_ID_PATTERN.test(itemId)) throw new Error('unsafe branch name');
  return `smurg/${topicSlug}/${itemId}`;
}

export function mergeRef(requestId: string): string {
  if (!MERGE_ID_PATTERN.test(requestId)) throw new Error('unsafe merge ref');
  return `refs/smurg/merge/${requestId}`;
}

// What git strips from both ends of a name ("crud", ident.c): a name made only of these is refused ("name consists
// only of disallowed characters"), and the commit with it.
const GIT_CRUD = /^[\u0000-\u0020.,:;<>"\\']+|[\u0000-\u0020.,:;<>"\\']+$/g;

/** Author / committer of commits the daemon writes for a member (git refuses `<`, `>` and newlines in names). */
export function gitIdentity(userId: string, displayName: string): GitIdentity {
  const cleaned = displayName.replace(/[<>\n\r]/g, ' ').trim();
  const name = cleaned.replace(GIT_CRUD, '').length > 0 ? cleaned : ownerSlug(userId);
  return { name, email: `${ownerSlug(userId)}@users.smurg.invalid` };
}

/** An anchored .git/info/exclude pattern that matches exactly `path` (a symlink: no trailing slash). */
export function excludePattern(path: string): string {
  const escaped = path.replace(/[*?[\]\\!#]/g, (char) => `\\${char}`).replace(/ $/, '\\ ');
  return `/${escaped}`;
}
