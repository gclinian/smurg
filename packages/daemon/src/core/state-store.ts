// Atomic JSON persistence under ~/.smurg/workspaces/<workspaceId>/ (ARCHITECTURE §7.1): directory 0700, files 0600,
// writes serialized per document (tmp + fsync + rename + dir fsync), schema-validated on load.
//
// Fail closed on load: a state file that is a symlink, owned by someone else, readable by group/other, or that does
// not match a shape a published smurg wrote stops the daemon with a refusal that has a KIND (core/state-file-error.ts).
// It is never "repaired" or reset, because resetting state.json would silently forget revoked devices and consumed
// invites.
//
// What an EARLIER published smurg wrote is read through STEPS. A document is declared with its current strict schema,
// its `init`, and one step per earlier shape: `{ from: '0.4.0', sinceShapes: 1, shape: <frozen strict schema>,
// upgrade(old) }`. Loading tries the current schema, then each earlier shape; on a match the steps run in memory and
// the result must pass the current strict schema. Nothing here is lenient: no default in a schema, no strip, no
// passthrough. A step never drops a record and never resets; a step is never removed.
//
// The store never decides WHEN a file is written: a start has two phases (core/workspace-folder.ts). Everything in
// this file that reads is used by phase 1 and writes nothing; `FileStateStore.adopt` is phase 2.
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import { z } from 'zod';
import type { PersistentDocument, StateStore } from './interfaces.ts';
import type { Logger } from './logger.ts';
import { assertPrivateFileStat, openPrivateFile } from './private-file.ts';
import { StateFileError, describeProblems, errnoCodeOf, escapeForTerminal, type StateFileCopy } from './state-file-error.ts';

const FILE_MODE = 0o600;
const DOCUMENT_NAME = /^[a-z0-9-]{1,40}$/;
/** A published smurg version, as a step and the stamp name it: digits.digits.digits. */
const VERSION_NAME = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;
/** Documents only the core opens (members, devices, invites, settings, roots). */
const RESERVED_DOCUMENTS: ReadonlySet<string> = new Set(['state']);

export {
  STATE_FILE_INSECURE_CAUSES,
  STATE_FILE_KINDS,
  STATE_FILE_PROBLEMS_MAX,
  STATE_FILE_UNREADABLE_REASONS,
  StateFileError,
  type StateFileCopy,
  type StateFileErrorInit,
  type StateFileInsecureCause,
  type StateFileKind,
  type StateFileUnreadableReason,
} from './state-file-error.ts';

function errnoCode(err: unknown): string | undefined {
  return errnoCodeOf(err);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** -1, 0, 1 for two version names (digits.digits.digits), compared number by number. */
export function compareVersionNames(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isVersionName(value: unknown): value is string {
  return typeof value === 'string' && VERSION_NAME.test(value);
}

// =====================================================================================================================
// Reading and writing one private file
// =====================================================================================================================

/**
 * The bytes of a private file, read through the handle that was checked (O_NOFOLLOW, regular, ours, no group/other
 * bits). Null when it does not exist. `maxBytes`: a larger file is refused before it is read (`unreadable`).
 */
export async function readPrivateFile(path: string, options: { readonly what?: string; readonly maxBytes?: number } = {}): Promise<Buffer | null> {
  const what = options.what ?? 'state file';
  const handle = await openPrivateFile(path, fsConstants.O_RDONLY, { what });
  if (handle === null) return null;
  try {
    if (options.maxBytes !== undefined) {
      const { size } = await handle.stat();
      if (size > options.maxBytes) {
        throw new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path, message: `${what} is larger than ${options.maxBytes} bytes`, problems: [`(file): larger than ${options.maxBytes} bytes`] });
      }
    }
    return await handle.readFile();
  } catch (source) {
    if (source instanceof StateFileError) throw source;
    throw new StateFileError({ kind: 'cannot-open', errno: errnoCode(source) ?? 'unknown', path, message: `cannot read the ${what} (${errnoCode(source) ?? 'unknown'})`, source });
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseJson(path: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (source) {
    throw new StateFileError({ kind: 'unreadable', reason: 'not-json', path, message: 'state file is not valid JSON', problems: ['(file): not valid JSON'], source });
  }
}

/** Reads a private JSON file: O_NOFOLLOW, regular, ours, no group/other bits. Returns null when it does not exist. */
export async function readPrivateJson(path: string): Promise<unknown> {
  const bytes = await readPrivateFile(path);
  return bytes === null ? null : parseJson(path, bytes);
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

/** A key of the file can be megabytes long, and zod names unknown keys as they are. */
const PROBLEM_MAX_CHARS = 240;

/** One problem per issue: the path in the document and zod's message, never a value; control characters escaped. */
export function problemsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const text = escapeForTerminal(`${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    return text.length > PROBLEM_MAX_CHARS ? `${text.slice(0, PROBLEM_MAX_CHARS)}…` : text;
  });
}

function describeIssues(error: z.ZodError): string {
  return describeProblems(problemsOf(error), 0);
}

/** How a document is serialized (every published smurg: two spaces, a final newline). */
export function serializeDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// =====================================================================================================================
// Declarations and steps
// =====================================================================================================================

/** What a step may know about the machine it runs on (nothing about the workspace: that is in the file). */
export interface StepEnv {
  /** The host's RAM (`maxLiveAgents` of a 0.4.0 workspace is the default for this machine). */
  readonly memoryBytes: number;
}

/**
 * From the shape ONE earlier published smurg wrote to the next shape. `upgrade` is pure and works in memory: it never
 * drops a record, never resets, and adds a security-relevant value only CLOSED. A step is never removed.
 */
export interface DocumentStep {
  /** The first published smurg that wrote `shape` (`0.4.0`). Names the step and the kept copy. */
  readonly from: string;
  /**
   * WORKSPACE_SHAPES of the first smurg that has this step (1 for the steps of 0.5.1, the first smurg that stamps a
   * folder). A folder whose stamp carries that number or a higher one was already upgraded by a smurg that has the
   * step: finding this shape there means an OLDER file was put back (Daemon.putBack).
   */
  readonly sinceShapes: number;
  /** FROZEN: a literal strict copy of what that smurg accepted, with its own scalar rules (src/frozen/). */
  readonly shape: z.ZodType;
  /** Returns the next shape (the next step's, or today's schema for the last step). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upgrade(old: any, env: StepEnv): unknown;
}

/** A typed step (the store only needs the erased DocumentStep). */
export function defineStep<S extends z.ZodType, Next>(step: { readonly from: string; readonly sinceShapes: number; readonly shape: S; upgrade(old: z.output<S>, env: StepEnv): Next }): DocumentStep {
  if (!isVersionName(step.from)) throw new TypeError(`a step is named after the published version whose shape it reads (X.Y.Z): ${step.from}`);
  if (!Number.isSafeInteger(step.sinceShapes) || step.sinceShapes < 1 || step.sinceShapes > WORKSPACE_SHAPES) throw new TypeError(`a step's sinceShapes is a shapes number this smurg has (1..${WORKSPACE_SHAPES})`);
  return Object.freeze(step) as DocumentStep;
}

/** One document of the workspace folder: `<name>.json`. A FeatureModule lists its own in `documents`. */
export interface DocumentDeclaration<S extends z.ZodType = z.ZodType> {
  /** `[a-z0-9-]{1,40}`; `state` is the core's. */
  readonly name: string;
  /** Today's strict schema: exactly what this smurg writes. */
  readonly schema: S;
  /** The value of a document that is not there yet. */
  readonly init: () => z.output<S>;
  /** From the shapes earlier published versions wrote, OLDEST FIRST. */
  readonly steps?: readonly DocumentStep[];
}

export function declareDocument<S extends z.ZodType>(declaration: DocumentDeclaration<S>): DocumentDeclaration<S> {
  if (!DOCUMENT_NAME.test(declaration.name)) throw new TypeError(`invalid state document name: ${declaration.name}`);
  const steps = declaration.steps ?? [];
  for (let i = 1; i < steps.length; i++) {
    if (compareVersionNames((steps[i - 1] as DocumentStep).from, (steps[i] as DocumentStep).from) >= 0) throw new TypeError(`the steps of ${declaration.name} are not oldest first`);
  }
  return Object.freeze({ ...declaration, steps: Object.freeze([...steps]) });
}

/**
 * The number the raw file's `version` key holds in today's shape, or null when today's shape has no such key (five
 * documents have none). It is what `init()` writes, so it cannot drift from the schema.
 */
export function expectedVersionOf(declaration: DocumentDeclaration): number | null {
  const initial: unknown = declaration.init();
  return isPlainObject(initial) && typeof initial['version'] === 'number' ? initial['version'] : null;
}

/** A document as phase 1 read it: validated, upgraded in memory, nothing written. */
export interface LoadedDocument<T = unknown> {
  readonly name: string;
  readonly path: string;
  /** In today's shape (frozen). */
  readonly value: Readonly<T>;
  /** The step whose shape the FILE had (`0.4.0`), or null when the file was in today's shape. */
  readonly upgradedFrom: string | null;
  /** The steps that ran, in order (empty when none). */
  readonly ran: readonly DocumentStep[];
  /** The file as it was, read through the checked handle (the kept copy is made from these bytes). */
  readonly bytes: Buffer;
}

/**
 * Validates what a file held against the declaration: today's schema, else each earlier shape and its steps. Pure:
 * no file is touched. Throws StateFileError `newer` or `unreadable`.
 */
export function loadDocumentValue<S extends z.ZodType>(declaration: DocumentDeclaration<S>, path: string, raw: unknown, env: StepEnv): { readonly value: z.output<S>; readonly upgradedFrom: string | null; readonly ran: readonly DocumentStep[] } {
  const current = declaration.schema.safeParse(raw);
  if (current.success) return { value: current.data, upgradedFrom: null, ran: [] };

  // A later smurg says so with the number: above the one this smurg expects, or on a document that has none today.
  const expected = expectedVersionOf(declaration);
  const rawVersion = isPlainObject(raw) ? raw['version'] : undefined;
  if (typeof rawVersion === 'number' && (expected === null || rawVersion > expected)) {
    throw new StateFileError({
      kind: 'newer',
      path,
      message: expected === null ? 'state file carries a version this smurg does not know (a newer smurg wrote it)' : `state file has version ${String(rawVersion).slice(0, 24)}, this smurg reads ${expected} (a newer smurg wrote it)`,
    });
  }

  const steps = declaration.steps ?? [];
  const failures: { readonly from: string | null; readonly error: z.ZodError }[] = [{ from: null, error: current.error }];
  // The newest earlier shape first: the fewest steps between the file and today.
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index] as DocumentStep;
    const matched = step.shape.safeParse(raw);
    if (!matched.success) {
      failures.push({ from: step.from, error: matched.error });
      continue;
    }
    let value: unknown = matched.data;
    const ran: DocumentStep[] = [];
    for (let at = index; at < steps.length; at++) {
      const running = steps[at] as DocumentStep;
      try {
        value = running.upgrade(value, env);
      } catch (source) {
        throw new StateFileError({ kind: 'unreadable', reason: 'carried-value-refused', path, message: `the upgrade step from smurg ${running.from} failed on this state file`, problems: [`(step from ${running.from}): failed`], source });
      }
      ran.push(running);
      const next = steps[at + 1];
      const checked = (next === undefined ? declaration.schema : next.shape).safeParse(value);
      if (!checked.success) {
        // What that smurg accepted and this one refuses (a path with more than 30 combining marks in a row): refused,
        // naming the entry and the rule. No entry is dropped.
        throw new StateFileError({
          kind: 'unreadable',
          reason: 'carried-value-refused',
          path,
          message: `state file was written by smurg ${step.from} and holds a value this smurg refuses (${describeIssues(checked.error)})`,
          problems: problemsOf(checked.error),
        });
      }
      value = checked.data;
    }
    return { value: value as z.output<S>, upgradedFrom: step.from, ran };
  }

  // No shape any published smurg wrote. The problems are measured against the shape the file came closest to (a
  // 0.4.0 file with one bad record must not be answered with "three settings are missing").
  let closest = failures[0] as (typeof failures)[number];
  for (const failure of failures) if (failure.error.issues.length < closest.error.issues.length) closest = failure;
  const problems = problemsOf(closest.error);
  throw new StateFileError({
    kind: 'unreadable',
    reason: 'no-known-shape',
    path,
    message: closest.from === null ? `state file does not match its schema (${describeProblems(problems, 0)})` : `state file does not match its schema; measured against what smurg ${closest.from} wrote: (${describeProblems(problems, 0)})`,
    problems,
  });
}

/** Phase 1 for one document: null when the file is not there. Reads; writes nothing. */
export async function readDocument<S extends z.ZodType>(dir: string, declaration: DocumentDeclaration<S>, env: StepEnv): Promise<LoadedDocument<z.output<S>> | null> {
  const path = join(dir, `${declaration.name}.json`);
  const bytes = await readPrivateFile(path);
  if (bytes === null) return null;
  const loaded = loadDocumentValue(declaration, path, parseJson(path, bytes), env);
  return { name: declaration.name, path, value: deepFreeze(loaded.value), upgradedFrom: loaded.upgradedFrom, ran: loaded.ran, bytes };
}

// =====================================================================================================================
// The stamp: written-by.json
// =====================================================================================================================

export const STAMP_FILE = 'written-by.json';
/**
 * ONE integer for everything persisted under the workspace folder (store documents or not: per-session cards.json,
 * upload manifests with their parts, transcript segments, the lines of audit.jsonl and activity.jsonl). 0.5.1 writes
 * 1. RAISE IT whenever any persisted shape changes; a smurg that meets a higher number refuses the whole folder as
 * `newer` before it reads a document.
 */
export const WORKSPACE_SHAPES = 1;
/** More than this is not a stamp. */
const STAMP_MAX_BYTES = 4096;

const stampSchema = z.strictObject({
  smurg: z.string().regex(VERSION_NAME),
  shapes: z.int().min(1).max(1_000_000),
  at: z.int().min(0),
});
export type WorkspaceStamp = z.infer<typeof stampSchema>;

/**
 * The stamp, or null when the writer is unknown: no stamp, or one that fails any check (a symlink, another owner,
 * group/other bits, not a regular file, too large, not JSON, another form). An unusable stamp is logged and is never
 * a refusal of its own and never `newer`.
 */
export async function readStamp(dir: string, log: Logger): Promise<WorkspaceStamp | null> {
  const path = join(dir, STAMP_FILE);
  const unknown = (reason: string): null => {
    log.warn('the stamp of this workspace folder cannot be used; its writer is unknown', { file: path, reason });
    return null;
  };
  let bytes: Buffer | null;
  try {
    bytes = await readPrivateFile(path, { what: 'stamp', maxBytes: STAMP_MAX_BYTES });
  } catch (err) {
    return unknown(err instanceof StateFileError ? `${err.kind}${err.cause === undefined ? '' : `:${err.cause}`}${err.errno === undefined ? '' : `:${err.errno}`}` : (errnoCode(err) ?? 'unknown'));
  }
  if (bytes === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return unknown('not-json');
  }
  const parsed = stampSchema.safeParse(raw);
  return parsed.success ? parsed.data : unknown('another-form');
}

/** Phase 2, first write: tmp + fsync + rename, 0600. A stamp that cannot be written refuses the start. */
export async function writeStamp(dir: string, stamp: WorkspaceStamp): Promise<void> {
  const path = join(dir, STAMP_FILE);
  try {
    await writePrivateFileAtomic(path, dir, serializeDocument(stampSchema.parse(stamp)));
  } catch (source) {
    throw new StateFileError({ kind: 'cannot-open', errno: errnoCode(source) ?? 'unknown', path, message: `cannot write the stamp (${errnoCode(source) ?? 'unknown'})`, source });
  }
}

// =====================================================================================================================
// Kept copies: <name>.json.before-upgrade-from-<step>
// =====================================================================================================================

const COPY_MARK = '.json.before-upgrade-from-';
/**
 * How many copies of ONE step a document may have beside it: the first carries the step's name alone, the others
 * `-2` … `-99`. A further one is made only when a file that differs from every copy of its step is upgraded (an older
 * file was put back, changed by the smurg that wrote it, and upgraded again); at the bound the start is refused
 * rather than a file upgraded that is kept nowhere.
 */
export const KEPT_COPIES_MAX = 99;

/** `<name>.json.before-upgrade-from-<step>`, and for the second, third, … copy of the same step `-2`, `-3`, … */
export function keptCopyPath(dir: string, name: string, from: string, nth = 1): string {
  if (!DOCUMENT_NAME.test(name) || !isVersionName(from) || !Number.isInteger(nth) || nth < 1 || nth > KEPT_COPIES_MAX) throw new TypeError('invalid kept copy name');
  return join(dir, `${name}${COPY_MARK}${from}${nth === 1 ? '' : `-${nth}`}`);
}

/** The step and the number in what follows the mark of a kept copy's name (`0.4.0`, `0.4.0-2`), or null. */
function keptCopyNameOf(rest: string): { readonly from: string; readonly nth: number } | null {
  const dash = rest.indexOf('-');
  if (dash === -1) return isVersionName(rest) ? { from: rest, nth: 1 } : null;
  const from = rest.slice(0, dash);
  const digits = rest.slice(dash + 1);
  const nth = digits.length >= 1 && digits.length <= 2 ? Number(digits) : Number.NaN;
  // Exactly the names keptCopyPath makes: `-2` … `-99`, written the one way (no `-02`, no `-1`).
  return isVersionName(from) && Number.isInteger(nth) && nth >= 2 && nth <= KEPT_COPIES_MAX && String(nth) === digits ? { from, nth } : null;
}

/**
 * Keeps the file as it was beside the document, before the upgraded document is renamed in: O_CREAT | O_EXCL |
 * O_NOFOLLOW, 0600, fsynced. Never overwritten: 'exists' when something already carries this name (it is left exactly
 * as it is; `keepCopy` then looks at it). Any other failure throws (`cannot-open`): the document is then not written.
 */
export async function writeKeptCopy(path: string, dir: string, bytes: Uint8Array): Promise<'created' | 'exists'> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
  } catch (source) {
    if (errnoCode(source) === 'EEXIST') return 'exists';
    throw new StateFileError({ kind: 'cannot-open', errno: errnoCode(source) ?? 'unknown', path, message: `cannot keep a copy of the state file before its upgrade (${errnoCode(source) ?? 'unknown'})`, source });
  }
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (source) {
    await handle.close().catch(() => {});
    // Ours (O_EXCL made it a moment ago) and incomplete: a half copy under this name would later be taken for the file as it was.
    await unlink(path).catch(() => {});
    throw new StateFileError({ kind: 'cannot-open', errno: errnoCode(source) ?? 'unknown', path, message: `cannot keep a copy of the state file before its upgrade (${errnoCode(source) ?? 'unknown'})`, source });
  }
  await handle.close();
  await syncDirectory(dir);
  return 'created';
}

/** Where the file as it was is kept: a copy made now, or one that was already there with exactly these bytes. */
export interface KeptCopy {
  readonly path: string;
  /** 1 for `<name>.json.before-upgrade-from-<step>`, 2 for `…-2`, … */
  readonly nth: number;
  /** False: a copy of this step already held these bytes (the file was put back from it); nothing new was made. */
  readonly made: boolean;
}

/**
 * Keeps `bytes` (the file as it was, read through the checked handle) as a copy of step `from`, under the first name
 * of that step that is free: `<name>.json.before-upgrade-from-<step>`, then `-2`, `-3`, … A name that is taken is
 * never written. When what it holds IS these bytes, nothing new is made: the file was put back from that copy. When
 * it holds OTHER bytes (the host went back to the older smurg with the copy, worked there, and updated again), the
 * file as it is now is kept too, under the next name: what a smurg is about to rewrite is always kept somewhere.
 *
 * What carries a copy's name must BE a kept copy (a regular file of ours, no group/other bits): a symlink or somebody
 * else's file is refused (`insecure`), and so is a copy that cannot be made (`cannot-open`; with `EEXIST` when every
 * name of the step is taken by other bytes). The caller then does not write the document.
 */
export async function keepCopy(dir: string, name: string, from: string, bytes: Uint8Array): Promise<KeptCopy> {
  for (let nth = 1; nth <= KEPT_COPIES_MAX; nth++) {
    const path = keptCopyPath(dir, name, from, nth);
    // Twice at most for one name: something that was there went away between the two looks.
    for (let attempt = 0; attempt < 2; attempt++) {
      if ((await writeKeptCopy(path, dir, bytes)) === 'created') return { path, nth, made: true };
      const there = await readPrivateFile(path, { what: 'kept copy' });
      if (there === null) continue;
      if (there.equals(bytes)) return { path, nth, made: false };
      break;
    }
  }
  const last = keptCopyPath(dir, name, from, KEPT_COPIES_MAX);
  throw new StateFileError({
    kind: 'cannot-open',
    errno: 'EEXIST',
    path: last,
    message: `cannot keep a copy of the state file before its upgrade: ${KEPT_COPIES_MAX} copies of this step are beside it, none with these bytes (EEXIST)`,
  });
}

/**
 * The kept copies beside `<name>.json`, newest first: every step's, and of one step every one (`-2`, `-3`, …). Only
 * what passes the checks of a private file is listed (a regular file, ours, no group/other bits): a refusal never
 * points the host at a symlink or somebody else's file.
 */
export async function listKeptCopies(dir: string, name: string): Promise<StateFileCopy[]> {
  const prefix = `${name}${COPY_MARK}`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const copies: (StateFileCopy & { readonly nth: number })[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const named = keptCopyNameOf(entry.slice(prefix.length));
    if (named === null) continue;
    const path = join(dir, entry);
    try {
      const st = await lstat(path);
      assertPrivateFileStat(path, st, 'kept copy');
      copies.push({ path, from: named.from, at: Math.floor(st.mtimeMs), nth: named.nth });
    } catch {
      // not a copy this smurg would name
    }
  }
  // By the time each was made; made in the same millisecond, the later step first, and of one step the higher number.
  copies.sort((a, b) => b.at - a.at || compareVersionNames(b.from, a.from) || b.nth - a.nth);
  return copies.map(({ path, from, at }) => ({ path, from, at }));
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
    if (!parsed.success) {
      throw new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path: this.path, message: `invalid ${this.name} update (${describeIssues(parsed.error)})`, problems: problemsOf(parsed.error) });
    }
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
      const text = serializeDocument(this.value);
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

/** A store outside a daemon (unit tests of the store, tools) knows nothing about the machine. */
const NO_ENV: StepEnv = Object.freeze({ memoryBytes: 0 });

export class FileStateStore implements StateStore {
  readonly dir: string;
  private readonly log: Logger;
  /**
   * The documents the daemon's modules declared (FeatureModule.documents, and the core's `state`): only these names
   * can be opened, and what phase 1 read of them is in `preloaded`. Null for a store outside a daemon
   * (FileStateStore.open): any name, read when it is opened.
   */
  private readonly declared: ReadonlyMap<string, DocumentDeclaration> | null;
  private readonly preloaded: Map<string, LoadedDocument>;
  private readonly documents = new Map<string, Promise<PersistentDocument<unknown>>>();
  private readonly loaded = new Set<JsonDocument<unknown>>();
  private readonly healthListeners = new Set<(event: { readonly document: string; readonly ok: boolean }) => void>();

  private constructor(dir: string, log: Logger, declared: ReadonlyMap<string, DocumentDeclaration> | null, preloaded: Map<string, LoadedDocument>) {
    this.dir = dir;
    this.log = log;
    this.declared = declared;
    this.preloaded = preloaded;
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

  /**
   * A store OUTSIDE a daemon (unit tests of the store, tools): creates the directory (0700, with missing parents),
   * refuses an existing one that is not private, and opens any document name, reading it when it is opened. The
   * daemon never uses this: it reads the whole folder first (core/workspace-folder.ts) and adopts what it read.
   */
  static async open(dir: string, log: Logger): Promise<FileStateStore> {
    await ensurePrivateDirectory(dir);
    return new FileStateStore(dir, log, null, new Map());
  }

  /**
   * The daemon's store, after phase 1 accepted the whole folder: `loaded` holds every declared document that exists
   * (already written in today's shape when a step ran: core/workspace-folder.ts does that before it calls this).
   * A declared document that is not there is created from its `init` when its module opens it. Reads nothing.
   */
  static adopt(dir: string, log: Logger, declarations: readonly DocumentDeclaration[], loaded: ReadonlyMap<string, LoadedDocument>): FileStateStore {
    const declared = new Map<string, DocumentDeclaration>();
    for (const declaration of declarations) {
      if (!DOCUMENT_NAME.test(declaration.name)) throw new TypeError(`invalid state document name: ${declaration.name}`);
      if (declared.has(declaration.name)) throw new TypeError(`state document ${declaration.name} is declared twice`);
      declared.set(declaration.name, declaration);
    }
    for (const name of loaded.keys()) if (!declared.has(name)) throw new TypeError(`state document ${name} was read and never declared`);
    return new FileStateStore(dir, log, declared, new Map(loaded));
  }

  /** Whether a module declared `name` (always true for a store outside a daemon). */
  declares(name: string): boolean {
    return this.declared === null || this.declared.has(name);
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
    let declaration: DocumentDeclaration<S>;
    if (this.declared === null) {
      declaration = { name, schema, init };
    } else {
      const declared = this.declared.get(name);
      // Every document is read and checked before a start writes anything: one that no module declared was not.
      if (declared === undefined) return Promise.reject(new TypeError(`state document ${name} was not declared (FeatureModule.documents): a start reads every document before it writes anything`));
      if (declared.schema !== schema) return Promise.reject(new TypeError(`state document ${name} is opened with another schema than it was declared with`));
      declaration = declared as DocumentDeclaration<S>;
    }
    const existing = this.documents.get(name);
    if (existing) return existing as Promise<PersistentDocument<z.output<S>>>;
    const loading = this.load(declaration);
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

  private async load<S extends z.ZodType>(declaration: DocumentDeclaration<S>): Promise<PersistentDocument<z.output<S>>> {
    type T = z.output<S>;
    const { name } = declaration;
    const schema = declaration.schema as unknown as z.ZodType<T>;
    const path = join(this.dir, `${name}.json`);
    // The daemon: what phase 1 read. Outside a daemon: read now.
    const found = this.declared === null ? await readDocument(this.dir, declaration, NO_ENV) : ((this.preloaded.get(name) as LoadedDocument<T> | undefined) ?? null);
    this.preloaded.delete(name);
    if (found === null) {
      const initial = schema.safeParse(declaration.init());
      if (!initial.success) {
        throw new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path, message: `invalid initial ${name} (${describeIssues(initial.error)})`, problems: problemsOf(initial.error) });
      }
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
    const doc = new JsonDocument(name, this.dir, schema, found.value as T, this.log, this.health);
    this.loaded.add(doc as JsonDocument<unknown>);
    return doc;
  }
}
