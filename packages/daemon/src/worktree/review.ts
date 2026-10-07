// What the host reviews before a merge (R9: the host sees the complete diff; ARCHITECTURE §5.7): the complete file list, the
// unified diff (cut at a file boundary when it exceeds the message limit), one file's diff on demand, and the policy
// every merge request not made by the host must pass. All of it runs on the MAIN repository, on fixed object ids; nothing here
// reads the worktree's files, so a symlink in a worktree is only ever a git object here, never followed.
//
// Every member reads these diffs (protocol 4: a result report shows its changes). They are made from git objects, past
// PathGuard, so two things PathGuard and the conversation do elsewhere are done here: a file on a host-private path is
// withheld from everyone but the host (listed as hidden, absent from the diff text), and every diff text passes mask().
import {
  MERGE_DIFF_MAX_BYTES,
  MERGE_FILES_MAX,
  SmurgError,
  foldRelPath,
  isHostOnlyPath,
  isHostPrivatePath,
  isSmurgDirName,
  mask,
  relPathSegments,
  topicFileKind,
  truncateToUtf8Bytes,
  type ResultInputOf,
} from '@smurg/protocol';
import { msg, type GitStep } from '@smurg/protocol/i18n';
import { firstLine, listedPaths, requireOk, type GitRunner } from './git.ts';
import { cutAtFileBoundary, diffText, parseNumstat, parseRawDiff, type GitPath, type RawDiffEntry } from './git-parse.ts';

type MergeDiffFile = ResultInputOf<'worktree.merge.diff'>['files'][number];

/** The complete change list of a request, with what git needs to show one file again. */
export interface ReviewFile {
  readonly file: MergeDiffFile;
  readonly path: GitPath;
  readonly oldPath?: GitPath;
  readonly raw: RawDiffEntry;
}

export interface ReviewLimits {
  /** Bound on git's machine output for the file list (raw + numstat each). */
  readonly listOutputBytes: number;
  /** Sum of path lengths in one file list (a message must fit the envelope). */
  readonly listPathBytes: number;
  readonly timeoutMs: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = Object.freeze({
  listOutputBytes: 16 * 1024 * 1024,
  listPathBytes: 4 * 1024 * 1024,
  timeoutMs: 120_000,
});

export interface MainRepo {
  readonly git: GitRunner;
  /** realpath of <share>/.git */
  readonly gitDir: string;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function oidOrThrow(value: string, step: GitStep): string {
  if (!OID.test(value)) throw new SmurgError('internal', msg('git.objectUnreadable', { step }), { reason: 'git-output-unparsable', step });
  return value;
}

/** The commit HEAD of the main workspace points at; null when the repository has no commit yet. */
export async function mainHead(repo: MainRepo): Promise<string | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code !== 0) return null;
  return oidOrThrow(firstLine(result), 'readCommit');
}

export async function commitExists(repo: MainRepo, commit: string): Promise<boolean> {
  if (!OID.test(commit)) return false;
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['cat-file', '-e', `${commit}^{commit}`], readOnly: true, maxStdoutBytes: 1024 });
  return result.code === 0;
}

/** Where the request's changes start: merge-base(main, commit). Unrelated histories cannot be merged: refused. */
export async function reviewBase(repo: MainRepo, mainCommit: string, commit: string): Promise<string> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['merge-base', mainCommit, commit], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code === 1) throw new SmurgError('conflict', msg('merge.unrelatedHistories'), { reason: 'unrelated-histories' });
  requireOk(result, 'mergeBase');
  return oidOrThrow(firstLine(result), 'mergeBase');
}

/** The complete file list of `base..commit` (renames detected), at most MERGE_FILES_MAX files. */
export async function reviewFiles(repo: MainRepo, base: string, commit: string, limits: ReviewLimits = DEFAULT_REVIEW_LIMITS): Promise<ReviewFile[]> {
  const common = { gitDir: repo.gitDir, readOnly: true, maxStdoutBytes: limits.listOutputBytes, timeoutMs: limits.timeoutMs } as const;
  const raw = requireOk(await repo.git.run({ ...common, args: ['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', base, commit] }), 'listChanges');
  const entries = parseRawDiff(raw.stdout);
  if (entries.length > MERGE_FILES_MAX) {
    throw new SmurgError('too_large', msg('merge.tooManyFiles', { max: MERGE_FILES_MAX }), { reason: 'too-many-files', count: entries.length });
  }
  const numstat = requireOk(await repo.git.run({ ...common, args: ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', base, commit] }), 'countLines');
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const entry of parseNumstat(numstat.stdout)) counts.set(`${entry.oldPath?.raw ?? ''}\u0000${entry.path.raw}`, entry);
  let pathBytes = 0;
  const files: ReviewFile[] = [];
  for (const entry of entries) {
    pathBytes += Buffer.byteLength(entry.path.raw) + Buffer.byteLength(entry.oldPath?.raw ?? '');
    if (pathBytes > limits.listPathBytes) throw new SmurgError('too_large', msg('merge.fileListTooLarge'), { reason: 'file-list-too-large' });
    const count = counts.get(`${entry.oldPath?.raw ?? ''}\u0000${entry.path.raw}`) ?? counts.get(`\u0000${entry.path.raw}`);
    const binary = count !== undefined && count.additions === null;
    const file: MergeDiffFile = {
      path: entry.path.path,
      status: entry.status,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      ...(entry.oldPath ? { oldPath: entry.oldPath.path } : {}),
      ...(binary ? { binary: true } : {}),
    };
    files.push({ file, path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), raw: entry });
  }
  return files;
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'] as const;

/** The unified diff of `base..commit`, cut at a file boundary to fit MERGE_DIFF_MAX_BYTES (`truncated`). */
export async function unifiedDiff(repo: MainRepo, base: string, commit: string, timeoutMs: number): Promise<{ diff: string; truncated: boolean }> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: [...DIFF_ARGS, base, commit], readOnly: true, maxStdoutBytes: MERGE_DIFF_MAX_BYTES + 1, timeoutMs });
  if (!result.truncated) requireOk(result, 'diff');
  return fitDiff(result.stdout, result.truncated);
}

/**
 * Whether a file of a request is withheld from everyone but the host: it lies on a host-private path (`.envrc`,
 * `.claude/settings.local.json`, `CLAUDE.local.md`, inside a `.git`) under its new or its old name. PathGuard keeps
 * such a file from every other member through file.*; a diff made from git objects must not hand it out instead.
 */
export function isWithheldFile(file: MergeDiffFile): boolean {
  return isHostPrivatePath(file.path) || (file.oldPath !== undefined && isHostPrivatePath(file.oldPath));
}

/** How a withheld file is listed: its name and status, no counts, `hidden`. */
export function withheldEntry(file: MergeDiffFile): MergeDiffFile {
  return { path: file.path, status: file.status, additions: 0, deletions: 0, ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}), hidden: true };
}

const GROUP_MAX_PATHS = 200;
const GROUP_MAX_PATH_BYTES = 96 * 1024;

/** `files` as pathspec groups one git command line can carry; both names of a rename stay in one group. */
function pathGroups(files: readonly ReviewFile[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const names = file.oldPath ? [file.oldPath.raw, file.path.raw] : [file.path.raw];
    const size = names.reduce((sum, name) => sum + Buffer.byteLength(name) + 1, 0);
    if (group.length > 0 && (group.length + names.length > GROUP_MAX_PATHS || bytes + size > GROUP_MAX_PATH_BYTES)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(...names);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/**
 * The unified diff of exactly `files` (the list of a request minus what is withheld from this reader), in the list's
 * order, cut like unifiedDiff. Each file is named to git as a literal path after `--` (GIT_LITERAL_PATHSPECS), so
 * nothing outside the list can appear, whatever a file is called.
 */
export async function unifiedDiffOfFiles(repo: MainRepo, base: string, commit: string, files: readonly ReviewFile[], timeoutMs: number): Promise<{ diff: string; truncated: boolean }> {
  const parts: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (const group of pathGroups(files)) {
    const result = await repo.git.run({ gitDir: repo.gitDir, args: [...DIFF_ARGS, base, commit, '--', ...group], readOnly: true, maxStdoutBytes: MERGE_DIFF_MAX_BYTES + 1 - total, timeoutMs });
    if (!result.truncated) requireOk(result, 'diff');
    parts.push(result.stdout);
    total += result.stdout.length;
    if (result.truncated || total > MERGE_DIFF_MAX_BYTES) {
      truncated = true;
      break;
    }
  }
  return fitDiff(Buffer.concat(parts), truncated);
}

/** One file of the list (a rename shows both names), cut at MERGE_DIFF_MAX_BYTES. */
export async function singleFileDiff(repo: MainRepo, base: string, commit: string, file: ReviewFile, timeoutMs: number): Promise<{ diff: string; truncated: boolean }> {
  const paths = file.oldPath ? [file.oldPath.raw, file.path.raw] : [file.path.raw];
  // GIT_LITERAL_PATHSPECS (git.ts) makes these plain names, and `--` ends the options: a name can be neither.
  const result = await repo.git.run({ gitDir: repo.gitDir, args: [...DIFF_ARGS, base, commit, '--', ...paths], readOnly: true, maxStdoutBytes: MERGE_DIFF_MAX_BYTES + 1, timeoutMs });
  if (!result.truncated) requireOk(result, 'diff');
  const bytes = result.stdout;
  const truncated = result.truncated || bytes.length > MERGE_DIFF_MAX_BYTES;
  return finishText(bytes.subarray(0, Math.min(bytes.length, MERGE_DIFF_MAX_BYTES)), truncated);
}

function fitDiff(bytes: Buffer, truncatedByGit: boolean): { diff: string; truncated: boolean } {
  if (!truncatedByGit && bytes.length <= MERGE_DIFF_MAX_BYTES) return finishText(bytes, false);
  return finishText(bytes.subarray(0, cutAtFileBoundary(bytes, MERGE_DIFF_MAX_BYTES)), true);
}

function finishText(bytes: Uint8Array, truncated: boolean): { diff: string; truncated: boolean } {
  return maskedDiffText(bytes, MERGE_DIFF_MAX_BYTES, truncated);
}

/**
 * Diff bytes as the text a message carries: decoded, through mask() (what looks like a credential never leaves in a
 * diff), then fitted to `maxBytes`. Invalid bytes become U+FFFD (3 bytes each) and a masked value can be longer than
 * what it replaces, so the text can outgrow the byte limit it was cut at: it is cut again, and says so.
 */
export function maskedDiffText(bytes: Uint8Array, maxBytes: number, truncated: boolean): { diff: string; truncated: boolean } {
  const text = mask(diffText(bytes));
  const fitted = truncateToUtf8Bytes(text, maxBytes);
  return { diff: fitted, truncated: truncated || fitted.length !== text.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------------------------

/**
 * Whether a symlink at `linkPath` with `target` may lead outside the repository, or onto what only the host may touch.
 * Merged into the main workspace, such a link would hand the host's unsandboxed tools (its Claude Code's Read / Edit
 * follow links) a name for a file the guest chose.
 *
 * Decided on the text alone, conservatively, because a name in the target can be (or later become) a symlink itself
 *: `b -> ../..` names the root, and `a -> b/../x` then climbs ABOVE it, although "b/.." cancels out
 * lexically. So the target may climb with `..` only at its start (through the link's own parent directories, which
 * are directories of the same tree), never after a name; it may not climb above the root; and it may not end on a
 * host-only path (`.git`, `.claude`, …, ARCHITECTURE §5.2) or in `.smurg`.
 */
export function symlinkEscapes(linkPath: string, target: string): boolean {
  if (target.length === 0 || target.includes('\u0000') || target.startsWith('/') || target.includes('\\')) return true;
  const stack = relPathSegments(linkPath).slice(0, -1);
  let descended = false;
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (descended || stack.length === 0) return true;
      stack.pop();
    } else {
      descended = true;
      stack.push(segment);
    }
  }
  const resolved = stack.join('/');
  if (resolved === '') return false; // the root itself
  return isSmurgDirName(stack[0] ?? '') || isHostOnlyPath(resolved);
}

const SYMLINK_MODE = '120000';
const MAX_SYMLINKS_CHECKED = 2_000;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Targets of the symlinks a change list adds or changes (one `git cat-file --batch`). */
async function symlinkTargets(repo: MainRepo, files: readonly ReviewFile[], timeoutMs: number): Promise<Map<string, string | null>> {
  const links = files.filter((entry) => entry.raw.dstMode === SYMLINK_MODE && entry.file.status !== 'deleted');
  const targets = new Map<string, string | null>();
  if (links.length === 0) return targets;
  if (links.length > MAX_SYMLINKS_CHECKED) throw new SmurgError('too_large', msg('merge.tooManySymlinks'), { reason: 'too-many-symlinks' });
  const input = `${links.map((entry) => entry.raw.dstOid).join('\n')}\n`;
  const result = requireOk(
    await repo.git.run({ gitDir: repo.gitDir, args: ['cat-file', '--batch'], input, readOnly: true, maxStdoutBytes: links.length * 8_192 + 65_536, timeoutMs }),
    'readSymlinks',
  );
  const out = result.stdout;
  let at = 0;
  for (const entry of links) {
    const lineEnd = out.indexOf(0x0a, at);
    const header = lineEnd === -1 ? '' : out.subarray(at, lineEnd).toString('latin1');
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.raw.dstOid) {
      targets.set(entry.file.path, null);
      break;
    }
    const size = Number(match[2]);
    const body = out.subarray(lineEnd + 1, lineEnd + 1 + size);
    let target: string | null;
    try {
      target = STRICT_UTF8.decode(body);
    } catch {
      target = null;
    }
    targets.set(entry.file.path, size > 4_096 ? null : target);
    at = lineEnd + 1 + size + 1;
  }
  for (const entry of links) if (!targets.has(entry.file.path)) targets.set(entry.file.path, null);
  return targets;
}

export interface PolicyViolation {
  readonly reason: 'daemon-dir' | 'host-only-paths' | 'spec-files' | 'unsafe-symlink';
  readonly paths: string[];
}

export interface MergePolicyOptions {
  /** A request the host made (and reviews and merges): only the daemon's own directory is refused. */
  readonly requesterIsHost: boolean;
  /** The changes of a work item of this topic: they may not touch the topic's SPEC.md or PLAN.md. */
  readonly topicSlug?: string;
  /**
   * Root-relative files the trust gate records (the scripts a host-confirmed project hook runs:
   * ProjectTrust.protectedPaths): host-only for writes like the lexical host-only paths, so for a merge too.
   */
  readonly recorded?: ReadonlySet<string>;
  readonly timeoutMs: number;
}

/**
 * What a merge request may not carry into the main workspace (fail closed):
 *  - anything under `<share>/.smurg` (the daemon's directory: other worktrees, partial uploads) — for everyone;
 *  - host-only paths of ARCHITECTURE §5.2 (`.claude/`, `.mcp.json`, `.envrc`, `.vscode/`, `CLAUDE.md`, …, at any
 *    depth) and the scripts the trust gate records, unless the requester is the host: the host's unsandboxed agent
 *    loads them or runs them from a confirmed hook, so a merge must not do what file.* refuses;
 *  - a work item's changes to its topic's `SPEC.md` or `PLAN.md`, unless the requester is the host: every other item
 *    starts from exactly the two files a member confirmed in the Start dialog (ARCHITECTURE §5.10), and no execution
 *    agent edits them;
 *  - symlinks that point outside the repository, unless the requester is the host.
 */
export async function checkMergePolicy(repo: MainRepo, files: readonly ReviewFile[], options: MergePolicyOptions): Promise<PolicyViolation | null> {
  const names = (entry: ReviewFile): string[] => [entry.file.path, ...(entry.file.oldPath !== undefined ? [entry.file.oldPath] : [])];
  const daemonDir = files.flatMap(names).filter((path) => isSmurgDirName(relPathSegments(path)[0] ?? ''));
  if (daemonDir.length > 0) return { reason: 'daemon-dir', paths: daemonDir };
  if (options.requesterIsHost) return null;
  const recorded = new Set([...(options.recorded ?? [])].map(foldRelPath));
  const hostOnly = files.flatMap(names).filter((path) => isHostOnlyPath(path) || (recorded.size > 0 && recorded.has(foldRelPath(path))));
  if (hostOnly.length > 0) return { reason: 'host-only-paths', paths: hostOnly };
  const topicSlug = options.topicSlug;
  if (topicSlug !== undefined) {
    const specFiles = files.flatMap(names).filter((path) => topicFileKind(path, topicSlug) !== null);
    if (specFiles.length > 0) return { reason: 'spec-files', paths: specFiles };
  }
  const targets = await symlinkTargets(repo, files, options.timeoutMs);
  const unsafe = [...targets.entries()].filter(([path, target]) => target === null || symlinkEscapes(path, target)).map(([path]) => path);
  if (unsafe.length > 0) return { reason: 'unsafe-symlink', paths: unsafe };
  return null;
}

export function policyError(violation: PolicyViolation): SmurgError {
  const sample = violation.paths.slice(0, 20);
  const paths = listedPaths(violation.paths);
  switch (violation.reason) {
    case 'daemon-dir':
      return new SmurgError('host_only', msg('merge.containsSmurgDir', { paths }), { reason: 'daemon-dir', paths: sample, count: violation.paths.length });
    case 'host-only-paths':
      return new SmurgError('host_only', msg('merge.containsHostOnly', { paths }), { reason: 'host-only-paths', paths: sample, count: violation.paths.length });
    case 'spec-files':
      return new SmurgError('host_only', msg('report.changes.specFiles'), { reason: 'spec-files', paths: sample, count: violation.paths.length });
    case 'unsafe-symlink':
      return new SmurgError('conflict', msg('merge.unsafeSymlinks', { paths }), { reason: 'unsafe-symlink', paths: sample, count: violation.paths.length });
  }
}
