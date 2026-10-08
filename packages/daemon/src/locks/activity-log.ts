// activity.jsonl (ARCHITECTURE §7.1): the activity feed on the host's disk, one ActivityEvent per line, private (0600,
// no symlink, ours). Bounded: when the file would grow beyond maxBytes it becomes activity.1.jsonl (the previous one is
// dropped), so the feed keeps roughly the last 2 × maxBytes of history. Queries read backwards from the end in blocks
// (readLinesBackward), so paging never loads a whole file.
import { constants as fsConstants } from 'node:fs';
import { rename, type FileHandle } from 'node:fs/promises';
import { activityEventSchema, type ActivityEvent } from '@smurg/protocol';
import { readLinesBackward, terminateTornLine } from '../core/audit.ts';
import type { Logger } from '../core/logger.ts';
import { openPrivateFile } from '../core/private-file.ts';
import { StateFileError } from '../core/state-file-error.ts';

export const ACTIVITY_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** The log object was used after close(). (A refusal of the FILE is a StateFileError with its kind.) */
export class ActivityLogError extends Error {
  constructor(path: string, message: string) {
    super(`${message}: ${path}`);
    this.name = 'ActivityLogError';
  }
}

/**
 * Opens a log file, refusing a symlink, a non-regular file, a foreign owner or any group/other permission bit: a
 * StateFileError with its kind (`insecure` with the cause, `cannot-open` with the errno), as for every file of the
 * workspace folder. Null when the file does not exist and is not created.
 */
function openPrivate(path: string, flags: number): Promise<FileHandle | null> {
  return openPrivateFile(path, flags, { what: 'activity log' });
}

function parse(line: string): ActivityEvent | null {
  try {
    const parsed = activityEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // a torn last line after a crash
  }
}

function rotatedPath(path: string): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.1.jsonl` : `${path}.1`;
}

export interface ActivityQuery {
  readonly limit: number;
  /** Only events with `at < before`. */
  readonly before?: number;
  /** Events the caller may see (checked before counting, so a page is never short because of filtering). */
  readonly accept?: (event: ActivityEvent) => boolean;
}

export class ActivityLogFile {
  private readonly path: string;
  private readonly log: Logger;
  private readonly maxBytes: number;
  private handle: FileHandle | null = null;
  private size = 0;
  private opening: Promise<void> | null = null;
  /** Appends, rotations and queries run one after another. */
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(path: string, options: { readonly log: Logger; readonly maxBytes?: number }) {
    this.path = path;
    this.log = options.log;
    this.maxBytes = Math.max(4_096, options.maxBytes ?? ACTIVITY_LOG_MAX_BYTES);
  }

  /** Opens (creating 0600) and returns the `at` of the newest event on file (0 when empty). */
  async open(): Promise<number> {
    await this.ensureOpen();
    let lastAt = 0;
    const find = async (handle: FileHandle): Promise<void> => {
      await readLinesBackward(handle, (line) => {
        const event = parse(line);
        if (!event) return true;
        lastAt = event.at;
        return false;
      });
    };
    if (this.handle) await find(this.handle);
    if (lastAt === 0) {
      const previous = await openPrivate(rotatedPath(this.path), fsConstants.O_RDONLY);
      if (previous) {
        try {
          await find(previous);
        } finally {
          await previous.close();
        }
      }
    }
    return lastAt;
  }

  append(event: ActivityEvent): void {
    if (this.closed) {
      this.log.warn('activity event after close', { kind: event.kind });
      return;
    }
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    this.tail = this.tail.then(async () => {
      try {
        await this.ensureOpen();
        if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
        if (!this.handle) throw new Error('activity log is not open');
        await this.handle.appendFile(line, 'utf8');
        this.size += bytes;
      } catch (err) {
        this.log.error('activity append failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    });
  }

  /** Newest first, across the current file and activity.1.jsonl. */
  async query(query: ActivityQuery): Promise<ActivityEvent[]> {
    const before = query.before ?? Number.POSITIVE_INFINITY;
    const out: ActivityEvent[] = [];
    const collect = (line: string): boolean => {
      const event = parse(line);
      if (event && event.at < before && (query.accept?.(event) ?? true)) out.push(event);
      return out.length < query.limit;
    };
    const page = this.tail.then(async () => {
      await this.ensureOpen();
      if (this.handle) await readLinesBackward(this.handle, collect);
      if (out.length >= query.limit) return;
      const previous = await openPrivate(rotatedPath(this.path), fsConstants.O_RDONLY);
      if (!previous) return;
      try {
        await readLinesBackward(previous, collect);
      } finally {
        await previous.close();
      }
    });
    this.tail = page.then(
      () => {},
      () => {},
    );
    await page;
    return out;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.opening?.catch(() => {});
    await this.handle?.close();
    this.handle = null;
  }

  private ensureOpen(): Promise<void> {
    if (this.handle) return Promise.resolve();
    if (this.closed) return Promise.reject(new ActivityLogError(this.path, 'activity log is closed'));
    this.opening ??= (async () => {
      const handle = await openPrivate(this.path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT);
      if (!handle) throw new StateFileError({ kind: 'cannot-open', errno: 'ENOENT', path: this.path, message: 'cannot open the activity log (ENOENT)' });
      this.handle = handle;
      this.size = (await handle.stat()).size;
      // A crash during a write can leave a last line without its newline: the next event would be glued onto it and
      // lost to every reader. Terminate it first.
      if (await terminateTornLine(handle, this.size)) {
        this.size += 1;
        this.log.warn('activity log ended in a torn line (crash during a write?); continuing on a new line', {});
      }
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** activity.jsonl → activity.1.jsonl (replacing it); a fresh 0600 activity.jsonl. */
  private async rotate(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
    try {
      await rename(this.path, rotatedPath(this.path));
    } finally {
      await this.ensureOpen();
    }
  }
}
