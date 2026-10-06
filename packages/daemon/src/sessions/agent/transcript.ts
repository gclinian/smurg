// The conversation log of one agent session on the host (ARCHITECTURE §7.6 "Transcript"; DESIGN §2.4, AD-4):
//
//   <workspace state dir>/transcripts/<hex(sessionId)>/         0700; files 0600
//     events-000001.jsonl, events-000002.jsonl, …               one ConversationEvent per line: { v: 1, seq, at, kind, … }
//
// Append-only SEGMENTS (a new file when the current one reaches `segmentBytes`), written through ONE serialized writer:
// buffered up to `flushMs` or `flushBytes`, fsync when the caller says so (every turn.finished and every card event). A
// torn last line (the daemon died mid-write) is terminated at open. `seq` starts at 1 and never repeats. Never stored:
// text deltas, thinking, file contents of reads, matched lines of searches, raw Claude Code lines.
//
// Reading is THE page rule (EVENTS_PAGE_MAX events and EVENTS_PAGE_MAX_BYTES, at least one event). Redaction rewrites
// the one segment atomically with the event replaced under the same `seq`. Trimming unlinks the oldest whole segment,
// never one that holds the event of an open card; no file is rewritten for it.
import { constants as fsConstants, type Stats } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { EVENTS_PAGE_MAX, EVENTS_PAGE_MAX_BYTES, conversationEventSchema, encodedSize, takeWithinBytes, type CardRef, type ConversationEvent, type ConversationEventInput } from '@smurg/protocol';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import type { EventsPage } from '../../core/interfaces.ts';

export interface TranscriptOptions {
  readonly segmentBytes: number;
  readonly flushMs: number;
  readonly flushBytes: number;
  /** Reports a write that failed (the events stay in memory and are tried again with the next flush). */
  readonly onError?: (err: unknown) => void;
}

interface Segment {
  readonly index: number;
  readonly path: string;
  /** `seq` of its first event (0: the segment is empty). */
  firstSeq: number;
  bytes: number;
}

const SEGMENT_NAME = /^events-(\d{6})\.jsonl$/;
const segmentName = (index: number): string => `events-${String(index).padStart(6, '0')}.jsonl`;

export type PageFrom = { readonly newest: true } | { readonly after: number } | { readonly before: number };

function parseLine(line: string): ConversationEvent | null {
  if (line.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { v: _version, ...rest } = raw as Record<string, unknown>;
  const parsed = conversationEventSchema.safeParse(rest);
  return parsed.success ? parsed.data : null;
}

function lineOf(event: ConversationEvent): string {
  return `${JSON.stringify({ v: 1, ...event })}\n`;
}

export class Transcript {
  readonly dir: string;
  private readonly options: TranscriptOptions;
  private segments: Segment[] = [];
  private last = 0;
  private handle: FileHandle | null = null;
  /** Appended, not on disk yet. */
  private pending: ConversationEvent[] = [];
  private pendingBytes = 0;
  private pendingSync = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /** Parsed events of the segments read last (at most two). */
  private readonly cache = new Map<number, ConversationEvent[]>();
  private closed = false;

  private constructor(dir: string, options: TranscriptOptions) {
    this.dir = dir;
    this.options = options;
  }

  /** Opens (or creates) the log in `dir`; `dir`'s parent must exist. */
  static async open(dir: string, options: TranscriptOptions): Promise<Transcript> {
    const transcript = new Transcript(dir, options);
    await ensurePrivateDirectory(dir);
    const names = (await readdir(dir)).filter((name) => SEGMENT_NAME.test(name)).sort();
    for (const name of names) {
      const path = join(dir, name);
      const info: Stats = await stat(path);
      transcript.segments.push({ index: Number((SEGMENT_NAME.exec(name) as RegExpExecArray)[1]), path, firstSeq: 0, bytes: info.size });
    }
    // The first seq of every segment is in its first line; the last segment is read whole (its last seq, a torn tail).
    for (let i = 0; i < transcript.segments.length; i++) {
      const segment = transcript.segments[i] as Segment;
      if (i === transcript.segments.length - 1) {
        // Only its ends are read: a daemon start opens every session's log.
        await transcript.repairTail(segment);
        segment.firstSeq = (await firstEventOf(segment.path))?.seq ?? 0;
        transcript.last = (await lastEventOf(segment.path))?.seq ?? 0;
      } else {
        segment.firstSeq = (await firstEventOf(segment.path))?.seq ?? 0;
      }
    }
    // An empty last segment (nothing ever reached it): the last seq is the one before it.
    if (transcript.last === 0 && transcript.segments.length > 1) {
      const before = transcript.segments[transcript.segments.length - 2] as Segment;
      transcript.last = (await lastEventOf(before.path))?.seq ?? 0;
    }
    return transcript;
  }

  /** `seq` of the newest event (0: none). */
  get lastSeq(): number {
    return this.last;
  }

  /** `seq` of the oldest event still kept (0: none). */
  get firstSeq(): number {
    for (const segment of this.segments) if (segment.firstSeq > 0) return segment.firstSeq;
    return this.pending[0]?.seq ?? 0;
  }

  /** Bytes on disk plus what is buffered. */
  get bytes(): number {
    return this.segments.reduce((sum, segment) => sum + segment.bytes, 0) + this.pendingBytes;
  }

  /** Stamps and appends one event. `sync`: fsync with this write (turn.finished, card events). */
  append(input: ConversationEventInput, at: number, sync = false): ConversationEvent {
    if (this.closed) throw new Error('the transcript is closed');
    const event = { ...input, seq: this.last + 1, at } as ConversationEvent;
    this.last = event.seq;
    this.pending.push(event);
    this.pendingBytes += Buffer.byteLength(lineOf(event), 'utf8');
    if (sync) this.pendingSync = true;
    if (sync || this.pendingBytes >= this.options.flushBytes) void this.flush().catch(() => {});
    else if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush().catch(() => {}), this.options.flushMs);
      this.timer.unref?.();
    }
    return event;
  }

  /** Runs `task` after everything queued before it: writes, reads from disk, redaction and trimming never interleave. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolves when everything appended so far is written (and synced when a sync was asked for). */
  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return this.serial(() => this.writePending()).catch((err: unknown) => {
      this.options.onError?.(err);
    });
  }

  private async writePending(): Promise<void> {
    // What is appended while this runs waits for the next flush (append() asks for one).
    const count = this.pending.length;
    if (count === 0) return;
    const sync = this.pendingSync;
    this.pendingSync = false;
    let written = 0;
    try {
      for (let i = 0; i < count; i++) {
        const event = this.pending[i] as ConversationEvent;
        const segment = await this.writableSegment();
        const line = lineOf(event);
        await (this.handle as FileHandle).appendFile(line, 'utf8');
        const size = Buffer.byteLength(line, 'utf8');
        segment.bytes += size;
        if (segment.firstSeq === 0) segment.firstSeq = event.seq;
        const cached = this.cache.get(segment.index);
        if (cached !== undefined && (cached.at(-1)?.seq ?? 0) < event.seq) cached.push(event);
        written += 1;
        this.pendingBytes = Math.max(0, this.pendingBytes - size);
      }
      if (sync) await this.handle?.sync();
    } catch (err) {
      if (sync) this.pendingSync = true;
      throw err;
    } finally {
      // What was written leaves the buffer; what was not stays first in line and is tried again.
      this.pending.splice(0, written);
    }
  }

  private async writableSegment(): Promise<Segment> {
    let current = this.segments.at(-1);
    if (current !== undefined && current.bytes >= this.options.segmentBytes) {
      await this.handle?.close().catch(() => {});
      this.handle = null;
      current = undefined;
    }
    if (current === undefined) {
      const index = (this.segments.at(-1)?.index ?? 0) + 1;
      current = { index, path: join(this.dir, segmentName(index)), firstSeq: 0, bytes: 0 };
      this.segments.push(current);
    }
    if (this.handle === null) {
      this.handle = await open(current.path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    }
    return current;
  }

  /** A last line without its newline is a write the daemon did not finish: it is dropped (it was never acknowledged). */
  private async repairTail(segment: Segment): Promise<void> {
    const handle = await open(segment.path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size;
      if (size === 0) return;
      // Walk back from the end to the last newline.
      const chunk = Buffer.alloc(64 * 1024);
      let end = size;
      let cut = 0;
      while (end > 0) {
        const start = Math.max(0, end - chunk.length);
        const { bytesRead } = await handle.read(chunk, 0, end - start, start);
        const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (newline !== -1) {
          cut = start + newline + 1;
          break;
        }
        end = start;
      }
      if (cut === size) return;
      await handle.truncate(cut);
      await handle.sync();
      segment.bytes = cut;
    } finally {
      await handle.close();
    }
  }

  /** The events of a segment; a read from disk is queued behind the writes. */
  private readSegment(segment: Segment): Promise<ConversationEvent[]> {
    const cached = this.cache.get(segment.index);
    if (cached !== undefined) return Promise.resolve(cached);
    return this.serial(() => this.readSegmentNow(segment));
  }

  /** Only inside serial(): reads a segment from disk unless it is cached. */
  private async readSegmentNow(segment: Segment): Promise<ConversationEvent[]> {
    const cached = this.cache.get(segment.index);
    if (cached !== undefined) return cached;
    let text = '';
    try {
      text = await readFile(segment.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const events: ConversationEvent[] = [];
    for (const line of text.split('\n')) {
      const event = parseLine(line);
      if (event !== null) events.push(event);
    }
    this.cache.set(segment.index, events);
    // Keep the newest segment and one other.
    const newest = this.segments.at(-1)?.index;
    for (const key of [...this.cache.keys()]) {
      if (this.cache.size <= 2) break;
      if (key !== newest && key !== segment.index) this.cache.delete(key);
    }
    return events;
  }

  /** Every event from `fromSeq` on, oldest first, at most `max` (stored and buffered). */
  private async forward(fromSeq: number, max: number): Promise<ConversationEvent[]> {
    const out: ConversationEvent[] = [];
    for (let i = 0; i < this.segments.length && out.length < max; i++) {
      const segment = this.segments[i] as Segment;
      const next = this.segments[i + 1];
      if (next !== undefined && next.firstSeq > 0 && next.firstSeq <= fromSeq) continue;
      for (const event of await this.readSegment(segment)) {
        if (event.seq >= fromSeq && out.length < max) out.push(event);
      }
    }
    const lastOut = out.at(-1)?.seq ?? fromSeq - 1;
    for (const event of this.pending) if (event.seq > lastOut && event.seq >= fromSeq && out.length < max) out.push(event);
    return out;
  }

  /** The last `max` events with `seq < beforeSeq`, oldest first. */
  private async backward(beforeSeq: number, max: number): Promise<ConversationEvent[]> {
    const out: ConversationEvent[] = [];
    const seen = new Set<number>();
    for (let i = this.pending.length - 1; i >= 0 && out.length < max; i--) {
      const event = this.pending[i] as ConversationEvent;
      if (event.seq < beforeSeq) {
        out.push(event);
        seen.add(event.seq);
      }
    }
    for (let i = this.segments.length - 1; i >= 0 && out.length < max; i--) {
      const segment = this.segments[i] as Segment;
      if (segment.firstSeq === 0 || segment.firstSeq >= beforeSeq) continue;
      const events = await this.readSegment(segment);
      for (let j = events.length - 1; j >= 0 && out.length < max; j--) {
        const event = events[j] as ConversationEvent;
        if (event.seq < beforeSeq && !seen.has(event.seq)) out.push(event);
      }
    }
    return out.sort((a, b) => a.seq - b.seq).slice(-max);
  }

  /** One page by THE page rule; `limit` is clamped to EVENTS_PAGE_MAX. */
  async page(from: PageFrom, limit: number = EVENTS_PAGE_MAX): Promise<EventsPage> {
    const max = Math.max(1, Math.min(EVENTS_PAGE_MAX, Math.trunc(limit)));
    // The page describes the log as of NOW: what is appended while the segments are read is not part of it (a
    // watcher gets those events live, from `nextSeq` on).
    const newest = this.last;
    let events: ConversationEvent[];
    if ('after' in from) {
      const pool = (await this.forward(from.after + 1, max)).filter((event) => event.seq <= newest);
      events = takeWithinBytes(pool, EVENTS_PAGE_MAX_BYTES, { atLeastOne: true, maxItems: max }).taken;
    } else {
      const pool = await this.backward('before' in from ? Math.min(from.before, newest + 1) : newest + 1, max);
      events = takeWithinBytes([...pool].reverse(), EVENTS_PAGE_MAX_BYTES, { atLeastOne: true, maxItems: max }).taken.reverse();
    }
    const oldest = this.firstSeq;
    const first = events[0]?.seq ?? 0;
    const last = events.at(-1)?.seq ?? 0;
    const hasEarlier = events.length > 0 ? oldest > 0 && oldest < first : 'after' in from && oldest > 0 && oldest <= from.after;
    const hasMore = events.length > 0 ? last < newest : 'before' in from && newest >= from.before;
    const cardRefs: CardRef[] = events.flatMap((event) => (event.kind === 'card' ? [{ kind: event.card, id: event.id }] : []));
    return { events: events.map((event) => structuredClone(event)), firstSeq: first, nextSeq: newest + 1, hasEarlier, hasMore, cardRefs, bytes: encodedSize(events) };
  }

  /** The event with that `seq`, or null (never written, or trimmed). */
  async get(seq: number): Promise<ConversationEvent | null> {
    const found = (await this.forward(seq, 1))[0];
    return found !== undefined && found.seq === seq ? structuredClone(found) : null;
  }

  /**
   * Replaces the event `seq` by `replacement` (stamped with the same `seq` and `at`) in its segment, atomically.
   * Returns the new event, or null when no such event is kept.
   */
  async redact(seq: number, replacement: ConversationEventInput): Promise<ConversationEvent | null> {
    await this.flush();
    const result = await this.serial(async (): Promise<ConversationEvent | null> => {
      await this.writePending();
      for (let i = this.segments.length - 1; i >= 0; i--) {
        const segment = this.segments[i] as Segment;
        if (segment.firstSeq === 0 || segment.firstSeq > seq) continue;
        const events = await this.readSegmentNow(segment);
        const at = events.findIndex((event) => event.seq === seq);
        if (at === -1) return null;
        const next = { ...replacement, seq, at: (events[at] as ConversationEvent).at } as ConversationEvent;
        const rewritten = [...events.slice(0, at), next, ...events.slice(at + 1)];
        const data = rewritten.map(lineOf).join('');
        const tmp = join(this.dir, `.${segmentName(segment.index)}.smurg-${randomBytes(6).toString('hex')}.tmp`);
        try {
          await writeFile(tmp, data, { mode: 0o600, flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW });
          if (i === this.segments.length - 1) {
            await this.handle?.close().catch(() => {});
            this.handle = null;
          }
          await rename(tmp, segment.path);
        } catch (err) {
          await unlink(tmp).catch(() => {});
          throw err;
        }
        segment.bytes = Buffer.byteLength(data, 'utf8');
        this.cache.set(segment.index, rewritten);
        return next;
      }
      return null;
    });
    return result === null ? null : structuredClone(result);
  }

  /**
   * Unlinks the oldest whole segments while the log is larger than `maxBytes`: never the newest, never one that holds
   * a `seq` of `keep` (the events of open cards). True when something went.
   */
  async trim(maxBytes: number, keep: Iterable<number> = []): Promise<boolean> {
    await this.flush();
    const protectedSeqs = [...keep];
    return this.serial(async () => {
      let trimmed = false;
      while (this.bytes > maxBytes && this.segments.length > 1) {
        const oldest = this.segments[0] as Segment;
        const next = this.segments[1] as Segment;
        const upTo = next.firstSeq > 0 ? next.firstSeq : this.last + 1;
        if (protectedSeqs.some((seq) => seq >= oldest.firstSeq && seq < upTo)) break;
        await unlink(oldest.path).catch(() => {});
        this.cache.delete(oldest.index);
        this.segments.shift();
        trimmed = true;
      }
      return trimmed;
    });
  }

  /** Flushes and releases the file handle and the cache; the log can still be read and appended to afterwards. */
  async release(): Promise<void> {
    await this.flush();
    await this.serial(async () => {
      await this.handle?.close().catch(() => {});
      this.handle = null;
      this.cache.clear();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.release();
    this.closed = true;
  }

  /** Removes the whole log directory (the session is forgotten). */
  async remove(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.pending = [];
    this.pendingBytes = 0;
    await this.serial(async () => {
      await this.handle?.close().catch(() => {});
      this.handle = null;
      await rm(this.dir, { recursive: true, force: true });
    });
  }
}

/** The first event of a segment file (reads only its first line). */
async function firstEventOf(file: string): Promise<ConversationEvent | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let text = '';
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        text += chunk.subarray(0, newline).toString('utf8');
        break;
      }
      text += chunk.toString('utf8');
      position += bytesRead;
      if (position > 8 * 1024 * 1024) break;
    }
    return parseLine(text);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The last valid event of a segment file whose last byte is a newline (reads only its end, more when a line is long). */
async function lastEventOf(file: string): Promise<ConversationEvent | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const size = (await handle.stat()).size;
    for (let want = 256 * 1024; ; want *= 4) {
      const start = Math.max(0, size - want);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      // Whole lines only: the first piece may be the tail of a line that began before `start`.
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= (start === 0 ? 0 : 1); i--) {
        const event = parseLine(lines[i] as string);
        if (event !== null) return event;
      }
      if (start === 0) return null;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
