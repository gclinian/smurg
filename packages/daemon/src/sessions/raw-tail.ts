// Bounded log of the most recent raw PTY output, addressed by absolute byte offset (pty-packaging.md §6.1). A client
// that re-attaches with `haveOffset` still inside the tail (and no resize since) gets the exact bytes it missed
// instead of a full mirror snapshot. Ported from the verified spike (pty-packaging-verify/src/raw-tail.ts).

export class RawTail {
  private chunks: { start: number; buf: Buffer }[] = [];
  private size = 0;
  /** Absolute offset of the first byte still held. */
  private startOffset = 0;
  /** Absolute offset one past the last byte appended. */
  end = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('raw tail capacity must be a positive integer');
    this.capacity = capacity;
  }

  /** Appends one chunk; returns the new end offset. The oldest chunks are dropped beyond the capacity (never the last). */
  append(buf: Buffer): number {
    if (buf.length === 0) return this.end;
    this.chunks.push({ start: this.end, buf });
    this.end += buf.length;
    this.size += buf.length;
    while (this.size > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift() as { start: number; buf: Buffer };
      this.size -= dropped.buf.length;
      this.startOffset = dropped.start + dropped.buf.length;
    }
    return this.end;
  }

  /** Bytes in [from, end), or null when `from` was already evicted or lies in the future (the caller must snapshot). */
  since(from: number): Buffer | null {
    if (!Number.isSafeInteger(from) || from < this.startOffset || from > this.end) return null;
    const parts: Buffer[] = [];
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.buf.length;
      if (chunkEnd <= from) continue;
      parts.push(from > chunk.start ? chunk.buf.subarray(from - chunk.start) : chunk.buf);
    }
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }

  get firstOffset(): number {
    return this.startOffset;
  }

  get bytes(): number {
    return this.size;
  }
}
