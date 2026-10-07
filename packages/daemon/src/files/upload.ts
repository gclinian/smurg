// UploadService (SPEC R7 / D15; ARCHITECTURE §5.2 transfer channel; transfer.md §1.3–§1.5, §1.8 with the
// verifier's corrections): plan, begin, hashes, chunk, commit, abort.
//
//  * Uploads are bound to the transfer connection that began or resumed them; chunks from any other connection are
//    refused. Resume works by uploadId, by identity (user, root, path, size, lastModified, chunkSize) and after a
//    daemon restart (the staging store is on disk).
//  * The disk rule runs before `plan` and before every `begin`, resumes included (then only for the missing bytes, and
//    never counting the upload itself as "pending"). Refusals carry the DiskReport.
//  * Staging lives in the state dir when it is on the target's volume, else in <share>/.smurg/uploads, so the commit
//    is always a same-volume link/rename.
//  * Commit: bitmap complete + size + hash-list root → fsync → chmod (never leave the 0600 staging mode on a shared
//    file) → PathGuard again → no-clobber link (EEXIST is the final arbiter) or rename for overwrite → post-move check.
//    `locked` when the target has any lock.
import { createHash } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SmurgError,
  UPLOAD_PLAN_MAX_ENTRIES,
  baseNameOfRelPath,
  can,
  foldPathName,
  insufficientDiskError,
  parentRelPath,
  relPathSegments,
  rootRefKey,
  type DiskReport,
  type FileRef,
  type PayloadOf,
  type ResultInputOf,
  type RootRef,
} from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { PathDeniedError } from '../core/errors.ts';
import type { ClientConnection, FileIdentity, Principal, ResolvedPath, RootInfo, UploadService, UserId } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { syncDirectory } from '../core/state-store.ts';
import { SpellingIndex, errnoCode, identityOf, isInside, lstatOrNull, realpathOrNull } from '../workspace/fs-util.ts';
import { diskReport, insufficientDiskMessage, nodeStatfs, probeVolume, type StatfsFunction } from './disk.ts';
import type { FileServiceImpl } from './file-service.ts';
import { existsError, makeDirectory, numberedName, placeNoClobber } from './fs-ops.ts';
import { UploadStore, matchesIdentity, type StagedUpload, type StagingArea, type UploadManifest } from './upload-store.ts';
import { looseKey, mapLimit, refLabel } from './util.ts';
import { shownPath } from '../locks/text.ts';

export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000;
export const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Planned bytes stay reserved this long unless their uploads begin, or the planning connection closes. */
export const PLAN_RESERVATION_TTL_MS = 30 * 60 * 1000;
const RENAME_ATTEMPTS = 1_000;
const PLAN_RESOLVE_CONCURRENCY = 8;
/** At most this many offending paths are listed in a refused plan's detail. */
const PLAN_PROBLEMS_LISTED = 100;
/**
 * Unfinished uploads one member may have at once. Each costs three staging files and some memory; clients pipeline a
 * few files of a folder drop at a time (transfer.md §1.3), so this only stops a flood.
 */
export const MAX_PARTIAL_UPLOADS_PER_USER = 1_000;
/**
 * How long a committed upload's id is remembered: a client whose commit answer was lost (the socket dropped between
 * the commit and its `.ok`) begins again with that id and must learn that its file is there, instead of meeting its
 * own file as a name conflict.
 */
export const COMMITTED_UPLOAD_MEMORY_MS = 10 * 60 * 1000;
const COMMITTED_UPLOADS_REMEMBERED = 10_000;

export interface UploadServiceOptions {
  readonly statfs?: StatfsFunction;
  /** Partial uploads untouched for this long are removed by the sweep. */
  readonly ttlMs?: number;
  readonly sweepIntervalMs?: number;
  readonly planReservationTtlMs?: number;
}

interface PlanReservation {
  readonly userId: UserId;
  readonly connId: string;
  readonly dev: number;
  readonly expiresAt: number;
  /** looseKey(root, final path) → bytes still reserved. */
  readonly entries: Map<string, number>;
}

interface PendingExclusion {
  readonly uploadId?: string;
  readonly plan?: { readonly userId: UserId; readonly key: string };
}

/** One entry of a plan as `plan` goes on with it. */
export interface PlannedEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly size: number;
}

/**
 * PURE: what a plan's entries are inside the batch itself: each name once (`seen`, by its path, or by the key a file
 * system that compares names without case gives it when `insensitive`), and the entries that cannot both be made (two
 * for one name, a file that is also the folder of another entry). null: the entries lie in more folders than a plan
 * may have entries (UPLOAD_PLAN_MAX_ENTRIES; an entry can lie two thousand folders deep, so without this bound ten
 * thousand entries were twenty million folders).
 * Each name is folded once and a folder is walked once: the first entry in it brings the folders above it, the others
 * stop at it (every entry used to fold every folder above it again, each from its first name on: 2.7 s for a thousand
 * files two hundred folders deep).
 */
export function planBatch(
  entries: readonly { readonly path: string; readonly kind: 'file' | 'dir'; readonly size?: number | undefined }[],
  insensitive: boolean,
): { readonly seen: Map<string, PlannedEntry>; readonly problems: { path: string; reason: string }[] } | null {
  const seen = new Map<string, PlannedEntry>();
  const problems: { path: string; reason: string }[] = [];
  const parentKeys = new Set<string>();
  for (const entry of entries) {
    const names = insensitive ? relPathSegments(entry.path).map(foldPathName) : relPathSegments(entry.path);
    const key = names.join('/');
    const previous = seen.get(key);
    if (previous) {
      if (!(previous.kind === 'dir' && entry.kind === 'dir')) problems.push({ path: entry.path, reason: 'duplicate' });
      continue;
    }
    seen.set(key, { path: entry.path, kind: entry.kind, size: entry.size ?? 0 });
    for (let depth = names.length - 1; depth > 0; depth -= 1) {
      const parent = names.slice(0, depth).join('/');
      if (parentKeys.has(parent)) break;
      parentKeys.add(parent);
      if (parentKeys.size > UPLOAD_PLAN_MAX_ENTRIES) return null;
    }
  }
  for (const [key, entry] of seen) if (entry.kind === 'file' && parentKeys.has(key)) problems.push({ path: entry.path, reason: 'file-and-directory' });
  return { seen, problems };
}

/**
 * PURE: the folders to make for a plan's entries (the ones it lists and the ones its entries lie in), parents first.
 * null: more than a plan may have entries. (As they are spelt: two spellings of one folder are two here, also on a
 * file system that takes them for one.)
 */
export function planFolders(entries: readonly PlannedEntry[]): string[] | null {
  const depthOf = new Map<string, number>();
  for (const entry of entries) {
    let prefix: string | null = entry.kind === 'dir' ? entry.path : parentRelPath(entry.path);
    while (prefix !== null && prefix !== '' && !depthOf.has(prefix)) {
      depthOf.set(prefix, relPathSegments(prefix).length);
      if (depthOf.size > UPLOAD_PLAN_MAX_ENTRIES) return null;
      prefix = parentRelPath(prefix);
    }
  }
  return [...depthOf].sort(([a, depthA], [b, depthB]) => depthA - depthB || (a < b ? -1 : a > b ? 1 : 0)).map(([dir]) => dir);
}

/** `SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1)` (ARCHITECTURE §5.2). */
export function hashListRoot(size: number, chunkSize: number, hashes: Uint8Array): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(BigInt(size), 0);
  header.writeUInt32BE(chunkSize, 8);
  return createHash('sha256').update(header).update(hashes).digest();
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function badRequest(reason: string, message: MessageRef, extra: Record<string, unknown> = {}): SmurgError {
  return new SmurgError('bad_request', message, { reason, ...extra });
}

export class UploadServiceImpl implements UploadService {
  readonly store: UploadStore;
  private readonly ctx: DaemonContext;
  private readonly files: FileServiceImpl;
  private readonly statfs: StatfsFunction;
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly planTtlMs: number;
  /** uploadId → id of the transfer connection that began / resumed it. */
  private readonly bindings = new Map<string, string>();
  /** Recently committed uploads (COMMITTED_UPLOAD_MEMORY_MS), oldest first: see refuseCommitted. */
  private readonly committed = new Map<string, { readonly userId: UserId; readonly ref: FileRef; readonly at: number }>();
  private readonly plans = new Map<string, PlanReservation>();
  private readonly caseInsensitive = new Map<string, boolean>();
  private stateArea: StagingArea | null = null;
  private shareArea: StagingArea | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(ctx: DaemonContext, files: FileServiceImpl, options: UploadServiceOptions = {}) {
    this.ctx = ctx;
    this.files = files;
    this.statfs = options.statfs ?? nodeStatfs;
    this.ttlMs = options.ttlMs ?? UPLOAD_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? UPLOAD_SWEEP_INTERVAL_MS;
    this.planTtlMs = options.planReservationTtlMs ?? PLAN_RESERVATION_TTL_MS;
    this.store = new UploadStore({ log: ctx.log.child({ module: 'uploads' }) });
  }

  /** Module start: index the partials of both staging areas (resume after a restart), sweep, schedule sweeps. */
  async start(): Promise<void> {
    const dir = await this.ctx.state.privateDir('uploads');
    this.stateArea = { kind: 'state', dir, dev: (await lstat(dir)).dev };
    await this.store.loadArea(this.stateArea);
    const shareDir = join(this.ctx.roots.main.realPath, '.smurg', 'uploads');
    if ((await lstatOrNull(shareDir)) !== null) await this.store.loadArea(await this.ensureShareArea());
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => {}), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Module stop: close handles; partial uploads stay on disk (that is what resume after a restart needs). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.bindings.clear();
    await this.store.closeAll();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // file.upload.plan
  // ---------------------------------------------------------------------------------------------------------------

  async plan(input: PayloadOf<'file.upload.plan'>, conn: ClientConnection, principal: Principal): Promise<ResultInputOf<'file.upload.plan'>> {
    this.refuseIfStopped();
    const rootInfo = this.rootOf(input.root);
    const insensitive = await this.isCaseInsensitive(rootInfo);
    const keyOf = (path: string): string => (insensitive ? relPathSegments(path).map(foldPathName).join('/') : path);
    const problems: { path: string; reason: string }[] = [];
    const fail = (reason: string): never => {
      throw new SmurgError('conflict', msg('upload.nameConflicts'), { reason, paths: problems.slice(0, PLAN_PROBLEMS_LISTED) });
    };
    const tooManyFolders = (): never => {
      throw new SmurgError('too_large', msg('upload.tooManyFolders', { max: UPLOAD_PLAN_MAX_ENTRIES }), { reason: 'too-many-folders' });
    };

    // 1. Inside the batch: two entries for one name, a file that is also the parent of another entry.
    const batch = planBatch(input.entries, insensitive) ?? tooManyFolders();
    const seen = batch.seen;
    for (const problem of batch.problems) problems.push(problem);
    if (problems.length > 0) fail('batch-collision');

    // 2. Every path through PathGuard for writing (host-only, read-only, symlinks, containment) before anything happens.
    const entries = [...seen.values()];
    for (const entry of entries) await this.files.refuseDaemonOwned({ root: input.root, path: entry.path }, principal);
    // Linux: one listing per directory for the NFC → on-disk mapping of the whole plan.
    const spellings = new SpellingIndex();
    const resolved = await mapLimit(entries, PLAN_RESOLVE_CONCURRENCY, (entry) =>
      this.ctx.paths.resolve({ root: input.root, path: entry.path }, { principal, forWrite: true, finalSymlink: 'deny', spellings }),
    );

    // 3. Against what exists.
    const renamed: { from: string; to: string }[] = [];
    const finalPaths = new Map<string, string>();
    const taken = new Set(seen.keys());
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as (typeof entries)[number];
      const target = resolved[i] as ResolvedPath;
      finalPaths.set(entry.path, entry.path);
      if (!target.exists) continue;
      const kind = target.identity?.kind;
      if (entry.kind === 'dir') {
        if (kind !== 'dir') problems.push({ path: entry.path, reason: 'not-a-directory' });
        continue;
      }
      if (kind !== 'file') {
        problems.push({ path: entry.path, reason: 'not-a-file' });
        continue;
      }
      if (input.onConflict === 'fail') {
        problems.push({ path: entry.path, reason: 'exists' });
      } else if (input.onConflict === 'overwrite') {
        await this.files.refuseIfLocked(target, false);
      } else {
        const to = await this.freeName(target, taken, keyOf, spellings);
        renamed.push({ from: entry.path, to });
        finalPaths.set(entry.path, to);
      }
    }
    if (problems.length > 0) fail(problems.every((p) => p.reason === 'exists') ? 'exists' : 'conflict');

    // 4. One disk check for the whole batch.
    const totalBytes = entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0);
    const volume = await this.volumeOf(rootInfo, rootInfo.realPath);
    const disk = await this.report(volume, totalBytes, {});
    if (!disk.ok) this.refuseDisk(disk, principal, { root: input.root, path: entries[0]?.path ?? '' }, 'plan');

    // 5. Directories, also the empty ones, parents first.
    const ordered = planFolders(entries) ?? tooManyFolders();
    const guard = this.files.guard(principal);
    for (const dir of ordered) {
      const ref: FileRef = { root: input.root, path: dir };
      this.files.announce(ref, principal, false);
      const made = await makeDirectory(ref, guard);
      if (made.created) this.files.knownDirs.add(input.root, dir);
    }

    // 6. Reserve the planned bytes until each upload begins (or the reservation expires / the connection closes).
    const reserved = new Map<string, number>();
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.size === 0) continue;
      reserved.set(looseKey(input.root, finalPaths.get(entry.path) as string), entry.size);
    }
    if (reserved.size > 0) {
      this.plans.set(newId('plan'), { userId: conn.userId, connId: conn.id, dev: volume.dev, expiresAt: this.ctx.clock.now() + this.planTtlMs, entries: reserved });
    }
    return { disk, renamed };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // file.upload.begin / hashes / chunk / commit / abort
  // ---------------------------------------------------------------------------------------------------------------

  async begin(input: PayloadOf<'file.upload.begin'>, conn: ClientConnection, principal: Principal): Promise<ResultInputOf<'file.upload.begin'>> {
    this.refuseIfStopped();
    if (input.uploadId !== undefined) await this.refuseCommitted(input.uploadId, conn.userId);
    const identity = { userId: conn.userId, root: input.root, path: input.path, size: input.size, chunkSize: input.chunkSize, lastModified: input.lastModified };
    let upload = input.uploadId !== undefined ? this.store.get(input.uploadId) : this.store.findByIdentity(identity);
    // Another user's id, a different file, a finished upload: never resumed, a new upload starts.
    if (upload && (upload.removed || upload.committing || !matchesIdentity(upload.manifest, identity))) upload = undefined;
    await this.files.refuseDaemonOwned({ root: input.root, path: input.path }, principal);
    const rootInfo = this.rootOf(input.root);
    const target = await this.ctx.paths.resolve({ root: input.root, path: input.path }, { principal, forWrite: true, finalSymlink: 'deny' });
    // A resume may change the policy (the person chose to overwrite after the first attempt found the name taken).
    const onConflict = input.onConflict ?? upload?.onConflict ?? 'fail';
    if (target.exists) {
      if (target.identity?.kind !== 'file') throw new SmurgError('conflict', msg('upload.folderInTheWay'), { reason: 'not-a-file' });
      if (onConflict === 'fail') throw existsError();
    }
    if (onConflict !== 'rename') await this.files.refuseIfLocked(target, false);

    if (upload) {
      const volume = await this.volumeOf(rootInfo, target.realPath);
      const disk = await this.report(volume, upload.remainingBytes, { uploadId: upload.id });
      if (!disk.ok) this.refuseDisk(disk, principal, target.ref, 'resume');
      await this.store.touch(upload);
      upload.onConflict = onConflict;
      this.bindings.set(upload.id, conn.id);
      return { uploadId: upload.id, chunkCount: upload.manifest.chunkCount, have: upload.have.slice(), received: upload.receivedChunks, resumed: true, disk };
    }

    const volume = await this.volumeOf(rootInfo, target.realPath);
    const planKey = { userId: conn.userId, key: looseKey(input.root, target.ref.path) };
    const disk = await this.report(volume, input.size, { plan: planKey });
    if (!disk.ok) this.refuseDisk(disk, principal, target.ref, 'begin');
    const area = await this.areaFor(volume.dev);
    const partials = this.store.list().filter((u) => !u.removed && u.manifest.userId === conn.userId).length;
    if (partials >= MAX_PARTIAL_UPLOADS_PER_USER) {
      throw new SmurgError('conflict', msg('upload.tooManyPartial'), { reason: 'too-many-uploads', limit: MAX_PARTIAL_UPLOADS_PER_USER });
    }
    const manifest: UploadManifest = {
      v: 1,
      uploadId: newId('up'),
      userId: conn.userId,
      root: input.root,
      path: target.ref.path,
      size: input.size,
      chunkSize: input.chunkSize,
      chunkCount: input.size === 0 ? 0 : Math.ceil(input.size / input.chunkSize),
      lastModified: input.lastModified,
      onConflict,
      createdAt: this.ctx.clock.now(),
      targetDev: volume.dev,
    };
    const created = await this.store.create(manifest, area);
    this.consumePlan(planKey);
    this.bindings.set(created.id, conn.id);
    return { uploadId: created.id, chunkCount: manifest.chunkCount, have: created.have.slice(), received: 0, resumed: false, disk };
  }

  async hashes(input: PayloadOf<'file.upload.hashes'>, conn: ClientConnection): Promise<ResultInputOf<'file.upload.hashes'>> {
    const upload = this.requireBound(input.uploadId, conn);
    const from = Math.min(input.from, upload.manifest.chunkCount);
    const count = Math.min(input.count, upload.manifest.chunkCount - from);
    return { hashes: upload.hashes.slice(from * 32, (from + count) * 32) };
  }

  async chunk(input: PayloadOf<'file.upload.chunk'>, conn: ClientConnection): Promise<ResultInputOf<'file.upload.chunk'>> {
    const upload = this.requireBound(input.uploadId, conn);
    if (upload.committing) throw new SmurgError('conflict', msg('upload.committing'), { reason: 'committing' });
    const { index, hash, data } = input;
    if (index >= upload.manifest.chunkCount) throw badRequest('index', msg('upload.chunkIndex'));
    const expected = upload.chunkLength(index);
    if (data.byteLength !== expected) throw badRequest('chunk-length', msg('upload.chunkLength'), { expected, actual: data.byteLength });
    const digest = createHash('sha256').update(data).digest();
    if (!equalBytes(digest, hash)) throw badRequest('hash-mismatch', msg('upload.chunkHashMismatch'), { index });
    if (upload.hasChunk(index)) {
      // A retransmission after a reconnect is harmless; a different content for a stored chunk is not.
      if (!equalBytes(upload.hashOf(index), digest)) throw new SmurgError('conflict', msg('upload.chunkDiffers'), { reason: 'chunk-differs', index });
      return { index };
    }
    try {
      await this.store.writeChunk(upload, index, digest, data);
    } catch (err) {
      if (upload.removed) throw new SmurgError('not_found', msg('upload.cancelled'), { reason: 'unknown-upload' });
      if (errnoCode(err) === 'ENOSPC') {
        const rootInfo = this.rootOf(upload.manifest.root);
        const disk = await this.report({ path: rootInfo.realPath, dev: upload.manifest.targetDev }, upload.remainingBytes, { uploadId: upload.id }).catch(() => null);
        throw new SmurgError('insufficient_disk', msg('upload.diskFull'), disk ? { disk, reason: 'disk-full' } : { reason: 'disk-full' });
      }
      throw err;
    }
    return { index };
  }

  async commit(input: PayloadOf<'file.upload.commit'>, conn: ClientConnection, principal: Principal): Promise<ResultInputOf<'file.upload.commit'>> {
    const upload = this.requireBound(input.uploadId, conn);
    if (upload.committing) throw new SmurgError('conflict', msg('upload.committing'), { reason: 'committing' });
    upload.committing = true;
    let placedOrLost = false;
    try {
      await upload.tail;
      const { manifest } = upload;
      if (!upload.complete) {
        let first = 0;
        while (first < manifest.chunkCount && upload.hasChunk(first)) first++;
        throw badRequest('incomplete', msg('upload.incomplete'), { missing: manifest.chunkCount - upload.receivedChunks, first });
      }
      const root = hashListRoot(manifest.size, manifest.chunkSize, upload.hashes);
      if (!equalBytes(root, input.rootHash)) throw badRequest('hash-mismatch', msg('upload.fileHashMismatch'));
      const handles = await this.store.handlesOf(upload);
      const st = await handles.part.stat();
      if (st.size !== manifest.size) throw new SmurgError('internal', undefined, { reason: 'part-size' });
      await handles.part.sync();
      const staged = identityOf(st);
      const partPath = upload.paths().part;
      // The request was authorised when it arrived; a kick or a demotion since must still stop the file landing.
      if (!this.mayStillWrite(conn.userId)) throw new SmurgError('forbidden', undefined, { reason: 'no-longer-allowed' });
      const placed = await this.place(upload, handles.part, partPath, staged, principal).catch(async (err: unknown) => {
        // A post-move check that removed the file (it landed outside the root) also consumed the staged data.
        if ((await lstatOrNull(partPath)) === null) placedOrLost = true;
        throw err;
      });
      placedOrLost = true;
      await syncDirectory(placed.parentRealPath);
      this.bindings.delete(upload.id);
      this.rememberCommitted(upload.id, conn.userId, placed.ref);
      await this.store.remove(upload);
      this.files.recordMutation(principal, 'file.upload', placed.ref, { size: manifest.size, chunks: manifest.chunkCount, overwrite: placed.overwritten }, msg('activity.fileUpload', { path: shownPath(placed.ref.path) }));
      const entry = await this.files.entryFor(placed.ref);
      if (!entry) throw new SmurgError('not_found', undefined, { reason: 'vanished' });
      return { entry };
    } catch (err) {
      if (placedOrLost) {
        this.bindings.delete(upload.id);
        if (!upload.removed) await this.store.remove(upload);
      } else {
        upload.committing = false;
      }
      throw err;
    }
  }

  private rememberCommitted(uploadId: string, userId: UserId, ref: FileRef): void {
    this.committed.delete(uploadId);
    this.committed.set(uploadId, { userId, ref, at: this.ctx.clock.now() });
    while (this.committed.size > COMMITTED_UPLOADS_REMEMBERED) this.committed.delete(this.committed.keys().next().value as string);
  }

  /**
   * A begin with the id of an upload THIS member committed a moment ago: its commit answer was lost. Answered with
   * `conflict` + reason 'committed' and the file's entry (the client treats it as done), never with a new upload that
   * would collide with the file just placed. Another member's id, or an old one, starts a new upload as before.
   */
  private async refuseCommitted(uploadId: string, userId: UserId): Promise<void> {
    const now = this.ctx.clock.now();
    for (const [id, done] of this.committed) {
      if (now - done.at <= COMMITTED_UPLOAD_MEMORY_MS) break;
      this.committed.delete(id);
    }
    const done = this.committed.get(uploadId);
    if (!done || done.userId !== userId) return;
    const entry = await this.files.entryFor(done.ref);
    throw new SmurgError('conflict', msg('upload.alreadyDone'), { reason: 'committed', path: done.ref.path, ...(entry ? { entry } : {}) });
  }

  async abort(input: PayloadOf<'file.upload.abort'>, conn: ClientConnection): Promise<void> {
    const upload = this.store.get(input.uploadId);
    if (!upload || upload.removed) return; // aborting twice is not an error
    if (upload.manifest.userId !== conn.userId) throw new SmurgError('forbidden', undefined, { reason: 'not-owner' });
    const boundTo = this.bindings.get(upload.id);
    // The owner may cancel from the connection that uploads, or when no live connection holds the upload.
    if (boundTo !== undefined && boundTo !== conn.id && this.ctx.hub.connection(boundTo)?.isOpen) {
      throw new SmurgError('conflict', msg('upload.boundElsewhere'), { reason: 'not-bound' });
    }
    if (upload.committing) throw new SmurgError('conflict', msg('upload.committing'), { reason: 'committing' });
    this.bindings.delete(upload.id);
    await this.store.remove(upload);
  }

  async abortAllForUser(userId: UserId): Promise<void> {
    for (const [id, plan] of this.plans) if (plan.userId === userId) this.plans.delete(id);
    for (const upload of this.store.list()) {
      if (upload.manifest.userId !== userId || upload.committing) continue;
      this.bindings.delete(upload.id);
      await this.store.remove(upload);
    }
  }

  pendingBytes(options: { readonly excludeUploadId?: string } = {}): number {
    let total = 0;
    const devs = new Set<number>();
    for (const upload of this.store.list()) devs.add(upload.manifest.targetDev);
    for (const plan of this.plans.values()) devs.add(plan.dev);
    for (const dev of devs) total += this.pendingOn(dev, options.excludeUploadId !== undefined ? { uploadId: options.excludeUploadId } : {});
    return total;
  }

  async checkDisk(ref: FileRef, requestedBytes: number, options: { readonly excludeUploadId?: string } = {}): Promise<DiskReport> {
    const rootInfo = this.rootOf(ref.root);
    const path = this.ctx.paths.lexical(ref.path, { allowRoot: true });
    const volume = await this.volumeOf(rootInfo, join(rootInfo.realPath, path));
    return this.report(volume, requestedBytes, options.excludeUploadId !== undefined ? { uploadId: options.excludeUploadId } : {});
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Connections, sweep
  // ---------------------------------------------------------------------------------------------------------------

  /** A transfer connection closed: its uploads stay resumable, but nothing is bound to it any more. */
  onConnectionClosed(connId: string): void {
    for (const [id, bound] of [...this.bindings]) {
      if (bound !== connId) continue;
      this.bindings.delete(id);
      const upload = this.store.get(id);
      // Free the file handles of an idle partial upload (they are reopened on resume).
      if (upload && !upload.committing) void this.store.closeHandles(upload).catch(() => {});
    }
    for (const [id, plan] of this.plans) if (plan.connId === connId) this.plans.delete(id);
  }

  /** Removes partial uploads untouched for the TTL (and not in use) and stray staging files. */
  async sweep(): Promise<string[]> {
    const now = this.ctx.clock.now();
    for (const [id, plan] of this.plans) if (plan.expiresAt < now) this.plans.delete(id);
    const areas = [this.stateArea, this.shareArea].filter((a): a is StagingArea => a !== null);
    return this.store.sweep(areas, now, this.ttlMs, (upload) => {
      const bound = this.bindings.get(upload.id);
      return bound !== undefined && this.ctx.hub.connection(bound)?.isOpen === true;
    });
  }

  /** Which connection an upload is bound to (tests). */
  boundConnection(uploadId: string): string | null {
    return this.bindings.get(uploadId) ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------------

  /** Requests still in flight while the daemon stops must not reopen staging files. */
  private refuseIfStopped(): void {
    if (this.stopped) throw new SmurgError('internal', msg('upload.hostStopping'), { reason: 'stopping' });
  }

  /** The member is still active and their current role may write files (fail closed). */
  private mayStillWrite(userId: UserId): boolean {
    const role = this.ctx.members.roleOf(userId);
    return role !== null && can(role, 'file.write');
  }

  private rootOf(root: RootRef): RootInfo {
    const info = this.ctx.roots.get(root);
    if (!info) throw new PathDeniedError('unknown-root', rootRefKey(root));
    return info;
  }

  /** Only the connection that began or resumed an upload may continue it (ARCHITECTURE §5.2). */
  private requireBound(uploadId: string, conn: ClientConnection): StagedUpload {
    this.refuseIfStopped();
    const upload = this.store.get(uploadId);
    if (!upload || upload.removed) throw new SmurgError('not_found', msg('upload.notFound'), { reason: 'unknown-upload' });
    if (upload.manifest.userId !== conn.userId) throw new SmurgError('forbidden', undefined, { reason: 'not-owner' });
    if (this.bindings.get(uploadId) !== conn.id) {
      throw new SmurgError('conflict', msg('upload.beginFirst'), { reason: 'not-bound' });
    }
    return upload;
  }

  private pendingOn(dev: number, exclude: PendingExclusion): number {
    let total = 0;
    for (const upload of this.store.list()) {
      if (upload.removed || upload.manifest.targetDev !== dev || upload.id === exclude.uploadId) continue;
      total += upload.remainingBytes;
    }
    const now = this.ctx.clock.now();
    for (const plan of this.plans.values()) {
      if (plan.dev !== dev || plan.expiresAt < now) continue;
      for (const [key, bytes] of plan.entries) {
        if (exclude.plan && plan.userId === exclude.plan.userId && key === exclude.plan.key) continue;
        total += bytes;
      }
    }
    return total;
  }

  private consumePlan(plan: { readonly userId: UserId; readonly key: string }): void {
    for (const [id, reservation] of this.plans) {
      if (reservation.userId !== plan.userId || !reservation.entries.delete(plan.key)) continue;
      if (reservation.entries.size === 0) this.plans.delete(id);
      return;
    }
  }

  private async report(volume: { readonly path: string; readonly dev: number }, requestedBytes: number, exclude: PendingExclusion): Promise<DiskReport> {
    const snapshot = await this.statfs(volume.path);
    return diskReport(snapshot, this.ctx.settings.get(), this.pendingOn(volume.dev, exclude), requestedBytes);
  }

  private refuseDisk(disk: DiskReport, principal: Principal, ref: FileRef, stage: 'plan' | 'begin' | 'resume'): never {
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'file.upload',
      outcome: 'denied',
      target: refLabel(ref),
      detail: { reason: 'insufficient-disk', stage, requestedBytes: disk.requestedBytes, availableBytes: disk.availableBytes, reserveBytes: disk.reserveBytes, pendingBytes: disk.pendingBytes },
    });
    throw insufficientDiskError(disk, insufficientDiskMessage(disk));
  }

  /** statfs probe for an upload target: its deepest existing ancestor, never outside the root. */
  private async volumeOf(root: RootInfo, absPath: string): Promise<{ readonly path: string; readonly dev: number }> {
    const probe = await probeVolume(absPath);
    if (isInside(probe.path, root.realPath)) return probe;
    return { path: root.realPath, dev: (await lstat(root.realPath)).dev };
  }

  /** The staging area on `dev` (so the commit is a same-volume link or rename). */
  private async areaFor(dev: number): Promise<StagingArea> {
    if (this.stateArea && this.stateArea.dev === dev) return this.stateArea;
    const share = await this.ensureShareArea();
    if (share.dev === dev) return share;
    throw new SmurgError('bad_request', msg('upload.crossDevice'), { reason: 'cross-device' });
  }

  /** `<share>/.smurg/uploads` (0700): staging when the state dir is on another volume (transfer.md §1.4). */
  private async ensureShareArea(): Promise<StagingArea> {
    if (this.shareArea) return this.shareArea;
    const smurgDir = join(this.ctx.roots.main.realPath, '.smurg');
    const dir = join(smurgDir, 'uploads');
    const smurg = await lstatOrNull(smurgDir);
    if (smurg === null || smurg === 'not-directory' || !smurg.isDirectory()) throw new SmurgError('internal', undefined, { reason: 'smurg-dir-missing' });
    await mkdir(dir, { mode: 0o700 }).catch((err: unknown) => (errnoCode(err) === 'EEXIST' ? undefined : Promise.reject(err)));
    const st = await lstatOrNull(dir);
    if (st === null || st === 'not-directory' || !st.isDirectory() || (await realpathOrNull(dir)) !== dir) {
      throw new SmurgError('internal', undefined, { reason: 'staging-dir-invalid' });
    }
    this.shareArea = { kind: 'share', dir, dev: st.dev };
    return this.shareArea;
  }

  /**
   * Whether names in this root are compared case-insensitively. Probed without writing (transfer.md §1.8): lstat the
   * root with the case of its last alphabetic component swapped and compare the inode. Unknown ⇒ insensitive (it
   * only makes the batch collision check stricter).
   */
  private async isCaseInsensitive(root: RootInfo): Promise<boolean> {
    const cached = this.caseInsensitive.get(root.key);
    if (cached !== undefined) return cached;
    let result = true;
    try {
      let dir = root.realPath;
      for (;;) {
        const slash = dir.lastIndexOf('/');
        const base = dir.slice(slash + 1);
        const swapped = [...base].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
        if (swapped !== base) {
          const a = await lstat(dir);
          const b = await lstat(`${dir.slice(0, slash)}/${swapped}`).catch(() => null);
          result = b !== null && a.ino === b.ino && a.dev === b.dev;
          break;
        }
        if (slash <= 0) break;
        dir = dir.slice(0, slash);
      }
    } catch {
      result = true;
    }
    this.caseInsensitive.set(root.key, result);
    return result;
  }

  /**
   * `name (1).ext` … that is neither on disk nor taken by another entry of the batch. Numbered from the REQUEST's
   * spelling, as place() numbers it: `target.name` is the file system's spelling of the entry in the
   * way (`README.md` for a request `readme.md` on APFS, an NFD `café.txt` on Linux), which made the plan promise
   * `README (1).md` and, on Linux, an NFD name that missed the batch's own NFC `café (1).txt`. A candidate counts as on
   * disk under either spelling: PathGuard maps an NFC name onto its one NFD twin (Linux, `spellings`).
   */
  private async freeName(target: ResolvedPath, taken: Set<string>, keyOf: (path: string) => string, spellings: SpellingIndex): Promise<string> {
    const parent = parentRelPath(target.ref.path) ?? '';
    const base = baseNameOfRelPath(target.ref.path);
    for (let n = 1; n <= RENAME_ATTEMPTS; n++) {
      const name = numberedName(base, n);
      const path = parent === '' ? name : `${parent}/${name}`;
      if (taken.has(keyOf(path))) continue;
      if ((await lstatOrNull(join(target.parentRealPath, name))) !== null) continue;
      if ((await spellings.otherSpellings(target.parentRealPath, name)).length > 0) continue;
      taken.add(keyOf(path));
      return path;
    }
    throw existsError();
  }

  /**
   * Moves the verified staging file into place for the upload's conflict policy. The target is resolved through
   * PathGuard right here (the tree may have changed since begin) and re-validated right before the link / rename;
   * PathGuard.checkPlaced removes a file that landed outside the root.
   */
  private async place(
    upload: StagedUpload,
    part: { chmod(mode: number): Promise<void> },
    partPath: string,
    staged: FileIdentity,
    principal: Principal,
  ): Promise<{ readonly ref: FileRef; readonly parentRealPath: string; readonly overwritten: boolean }> {
    const { manifest } = upload;
    await this.files.refuseDaemonOwned({ root: manifest.root, path: manifest.path }, principal);
    const guard = this.files.guard(principal);
    const parent = parentRelPath(manifest.path) ?? '';
    let dirPath = '';
    for (const segment of relPathSegments(parent)) {
      dirPath = dirPath === '' ? segment : `${dirPath}/${segment}`;
      const ref: FileRef = { root: manifest.root, path: dirPath };
      this.files.announce(ref, principal, false);
      const made = await makeDirectory(ref, guard);
      if (made.created) this.files.knownDirs.add(manifest.root, dirPath);
    }
    const options = { principal, forWrite: true, finalSymlink: 'deny' as const };
    const baseName = manifest.path.slice(manifest.path.lastIndexOf('/') + 1);
    const policy = upload.onConflict;
    const attempts = policy === 'rename' ? RENAME_ATTEMPTS + 1 : 1;
    for (let n = 0; n < attempts; n++) {
      const name = n === 0 ? baseName : numberedName(baseName, n);
      const ref: FileRef = { root: manifest.root, path: parent === '' ? name : `${parent}/${name}` };
      const target = await this.ctx.paths.resolve(ref, options);
      if (target.exists && policy === 'rename') continue;
      await this.files.refuseIfLocked(target, false);
      if (target.exists) {
        if (target.identity?.kind !== 'file') throw new SmurgError('conflict', msg('upload.folderInTheWay'), { reason: 'not-a-file' });
        if (policy === 'fail') throw existsError();
        // Overwrite: the new content keeps the replaced file's permissions (like an autosave does).
        await part.chmod((target.identity?.mode ?? 0o644) & 0o7777);
        this.files.announce(ref, principal, false);
        const fresh = await this.ctx.paths.revalidate(target, options);
        await rename(partPath, fresh.realPath);
        await this.ctx.paths.checkPlaced(fresh, staged, options);
        return { ref, parentRealPath: fresh.parentRealPath, overwritten: true };
      }
      await part.chmod(0o666 & ~process.umask());
      this.files.announce(ref, principal, false);
      const fresh = await this.ctx.paths.revalidate(target, options);
      try {
        await placeNoClobber(partPath, fresh.realPath);
      } catch (err) {
        if (err instanceof SmurgError && err.code === 'conflict' && policy === 'rename') continue;
        throw err;
      }
      await this.ctx.paths.checkPlaced(fresh, staged, options);
      return { ref, parentRealPath: fresh.parentRealPath, overwritten: false };
    }
    throw existsError();
  }
}

