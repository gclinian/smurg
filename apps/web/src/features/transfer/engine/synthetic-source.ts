// A File-like upload source whose bytes are computed, never stored: the R7.2 measurement page uploads 10 GB from it
// (no 10 GB file is ever written to disk), and the tests use it to upload megabytes without fixtures.
//
// Byte p is byte (p & 3) of the 32-bit word mix(floor(p / 4), seed), so any slice is reproducible on its own: a
// re-read after a "reload" yields the same bytes and the same chunk hashes, exactly like a real file.
import type { BlobLike, BlobSlice, UploadSourceFile } from './source.ts';

/** A 32-bit integer hash (lowbias32, public domain): cheap, well mixed, deterministic. */
function mix(word: number, seed: number): number {
  let x = (word ^ seed) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Bytes [start, end) of the synthetic stream `seed` (a fresh buffer). */
export function syntheticBytes(seed: number, start: number, end: number): Uint8Array<ArrayBuffer> {
  const length = Math.max(0, end - start);
  const out = new Uint8Array(length);
  if (length === 0) return out;
  const firstWord = Math.floor(start / 4);
  const lastWord = Math.floor((end - 1) / 4);
  // Words are written little-endian through a DataView so the bytes do not depend on the platform's endianness.
  const words = new Uint8Array((lastWord - firstWord + 1) * 4);
  const view = new DataView(words.buffer);
  for (let w = firstWord; w <= lastWord; w++) {
    // The word index can exceed 2^32 for sources above 16 GiB: fold the high part into the seed.
    const high = Math.floor(w / 0x1_0000_0000);
    view.setUint32((w - firstWord) * 4, mix(w >>> 0, (seed ^ Math.imul(high, 0x9e3779b1)) >>> 0), true);
  }
  out.set(words.subarray(start - firstWord * 4, start - firstWord * 4 + length));
  return out;
}

export interface SyntheticSourceOptions {
  readonly size: number;
  readonly seed?: number;
  readonly name?: string;
  readonly lastModified?: number;
}

/** A synthetic source of `size` bytes. Only `slice(a, b).arrayBuffer()` is offered, like the engine requires. */
export function createSyntheticSource(options: SyntheticSourceOptions): UploadSourceFile {
  const { size } = options;
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('size must be a non-negative safe integer');
  const seed = (options.seed ?? 1) >>> 0;
  return {
    name: options.name ?? 'synthetic.bin',
    size,
    lastModified: options.lastModified ?? 1_780_000_000_000,
    slice(start: number, end: number): BlobSlice {
      const a = Math.max(0, Math.min(size, start));
      const b = Math.max(a, Math.min(size, end));
      return { arrayBuffer: () => Promise.resolve(syntheticBytes(seed, a, b).buffer) };
    },
  };
}

/** Where reads of a source happened (tests, the measurement page). */
export interface ReadRecord {
  readonly start: number;
  readonly end: number;
}

export interface InstrumentedSource extends UploadSourceFile {
  readonly reads: readonly ReadRecord[];
  /** Total bytes handed out by slice().arrayBuffer(). */
  readonly bytesRead: number;
  /** Largest single slice ever read. */
  readonly largestRead: number;
}

/**
 * Wraps a source and records every read. Whole-file reads (`arrayBuffer()`, `text()`, `stream()` on the source
 * itself) throw: SPEC R7 forbids loading the whole file.
 */
export function instrumentSource(inner: BlobLike & { readonly name?: string; readonly lastModified?: number }, onRead?: (record: ReadRecord) => void): InstrumentedSource {
  const reads: ReadRecord[] = [];
  let bytesRead = 0;
  let largestRead = 0;
  const refuseWhole = (): never => {
    throw new Error('the whole source was read at once (SPEC R7: never load the whole file)');
  };
  return {
    name: inner.name ?? 'source.bin',
    lastModified: inner.lastModified ?? 1_780_000_000_000,
    size: inner.size,
    get reads() {
      return reads;
    },
    get bytesRead() {
      return bytesRead;
    },
    get largestRead() {
      return largestRead;
    },
    slice(start: number, end: number): BlobSlice {
      const slice = inner.slice(start, end);
      return {
        arrayBuffer: async () => {
          const buffer = await slice.arrayBuffer();
          const record = { start, end: start + buffer.byteLength };
          reads.push(record);
          bytesRead += buffer.byteLength;
          largestRead = Math.max(largestRead, buffer.byteLength);
          onRead?.(record);
          return buffer;
        },
      };
    },
    ...({ arrayBuffer: refuseWhole, text: refuseWhole, stream: refuseWhole } as object),
  };
}
