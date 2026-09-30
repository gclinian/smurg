// Where a download's bytes go (transfer.md §1.7), in this order:
//
// 1. picker — Chromium: a FileSystemFileHandle from showSaveFilePicker() (called by the main thread inside the click
//    handler, before any await) written with createWritable(): straight into the person's file, no second copy.
// 2. opfs — Firefox / Safari: staged in the Origin Private File System with a sync access handle (Worker only), then
//    handed to the page as a File for `<a download>`. Checked the way the research found necessary: the storage
//    estimate BEFORE starting, EVERY write's return value (at quota exhaustion Chromium returned 2^32 − 8 instead of
//    throwing and the file silently stopped growing, F37) and the final size.
// 3. memory — nothing else available, or OPFS too small: a Blob assembled in memory, only up to 512 MiB; above that
//    the person is told honestly to use Chrome or the smurg CLI.
//
// The browser types are described structurally so tests can simulate quota exhaustion and short writes in Node.
import { StorageError } from './failures.ts';
import type { SavedAs } from './types.ts';

export const MEMORY_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
/** Kept free in OPFS beyond the file itself (the browser needs room for its own bookkeeping). */
export const OPFS_MARGIN_BYTES = 64 * 1024 * 1024;
/** OPFS copies older than this are removed when a transfer Worker starts (we cannot see when the browser's save ended). */
export const OPFS_STALE_MS = 60 * 60 * 1000;
export const OPFS_DOWNLOAD_DIR = 'smurg-downloads';

export type DownloadOutput = { readonly kind: 'saved' } | { readonly kind: 'blob'; readonly blob: Blob };

export interface DownloadWriter {
  readonly savedAs: SavedAs;
  /** Bytes written, contiguous from offset 0. */
  readonly written: number;
  /** Once `file.download.begin` answered: `size` is null for zips. Throws StorageError when it cannot fit. */
  prepare(size: number | null): Promise<void>;
  /** `offset` must be where the previous write ended (or earlier, when a resumed download repeats bytes). */
  write(offset: number, data: Uint8Array): Promise<void>;
  /** Drops everything written (a zip download restarts from zero after a reconnect). */
  reset(): Promise<void>;
  /** Checks the final size and closes. */
  finish(totalBytes: number): Promise<DownloadOutput>;
  /** Discards the partial result (best effort). */
  abort(): Promise<void>;
}

function isQuotaError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ((error as { name?: unknown }).name === 'QuotaExceededError' || (error as { code?: unknown }).code === 22);
}

function storageFailure(error: unknown, neededBytes: number | null = null): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(isQuotaError(error) ? 'quota' : 'write-failed', { neededBytes, cause: error });
}

function checkOffset(written: number, offset: number): void {
  // A gap would leave zeros in the saved file: refuse rather than save something that looks complete.
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > written) throw new StorageError('write-failed', { neededBytes: offset });
}

// ---------------------------------------------------------------------------------------------------------------
// 1. showSaveFilePicker + createWritable
// ---------------------------------------------------------------------------------------------------------------

export interface WritableLike {
  write(chunk: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface SaveHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
  getFile(): Promise<{ readonly size: number }>;
}

export class PickerWriter implements DownloadWriter {
  readonly savedAs = 'picker' as const;
  private readonly handle: SaveHandleLike;
  private writable: WritableLike | null = null;
  private end = 0;

  constructor(handle: SaveHandleLike) {
    this.handle = handle;
  }

  get written(): number {
    return this.end;
  }

  /** The picked file is on the person's own disk: there is no estimate to check; a full disk throws on write. */
  async prepare(_size?: number | null): Promise<void> {
    if (this.writable) return;
    try {
      this.writable = await this.handle.createWritable({ keepExistingData: false });
    } catch (error) {
      throw storageFailure(error);
    }
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    checkOffset(this.end, offset);
    try {
      await (this.writable as WritableLike).write({ type: 'write', position: offset, data });
    } catch (error) {
      throw storageFailure(error, offset + data.byteLength);
    }
    this.end = Math.max(this.end, offset + data.byteLength);
  }

  async reset(): Promise<void> {
    await this.writable?.truncate(0);
    this.end = 0;
  }

  async finish(totalBytes: number): Promise<DownloadOutput> {
    if (this.end !== totalBytes) throw new StorageError('size-mismatch', { neededBytes: totalBytes, availableBytes: this.end });
    try {
      await this.writable?.truncate(totalBytes);
      await this.writable?.close();
    } catch (error) {
      throw storageFailure(error, totalBytes);
    }
    this.writable = null;
    const saved = await this.handle.getFile();
    if (saved.size !== totalBytes) throw new StorageError('size-mismatch', { neededBytes: totalBytes, availableBytes: saved.size });
    return { kind: 'saved' };
  }

  async abort(): Promise<void> {
    const writable = this.writable;
    this.writable = null;
    await writable?.abort().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2. OPFS staging (Worker: createSyncAccessHandle)
// ---------------------------------------------------------------------------------------------------------------

export interface SyncAccessHandleLike {
  /** Returns the number of bytes written — which may be wrong without an exception (F37): always compare. */
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  getSize(): number;
  close(): void;
}

export interface OpfsFileHandleLike {
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
  getFile(): Promise<Blob & { readonly lastModified?: number }>;
}

export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  removeEntry(name: string): Promise<void>;
  entries?(): AsyncIterable<[string, { readonly kind: string }]>;
}

export interface OpfsEnv {
  /** The download staging directory (created if missing). */
  directory(): Promise<OpfsDirectoryLike>;
  estimate(): Promise<{ readonly quota?: number; readonly usage?: number }>;
}

export class OpfsWriter implements DownloadWriter {
  readonly savedAs = 'opfs' as const;
  private readonly env: OpfsEnv;
  private readonly fileName: string;
  private dir: OpfsDirectoryLike | null = null;
  private handle: OpfsFileHandleLike | null = null;
  private access: SyncAccessHandleLike | null = null;
  private end = 0;

  constructor(env: OpfsEnv, fileName: string) {
    this.env = env;
    this.fileName = fileName;
  }

  get written(): number {
    return this.end;
  }

  async prepare(size: number | null): Promise<void> {
    if (this.access) return;
    const { quota, usage } = await this.env.estimate();
    const available = quota === undefined ? null : Math.max(0, quota - (usage ?? 0));
    if (size !== null && available !== null && size + OPFS_MARGIN_BYTES > available) {
      throw new StorageError('quota', { neededBytes: size, availableBytes: available });
    }
    try {
      this.dir = await this.env.directory();
      this.handle = await this.dir.getFileHandle(this.fileName, { create: true });
      this.access = await this.handle.createSyncAccessHandle();
      this.access.truncate(0);
    } catch (error) {
      await this.abort();
      throw storageFailure(error, size);
    }
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    checkOffset(this.end, offset);
    const access = this.access as SyncAccessHandleLike;
    let count: number;
    try {
      count = access.write(data, { at: offset });
    } catch (error) {
      throw storageFailure(error, offset + data.byteLength);
    }
    if (count !== data.byteLength) {
      // The quota ran out without an exception (transfer.md F37): the file stopped growing.
      // A count above the chunk length is the bogus value itself: nothing of this chunk is known to be stored.
      const stored = Number.isSafeInteger(count) && count >= 0 && count < data.byteLength ? count : 0;
      throw new StorageError('short-write', { neededBytes: offset + data.byteLength, availableBytes: offset + stored });
    }
    this.end = Math.max(this.end, offset + data.byteLength);
  }

  async reset(): Promise<void> {
    this.access?.truncate(0);
    this.end = 0;
  }

  async finish(totalBytes: number): Promise<DownloadOutput> {
    const access = this.access as SyncAccessHandleLike;
    let size: number;
    try {
      access.flush();
      size = access.getSize();
      access.close();
    } catch (error) {
      throw storageFailure(error, totalBytes);
    }
    this.access = null;
    if (size !== totalBytes || this.end !== totalBytes) throw new StorageError('size-mismatch', { neededBytes: totalBytes, availableBytes: size });
    const file = await (this.handle as OpfsFileHandleLike).getFile();
    if (file.size !== totalBytes) throw new StorageError('size-mismatch', { neededBytes: totalBytes, availableBytes: file.size });
    return { kind: 'blob', blob: file };
  }

  async abort(): Promise<void> {
    try {
      this.access?.close();
    } catch {
      // already closed
    }
    this.access = null;
    await this.dir?.removeEntry(this.fileName).catch(() => {});
  }
}

/**
 * Removes staged downloads older than OPFS_STALE_MS. Files still open elsewhere (another tab's download holds an
 * exclusive sync access handle) cannot be removed and are skipped.
 */
export async function sweepOpfsDownloads(env: OpfsEnv, now: number, maxAgeMs = OPFS_STALE_MS): Promise<number> {
  let removed = 0;
  let dir: OpfsDirectoryLike;
  try {
    dir = await env.directory();
  } catch {
    return 0;
  }
  if (!dir.entries) return 0;
  const names: string[] = [];
  for await (const [name, entry] of dir.entries()) if (entry.kind === 'file') names.push(name);
  for (const name of names) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (now - (file.lastModified ?? 0) < maxAgeMs) continue;
      await dir.removeEntry(name);
      removed++;
    } catch {
      // in use or gone
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Memory (last resort, ≤ 512 MiB)
// ---------------------------------------------------------------------------------------------------------------

export class MemoryWriter implements DownloadWriter {
  readonly savedAs = 'memory' as const;
  private readonly limit: number;
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private end = 0;

  constructor(limit = MEMORY_DOWNLOAD_LIMIT) {
    this.limit = limit;
  }

  get written(): number {
    return this.end;
  }

  async prepare(size: number | null): Promise<void> {
    if (size !== null && size > this.limit) throw new StorageError('too-large-for-memory', { neededBytes: size, availableBytes: this.limit });
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    // Chunks arrive in order; a resumed single-file download starts exactly where the last write ended.
    if (offset !== this.end) throw new StorageError('write-failed', { neededBytes: offset, availableBytes: this.end });
    if (this.end + data.byteLength > this.limit) throw new StorageError('too-large-for-memory', { neededBytes: null, availableBytes: this.limit });
    // The SDK hands out a view on a fresh per-message buffer; copy anyway so the Blob never aliases a larger buffer.
    this.parts.push(new Uint8Array(data));
    this.end += data.byteLength;
  }

  async reset(): Promise<void> {
    this.parts = [];
    this.end = 0;
  }

  async finish(totalBytes: number): Promise<DownloadOutput> {
    if (this.end !== totalBytes) throw new StorageError('size-mismatch', { neededBytes: totalBytes, availableBytes: this.end });
    const blob = new Blob(this.parts, { type: 'application/octet-stream' });
    this.parts = [];
    if (blob.size !== totalBytes) throw new StorageError('size-mismatch', { neededBytes: totalBytes, availableBytes: blob.size });
    return { kind: 'blob', blob };
  }

  async abort(): Promise<void> {
    this.parts = [];
    this.end = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Choice
// ---------------------------------------------------------------------------------------------------------------

export interface WriterEnv {
  /** null where the Worker has no OPFS sync access (then memory is the fallback). */
  readonly opfs: OpfsEnv | null;
  readonly memoryLimit?: number;
}

/**
 * The writer for a download without a picker handle: OPFS when it has room (checked with the estimate), else memory
 * for downloads that fit, else a StorageError the UI explains. Returns a prepared writer.
 */
export async function openAutoWriter(env: WriterEnv, fileName: string, size: number | null): Promise<DownloadWriter> {
  const limit = env.memoryLimit ?? MEMORY_DOWNLOAD_LIMIT;
  if (env.opfs) {
    const opfs = new OpfsWriter(env.opfs, fileName);
    try {
      await opfs.prepare(size);
      return opfs;
    } catch (error) {
      // Too small for this file: memory is only an option below the in-memory limit.
      if (!(error instanceof StorageError) || size === null || size > limit) throw error;
    }
  }
  const memory = new MemoryWriter(limit);
  await memory.prepare(size);
  return memory;
}

/** The OPFS environment of a dedicated Worker, or null where sync access handles are unavailable. */
export function workerOpfsEnv(): OpfsEnv | null {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  const handleProto = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle?.prototype;
  if (!storage || typeof storage.getDirectory !== 'function' || !handleProto || !('createSyncAccessHandle' in handleProto)) return null;
  return {
    async directory() {
      const root = await storage.getDirectory();
      return (await root.getDirectoryHandle(OPFS_DOWNLOAD_DIR, { create: true })) as unknown as OpfsDirectoryLike;
    },
    estimate: () => storage.estimate(),
  };
}
