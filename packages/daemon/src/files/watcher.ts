// The daemon's file watcher (ARCHITECTURE §7.5 last bullet; yjs-monaco.md Q7): @parcel/watcher (FSEvents on macOS,
// inotify on Linux), one subscription per registered root, following roots as worktrees come and go.
//
// Every event, whatever its type, only means "re-check this path" (an atomic rename-over arrives as `create`): events
// are collected per root, de-duplicated, and after a short quiet period each path is looked at again through
// PathGuard (lstat semantics, containment). The result is ONE `file.changed` bus event per batch and the same payload
// to every client that may read files. Changes the daemon announced (ChangeAttribution) carry `by`; the others are
// left unattributed for the activity module ("external change").
//
// Ignored: `.git`, `.smurg` and `node_modules` (at any depth) natively, plus smurg's and Claude Code's temp files
// (isHiddenTempName) in JS. Changes inside a directory that worktrees share read-only (D12) are also reported for
// those worktrees under the link's path, so a tree showing the worktree updates too.
//
// Every batch also goes, as reported and before any filtering, to the guest sandbox (SandboxService.fileEvents;
// reviews RV-1, RV-2): on Linux a protected entry the host changes while a guest process runs in that root ends the
// guest's processes (sandbox/guard.ts).
//
// Native calls (2026-09-29: a test worker died with SIGTRAP, "memory corruption of free block" inside
// FSEventStreamCreate; yjs-monaco.md "Watcher crash"). @parcel/watcher 2.6.0 keeps process-global state that its
// libuv pool threads and its FSEvents thread change without the locks the JS thread takes, so:
//   - every native subscribe / unsubscribe goes through ONE process-wide queue (nativeWatcherQueue): a call starts
//     only after the previous one finished. Overlapping calls corrupt the global backend map (the last unsubscribe
//     erases it on a pool thread while the next call reads it), and a re-subscribe of a directory whose unsubscribe
//     is still running gets a subscription that never reports;
//   - a native subscribe that FAILS (the directory is gone) releases JS references on a pool thread: V8 heap
//     corruption even with nothing else running. A root is stat'ed as the same directory right before it is
//     subscribed;
//   - when FSEvents reports the watched root deleted, the native module stops and releases the stream itself, on its
//     own thread and without a lock; an unsubscribe running at that moment releases it a second time. A subscription
//     whose root was seen gone is released only once the native module reported the deletion and a grace period
//     passed (or after a timeout); unregisterWorktree waits for the release, so the worktree manager deletes a
//     worktree's directory only after its subscription is gone;
//   - a process that exits with live subscriptions can abort in a native thread: stop() releases the roots one by
//     one and waits for every native call this watcher started.
// The event callback of a subscription that was released or replaced, or whose root was removed, touches nothing.
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import {
  FILE_CHANGES_MAX,
  SmurgError,
  checkRelPath,
  isHiddenTempName,
  isRelPathWithin,
  isSmurgDirName,
  relPathSegments,
  type FileRef,
} from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import { isPathDeniedError } from '../core/errors.ts';
import type { FileChange, RootInfo } from '../core/interfaces.ts';
import type { Disposable } from '../core/lifecycle.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { SpellingIndex } from '../workspace/fs-util.ts';
import type { FileServiceImpl } from './file-service.ts';
import { joinRel, mapLimit, toPosix } from './util.ts';

export type NativeWatcherEventType = 'create' | 'update' | 'delete';
export interface NativeWatcherEvent {
  readonly path: string;
  readonly type: NativeWatcherEventType;
}
export interface NativeWatcherSubscription {
  unsubscribe(): Promise<void>;
}
/** What the watcher uses of @parcel/watcher: the seam through which tests stand in for the native module. */
export interface NativeWatcherModule {
  subscribe(
    dir: string,
    fn: (err: Error | null, events: NativeWatcherEvent[]) => unknown,
    opts?: { ignore?: string[] },
  ): Promise<NativeWatcherSubscription>;
}
type ParcelEventType = NativeWatcherEventType;

/**
 * Runs calls into the native watcher one at a time, in the order they were queued: a call starts only after the
 * previous one settled (resolved or rejected).
 */
export class NativeCallQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(call: () => Promise<T>): Promise<T> {
    const result = this.tail.then(call);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const QUEUE_KEY = Symbol.for('smurg.daemon.nativeWatcherQueue');

/**
 * The process-wide queue of native watcher calls: every FileWatcher of every daemon in this process shares it, as
 * the native module's state is per process. Kept on globalThis so that a second copy of this module shares it too.
 */
export function nativeWatcherQueue(): NativeCallQueue {
  const holder = globalThis as unknown as Record<symbol, NativeCallQueue | undefined>;
  return (holder[QUEUE_KEY] ??= new NativeCallQueue());
}

/** Native ignores, relative to each subscribed root (globs for "at any depth"). */
export const WATCHER_IGNORE: readonly string[] = Object.freeze([
  '.git',
  '.smurg',
  'node_modules',
  '**/.git',
  '**/.git/**',
  '**/node_modules',
  '**/node_modules/**',
  '**/*.smurg-*.tmp',
]);

/**
 * Temp files of in-place editing tools that isHiddenTempName does not know (review SPEC-01): BSD / macOS `sed -i`
 * writes `.!<pid>!<name>` next to the file, GNU `sed -i` writes `sedXXXXXX`. They exist for milliseconds; reported,
 * they show up as a separate 「外部程式刪除了 .!30367!conflict.txt」 entry.
 */
export function isToolTempName(name: string): boolean {
  return /^\.![0-9]{1,10}!./.test(name) || /^sed[A-Za-z0-9]{6}$/.test(name);
}

/** Segments whose subtree is never reported (the same rule in JS: the native ignore is an optimisation). */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export interface WatcherOptions {
  /** Quiet period before a batch is processed. */
  readonly debounceMs?: number;
  /** A busy root is still flushed at least this often. */
  readonly maxWaitMs?: number;
  /** How often each root's identity is checked (REL-10: a root that went away and came back is watched again). */
  readonly rootCheckMs?: number;
  /** The native module (default: @parcel/watcher, loaded by start()). Tests pass a stand-in. */
  readonly native?: NativeWatcherModule;
  /**
   * Release a subscription whose root was seen gone only after the native module reported the root deleted (it then
   * stops the stream itself) and `rootGoneGraceMs` passed, or after `rootGoneTimeoutMs` (default: on macOS, where
   * FSEvents does this).
   */
  readonly waitForNativeRootDelete?: boolean;
  readonly rootGoneGraceMs?: number;
  readonly rootGoneTimeoutMs?: number;
}

/** Default of WatcherOptions.rootCheckMs. */
export const ROOT_CHECK_MS = 3_000;
/** Default of WatcherOptions.rootGoneGraceMs. */
export const ROOT_GONE_GRACE_MS = 500;
/** Default of WatcherOptions.rootGoneTimeoutMs. */
export const ROOT_GONE_TIMEOUT_MS = 5_000;
/** How often a release that waits for the native module looks again. */
const RELEASE_POLL_MS = 50;
/** stop() gives up waiting for native calls after this long (a native call that never returns). */
const STOP_SETTLE_MS = 30_000;

/** One native subscription of a root. */
interface NativeSub {
  handle: NativeWatcherSubscription | null;
  /** performance.now() when the native module reported the root itself deleted (FSEvents then stops the stream). */
  rootDeletedAt: number | null;
  /** The root was seen gone or replaced while this subscription was live. */
  sawRootGone: boolean;
  /** unsubscribe() was called (or is running): the callback touches nothing any more. */
  released: boolean;
}

interface RootWatch {
  root: RootInfo;
  /** The live native subscription; null while none (not yet, released, or lost and not yet subscribed again). */
  sub: NativeSub | null;
  /** The release of `sub` in progress (unwatch, dropLost). */
  releasing: Promise<void> | null;
  /** abs path → the latest event type seen for it in this batch. */
  pending: Map<string, ParcelEventType>;
  timer: ReturnType<typeof setTimeout> | null;
  firstPendingAt: number;
  flushing: Promise<void>;
  closed: boolean;
  /** dev/ino of the root directory when it was subscribed (null: unknown yet). */
  identity: { readonly dev: number; readonly ino: number } | null;
  /** The root directory is gone or not the one subscribed: the dead subscription was dropped until it is back. */
  lost: boolean;
  checking: boolean;
}

const RECHECK_CONCURRENCY = 16;

export class FileWatcher {
  private readonly ctx: DaemonContext;
  private readonly files: FileServiceImpl;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly rootCheckMs: number;
  private readonly waitForNativeRootDelete: boolean;
  private readonly rootGoneGraceMs: number;
  private readonly rootGoneTimeoutMs: number;
  private readonly injectedNative: NativeWatcherModule | null;
  private readonly queue = nativeWatcherQueue();
  /** Every queued native call and release this watcher started and that has not settled yet (stop waits for them). */
  private readonly ops = new Set<Promise<unknown>>();
  private rootTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watches = new Map<string, RootWatch>();
  private native: NativeWatcherModule | null = null;
  private rootsListener: Disposable | null = null;
  private stopped = false;

  constructor(ctx: DaemonContext, files: FileServiceImpl, options: WatcherOptions = {}) {
    this.ctx = ctx;
    this.files = files;
    this.debounceMs = options.debounceMs ?? 50;
    this.maxWaitMs = options.maxWaitMs ?? 300;
    this.rootCheckMs = options.rootCheckMs ?? ROOT_CHECK_MS;
    this.waitForNativeRootDelete = options.waitForNativeRootDelete ?? process.platform === 'darwin';
    this.rootGoneGraceMs = options.rootGoneGraceMs ?? ROOT_GONE_GRACE_MS;
    this.rootGoneTimeoutMs = options.rootGoneTimeoutMs ?? ROOT_GONE_TIMEOUT_MS;
    this.injectedNative = options.native ?? null;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.injectedNative) this.native = this.injectedNative;
    else {
      try {
        // Loaded here, not at import time: a missing native binary disables live updates instead of the daemon.
        const loaded = (await import('@parcel/watcher')) as unknown as { default?: NativeWatcherModule } & NativeWatcherModule;
        this.native = loaded.default ?? loaded;
      } catch (err) {
        this.ctx.log.error('file watcher unavailable', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
        return;
      }
    }
    this.rootsListener = this.ctx.roots.onChange((change) => {
      if (change.kind === 'added') {
        void this.watch(change.root);
        return undefined;
      }
      // unregisterWorktree waits for this: the worktree manager deletes the directory only once it is released.
      return this.unwatch(change.root.key);
    });
    for (const root of this.ctx.roots.list()) await this.watch(root);
    this.rootTimer = setInterval(() => {
      for (const watch of this.watches.values()) void this.checkRoot(watch);
    }, this.rootCheckMs);
    this.rootTimer.unref?.();
  }

  /** Releases every subscription, one root at a time, and waits for every native call this watcher started. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.rootTimer !== null) clearInterval(this.rootTimer);
    this.rootTimer = null;
    this.rootsListener?.dispose();
    this.rootsListener = null;
    for (const key of [...this.watches.keys()]) await this.unwatch(key);
    await this.settle();
  }

  /** Processes everything collected so far (tests; stop). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.watches.values()].map((w) => this.flush(w)));
  }

  /** Keys of the roots currently subscribed (tests, status). */
  watchedRoots(): string[] {
    return [...this.watches.entries()].filter(([, w]) => w.sub !== null && !w.lost).map(([key]) => key);
  }

  private async watch(root: RootInfo): Promise<void> {
    if (this.stopped || !this.native || this.watches.has(root.key)) return;
    const watch: RootWatch = {
      root,
      sub: null,
      releasing: null,
      pending: new Map(),
      timer: null,
      firstPendingAt: 0,
      flushing: Promise.resolve(),
      closed: false,
      identity: null,
      lost: false,
      checking: false,
    };
    this.watches.set(root.key, watch);
    watch.identity = await rootIdentity(root.realPath);
    if (watch.closed) return;
    if (!(await this.subscribe(watch)) && !watch.closed && this.watches.get(root.key) === watch) this.watches.delete(root.key);
  }

  /** Queues the native subscribe of a root; true once it is subscribed. */
  private subscribe(watch: RootWatch): Promise<boolean> {
    const native = this.native;
    if (!native) return Promise.resolve(false);
    return this.track(
      this.queue.run(async () => {
        if (watch.closed || this.stopped) return false;
        if (watch.sub !== null) return true;
        // A native subscribe that fails is itself unsafe (header): only the root directory, as it is right now.
        const now = await rootIdentity(watch.root.realPath);
        if (now === null || (watch.identity !== null && !sameIdentity(now, watch.identity))) {
          this.ctx.log.error('could not watch a root', { root: watch.root.key, error: 'not the root directory' });
          return false;
        }
        watch.identity ??= now;
        if (watch.closed || this.stopped) return false;
        const sub: NativeSub = { handle: null, rootDeletedAt: null, sawRootGone: false, released: false };
        try {
          sub.handle = await native.subscribe(watch.root.realPath, (err, events) => this.onNative(watch, sub, err, events), { ignore: [...WATCHER_IGNORE] });
        } catch (err) {
          this.ctx.log.error('could not watch a root', { root: watch.root.key, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
          return false;
        }
        // A watch closed meanwhile keeps it here: its release is queued behind this call and takes it.
        watch.sub = sub;
        return !watch.closed;
      }),
    );
  }

  /** Releases the root's native subscription (whatever is subscribed when the release gets its turn). */
  private release(watch: RootWatch): Promise<void> {
    if (watch.releasing === null) {
      const releasing = this.track(this.releaseLoop(watch)).finally(() => {
        if (watch.releasing === releasing) watch.releasing = null;
      });
      watch.releasing = releasing;
    }
    return watch.releasing;
  }

  private async releaseLoop(watch: RootWatch): Promise<void> {
    const started = performance.now();
    for (;;) {
      const done = await this.queue.run(async () => {
        const sub = watch.sub;
        if (sub === null) return true;
        if (this.waitForNativeRootDelete) {
          const waited = performance.now() - started;
          if (!sub.sawRootGone && sub.rootDeletedAt === null) {
            const now = await rootIdentity(watch.root.realPath);
            if (now === null || (watch.identity !== null && !sameIdentity(now, watch.identity))) sub.sawRootGone = true;
          }
          // FSEvents stops the stream of a deleted root by itself: never unsubscribe while it may be doing so.
          if (sub.rootDeletedAt !== null) {
            if (performance.now() - sub.rootDeletedAt < this.rootGoneGraceMs) return false;
          } else if (sub.sawRootGone) {
            if (waited < this.rootGoneTimeoutMs) return false;
            this.ctx.log.warn('file watcher: a vanished root was not reported by the native module; released anyway', { root: watch.root.key });
          }
        }
        watch.sub = null;
        sub.released = true;
        await sub.handle?.unsubscribe().catch((err: unknown) => {
          this.ctx.log.warn('file watcher: unsubscribe failed', { root: watch.root.key, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
        });
        return true;
      });
      if (done) return;
      await delay(RELEASE_POLL_MS);
    }
  }

  /** Remembers a queued native call or release until it settles. */
  private track<T>(op: Promise<T>): Promise<T> {
    this.ops.add(op);
    const forget = (): void => {
      this.ops.delete(op);
    };
    op.then(forget, forget);
    return op;
  }

  /** Waits until every native call and release this watcher started has settled (bounded: a hung native call). */
  private async settle(): Promise<void> {
    const deadline = performance.now() + STOP_SETTLE_MS;
    while (this.ops.size > 0) {
      const left = deadline - performance.now();
      if (left <= 0) {
        this.ctx.log.error('file watcher: native calls still running at stop', { count: this.ops.size });
        return;
      }
      await settledWithin([...this.ops], left);
    }
  }

  /**
   * REL-10: the shared folder was moved or deleted and restored (Finder rename and undo, an external drive remounted).
   * FSEvents keeps the old stream, which never reports again. While the root is gone, or is another directory, the
   * dead subscription is dropped; once the SAME directory (dev/ino) is back it is subscribed again. A different
   * directory at the path stays unwatched (PathGuard refuses it too: 工作區資料夾已被移動或替換).
   */
  private async checkRoot(watch: RootWatch): Promise<void> {
    if (watch.checking || watch.closed || this.stopped) return;
    watch.checking = true;
    try {
      const now = await rootIdentity(watch.root.realPath);
      if (watch.identity === null) watch.identity = now;
      const same = now !== null && watch.identity !== null && now.dev === watch.identity.dev && now.ino === watch.identity.ino;
      if (!same) {
        if (watch.sub !== null) watch.sub.sawRootGone = true;
        if (!watch.lost) await this.dropLost(watch);
      } else if (watch.lost && !watch.closed && watch.sub === null && watch.releasing === null) {
        if (await this.subscribe(watch)) {
          watch.lost = false;
          this.ctx.log.info('a shared root is back; live updates resumed', { root: watch.root.key });
        }
      }
    } finally {
      watch.checking = false;
    }
  }

  private async unwatch(key: string): Promise<void> {
    const watch = this.watches.get(key);
    if (!watch) return;
    this.watches.delete(key);
    watch.closed = true;
    if (watch.timer !== null) clearTimeout(watch.timer);
    watch.timer = null;
    watch.pending.clear();
    await this.release(watch);
  }

  /** The root directory went away: its stream is dead (it never reports again, even once the folder is back). */
  private async dropLost(watch: RootWatch): Promise<void> {
    if (watch.lost) return;
    watch.lost = true;
    if (watch.sub !== null) watch.sub.sawRootGone = true;
    this.ctx.log.warn('a shared root is gone or was replaced; live updates paused', { root: watch.root.key });
    await this.release(watch);
  }

  /** The native callback: bookkeeping of the subscription, then events only for the live subscription of a live root. */
  private onNative(watch: RootWatch, sub: NativeSub, err: Error | null, events: readonly NativeWatcherEvent[]): void {
    if (sub.rootDeletedAt === null && events.some((event) => event.type === 'delete' && event.path === watch.root.realPath)) {
      sub.rootDeletedAt = performance.now();
    }
    if (sub.released || watch.closed || watch.sub !== sub || this.watches.get(watch.root.key) !== watch) return;
    this.onEvents(watch, err, events);
  }

  private onEvents(watch: RootWatch, err: Error | null, events: readonly NativeWatcherEvent[]): void {
    if (watch.closed) return;
    // FSEvents reports the root itself as deleted when it is moved away or removed (verified with @parcel/watcher
    // 2.6.0 on macOS); the periodic check subscribes again once the same directory is back.
    if (events.some((event) => event.type === 'delete' && event.path === watch.root.realPath)) void this.dropLost(watch);
    if (err) {
      // FSEvents can drop events under load: nothing tells which paths; clients re-list on their next open. The root
      // itself may be gone: look now rather than at the next periodic check.
      this.ctx.log.warn('file watcher reported an error', { root: watch.root.key, error: err.message.slice(0, 200) });
      void this.checkRoot(watch);
    }
    if (events.length === 0) return;
    if (watch.pending.size === 0) watch.firstPendingAt = Date.now();
    for (const event of events) {
      const previous = watch.pending.get(event.path);
      watch.pending.delete(event.path); // arrival order of the latest event
      // A path created and then updated inside one batch is still new; anything else keeps the latest type.
      watch.pending.set(event.path, previous === 'create' && event.type === 'update' ? 'create' : event.type);
    }
    if (watch.timer !== null) clearTimeout(watch.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, watch.firstPendingAt + this.maxWaitMs - Date.now()));
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void this.flush(watch);
    }, wait);
    watch.timer.unref?.();
  }

  private flush(watch: RootWatch): Promise<void> {
    // One batch at a time per root, in order.
    watch.flushing = watch.flushing.then(async () => {
      if (watch.closed || watch.pending.size === 0) return;
      const batch = [...watch.pending.entries()];
      watch.pending = new Map();
      this.tellSandbox(watch.root, batch);
      try {
        const changes = await this.recheck(watch.root, batch);
        if (!watch.closed && !this.stopped) this.publish(watch.root.ref, changes);
      } catch (err) {
        this.ctx.log.error('file watcher batch failed', { root: watch.root.key, error: err instanceof Error ? err.name : 'unknown' });
      }
    });
    return watch.flushing;
  }

  /**
   * Linux (reviews RV-1, RV-2): the guest sandbox compares the protected entries a batch names (and what a directory
   * that appeared holds) with what its running guest processes were started with, and ends them when one changed. Every
   * path of the batch, before any filtering here (`.git` and node_modules never arrive: the native ignore).
   */
  private tellSandbox(root: RootInfo, batch: readonly (readonly [string, ParcelEventType])[]): void {
    const sandbox = this.ctx.services.sandbox;
    if (isStubService(sandbox) || typeof sandbox.fileEvents !== 'function') return;
    try {
      sandbox.fileEvents(
        root.realPath,
        batch.map(([path, type]) => ({ path, type })),
      );
    } catch (err) {
      this.ctx.log.error('file watcher: the sandbox could not check a batch', { root: root.key, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
    }
  }

  /** Looks at every path of a batch again and turns it into at most one FileChange each. */
  private async recheck(root: RootInfo, batch: readonly (readonly [string, ParcelEventType])[]): Promise<FileChange[]> {
    // Linux: one listing per directory for the NFC → on-disk mapping of the whole batch (review RCR-2: a batch of n
    // Mac-made (NFD) or deleted non-ASCII names listed their directory n times). Every path of the batch existed or
    // was gone before the batch started, so a listing taken during it is no staler than the events themselves.
    const spellings = new SpellingIndex();
    const results = await mapLimit(batch, RECHECK_CONCURRENCY, async ([abs, type]): Promise<FileChange | null> => {
      const rel = toPosix(relative(root.realPath, abs));
      if (rel === '' || rel.startsWith('..')) return null;
      const checked = checkRelPath(rel);
      if (!checked.ok) return null;
      const path = checked.path;
      const segments = relPathSegments(path);
      const name = segments.at(-1) as string;
      if (isHiddenTempName(name) || isToolTempName(name)) return null;
      if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return null;
      if (root.ref.kind === 'main' && isSmurgDirName(segments[0] as string)) return null;
      const ref: FileRef = { root: root.ref, path };
      let kind: 'file' | 'dir' | 'symlink' | 'other' | null;
      try {
        const resolved = await this.ctx.paths.resolve(ref, { principal: SYSTEM_PRINCIPAL, audit: false, finalSymlink: 'self', spellings });
        kind = resolved.exists ? (resolved.identity?.kind ?? null) : null;
      } catch (err) {
        // Not reachable inside the root any more (a parent swapped for a link, a vanished parent): gone for clients.
        if (isPathDeniedError(err) || (err instanceof SmurgError && err.code === 'not_found')) kind = null;
        else throw err;
      }
      if (kind === 'other') return null;
      const by = this.files.attribution.attribute(root.ref, path);
      let change: FileChange['change'];
      if (kind === null) {
        const wasDir = this.files.knownDirs.has(root.ref, path);
        change = wasDir ? 'unlinkDir' : 'unlink';
        if (wasDir) this.files.knownDirs.delete(root.ref, path);
        this.files.attribution.forget(root.ref, path, wasDir);
      } else if (kind === 'dir') {
        // Metadata updates of a directory are noise; a new directory is news.
        if (type !== 'create') return null;
        this.files.knownDirs.add(root.ref, path);
        change = 'addDir';
      } else {
        change = type === 'create' ? 'add' : 'change';
        if (this.files.knownDirs.has(root.ref, path)) this.files.knownDirs.delete(root.ref, path); // replaced by a file
        if (by) this.files.attribution.recordModified(root.ref, path, by);
      }
      return by ? { path, change, by } : { path, change };
    });
    return results.filter((c): c is FileChange => c !== null);
  }

  private publish(root: RootInfo['ref'], changes: readonly FileChange[]): void {
    if (changes.length === 0) return;
    for (let i = 0; i < changes.length; i += FILE_CHANGES_MAX) {
      const slice = changes.slice(i, i + FILE_CHANGES_MAX);
      this.ctx.bus.emit('file.changed', { root, changes: slice });
      this.ctx.hub.broadcast('file.changed', { root, changes: slice.map((c) => ({ ...c })) });
    }
    if (root.kind === 'main') this.mirrorToWorktrees(changes);
  }

  /** A shared read-only directory (D12) is the same directory in every worktree that links it. */
  private mirrorToWorktrees(changes: readonly FileChange[]): void {
    for (const info of this.ctx.roots.list()) {
      if (info.ref.kind !== 'worktree' || info.sharedLinks.length === 0) continue;
      const mirrored: FileChange[] = [];
      for (const change of changes) {
        for (const link of info.sharedLinks) {
          if (!isRelPathWithin(change.path, link.mainPath) || change.path === link.mainPath) continue;
          const rest = change.path.slice(link.mainPath.length + 1);
          const path = joinRel(link.path, rest);
          if (checkRelPath(path).ok) mirrored.push({ ...change, path });
        }
      }
      if (mirrored.length > 0) this.publish(info.ref, mirrored);
    }
  }
}


async function rootIdentity(path: string): Promise<{ readonly dev: number; readonly ino: number } | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}

function sameIdentity(a: { readonly dev: number; readonly ino: number }, b: { readonly dev: number; readonly ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves once every promise settled or after `ms`, whichever comes first (the timer does not outlive it). */
async function settledWithin(promises: readonly Promise<unknown>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([Promise.allSettled(promises), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
