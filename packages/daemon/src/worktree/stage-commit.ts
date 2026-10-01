// The merge-request commit (ARCHITECTURE §5.7 "What a merge request contains"): the worktree's working tree committed
// onto its branch. The tree is written by the sessions running in it while a request is made, so `git add` can be
// raced: a directory swapped for a symlink between git's directory walk and its open() makes git read a file outside
// the worktree (`~/.ssh/id_rsa`) under a worktree name, and the merge would carry it into the host's repository.
//
// So the commit is built in a daemon-private object store with a private index (GIT_OBJECT_DIRECTORY,
// GIT_INDEX_FILE; state dir), and, for a request by anyone but the host, every blob it adds is VERIFIED against a
// careful re-read of the worktree (no symlink on the way, O_NOFOLLOW, the opened file is the one lstat saw, a single
// hard link, the same bytes). Only a verified commit is published: its objects copied into the clone, the branch
// moved (with the old value as a guard), the index installed. A lost race or a concurrent edit refuses the request
// (retry), and nothing the verification did not vouch for reaches the request the host reviews.
//
// The verification is itself a sequence of path-based checks (Node has no openat / O_BENEATH): an attacker would have
// to win the race against git AND against this re-read, whose checks bracket the open. Documented as residual risk.
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError } from '@smurg/protocol';
import { firstLine, requireOk, type GitIdentity, type GitObjectStore, type GitRunner } from './git.ts';
import { parseRawDiff, type RawDiffEntry } from './git-parse.ts';
import { WorktreeTamperedError } from './integrity.ts';

export interface StageCommitLimits {
  /** Changed entries one commit may carry (each one is verified by re-reading it). */
  readonly maxEntries: number;
  readonly timeoutMs: number;
}

export const DEFAULT_STAGE_COMMIT_LIMITS: StageCommitLimits = Object.freeze({ maxEntries: 50_000, timeoutMs: 120_000 });

export interface StageCommitInput {
  readonly git: GitRunner;
  /** realpath of the worktree (its `.git` was verified by integrity.ts just before). */
  readonly workTree: string;
  readonly branch: string;
  readonly identity: GitIdentity;
  readonly message: string;
  /** Daemon-private directory for staging stores (state dir, 0700). */
  readonly stagingRoot: string;
  /**
   * Re-read and compare every blob before publishing it. A request of the host skips it: the host reviews and merges
   * their own request anyway.
   */
  readonly verify: boolean;
  readonly limits?: Partial<StageCommitLimits>;
}

export interface StageCommitResult {
  readonly commit: string;
  /** false: nothing to commit, `commit` is the branch head as it was. */
  readonly created: boolean;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The worktree changed while it was being committed (an edit, or a lost race): the request can simply be repeated. */
export class WorktreeChangedError extends SmurgError {
  constructor(path: string | null) {
    super('conflict', 'worktree 在提交變更時又被修改了，請稍後再提出一次合併請求', { reason: 'worktree-changed', ...(path !== null ? { path } : {}) });
    this.name = 'WorktreeChangedError';
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return null;
    throw err;
  }
}

/** git's object id of a blob: sha1 or sha256 (by the length of the expected id) of `blob <size>\0<bytes>`. */
function blobHasher(oid: string, size: number): ReturnType<typeof createHash> {
  const hash = createHash(oid.length === 40 ? 'sha1' : 'sha256');
  hash.update(`blob ${size}\0`);
  return hash;
}

/** Every directory from the worktree down to `segments` must be a real directory (no symlink on the way). */
async function assertPlainDirs(root: string, segments: readonly string[], rel: string): Promise<void> {
  let at = root;
  for (const segment of segments) {
    at = join(at, segment);
    const st = await lstatOrNull(at);
    if (st === null || !st.isDirectory()) throw new WorktreeChangedError(rel);
  }
}

const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** A regular file at `rel` whose bytes hash to `oid`, read without following any link, with a single hard link. */
export async function verifyBlobFile(root: string, rel: string, oid: string): Promise<void> {
  const segments = rel.split('/');
  const full = join(root, ...segments);
  await assertPlainDirs(root, segments.slice(0, -1), rel);
  const before = await lstatOrNull(full);
  if (before === null || !before.isFile()) throw new WorktreeChangedError(rel);
  if (before.nlink !== 1) throw hardLinkError(rel);
  let handle;
  try {
    handle = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    throw new WorktreeChangedError(rel);
  }
  let digest: string;
  try {
    const st = await handle.stat();
    if (!st.isFile() || !same(st, before)) throw new WorktreeChangedError(rel);
    if (st.nlink !== 1) throw hardLinkError(rel);
    const hash = blobHasher(oid, st.size);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > st.size) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== st.size) throw new WorktreeChangedError(rel);
    digest = hash.digest('hex');
  } finally {
    await handle.close();
  }
  await assertPlainDirs(root, segments.slice(0, -1), rel);
  const after = await lstatOrNull(full);
  if (after === null || !same(after, before)) throw new WorktreeChangedError(rel);
  if (digest !== oid) throw new WorktreeChangedError(rel);
}

/** A symlink at `rel` whose target (the blob's bytes) hashes to `oid`. */
export async function verifyBlobLink(root: string, rel: string, oid: string): Promise<void> {
  const segments = rel.split('/');
  const full = join(root, ...segments);
  await assertPlainDirs(root, segments.slice(0, -1), rel);
  const before = await lstatOrNull(full);
  if (before === null || !before.isSymbolicLink()) throw new WorktreeChangedError(rel);
  const target = await readlink(full, { encoding: 'buffer' }).catch(() => null);
  if (target === null) throw new WorktreeChangedError(rel);
  await assertPlainDirs(root, segments.slice(0, -1), rel);
  const after = await lstatOrNull(full);
  if (after === null || !same(after, before)) throw new WorktreeChangedError(rel);
  if (blobHasher(oid, target.length).update(target).digest('hex') !== oid) throw new WorktreeChangedError(rel);
}

function hardLinkError(rel: string): SmurgError {
  return new SmurgError('conflict', `worktree 中的檔案有多個硬連結，為了安全無法提交：${rel}`, { reason: 'hard-link', path: rel });
}

/** Checks every entry the staged commit adds or changes (deleted ones read nothing). */
export async function verifyStagedEntries(root: string, entries: readonly RawDiffEntry[]): Promise<void> {
  const nested: string[] = [];
  for (const entry of entries) {
    if (entry.letter === 'D') continue;
    const rel = entry.path.raw;
    switch (entry.dstMode) {
      case '100644':
      case '100755':
        await verifyBlobFile(root, rel, entry.dstOid);
        break;
      case '120000':
        await verifyBlobLink(root, rel, entry.dstOid);
        break;
      case '160000':
        nested.push(entry.path.path);
        break;
      default:
        throw new WorktreeChangedError(entry.path.path);
    }
  }
  if (nested.length > 0) {
    throw new SmurgError('conflict', `合併內容不可以包含巢狀的 git 儲存庫（submodule）：${nested.slice(0, 10).join('、')}`, {
      reason: 'nested-repository',
      paths: nested.slice(0, 20),
      count: nested.length,
    });
  }
}

/**
 * Reads a small git file of the clone without following a link (the index may be large: bounded generously), with
 * the file's mtime: a copy of the index must keep it (see stageCommit).
 */
async function readPrivateCopy(path: string, maxBytes: number): Promise<{ readonly bytes: Buffer; readonly mtimeMs: number } | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw new WorktreeTamperedError('index-unreadable');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) throw new WorktreeTamperedError('index-not-a-plain-file');
    return { bytes: await handle.readFile(), mtimeMs: st.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** A real directory at exactly `path` (created when missing). */
async function ensureRealDir(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (err) {
    if (errnoCode(err) !== 'EEXIST') throw err;
  }
  const st = await lstat(path);
  if (!st.isDirectory() || (await realpath(path)) !== path) throw new WorktreeTamperedError('objects-dir-replaced');
}

/** Pack files: the pack before its reverse index before its index (a reader finds a pack through its .idx). */
function packOrder(name: string): number {
  if (name.endsWith('.pack')) return 0;
  if (name.endsWith('.rev')) return 1;
  if (name.endsWith('.idx')) return 2;
  return 3;
}

/**
 * Copies the verified objects (loose `xx/…` and `pack/…`) into the clone's object directory. Objects are
 * content-addressed: an existing file is the same object (and the fetch into the main repository re-hashes whatever
 * it receives, so a bogus one could not reach the host's repository anyway).
 */
async function publishObjects(from: string, to: string): Promise<void> {
  if ((await realpath(to).catch(() => null)) !== to || !(await lstat(to)).isDirectory()) throw new WorktreeTamperedError('objects-dir-replaced');
  for (const sub of (await readdir(from)).sort()) {
    if (!/^(?:[0-9a-f]{2}|pack)$/.test(sub)) continue;
    const srcDir = join(from, sub);
    if (!(await lstat(srcDir)).isDirectory()) continue;
    const dstDir = join(to, sub);
    await ensureRealDir(dstDir);
    const names = (await readdir(srcDir)).sort((a, b) => packOrder(a) - packOrder(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (!/^[0-9a-f]{38}(?:[0-9a-f]{24})?$|^pack-[0-9a-f]{40,64}\.(?:pack|rev|idx)$/.test(name)) continue;
      const dst = join(dstDir, name);
      if ((await lstatOrNull(dst)) !== null) continue;
      const tmp = join(dstDir, `tmp_smurg_${randomBytes(8).toString('hex')}`);
      await copyFile(join(srcDir, name), tmp, fsConstants.COPYFILE_EXCL);
      await rename(tmp, dst);
    }
  }
}

/** Removes staging stores a stopped daemon left behind (they are the daemon's own, never shared). */
export async function sweepStaging(stagingRoot: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stagingRoot);
  } catch {
    return;
  }
  for (const name of names) if (name.startsWith('c-')) await rm(join(stagingRoot, name), { recursive: true, force: true }).catch(() => {});
}

/**
 * Commits the worktree's working tree onto `branch` as described at the top of this file. Nothing to commit is fine
 * (`created: false`). Throws WorktreeChangedError / SmurgError; the clone is untouched unless the commit was published.
 */
export async function stageCommit(input: StageCommitInput): Promise<StageCommitResult> {
  const limits = { ...DEFAULT_STAGE_COMMIT_LIMITS, ...input.limits };
  const { git, workTree } = input;
  const gitDir = join(workTree, '.git');
  const cloneObjects = join(gitDir, 'objects');
  const timeoutMs = limits.timeoutMs;
  const head = firstLine(requireOk(await git.run({ gitDir, args: ['rev-parse', '--verify', `refs/heads/${input.branch}^{commit}`], readOnly: true, timeoutMs }), '讀取 commit'));
  if (!OID.test(head)) throw new SmurgError('internal', '讀取 commit失敗', { reason: 'git-output-unparsable' });

  const stage = await mkdtemp(join(input.stagingRoot, 'c-'));
  try {
    const store: GitObjectStore = { objectDir: join(stage, 'objects'), alternates: [cloneObjects], indexFile: join(stage, 'index') };
    await mkdir(store.objectDir, { mode: 0o700 });
    // Start from the clone's index: its stat cache lets git re-read only what changed.
    const index = await readPrivateCopy(join(gitDir, 'index'), 512 * 1024 * 1024);
    if (index !== null) {
      const handle = await open(store.indexFile, 'wx', 0o600);
      try {
        await handle.writeFile(index.bytes);
      } finally {
        await handle.close();
      }
      // git's "racy clean" rule: an entry whose stat data matches is re-hashed anyway when its mtime is not older than
      // the index FILE's mtime (a file changed within the same second as the checkout, keeping its size, matches the
      // stat cache otherwise). A fresh copy would carry a new mtime and silently drop such a change from the merge
      // request: keep the original's, rounded DOWN to the second (more entries count as racy: re-hashed, never lost).
      const seconds = Math.floor(index.mtimeMs / 1000);
      await utimes(store.indexFile, seconds, seconds);
    }

    requireOk(await git.run({ gitDir, workTree, store, args: ['add', '--all'], timeoutMs }), '暫存 worktree 的變更');
    const staged = await git.run({ gitDir, workTree, store, args: ['diff', '--cached', '--quiet', '--no-ext-diff', head], timeoutMs });
    if (staged.code === 0) return { commit: head, created: false };
    if (staged.code !== 1) requireOk(staged, '檢查 worktree 的變更');
    const tree = firstLine(requireOk(await git.run({ gitDir, store, args: ['write-tree'], timeoutMs }), '提交 worktree 的變更'));
    const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
    const commit = firstLine(
      requireOk(
        await git.run({ gitDir, store, identity: input.identity, input: message, args: ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-F', '-'], timeoutMs }),
        '提交 worktree 的變更',
      ),
    );
    if (!OID.test(tree) || !OID.test(commit)) throw new SmurgError('internal', '提交 worktree 的變更失敗', { reason: 'git-output-unparsable' });

    if (input.verify) {
      const changed = requireOk(
        await git.run({ gitDir, store, args: ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', head, commit], readOnly: true, maxStdoutBytes: 64 * 1024 * 1024, timeoutMs }),
        '檢查提交的內容',
      );
      const entries = parseRawDiff(changed.stdout);
      if (entries.length > limits.maxEntries) {
        throw new SmurgError('too_large', `一次提交的變更超過 ${limits.maxEntries} 個檔案，請分成幾次`, { reason: 'too-many-files', count: entries.length });
      }
      await verifyStagedEntries(workTree, entries);
    }

    // Publish: objects, then the branch (only if nobody moved it meanwhile), then the index that matches it.
    await publishObjects(store.objectDir, cloneObjects);
    const moved = await git.run({ gitDir, args: ['update-ref', '-m', 'smurg: merge request', `refs/heads/${input.branch}`, commit, head], timeoutMs, abortable: false });
    // Only fails when the branch is no longer `head` (the host's own agent committed meanwhile): try again.
    if (moved.code !== 0) throw new WorktreeChangedError(null);
    const installed = join(gitDir, `index.smurg-${randomBytes(8).toString('hex')}.tmp`);
    await copyFile(store.indexFile, installed, fsConstants.COPYFILE_EXCL);
    // Same racy-clean rule as above: the installed index keeps the mtime git gave it (rounded down).
    const written = Math.floor((await lstat(store.indexFile)).mtimeMs / 1000);
    await utimes(installed, written, written);
    await rename(installed, join(gitDir, 'index'));
    return { commit, created: true };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
