// What the host reviews before a merge (R9 「主人看到完整 diff」, ARCHITECTURE §5.7): the complete file list, the
// unified diff (cut at a file boundary when it exceeds the message limit), one file's diff on demand, and the policy
// every merge request not made by the host must pass. All of it runs on the MAIN repository, on fixed object ids; nothing here
// reads the worktree's files, so a symlink in a worktree is only ever a git object here, never followed.
import { MERGE_DIFF_MAX_BYTES, MERGE_FILES_MAX, SmurgError, isHostOnlyPath, isSmurgDirName, relPathSegments, truncateToUtf8Bytes, type ResultInputOf } from '@smurg/protocol';
import { firstLine, requireOk, type GitRunner } from './git.ts';
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

function oidOrThrow(value: string, what: string): string {
  if (!OID.test(value)) throw new SmurgError('internal', `${what}：無法讀取 git 物件`, { reason: 'git-output-unparsable' });
  return value;
}

/** The commit HEAD of the main workspace points at; null when the repository has no commit yet. */
export async function mainHead(repo: MainRepo): Promise<string | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code !== 0) return null;
  return oidOrThrow(firstLine(result), 'HEAD');
}

export async function commitExists(repo: MainRepo, commit: string): Promise<boolean> {
  if (!OID.test(commit)) return false;
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['cat-file', '-e', `${commit}^{commit}`], readOnly: true, maxStdoutBytes: 1024 });
  return result.code === 0;
}

/** Where the request's changes start: merge-base(main, commit). Unrelated histories cannot be merged: refused. */
export async function reviewBase(repo: MainRepo, mainCommit: string, commit: string): Promise<string> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['merge-base', mainCommit, commit], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code === 1) throw new SmurgError('conflict', '這個 worktree 與主工作區沒有共同的歷史，無法合併', { reason: 'unrelated-histories' });
  requireOk(result, '找出共同祖先');
  return oidOrThrow(firstLine(result), 'merge-base');
}

/** The complete file list of `base..commit` (renames detected), at most MERGE_FILES_MAX files. */
export async function reviewFiles(repo: MainRepo, base: string, commit: string, limits: ReviewLimits = DEFAULT_REVIEW_LIMITS): Promise<ReviewFile[]> {
  const common = { gitDir: repo.gitDir, readOnly: true, maxStdoutBytes: limits.listOutputBytes, timeoutMs: limits.timeoutMs } as const;
  const raw = requireOk(await repo.git.run({ ...common, args: ['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', base, commit] }), '列出變更的檔案');
  const entries = parseRawDiff(raw.stdout);
  if (entries.length > MERGE_FILES_MAX) {
    throw new SmurgError('too_large', `變更的檔案超過 ${MERGE_FILES_MAX} 個，無法完整審核，請分成幾次合併`, { reason: 'too-many-files', count: entries.length });
  }
  const numstat = requireOk(await repo.git.run({ ...common, args: ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', base, commit] }), '計算變更行數');
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const entry of parseNumstat(numstat.stdout)) counts.set(`${entry.oldPath?.raw ?? ''}\u0000${entry.path.raw}`, entry);
  let pathBytes = 0;
  const files: ReviewFile[] = [];
  for (const entry of entries) {
    pathBytes += Buffer.byteLength(entry.path.raw) + Buffer.byteLength(entry.oldPath?.raw ?? '');
    if (pathBytes > limits.listPathBytes) throw new SmurgError('too_large', '變更的檔名總長度過大，無法完整審核', { reason: 'file-list-too-large' });
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
  if (!result.truncated) requireOk(result, '產生 diff');
  return fitDiff(result.stdout, result.truncated);
}

/** One file of the list (a rename shows both names), cut at MERGE_DIFF_MAX_BYTES. */
export async function singleFileDiff(repo: MainRepo, base: string, commit: string, file: ReviewFile, timeoutMs: number): Promise<{ diff: string; truncated: boolean }> {
  const paths = file.oldPath ? [file.oldPath.raw, file.path.raw] : [file.path.raw];
  // GIT_LITERAL_PATHSPECS (git.ts) makes these plain names, and `--` ends the options: a name can be neither.
  const result = await repo.git.run({ gitDir: repo.gitDir, args: [...DIFF_ARGS, base, commit, '--', ...paths], readOnly: true, maxStdoutBytes: MERGE_DIFF_MAX_BYTES + 1, timeoutMs });
  if (!result.truncated) requireOk(result, '產生 diff');
  const bytes = result.stdout;
  const truncated = result.truncated || bytes.length > MERGE_DIFF_MAX_BYTES;
  return finishText(bytes.subarray(0, Math.min(bytes.length, MERGE_DIFF_MAX_BYTES)), truncated);
}

function fitDiff(bytes: Buffer, truncatedByGit: boolean): { diff: string; truncated: boolean } {
  if (!truncatedByGit && bytes.length <= MERGE_DIFF_MAX_BYTES) return finishText(bytes, false);
  return finishText(bytes.subarray(0, cutAtFileBoundary(bytes, MERGE_DIFF_MAX_BYTES)), true);
}

function finishText(bytes: Uint8Array, truncated: boolean): { diff: string; truncated: boolean } {
  const text = diffText(bytes);
  // Invalid bytes become U+FFFD (3 bytes each): the text can outgrow the byte limit it was cut at.
  const fitted = truncateToUtf8Bytes(text, MERGE_DIFF_MAX_BYTES);
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
 * (review SEC-D-04): `b -> ../..` names the root, and `a -> b/../x` then climbs ABOVE it, although "b/.." cancels out
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
  if (links.length > MAX_SYMLINKS_CHECKED) throw new SmurgError('too_large', '變更中的符號連結過多，無法審核', { reason: 'too-many-symlinks' });
  const input = `${links.map((entry) => entry.raw.dstOid).join('\n')}\n`;
  const result = requireOk(
    await repo.git.run({ gitDir: repo.gitDir, args: ['cat-file', '--batch'], input, readOnly: true, maxStdoutBytes: links.length * 8_192 + 65_536, timeoutMs }),
    '讀取符號連結',
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
  readonly reason: 'daemon-dir' | 'host-only-paths' | 'unsafe-symlink';
  readonly paths: string[];
}

/**
 * What a merge request may not carry into the main workspace (fail closed):
 *  - anything under `<share>/.smurg` (the daemon's directory: other worktrees, partial uploads) — for everyone;
 *  - host-only paths of ARCHITECTURE §5.2 (`.claude/`, `.mcp.json`, `.envrc`, `.vscode/`, …, at any depth) unless
 *    the requester is the host: the host's unsandboxed agent loads them, so a merge must not do what file.* refuses;
 *  - symlinks that point outside the repository, unless the requester is the host.
 */
export async function checkMergePolicy(repo: MainRepo, files: readonly ReviewFile[], requesterIsHost: boolean, timeoutMs: number): Promise<PolicyViolation | null> {
  const names = (entry: ReviewFile): string[] => [entry.file.path, ...(entry.file.oldPath !== undefined ? [entry.file.oldPath] : [])];
  const daemonDir = files.flatMap(names).filter((path) => isSmurgDirName(relPathSegments(path)[0] ?? ''));
  if (daemonDir.length > 0) return { reason: 'daemon-dir', paths: daemonDir };
  if (requesterIsHost) return null;
  const hostOnly = files.flatMap(names).filter((path) => isHostOnlyPath(path));
  if (hostOnly.length > 0) return { reason: 'host-only-paths', paths: hostOnly };
  const targets = await symlinkTargets(repo, files, timeoutMs);
  const unsafe = [...targets.entries()].filter(([path, target]) => target === null || symlinkEscapes(path, target)).map(([path]) => path);
  if (unsafe.length > 0) return { reason: 'unsafe-symlink', paths: unsafe };
  return null;
}

export function policyError(violation: PolicyViolation): SmurgError {
  const sample = violation.paths.slice(0, 20);
  const list = sample.join('、');
  switch (violation.reason) {
    case 'daemon-dir':
      return new SmurgError('host_only', `合併內容不可以包含 .smurg 資料夾：${list}`, { reason: 'daemon-dir', paths: sample, count: violation.paths.length });
    case 'host-only-paths':
      return new SmurgError('host_only', `合併內容包含只有主人可以修改的檔案，請先移除：${list}`, { reason: 'host-only-paths', paths: sample, count: violation.paths.length });
    case 'unsafe-symlink':
      return new SmurgError('conflict', `合併內容包含指向專案外的符號連結，請先移除：${list}`, { reason: 'unsafe-symlink', paths: sample, count: violation.paths.length });
  }
}
