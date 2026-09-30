// The audit log (R11; ARCHITECTURE §5.8): append-only JSONL at <workspace state dir>/audit.jsonl (0600), newest-first
// paging by the strictly increasing `at`, and a live feed for the host console (admin.audit.entry).
//
// What never lands here: file contents, terminal data, keys, tokens, invite secrets or URLs, API keys. record()
// sanitises `detail` (bytes → sizes, secret-bearing keys replaced) and the router never passes payloads of types the
// registry marks sensitive (auditDetailForMessage). R6 requires suggestion text in the log, which is why the
// sanitiser redacts by key rather than dropping all text (and why `fullText` keys may keep a whole suggestion).
//
// Bounded (security review F5): `denied` entries are recorded up to a budget per actor and minute, the rest are
// counted in one summary entry; the file is rotated to audit.1.jsonl / audit.2.jsonl (0600) at a size cap, and
// queries page through the rotated files too.
import { constants as fsConstants } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import {
  AUDIT_DETAIL_MAX_KEYS,
  AUDIT_TARGET_MAX_CHARS,
  FORBIDDEN_RECORD_KEYS,
  SUGGESTION_TEXT_MAX_CHARS,
  auditEntrySchema,
  isSensitiveWireType,
  redactForLog,
  type Actor,
  type AuditAction,
  type AuditEntry,
} from '@smurg/protocol';
import type { AuditInput, AuditLog, AuditQuery } from './interfaces.ts';
import { newId, toDisposable, type Clock, type Disposable } from './lifecycle.ts';
import type { Logger } from './logger.ts';
import { StateFileError } from './state-store.ts';

/** Keys whose values are secrets or content wherever they appear in `detail` (compared case-insensitively). */
const SECRET_KEYS: ReadonlySet<string> = new Set(
  [
    'content',
    'data',
    'bytes-content',
    'apikey',
    'token',
    'identitytoken',
    'sessiontoken',
    'secret',
    'psk',
    'pskhex',
    's',
    'url',
    'inviteurl',
    'password',
    'key',
    'privatekey',
    'secretkey',
    'hookinput',
    'hookoutput',
    'agentversion',
    'humantext',
    'agenttext',
    'basetext',
    'diff',
    'authorization',
    'cookie',
    'env',
    'cnf',
    'cnfnonce',
    'hash',
  ].map((key) => key.toLowerCase()),
);

const MAX_STRING = 2_000;
/** A top-level `fullText` key keeps up to this many characters (a whole suggestion, R6.3). */
const MAX_FULL_TEXT = SUGGESTION_TEXT_MAX_CHARS;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
const REDACTED = '[redacted]';

function isByteArray(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitizeValue(value: unknown, depth: number, fullText: ReadonlySet<string> = new Set()): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return clip(value, MAX_STRING);
  if (isByteArray(value)) return { bytes: value.byteLength };
  if (typeof value !== 'object') return undefined; // functions, symbols, bigint, undefined
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_RECORD_KEYS.has(key) || key.length === 0 || key.length > 64) continue;
    if (count >= AUDIT_DETAIL_MAX_KEYS) break;
    const clean = SECRET_KEYS.has(key.toLowerCase())
      ? isByteArray(item)
        ? { bytes: item.byteLength }
        : REDACTED
      : depth === 0 && fullText.has(key) && typeof item === 'string'
        ? clip(item, MAX_FULL_TEXT)
        : sanitizeValue(item, depth + 1);
    if (clean === undefined) continue;
    out[key] = clean;
    count++;
  }
  return out;
}

/**
 * The sanitiser record() applies; exported for tests and for modules that build detail elsewhere. Strings are cut
 * at 2,000 characters, except top-level keys named in `fullText` (up to SUGGESTION_TEXT_MAX_CHARS).
 */
export function sanitizeAuditDetail(detail: Readonly<Record<string, unknown>> | undefined, fullText: readonly string[] = []): Record<string, unknown> | undefined {
  if (detail === undefined) return undefined;
  const clean = sanitizeValue(detail, 0, new Set(fullText));
  if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) return undefined;
  return Object.keys(clean).length === 0 ? undefined : (clean as Record<string, unknown>);
}

/**
 * Audit detail derived from a message payload: nothing but the type for payloads the registry marks sensitive,
 * otherwise the log-safe view (bytes → sizes, redact keys hidden).
 */
export function auditDetailForMessage(type: string, payload: unknown): Record<string, unknown> {
  if (isSensitiveWireType(type)) return { type, payload: REDACTED };
  const view = redactForLog(type, payload);
  return view !== null && typeof view === 'object' && !Array.isArray(view) ? { type, ...(view as Record<string, unknown>) } : { type };
}

function clampTarget(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  // lineText: no control / bidi characters. Replace rather than drop, so the entry still says what was targeted.
  // eslint-disable-next-line no-control-regex
  const cleaned = target.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '�');
  return cleaned.length > AUDIT_TARGET_MAX_CHARS ? cleaned.slice(0, AUDIT_TARGET_MAX_CHARS) : cleaned;
}

const READ_BLOCK = 64 * 1024;

/**
 * Calls `onLine` for each line of the file, last line first, until it returns false. Reads fixed-size blocks from
 * the end, so paging through a large log never loads it whole.
 */
export async function readLinesBackward(handle: FileHandle, onLine: (line: string) => boolean): Promise<void> {
  const { size } = await handle.stat();
  let position = size;
  let carry: Buffer = Buffer.alloc(0);
  while (position > 0) {
    const length = Math.min(READ_BLOCK, position);
    position -= length;
    const block = Buffer.alloc(length);
    await handle.read(block, 0, length, position);
    let buffer = Buffer.concat([block, carry]);
    let end = buffer.length;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i] !== 0x0a) continue;
      const line = buffer.subarray(i + 1, end).toString('utf8');
      end = i;
      if (line.length > 0 && !onLine(line)) return;
    }
    carry = buffer.subarray(0, end);
    buffer = Buffer.alloc(0);
  }
  if (carry.length > 0) onLine(carry.toString('utf8'));
}

function parseEntry(line: string): AuditEntry | null {
  try {
    const parsed = auditEntrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // a torn last line after a crash
  }
}

export interface JsonlAuditLogOptions {
  readonly clock: Clock;
  readonly log: Logger;
  readonly pageMax: number;
  /** Rotate when the file would grow beyond this many bytes (default 32 MiB). */
  readonly maxBytes?: number;
  /** Rotated files kept: audit.1.jsonl … audit.<n>.jsonl (default 2). */
  readonly rotations?: number;
  /** `denied` entries recorded per actor per minute (default 120); 0 disables the budget. */
  readonly deniedPerActorPerMinute?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_ROTATIONS = 2;
const DEFAULT_DENIED_PER_ACTOR_PER_MINUTE = 120;
const DENIED_WINDOW_MS = 60_000;
const DENIED_WINDOWS_PRUNE_AT = 1_024;
/** Entries kept in memory while appends fail (beyond: counted in the log line of the recovery). */
const AUDIT_BACKLOG_MAX_BYTES = 4 * 1024 * 1024;

/** `…/audit.jsonl` → `…/audit.<n>.jsonl` */
function rotatedPath(path: string, n: number): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.${n}.jsonl` : `${path}.${n}`;
}

/** Opens a log file and refuses a symlink, a foreign file or one with any group/other permission bit. */
async function openChecked(path: string, flags: number): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags | fsConstants.O_NOFOLLOW, 0o600);
  } catch (cause) {
    throw new StateFileError(path, 'cannot open the audit log', { cause });
  }
  try {
    const st = await handle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!st.isFile()) throw new StateFileError(path, 'audit log is not a regular file');
    if (uid !== undefined && st.uid !== uid) throw new StateFileError(path, 'audit log is owned by another user');
    if ((st.mode & 0o077) !== 0) throw new StateFileError(path, `audit log mode ${(st.mode & 0o777).toString(8)} grants group/other access`);
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/**
 * For a JSONL file opened for appending (O_APPEND) whose current size is `size`: when it does not end in a newline
 * (a crash tore its last line), appends one, so the next entry starts on its own line. Returns true when it did.
 */
export async function terminateTornLine(handle: FileHandle, size: number): Promise<boolean> {
  if (size <= 0) return false;
  const last = Buffer.alloc(1);
  const { bytesRead } = await handle.read(last, 0, 1, size - 1);
  if (bytesRead === 1 && last[0] === 0x0a) return false;
  await handle.appendFile('\n', 'utf8');
  return true;
}

async function lastEntryAt(handle: FileHandle): Promise<number | null> {
  let at: number | null = null;
  await readLinesBackward(handle, (line) => {
    const entry = parseEntry(line);
    if (!entry) return true;
    at = entry.at;
    return false;
  });
  return at;
}

function isMissing(err: unknown): boolean {
  const cause = err instanceof StateFileError ? (err as { cause?: unknown }).cause : err;
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT';
}

/** One actor's `denied` entries in the current minute. */
interface DeniedWindow {
  start: number;
  count: number;
  suppressed: number;
  readonly actor: Actor;
  action: AuditAction;
}

function actorKey(actor: Actor): string {
  if (actor.kind === 'user') return `u:${actor.userId}`;
  if (actor.kind === 'agent') return `a:${actor.ownerUserId}`;
  return 'system';
}

export class JsonlAuditLog implements AuditLog {
  private readonly path: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly pageMax: number;
  private readonly maxBytes: number;
  private readonly rotations: number;
  private readonly deniedPerActor: number;
  private handle: FileHandle | null;
  private size: number;
  private readonly listeners = new Set<(entry: AuditEntry) => void>();
  private readonly deniedWindows = new Map<string, DeniedWindow>();
  private lastAt: number;
  /** Appends, rotations and queries run one after another on this chain. */
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  /** Lines a failed append could not write, written first by the next append (and at close). */
  private backlog: string[] = [];
  private backlogBytes = 0;
  private backlogDropped = 0;
  private appendFailed = false;

  private constructor(path: string, handle: FileHandle, size: number, lastAt: number, options: JsonlAuditLogOptions) {
    this.path = path;
    this.handle = handle;
    this.size = size;
    this.lastAt = lastAt;
    this.clock = options.clock;
    this.log = options.log;
    this.pageMax = options.pageMax;
    this.maxBytes = Math.max(4_096, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.rotations = Math.max(1, Math.floor(options.rotations ?? DEFAULT_ROTATIONS));
    this.deniedPerActor = Math.max(0, Math.floor(options.deniedPerActorPerMinute ?? DEFAULT_DENIED_PER_ACTOR_PER_MINUTE));
  }

  /** Opens (or creates with 0600) the log; refuses a symlink, a foreign or a group/other-readable file. */
  static async open(path: string, options: JsonlAuditLogOptions): Promise<JsonlAuditLog> {
    const handle = await openChecked(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT);
    try {
      let { size } = await handle.stat();
      // A crash in the middle of an append leaves a torn last line without its newline: start on a fresh line, or the
      // first entry written after the restart would be glued to the fragment and lost with it (review REL-02).
      if (await terminateTornLine(handle, size)) {
        size += 1;
        options.log.warn('audit log ended in a torn line (crash during a write?); continuing on a new line', {});
      }
      let lastAt = await lastEntryAt(handle);
      if (lastAt === null) {
        // Freshly rotated before a restart: `at` must keep increasing across the rotated files too.
        const previous = await openChecked(rotatedPath(path, 1), fsConstants.O_RDONLY).catch((err: unknown) => {
          if (isMissing(err)) return null;
          throw err;
        });
        if (previous) {
          try {
            lastAt = await lastEntryAt(previous);
          } finally {
            await previous.close();
          }
        }
      }
      return new JsonlAuditLog(path, handle, size, lastAt ?? 0, options);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  record(input: AuditInput): AuditEntry {
    const at = Math.max(this.clock.now(), this.lastAt + 1);
    this.lastAt = at;
    const detail = sanitizeAuditDetail(input.detail, input.fullText);
    const target = clampTarget(input.target);
    let entry: AuditEntry = {
      id: newId('au'),
      at,
      actor: input.actor,
      action: input.action,
      outcome: input.outcome,
      ...(target === undefined ? {} : { target }),
      ...(detail === undefined ? {} : { detail }),
    };
    const checked = auditEntrySchema.safeParse(entry);
    if (!checked.success) {
      // Never lose the fact that something happened: keep action/outcome/at, drop what failed validation.
      this.log.error('audit entry failed validation', { action: input.action });
      entry = { id: entry.id, at, actor: auditEntrySchema.shape.actor.safeParse(input.actor).success ? input.actor : { kind: 'system' }, action: input.action, outcome: input.outcome, detail: { invalid: true } };
    } else {
      entry = checked.data;
    }
    if (entry.outcome === 'denied' && !this.admitDenied(entry)) return entry;
    this.commit(entry);
    return entry;
  }

  async query(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 100, this.pageMax));
    const before = query.before ?? Number.POSITIVE_INFINITY;
    const out: AuditEntry[] = [];
    const collect = (line: string): boolean => {
      const entry = parseEntry(line);
      if (entry && entry.at < before) out.push(entry);
      return out.length < limit;
    };
    const page = this.tail.then(async () => {
      if (this.handle) await readLinesBackward(this.handle, collect);
      for (let n = 1; n <= this.rotations && out.length < limit; n++) {
        const rotated = await openChecked(rotatedPath(this.path, n), fsConstants.O_RDONLY).catch((err: unknown) => {
          if (!isMissing(err)) this.log.error('rotated audit log refused', { file: n });
          return null;
        });
        if (!rotated) break;
        try {
          await readLinesBackward(rotated, collect);
        } finally {
          await rotated.close();
        }
      }
    });
    this.tail = page.then(
      () => {},
      () => {},
    );
    await page;
    return out;
  }

  subscribe(listener: (entry: AuditEntry) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  flush(): Promise<void> {
    return this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const window of this.deniedWindows.values()) this.summarize(window);
    this.deniedWindows.clear();
    this.closed = true;
    await this.tail;
    // One last attempt for entries a failed append kept.
    if (this.backlog.length > 0) await this.writeLines([]);
    if (this.backlog.length > 0) this.log.error('audit entries could not be written before close', { entries: this.backlog.length, notRecorded: this.backlogDropped });
    await this.handle?.close();
    this.handle = null;
  }

  /**
   * The per-actor budget of `denied` entries: within budget → record; the first one over budget → record it and
   * say that the rest of the minute is only counted; later ones → counted (summary entry when the window ends).
   */
  private admitDenied(entry: AuditEntry): boolean {
    if (this.deniedPerActor === 0) return true;
    const key = actorKey(entry.actor);
    const now = entry.at;
    let window = this.deniedWindows.get(key);
    if (window && now - window.start >= DENIED_WINDOW_MS) {
      this.summarize(window);
      window = undefined;
    }
    if (!window) {
      if (this.deniedWindows.size >= DENIED_WINDOWS_PRUNE_AT) {
        for (const [k, w] of this.deniedWindows) {
          if (now - w.start < DENIED_WINDOW_MS) continue;
          this.summarize(w);
          this.deniedWindows.delete(k);
        }
      }
      window = { start: now, count: 0, suppressed: 0, actor: entry.actor, action: entry.action };
      this.deniedWindows.set(key, window);
    }
    window.count++;
    if (window.count <= this.deniedPerActor) return true;
    window.suppressed++;
    window.action = entry.action;
    if (window.suppressed === 1) {
      const note: AuditEntry = { ...entry, detail: { ...(entry.detail ?? {}), rateLimited: true, limitPerMinute: this.deniedPerActor } };
      this.commit(note);
    }
    return false;
  }

  /** One entry for the refusals of a finished window that were only counted. */
  private summarize(window: DeniedWindow): void {
    const counted = window.suppressed - 1; // the first one over budget was recorded
    window.suppressed = 0;
    if (counted <= 0 || this.closed) return;
    const at = Math.max(this.clock.now(), this.lastAt + 1);
    this.lastAt = at;
    this.commit({
      id: newId('au'),
      at,
      actor: window.actor,
      action: window.action,
      outcome: 'denied',
      target: 'audit-rate-limit',
      detail: { reason: 'audit-rate-limit', notRecorded: counted, windowStart: window.start, windowMs: DENIED_WINDOW_MS },
    });
  }

  /** Queues the append and notifies subscribers. */
  private commit(entry: AuditEntry): void {
    this.append(entry);
    for (const listener of [...this.listeners]) {
      try {
        listener(entry);
      } catch (err) {
        this.log.error('audit listener failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  private append(entry: AuditEntry): void {
    if (this.closed) {
      this.log.error('audit entry after close', { action: entry.action });
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    this.tail = this.tail.then(() => this.writeLines([line]));
  }

  /**
   * Appends `lines` after whatever earlier appends could not write (review REL-14: a failed append is kept and written
   * with the next one instead of being lost; bounded by AUDIT_BACKLOG_MAX_BYTES, beyond which entries are counted).
   */
  private async writeLines(lines: readonly string[]): Promise<void> {
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (this.backlogBytes + bytes > AUDIT_BACKLOG_MAX_BYTES) {
        this.backlogDropped++;
        continue;
      }
      this.backlog.push(line);
      this.backlogBytes += bytes;
    }
    if (this.backlog.length === 0) return;
    // After a failed append the file may end in a partial line: continue on a fresh one (an empty line is skipped).
    const text = `${this.appendFailed ? '\n' : ''}${this.backlog.join('')}`;
    const bytes = Buffer.byteLength(text, 'utf8');
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
      if (!this.handle) throw new Error('audit log is not open');
      await this.handle.appendFile(text, 'utf8');
      this.size += bytes;
      if (this.appendFailed) this.log.warn('audit log written again', { entries: this.backlog.length, notRecorded: this.backlogDropped });
      this.backlog = [];
      this.backlogBytes = 0;
      this.backlogDropped = 0;
      this.appendFailed = false;
    } catch (err) {
      this.appendFailed = true;
      this.log.error('audit append failed; kept for the next write', {
        path: this.path,
        error: typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown',
        pending: this.backlog.length,
      });
      if (this.handle) this.size = await this.handle.stat().then((st) => st.size, () => this.size);
    }
  }

  /** audit.jsonl → audit.1.jsonl → … → audit.<rotations>.jsonl (the oldest is replaced); a fresh 0600 audit.jsonl. */
  private async rotate(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
    try {
      for (let n = this.rotations - 1; n >= 1; n--) {
        await rename(rotatedPath(this.path, n), rotatedPath(this.path, n + 1)).catch((err: unknown) => {
          if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
        });
      }
      await rename(this.path, rotatedPath(this.path, 1));
    } finally {
      // Whatever happened above, keep logging (into the old file if it could not be moved).
      this.handle = await openChecked(this.path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT);
      this.size = (await this.handle.stat()).size;
    }
  }
}
