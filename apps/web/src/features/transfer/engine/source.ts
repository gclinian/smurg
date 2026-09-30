// What an upload reads from: a File (from a drop, a picker or a stored handle) or anything with the same slicing
// contract (the synthetic 10 GB source of the measurement page, instrumented fakes in tests).
//
// The one rule (SPEC R7 「不能把整個檔案載入記憶體」, transfer.md gotcha 4): a source is only ever read with
// `slice(a, b).arrayBuffer()`, one chunk at a time. Never `arrayBuffer()` / `text()` / `stream()` on the whole file.

export interface BlobSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BlobLike {
  readonly size: number;
  slice(start: number, end: number): BlobSlice;
}

/** A file to upload: its bytes, plus the identity the daemon resumes by (size + lastModified, ARCHITECTURE §5.2). */
export interface UploadSourceFile extends BlobLike {
  readonly name: string;
  /** `File.lastModified` (epoch ms). */
  readonly lastModified: number;
}

/** The local file changed or vanished while it was being uploaded (Chrome: NotReadableError on the slice). */
export class SourceUnreadableError extends Error {
  override readonly name: string = 'SourceUnreadableError';
}

/**
 * Reads bytes [offset, offset + length) of `source` as a fresh Uint8Array. A short read means the file shrank after it
 * was chosen: that is refused rather than uploaded as a truncated chunk.
 */
export async function readChunk(source: BlobLike, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  let buffer: ArrayBuffer;
  try {
    buffer = await source.slice(offset, offset + length).arrayBuffer();
  } catch (error) {
    throw new SourceUnreadableError('the local file could not be read', { cause: error });
  }
  if (buffer.byteLength !== length) throw new SourceUnreadableError(`expected ${length} bytes at ${offset}, read ${buffer.byteLength}`);
  return new Uint8Array(buffer);
}

/** SHA-256 of one chunk (32 bytes). */
export type ChunkHasher = (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

/**
 * WebCrypto SHA-256: 2–4 ms per 4 MiB chunk in current engines (transfer.md F17 as corrected), off the UI thread
 * because the engine runs in the transfer Worker. There is no streaming digest in WebCrypto, hence the hash-list root.
 */
export const subtleSha256: ChunkHasher = async (data) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
