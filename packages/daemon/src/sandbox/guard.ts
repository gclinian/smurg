// Linux: what the guest sandbox's mounts cannot follow while a guest process runs (reviews RV-1 and RV-2, 2026-10-01;
// ARCHITECTURE §7.6 "Linux, protected entries while a guest runs", §12).
//
// bubblewrap protects a host-only or host-private name by MOUNTING something on the path as it is when the guest
// process starts: a read-only bind of the entry (`.claude/`, `.mcp.json`, a nested `.git`), /dev/null over a
// read-denied file (`.envrc`, `.claude/settings.local.json`, `CLAUDE.local.md`; srt expands its globs at that moment),
// srt's empty 0444 mount point over an absent write-denied file. A mount sits on a directory entry. When the HOST
// replaces, removes or renames such an entry while the guest runs (an editor's atomic save, `git switch`, `git clean
// -fd`, Claude Code's "don't ask again"), the kernel detaches the guest's mount and the guest sees the new entry
// unprotected: it reads the new `.envrc`, or plants `.claude/settings.json` (measured, diff-review E1, E2, E5, E6). A
// read-denied file the host CREATES after the start was never covered (E7). No mount can follow either.
//
// So while guest processes run in a root (or a wrap() for it is in flight), this guard keeps the state of every
// protected entry of that root as the latest wrap() saw it (taken before srt expands its globs), holding a descriptor
// on each existing one (ext4 hands a freed inode number straight back, E3: 5 of 5; an inode that is held cannot be
// freed, so a replacement always has another number), and compares again:
//   - on every file-watcher batch, as it arrives (review GR-3: not behind the files module's own work): a protected name
//     at any depth, and every directory that appeared (its subtree);
//   - every GUARD_POLL_MS, the recorded entries (the watcher ignores `.git`; inotify can drop events);
//   - every GUARD_WALK_MS at most (spaced to ten times the walk's own duration), a walk of the whole root for protected
//     names the record does not have (review GR-1): @parcel/watcher's inotify backend watches a new directory only
//     when it handles that directory's own creation, so in directories made in one burst with their parent (`mkdir
//     -p`, a checkout, an unpack, a folder moved in) later changes produce no event at all, and it drops an inotify
//     queue overflow without a word. Also at once when the watcher reports an error (rescan);
//   - on every later wrap() in that root (its fresh view against the recorded one);
//   - when the root's last process is released: the top-level names synchronously (before srt removes its mount
//     points), then the rest of the record and one more walk (a guest that planted a name and exited at once; the
//     host is told, nothing is left to revoke).
// Any difference revokes every WrappedCommand handed out for that root (SandboxService.onRevoked: the sessions module
// ends the processes), makes a wrap() in flight there refuse (`protected-changed`) and is reported (GuardBreach). It
// is a detection, not a prevention: a guest has until the change is noticed and its processes are ended.
//
// Rules of the comparison (`changed`): the same state is no change; an absent top-level `.mcp.json` / `.envrc` that
// became srt's empty 0444 file is bubblewrap's own mount point (made when a guest process starts); srt's file that
// became absent or was made again is srt's own doing only while no process runs (srt removes its mount points when its
// count of running wraps is zero); the same regular file with another mode (`chmod`) is no change (review GR-11), but
// only while the record holds that inode (one nobody holds can be handed straight back to a new file, E3, which would
// then pass for the old one); everything else is a change, a new entry included. A NEW nested `.git` is not looked for
// (the watcher never reports `.git`, and a guest's `git clone` makes one: ARCHITECTURE §12 residual); the walk leaves
// it out too.
//
// Readings are asynchronous while the record changes under them: issue() makes srt's files, a later wrap()'s enter()
// rewrites the record, and whether a process runs is decided when the reading is compared. A reading that started
// before the record of a path was last written is not trusted for that path: where it differs, the path is read again,
// synchronously, and that state counts (review GR-5: a stale reading reported after a newer one revoked guests started
// since and wrote the old state back; CI run 36810877157: a poll or a watcher batch that read `.mcp.json` as absent
// before issue() made it, compared once the command was handed out, revoked a terminal that had just started). enter()
// keeps what was recorded while it looked.
import { closeSync, constants, fstat, fstatSync, lstatSync, open, openSync, type BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SandboxRevocation, WatchedPathEvent, WrappedCommand } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';
import { HOST_ONLY_DIR_NAMES, HOST_ONLY_FILE_NAMES, HOST_PERSONAL_FILES, HOST_PRIVATE_READ_DENIED_NAMES, isStrictlyUnder } from './policy.ts';

/** How often the recorded entries of every guarded root are compared again. */
export const GUARD_POLL_MS = 2_000;
/** The least time between two walks of a guarded root for protected names nothing reported (review GR-1). */
export const GUARD_WALK_MS = 2_000;
/** A root is walked again at the earliest this many times its last walk's duration later (a large tree less often). */
const GUARD_WALK_SPACING = 10;
/** Directories one check of the directories that appeared may list in all (a larger one is left to the walk). */
export const GUARD_SCAN_MAX_DIRS = 10_000;
/** Paths a breach (and a revocation) names; the rest is counted (review GR-2). */
export const GUARD_BREACH_PATHS_MAX = 100;
/** Entries one report re-pins after a difference; the rest is recorded without a descriptor (review GR-2). */
export const GUARD_REPIN_MAX = 256;
const GUARD_CONCURRENCY = 16;

/**
 * The state of a path: absent, srt's mount-point file `srt-file:<dev>:<ino>`, `<kind>:<dev>:<ino>`, or
 * `error:<code>`.
 */
type EntryState = string;
const ABSENT: EntryState = 'absent';
const SRT_FILE = 'srt-file';

/** Linux `O_PATH` (asm-generic, x86 and arm64 alike; not in fs.constants): a handle on the inode, nothing readable. */
const O_PATH = 0o10000000;
/** Linux: O_PATH | O_NOFOLLOW opens a symlink or a FIFO as itself. Elsewhere (unit tests on macOS) a read-only open. */
function pinFlags(): number {
  return process.platform === 'linux' ? O_PATH | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

/**
 * Open errors that say the daemon is out of a resource, not that the entry is odd (review GR-7): without the descriptor
 * a replaced entry can carry the same inode number, so the wrap is refused instead (§0 rule 6, fail closed).
 */
const RESOURCE_ERRORS: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'ENOMEM']);

/** The guard could not hold the protected entries of a root (the daemon is out of descriptors or memory). */
export class GuardResourceError extends Error {
  constructor(code: string) {
    super(`the protected entries of the session root cannot be held open (${code})`);
    this.name = 'GuardResourceError';
  }
}

/** Every name the guard compares at the top of a root (relative). */
export const GUARD_TOP_LEVEL: readonly string[] = Object.freeze([...new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES, ...HOST_PERSONAL_FILES, ...HOST_PRIVATE_READ_DENIED_NAMES])]);
const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES, ...HOST_PRIVATE_READ_DENIED_NAMES, ...HOST_PERSONAL_FILES.filter((rel) => !rel.includes('/'))]);
/** Personal files below a directory name (`.claude/settings.local.json`): [directory name, file name]. */
const PERSONAL_IN_DIR: readonly (readonly [string, string])[] = HOST_PERSONAL_FILES.filter((rel) => rel.includes('/')).map((rel) => rel.split('/') as [string, string]);
/** Names a scan neither reports nor enters (srt and the nested walk skip node_modules; `.git`: see the header). */
const SCAN_SKIP: ReadonlySet<string> = new Set(['node_modules', '.git']);
/** New names the walk does not report (the header: a guest's `git clone`). */
const WALK_NEW_SKIP: ReadonlySet<string> = new Set(['.git']);

/** Whether `path` names a protected entry by itself (any depth). */
export function isProtectedPath(path: string): boolean {
  const name = basename(path);
  if (PROTECTED_BASENAMES.has(name)) return true;
  const parent = basename(dirname(path));
  return PERSONAL_IN_DIR.some(([dir, file]) => dir === parent && file === name);
}

/** The paths below `dir` that a protected entry has inside it (`<dir>/.claude/settings.local.json`). */
function personalInside(dir: string): string[] {
  const name = basename(dir);
  return PERSONAL_IN_DIR.filter(([d]) => d === name).map(([, file]) => join(dir, file));
}

function stateOf(st: BigIntStats, srtShape: boolean): EntryState {
  // bubblewrap's ensure_file(dest, 0444): empty, no write bit, one link (srt's own test, isStaleBwrapMountPoint).
  if (srtShape && st.isFile() && st.size === 0n && (st.mode & 0o222n) === 0n && st.nlink === 1n) return `${SRT_FILE}:${st.dev}:${st.ino}`;
  const kind = st.isDirectory() ? 'd' : st.isFile() ? 'f' : st.isSymbolicLink() ? 'l' : 'o';
  return `${kind}:${st.dev}:${st.ino}`;
}

function isSrtFile(state: EntryState): boolean {
  return state.startsWith(`${SRT_FILE}:`);
}

/** `<dev>:<ino>` of a regular file's state (srt's or another), else null. */
function fileIdentity(state: EntryState): string | null {
  if (isSrtFile(state)) return state.slice(SRT_FILE.length + 1);
  return state.startsWith('f:') ? state.slice(2) : null;
}

function errorState(err: unknown): EntryState {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? ABSENT : `error:${code ?? 'unknown'}`;
}

async function stateAt(path: string, srtShape: boolean): Promise<EntryState> {
  try {
    return stateOf(await lstat(path, { bigint: true }), srtShape);
  } catch (err) {
    return errorState(err);
  }
}

function stateAtSync(path: string, srtShape: boolean): EntryState {
  try {
    return stateOf(lstatSync(path, { bigint: true }), srtShape);
  } catch (err) {
    return errorState(err);
  }
}

function openFd(path: string, flags: number): Promise<number> {
  return new Promise((resolve, reject) => open(path, flags, (err, fd) => (err ? reject(err) : resolve(fd))));
}

function fstatFd(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) => fstat(fd, { bigint: true }, (err, st) => (err ? reject(err) : resolve(st))));
}

function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? 'unknown';
}

/**
 * The state of `path` and a descriptor that keeps its inode. Throws GuardResourceError when the daemon is out of
 * descriptors or memory (review GR-7); other open errors fall back to lstat without a descriptor.
 */
async function pin(path: string, srtShape: boolean): Promise<{ readonly state: EntryState; readonly fd: number | null }> {
  let fd: number;
  try {
    fd = await openFd(path, pinFlags());
  } catch (err) {
    if (RESOURCE_ERRORS.has(errorCode(err))) throw new GuardResourceError(errorCode(err));
    const state = errorState(err);
    return { state: state === ABSENT ? ABSENT : await stateAt(path, srtShape), fd: null };
  }
  try {
    return { state: stateOf(await fstatFd(fd), srtShape), fd };
  } catch (err) {
    closeFd(fd);
    return { state: errorState(err), fd: null };
  }
}

/**
 * dev / ino of the directory entry at `path` and a descriptor that holds its inode (SandboxServiceImpl's own
 * placeholder directories, review RV-3: while it is held, a directory made in its place gets another inode number).
 * Null when nothing is there any more.
 */
export async function holdInode(path: string): Promise<{ readonly dev: bigint; readonly ino: bigint; readonly fd: number | null } | null> {
  try {
    const fd = await openFd(path, pinFlags());
    try {
      const st = await fstatFd(fd);
      return { dev: st.dev, ino: st.ino, fd };
    } catch {
      closeFd(fd);
      return null;
    }
  } catch {
    const st = await lstat(path, { bigint: true }).catch(() => null);
    return st === null ? null : { dev: st.dev, ino: st.ino, fd: null };
  }
}

/**
 * The comparison rules (header). `running`: a process handed out for this root has not been released. `held`: the
 * record holds a descriptor on the inode of `before`.
 */
function changed(before: EntryState, now: EntryState, running: boolean, held: boolean): boolean {
  if (before === now) return false;
  if (before === ABSENT && isSrtFile(now)) return false;
  // srt removes its mount points, and bubblewrap makes them again, only while nothing of this daemon runs; while a
  // process runs here, its mount point removed, or replaced by another empty read-only file, is the host's doing.
  if (isSrtFile(before) && (now === ABSENT || isSrtFile(now))) return running;
  // The same file with another mode only while its inode is held: a freed inode number comes straight back (E3).
  const a = fileIdentity(before);
  return !held || a === null || a !== fileIdentity(now);
}

/**
 * srt's mount point at `path`, made as bubblewrap's ensure_file makes it (empty, 0444) or, when the name exists, what
 * is there, with a descriptor holding its inode. Null when it can be neither made nor opened.
 */
function makeOrHold(path: string): { readonly state: EntryState; readonly fd: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') return null;
    try {
      fd = openSync(path, pinFlags());
    } catch {
      return null;
    }
  }
  try {
    return { state: stateOf(fstatSync(fd, { bigint: true }), true), fd };
  } catch {
    closeFd(fd);
    return null;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** What a scan below a directory found, and how many directories it listed. */
interface Scan {
  readonly found: string[];
  readonly complete: boolean;
  readonly listed: number;
}

async function scanBelow(dir: string, maxDirs: number): Promise<Scan> {
  const found: string[] = [];
  const queue = [dir];
  let listed = 0;
  let complete = true;
  while (queue.length > 0) {
    const batch = queue.splice(0, GUARD_CONCURRENCY);
    if (listed + batch.length > maxDirs) {
      complete = false;
      break;
    }
    listed += batch.length;
    const listings = await Promise.all(batch.map((d) => readdir(d, { withFileTypes: true }).catch(() => [])));
    listings.forEach((entries, i) => {
      for (const entry of entries) {
        const path = join(batch[i] as string, entry.name);
        if (SCAN_SKIP.has(entry.name)) continue;
        if (PROTECTED_BASENAMES.has(entry.name)) {
          found.push(path);
          if (entry.isDirectory()) found.push(...personalInside(path));
        } else if (entry.isDirectory()) {
          queue.push(path);
        }
      }
    });
  }
  return { found, complete, listed };
}

/**
 * The protected entries inside `dir` (a directory that appeared while guests ran): host-only names (not entered),
 * host-private and personal files. Skips node_modules and `.git`; follows no symlink; lists at most `maxDirs`
 * directories (`complete: false` beyond).
 */
export async function protectedEntriesBelow(dir: string, maxDirs = GUARD_SCAN_MAX_DIRS): Promise<{ readonly found: string[]; readonly complete: boolean }> {
  const { found, complete } = await scanBelow(dir, maxDirs);
  return { found, complete };
}

/** What changed in one root while guest processes ran or were being wrapped there. */
export interface GuardBreach {
  readonly root: string;
  /** Absolute paths, sorted; at most GUARD_BREACH_PATHS_MAX. */
  readonly paths: readonly string[];
  /** How many more changed (not in `paths`); absent when none. */
  readonly more?: number;
  /** WrappedCommands revoked by this change (0: nothing ran any more, or everything was revoked already). */
  readonly revoked: number;
}

/** A wrap() in flight: the root it entered and the root's generation then. */
export interface GuardTicket {
  readonly root: string;
  readonly generation: number;
}

/**
 * What a walk of a root found (GuardOptions.walk): every existing protected entry below its top that a wrap() would
 * record (host-only names, the host's personal memory files). `complete: false` when the root holds more than the
 * sandbox can record (the wrap() of a new process would be refused): a difference by itself.
 */
export interface GuardWalk {
  readonly found: readonly string[];
  readonly complete: boolean;
}

interface RootGuard {
  readonly root: string;
  inFlight: number;
  readonly issued: Set<WrappedCommand>;
  /** A command was handed out for this root since the record was made (what ran there may have planted names). */
  everIssued: boolean;
  /** Bumped by every difference: a wrap() in flight that entered before it must not hand its command out. */
  generation: number;
  /** path → state as the latest wrap() saw it (and as later seen, once a difference was reported). */
  entries: Map<string, EntryState>;
  /** path → the descriptor holding the recorded entry's inode. */
  pins: Map<string, number>;
  /** Bumped by every write of the record; `stamps` holds each path's latest (review GR-5). */
  seq: number;
  readonly stamps: Map<string, number>;
  polling: boolean;
  walking: boolean;
  /** performance.now() when the latest walk (or the wrap's own) ended, and how long the latest walk took. */
  lastWalkAt: number;
  lastWalkMs: number;
  /** Watcher paths waiting for their check: protected names, and paths that appeared (directories are scanned). */
  readonly pendingNamed: Set<string>;
  readonly pendingAppeared: Set<string>;
  checkingNamed: boolean;
  checkingAppeared: boolean;
}

export interface ProtectedEntryGuardOptions {
  readonly log: Logger;
  readonly onBreach: (breach: GuardBreach) => void;
  readonly pollMs?: number;
  /**
   * Lists the protected entries below the top of a root (SandboxServiceImpl: the same walk a wrap() makes). Without it
   * nothing walks (unit tests): new names are then seen through the watcher and the next wrap() only.
   */
  readonly walk?: (root: string) => Promise<GuardWalk>;
  readonly walkMs?: number;
}

export class ProtectedEntryGuard {
  private readonly log: Logger;
  private readonly onBreach: (breach: GuardBreach) => void;
  private readonly pollMs: number;
  private readonly walk: ((root: string) => Promise<GuardWalk>) | undefined;
  private readonly walkMs: number;
  private readonly roots = new Map<string, RootGuard>();
  private readonly rootOf = new WeakMap<WrappedCommand, RootGuard>();
  private readonly revocations = new WeakMap<WrappedCommand, SandboxRevocation>();
  private readonly listeners = new WeakMap<WrappedCommand, Set<(revocation: SandboxRevocation) => void>>();
  private readonly incomplete = new Set<string>();
  /** Descriptors of records dropped while their last look still runs (closed with it, or at dispose). */
  private readonly lastLooks = new Set<Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: ProtectedEntryGuardOptions) {
    this.log = options.log;
    this.onBreach = options.onBreach;
    this.pollMs = options.pollMs ?? GUARD_POLL_MS;
    this.walk = options.walk;
    this.walkMs = options.walkMs ?? GUARD_WALK_MS;
  }

  /** Roots with a record (tests, diagnostics). */
  guardedRoots(): string[] {
    return [...this.roots.keys()];
  }

  /** dispose() ran (the daemon is stopping): issue() answers false for that reason, not for a change. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * A wrap() for `root`: its view of the protected entries (the top-level names, and `nested`, the existing entries
   * below the top that the service's walk found), taken after the service's placeholder directories exist and before
   * srt expands its globs. Compared with the root's record (a difference revokes what runs there), then recorded.
   * Entries the record has and the walk did not name are looked at too, never assumed gone (review GR-6). Throws
   * GuardResourceError when the entries cannot be held (the wrap is refused).
   */
  async enter(root: string, nested: readonly string[]): Promise<GuardTicket> {
    const prior = this.roots.get(root);
    const startSeq = prior?.seq ?? 0;
    const keys = new Set(GUARD_TOP_LEVEL.map((rel) => join(root, rel)));
    for (const path of nested) {
      keys.add(path);
      for (const inside of personalInside(path)) keys.add(inside);
    }
    if (prior !== undefined) for (const path of prior.entries.keys()) keys.add(path);
    const list = [...keys];
    const pinned = await this.pinAll(root, list);
    if (this.disposed) {
      for (const { fd } of pinned) if (fd !== null) closeFd(fd);
      throw new Error('the sandbox guard is disposed');
    }
    const top = new Set(GUARD_TOP_LEVEL.map((rel) => join(root, rel)));
    let guard = this.roots.get(root);
    if (guard === undefined) {
      guard = this.newGuard(root);
      guard.seq = 1;
      list.forEach((path, i) => {
        const { state, fd } = pinned[i] as { state: EntryState; fd: number | null };
        if (state !== ABSENT || top.has(path)) (guard as RootGuard).entries.set(path, state);
        if (fd !== null) (guard as RootGuard).pins.set(path, fd);
        (guard as RootGuard).stamps.set(path, 1);
      });
      this.roots.set(root, guard);
    } else {
      // A record made (or made again) while this wrap looked is newer than this wrap's view throughout.
      const since = guard === prior ? startSeq : -1;
      const running = guard.issued.size > 0;
      const entries = new Map<string, EntryState>();
      const pins = new Map<string, number>();
      const diff: string[] = [];
      const seen = new Set<string>();
      const carried = new Set<string>();
      const keep = (path: string): void => {
        carried.add(path);
        const state = (guard as RootGuard).entries.get(path);
        if (state !== undefined) entries.set(path, state);
        const fd = (guard as RootGuard).pins.get(path);
        if (fd !== undefined) {
          pins.set(path, fd);
          (guard as RootGuard).pins.delete(path);
        }
      };
      list.forEach((path, i) => {
        seen.add(path);
        const { state, fd } = pinned[i] as { state: EntryState; fd: number | null };
        const stamp = (guard as RootGuard).stamps.get(path);
        if (stamp !== undefined && stamp > since) {
          // Recorded while this wrap pinned: that reading is the newer one (review GR-5).
          if (fd !== null) closeFd(fd);
          keep(path);
          return;
        }
        if (changed((guard as RootGuard).entries.get(path) ?? ABSENT, state, running, (guard as RootGuard).pins.has(path))) diff.push(path);
        if (state !== ABSENT || top.has(path)) entries.set(path, state);
        if (fd !== null) pins.set(path, fd);
      });
      // Recorded by a reading while this wrap pinned, and not in its view: kept as recorded.
      for (const path of guard.entries.keys()) if (!seen.has(path)) keep(path);
      for (const fd of guard.pins.values()) closeFd(fd);
      guard.entries = entries;
      guard.pins = pins;
      guard.seq++;
      for (const path of list) if (!carried.has(path)) guard.stamps.set(path, guard.seq);
      if (diff.length > 0) this.breach(guard, diff);
    }
    guard.lastWalkAt = performance.now(); // the wrap's own walk
    guard.inFlight++;
    this.ensurePolling();
    return { root, generation: guard.generation };
  }

  /** The wrap() of `ticket` hands `wrapped` out: false (and nothing recorded) when its root changed since enter(). */
  issue(ticket: GuardTicket, wrapped: WrappedCommand): boolean {
    const guard = this.roots.get(ticket.root);
    if (guard === undefined) return false;
    guard.inFlight--;
    if (guard.generation !== ticket.generation) {
      this.dropIfIdle(guard);
      return false;
    }
    const othersRunning = guard.issued.size > 0;
    guard.issued.add(wrapped);
    guard.everIssued = true;
    this.rootOf.set(wrapped, guard);
    this.placeMountPoints(guard, othersRunning);
    return true;
  }

  /**
   * An absent top-level `.mcp.json` / `.envrc` gets srt's mount point (an empty 0444 file, bubblewrap's ensure_file)
   * once the process starts, and the guard can tell the host's later removal of it (which lifts the deny: the guest
   * could then create the name) from srt's own cleanup only if it saw the file. A guest process starts within
   * milliseconds of this, a watcher event for the new file comes ~50 ms later, and a removal in between left no event
   * at all (inotify reports nothing for a file made and removed in one batch). So the file is made here, exactly as
   * bubblewrap would make it (bubblewrap then finds it and mounts over it). srt chose its binds for this command while
   * the name was absent or its own mount point, so it tracks the path and removes the file with its other mount
   * points once nothing runs. The descriptor of the file is kept as its pin (a file the host puts in its place gets
   * another inode number).
   *
   * Decided on what is on disk, not on the record alone (CI run 36810877157): a watcher batch or a poll during this
   * wrap()'s canary records the canary's own mount point as srt's file, and srt removes it when the canary ends (its
   * count of running wraps is zero then). Trusted, that record left the name absent until this command's bubblewrap
   * made it, and a look in between revoked the command just handed out. So with nothing else of the root running,
   * srt's file is made again when it is gone, and held as it is (another process's mount point) when it is there. While
   * OTHER commands of the root run, srt's file is left as recorded: srt removes nothing then (its count is above zero),
   * so if it is gone or another, the host did it, which lifted their deny, and the comparison must see it. A name that
   * is the host's own entry by now is left alone (compared like any other).
   */
  private placeMountPoints(guard: RootGuard, othersRunning: boolean): void {
    for (const name of HOST_ONLY_FILE_NAMES) {
      const path = join(guard.root, name);
      const recorded = guard.entries.get(path) ?? ABSENT;
      if (recorded !== ABSENT && (!isSrtFile(recorded) || othersRunning)) continue;
      const held = makeOrHold(path);
      if (held === null) {
        // Neither made nor opened (bubblewrap will not manage either): srt's own cleanup is still recorded as such.
        const now = stateAtSync(path, true);
        if (isSrtFile(recorded) && (now === ABSENT || isSrtFile(now)) && now !== recorded) {
          this.record(guard, path, now);
          this.unpin(guard, path);
        }
        continue;
      }
      if (!isSrtFile(held.state)) {
        closeFd(held.fd); // the host's own file by now
        continue;
      }
      if (held.state !== recorded) this.record(guard, path, held.state);
      this.unpin(guard, path);
      guard.pins.set(path, held.fd);
    }
  }

  /** Closes and forgets the descriptor the record holds for `path`. */
  private unpin(guard: RootGuard, path: string): void {
    const old = guard.pins.get(path);
    if (old !== undefined) closeFd(old);
    guard.pins.delete(path);
  }

  /** The wrap() of `ticket` failed. */
  leave(ticket: GuardTicket): void {
    const guard = this.roots.get(ticket.root);
    if (guard === undefined) return;
    guard.inFlight--;
    this.dropIfIdle(guard);
  }

  /**
   * The process of `wrapped` exited or never started. When it was the root's last (and no wrap() for the root is in
   * flight), the top-level names are compared one last time (synchronously, a few lstat calls, before the service's
   * own placeholders go), so a change in the last moments is still reported; then the record goes (its nested entries
   * and one more walk are looked at without blocking, dropIfIdle).
   */
  release(wrapped: WrappedCommand): void {
    const guard = this.rootOf.get(wrapped);
    if (guard === undefined) return;
    this.rootOf.delete(wrapped);
    this.listeners.delete(wrapped);
    guard.issued.delete(wrapped);
    this.dropIfIdle(guard);
  }

  /** `listener` runs once when `wrapped` is revoked; at once when it already was. Returns the remover. */
  onRevoked(wrapped: WrappedCommand, listener: (revocation: SandboxRevocation) => void): () => void {
    const done = this.revocations.get(wrapped);
    if (done !== undefined) {
      listener(done);
      return () => {};
    }
    if (!this.rootOf.has(wrapped)) return () => {};
    let set = this.listeners.get(wrapped);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(wrapped, set);
    }
    set.add(listener);
    const own = set;
    return () => {
      own.delete(listener);
    };
  }

  /**
   * A batch of the file watcher for `root` (absolute paths as reported), as it arrives. Returns at once when nothing
   * runs there; otherwise the paths join the root's checks (protected names apart from the directories that appeared,
   * so a scan never holds a name's check up).
   */
  changed(root: string, events: readonly WatchedPathEvent[]): void {
    const guard = this.roots.get(root);
    if (guard === undefined) return;
    let named = false;
    let appeared = false;
    for (const event of events) {
      if (typeof event?.path !== 'string' || !isStrictlyUnder(event.path, root)) continue;
      if (isProtectedPath(event.path)) {
        guard.pendingNamed.add(event.path);
        named = true;
      } else if (event.type !== 'delete') {
        guard.pendingAppeared.add(event.path);
        appeared = true;
      }
    }
    if (named) void this.checkNamed(guard).catch((err: unknown) => this.checkFailed(err));
    if (appeared) void this.checkAppeared(guard).catch((err: unknown) => this.checkFailed(err));
  }

  /** The watcher may have missed events of `root`: everything recorded there, and a walk, at once (review GR-1). */
  async rescan(root: string): Promise<void> {
    const guard = this.roots.get(root);
    if (guard === undefined) return;
    await this.pollRoot(guard, true).catch((err: unknown) => this.checkFailed(err));
  }

  /** Daemon stop: no more polling, every descriptor closed. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const guard of this.roots.values()) for (const fd of guard.pins.values()) closeFd(fd);
    this.roots.clear();
    for (const pins of this.lastLooks) for (const fd of pins.values()) closeFd(fd);
    this.lastLooks.clear();
  }

  /** Compares every recorded entry of every guarded root again, and walks the roots that are due (the timer; tests). */
  async poll(): Promise<void> {
    await Promise.all([...this.roots.values()].map((guard) => this.pollRoot(guard, false)));
  }

  // ------------------------------------------------------------------------------------------------------------------

  private newGuard(root: string): RootGuard {
    return {
      root,
      inFlight: 0,
      issued: new Set(),
      everIssued: false,
      generation: 0,
      entries: new Map(),
      pins: new Map(),
      seq: 0,
      stamps: new Map(),
      polling: false,
      walking: false,
      lastWalkAt: performance.now(),
      lastWalkMs: 0,
      pendingNamed: new Set(),
      pendingAppeared: new Set(),
      checkingNamed: false,
      checkingAppeared: false,
    };
  }

  /** Pins every path; on a resource error closes what it opened and throws (review GR-7). */
  private async pinAll(root: string, list: readonly string[]): Promise<{ readonly state: EntryState; readonly fd: number | null }[]> {
    let failure: unknown = null;
    const pinned = await mapLimit(list, GUARD_CONCURRENCY, async (path) => {
      if (failure !== null) return { state: ABSENT, fd: null };
      try {
        return await pin(path, this.srtShape(root, path));
      } catch (err) {
        failure ??= err;
        return { state: ABSENT, fd: null };
      }
    });
    if (failure !== null) {
      for (const { fd } of pinned) if (fd !== null) closeFd(fd);
      throw failure;
    }
    return pinned;
  }

  private checkFailed(err: unknown): void {
    this.log.error('sandbox guard: a check could not be completed', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
  }

  private srtShape(root: string, path: string): boolean {
    return dirname(path) === root && HOST_ONLY_FILE_NAMES.includes(basename(path));
  }

  /** Writes the record of `path` (and its stamp, review GR-5). */
  private record(guard: RootGuard, path: string, state: EntryState): void {
    guard.seq++;
    guard.entries.set(path, state);
    guard.stamps.set(path, guard.seq);
  }

  /** Every command handed out for the root was revoked and none is being wrapped: nothing there is left to protect. */
  private spent(guard: RootGuard): boolean {
    if (guard.inFlight > 0) return false;
    for (const wrapped of guard.issued) if (!this.revocations.has(wrapped)) return false;
    return true;
  }

  private async pollRoot(guard: RootGuard, walkNow: boolean): Promise<void> {
    if (!guard.polling) {
      guard.polling = true;
      try {
        const startSeq = guard.seq;
        const paths = [...guard.entries.keys()];
        const now = await mapLimit(paths, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
        this.report(guard, paths, now, startSeq);
      } finally {
        guard.polling = false;
      }
    }
    if (walkNow || performance.now() - guard.lastWalkAt >= Math.max(this.walkMs, GUARD_WALK_SPACING * guard.lastWalkMs)) await this.walkRoot(guard);
  }

  /** A walk of the root: protected names below its top that the record does not have (review GR-1). */
  private async walkRoot(guard: RootGuard): Promise<void> {
    const walk = this.walk;
    if (walk === undefined || guard.walking || this.roots.get(guard.root) !== guard) return;
    guard.walking = true;
    const started = performance.now();
    try {
      const startSeq = guard.seq;
      const result = await walk(guard.root);
      if (this.roots.get(guard.root) !== guard) return;
      const fresh = this.newNames(result, guard.entries);
      const states = await mapLimit(fresh, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
      const before = guard.generation;
      this.report(guard, fresh, states, startSeq);
      if (!result.complete && guard.generation === before && this.roots.get(guard.root) === guard) {
        this.tooMany(guard.root);
        this.breach(guard, [guard.root]);
      }
    } finally {
      guard.walking = false;
      guard.lastWalkAt = performance.now();
      guard.lastWalkMs = guard.lastWalkAt - started;
    }
  }

  /** The keys of a walk's result that `entries` does not have (with the personal files inside each, no new `.git`). */
  private newNames(result: GuardWalk, entries: ReadonlyMap<string, EntryState>): string[] {
    const fresh = new Set<string>();
    for (const path of result.found) {
      for (const key of [path, ...personalInside(path)]) {
        if (!WALK_NEW_SKIP.has(basename(key)) && !entries.has(key)) fresh.add(key);
      }
    }
    return [...fresh];
  }

  private tooMany(root: string): void {
    this.log.warn('sandbox guard: more host-only entries below the top of a folder than the sandbox can record appeared while guests ran', { dirs: GUARD_SCAN_MAX_DIRS, root: basename(root) });
  }

  /** The watcher's protected names of the root, checked as they come (never behind a scan). */
  private async checkNamed(guard: RootGuard): Promise<void> {
    if (guard.checkingNamed) return;
    guard.checkingNamed = true;
    try {
      while (guard.pendingNamed.size > 0 && this.roots.get(guard.root) === guard) {
        const paths = [...guard.pendingNamed];
        guard.pendingNamed.clear();
        const startSeq = guard.seq;
        const states = await mapLimit(paths, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
        this.report(guard, paths, states, startSeq);
      }
    } finally {
      guard.checkingNamed = false;
    }
  }

  /**
   * The watcher's other paths of the root: a directory that appeared (made, moved in, replaced) is looked through,
   * since inotify reports the directory, not what it holds. Only the outermost of them, and at most
   * GUARD_SCAN_MAX_DIRS listings per round in all (review GR-2): what is beyond is the walk's. Nothing once every
   * command of the root was revoked (the walk still tells the host about new names).
   */
  private async checkAppeared(guard: RootGuard): Promise<void> {
    if (guard.checkingAppeared) return;
    guard.checkingAppeared = true;
    try {
      while (guard.pendingAppeared.size > 0 && this.roots.get(guard.root) === guard) {
        const appeared = [...guard.pendingAppeared];
        guard.pendingAppeared.clear();
        if (this.spent(guard)) continue;
        const startSeq = guard.seq;
        const appearedSet = new Set(appeared);
        // Each path's ancestors are looked up, not every pair.
        const outer = appeared.filter((path) => {
          for (let dir = dirname(path); dir !== guard.root && isStrictlyUnder(dir, guard.root); dir = dirname(dir)) {
            if (appearedSet.has(dir)) return false;
          }
          return true;
        });
        const dirs = (await mapLimit(outer, GUARD_CONCURRENCY, async (path) => ((await lstat(path).catch(() => null))?.isDirectory() === true ? path : null))).filter((path): path is string => path !== null);
        const found: string[] = [];
        let budget = GUARD_SCAN_MAX_DIRS;
        let complete = true;
        for (const dir of dirs) {
          if (this.roots.get(guard.root) !== guard || this.spent(guard)) break;
          const scan = await scanBelow(dir, budget);
          budget -= scan.listed;
          found.push(...scan.found);
          if (!scan.complete || budget <= 0) {
            complete = false;
            break;
          }
        }
        if (!complete) {
          if (!this.incomplete.has(guard.root) && this.incomplete.size < 100) {
            this.incomplete.add(guard.root);
            this.log.warn('sandbox guard: a large folder that appeared while guests ran is left to the next walk for host-only names', { dirs: GUARD_SCAN_MAX_DIRS });
          }
          void this.walkRoot(guard).catch((err: unknown) => this.checkFailed(err));
        }
        const states = await mapLimit(found, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
        this.report(guard, found, states, startSeq);
      }
    } finally {
      guard.checkingAppeared = false;
    }
  }

  /**
   * Compares `now` (states of `paths`, read since `startSeq`) with the record; a difference is recorded and reported,
   * and an entry with another inode is held again (at most GUARD_REPIN_MAX per report). A path whose record was written
   * after `startSeq` was read before that write (header): where such a reading differs from the record, the path is
   * looked at again now (synchronously, one lstat) and that state counts, so an older reading neither reports a change
   * twice, nor one that is not there, nor writes the old state back.
   */
  private report(guard: RootGuard, paths: readonly string[], now: readonly EntryState[], startSeq: number): void {
    if (this.roots.get(guard.root) !== guard) return;
    const running = guard.issued.size > 0;
    const diff: string[] = [];
    let repins = 0;
    paths.forEach((path, i) => {
      const before = guard.entries.get(path) ?? ABSENT;
      let state = now[i] as EntryState;
      const stamp = guard.stamps.get(path);
      if (stamp !== undefined && stamp > startSeq) {
        if (state === before) return;
        state = stateAtSync(path, this.srtShape(guard.root, path));
      }
      if (state === before) return;
      const held = guard.pins.has(path);
      const isChange = changed(before, state, running, held);
      // Recorded either way: srt's mount point appearing or going, a chmod, so that the next difference is one.
      this.record(guard, path, state);
      const sameInode = held && fileIdentity(before) !== null && fileIdentity(before) === fileIdentity(state);
      if (!sameInode) {
        this.unpin(guard, path);
        if (state !== ABSENT && repins < GUARD_REPIN_MAX) {
          repins++;
          void this.repin(guard, path, state);
        }
      }
      if (isChange) diff.push(path);
    });
    if (diff.length > 0) this.breach(guard, diff);
  }

  /**
   * Holds the inode of an entry seen after a difference (kept only if it is still the one seen). A failure leaves it
   * without a descriptor (then any difference of it is a change, `changed`): after a change every command handed out
   * for the root was revoked, and the next wrap() pins everything again (and is refused when it cannot).
   */
  private async repin(guard: RootGuard, path: string, expected: EntryState): Promise<void> {
    let held: { readonly state: EntryState; readonly fd: number | null };
    try {
      held = await pin(path, this.srtShape(guard.root, path));
    } catch {
      return;
    }
    const { state, fd } = held;
    if (fd === null) return;
    if (state !== expected || guard.entries.get(path) !== expected || this.roots.get(guard.root) !== guard || guard.pins.has(path) || this.disposed) {
      closeFd(fd);
      return;
    }
    guard.pins.set(path, fd);
  }

  /** The bounded form of a list of changed paths (sorted; the rest counted). */
  private static named(paths: readonly string[]): { readonly paths: readonly string[]; readonly more?: number } {
    const sorted = [...paths].sort();
    const shown = Object.freeze(sorted.slice(0, GUARD_BREACH_PATHS_MAX));
    const more = sorted.length - shown.length;
    return more > 0 ? { paths: shown, more } : { paths: shown };
  }

  private breach(guard: RootGuard, paths: readonly string[]): void {
    guard.generation++;
    const named = ProtectedEntryGuard.named(paths);
    const revocation: SandboxRevocation = Object.freeze({ root: guard.root, ...named });
    let revoked = 0;
    for (const wrapped of guard.issued) {
      if (this.revocations.has(wrapped)) continue;
      this.revocations.set(wrapped, revocation);
      revoked++;
      const listeners = [...(this.listeners.get(wrapped) ?? [])];
      this.listeners.delete(wrapped);
      for (const listener of listeners) {
        try {
          listener(revocation);
        } catch (err) {
          this.log.error('sandbox guard: a revocation listener failed', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
        }
      }
    }
    this.onBreach({ root: guard.root, ...named, revoked });
  }

  private dropIfIdle(guard: RootGuard): void {
    if (guard.inFlight > 0 || guard.issued.size > 0 || this.roots.get(guard.root) !== guard) return;
    // The last look (top-level names). srt may have removed its own mount points by now (a self-test's cleanup, a
    // command that never started): its file that is gone counts as no change here (a host's removal of it while a
    // process ran was reported by the watcher's delete event).
    const diff: string[] = [];
    const top = new Set<string>();
    for (const rel of GUARD_TOP_LEVEL) {
      const path = join(guard.root, rel);
      top.add(path);
      if (changed(guard.entries.get(path) ?? ABSENT, stateAtSync(path, this.srtShape(guard.root, path)), false, guard.pins.has(path))) diff.push(path);
    }
    this.roots.delete(guard.root);
    if (this.roots.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (diff.length > 0) this.onBreach({ root: guard.root, ...ProtectedEntryGuard.named(diff), revoked: 0 });
    if (!guard.everIssued || this.walk === undefined || this.disposed) {
      for (const fd of guard.pins.values()) closeFd(fd);
      return;
    }
    // The rest without blocking, the descriptors held until then: a name planted below the top just before the
    // process ended (no event in a directory the watcher does not watch, review GR-1) is still named to the host.
    const pins = guard.pins;
    this.lastLooks.add(pins);
    void this.lastLook(guard, top)
      .catch((err: unknown) => this.checkFailed(err))
      .finally(() => {
        if (this.lastLooks.delete(pins)) for (const fd of pins.values()) closeFd(fd);
      });
  }

  /** dropIfIdle's look at the nested entries of a dropped record, and one more walk (the host is told; revoked 0). */
  private async lastLook(guard: RootGuard, top: ReadonlySet<string>): Promise<void> {
    const walk = this.walk;
    if (walk === undefined) return;
    const nested = [...guard.entries.keys()].filter((path) => !top.has(path));
    const states = await mapLimit(nested, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
    const result = await walk(guard.root);
    const fresh = this.newNames(result, guard.entries);
    const freshStates = await mapLimit(fresh, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
    if (this.disposed) return;
    const paths: string[] = [];
    nested.forEach((path, i) => {
      if (changed(guard.entries.get(path) ?? ABSENT, states[i] as EntryState, false, guard.pins.has(path))) paths.push(path);
    });
    fresh.forEach((path, i) => {
      if (freshStates[i] !== ABSENT) paths.push(path);
    });
    if (!result.complete && paths.length === 0) {
      this.tooMany(guard.root);
      paths.push(guard.root);
    }
    if (paths.length > 0) this.onBreach({ root: guard.root, ...ProtectedEntryGuard.named(paths), revoked: 0 });
  }

  private ensurePolling(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setInterval(() => {
      void this.poll().catch((err: unknown) => {
        this.log.error('sandbox guard: the periodic check failed', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      });
    }, this.pollMs);
    this.timer.unref?.();
  }
}
