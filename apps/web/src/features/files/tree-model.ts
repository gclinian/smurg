// The file tree as pure data (tested without React): the visible rows of a root given which folders are expanded,
// each entry's badges (who holds it, which agent is changing it, who changed it recently, read-only), what the local
// member may do to it, and the validation of new names. Display only: the daemon enforces every rule.
import {
  checkRelPath,
  foldPathName,
  isHostOnlyPath,
  isInTopicDir,
  isRelPathWithin,
  joinRelPath,
  parentRelPath,
  rootRefEquals,
  type Actor,
  type FileEntry,
  type LockInfo,
  type RootRef,
} from '@smurg/protocol';
import { formatList, formatRelativeTime } from '../../lib/format.ts';
import { selectDir, sortEntries, type FilesState } from '../../lib/stores/files.ts';
import type { LocksState } from '../../lib/stores/locks.ts';
import type { PresenceState } from '../../lib/stores/presence.ts';
import { t } from './strings.ts';

export type TreeRowKind =
  | 'entry'
  /** An expanded folder whose listing is on its way. */
  | 'loading'
  /** An expanded folder whose listing failed. */
  | 'error'
  /** A folder with more than 10,000 entries: only the first ones are listed. */
  | 'truncated'
  | 'empty';

export interface TreeRow {
  readonly kind: TreeRowKind;
  /** The entry's path; for the other kinds the path of the folder the row belongs to. */
  readonly path: string;
  readonly entry: FileEntry | null;
  /** aria-level: 1 for the root's children. */
  readonly level: number;
  readonly expanded: boolean;
  readonly posInSet: number;
  readonly setSize: number;
  readonly error: string | null;
}

export function isFolder(entry: FileEntry | null): boolean {
  return entry?.kind === 'dir';
}

/**
 * A worktree's shared folders (D12) are symlinks to the main workspace's folders, which the daemon lists and reads
 * through; shown as the read-only folders they are, not as a dead "link" entry that opens an error tab.
 */
export function asSharedDir(entry: FileEntry, sharedDirs: ReadonlySet<string>): FileEntry {
  return entry.kind === 'symlink' && sharedDirs.has(entry.path) ? { ...entry, kind: 'dir', readOnly: true } : entry;
}

/**
 * Rows in display order: folders first, the collation of the viewer's language, children right below their expanded folder. `sharedDirs`:
 * the shared folders of the worktree shown (asSharedDir).
 */
export function flattenTree(files: FilesState, root: RootRef, expanded: ReadonlySet<string>, sharedDirs: ReadonlySet<string> = new Set()): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dirPath: string, level: number): void => {
    const listing = selectDir(files, root, dirPath);
    if (listing === undefined || (listing.status === 'loading' && listing.entries.length === 0)) {
      if (level > 1) rows.push(statusRow('loading', dirPath, level));
      return;
    }
    if (listing.status === 'error' && listing.entries.length === 0) {
      if (level > 1) rows.push({ ...statusRow('error', dirPath, level), error: listing.error });
      return;
    }
    const entries = sortEntries(sharedDirs.size === 0 ? listing.entries : listing.entries.map((entry) => asSharedDir(entry, sharedDirs)));
    if (entries.length === 0 && level > 1) rows.push(statusRow('empty', dirPath, level));
    entries.forEach((entry, index) => {
      const open = entry.kind === 'dir' && expanded.has(entry.path);
      rows.push({ kind: 'entry', path: entry.path, entry, level, expanded: open, posInSet: index + 1, setSize: entries.length, error: null });
      if (open) walk(entry.path, level + 1);
    });
    if (listing.truncated) rows.push(statusRow('truncated', dirPath, level));
  };
  walk('', 1);
  return rows;
}

function statusRow(kind: Exclude<TreeRowKind, 'entry'>, path: string, level: number): TreeRow {
  return { kind, path, entry: null, level, expanded: false, posInSet: 1, setSize: 1, error: null };
}

/** The folder a new file, an upload or a drop goes into for a row (a file's own folder; the root for none). */
export function targetDirOf(row: Pick<TreeRow, 'kind' | 'path' | 'entry'> | null): string {
  if (row === null) return '';
  if (row.kind !== 'entry') return row.path;
  if (row.entry?.kind === 'dir') return row.path;
  return parentRelPath(row.path) ?? '';
}

/** Every folder above `path` (not `path` itself), outermost first, without the root: `a/b/c` → [`a`, `a/b`]. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let parent = parentRelPath(path);
  while (parent !== null && parent !== '') {
    out.unshift(parent);
    parent = parentRelPath(parent);
  }
  return out;
}

// ---- permissions (UI hiding only)

export interface WriteContext {
  /** The role has file.write. */
  readonly canWrite: boolean;
  readonly isHost: boolean;
  /**
   * The root shown is a work item's worktree: the folder name (slug) of its topic. `specs/<slug>/` there is what the
   * agent was started from and where it writes its report: nobody changes it through smurg, the host included
   * (DESIGN §3.11; the daemon's PathGuard refuses).
   */
  readonly itemSlug?: string | undefined;
}

/** Whether `path` lies in the topic folder of the work item whose worktree is shown (read-only for everyone). */
export function isItemSpecPath(path: string, itemSlug: string | undefined): boolean {
  return itemSlug !== undefined && path !== '' && isInTopicDir(path, itemSlug);
}

/** Whether the member may change this entry (rename, delete, write into it): not for viewers, read-only entries or host-only paths. */
export function isEntryWritable(entry: FileEntry | null, path: string, ctx: WriteContext): boolean {
  if (!ctx.canWrite) return false;
  if (entry?.readOnly) return false;
  if (isItemSpecPath(path, ctx.itemSlug)) return false;
  // `.claude/`, `.git/`, `.mcp.json`, … : only the host may write them (ARCHITECTURE §5.2).
  if (!ctx.isHost && path !== '' && isHostOnlyPath(path)) return false;
  return true;
}

// ---- badges

export type BadgeKind = 'agent-lock' | 'human-lock' | 'recent' | 'read-only' | 'host-only' | 'item-spec';

export interface EntryBadge {
  readonly kind: BadgeKind;
  /** Short visible text; may be empty for icon-only badges. */
  readonly text: string;
  /** Full sentence for the tooltip / accessible name. */
  readonly label: string;
}

/** How long "recently changed" stays on an entry. */
export const RECENT_CHANGE_MS = 15 * 60_000;

export interface BadgeContext {
  /** The live lock (locks store); falls back to the entry's own when undefined. */
  readonly lock: LockInfo | null | undefined;
  readonly now: number;
  readonly selfUserId: string | null;
  readonly isHost: boolean;
  /** See WriteContext.itemSlug. */
  readonly itemSlug?: string | undefined;
}

export function actorName(actor: Actor): string {
  return actor.kind === 'system' ? t('actor.system') : actor.displayName;
}

export function entryBadges(entry: FileEntry, ctx: BadgeContext): EntryBadge[] {
  const badges: EntryBadge[] = [];
  const lock = ctx.lock === undefined ? (entry.lock ?? null) : ctx.lock;
  if (lock?.kind === 'agent') {
    badges.push({ kind: 'agent-lock', text: t('badge.agentLock', { agent: lock.agentName }), label: t('badge.agentLockLabel', { agent: lock.agentName }) });
  } else if (lock?.kind === 'human') {
    const names = lock.holders.map((holder) => (holder.userId === ctx.selfUserId ? t('badge.you') : holder.displayName));
    const joined = formatList(names);
    badges.push({ kind: 'human-lock', text: t('badge.humanLock', { names: joined }), label: t('badge.humanLockLabel', { names: joined }) });
  }
  const by = entry.lastModifiedBy;
  // Recent = mtime within RECENT_CHANGE_MS (a host clock a minute ahead still counts). Hidden while an agent holds the
  // file: the lock badge already says who is changing it.
  if (lock?.kind !== 'agent' && by !== undefined && ctx.now - entry.mtime < RECENT_CHANGE_MS && ctx.now - entry.mtime >= -60_000) {
    const name = actorName(by);
    const shown = by.kind === 'user' && by.userId === ctx.selfUserId ? t('badge.you') : name;
    badges.push({ kind: 'recent', text: shown, label: t('badge.recentLabel', { name, time: formatRelativeTime(entry.mtime, ctx.now) }) });
  }
  // A work item's own copy of the spec and the plan first (the daemon reports what is inside as readOnly too, and it
  // is no shared folder); then host-only: the daemon also reports those paths (.git, .claude, …) as readOnly to
  // guests, and calling them a shared folder told students something false.
  if (isItemSpecPath(entry.path, ctx.itemSlug)) badges.push({ kind: 'item-spec', text: '', label: t('badge.itemSpecLabel') });
  else if (!ctx.isHost && isHostOnlyPath(entry.path)) badges.push({ kind: 'host-only', text: '', label: t('badge.hostOnlyLabel') });
  else if (entry.readOnly) badges.push({ kind: 'read-only', text: '', label: t('badge.readOnlyLabel') });
  return badges;
}

// ---- names

export type NameCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string };

/**
 * Validates a new file or folder name typed into `parent` (create or rename). `siblings` are the names already there
 * (a case-insensitive match counts: the host's disk may well be APFS); `current` is the entry being renamed.
 */
export function checkNewName(name: string, parent: string, siblings: readonly string[], options: { isHost: boolean; current?: string; itemSlug?: string | undefined }): NameCheck {
  if (name.trim() === '') return { ok: false, message: t('name.empty') };
  if (name.includes('/')) return { ok: false, message: t('name.slash') };
  if (name === '.' || name === '..') return { ok: false, message: t('name.dots') };
  const check = checkRelPath(parent === '' ? name : `${parent}/${name}`);
  if (!check.ok) {
    switch (check.problem) {
      case 'control-character':
      case 'bidi-character':
      case 'lone-surrogate':
        return { ok: false, message: t('name.invisible') };
      case 'backslash':
        return { ok: false, message: t('name.backslash') };
      case 'too-long':
      case 'segment-too-long':
        return { ok: false, message: t('name.tooLong') };
      default:
        return { ok: false, message: t('name.invalid') };
    }
  }
  const path = joinRelPath(parent, name);
  if (path === null) return { ok: false, message: t('name.invalid') };
  const folded = foldPathName(name);
  const currentFolded = options.current === undefined ? null : foldPathName(options.current);
  if (siblings.some((sibling) => foldPathName(sibling) === folded && foldPathName(sibling) !== currentFolded)) return { ok: false, message: t('name.exists') };
  if (options.current !== undefined && name === options.current) return { ok: false, message: t('name.unchanged') };
  if (!options.isHost && isHostOnlyPath(path)) return { ok: false, message: t('name.hostOnly') };
  if (isItemSpecPath(path, options.itemSlug)) return { ok: false, message: t('name.itemSpec') };
  return { ok: true, path };
}

/**
 * The other people (and agents) who have `path` open or are editing it — for a folder, anything below it — so a delete
 * confirmation can name them. In daemon order, without duplicates, never the local member.
 */
export function peopleUsing(presence: PresenceState, locks: LocksState, root: RootRef, path: string, selfUserId: string | null): string[] {
  const names: string[] = [];
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  const within = (file: { root: RootRef; path: string } | undefined): boolean =>
    file !== undefined && rootRefEquals(file.root, root) && isRelPathWithin(file.path, path);
  if (locks.status === 'ready') {
    for (const lock of locks.locks.values()) {
      if (!within(lock.file)) continue;
      if (lock.kind === 'agent') add(lock.agentName);
      else for (const holder of lock.holders) if (holder.userId !== selfUserId) add(holder.displayName);
    }
  }
  for (const member of presence.members) if (member.userId !== selfUserId && member.online && within(member.activeFile)) add(member.displayName);
  for (const agent of presence.agents) if (within(agent.activeFile)) add(agent.displayName);
  return names;
}
