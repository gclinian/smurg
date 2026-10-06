// The full-text store of the audit log (ARCHITECTURE §5.8): entries that carry a full text a person or an agent wrote
// (a message, a suggestion, a command, a note) keep its SHA-256 and its first characters; the whole text is here,
// keyed by that hash, in its own rotating files (audit-text.jsonl, .1, .2: 3 × 32 MiB by default, 0600). So volume
// from a member who loops suggestions rotates THESE files, never the core log with its role changes and decisions.
//
// One line per text: {"sha256": "…", "at": 1727000000000, "text": "…"}. Appends are serialized; a text already
// written since the last rotation is not written again.
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import { readLinesBackward, terminateTornLine } from './audit.ts';
import type { Clock } from './lifecycle.ts';
import type { Logger } from './logger.ts';

export interface AuditTextStoreOptions {
  readonly clock: Clock;
  readonly log: Logger;
  /** Rotate when the current file would grow beyond this many bytes (default 32 MiB). */
  readonly maxBytes?: number;
  /** Files kept in all (default 3: the current one and two rotated). */
  readonly files?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_FILES = 3;
/** Hashes remembered as "already in the current file" (bounds memory; a miss only writes a text twice). */
const SEEN_MAX = 50_000;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function rotatedPath(path: string, n: number): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.${n}.jsonl` : `${path}.${n}`;
}

async function openAppend(path: string): Promise<FileHandle> {
  return open(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
}

export class AuditTextStore {
  private readonly path: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly maxBytes: number;
  private readonly files: number;
  private handle: FileHandle | null;
  private size: number;
  private readonly seen = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(path: string, handle: FileHandle, size: number, options: AuditTextStoreOptions) {
    this.path = path;
    this.handle = handle;
    this.size = size;
    this.clock = options.clock;
    this.log = options.log;
    this.maxBytes = Math.max(4_096, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.files = Math.max(1, Math.floor(options.files ?? DEFAULT_FILES));
  }

  static async open(path: string, options: AuditTextStoreOptions): Promise<AuditTextStore> {
    const handle = await openAppend(path);
    try {
      let { size } = await handle.stat();
      if (await terminateTornLine(handle, size)) size += 1;
      return new AuditTextStore(path, handle, size, options);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /** Queues `text` for the store and returns its hash at once (record() is synchronous). */
  put(text: string): string {
    const sha256 = sha256Hex(text);
    if (this.closed || this.seen.has(sha256)) return sha256;
    if (this.seen.size >= SEEN_MAX) this.seen.clear();
    this.seen.add(sha256);
    const line = `${JSON.stringify({ sha256, at: this.clock.now(), text })}\n`;
    this.tail = this.tail.then(() => this.append(line));
    return sha256;
  }

  /** The text stored under `sha256` (newest file first), or null. */
  async get(sha256: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    let found: string | null = null;
    const scan = (line: string): boolean => {
      // Cheap filter first: most lines are other texts, and each can be tens of kilobytes.
      if (!line.startsWith(`{"sha256":"${sha256}"`)) return true;
      try {
        const parsed = JSON.parse(line) as { text?: unknown };
        if (typeof parsed.text === 'string' && sha256Hex(parsed.text) === sha256) found = parsed.text;
      } catch {
        // a torn line
      }
      return found === null;
    };
    const read = this.tail.then(async () => {
      if (this.handle) await readLinesBackward(this.handle, scan);
      for (let n = 1; n < this.files && found === null; n += 1) {
        const rotated = await open(rotatedPath(this.path, n), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
        if (rotated === null) break;
        try {
          await readLinesBackward(rotated, scan);
        } finally {
          await rotated.close();
        }
      }
    });
    this.tail = read.then(
      () => {},
      () => {},
    );
    await read;
    return found;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.handle?.close();
    this.handle = null;
  }

  private async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
      if (!this.handle) throw new Error('audit text store is not open');
      await this.handle.appendFile(line, 'utf8');
      this.size += bytes;
    } catch (err) {
      // The entry in the core log keeps the hash and the first characters; only the whole text is lost.
      this.log.error('audit full text not written', { error: typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** audit-text.jsonl → .1 → … (the oldest is replaced); a fresh 0600 file. What rotates away is forgotten here too. */
  private async rotate(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
    try {
      for (let n = this.files - 2; n >= 1; n -= 1) {
        await rename(rotatedPath(this.path, n), rotatedPath(this.path, n + 1)).catch((err: unknown) => {
          if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
        });
      }
      if (this.files > 1) await rename(this.path, rotatedPath(this.path, 1));
    } finally {
      this.handle = await openAppend(this.path);
      if (this.files <= 1) await this.handle.truncate(0);
      this.size = (await this.handle.stat()).size;
      this.seen.clear();
    }
  }
}
