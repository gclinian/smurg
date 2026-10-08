// A start has two phases (ARCHITECTURE §7.1).
//
// PHASE 1 ONLY READS (readWorkspaceFolder). Before the daemon creates a key, opens a log, makes a folder or runs any
// module code, it looks at the stamp `written-by.json` (its `shapes` number alone decides `newer`, for the whole
// folder); checks owner, mode and kind of identity.key, audit.jsonl, audit-text.jsonl, activity.jsonl, every declared
// document that exists and every kept copy beside one; reads the key; reads and validates every declared document
// that exists, upgrading in memory and creating none; and, for every document a step ran on, finds the name its kept
// copy will get (a name that is in the way, or none that is free, refuses here). A refusal of phase 1 leaves the
// workspace folder byte for byte as it was: names, modes, bytes. It says `phase: 1`.
//
// PHASE 2 WRITES (writeWorkspaceFolder), only when phase 1 accepted everything, in this order: the folder itself (a
// new workspace); `written-by.json`, with `pending` = the documents this start will upgrade; for every upgraded
// document its kept copy, then the document; `written-by.json` again, without `pending`. Then the daemon goes on with
// everything a start does (the key and the first state.json of a new folder, the logs, ensureHost, prune, the
// modules). A refusal that comes from here says `phase: 2`: something of the above may be on disk, nobody may say
// "nothing was changed" (nothing the workspace held is lost: a document is replaced only after its copy is kept).
//
// An upgrade that did not finish (a kill, a full disk, a refusal of phase 2) is not a put back. The stamp says what
// is under way: a start that finds `pending` finishes the job and reports the upgrade, whatever of it was already
// done. `putBack` needs a usable stamp WITHOUT `pending`.
//
// A workspace folder is NEW only when it holds neither identity.key nor state.json. state.json absent while the key,
// another document or a log is there, or the key absent while state.json is there, is a refusal (`unreadable`, reason
// `missing`) and nothing is created: a key without a state document is a question for the host, not a fresh
// workspace (every member, kick and used-up link would be forgotten under the old key). A folder that holds nothing
// but the stamp IS new: that is what a first start leaves that died right after it wrote the stamp.
import { basename, join } from 'node:path';
import { DAEMON_IDENTITY_KEY_FILE, KeyFileError, assertPrivateDirectory, ensurePrivateDirectory, loadDaemonIdentity, type LoadedStaticKey } from '@smurg/protocol/node';
import type { Clock } from './lifecycle.ts';
import type { Logger } from './logger.ts';
import { inspectPrivateFile } from './private-file.ts';
import {
  FileStateStore,
  WORKSPACE_SHAPES,
  compareVersionNames,
  keepCopy,
  keptCopyNames,
  keptCopyPath,
  listKeptCopies,
  lookAtStamp,
  planKeptCopy,
  readDocument,
  serializeDocument,
  writePrivateFileAtomic,
  writeStamp,
  type DocumentDeclaration,
  type LoadedDocument,
  type PendingUpgrade,
  type StepEnv,
  type WorkspaceStamp,
} from './state-store.ts';
import { STATE_FILE_INSECURE_CAUSES, StateFileError, errnoCodeOf, type StateFileInsecureCause } from './state-file-error.ts';

/** The core's document: the one that makes a folder a workspace, together with the key. */
const CORE_DOCUMENT = 'state';

/** The logs of the workspace folder whose owner, mode and kind phase 1 checks (they are opened in phase 2). */
export const WORKSPACE_LOG_FILES = Object.freeze([
  { name: 'audit.jsonl', what: 'audit log' },
  { name: 'audit-text.jsonl', what: 'audit text store' },
  { name: 'activity.jsonl', what: 'activity log' },
] as const);

export interface FolderReadOptions {
  /** `~/.smurg/workspaces/<workspaceId>` */
  readonly dir: string;
  readonly log: Logger;
  /** Every declared document: the core's `state` and those of the composed modules, in module order. */
  readonly documents: readonly DocumentDeclaration[];
  readonly env: StepEnv;
  /** This smurg's version (DAEMON_VERSION). */
  readonly smurg: string;
  /** This smurg's number for everything persisted under the folder. Default WORKSPACE_SHAPES. */
  readonly shapes?: number;
  /** When given: a state.json that names another workspace is refused (`other-workspace`). */
  readonly workspaceId?: string;
}

/** What phase 1 found. Nothing was written to get it. */
export interface FolderReading {
  readonly dir: string;
  /** The folder holds neither identity.key nor state.json (nor a log, a document or a stamp): phase 2 makes it. */
  readonly isNew: boolean;
  /** Null: the writer is unknown (no stamp, or one that cannot be used). */
  readonly stamp: WorkspaceStamp | null;
  /** The daemon's key as read (null for a new folder: it is created with the first state.json). */
  readonly keyPair: LoadedStaticKey['keyPair'] | null;
  readonly documents: readonly DocumentDeclaration[];
  /** Every declared document that exists, in today's shape (upgraded in memory when a step ran). */
  readonly loaded: ReadonlyMap<string, LoadedDocument>;
  /**
   * A step ran although the stamp names a smurg that has that step, and no upgrade is under way: an OLDER file was
   * put back. (A stamp with `pending` is an upgrade that did not finish: never this.)
   */
  readonly putBack: boolean;
  /**
   * For every document a step ran on: the path its kept copy gets (the first name of the step that is free, or the
   * one that already holds the file's bytes), found in phase 1. Absent for a reading made by hand.
   */
  readonly copies?: ReadonlyMap<string, string>;
  readonly smurg: string;
  readonly shapes: number;
}

/** identity.key's own refusals, as kinds (the directory's stay a KeyFileError: the command words those already). */
function keyRefusal(err: KeyFileError): StateFileError | KeyFileError {
  const base = { path: err.path, source: err } as const;
  switch (err.code) {
    case 'not-regular-file':
      return new StateFileError({ ...base, kind: 'insecure', cause: 'not-a-file', message: 'key file is not a regular file' });
    case 'not-owner':
      return new StateFileError({ ...base, kind: 'insecure', cause: 'owner', message: 'key file is owned by another user' });
    case 'insecure-permissions':
      return new StateFileError({ ...base, kind: 'insecure', cause: 'mode', message: 'key file grants group/other access' });
    case 'wrong-size':
      return new StateFileError({ ...base, kind: 'unreadable', reason: 'no-known-shape', message: 'key file must be exactly 32 bytes', problems: ['(file): not exactly 32 bytes'] });
    case 'missing':
      return new StateFileError({ ...base, kind: 'unreadable', reason: 'missing', message: 'key file is missing', problems: ['(file): missing'] });
    default:
      return err; // insecure-directory, exists
  }
}

/**
 * PHASE 1. Reads and checks everything a start will rely on and writes NOTHING. Throws StateFileError with its kind
 * (and KeyFileError 'insecure-directory' when the folder itself is not private).
 */
export async function readWorkspaceFolder(options: FolderReadOptions): Promise<FolderReading> {
  const { dir, log, documents, env, smurg } = options;
  const shapes = options.shapes ?? WORKSPACE_SHAPES;
  const names = new Set<string>();
  for (const declaration of documents) {
    if (names.has(declaration.name)) throw new TypeError(`state document ${declaration.name} is declared twice`);
    names.add(declaration.name);
  }
  const fresh: FolderReading = { dir, isNew: true, stamp: null, keyPair: null, documents, loaded: new Map(), putBack: false, smurg, shapes };

  // The folder itself: not there is a new workspace; there and not private is refused as before (never chmod-ed).
  try {
    await assertPrivateDirectory(dir);
  } catch (err) {
    if (err instanceof KeyFileError && err.code === 'missing' && err.path === dir) return fresh;
    throw err;
  }

  // The stamp decides `newer` for the WHOLE folder before any document is read, and its `shapes` number decides it
  // ALONE: whatever else the stamp holds, and whoever may read the file (a later smurg may add keys to its own stamp
  // or name its version another way; a restore may have lost the modes). Everything else about a stamp that does
  // not fit only makes its writer unknown.
  const looked = await lookAtStamp(dir, log);
  const stamp = looked.stamp;
  if (looked.shapes !== null && looked.shapes > shapes) {
    throw new StateFileError({
      kind: 'newer',
      path: dir,
      message: `this workspace folder was last written by a newer smurg (${looked.smurg ?? 'its name is not one this smurg knows'}, shapes ${String(looked.shapes).slice(0, 24)}; this is ${smurg}, shapes ${shapes})`,
      ...(looked.smurg === null ? {} : { writtenBy: looked.smurg }),
    });
  }
  const writtenBy = stamp === null ? {} : { writtenBy: stamp.smurg };

  // Owner, mode and kind of everything, ALL of it before anything is reported: one refusal names every such path.
  const keyPath = join(dir, DAEMON_IDENTITY_KEY_FILE);
  const files = [
    { path: keyPath, what: 'key file', document: null as string | null },
    ...WORKSPACE_LOG_FILES.map((file) => ({ path: join(dir, file.name), what: file.what, document: null as string | null })),
    ...documents.map((declaration) => ({ path: join(dir, `${declaration.name}.json`), what: 'state file', document: declaration.name as string | null })),
  ];
  // The kept copies too (they hold what the documents held, the keys of the invite links with it): whatever carries
  // a copy's name is looked at, whether or not a step will run. After the documents, in their order.
  const copyPaths = new Set<string>();
  for (const declaration of documents) for (const path of await keptCopyNames(dir, declaration.name)) copyPaths.add(path);
  for (const path of copyPaths) files.push({ path, what: 'kept copy', document: null });
  const present = new Set<string>();
  const refusals: StateFileError[] = [];
  for (const file of files) {
    const inspected = await inspectPrivateFile(file.path, file.what);
    if (inspected.exists) present.add(file.path);
    if (inspected.refusal !== null) refusals.push(inspected.refusal);
  }
  // What only the folder's reader knows about a refused file: which declared document it is, and its kept copies.
  const copiesOf = async (path: string): Promise<{ readonly document?: string; readonly copies?: Awaited<ReturnType<typeof listKeptCopies>> }> => {
    const document = files.find((file) => file.path === path)?.document ?? null;
    return document === null ? {} : { document, copies: await listKeptCopies(dir, document) };
  };
  const insecure = refusals.filter((refusal) => refusal.kind === 'insecure');
  if (insecure.length > 0) {
    // One cause at a time, the one that a `chmod` cannot cure first; `paths` are the files with THAT cause.
    const cause = STATE_FILE_INSECURE_CAUSES.find((candidate) => insecure.some((refusal) => refusal.cause === candidate)) as StateFileInsecureCause;
    const same = insecure.filter((refusal) => refusal.cause === cause);
    throw (same[0] as StateFileError).with({ paths: same.map((refusal) => refusal.path), ...writtenBy, ...(await copiesOf((same[0] as StateFileError).path)) });
  }
  if (refusals.length > 0) {
    const first = refusals[0] as StateFileError;
    throw first.with({ paths: refusals.filter((refusal) => refusal.kind === first.kind).map((refusal) => refusal.path), ...writtenBy, ...(await copiesOf(first.path)) });
  }

  // New, or one half of a workspace without the other.
  const statePath = join(dir, `${CORE_DOCUMENT}.json`);
  const hasKey = present.has(keyPath);
  const hasState = present.has(statePath);
  if (!hasState) {
    // The key, another document, a log. NOT the stamp: a folder that holds nothing but the stamp is what a first
    // start leaves that died right after it wrote it, and there is nothing in it to lose. (Nor a kept copy alone,
    // as before: it is looked at above, and it does not make a folder a workspace.)
    const others = [...present].filter((path) => path !== statePath && !copyPaths.has(path));
    if (others.length === 0) return { ...fresh, stamp };
    throw new StateFileError({
      kind: 'unreadable',
      reason: 'missing',
      path: statePath,
      message: `state file is missing although this workspace folder holds ${others.length === 1 ? 'another file' : `${others.length} other files`} of a workspace (nothing was created)`,
      problems: ['(file): missing'],
      copies: await listKeptCopies(dir, CORE_DOCUMENT),
      document: CORE_DOCUMENT,
      ...writtenBy,
    });
  }
  if (!hasKey) {
    throw new StateFileError({
      kind: 'unreadable',
      reason: 'missing',
      path: keyPath,
      message: 'key file is missing although this workspace folder holds a state file (no new key was created)',
      problems: ['(file): missing'],
      ...writtenBy,
    });
  }

  // The key is read, never created.
  let keyPair: LoadedStaticKey['keyPair'];
  try {
    keyPair = await loadDaemonIdentity(dir);
  } catch (err) {
    if (err instanceof KeyFileError) {
      const refusal = keyRefusal(err);
      throw refusal instanceof StateFileError ? refusal.with(writtenBy) : refusal;
    }
    throw new StateFileError({ kind: 'cannot-open', errno: errnoCodeOf(err) ?? 'unknown', path: keyPath, message: `cannot read the key file (${errnoCodeOf(err) ?? 'unknown'})`, source: err, ...writtenBy });
  }

  // Every declared document that exists: read, validated, upgraded in memory. None is created.
  const loaded = new Map<string, LoadedDocument>();
  for (const declaration of documents) {
    let document: LoadedDocument | null;
    try {
      document = await readDocument(dir, declaration, env);
    } catch (err) {
      // Which document it is, and whether the host may set this one file aside (the error itself says yes only for
      // an `unreadable` file; a file open to others is cured by a chmod, a newer one by an update).
      if (err instanceof StateFileError) throw err.with({ ...writtenBy, copies: await listKeptCopies(dir, declaration.name), document: declaration.name, canSetAside: declaration.canSetAside === true });
      throw err;
    }
    if (document !== null) loaded.set(declaration.name, document);
  }
  const state = loaded.get(CORE_DOCUMENT);
  if (options.workspaceId !== undefined && state !== undefined && (state.value as { readonly workspaceId?: unknown }).workspaceId !== options.workspaceId) {
    throw new StateFileError({ kind: 'other-workspace', path: statePath, message: 'state file belongs to another workspace', document: CORE_DOCUMENT, ...writtenBy });
  }

  // The copy every step that ran WILL make: its name is found now, before anything is written. Something in the way
  // of one that is no private file of ours was refused above (every name of a kept copy is among the files looked
  // at); no name that is free refuses here.
  const copies = new Map<string, string>();
  for (const document of loaded.values()) {
    if (document.upgradedFrom === null) continue;
    try {
      copies.set(document.name, await planKeptCopy(dir, document.name, document.upgradedFrom, document.bytes));
    } catch (err) {
      if (err instanceof StateFileError) throw err.with(writtenBy);
      throw err;
    }
  }

  // The stamp's writer has the step itself (0.5.1 or later for the steps from 0.4.0: every smurg that stamps a folder
  // has them): it upgraded this document in its own start. The old shape is back. Unless that start never finished:
  // then its stamp still says what was under way, and this start finishes it.
  const putBack = stamp !== null && stamp.pending === undefined && [...loaded.values()].some((document) => document.ran.some((step) => stamp.shapes >= step.sinceShapes));
  return { dir, isNew: false, stamp, keyPair, documents, loaded, putBack, copies, smurg, shapes };
}

export interface UpgradedDocument {
  readonly document: string;
  /** The step's name: the published smurg whose shape the file had (`0.4.0`). */
  readonly from: string;
  /**
   * Absolute path of the kept copy that holds the file as it was: `<name>.json.before-upgrade-from-<from>`, or with
   * `-2`, `-3`, … when a copy of this step with other bytes was already there.
   */
  readonly copy: string;
}

/**
 * PHASE 2, the folder's own part: the folder (0700); the stamp FIRST, saying which documents this start will upgrade
 * (`pending`); for every upgraded document its kept copy and then the document, in THIS start; the stamp again,
 * without `pending`, when the last of them is on disk. Returns the daemon's store. A failure refuses the start, and
 * the refusal says `phase: 2`: the stamp could not be written, a copy could not be created (the document is then not
 * written), a document could not be written.
 *
 * `upgraded` is what the host is told: the documents this start upgraded, and those a start before it upgraded
 * without living to say so (its stamp still named them).
 */
export async function writeWorkspaceFolder(
  reading: FolderReading,
  options: {
    readonly log: Logger;
    readonly clock: Clock;
    /**
     * A SEAM FOR TESTS: called after each write that is on disk (`stamp`, `copy:<document>`, `document:<document>`).
     * A test that throws from it is a start that died right there: nothing after it happens, nothing is cleaned up.
     */
    readonly interrupt?: (written: string) => void | Promise<void>;
  },
): Promise<{ readonly store: FileStateStore; readonly upgraded: readonly UpgradedDocument[] }> {
  try {
    return await writeFolder(reading, options);
  } catch (err) {
    throw err instanceof StateFileError ? err.with({ phase: 2 }) : err;
  }
}

async function writeFolder(reading: FolderReading, options: Parameters<typeof writeWorkspaceFolder>[1]): Promise<{ readonly store: FileStateStore; readonly upgraded: readonly UpgradedDocument[] }> {
  const { dir } = reading;
  const { log, clock } = options;
  const written = async (what: string): Promise<void> => {
    await options.interrupt?.(what);
  };
  await ensurePrivateDirectory(dir);
  // Never lowered, neither the name (an older smurg that opens a folder of the same shapes keeps the newer writer's
  // name) nor the number (phase 1 refuses a folder whose stamp carries a higher one; this is the second lock).
  const smurg = reading.stamp !== null && compareVersionNames(reading.stamp.smurg, reading.smurg) > 0 ? reading.stamp.smurg : reading.smurg;
  const shapes = Math.max(reading.shapes, reading.stamp?.shapes ?? 0);

  const toUpgrade = [...reading.loaded.values()].filter((document) => document.upgradedFrom !== null);
  // What a start before this one had under way and did upgrade (its stamp still names it; the file is in today's
  // shape now): reported by THIS start, and named in the stamp until this start is through as well.
  const carried = (reading.stamp?.pending ?? []).filter((entry) => reading.loaded.get(entry.document)?.upgradedFrom === null);
  const pending: PendingUpgrade[] = [
    ...carried,
    ...toUpgrade.map((document) => ({
      document: document.name,
      from: document.upgradedFrom as string,
      copy: basename(reading.copies?.get(document.name) ?? keptCopyPath(dir, document.name, document.upgradedFrom as string)),
    })),
  ];
  await writeStamp(dir, { smurg, shapes, at: clock.now(), ...(toUpgrade.length > 0 ? { pending } : {}) });
  await written('stamp');

  const underWay = new Set((reading.stamp?.pending ?? []).map((entry) => entry.document));
  const now = new Map<string, UpgradedDocument>();
  for (const document of toUpgrade) {
    const from = document.upgradedFrom as string;
    // The file as it was, from the bytes phase 1 read through the checked handle (never a second read of the path),
    // kept under the first name of this step that is free. A name that is taken is never written: when it holds
    // these very bytes nothing new is made (the file was put back from that copy, or a start that died made it);
    // when it holds other bytes the file as it is now is kept under the next name (`-2`, `-3`, …). Phase 1 found
    // that name; should something have taken it since, this refuses the start: the document is then not written.
    const kept = await keepCopy(dir, document.name, from, document.bytes);
    const copy = kept.path;
    await written(`copy:${document.name}`);
    if (!kept.made && underWay.has(document.name)) {
      log.info('the kept copy is already beside the state file: a start before this one made it and did not finish', { document: document.name, from, copy });
    } else if (!kept.made) {
      log.warn('a kept copy of this step is already beside the state file, with the same bytes: the file was put back', { document: document.name, from, copy });
    } else if (kept.nth > 1) {
      log.warn('a kept copy of this step is already beside the state file and holds other bytes; it stays as it is, and the file as it is now was kept under the next name', {
        document: document.name,
        from,
        copy,
        earlier: keptCopyPath(dir, document.name, from),
      });
    }
    try {
      await writePrivateFileAtomic(document.path, dir, serializeDocument(document.value));
    } catch (source) {
      throw new StateFileError({
        kind: 'cannot-open',
        errno: errnoCodeOf(source) ?? 'unknown',
        path: document.path,
        message: `cannot write the upgraded state file (${errnoCodeOf(source) ?? 'unknown'})`,
        source,
        document: document.name,
        ...(reading.stamp === null ? {} : { writtenBy: reading.stamp.smurg }),
      });
    }
    await written(`document:${document.name}`);
    now.set(document.name, { document: document.name, from, copy });
    log.info('state file upgraded', { document: document.name, from, copy, putBack: reading.putBack });
  }
  // The last of them is on disk: the upgrade is no longer under way.
  if (toUpgrade.length > 0) {
    await writeStamp(dir, { smurg, shapes, at: clock.now() });
    await written('stamp');
  }

  // In the order of the declarations, whichever start wrote each.
  const upgraded: UpgradedDocument[] = [];
  for (const declaration of reading.documents) {
    const mine = now.get(declaration.name);
    const earlier = carried.find((entry) => entry.document === declaration.name);
    if (mine !== undefined) upgraded.push(mine);
    else if (earlier !== undefined) {
      upgraded.push({ document: earlier.document, from: earlier.from, copy: join(dir, earlier.copy) });
      log.info('state file upgraded by a start before this one that did not finish', { document: earlier.document, from: earlier.from, copy: join(dir, earlier.copy) });
    }
  }
  return { store: FileStateStore.adopt(dir, log, reading.documents, reading.loaded), upgraded: Object.freeze(upgraded) };
}
