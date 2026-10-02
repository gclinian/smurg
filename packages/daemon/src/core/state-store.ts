// Atomic JSON persistence under ~/.smurg/workspaces/<workspaceId>/ (ARCHITECTURE §7.1): directory 0700, files 0600,
// writes serialized per document (tmp + fsync + rename + dir fsync), schema-validated on load.
//
// Fail closed on load: a state file that is a symlink, owned by someone else, readable by group/other, or that does
// not match its schema stops the daemon with a clear error. It is never "repaired" or reset, because resetting
// state.json would silently forget revoked devices and consumed invites.
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import type { z } from 'zod';
import type { PersistentDocument, StateStore } from './interfaces.ts';
import type { Logger } from './logger.ts';

const FILE_MODE = 0o600;
const GROUP_OTHER_BITS = 0o077;
const DOCUMENT_NAME = /^[a-z0-9-]{1,40}$/;
/** Documents only the core opens (members, devices, invites, settings, roots). */
const RESERVED_DOCUMENTS: ReadonlySet<string> = new Set(['state']);

export class StateFileError extends Error {
  readonly path: string;

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`${message}: ${path}`, options);
    this.name = 'StateFileError';
    this.path = path;
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Reads a private JSON file: O_NOFOLLOW, regular, ours, no group/other bits. Returns null when it does not exist. */
export async function readPrivateJson(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new StateFileError(path, 'state file is a symlink', { cause });
    throw cause;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new StateFileError(path, 'state file is not a regular file');
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid) throw new StateFileError(path, 'state file is owned by another user');
    if ((st.mode & GROUP_OTHER_BITS) !== 0) {
      throw new StateFileError(path, `state file mode ${(st.mode & 0o777).toString(8)} grants group/other access`);
    }
    const text = await handle.readFile('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new StateFileError(path, 'state file is not valid JSON', { cause });
    }
  } finally {
    await handle.close();
  }
}

/** Writes `text` to `path` atomically with mode 0600. The directory must already be private. */
export async function writePrivateFileAtomic(path: string, dir: string, text: string): Promise<void> {
  const tmp = join(dir, `.${path.slice(dir.length + 1)}.${randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
    try {
      await handle.chmod(FILE_MODE);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    await syncDirectory(dir);
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {});
  }
}

export async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every platform allows fsync on a directory; the rename itself is still atomic.
  }
}

function describeIssues(error: z.ZodError): string {
  // Paths and messages only: never the offending values (they can be keys or member data).
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Backoff of the automatic re-writes of a document whose last write failed (disk full, EIO, permissions). */
export const STATE_RETRY_MIN_MS = 250;
export const STATE_RETRY_MAX_MS = 10_000;

/** A document that is not (yet) on disk, for the daemon's status and the host's warning. */
export interface UnsavedDocument {
  readonly name: string;
  /** errno code (or 'unknown') of the most recent failed write. */
  readonly error: string;
  readonly failedAttempts: number;
}

class JsonDocument<T> implements PersistentDocument<T> {
  readonly name: string;
  private readonly path: string;
  private readonly dir: string;
  private readonly schema: z.ZodType<T>;
  private readonly log: Logger;
  private readonly onHealth: (doc: JsonDocument<unknown>, ok: boolean) => void;
  private value: T;
  /**
   * The in-memory value differs from the file. It stays set after a FAILED write: the value is
   * written again (backoff, and at once by flush()) until the disk takes it. A kick applied in memory must not be
   * undone by the next restart because one write failed.
   */
  private dirty = false;
  private writing: Promise<void> | null = null;
  /** The most recent attempt failed and nothing has been written since. */
  private failing = false;
  private lastError: unknown = null;
  private failedAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs = STATE_RETRY_MIN_MS;
  private closed = false;

  constructor(name: string, dir: string, schema: z.ZodType<T>, value: T, log: Logger, onHealth: (doc: JsonDocument<unknown>, ok: boolean) => void) {
    this.name = name;
    this.dir = dir;
    this.path = join(dir, `${name}.json`);
    this.schema = schema;
    this.value = deepFreeze(value);
    this.log = log;
    this.onHealth = onHealth;
  }

  get(): Readonly<T> {
    return this.value;
  }

  update(mutator: (draft: T) => T | void): Readonly<T> {
    const draft = structuredClone(this.value) as T;
    const returned = mutator(draft);
    const next = returned === undefined ? draft : returned;
    const parsed = this.schema.safeParse(next);
    // An invalid update is a bug in the caller: refuse it instead of persisting something unloadable.
    if (!parsed.success) throw new StateFileError(this.path, `invalid ${this.name} update (${describeIssues(parsed.error)})`);
    this.value = deepFreeze(parsed.data);
    this.dirty = true;
    // While the disk refuses writes, the retry timer (or a flush) writes the latest value; every update does not
    // need its own failing attempt.
    if (!this.failing) this.startWriting();
    return this.value;
  }

  /** Persists the current value now (used right after creation). */
  persistNow(): Promise<void> {
    this.dirty = true;
    return this.flush();
  }

  /**
   * Resolves when the current value is on disk. When it is not, a write is attempted NOW (not only a stale error
   * reported): rejects with that attempt's error, and the document stays unsaved and keeps being retried.
   */
  async flush(): Promise<void> {
    for (;;) {
      if (this.writing) await this.writing;
      else if (this.dirty) {
        this.startWriting();
        await this.writing;
      }
      if (!this.dirty) return;
      if (this.failing) throw this.lastError;
    }
  }

  /** Why the document is not on disk, or null when it is (or a write of it is merely in progress). */
  unsaved(): UnsavedDocument | null {
    if (!this.failing) return null;
    return { name: this.name, error: errnoCode(this.lastError) ?? 'unknown', failedAttempts: this.failedAttempts };
  }

  /** Stops the automatic retries (daemon stopped). flush() still writes. */
  close(): void {
    this.closed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private startWriting(): void {
    if (this.writing) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const run: Promise<void> = this.writeLoop().finally(() => {
      if (this.writing === run) this.writing = null;
    });
    this.writing = run;
  }

  private async writeLoop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const text = `${JSON.stringify(this.value, null, 2)}\n`;
      try {
        await writePrivateFileAtomic(this.path, this.dir, text);
      } catch (err) {
        // Still not on disk: keep it dirty and try again later (and at every flush()).
        this.dirty = true;
        this.lastError = err;
        this.failedAttempts++;
        const first = !this.failing;
        this.failing = true;
        this.log.error('state write failed; will retry', { document: this.name, error: errnoCode(err) ?? 'unknown', attempt: this.failedAttempts });
        if (first) this.onHealth(this as JsonDocument<unknown>, false);
        this.scheduleRetry();
        return;
      }
      if (this.failing) {
        this.log.warn('state write succeeded again', { document: this.name, failedAttempts: this.failedAttempts });
        this.failing = false;
        this.lastError = null;
        this.failedAttempts = 0;
        this.retryDelayMs = STATE_RETRY_MIN_MS;
        this.onHealth(this as JsonDocument<unknown>, true);
      }
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer !== undefined) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, STATE_RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.dirty) this.startWriting();
    }, delay);
    // A retry never keeps the process alive; stop() flushes (and reports) explicitly.
    this.retryTimer.unref?.();
  }
}

export class FileStateStore implements StateStore {
  readonly dir: string;
  private readonly log: Logger;
  private readonly documents = new Map<string, Promise<PersistentDocument<unknown>>>();
  private readonly loaded = new Set<JsonDocument<unknown>>();
  private readonly healthListeners = new Set<(event: { readonly document: string; readonly ok: boolean }) => void>();

  private constructor(dir: string, log: Logger) {
    this.dir = dir;
    this.log = log;
  }

  /** Documents whose latest value could not be written: shown to the host, reported at stop. */
  unsaved(): UnsavedDocument[] {
    return [...this.loaded].map((doc) => doc.unsaved()).filter((u): u is UnsavedDocument => u !== null);
  }

  /** Called when a document starts failing to write (ok: false) and when it is written again (ok: true). */
  onHealthChange(listener: (event: { readonly document: string; readonly ok: boolean }) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /** Stops the background retries (after the final flush of stop()). */
  close(): void {
    for (const doc of this.loaded) doc.close();
  }

  private readonly health = (doc: JsonDocument<unknown>, ok: boolean): void => {
    for (const listener of [...this.healthListeners]) {
      try {
        listener({ document: doc.name, ok });
      } catch (err) {
        this.log.error('state health listener failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  };

  /** Creates the directory (0700, with missing parents) and refuses an existing one that is not private. */
  static async open(dir: string, log: Logger): Promise<FileStateStore> {
    await ensurePrivateDirectory(dir);
    return new FileStateStore(dir, log);
  }

  document<S extends z.ZodType>(name: string, schema: S, init: () => z.output<S>): Promise<PersistentDocument<z.output<S>>> {
    if (RESERVED_DOCUMENTS.has(name)) return Promise.reject(new TypeError(`state document ${name} is reserved for the daemon core`));
    return this.open(name, schema, init);
  }

  /** The core's own documents (`state`); feature modules cannot open them with another schema. */
  coreDocument<S extends z.ZodType>(name: string, schema: S, init: () => z.output<S>): Promise<PersistentDocument<z.output<S>>> {
    if (!RESERVED_DOCUMENTS.has(name)) return Promise.reject(new TypeError(`${name} is not a core document`));
    return this.open(name, schema, init);
  }

  private open<S extends z.ZodType>(name: string, schema: S, init: () => z.output<S>): Promise<PersistentDocument<z.output<S>>> {
    if (!DOCUMENT_NAME.test(name)) return Promise.reject(new TypeError(`invalid state document name: ${name}`));
    const existing = this.documents.get(name);
    if (existing) return existing as Promise<PersistentDocument<z.output<S>>>;
    const loading = this.load(name, schema as unknown as z.ZodType<z.output<S>>, init);
    this.documents.set(name, loading as Promise<PersistentDocument<unknown>>);
    loading.catch(() => this.documents.delete(name));
    return loading;
  }

  async privateDir(name: string): Promise<string> {
    if (!DOCUMENT_NAME.test(name)) throw new TypeError(`invalid state directory name: ${name}`);
    const dir = join(this.dir, name);
    await ensurePrivateDirectory(dir);
    return dir;
  }

  async flush(): Promise<void> {
    const docs = await Promise.all([...this.documents.values()].map((p) => p.catch(() => null)));
    const results = await Promise.allSettled(docs.map((doc) => doc?.flush()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  private async load<T>(name: string, schema: z.ZodType<T>, init: () => T): Promise<PersistentDocument<T>> {
    const path = join(this.dir, `${name}.json`);
    const raw = await readPrivateJson(path);
    if (raw === null) {
      const initial = schema.safeParse(init());
      if (!initial.success) throw new StateFileError(path, `invalid initial ${name} (${describeIssues(initial.error)})`);
      const doc = new JsonDocument(name, this.dir, schema, initial.data, this.log, this.health);
      try {
        await doc.persistNow();
      } catch (err) {
        doc.close();
        throw err;
      }
      this.loaded.add(doc as JsonDocument<unknown>);
      return doc;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new StateFileError(path, `state file does not match its schema (${describeIssues(parsed.error)})`);
    const doc = new JsonDocument(name, this.dir, schema, parsed.data, this.log, this.health);
    this.loaded.add(doc as JsonDocument<unknown>);
    return doc;
  }
}
