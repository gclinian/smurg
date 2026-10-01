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
//   - on every file-watcher batch: a protected name at any depth, and every directory that appeared (its subtree);
//   - every GUARD_POLL_MS, the recorded entries (the watcher ignores `.git`; inotify can drop events);
//   - on every later wrap() in that root (its fresh view against the recorded one);
//   - when the root's last process is released (top-level names, synchronously, before srt removes its mount points).
// Any difference revokes every WrappedCommand handed out for that root (SandboxService.onRevoked: the sessions module
// ends the processes), makes a wrap() in flight there refuse (`protected-changed`) and is reported (GuardBreach). It
// is a detection, not a prevention: a guest has until the change is noticed and its processes are ended.
//
// Rules of the comparison (`changed`): the same state is no change; an absent top-level `.mcp.json` / `.envrc` that
// became srt's empty 0444 file is bubblewrap's own mount point (made when a guest process starts); srt's file that
// became absent is srt's own cleanup only while no process runs (srt removes its mount points when its count of
// running wraps is zero); everything else is a change, a new entry included. A NEW nested `.git` is not looked for (the
// watcher never reports `.git`, and a guest's `git clone` makes one: ARCHITECTURE §12 residual).
import { closeSync, constants, fstat, lstatSync, open, openSync, type BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SandboxRevocation, WatchedPathEvent, WrappedCommand } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';
import { HOST_ONLY_DIR_NAMES, HOST_ONLY_FILE_NAMES, HOST_PERSONAL_FILES, HOST_PRIVATE_READ_DENIED_NAMES, isStrictlyUnder } from './policy.ts';

/** How often the recorded entries of every guarded root are compared again. */
export const GUARD_POLL_MS = 2_000;
/** Directories one scan of a directory that appeared may list (a larger one is reported as not fully checked). */
export const GUARD_SCAN_MAX_DIRS = 10_000;
const GUARD_CONCURRENCY = 16;

/** The state of a path: absent, srt's mount-point file, `<kind>:<dev>:<ino>`, or `error:<code>`. */
type EntryState = string;
const ABSENT: EntryState = 'absent';
const SRT_FILE: EntryState = 'srt-file';

/** Linux `O_PATH` (asm-generic, x86 and arm64 alike; not in fs.constants): a handle on the inode, nothing readable. */
const O_PATH = 0o10000000;

/** Every name the guard compares at the top of a root (relative). */
export const GUARD_TOP_LEVEL: readonly string[] = Object.freeze([...new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES, ...HOST_PERSONAL_FILES, ...HOST_PRIVATE_READ_DENIED_NAMES])]);
const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES, ...HOST_PRIVATE_READ_DENIED_NAMES, ...HOST_PERSONAL_FILES.filter((rel) => !rel.includes('/'))]);
/** Personal files below a directory name (`.claude/settings.local.json`): [directory name, file name]. */
const PERSONAL_IN_DIR: readonly (readonly [string, string])[] = HOST_PERSONAL_FILES.filter((rel) => rel.includes('/')).map((rel) => rel.split('/') as [string, string]);
/** Names a scan neither reports nor enters (srt and the nested walk skip node_modules; `.git`: see the header). */
const SCAN_SKIP: ReadonlySet<string> = new Set(['node_modules', '.git']);

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
  if (srtShape && st.isFile() && st.size === 0n && (st.mode & 0o222n) === 0n && st.nlink === 1n) return SRT_FILE;
  const kind = st.isDirectory() ? 'd' : st.isFile() ? 'f' : st.isSymbolicLink() ? 'l' : 'o';
  return `${kind}:${st.dev}:${st.ino}`;
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

/**
 * The state of `path` and a descriptor that keeps its inode (Linux: O_PATH | O_NOFOLLOW, which opens a symlink or a
 * FIFO as itself). Elsewhere (unit tests on macOS) a read-only descriptor, or no descriptor where none can be had.
 */
async function pin(path: string, srtShape: boolean): Promise<{ readonly state: EntryState; readonly fd: number | null }> {
  const flags = process.platform === 'linux' ? O_PATH | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = await openFd(path, flags);
  } catch (err) {
    const state = errorState(err);
    return { state: state === ABSENT ? ABSENT : await stateAt(path, srtShape), fd: null };
  }
  try {
    const state = stateOf(await fstatFd(fd), srtShape);
    if (state === SRT_FILE) {
      closeFd(fd); // compared by its shape: srt makes and removes it
      return { state, fd: null };
    }
    return { state, fd };
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
  const flags = process.platform === 'linux' ? O_PATH | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const fd = await openFd(path, flags);
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

/** The comparison rules (header). `running`: a process handed out for this root has not been released. */
function changed(before: EntryState, now: EntryState, running: boolean): boolean {
  if (before === now) return false;
  if (before === ABSENT && now === SRT_FILE) return false;
  if (before === SRT_FILE && now === ABSENT) return running;
  return true;
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

/**
 * The protected entries inside `dir` (a directory that appeared while guests ran): host-only names (not entered),
 * host-private and personal files. Skips node_modules and `.git`; follows no symlink; lists at most `maxDirs`
 * directories (`complete: false` beyond).
 */
export async function protectedEntriesBelow(dir: string, maxDirs = GUARD_SCAN_MAX_DIRS): Promise<{ readonly found: string[]; readonly complete: boolean }> {
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
  return { found, complete };
}

/** What changed in one root while guest processes ran or were being wrapped there. */
export interface GuardBreach {
  readonly root: string;
  /** Absolute paths, sorted. */
  readonly paths: readonly string[];
  /** WrappedCommands revoked by this change (0: nothing ran any more, or everything was revoked already). */
  readonly revoked: number;
}

/** A wrap() in flight: the root it entered and the root's generation then. */
export interface GuardTicket {
  readonly root: string;
  readonly generation: number;
}

interface RootGuard {
  readonly root: string;
  inFlight: number;
  readonly issued: Set<WrappedCommand>;
  /** Bumped by every difference: a wrap() in flight that entered before it must not hand its command out. */
  generation: number;
  /** path → state as the latest wrap() saw it (and as later seen, once a difference was reported). */
  entries: Map<string, EntryState>;
  /** path → the descriptor holding the recorded entry's inode. */
  pins: Map<string, number>;
  polling: boolean;
}

export interface ProtectedEntryGuardOptions {
  readonly log: Logger;
  readonly onBreach: (breach: GuardBreach) => void;
  readonly pollMs?: number;
}

export class ProtectedEntryGuard {
  private readonly log: Logger;
  private readonly onBreach: (breach: GuardBreach) => void;
  private readonly pollMs: number;
  private readonly roots = new Map<string, RootGuard>();
  private readonly rootOf = new WeakMap<WrappedCommand, RootGuard>();
  private readonly revocations = new WeakMap<WrappedCommand, SandboxRevocation>();
  private readonly listeners = new WeakMap<WrappedCommand, Set<(revocation: SandboxRevocation) => void>>();
  private readonly incomplete = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: ProtectedEntryGuardOptions) {
    this.log = options.log;
    this.onBreach = options.onBreach;
    this.pollMs = options.pollMs ?? GUARD_POLL_MS;
  }

  /** Roots with a record (tests, diagnostics). */
  guardedRoots(): string[] {
    return [...this.roots.keys()];
  }

  /**
   * A wrap() for `root`: its view of the protected entries (the top-level names, and `nested`, the existing entries
   * below the top that the service's walk found), taken after the service's placeholder directories exist and before
   * srt expands its globs. Compared with the root's record (a difference revokes what runs there), then recorded.
   */
  async enter(root: string, nested: readonly string[]): Promise<GuardTicket> {
    const keys = new Set(GUARD_TOP_LEVEL.map((rel) => join(root, rel)));
    for (const path of nested) {
      keys.add(path);
      for (const inside of personalInside(path)) keys.add(inside);
    }
    const list = [...keys];
    const pinned = await mapLimit(list, GUARD_CONCURRENCY, (path) => pin(path, this.srtShape(root, path)));
    const entries = new Map<string, EntryState>();
    const pins = new Map<string, number>();
    list.forEach((path, i) => {
      const { state, fd } = pinned[i] as { state: EntryState; fd: number | null };
      entries.set(path, state);
      if (fd !== null) pins.set(path, fd);
    });
    if (this.disposed) {
      for (const fd of pins.values()) closeFd(fd);
      throw new Error('the sandbox guard is disposed');
    }
    let guard = this.roots.get(root);
    if (guard === undefined) {
      guard = { root, inFlight: 0, issued: new Set(), generation: 0, entries, pins, polling: false };
      this.roots.set(root, guard);
    } else {
      const running = guard.issued.size > 0;
      const diff: string[] = [];
      for (const path of new Set([...guard.entries.keys(), ...entries.keys()])) {
        if (changed(guard.entries.get(path) ?? ABSENT, entries.get(path) ?? ABSENT, running)) diff.push(path);
      }
      for (const fd of guard.pins.values()) closeFd(fd);
      guard.entries = entries;
      guard.pins = pins;
      if (diff.length > 0) this.breach(guard, diff);
    }
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
    guard.issued.add(wrapped);
    this.rootOf.set(wrapped, guard);
    this.placeMountPoints(guard);
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
   * points once nothing runs. A name that exists by now is left alone (compared like any other).
   */
  private placeMountPoints(guard: RootGuard): void {
    for (const name of HOST_ONLY_FILE_NAMES) {
      const path = join(guard.root, name);
      if (guard.entries.get(path) !== ABSENT) continue;
      try {
        closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444));
        guard.entries.set(path, SRT_FILE);
      } catch {
        // There by now: another process's mount point (recorded as such), or the host's file (compared like any other
        // entry: a difference).
        if (stateAtSync(path, true) === SRT_FILE) guard.entries.set(path, SRT_FILE);
      }
    }
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
   * own placeholders go), so a change in the last moments is still reported; then the record and its descriptors go.
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

  /** A batch of the file watcher for `root` (absolute paths as reported). Returns at once when nothing runs there. */
  changed(root: string, events: readonly WatchedPathEvent[]): void {
    const guard = this.roots.get(root);
    if (guard === undefined) return;
    const named = new Set<string>();
    const appeared = new Set<string>();
    for (const event of events) {
      if (typeof event?.path !== 'string' || !isStrictlyUnder(event.path, root)) continue;
      if (isProtectedPath(event.path)) named.add(event.path);
      else if (event.type !== 'delete') appeared.add(event.path);
    }
    if (named.size === 0 && appeared.size === 0) return;
    void this.checkEvents(guard, [...named], [...appeared]).catch((err: unknown) => {
      this.log.error('sandbox guard: a watcher batch could not be checked', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
    });
  }

  /** Daemon stop: no more polling, every descriptor closed. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const guard of this.roots.values()) for (const fd of guard.pins.values()) closeFd(fd);
    this.roots.clear();
  }

  /** Compares every recorded entry of every guarded root again (the timer; tests call it directly). */
  async poll(): Promise<void> {
    await Promise.all(
      [...this.roots.values()].map(async (guard) => {
        if (guard.polling) return;
        guard.polling = true;
        try {
          const paths = [...guard.entries.keys()];
          const now = await mapLimit(paths, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
          this.report(guard, paths, now);
        } finally {
          guard.polling = false;
        }
      }),
    );
  }

  // ------------------------------------------------------------------------------------------------------------------

  private srtShape(root: string, path: string): boolean {
    return dirname(path) === root && HOST_ONLY_FILE_NAMES.includes(basename(path));
  }

  private async checkEvents(guard: RootGuard, named: readonly string[], appeared: readonly string[]): Promise<void> {
    const paths: string[] = [];
    const states: EntryState[] = [];
    const namedStates = await mapLimit(named, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)));
    paths.push(...named);
    states.push(...namedStates);
    const appearedSet = new Set(appeared);
    // A directory that appeared (made, moved in, replaced): inotify reports the directory, not what it holds.
    // Only the outermost of them: a scan covers what is below (each path's ancestors looked up, not every pair).
    const outer = appeared.filter((path) => {
      for (let dir = dirname(path); dir !== guard.root && isStrictlyUnder(dir, guard.root); dir = dirname(dir)) {
        if (appearedSet.has(dir)) return false;
      }
      return true;
    });
    const scans = await mapLimit(outer, GUARD_CONCURRENCY, async (path) => {
      const st = await lstat(path).catch(() => null);
      return st?.isDirectory() === true ? protectedEntriesBelow(path) : null;
    });
    const found: string[] = [];
    scans.forEach((scan, i) => {
      if (scan === null) return;
      found.push(...scan.found);
      if (!scan.complete && !this.incomplete.has(outer[i] as string) && this.incomplete.size < 100) {
        this.incomplete.add(outer[i] as string);
        this.log.warn('sandbox guard: a large folder that appeared while guests ran was not fully checked for host-only names', { dirs: GUARD_SCAN_MAX_DIRS });
      }
    });
    paths.push(...found);
    states.push(...(await mapLimit(found, GUARD_CONCURRENCY, (path) => stateAt(path, this.srtShape(guard.root, path)))));
    if (this.roots.get(guard.root) !== guard) return; // nothing runs there any more
    this.report(guard, paths, states);
  }

  /** Compares `now` (states of `paths`) with the record; a difference is recorded, re-pinned and reported. */
  private report(guard: RootGuard, paths: readonly string[], now: readonly EntryState[]): void {
    if (this.roots.get(guard.root) !== guard) return;
    const running = guard.issued.size > 0;
    const diff: string[] = [];
    paths.forEach((path, i) => {
      const state = now[i] as EntryState;
      const before = guard.entries.get(path) ?? ABSENT;
      if (!changed(before, state, running)) {
        // srt's mount point appeared (a guest process started) or went with srt's own cleanup: recorded, so that
        // the host's removal of it later is seen as one.
        if (state !== before && (state === SRT_FILE || before === SRT_FILE)) guard.entries.set(path, state);
        return;
      }
      if (diff.includes(path)) return;
      diff.push(path);
      guard.entries.set(path, state);
      const old = guard.pins.get(path);
      if (old !== undefined) closeFd(old);
      guard.pins.delete(path);
      if (state !== ABSENT && state !== SRT_FILE) void this.repin(guard, path, state);
    });
    if (diff.length > 0) this.breach(guard, diff);
  }

  /** Holds the inode of an entry seen after a difference (kept only if it is still the one seen). */
  private async repin(guard: RootGuard, path: string, expected: EntryState): Promise<void> {
    const { state, fd } = await pin(path, this.srtShape(guard.root, path));
    if (fd === null) return;
    if (state !== expected || this.roots.get(guard.root) !== guard || guard.pins.has(path) || this.disposed) {
      closeFd(fd);
      return;
    }
    guard.pins.set(path, fd);
  }

  private breach(guard: RootGuard, paths: readonly string[]): void {
    guard.generation++;
    const sorted = [...paths].sort();
    const revocation: SandboxRevocation = Object.freeze({ root: guard.root, paths: Object.freeze(sorted) });
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
    this.onBreach({ root: guard.root, paths: sorted, revoked });
  }

  private dropIfIdle(guard: RootGuard): void {
    if (guard.inFlight > 0 || guard.issued.size > 0 || this.roots.get(guard.root) !== guard) return;
    // The last look (top-level names). srt may have removed its own mount points by now (a self-test's cleanup, a
    // command that never started): its file that is gone counts as no change here (a host's removal of it while a
    // process ran was reported by the watcher's delete event).
    const diff: string[] = [];
    for (const rel of GUARD_TOP_LEVEL) {
      const path = join(guard.root, rel);
      if (changed(guard.entries.get(path) ?? ABSENT, stateAtSync(path, this.srtShape(guard.root, path)), false)) diff.push(path);
    }
    for (const fd of guard.pins.values()) closeFd(fd);
    this.roots.delete(guard.root);
    if (this.roots.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (diff.length > 0) this.onBreach({ root: guard.root, paths: diff.sort(), revoked: 0 });
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
