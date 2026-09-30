// Durable staging of uploads (transfer.md §1.4, with the verifier's corrections). Per upload, in a private (0700)
// staging directory:
//
//   <id>.json   manifest, written once (tmp + fsync + rename), 0600
//   <id>.log    journal: one line "<index> <sha256 hex>\n" per durable chunk, append-only, 0600
//   <id>.part   data, positional writes, 0600
//
// Per chunk: pwrite → fdatasync → journal line → ack. A journal line therefore always means durable data; a lost
// line only costs a re-send, and a torn last line (crash mid-append) fails the regex and is ignored. Chunk writes of
// one upload are serialized. Opening the files is memoized (the in-flight promise, not only the result): two chunks
// racing after a daemon restart must share one pair of handles and one bitmap, or bits are lost (verified in the
// research). Everything on disk is re-validated when it is read back; the directories are daemon-private.
import { constants as fsConstants } from 'node:fs';
import { open, readFile, readdir, rename, stat, unlink, utimes, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  CHUNK_HASH_BYTES,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  UPLOAD_CONFLICT_POLICIES,
  entryPathSchema,
  rootRefKey,
  rootRefSchema,
  type RootRef,
} from '@smurg/protocol';
import type { Logger } from '../core/logger.ts';
import { syncDirectory } from '../core/state-store.ts';
import { errnoCode } from '../workspace/fs-util.ts';

/** `newId('up')`: exactly what the daemon issues. Anything else never becomes part of a file name. */
export const UPLOAD_ID_PATTERN = /^up_[A-Za-z0-9_-]{22}$/;
const STAGING_FILE = /^(up_[A-Za-z0-9_-]{22})\.(json|log|part)$/;
const STAGING_TMP = /^\.up_[A-Za-z0-9_-]{22}\.json\.[0-9a-f]{12}\.tmp$/;
const JOURNAL_LINE = /^(\d{1,15}) ([0-9a-f]{64})$/;
const FILE_MODE = 0o600;

export const manifestSchema = z.strictObject({
  v: z.literal(1),
  uploadId: z.string().regex(UPLOAD_ID_PATTERN),
  userId: z.string().min(1).max(256),
  root: rootRefSchema,
  path: entryPathSchema,
  size: z.int().min(0),
  chunkSize: z.int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
  chunkCount: z.int().min(0),
  lastModified: z.int(),
  onConflict: z.enum(UPLOAD_CONFLICT_POLICIES),
  createdAt: z.int(),
  /** Device of the volume the file will be committed to (the disk rule counts pending bytes per volume). */
  targetDev: z.int(),
});
export type UploadManifest = z.output<typeof manifestSchema>;

export interface StagingArea {
  /** 'state': ~/.smurg/workspaces/<id>/uploads; 'share': <share>/.smurg/uploads (the state dir is on another volume). */
  readonly kind: 'state' | 'share';
  readonly dir: string;
  readonly dev: number;
}

interface Handles {
  readonly part: FileHandle;
  readonly journal: FileHandle;
}

export class StagedUpload {
  readonly manifest: UploadManifest;
  readonly area: StagingArea;
  /** Bit `i & 7` of byte `i >> 3`: chunk i is durable. */
  readonly have: Uint8Array;
  /** 32 bytes per chunk (zeros where missing). */
  readonly hashes: Uint8Array;
  receivedChunks = 0;
  receivedBytes = 0;
  /** Conflict policy of the commit: the manifest's, or what the latest begin (resume) asked for. */
  onConflict: UploadManifest['onConflict'];
  /** Removed (committed, aborted, swept): every later operation fails. */
  removed = false;
  committing = false;
  handles: Promise<Handles> | null = null;
  /** Serializes chunk writes (and waits for them before commit / close). */
  tail: Promise<void> = Promise.resolve();

  constructor(manifest: UploadManifest, area: StagingArea) {
    this.manifest = manifest;
    this.area = area;
    this.onConflict = manifest.onConflict;
    this.have = new Uint8Array(Math.ceil(manifest.chunkCount / 8));
    this.hashes = new Uint8Array(manifest.chunkCount * CHUNK_HASH_BYTES);
  }

  get id(): string {
    return this.manifest.uploadId;
  }

  get remainingBytes(): number {
    return this.manifest.size - this.receivedBytes;
  }

  hasChunk(index: number): boolean {
    return ((this.have[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
  }

  chunkLength(index: number): number {
    const { size, chunkSize, chunkCount } = this.manifest;
    return index === chunkCount - 1 ? size - index * chunkSize : chunkSize;
  }

  hashOf(index: number): Uint8Array {
    return this.hashes.subarray(index * CHUNK_HASH_BYTES, (index + 1) * CHUNK_HASH_BYTES);
  }

  markChunk(index: number, digest: Uint8Array): void {
    if (this.hasChunk(index)) return;
    this.have[index >> 3] = (this.have[index >> 3] ?? 0) | (1 << (index & 7));
    this.hashes.set(digest, index * CHUNK_HASH_BYTES);
    this.receivedChunks++;
    this.receivedBytes += this.chunkLength(index);
  }

  get complete(): boolean {
    return this.receivedChunks === this.manifest.chunkCount;
  }

  paths(): { readonly manifest: string; readonly journal: string; readonly part: string } {
    const base = join(this.area.dir, this.manifest.uploadId);
    return { manifest: `${base}.json`, journal: `${base}.log`, part: `${base}.part` };
  }
}

export interface UploadIdentity {
  readonly userId: string;
  readonly root: RootRef;
  readonly path: string;
  readonly size: number;
  readonly chunkSize: number;
  readonly lastModified: number;
}

export function matchesIdentity(manifest: UploadManifest, identity: UploadIdentity): boolean {
  return (
    manifest.userId === identity.userId &&
    rootRefKey(manifest.root) === rootRefKey(identity.root) &&
    manifest.path === identity.path &&
    manifest.size === identity.size &&
    manifest.chunkSize === identity.chunkSize &&
    manifest.lastModified === identity.lastModified
  );
}

export class UploadStore {
  private readonly log: Logger;
  private readonly uploads = new Map<string, StagedUpload>();
  /** Ids whose files are being created right now: a concurrent sweep must not take them for strays. */
  private readonly creating = new Set<string>();

  constructor(options: { readonly log: Logger }) {
    this.log = options.log;
  }

  get(uploadId: string): StagedUpload | undefined {
    return this.uploads.get(uploadId);
  }

  list(): StagedUpload[] {
    return [...this.uploads.values()];
  }

  findByIdentity(identity: UploadIdentity): StagedUpload | undefined {
    for (const upload of this.uploads.values()) if (!upload.removed && matchesIdentity(upload.manifest, identity)) return upload;
    return undefined;
  }

  /**
   * Indexes every partial upload of a staging area (daemon start): manifest validated, journal replayed into the
   * bitmap. Stray files (a part or journal without manifest, a manifest temp file, an invalid manifest) are removed.
   */
  async loadArea(area: StagingArea): Promise<void> {
    let names: string[];
    try {
      names = await readdir(area.dir);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return;
      throw err;
    }
    const byId = new Map<string, Set<string>>();
    for (const name of names) {
      if (STAGING_TMP.test(name)) {
        await unlink(join(area.dir, name)).catch(() => {});
        continue;
      }
      const match = STAGING_FILE.exec(name);
      if (!match) continue; // not ours: never touch it
      const id = match[1] as string;
      const set = byId.get(id) ?? new Set<string>();
      set.add(match[2] as string);
      byId.set(id, set);
    }
    for (const [id, kinds] of byId) {
      if (this.uploads.has(id) || this.creating.has(id)) continue;
      const upload = kinds.has('json') && kinds.has('part') ? await this.readUpload(id, area) : null;
      if (upload) {
        this.uploads.set(id, upload);
        continue;
      }
      for (const kind of kinds) await unlink(join(area.dir, `${id}.${kind}`)).catch(() => {});
    }
  }

  /** Creates the three files of a new upload (manifest last-written-wins is impossible: `wx` everywhere). */
  async create(manifest: UploadManifest, area: StagingArea): Promise<StagedUpload> {
    const upload = new StagedUpload(manifest, area);
    const files = upload.paths();
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    this.creating.add(manifest.uploadId);
    try {
      await (await open(files.part, flags, FILE_MODE)).close();
      await (await open(files.journal, flags, FILE_MODE)).close();
      const tmp = join(area.dir, `.${manifest.uploadId}.json.${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(tmp, flags, FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify(manifest));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, files.manifest);
      await syncDirectory(area.dir);
      this.uploads.set(manifest.uploadId, upload);
    } catch (err) {
      await Promise.all([files.part, files.journal, files.manifest].map((p) => unlink(p).catch(() => {})));
      throw err;
    } finally {
      this.creating.delete(manifest.uploadId);
    }
    return upload;
  }

  /** The open part + journal handles (memoized, including while the open is in flight). */
  handlesOf(upload: StagedUpload): Promise<Handles> {
    if (upload.handles === null) {
      const files = upload.paths();
      const opening = (async (): Promise<Handles> => {
        const part = await open(files.part, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
        try {
          const journal = await open(files.journal, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
          return { part, journal };
        } catch (err) {
          await part.close().catch(() => {});
          throw err;
        }
      })();
      upload.handles = opening;
      opening.catch(() => {
        if (upload.handles === opening) upload.handles = null;
      });
    }
    return upload.handles;
  }

  /**
   * Makes chunk `index` durable: pwrite → fdatasync → journal line → bitmap. Serialized per upload. The caller has
   * verified length and hash; a chunk that is already durable is a no-op.
   */
  writeChunk(upload: StagedUpload, index: number, digest: Uint8Array, data: Uint8Array): Promise<void> {
    const run = async (): Promise<void> => {
      if (upload.removed) throw new Error('upload removed');
      if (upload.hasChunk(index)) return;
      const { part, journal } = await this.handlesOf(upload);
      let written = 0;
      while (written < data.byteLength) {
        const { bytesWritten } = await part.write(data, written, data.byteLength - written, index * upload.manifest.chunkSize + written);
        written += bytesWritten;
      }
      await part.datasync();
      await journal.appendFile(`${index} ${Buffer.from(digest).toString('hex')}\n`);
      upload.markChunk(index, digest);
    };
    const result = upload.tail.then(run);
    upload.tail = result.catch(() => {});
    return result;
  }

  /** Marks activity (the sweep's TTL counts from the journal's mtime). */
  async touch(upload: StagedUpload): Promise<void> {
    const now = new Date();
    await utimes(upload.paths().journal, now, now).catch(() => {});
  }

  /** Closes the handles once pending writes finished (the upload stays on disk, resumable). */
  async closeHandles(upload: StagedUpload): Promise<void> {
    await upload.tail;
    const handles = upload.handles;
    upload.handles = null;
    if (!handles) return;
    const opened = await handles.catch(() => null);
    if (!opened) return;
    await opened.part.close().catch(() => {});
    await opened.journal.close().catch(() => {});
  }

  /** Forgets the upload and deletes its staging files (abort, sweep, kick; commit after the part was moved). */
  async remove(upload: StagedUpload): Promise<void> {
    upload.removed = true;
    if (this.uploads.get(upload.id) === upload) this.uploads.delete(upload.id);
    await this.closeHandles(upload);
    const files = upload.paths();
    for (const path of [files.part, files.journal, files.manifest]) {
      await unlink(path).catch((err: unknown) => {
        if (errnoCode(err) !== 'ENOENT') this.log.warn('could not remove a staging file', { error: errnoCode(err) ?? 'unknown' });
      });
    }
  }

  /**
   * Removes partial uploads nobody touched for `ttlMs` (journal and manifest mtime) and that are not in use
   * (`inUse`), plus stray files of every area. Returns the removed upload ids.
   */
  async sweep(areas: readonly StagingArea[], now: number, ttlMs: number, inUse: (upload: StagedUpload) => boolean): Promise<string[]> {
    const removed: string[] = [];
    for (const upload of this.list()) {
      if (upload.committing || inUse(upload)) continue;
      const files = upload.paths();
      let last = 0;
      for (const path of [files.journal, files.manifest]) {
        const st = await stat(path).catch(() => null);
        if (st) last = Math.max(last, st.mtimeMs);
      }
      if (now - last > ttlMs) {
        await this.remove(upload);
        removed.push(upload.id);
      }
    }
    for (const area of areas) await this.loadArea(area); // also clears strays next to the live uploads
    return removed;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((upload) => this.closeHandles(upload)));
  }

  private async readUpload(id: string, area: StagingArea): Promise<StagedUpload | null> {
    const base = join(area.dir, id);
    try {
      const raw = JSON.parse(await readFile(`${base}.json`, 'utf8')) as unknown;
      const parsed = manifestSchema.safeParse(raw);
      if (!parsed.success) return null;
      const manifest = parsed.data;
      const expectedCount = manifest.size === 0 ? 0 : Math.ceil(manifest.size / manifest.chunkSize);
      if (manifest.uploadId !== id || manifest.chunkCount !== expectedCount || !Number.isSafeInteger(manifest.size)) return null;
      const upload = new StagedUpload(manifest, area);
      let journal = '';
      try {
        journal = await readFile(`${base}.log`, 'utf8');
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw err;
      }
      for (const line of journal.split('\n')) {
        const match = JOURNAL_LINE.exec(line);
        if (!match) continue;
        const index = Number(match[1]);
        if (index >= manifest.chunkCount) continue;
        upload.markChunk(index, Buffer.from(match[2] as string, 'hex'));
      }
      return upload;
    } catch (err) {
      this.log.warn('unreadable partial upload removed', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
  }
}
