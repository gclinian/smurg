// One file's upload over the transfer channel (ARCHITECTURE §5.2, transfer.md §1.3):
//
//   begin (new, or resume by uploadId / by identity) → have bitmap
//   → if the daemon already holds chunks: fetch their hashes (paged) and compare them with LOCAL hashes, re-hashing
//     the local file where this page has none (after a reload); any difference ⇒ abort that partial, start fresh
//   → send only the missing chunks: slice(a, b).arrayBuffer() per chunk (never the whole file), SHA-256 per chunk,
//     at most TRANSFER_WINDOW_CHUNKS unacknowledged (AckWindow), inside the connection's byte budget, and only while
//     the socket's bufferedAmount ≤ 8 MiB (waitForDrain) — both guards, transfer.md gotcha 1
//   → commit with rootHash = SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1) (the protocol's uploadRootHash).
//
// A FileUpload outlives one attempt: after a reconnect `run()` is called again and resumes from the daemon's bitmap
// with the chunk hashes it already has in memory (32 bytes per chunk: 80 KiB for 10 GiB).
import { CHUNK_HASH_BYTES, SmurgError, TRANSFER_WINDOW_CHUNKS, UPLOAD_HASHES_PAGE_MAX, equalBytes, fileEntrySchema, isSmurgError, type FileEntry, type RootRef } from '@smurg/protocol';
import { AckWindow, bitmapHas, isClientRequestError, missingChunks, uploadChunkCount, uploadChunkRange, uploadRootHash } from '@smurg/protocol/client';
import type { Budget } from './limits.ts';
import { TransferInterruptedError, abortReason, hasReason, isConnectivityError, throwIfAborted, type TransferLink } from './link.ts';
import { anySignal } from './signals.ts';
import { SourceUnreadableError, readChunk, type ChunkHasher, type UploadSourceFile } from './source.ts';

export type UploadConflictPolicy = 'fail' | 'overwrite' | 'rename';

export interface FileUploadSpec {
  readonly root: RootRef;
  /** Final path in `root` (after a planned rename). */
  readonly path: string;
  readonly source: UploadSourceFile;
  readonly chunkSize: number;
  /** What the daemon does when `path` exists at commit time. May change after the person answered a conflict. */
  onConflict: UploadConflictPolicy;
  /** An earlier upload of the same file (a journal entry after a reload): resumed if the daemon still has it. */
  uploadId?: string | undefined;
  /** 'abort' instead of committing: measurement runs that must leave nothing on the host. Default 'commit'. */
  readonly finalize?: 'commit' | 'abort';
}

export interface FileUploadDeps {
  readonly link: TransferLink;
  /** Bytes read but not yet acknowledged, across every upload of the connection. */
  readonly budget: Budget;
  readonly hasher: ChunkHasher;
  /** Default TRANSFER_WINDOW_CHUNKS (4). */
  readonly windowChunks?: number;
  /** Attempts per chunk for refusals that a resend can fix (hash mismatch in transit, timeout). Default 3. */
  readonly maxChunkAttempts?: number;
  /** Begins after the daemon's partial turned out unusable or unbound (changed file, lost upload). Default 3. */
  readonly maxRestarts?: number;
  /** After every begin (the journal remembers the uploadId so a reload can resume). */
  onBegin?(info: { readonly uploadId: string; readonly resumed: boolean; readonly received: number }): void | Promise<void>;
  /** Bytes of this file the daemon holds (verified or acknowledged). */
  onProgress?(doneBytes: number, phase: 'verifying' | 'sending'): void;
  /** Every chunk read from the source (tests and the measurement page instrument this). */
  onRead?(index: number, bytes: number): void;
}

/** The file changed on this computer between two reads of the same chunk: uploading it would mix two versions. */
export class SourceChangedError extends SourceUnreadableError {
  override readonly name = 'SourceChangedError';
}

export class FileUpload {
  readonly spec: FileUploadSpec;
  readonly size: number;
  readonly chunkCount: number;
  /** chunkCount × 32 bytes of local SHA-256 digests, valid where `known` has the bit. */
  private readonly hashTable: Uint8Array;
  private readonly known: Uint8Array;
  /** Chunks the daemon has confirmed during the current attempt (bitmap, same layout as `have`). */
  private confirmed: Uint8Array;
  private confirmedBytes = 0;
  private result: FileEntry | null = null;
  private finished = false;

  constructor(spec: FileUploadSpec) {
    this.spec = spec;
    this.size = spec.source.size;
    this.chunkCount = uploadChunkCount(this.size, spec.chunkSize);
    this.hashTable = new Uint8Array(this.chunkCount * CHUNK_HASH_BYTES);
    this.known = new Uint8Array(Math.ceil(this.chunkCount / 8));
    this.confirmed = new Uint8Array(this.known.length);
  }

  get uploadId(): string | undefined {
    return this.spec.uploadId;
  }

  /** Bytes the daemon holds right now, as far as this upload knows. */
  get doneBytes(): number {
    return this.finished ? this.size : this.confirmedBytes;
  }

  get done(): boolean {
    return this.finished;
  }

  get entry(): FileEntry | null {
    return this.result;
  }

  /**
   * One attempt: begin → verify → send the missing chunks → commit. Returns the committed entry (null with
   * `finalize: 'abort'`). Throws TransferInterruptedError when the link dropped or `signal` paused it (call again to
   * resume), the daemon's SmurgError when it refused (conflict, disk, lock, permission), SourceUnreadableError when
   * the local file cannot be read any more.
   */
  async run(deps: FileUploadDeps, signal?: AbortSignal): Promise<FileEntry | null> {
    if (this.finished) return this.result;
    const maxRestarts = deps.maxRestarts ?? 3;
    let restarts = 0;
    const again = (): void => {
      if (++restarts > maxRestarts) throw new SmurgError('conflict', undefined, { reason: 'upload-restarts', local: true });
    };
    for (;;) {
      throwIfAborted(signal);
      try {
        const begin = await deps.link.request('file.upload.begin', this.beginPayload(), { signal });
        if (begin.chunkCount !== this.chunkCount) {
          throw new SmurgError('bad_request', undefined, { reason: 'chunk-count', expected: this.chunkCount, actual: begin.chunkCount, local: true });
        }
        this.spec.uploadId = begin.uploadId;
        this.confirmed = new Uint8Array(this.known.length);
        this.confirmedBytes = 0;
        await deps.onBegin?.({ uploadId: begin.uploadId, resumed: begin.resumed, received: begin.received });
        if (begin.received > 0 && !(await this.verify(deps, begin.have, signal))) {
          // The partial on the host is not this file (it changed since, or it is another file of the same identity).
          again();
          await this.discard(deps.link);
          continue;
        }
        await this.sendMissing(deps, missingChunks(begin.have, this.chunkCount), signal);
        return await this.finish(deps, signal);
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        if (isConnectivityError(error)) throw new TransferInterruptedError('offline');
        if (hasReason(error, 'conflict', 'committed') && this.spec.finalize !== 'abort') {
          // Our commit reached the daemon; only its answer was lost (the socket dropped). The daemon remembers the
          // upload for a few minutes and answers the begin with the committed file: done, not a name conflict.
          const entry = fileEntrySchema.safeParse((error as SmurgError).detail?.['entry']);
          if (entry.success) {
            this.result = entry.data;
            this.finished = true;
            deps.onProgress?.(this.size, 'sending');
            return entry.data;
          }
        }
        if (hasReason(error, 'conflict', 'not-bound')) {
          // Our binding to the upload is gone (the transfer socket was replaced): a begin with the id rebinds it.
          again();
          continue;
        }
        if (hasReason(error, 'not_found', 'unknown-upload')) {
          // The partial was swept or aborted meanwhile: a fresh upload of the same file.
          again();
          this.spec.uploadId = undefined;
          continue;
        }
        if (hasReason(error, 'conflict', 'chunk-differs') || hasReason(error, 'bad_request', 'hash-mismatch')) {
          // The daemon holds different content for a chunk, a chunk kept failing its hash, or the whole-file hash
          // disagrees: throw the partial away and read everything again, consistently.
          again();
          this.forgetHashes();
          await this.discard(deps.link);
          continue;
        }
        if (hasReason(error, 'bad_request', 'incomplete')) {
          // A chunk went missing between its ack and the commit: begin again and send what the bitmap lacks.
          again();
          continue;
        }
        throw error;
      }
    }
  }

  /** Aborts the daemon's partial upload (the person cancelled). Best effort: the daemon also sweeps after 48 h. */
  async cancel(link: TransferLink): Promise<void> {
    if (this.finished || this.spec.uploadId === undefined) return;
    await this.discard(link);
  }

  // ---------------------------------------------------------------------------------------------------------------

  private beginPayload() {
    const { root, path, chunkSize, onConflict, uploadId, source } = this.spec;
    return {
      root,
      path,
      size: this.size,
      chunkSize,
      lastModified: Math.floor(source.lastModified),
      onConflict,
      ...(uploadId !== undefined ? { uploadId } : {}),
    };
  }

  private async finish(deps: FileUploadDeps, signal: AbortSignal | undefined): Promise<FileEntry | null> {
    const uploadId = this.spec.uploadId as string;
    const hashes: Uint8Array[] = [];
    for (let i = 0; i < this.chunkCount; i++) hashes.push(this.hashTable.subarray(i * CHUNK_HASH_BYTES, (i + 1) * CHUNK_HASH_BYTES));
    const rootHash = uploadRootHash(this.size, this.spec.chunkSize, hashes);
    if (this.spec.finalize === 'abort') {
      await deps.link.request('file.upload.abort', { uploadId }, { signal });
      this.finished = true;
      return null;
    }
    const committed = await deps.link.request('file.upload.commit', { uploadId, rootHash }, { signal });
    this.result = committed.entry;
    this.finished = true;
    deps.onProgress?.(this.size, 'sending');
    return committed.entry;
  }

  private async discard(link: TransferLink): Promise<void> {
    const uploadId = this.spec.uploadId;
    this.spec.uploadId = undefined;
    if (uploadId === undefined) return;
    try {
      await link.request('file.upload.abort', { uploadId });
    } catch {
      // Offline or already gone: the daemon sweeps abandoned partials; a fresh begin by identity may find it again,
      // which only costs one more verification.
    }
  }

  /**
   * Compares the daemon's hashes of the chunks it holds with ours. Where this page never hashed a chunk (after a
   * reload), the chunk is read and hashed locally — no upload — one at a time inside the byte budget.
   */
  private async verify(deps: FileUploadDeps, have: Uint8Array, signal: AbortSignal | undefined): Promise<boolean> {
    const uploadId = this.spec.uploadId as string;
    let verified = 0;
    for (let from = 0; from < this.chunkCount; from += UPLOAD_HASHES_PAGE_MAX) {
      const count = Math.min(UPLOAD_HASHES_PAGE_MAX, this.chunkCount - from);
      let any = false;
      for (let i = from; i < from + count && !any; i++) any = bitmapHas(have, i);
      if (!any) continue;
      const page = await deps.link.request('file.upload.hashes', { uploadId, from, count }, { signal });
      for (let i = from; i < from + count; i++) {
        if (!bitmapHas(have, i)) continue;
        const start = (i - from) * CHUNK_HASH_BYTES;
        const theirs = page.hashes.subarray(start, start + CHUNK_HASH_BYTES);
        if (theirs.byteLength !== CHUNK_HASH_BYTES) return false;
        const { length } = uploadChunkRange(this.size, this.spec.chunkSize, i);
        let ours = this.hashOf(i);
        if (ours === null) {
          ours = await this.hashLocally(deps, i, signal);
          this.storeHash(i, ours);
        }
        if (!equalBytes(ours, theirs)) return false;
        this.confirm(i, length);
        verified += length;
        deps.onProgress?.(verified, 'verifying');
      }
    }
    return true;
  }

  private async hashLocally(deps: FileUploadDeps, index: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const { offset, length } = uploadChunkRange(this.size, this.spec.chunkSize, index);
    const release = await deps.budget.acquire(length, signal);
    try {
      const data = await readChunk(this.spec.source, offset, length);
      deps.onRead?.(index, length);
      throwIfAborted(signal);
      return await deps.hasher(data);
    } finally {
      release();
    }
  }

  private async sendMissing(deps: FileUploadDeps, missing: readonly number[], signal: AbortSignal | undefined): Promise<void> {
    if (missing.length === 0) return;
    const window = new AckWindow(deps.windowChunks ?? TRANSFER_WINDOW_CHUNKS);
    // Stops the loop's waits as soon as one chunk fails for good (or the job is paused / cancelled).
    const stop = new AbortController();
    const combined = anySignal(signal, stop.signal);
    const inflight = new Set<Promise<void>>();
    const outcome: { failure: { error: unknown } | null } = { failure: null };
    const fail = (error: unknown): void => {
      outcome.failure ??= { error };
      if (!stop.signal.aborted) stop.abort(new TransferInterruptedError('paused'));
    };
    // A wait that ended because of `combined` reports the pause / cancel reason, not the helper's own 'cancelled'.
    const waitOr = async (wait: Promise<unknown>): Promise<void> => {
      try {
        await wait;
      } catch (error) {
        throw combined.signal.aborted ? abortReason(combined.signal) : error;
      }
    };
    try {
      for (const index of missing) {
        if (outcome.failure !== null) break;
        await waitOr(window.acquire(combined.signal));
        let releaseBudget: (() => void) | null = null;
        let handedOver = false;
        try {
          const { offset, length } = uploadChunkRange(this.size, this.spec.chunkSize, index);
          releaseBudget = await deps.budget.acquire(length, combined.signal);
          await waitOr(deps.link.waitForDrain({ signal: combined.signal }));
          const data = await readChunk(this.spec.source, offset, length);
          deps.onRead?.(index, length);
          throwIfAborted(combined.signal);
          const hash = await deps.hasher(data);
          const previous = this.hashOf(index);
          if (previous !== null && !equalBytes(previous, hash)) throw new SourceChangedError(`chunk ${index} changed since it was first read`);
          this.storeHash(index, hash);
          const release = releaseBudget;
          const task: Promise<void> = this.sendChunk(deps, index, hash, data, combined.signal)
            .then(
              () => {
                this.confirm(index, length);
                deps.onProgress?.(this.confirmedBytes, 'sending');
              },
              (error: unknown) => fail(error),
            )
            .finally(() => {
              window.release();
              release();
              inflight.delete(task);
            });
          inflight.add(task);
          handedOver = true;
        } finally {
          if (!handedOver) {
            window.release();
            releaseBudget?.();
          }
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      await Promise.allSettled([...inflight]);
      combined.dispose();
    }
    if (outcome.failure !== null) {
      if (signal?.aborted) throw abortReason(signal);
      throw outcome.failure.error;
    }
  }

  private async sendChunk(deps: FileUploadDeps, index: number, hash: Uint8Array, data: Uint8Array, signal: AbortSignal): Promise<void> {
    const uploadId = this.spec.uploadId as string;
    const maxAttempts = deps.maxChunkAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        // No request timeout: over a slow uplink a 4 MiB chunk behind a full socket buffer can take minutes. A dead
        // socket is noticed by the relay socket's pong watchdog (6 s) and fails the request as connection-lost.
        await deps.link.request('file.upload.chunk', { uploadId, index, hash, data }, { signal, timeoutMs: 0 });
        return;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableChunkError(error)) throw error;
        throwIfAborted(signal);
      }
    }
  }

  private hashOf(index: number): Uint8Array | null {
    if (!bitmapHas(this.known, index)) return null;
    return this.hashTable.subarray(index * CHUNK_HASH_BYTES, (index + 1) * CHUNK_HASH_BYTES);
  }

  private storeHash(index: number, hash: Uint8Array): void {
    if (hash.byteLength !== CHUNK_HASH_BYTES) throw new RangeError('a chunk hash is 32 bytes');
    this.hashTable.set(hash, index * CHUNK_HASH_BYTES);
    this.known[index >> 3] = (this.known[index >> 3] ?? 0) | (1 << (index & 7));
  }

  private forgetHashes(): void {
    this.known.fill(0);
  }

  private confirm(index: number, length: number): void {
    const byte = index >> 3;
    const bit = 1 << (index & 7);
    const current = this.confirmed[byte] ?? 0;
    if ((current & bit) !== 0) return;
    this.confirmed[byte] = current | bit;
    this.confirmedBytes += length;
  }
}

/** Refusals of one chunk that a resend can fix: corrupted in transit (the daemon re-hashes), or no answer in time. */
export function isRetryableChunkError(error: unknown): boolean {
  if (isClientRequestError(error, 'timeout')) return true;
  return isSmurgError(error) && error.code === 'bad_request' && error.detail?.['reason'] === 'hash-mismatch';
}
