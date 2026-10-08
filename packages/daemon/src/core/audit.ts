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
//
// Accepted requests are bounded as well (review DX-15: one Editor writing files in a loop filled the three files in
// half an hour, and the role changes and decisions of weeks went with them). A MEMBER's own `ok` entries of one
// action are recorded up to a budget per minute; the rest of that minute go, whole, to audit-overflow.jsonl (rotated
// the same way, never paged by a query), and one summary entry in the log says how many. Nothing a member did is
// dropped, and no loop of one action can push other people's entries, or that member's other actions, out of the log.
// The budget is for members other than the HOST (the log is the host's own record of what the host did: every
// decision of theirs stays where the console reads it; requests on the control socket, which every agent session
// reaches under the host's name, keep the budget), and never for the entries that say who may do what and what was
// removed (UNBUDGETED_AUDIT_ACTIONS), whoever records them.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { rename, type FileHandle } from 'node:fs/promises';
import {
  AUDIT_DETAIL_MAX_KEYS,
  AUDIT_TARGET_MAX_CHARS,
  FORBIDDEN_RECORD_KEYS,
  auditEntrySchema,
  isSensitiveWireType,
  redactForLog,
  type Actor,
  type AuditAction,
  type AuditEntry,
} from '@smurg/protocol';
import { LOCAL_CHANNEL_VIA } from '../local/local-channel.ts';
import type { AuditTextStore } from './audit-text.ts';
import { AUDIT_FULL_TEXT_HEAD_CHARS, type AuditInput, type AuditLog, type AuditQuery } from './interfaces.ts';
import { newId, toDisposable, type Clock, type Disposable } from './lifecycle.ts';
import type { Logger } from './logger.ts';
import { openPrivateFile } from './private-file.ts';
import { StateFileError } from './state-file-error.ts';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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

/**
 * Where the work that records an entry came from, when that matters to the reader of the log: `control-socket` for
 * everything a local channel's messages cause (review F1: the control socket admits the host's OS account, which every
 * session runs as, so "the host" there may be someone who drives a session). Set by the hub around a local
 * connection's inbound messages; record() puts it in `detail.via`.
 */
const auditVia = new AsyncLocalStorage<string>();

/** Runs `fn`; every audit entry recorded inside it (synchronously or in its async continuations) gets `detail.via`. */
export function withAuditVia<T>(via: string, fn: () => T): T {
  return auditVia.run(via, fn);
}

/** `detail` with the current audit origin (withAuditVia) as `via`, first (so the key cap never drops it). */
function withVia(detail: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  const via = auditVia.getStore();
  if (via === undefined) return detail;
  const merged: Record<string, unknown> = { via, ...detail };
  merged['via'] = via;
  return merged;
}

const MAX_STRING = 2_000;
/** A top-level `fullText` key keeps this many characters in the entry; the whole text goes to the full-text store. */
const MAX_FULL_TEXT = AUDIT_FULL_TEXT_HEAD_CHARS;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
const REDACTED = '[redacted]';

function isByteArray(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  // Never cut a surrogate pair in half: a lone surrogate would not survive the JSON round trip of the log.
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
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
 * at 2,000 characters; top-level keys named in `fullText` at AUDIT_FULL_TEXT_HEAD_CHARS (record() adds their hash and
 * length and stores the whole text in the full-text store).
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
  /**
   * `ok` entries of one action that one MEMBER's own requests add to the log per minute (default 120); the rest of
   * the minute go to the overflow file and are counted in a summary entry. 0 disables the budget.
   */
  readonly acceptedPerActionPerMinute?: number;
  /** The host: their own accepted entries have no budget. Without it nobody is taken for the host. */
  readonly hostUserId?: string;
  /** Where the whole text of `fullText` keys goes. Without it an entry still carries the hash, the length and the head. */
  readonly texts?: AuditTextStore;
}

/**
 * Accepted entries that are never moved out of the log by a budget, whoever the actor is: a role change, a kick, a
 * decision about a folder's Claude Code project settings, and the removal of a conversation entry.
 */
export const UNBUDGETED_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>(['member.role', 'member.kick', 'claude-config.decide', 'transcript.redact']);

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_ROTATIONS = 2;
const DEFAULT_DENIED_PER_ACTOR_PER_MINUTE = 120;
const DEFAULT_ACCEPTED_PER_ACTION_PER_MINUTE = 120;
const DENIED_WINDOW_MS = 60_000;
const DENIED_WINDOWS_PRUNE_AT = 1_024;
/** The file name a summary entry gives for the entries it counts (`detail.keptIn`), next to the log. */
export const AUDIT_OVERFLOW_FILE = 'audit-overflow.jsonl';
/** Entries kept in memory while appends fail (beyond: counted in the log line of the recovery). */
const AUDIT_BACKLOG_MAX_BYTES = 4 * 1024 * 1024;

/** `…/audit.jsonl` → `…/audit.<n>.jsonl` */
function rotatedPath(path: string, n: number): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}.${n}.jsonl` : `${path}.${n}`;
}

/** `…/audit.jsonl` → `…/audit-overflow.jsonl` */
function overflowPath(path: string): string {
  return path.endsWith('.jsonl') ? `${path.slice(0, -'.jsonl'.length)}-overflow.jsonl` : `${path}-overflow`;
}

/**
 * Opens a log file and refuses a symlink, a foreign file or one with any group/other permission bit (StateFileError:
 * `insecure` with its cause, `cannot-open` with the errno; a file that is not there and is not created: `cannot-open`
 * with ENOENT).
 */
async function openChecked(path: string, flags: number): Promise<FileHandle> {
  const handle = await openPrivateFile(path, flags, { what: 'audit log' });
  if (handle === null) throw new StateFileError({ kind: 'cannot-open', errno: 'ENOENT', path, message: 'cannot open the audit log (ENOENT)' });
  return handle;
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
  return err instanceof StateFileError ? err.kind === 'cannot-open' && err.errno === 'ENOENT' : typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * One budget in the current minute: an actor's `denied` entries from one origin (`detail.via`), or a member's `ok`
 * entries of one action from one origin.
 */
interface DeniedWindow {
  start: number;
  count: number;
  suppressed: number;
  readonly actor: Actor;
  /** `detail.via` of the entries this window counts (e.g. 'control-socket'); undefined for the relay channels. */
  readonly via: string | undefined;
  readonly outcome: 'denied' | 'ok';
  /** What `count` may reach before entries are only counted. */
  readonly limit: number;
  action: AuditAction;
}

function actorKey(actor: Actor): string {
  if (actor.kind === 'user') return `u:${actor.userId}`;
  if (actor.kind === 'agent') return `a:${actor.ownerUserId}`;
  return 'system';
}

/**
 * The origin that gets a refusal budget of its own (admitDenied): the control socket (`detail.via` 'control-socket',
 * set by withAuditVia or explicitly), else undefined (the relay channels). A fixed set, so an actor never has more
 * than two budgets whatever a detail says.
 */
function deniedOriginOf(entry: AuditEntry): string | undefined {
  return entry.detail?.['via'] === LOCAL_CHANNEL_VIA ? LOCAL_CHANNEL_VIA : undefined;
}

export class JsonlAuditLog implements AuditLog {
  private readonly path: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly pageMax: number;
  private readonly maxBytes: number;
  private readonly rotations: number;
  private readonly deniedPerActor: number;
  private readonly acceptedPerAction: number;
  private readonly hostUserId: string | null;
  /** Where a member's `ok` entries beyond the budget go; opened with the first one. `null` inside: it could not be opened. */
  private overflow: Promise<JsonlAuditLog | null> | null = null;
  private readonly texts: AuditTextStore | null;
  private handle: FileHandle | null;
  private size: number;
  private readonly listeners = new Set<(entry: AuditEntry) => void>();
  private readonly deniedWindows = new Map<string, DeniedWindow>();
  /** The windows that are over their budget: their summary is due when their minute has ended. */
  private readonly overBudget = new Map<string, DeniedWindow>();
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
    this.acceptedPerAction = Math.max(0, Math.floor(options.acceptedPerActionPerMinute ?? DEFAULT_ACCEPTED_PER_ACTION_PER_MINUTE));
    this.hostUserId = options.hostUserId ?? null;
    this.texts = options.texts ?? null;
  }

  /** Opens (or creates with 0600) the log; refuses a symlink, a foreign or a group/other-readable file. */
  static async open(path: string, options: JsonlAuditLogOptions): Promise<JsonlAuditLog> {
    const handle = await openChecked(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT);
    try {
      let { size } = await handle.stat();
      // A crash in the middle of an append leaves a torn last line without its newline: start on a fresh line, or the
      // first entry written after the restart would be glued to the fragment and lost with it.
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
    const detail = this.withFullTexts(sanitizeAuditDetail(withVia(input.detail), input.fullText), input);
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
    this.settleEnded(entry.at);
    if (entry.outcome === 'denied' && this.admitDenied(entry) !== 'record') return entry;
    // The host's own requests on a relay channel have no budget. What arrives on the control socket under the host's
    // name does (any agent session of a member reaches that socket: a loop there must not fill the log either).
    const hostsOwn = entry.actor.kind === 'user' && entry.actor.userId === this.hostUserId && deniedOriginOf(entry) === undefined;
    if (entry.outcome === 'ok' && entry.actor.kind === 'user' && !hostsOwn && !UNBUDGETED_AUDIT_ACTIONS.has(entry.action)) {
      const admitted = this.admitAccepted(entry);
      if (admitted === 'counted') this.spill(entry);
      if (admitted !== 'record') return entry;
    }
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

  async fullText(sha256: string): Promise<string | null> {
    return this.texts === null ? null : this.texts.get(sha256);
  }

  async flush(): Promise<void> {
    await this.tail;
    await (await this.overflow)?.flush();
    await this.texts?.flush();
  }

  /**
   * For every `fullText` key that holds a string: `<key>Sha256` and `<key>Chars` next to the clipped head, and the
   * whole text into the full-text store. Secret-bearing keys were replaced by the sanitiser and are skipped.
   */
  private withFullTexts(detail: Record<string, unknown> | undefined, input: AuditInput): Record<string, unknown> | undefined {
    if (detail === undefined || input.fullText === undefined || input.detail === undefined) return detail;
    const out: Record<string, unknown> = { ...detail };
    for (const key of input.fullText) {
      const text = input.detail[key];
      if (typeof text !== 'string' || typeof out[key] !== 'string' || out[key] === REDACTED) continue;
      out[`${key}Sha256`] = this.texts === null ? sha256Hex(text) : this.texts.put(text);
      out[`${key}Chars`] = text.length;
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const window of this.deniedWindows.values()) this.summarize(window);
    this.deniedWindows.clear();
    this.overBudget.clear();
    this.closed = true;
    await this.tail;
    // One last attempt for entries a failed append kept.
    if (this.backlog.length > 0) await this.writeLines([]);
    if (this.backlog.length > 0) this.log.error('audit entries could not be written before close', { entries: this.backlog.length, notRecorded: this.backlogDropped });
    await this.handle?.close();
    this.handle = null;
    await (await this.overflow)?.close();
    await this.texts?.close();
  }

  /**
   * The per-actor budget of `denied` entries: within budget → record; the first one over budget → record it and
   * say that the rest of the minute is only counted; later ones → counted (summary entry when the window ends).
   * One budget per actor AND origin (`detail.via`; verification F-3, 2026-10-02): a local channel's actor is the host,
   * and a flood through the control socket (which any session of a Agent access member reaches) must not use up the
   * budget of the host's own refusals on the web, nor leave a summary that cannot say where the counted ones came
   * from. Two budgets per actor at most: the relay channels and the control socket (deniedOriginOf).
   */
  private admitDenied(entry: AuditEntry): 'record' | 'noted' | 'counted' {
    if (this.deniedPerActor === 0) return 'record';
    const via = deniedOriginOf(entry);
    return this.admit(entry, `denied|${actorKey(entry.actor)}|${via ?? ''}`, via, this.deniedPerActor);
  }

  /**
   * The budget of a MEMBER's own accepted requests, per action and origin: the same steps as for refusals, except
   * that the entries over budget are not only counted but kept, whole, in the overflow file (`spill`). Per action, so
   * that a loop of one kind of request leaves every other thing that member does in the log. Entries of agents, of
   * the daemon itself and of the host have no such budget (no request of a member writes them one for one), and
   * neither have the actions of UNBUDGETED_AUDIT_ACTIONS.
   */
  private admitAccepted(entry: AuditEntry): 'record' | 'noted' | 'counted' {
    if (this.acceptedPerAction === 0) return 'record';
    const via = deniedOriginOf(entry);
    return this.admit(entry, `ok|${actorKey(entry.actor)}|${via ?? ''}|${entry.action}`, via, this.acceptedPerAction);
  }

  /** `record`: within the budget. `noted`: the first one over it, written here with `rateLimited`. `counted`: only counted. */
  private admit(entry: AuditEntry, key: string, via: string | undefined, limit: number): 'record' | 'noted' | 'counted' {
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
      window = { start: now, count: 0, suppressed: 0, actor: entry.actor, via, outcome: entry.outcome === 'ok' ? 'ok' : 'denied', limit, action: entry.action };
      this.deniedWindows.set(key, window);
    }
    window.count++;
    if (window.count <= limit) return 'record';
    window.suppressed++;
    window.action = entry.action;
    if (window.suppressed > 1) return 'counted';
    this.overBudget.set(key, window);
    const note: AuditEntry = { ...entry, detail: { ...(entry.detail ?? {}), rateLimited: true, limitPerMinute: limit } };
    this.commit(note);
    return 'noted';
  }

  /** The summaries of the budgets whose minute has ended are written with the next entry, whoever records it. */
  private settleEnded(now: number): void {
    if (this.overBudget.size === 0) return;
    for (const [key, window] of this.overBudget) {
      if (now - window.start < DENIED_WINDOW_MS) continue;
      this.overBudget.delete(key);
      this.summarize(window);
      if (this.deniedWindows.get(key) === window) this.deniedWindows.delete(key);
    }
  }

  /** One entry for the entries of a finished window that were only counted (accepted ones: and kept in the overflow file). */
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
      outcome: window.outcome,
      target: 'audit-rate-limit',
      detail: {
        ...(window.via === undefined ? {} : { via: window.via }),
        reason: 'audit-rate-limit',
        notRecorded: counted,
        ...(window.outcome === 'ok' ? { keptIn: AUDIT_OVERFLOW_FILE } : {}),
        windowStart: window.start,
        windowMs: DENIED_WINDOW_MS,
      },
    });
  }

  /**
   * An accepted entry over its budget: appended to the overflow file (opened with the first one; 0600, rotated at the
   * same size into the same number of files). Not a live entry for the console and not part of any query.
   */
  private spill(entry: AuditEntry): void {
    if (this.closed) return;
    this.overflow ??= JsonlAuditLog.open(overflowPath(this.path), {
      clock: this.clock,
      log: this.log,
      pageMax: this.pageMax,
      maxBytes: this.maxBytes,
      rotations: this.rotations,
      deniedPerActorPerMinute: 0,
      acceptedPerActionPerMinute: 0,
    }).catch((err: unknown) => {
      this.log.error('audit overflow file could not be opened; entries over the budget are only counted', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    });
    void this.overflow.then((log) => log?.append(entry));
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
   * Appends `lines` after whatever earlier appends could not write (a failed append is kept and written
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
