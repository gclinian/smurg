// PathGuard (SPEC R1; ARCHITECTURE §7.4). The daemon acts for every member, so every path from a client, a hook or
// the MCP socket is resolved here before any fs call, and resolved AGAIN right before every read and write: a
// session can swap a parent directory for a symlink at any time (yjs-monaco.md verification item 1).
//
// resolve(): lexical layer → root still the registered directory → walk every component with lstat, resolving
// symlinks with realpath and requiring every step to stay inside the root (a registered read-only shared link is the
// one exception: its target must be exactly the recorded shared directory) → the non-existing tail is plain names →
// host-only / hidden / read-only / special-file / hard-link rules.
// openRead(): re-validate, open the symlink-free path with O_NOFOLLOW|O_NONBLOCK, fstat must be the same inode.
// writeFileAtomic(): tmp in the checked parent (O_EXCL|O_NOFOLLOW), parent re-validated, rename / link, post-move
// check (removes a file that landed outside), directory fsync.
// Residual risk (documented in yjs-monaco.md "Still unverified"): a swap between the last check and the open/rename
// syscall; the inode comparison after open and the post-move check detect it instead of preventing it.
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAIN_ROOT, SmurgError, checkRelPath, foldPathName, isHostOnlyPath, isHostPrivatePath, isInTopicDir, isSmurgDirName, relPathSegments, rootRefKey, type FileRef, type RootRef } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { PathDeniedError, isPathDeniedError, type PathDeniedReason } from '../core/errors.ts';
import type { AuditLog, FileIdentity, GuardedFile, PathGuard, ResolveOptions, ResolvedPath, RootInfo, RootRegistry, SharedLink } from '../core/interfaces.ts';
import { isHostPrincipal } from '../core/permissions.ts';
import { syncDirectory } from '../core/state-store.ts';
import { errnoCode, identityOf, isInside, lstatOrNull, otherSpellings, realpathOrNull, sameObject } from './fs-util.ts';
import { checkAbsoluteLength, checkLexicalPath, describeTarget, platformLimits, type PlatformLimits } from './lexical.ts';

/** Largest file readFile() loads into memory; bigger reads must stream through openRead(). */
const READ_FILE_MAX_BYTES = 256 * 1024 * 1024;

export interface PathGuardOptions {
  readonly roots: RootRegistry;
  readonly audit: AuditLog;
  readonly platform?: NodeJS.Platform;
  /**
   * Root-relative paths that are host-only for writes right now, beyond the lexical list: the files the trust gate
   * records for a root whose Claude Code project settings the host confirmed (ProjectTrust.protectedPaths). Asked at
   * every write of a non-host, so the answer is always the trust gate's current one. Default: none.
   */
  readonly protectedPaths?: (root: RootRef) => ReadonlySet<string>;
}

function rootLabel(root: unknown): string {
  try {
    return rootRefKey(root as RootRef);
  } catch {
    return '?';
  }
}

/** The host and the daemon itself may see `<share>/.smurg`, write host-only paths and read hard-linked files. */
function privileged(options: ResolveOptions): boolean {
  return options.principal.kind === 'system' || isHostPrincipal(options.principal);
}

function toPosix(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function tmpNameFor(name: string): string {
  // Stay under NAME_MAX even for a 255-unit name; the pattern stays `.<name>.smurg-<12 hex>.tmp` (hidden in the tree).
  const stem = name.length > 200 ? name.slice(0, 200) : name;
  return `.${stem}.smurg-${randomBytes(6).toString('hex')}.tmp`;
}

/** A path as a case-insensitive file system would compare it (protocol foldPathName, segment by segment). */
function foldedPath(path: string): string {
  return relPathSegments(path).map(foldPathName).join('/');
}

export class PathGuardImpl implements PathGuard {
  private readonly roots: RootRegistry;
  private readonly audit: AuditLog;
  private readonly protectedPaths: (root: RootRef) => ReadonlySet<string>;
  private readonly limits: PlatformLimits;
  /**
   * The file system compares names byte-wise, not normalisation-insensitively like APFS (Linux: ext4, btrfs, xfs,
   * tmpfs): an NFC request is mapped onto the entry that spells the same name differently (fs-util otherSpellings).
   */
  private readonly normalisationSensitive: boolean;

  constructor(options: PathGuardOptions) {
    this.roots = options.roots;
    this.audit = options.audit;
    this.protectedPaths = options.protectedPaths ?? (() => new Set());
    const platform = options.platform ?? process.platform;
    this.limits = platformLimits(platform);
    this.normalisationSensitive = platform !== 'darwin';
  }

  lexical(path: unknown, options: { readonly allowRoot?: boolean } = {}): string {
    return checkLexicalPath(path, this.limits, options);
  }

  async resolve(ref: FileRef, options: ResolveOptions): Promise<ResolvedPath> {
    try {
      return await this.resolveUnaudited(ref, options);
    } catch (err) {
      this.auditDenial(err, ref, options);
      throw err;
    }
  }

  async toFileRef(absPath: string): Promise<FileRef | null> {
    if (typeof absPath !== 'string' || !isAbsolute(absPath) || absPath.includes('\u0000')) return null;
    let probe = resolve(absPath);
    const tail: string[] = [];
    let real: string | null;
    for (;;) {
      real = await realpathOrNull(probe);
      if (real !== null) break;
      const parent = dirname(probe);
      if (parent === probe) return null;
      tail.unshift(basename(probe));
      probe = parent;
    }
    const full = tail.length > 0 ? join(real, ...tail) : real;
    let best: RootInfo | null = null;
    for (const root of this.roots.list()) {
      if (isInside(full, root.realPath) && (best === null || root.realPath.length > best.realPath.length)) best = root;
    }
    if (best === null) return null;
    const checked = checkRelPath(toPosix(relative(best.realPath, full)), { allowRoot: true });
    return checked.ok ? { root: best.ref, path: checked.path } : null;
  }

  async revalidate(resolved: ResolvedPath, options: ResolveOptions): Promise<ResolvedPath> {
    const fresh = await this.resolve(resolved.ref, options);
    const changed =
      fresh.exists !== resolved.exists ||
      fresh.realPath !== resolved.realPath ||
      (resolved.identity !== null && fresh.identity !== null && !sameObject(resolved.identity, fresh.identity));
    if (changed) this.deny('changed', resolved.ref, options);
    return fresh;
  }

  async openRead(resolved: ResolvedPath, options: ResolveOptions): Promise<GuardedFile> {
    const fresh = await this.revalidate(resolved, { ...options, mustExist: true });
    if (fresh.identity === null || fresh.identity.kind !== 'file') throw new SmurgError('bad_request', msg('file.notAFile'), { reason: 'not-a-file' });
    let handle: FileHandle;
    try {
      handle = await open(fresh.realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOENT' || code === 'ENOTDIR') this.deny('changed', resolved.ref, options);
      throw err;
    }
    try {
      const st = await handle.stat();
      const expected = fresh.identity;
      if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino) this.deny('changed', resolved.ref, options);
      if (!privileged(options) && st.nlink > 1) this.deny('hard-link', resolved.ref, options);
      const identity = identityOf(st);
      return { handle, identity, close: () => handle.close() };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async readFile(
    ref: FileRef,
    options: ResolveOptions & { readonly maxBytes?: number },
  ): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity; readonly truncated: boolean }> {
    const resolved = await this.resolve(ref, { ...options, mustExist: true });
    const file = await this.openRead(resolved, options);
    try {
      if (options.maxBytes === undefined && file.identity.size > READ_FILE_MAX_BYTES) {
        throw new SmurgError('too_large', undefined, { reason: 'read-limit' });
      }
      const max = Math.max(0, Math.min(options.maxBytes ?? READ_FILE_MAX_BYTES, READ_FILE_MAX_BYTES));
      const want = Math.min(file.identity.size, max);
      const buffer = Buffer.alloc(want);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await file.handle.read(buffer, filled, want - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      // More bytes after what we returned (beyond maxBytes, or the file grew while reading): not the whole file.
      const probe = Buffer.alloc(1);
      const truncated = (await file.handle.read(probe, 0, 1, filled)).bytesRead > 0;
      return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, filled), identity: file.identity, truncated };
    } finally {
      await file.close();
    }
  }

  async writeFileAtomic(
    ref: FileRef,
    data: Uint8Array,
    options: ResolveOptions & { readonly noClobber?: boolean; readonly expect?: FileIdentity | null; readonly mode?: number },
  ): Promise<FileIdentity> {
    const target = await this.resolve(ref, { ...options, forWrite: true, finalSymlink: 'deny' });
    if (target.name === '') throw new SmurgError('bad_request', msg('file.cannotWriteRoot'), { reason: 'root' });
    if (options.expect !== undefined) {
      const matches = options.expect === null ? !target.exists : target.identity !== null && sameObject(target.identity, options.expect);
      if (!matches) throw new SmurgError('conflict', msg('file.changedSinceRead'), { reason: 'changed-since-read' });
    }
    if (options.noClobber && target.exists) throw new SmurgError('conflict', msg('file.exists'), { reason: 'exists' });
    if (target.exists && target.identity?.kind !== 'file') throw new SmurgError('bad_request', msg('file.notAFile'), { reason: 'not-a-file' });
    const parentStat = await lstatOrNull(target.parentRealPath);
    if (parentStat === null || parentStat === 'not-directory' || !parentStat.isDirectory()) {
      throw new SmurgError('not_found', msg('file.parentMissing'), { reason: 'parent-missing' });
    }
    const parentIdentity = identityOf(parentStat);
    const tmp = join(target.parentRealPath, tmpNameFor(target.name));
    const finalPath = join(target.parentRealPath, target.name);
    let handle: FileHandle | null = null;
    try {
      handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o666);
      // A new file gets 0666 & ~umask from open(); a replaced file keeps its mode (ARCHITECTURE §7.5).
      const mode = options.mode ?? (target.exists && target.identity ? target.identity.mode & 0o7777 : undefined);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.writeFile(data);
      await handle.sync();
      const tmpStat = await handle.stat();
      await handle.close();
      handle = null;
      await this.revalidateParent(target, parentIdentity, options);
      if (options.noClobber) await this.placeNoClobber(tmp, finalPath);
      else await rename(tmp, finalPath);
      const placed = identityOf(tmpStat);
      await this.checkPlaced(target, placed, options);
      await syncDirectory(target.parentRealPath);
      return placed;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(tmp).catch(() => {});
    }
  }

  async checkPlaced(resolved: ResolvedPath, placed: FileIdentity, options: ResolveOptions): Promise<void> {
    const finalPath = resolved.realPath;
    const st = await lstatOrNull(finalPath);
    if (st === null || st === 'not-directory' || !sameObject(identityOf(st), placed)) {
      // What is at the checked path is not what we placed; nothing there is ours to remove.
      this.deny('changed', resolved.ref, options);
    }
    const real = await realpathOrNull(finalPath);
    if (real === null || real !== finalPath || !isInside(real, resolved.root.realPath)) {
      // A parent was swapped for a symlink: the object landed outside the root. Take it back out, then refuse.
      if (placed.kind === 'dir') await rmdir(finalPath).catch(() => {});
      else await unlink(finalPath).catch(() => {});
      this.deny('outside-root', resolved.ref, options);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async resolveUnaudited(ref: FileRef, options: ResolveOptions): Promise<ResolvedPath> {
    const target = describeTarget(ref?.path);
    const path = this.lexical(ref.path, { allowRoot: options.allowRoot === true });
    const root = this.roots.get(ref.root);
    if (!root) throw new PathDeniedError('unknown-root', target);
    const segments = relPathSegments(path);
    const isPrivileged = privileged(options);
    if (!isPrivileged && root.ref.kind === 'main' && startsWithSmurgDir(path)) throw new PathDeniedError('hidden', target);
    if ((await realpathOrNull(root.realPath)) !== root.realPath) throw new PathDeniedError('root-changed', target);
    checkAbsoluteLength(join(root.realPath, path), this.limits, target);

    const finalSymlink = options.finalSymlink ?? (options.forWrite ? 'deny' : 'follow');
    let current = root.realPath;
    let boundary = root.realPath;
    let readOnly = false;
    let shared: { readonly mainPath: string; readonly targetRealPath: string } | null = null;
    let exists = true;
    let identity: FileIdentity | null = null;
    let realPath = root.realPath;
    let parentRealPath = dirname(root.realPath);
    /** The names below `current` that do not exist yet. */
    let missing: readonly string[] = [];
    /** The last segment was a symlink that was followed (in-root or shared link): realPath is its target. */
    let lastFollowedLink = false;
    if (segments.length === 0) identity = identityOf(await lstat(root.realPath));

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      const last = i === segments.length - 1;
      let candidate = join(current, segment);
      let st = await lstatOrNull(candidate);
      if (st === null && this.normalisationSensitive) {
        // Not there under its NFC spelling: the one entry of this (contained, symlink-free) directory that spells the
        // same name differently, if there is exactly one. It goes through every check below like any other entry.
        const others = options.spellings !== undefined ? await options.spellings.otherSpellings(current, segment) : await otherSpellings(current, segment);
        if (others.length === 1) {
          const onDisk = join(current, others[0] as string);
          const found = await lstatOrNull(onDisk);
          if (found !== null && found !== 'not-directory') {
            candidate = onDisk;
            st = found;
          }
        }
      }
      if (st === 'not-directory') throw new PathDeniedError('not-directory', target);
      if (st === null) {
        // The rest does not exist yet: plain names below the last existing (symlink-free, contained) directory.
        exists = false;
        const tail = segments.slice(i);
        missing = tail;
        realPath = join(current, ...tail);
        parentRealPath = tail.length === 1 ? current : join(current, ...tail.slice(0, -1));
        break;
      }
      if (st.isSymbolicLink()) {
        const soFar = segments.slice(0, i + 1).join('/');
        const sharedLink: SharedLink | undefined = shared === null ? root.sharedLinks.find((l) => l.path === soFar) : undefined;
        if (last && finalSymlink === 'self') {
          identity = identityOf(st);
          realPath = candidate;
          parentRealPath = current;
          if (sharedLink) readOnly = true;
          break;
        }
        if (sharedLink) {
          const linkTarget = await realpathOrNull(candidate);
          if (linkTarget === null || linkTarget !== sharedLink.targetRealPath) throw new PathDeniedError('shared-link-tampered', target);
          if (!isInside(linkTarget, this.roots.main.realPath)) throw new PathDeniedError('outside-root', target);
          readOnly = true;
          shared = { mainPath: sharedLink.mainPath, targetRealPath: linkTarget };
          current = linkTarget;
          boundary = linkTarget;
          if (last) {
            identity = identityOf(await lstat(linkTarget));
            realPath = linkTarget;
            parentRealPath = dirname(linkTarget);
            lastFollowedLink = true;
          }
          continue;
        }
        if (last && finalSymlink === 'deny') throw new PathDeniedError('symlink', target);
        const linkTarget = await realpathOrNull(candidate);
        if (linkTarget === null) throw new SmurgError('not_found', undefined, { reason: 'dangling-symlink' });
        if (!isInside(linkTarget, boundary)) throw new PathDeniedError('outside-root', target);
        const targetStat = await lstat(linkTarget);
        if (!last && !targetStat.isDirectory()) throw new PathDeniedError('not-directory', target);
        current = linkTarget;
        if (last) {
          identity = identityOf(targetStat);
          realPath = linkTarget;
          parentRealPath = dirname(linkTarget);
          lastFollowedLink = true;
        }
        continue;
      }
      if (!last) {
        if (!st.isDirectory()) throw new PathDeniedError('not-directory', target);
        current = candidate;
        continue;
      }
      identity = identityOf(st);
      realPath = candidate;
      parentRealPath = current;
    }

    if (!isInside(realPath, boundary)) throw new PathDeniedError('outside-root', target);
    const relOf = (abs: string): string =>
      shared ? joinPosix(shared.mainPath, toPosix(relative(shared.targetRealPath, abs))) : toPosix(relative(root.realPath, abs));
    const resolvedRel = relOf(realPath);
    // The same object as the file system spells it (native realpath returns the on-disk case of every existing
    // component): host-only and hidden are decided on what IS there, not only on the request's spelling.
    const onDisk = !exists
      ? await canonicalJoin(current, missing)
      : identity?.kind === 'symlink'
        ? await canonicalJoin(parentRealPath, [basename(realPath)]) // finalSymlink 'self': the link itself
        : await realpathOrNull(realPath);
    if (onDisk === null || !isInside(onDisk, boundary)) throw new PathDeniedError('changed', target);
    const diskRel = relOf(onDisk);
    const mainRef: FileRef | null = shared ? { root: MAIN_ROOT, path: resolvedRel } : null;
    const inMain = shared !== null || root.ref.kind === 'main';
    if (!isPrivileged && inMain && (startsWithSmurgDir(resolvedRel) || startsWithSmurgDir(diskRel))) throw new PathDeniedError('hidden', target);
    const spellings = [path, resolvedRel, diskRel];
    // An item worktree: its copy of the topic's folder is what the agent was started from, and the report file there
    // belongs to the agent. No PERSON writes it through smurg (file.*, doc.*, uploads), the host included. The daemon
    // itself may (it removes a stale report before a start); what the item's own agent may edit there is the tool
    // gate's decision (hooks/tool-gate.ts), not this rule's.
    const itemSlug = shared === null ? root.item?.topicSlug : undefined;
    if (itemSlug !== undefined && options.principal.kind === 'user' && spellings.some((spelling) => isInTopicDir(spelling, itemSlug))) readOnly = true;
    let hostOnly = spellings.some((spelling) => isHostOnlyPath(spelling));
    if (!hostOnly && shared === null) {
      // Files the trust gate records (scripts a trusted settings file runs): host-only while that content is trusted.
      const recorded = this.recordedPaths(root.ref);
      if (recorded.size > 0) hostOnly = spellings.some((spelling) => recorded.has(foldedPath(spelling)));
    }
    if (options.forWrite) {
      if (readOnly) throw new PathDeniedError('read-only', target);
      if (hostOnly && !isPrivileged) throw new PathDeniedError('host-only', target);
    }
    // Reads too: the host-private files (.git, .envrc, the host's personal Claude Code files) are not
    // handed to anyone but the host through file.read / download / doc.open. Decided on the request's, the resolved and
    // the on-disk spelling, like host-only.
    if (!isPrivileged && (isHostPrivatePath(path) || isHostPrivatePath(resolvedRel) || isHostPrivatePath(diskRel))) {
      throw new PathDeniedError('host-private', target);
    }
    if (identity !== null && identity.kind === 'other') throw new PathDeniedError('special-file', target);
    if (identity !== null && identity.kind === 'file' && identity.nlink > 1 && !isPrivileged) throw new PathDeniedError('hard-link', target);
    if (options.mustExist && !exists) throw new SmurgError('not_found');
    // The paths handed out are spelled as the file system spells them (native realpath: the stored case and Unicode
    // normalisation of every existing component; the missing names as requested). Every read, write, rename and
    // post-move check works on that spelling: APFS keeps an entry's stored name when a file is renamed over it (NFC
    // `café` onto a stored NFD `cafe` + U+0301, `readme.md` onto `README.md`), so a request-spelled path is never what
    // realpath reports afterwards, and the post-move check took the new file for one that landed elsewhere (removed
    // it and refused the write). A followed final link keeps its target (already a realpath) and the link's name.
    let name = segments.at(-1) ?? '';
    if (segments.length > 0 && !lastFollowedLink) {
      realPath = onDisk;
      parentRealPath = dirname(onDisk);
      name = basename(onDisk);
    }
    return Object.freeze({
      ref: { root: root.ref, path },
      root,
      name,
      realPath,
      parentRealPath,
      exists,
      identity,
      readOnly,
      hostOnly,
      mainRef,
    });
  }

  /** ProjectTrust.protectedPaths(root), folded; a failing provider protects nothing more (the lexical list still holds). */
  private recordedPaths(root: RootRef): ReadonlySet<string> {
    try {
      const paths = this.protectedPaths(root);
      if (paths.size === 0) return paths;
      return new Set([...paths].map(foldedPath));
    } catch {
      return new Set();
    }
  }

  private async revalidateParent(target: ResolvedPath, parent: FileIdentity, options: ResolveOptions): Promise<void> {
    const now = await realpathOrNull(target.parentRealPath);
    if (now !== target.parentRealPath || !isInside(now, target.root.realPath)) this.deny('changed', target.ref, options);
    const st = await lstatOrNull(target.parentRealPath);
    if (st === null || st === 'not-directory' || !sameObject(identityOf(st), parent)) this.deny('changed', target.ref, options);
  }

  private async placeNoClobber(tmp: string, finalPath: string): Promise<void> {
    try {
      await link(tmp, finalPath);
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EEXIST') throw new SmurgError('conflict', msg('file.exists'), { reason: 'exists' });
      if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EOPNOTSUPP') throw err;
    }
    // No hard links on this filesystem (ExFAT, transfer.md §1.4): a placeholder still refuses an existing file.
    const placeholder = await open(finalPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o666).catch((cause: unknown) => {
      if (errnoCode(cause) === 'EEXIST') throw new SmurgError('conflict', msg('file.exists'), { reason: 'exists' });
      throw cause;
    });
    await placeholder.close();
    await rename(tmp, finalPath);
  }

  /** Throws an audited PathDeniedError. */
  private deny(reason: PathDeniedReason, ref: FileRef, options: ResolveOptions): never {
    const error = new PathDeniedError(reason, describeTarget(ref?.path));
    this.auditDenial(error, ref, options);
    throw error;
  }

  private auditDenial(err: unknown, ref: FileRef, options: ResolveOptions): void {
    if (!isPathDeniedError(err) || err.audited || options.audit === false) return;
    err.audited = true;
    this.audit.record({
      actor: options.principal.actor,
      action: 'path.denied',
      outcome: 'denied',
      target: `${rootLabel(ref?.root)}:${err.target}`,
      detail: { reason: err.reason, write: options.forWrite === true },
    });
  }
}

function joinPosix(base: string, rel: string): string {
  if (rel === '') return base;
  return base === '' ? rel : `${base}/${rel}`;
}

/** `rel`'s first segment is the daemon's `.smurg` directory under any spelling a file system may fold onto it. */
function startsWithSmurgDir(rel: string): boolean {
  const first = relPathSegments(rel)[0];
  return first !== undefined && isSmurgDirName(first);
}

/** realpath(dir) (on-disk spelling) joined with names that do not exist yet; null when `dir` vanished. */
async function canonicalJoin(dir: string, names: readonly string[]): Promise<string | null> {
  const real = await realpathOrNull(dir);
  return real === null ? null : names.length === 0 ? real : join(real, ...names);
}
