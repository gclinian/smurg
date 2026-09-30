// FileService (ARCHITECTURE §5.2 file.* on the interactive channel; SPEC R1, R7). Every path a client names goes
// through PathGuard immediately before the disk access that uses it; a listing re-validates its directory after
// reading it; mutations run through the guarded operations of fs-ops.ts. Writes are refused with `locked` while the
// file has any lock. Mutations are audited with the actor and announced to the watcher (ChangeAttribution), which
// then emits `file.changed` with `by` set: the watcher is the single source of file.changed (ARCHITECTURE §7.3).
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FILE_CONTENT_MAX_BYTES,
  FILE_TREE_MAX_ENTRIES,
  MAIN_ROOT,
  SmurgError,
  checkRelPath,
  isHiddenTempName,
  isHostOnlyPath,
  isHostPrivatePath,
  isSmurgDirName,
  lockedError,
  type Actor,
  type FileEntry,
  type FileRef,
  type LockInfo,
  type PayloadOf,
  type ResultInputOf,
  type RootRef,
} from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import { isPathDeniedError } from '../core/errors.ts';
import type { FileIdentity, FileService, Principal, ResolveOptions, ResolvedPath } from '../core/interfaces.ts';
import { isHostPrincipal, SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { errnoCode, identityOf, lstatOrNull, realpathOrNull } from '../workspace/fs-util.ts';
import { ChangeAttribution } from './attribution.ts';
import { entryFromIdentity } from './entries.ts';
import {
  daemonOwnedError,
  deleteResolved,
  emptyTrash,
  ensureTrashDir,
  existsError,
  isDaemonOwnedPath,
  makeDirectory,
  moveResolved,
  type GuardContext,
} from './fs-ops.ts';
import { clampSummary, joinRel, looseKey, mapLimit, refLabel } from './util.ts';

/** Default window in which a watcher event is attributed to whoever announced the change (FileService contract). */
export const EXPECT_CHANGE_TTL_MS = 5_000;
/** Concurrent lstat calls while listing one directory. */
const LIST_CONCURRENCY = 32;
/** Errors of one directory entry (or one sub-directory) that leave it out of a listing instead of failing it (REL-13). */
const UNLISTABLE: ReadonlySet<string> = new Set(['ENAMETOOLONG', 'ELOOP', 'EACCES', 'EPERM']);
const HASH_READ_BYTES = 1024 * 1024;

export interface FileServiceOptions {
  /** Entries per file.tree result (default FILE_TREE_MAX_ENTRIES; tests lower it). */
  readonly treeMaxEntries?: number;
}

/** A bounded "this path was a directory" memory: a deleted path cannot be lstat'ed any more (unlink vs unlinkDir). */
export class KnownDirectories {
  private readonly keys = new Map<string, true>();
  private readonly max: number;

  constructor(max = 100_000) {
    this.max = max;
  }

  add(root: RootRef, path: string): void {
    const key = looseKey(root, path);
    this.keys.delete(key);
    this.keys.set(key, true);
    if (this.keys.size > this.max) {
      const oldest = this.keys.keys().next();
      if (!oldest.done) this.keys.delete(oldest.value);
    }
  }

  has(root: RootRef, path: string): boolean {
    return this.keys.has(looseKey(root, path));
  }

  delete(root: RootRef, path: string): void {
    const key = looseKey(root, path);
    this.keys.delete(key);
    const prefix = `${key}/`;
    for (const candidate of [...this.keys.keys()]) if (candidate.startsWith(prefix)) this.keys.delete(candidate);
  }
}

function privileged(principal: Principal): boolean {
  return principal.kind === 'system' || isHostPrincipal(principal);
}

function badRequest(reason: string, message: string): SmurgError {
  return new SmurgError('bad_request', message, { reason });
}

export class FileServiceImpl implements FileService {
  readonly attribution: ChangeAttribution;
  readonly knownDirs = new KnownDirectories();
  private readonly ctx: DaemonContext;
  private readonly treeMaxEntries: number;
  private trashDir: string | null = null;

  constructor(ctx: DaemonContext, options: FileServiceOptions = {}) {
    this.ctx = ctx;
    this.treeMaxEntries = Math.max(1, Math.min(options.treeMaxEntries ?? FILE_TREE_MAX_ENTRIES, FILE_TREE_MAX_ENTRIES));
    this.attribution = new ChangeAttribution({ clock: ctx.clock });
  }

  /** Module start: the trash directory exists and holds nothing from an interrupted delete. */
  async start(): Promise<void> {
    const trash = await this.trash();
    await emptyTrash(trash);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------------------------

  async tree(input: PayloadOf<'file.tree'>, principal: Principal): Promise<ResultInputOf<'file.tree'>> {
    const depth = input.depth ?? 1;
    let base: ResolvedPath;
    try {
      base = await this.ctx.paths.resolve({ root: input.root, path: input.path }, { principal, mustExist: true, allowRoot: true });
    } catch (err) {
      if (errnoCode(err) === 'ENAMETOOLONG') throw badRequest('path-too-long', '這個資料夾的完整路徑太長，系統無法開啟');
      throw err;
    }
    if (base.identity?.kind !== 'dir') throw badRequest('not-a-directory', '這不是資料夾');
    const entries: FileEntry[] = [];
    let truncated = false;
    const queue: { readonly ref: FileRef; readonly level: number; readonly resolved: ResolvedPath | null }[] = [{ ref: base.ref, level: 1, resolved: base }];
    while (queue.length > 0 && !truncated) {
      const next = queue.shift() as (typeof queue)[number];
      // A sub-directory is resolved again right before it is read (it may have been swapped since it was listed).
      let dir: ResolvedPath;
      try {
        dir = next.resolved ?? (await this.ctx.paths.resolve(next.ref, { principal, mustExist: true, finalSymlink: 'deny' }));
      } catch (err) {
        if (isPathDeniedError(err) || (err instanceof SmurgError && err.code === 'not_found') || errnoCode(err) === 'ENAMETOOLONG') continue;
        throw err;
      }
      if (dir.identity?.kind !== 'dir') continue;
      let listed: FileEntry[];
      try {
        listed = await this.listDirectory(dir, principal);
      } catch (err) {
        // A sub-directory the OS cannot list (REL-13: deeper than PATH_MAX): skipped; the listing itself still works.
        if (next.resolved === null && UNLISTABLE.has(errnoCode(err) ?? '')) continue;
        throw err;
      }
      for (const entry of listed) {
        if (entries.length >= this.treeMaxEntries) {
          truncated = true;
          break;
        }
        entries.push(entry);
        if (entry.kind === 'dir' && next.level < depth) queue.push({ ref: { root: dir.ref.root, path: entry.path }, level: next.level + 1, resolved: null });
      }
    }
    return { entries, truncated };
  }

  async stat(ref: FileRef, principal: Principal): Promise<FileEntry> {
    const resolved = await this.ctx.paths.resolve(ref, { principal, mustExist: true, allowRoot: true, finalSymlink: 'self' });
    const entry = this.entryOf(resolved, principal);
    if (!entry) throw new SmurgError('not_found');
    return entry;
  }

  async read(input: PayloadOf<'file.read'>, principal: Principal): Promise<ResultInputOf<'file.read'>> {
    const maxBytes = Math.min(input.maxBytes ?? FILE_CONTENT_MAX_BYTES, FILE_CONTENT_MAX_BYTES);
    const { bytes, truncated } = await this.ctx.paths.readFile(input.file, { principal, maxBytes });
    return { content: bytes, hash: createHash('sha256').update(bytes).digest('hex'), truncated };
  }

  async entryFor(ref: FileRef): Promise<FileEntry | null> {
    try {
      const resolved = await this.ctx.paths.resolve(ref, { principal: SYSTEM_PRINCIPAL, mustExist: true, allowRoot: true, finalSymlink: 'self', audit: false });
      return this.entryOf(resolved, SYSTEM_PRINCIPAL);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------------------------------------------

  async create(input: PayloadOf<'file.create'>, principal: Principal): Promise<FileEntry> {
    const ref = input.file;
    await this.refuseDaemonOwned(ref, principal);
    const guard = this.guard(principal);
    this.announce(ref, principal, false);
    let entry: FileEntry | null;
    if (input.kind === 'dir') {
      const result = await makeDirectory(ref, guard);
      if (!result.created) throw existsError();
      entry = await this.entryAfterMutation(ref, principal);
    } else {
      const identity = await this.ctx.paths.writeFileAtomic(ref, new Uint8Array(0), { principal, noClobber: true });
      entry = entryFromIdentity(this.nameOf(ref), ref.path, identity, this.decorations(ref, principal, identity));
    }
    if (!entry) throw new SmurgError('not_found', undefined, { reason: 'vanished' });
    this.recordMutation(principal, 'file.create', ref, { kind: input.kind }, `新增${input.kind === 'dir' ? '資料夾' : '檔案'} ${ref.path}`);
    if (input.kind === 'dir') this.knownDirs.add(ref.root, ref.path);
    return entry;
  }

  async rename(input: PayloadOf<'file.rename'>, principal: Principal): Promise<FileEntry> {
    const fromRef: FileRef = { root: input.root, path: input.from };
    const toRef: FileRef = { root: input.root, path: input.to };
    if (input.from === input.to) throw badRequest('same-path', '新名稱與原本相同');
    await this.refuseDaemonOwned(fromRef, principal);
    await this.refuseDaemonOwned(toRef, principal);
    const from = await this.ctx.paths.resolve(fromRef, { principal, forWrite: true, mustExist: true, finalSymlink: 'self' });
    const to = await this.ctx.paths.resolve(toRef, { principal, forWrite: true, finalSymlink: 'self' });
    const isDir = from.identity?.kind === 'dir';
    await this.refuseIfLocked(from, isDir);
    if (to.exists) await this.refuseIfLocked(to, to.identity?.kind === 'dir');
    this.announce(fromRef, principal, true);
    this.announce(toRef, principal, true);
    await moveResolved(from, to, this.guard(principal));
    // `from` stays a known directory until the watcher has reported it gone (it decides unlink vs unlinkDir).
    if (isDir) this.knownDirs.add(toRef.root, toRef.path);
    this.attribution.forget(fromRef.root, fromRef.path, isDir);
    // The web client parses this exact summary to move open editor tabs to the new path (apps/web lib/stores/docs.ts
    // renamedFrom, review WEB-01) until the activity event carries the old path as a field: do not reword it alone.
    this.recordMutation(principal, 'file.rename', toRef, { from: input.from, to: input.to }, `重新命名 ${input.from} → ${input.to}`);
    const entry = await this.entryAfterMutation(toRef, principal);
    if (!entry) throw new SmurgError('not_found', undefined, { reason: 'vanished' });
    return entry;
  }

  async delete(ref: FileRef, principal: Principal): Promise<void> {
    await this.refuseDaemonOwned(ref, principal);
    const resolved = await this.ctx.paths.resolve(ref, { principal, forWrite: true, mustExist: true, finalSymlink: 'self' });
    const isDir = resolved.identity?.kind === 'dir';
    await this.refuseIfLocked(resolved, isDir);
    this.announce(ref, principal, isDir);
    await deleteResolved(resolved, await this.trash(), this.guard(principal));
    this.attribution.forget(ref.root, ref.path, isDir);
    if (isDir) this.knownDirs.add(ref.root, ref.path); // the watcher's event for it must say unlinkDir
    this.recordMutation(principal, 'file.delete', ref, { kind: resolved.identity?.kind ?? 'file' }, `刪除 ${ref.path}`);
  }

  async write(input: PayloadOf<'file.write'>, principal: Principal): Promise<ResultInputOf<'file.write'>> {
    const ref = input.file;
    await this.refuseDaemonOwned(ref, principal);
    const target = await this.ctx.paths.resolve(ref, { principal, forWrite: true, finalSymlink: 'deny' });
    if (target.exists && target.identity?.kind !== 'file') throw badRequest('not-a-file', '不是一般檔案');
    await this.refuseIfLocked(target, false);
    let expect: FileIdentity | null | undefined;
    if (input.ifMatchHash !== undefined) {
      if (!target.exists) throw new SmurgError('conflict', '檔案已不存在', { reason: 'changed-since-read' });
      const current = await this.hashFile(target, principal);
      if (current.hash !== input.ifMatchHash) throw new SmurgError('conflict', '檔案在讀取後已被變更', { reason: 'changed-since-read' });
      expect = current.identity;
    }
    this.announce(ref, principal, false);
    const identity = await this.ctx.paths.writeFileAtomic(ref, input.content, { principal, ...(expect !== undefined ? { expect } : {}) });
    const hash = createHash('sha256').update(input.content).digest('hex');
    this.attribution.recordModified(ref.root, ref.path, principal.actor);
    this.ctx.audit.record({ actor: principal.actor, action: 'file.write', outcome: 'ok', target: refLabel(ref), detail: { size: input.content.byteLength, created: !target.exists } });
    this.activity(principal.actor, 'human.edit', ref, `修改 ${ref.path}`);
    const entry = entryFromIdentity(this.nameOf(ref), ref.path, identity, this.decorations(ref, principal, identity));
    if (!entry) throw new SmurgError('internal');
    return { entry, hash };
  }

  expectChange(ref: FileRef, by: Actor, ttlMs: number = EXPECT_CHANGE_TTL_MS): void {
    this.attribution.expect(ref.root, ref.path, by, ttlMs);
  }

  /** Like expectChange, for everything below a directory as well (directory moves, deletes, folder uploads). */
  expectSubtreeChange(ref: FileRef, by: Actor, ttlMs: number = EXPECT_CHANGE_TTL_MS): void {
    this.attribution.expect(ref.root, ref.path, by, ttlMs, true);
  }

  lastModifiedBy(ref: FileRef): Actor | null {
    return this.attribution.lastModifiedBy(ref.root, ref.path);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Shared with the upload service and the watcher
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * The lock that blocks writing `resolved` (any lock on it or, for a directory, below it), or null. `canonical`: the
   * FileRef of the resolved object itself (PathGuard.toFileRef of its realPath), which a lock taken under another
   * spelling (a symlinked parent directory) is keyed by; see refuseIfLocked.
   */
  lockBlocking(resolved: ResolvedPath, subtree: boolean, canonical: FileRef | null = null): LockInfo | null {
    const locks = this.ctx.services.locks;
    // No lock manager in this composition: nothing can hold a lock, so nothing is locked.
    if (isStubService(locks)) return null;
    const candidates: FileRef[] = [resolved.ref];
    if (resolved.mainRef) candidates.push(resolved.mainRef);
    if (canonical) candidates.push(canonical);
    for (const ref of candidates) {
      const lock = locks.get(ref);
      if (lock) return lock;
    }
    // Also match other spellings of the same entry (case, NFC/NFD) and, for directories, every lock below it.
    const keys = candidates.map((ref) => looseKey(ref.root, ref.path));
    for (const lock of locks.list()) {
      const key = looseKey(lock.file.root, lock.file.path);
      for (const base of keys) {
        if (key === base) return lock;
        if (subtree && (base.endsWith(':') ? key.startsWith(base) : key.startsWith(`${base}/`))) return lock;
      }
    }
    return null;
  }

  /**
   * Refuses (`locked`) a write of `resolved` while any lock holds it. The request's spelling may reach the file through
   * a symlinked directory inside the share, while the LockManager keys locks by the file itself (it learns aliases
   * only in the background): the canonical FileRef of the resolved object is checked as well.
   */
  async refuseIfLocked(resolved: ResolvedPath, subtree: boolean): Promise<void> {
    const canonical = await this.ctx.paths.toFileRef(resolved.realPath).catch(() => null);
    const lock = this.lockBlocking(resolved, subtree, canonical);
    if (lock) throw lockedError(lock, lock.kind === 'agent' ? `${lock.agentName} 正在修改這個檔案` : `${lock.holders.map((h) => h.displayName).join('、')} 正在編輯這個檔案`);
  }

  /** FileEntry of a resolved existing path, with decorations for `principal`. */
  entryOf(resolved: ResolvedPath, principal: Principal): FileEntry | null {
    if (!resolved.exists || resolved.identity === null) return null;
    return entryFromIdentity(this.nameOf(resolved.ref), resolved.ref.path, resolved.identity, {
      readOnly: resolved.readOnly || (!privileged(principal) && resolved.hostOnly),
      lock: this.lockOfEntry(resolved.ref, resolved.mainRef),
      lastModifiedBy: this.lastModifiedBy(resolved.ref) ?? (resolved.mainRef ? this.lastModifiedBy(resolved.mainRef) : null),
    });
  }

  /** Records a mutation made through the daemon: audit entry (the action's own name) and activity feed entry. */
  recordMutation(
    principal: Principal,
    action: 'file.create' | 'file.rename' | 'file.delete' | 'file.upload',
    ref: FileRef,
    detail: Readonly<Record<string, unknown>>,
    summary: string,
  ): void {
    this.ctx.audit.record({ actor: principal.actor, action, outcome: 'ok', target: refLabel(ref), detail });
    if (action !== 'file.delete') this.attribution.recordModified(ref.root, ref.path, principal.actor);
    this.activity(principal.actor, action, ref, summary);
  }

  /** Announces a coming change to the watcher (attributed to the principal's actor) and remembers the modifier. */
  announce(ref: FileRef, principal: Principal, subtree: boolean): void {
    this.attribution.expect(ref.root, ref.path, principal.actor, EXPECT_CHANGE_TTL_MS, subtree);
  }

  /**
   * Refuses mutations of the daemon's own directories (fs-ops isDaemonOwnedPath). PathGuard decides first, so a guest
   * gets the same audited `hidden` denial as for any other path below `.smurg`; only the host sees `daemon-owned`.
   */
  async refuseDaemonOwned(ref: FileRef, principal: Principal): Promise<void> {
    if (!isDaemonOwnedPath(ref.root, ref.path)) return;
    await this.ctx.paths.resolve(ref, { principal, forWrite: true, finalSymlink: 'self' });
    throw daemonOwnedError();
  }

  guard(principal: Principal): GuardContext {
    return { paths: this.ctx.paths, principal };
  }

  async trash(): Promise<string> {
    if (this.trashDir === null) this.trashDir = await ensureTrashDir(this.ctx.roots.main.realPath);
    // Re-checked on every use: the host could have removed or replaced it.
    const st = await lstatOrNull(this.trashDir);
    if (st === null || st === 'not-directory' || !st.isDirectory() || (await realpathOrNull(this.trashDir)) !== this.trashDir) {
      this.trashDir = await ensureTrashDir(this.ctx.roots.main.realPath);
    }
    return this.trashDir;
  }

  activity(actor: Actor, kind: 'human.edit' | 'file.create' | 'file.delete' | 'file.rename' | 'file.upload', file: FileRef, summary: string): void {
    const feed = this.ctx.services.activity;
    if (isStubService(feed)) return;
    try {
      feed.record({ actor, kind, file, summary: clampSummary(summary) });
    } catch (err) {
      this.ctx.log.warn('activity record failed', { kind, error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------------

  private nameOf(ref: FileRef): string {
    return ref.path.slice(ref.path.lastIndexOf('/') + 1);
  }

  private decorations(ref: FileRef, principal: Principal, identity: FileIdentity): { readOnly: boolean; lock: LockInfo | null; lastModifiedBy: Actor | null } {
    return {
      readOnly: !privileged(principal) && isHostOnlyPath(ref.path) && identity.kind !== 'other',
      lock: this.lockOfEntry(ref, null),
      lastModifiedBy: this.lastModifiedBy(ref),
    };
  }

  private lockOfEntry(ref: FileRef, mainRef: FileRef | null): LockInfo | null {
    const locks = this.ctx.services.locks;
    if (isStubService(locks)) return null;
    try {
      return locks.get(ref) ?? (mainRef ? locks.get(mainRef) : null) ?? null;
    } catch {
      return null;
    }
  }

  private async entryAfterMutation(ref: FileRef, principal: Principal): Promise<FileEntry | null> {
    try {
      const resolved = await this.ctx.paths.resolve(ref, { principal, mustExist: true, finalSymlink: 'self' });
      return this.entryOf(resolved, principal);
    } catch (err) {
      if (err instanceof SmurgError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /**
   * One directory: readdir → lstat every child (never following it) → re-validate the directory (same object, still
   * inside the root) so a directory swapped for a symlink while it was being read is refused, not listed.
   */
  private async listDirectory(dir: ResolvedPath, principal: Principal): Promise<FileEntry[]> {
    const options: ResolveOptions = { principal, mustExist: true, allowRoot: true };
    let names: string[];
    try {
      names = await readdir(dir.realPath);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new SmurgError('not_found', undefined, { reason: 'vanished' });
      throw err;
    }
    const isPrivileged = privileged(principal);
    const inMainTop = dir.ref.path === '' && dir.ref.root.kind === 'main';
    const sharedLinkPaths = new Set(dir.root.sharedLinks.map((l) => l.path));
    const listed = await mapLimit(names, LIST_CONCURRENCY, async (rawName): Promise<FileEntry | null> => {
      if (isHiddenTempName(rawName)) return null;
      const checked = checkRelPath(rawName);
      // A name the protocol cannot carry (control characters, backslash, …) cannot be named in a request either.
      if (!checked.ok || checked.path.includes('/')) return null;
      const name = checked.path;
      if (inMainTop && !isPrivileged && isSmurgDirName(name)) return null;
      // SEC-D-03: what PathGuard refuses non-hosts to read (.git, .envrc, the host's personal Claude Code files) is not
      // listed for them either, like .smurg: a listing that shows them only leads to refused (audited) opens.
      if (!isPrivileged && isHostPrivatePath(joinRel(dir.ref.path, name))) return null;
      let st: Awaited<ReturnType<typeof lstatOrNull>>;
      try {
        st = await lstatOrNull(join(dir.realPath, rawName));
      } catch (err) {
        // One entry the OS cannot look at (REL-13: its path exceeds PATH_MAX, a permission): left out, not the listing.
        if (UNLISTABLE.has(errnoCode(err) ?? '')) return null;
        throw err;
      }
      if (st === null || st === 'not-directory') return null;
      const identity = identityOf(st);
      const path = joinRel(dir.ref.path, name);
      const ref: FileRef = { root: dir.ref.root, path };
      const mainRef: FileRef | null = dir.mainRef ? { root: MAIN_ROOT, path: joinRel(dir.mainRef.path, name) } : null;
      if (identity.kind === 'dir') this.knownDirs.add(ref.root, ref.path);
      return entryFromIdentity(name, path, identity, {
        readOnly: dir.readOnly || sharedLinkPaths.has(path) || (!isPrivileged && isHostOnlyPath(path)),
        lock: this.lockOfEntry(ref, mainRef),
        lastModifiedBy: this.lastModifiedBy(ref) ?? (mainRef ? this.lastModifiedBy(mainRef) : null),
      });
    });
    await this.ctx.paths.revalidate(dir, options);
    const entries = listed.filter((e): e is FileEntry => e !== null);
    entries.sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return entries;
  }

  /** SHA-256 of a whole file, streamed through a guarded handle (never loaded whole). */
  private async hashFile(resolved: ResolvedPath, principal: Principal): Promise<{ readonly hash: string; readonly identity: FileIdentity }> {
    const file = await this.ctx.paths.openRead(resolved, { principal });
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(HASH_READ_BYTES);
      let position = 0;
      for (;;) {
        const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return { hash: hash.digest('hex'), identity: file.identity };
    } finally {
      await file.close();
    }
  }
}


