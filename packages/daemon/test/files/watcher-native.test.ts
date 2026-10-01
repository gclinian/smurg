// How the file watcher drives the native module (files/watcher.ts header; yjs-monaco.md "Watcher crash"): a stand-in
// for @parcel/watcher, injected through WatcherOptions.native, records every native call. @parcel/watcher 2.6.0
// corrupts the heap when its calls overlap, when a subscribe fails, and when FSEvents stops the stream of a deleted
// root while an unsubscribe runs (a SIGTRAP of a test worker on 2026-09-29), so: one native call at a time in the
// whole process, never a subscribe of a directory that is not there, a vanished root released only after the native
// module reported its deletion, nothing left subscribed after stop(), and nothing done for a removed root's events.
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../src/core/context.ts';
import type { DaemonEvents, WatchedPathEvent } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import type { FileWatcher, NativeWatcherEvent, NativeWatcherModule, NativeWatcherSubscription, WatcherOptions } from '../../src/files/watcher.ts';
import { waitFor } from '../../src/testing/index.ts';
import { startFilesDaemon, type FilesTest } from './helpers.ts';

const started: FilesTest[] = [];

afterEach(async () => {
  for (const f of started.splice(0)) await f.t.cleanup();
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Callback = (err: Error | null, events: NativeWatcherEvent[]) => unknown;

interface LiveSub {
  readonly dir: string;
  readonly fn: Callback;
}

/** The native module, instrumented: calls in flight, what is subscribed, and what each call saw. */
class RecordingNative implements NativeWatcherModule {
  inFlight = 0;
  maxInFlight = 0;
  readonly overlaps: string[] = [];
  readonly live = new Map<number, LiveSub>();
  /** Every callback ever handed over (a removed root's callback stays callable, as with the real module). */
  readonly callbacks: LiveSub[] = [];
  readonly subscribed: string[] = [];
  readonly failedSubscribes: string[] = [];
  readonly unsubscribedAt = new Map<string, number>();
  /** While set, every native call waits for it before it completes. */
  gate: Promise<void> | null = null;
  private nextId = 1;
  private current: string | null = null;

  async subscribe(dir: string, fn: Callback): Promise<NativeWatcherSubscription> {
    this.enter(`subscribe ${dir}`);
    try {
      // Like FSEventsBackend::startStream: a directory that is not there fails (which is the unsafe native path).
      if (!existsSync(dir)) {
        this.failedSubscribes.push(dir);
        throw new Error('No such file or directory');
      }
      await this.pause();
      const id = this.nextId++;
      this.live.set(id, { dir, fn });
      this.callbacks.push({ dir, fn });
      this.subscribed.push(dir);
      return {
        unsubscribe: async () => {
          this.enter(`unsubscribe ${dir}`);
          try {
            await this.pause();
            this.live.delete(id);
            this.unsubscribedAt.set(dir, performance.now());
          } finally {
            this.exit();
          }
        },
      };
    } finally {
      this.exit();
    }
  }

  /** Delivers events to every live subscription of `dir` (the native thread's callback). */
  emit(dir: string, events: NativeWatcherEvent[]): void {
    for (const sub of [...this.live.values()]) if (sub.dir === dir) sub.fn(null, events);
  }

  liveDirs(): string[] {
    return [...this.live.values()].map((sub) => sub.dir);
  }

  private enter(what: string): void {
    if (this.inFlight > 0) this.overlaps.push(`${what} while ${this.current ?? '?'}`);
    this.inFlight++;
    this.current = what;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
  }

  /** The real calls run on libuv pool threads for a while: give an overlapping call every chance to start. */
  private async pause(): Promise<void> {
    await delay(1 + Math.floor(Math.random() * 3));
    if (this.gate) await this.gate;
  }

  private exit(): void {
    this.inFlight--;
    if (this.inFlight === 0) this.current = null;
  }
}

async function start(native: RecordingNative, watcher: WatcherOptions = {}, extraModules: readonly FeatureModule[] = []): Promise<FilesTest> {
  const f = await startFilesDaemon({ project: { files: { 'README.md': '# hi\n' } }, files: { watcher: { native, ...watcher } }, extraModules: [...extraModules] });
  started.push(f);
  return f;
}

function watcherOf(f: FilesTest): FileWatcher {
  const watcher = f.instance().watcher;
  if (!watcher) throw new Error('no watcher');
  return watcher;
}

async function makeWorktreeDir(f: FilesTest, id: string): Promise<string> {
  const dir = join(f.t.root, '.smurg/worktrees', id);
  await mkdir(dir, { recursive: true });
  return dir;
}

function register(f: FilesTest, id: string, dir: string): Promise<unknown> {
  return f.t.ctx.roots.registerWorktree({ worktreeId: id, dir, ownerUserId: 'dev:amy', sharedLinks: [] });
}

describe('file watcher: calls into the native module', { timeout: 60_000 }, () => {
  it('never overlap, in the whole process: worktrees registered and removed concurrently on two daemons, then stop() while calls are queued', async () => {
    const native = new RecordingNative();
    const a = await start(native);
    const b = await start(native);
    const ids = ['wt_native_a', 'wt_native_b', 'wt_native_c', 'wt_native_d'];
    const dirs = new Map<FilesTest, string[]>();
    for (const f of [a, b]) dirs.set(f, await Promise.all(ids.map((id) => makeWorktreeDir(f, id))));
    // Per worktree the registry sees register / remove alternating (each waits for the previous one of that worktree);
    // nobody waits across worktrees and daemons, so the watcher gets overlapping watch / unwatch of eight roots.
    const chains = new Map<string, Promise<unknown>>();
    let stopRequested = false;
    const churn = (f: FilesTest, i: number, id: string): void => {
      const key = `${f.t.root}:${id}`;
      let chain = chains.get(key) ?? Promise.resolve();
      for (let round = 0; round < 6; round++) {
        chain = chain
          .then(() => (stopRequested ? undefined : register(f, id, (dirs.get(f) as string[])[i] as string)))
          .then(() => delay(Math.floor(Math.random() * 4)))
          .then(() => f.t.ctx.roots.unregisterWorktree(id))
          .catch(() => {});
      }
      chains.set(key, chain.then(() => (stopRequested ? undefined : register(f, id, (dirs.get(f) as string[])[i] as string))).catch(() => {}));
    };
    for (const f of [a, b]) for (const [i, id] of ids.entries()) churn(f, i, id);
    await waitFor(() => native.unsubscribedAt.size >= ids.length && native.subscribed.length >= 3 * ids.length, { what: 'the worktrees to be subscribed and released repeatedly' });
    // stop() while subscribes and releases of both daemons are still queued or running.
    const stopping = Promise.all([watcherOf(a).stop(), watcherOf(b).stop()]);
    stopRequested = true;
    const pending = [...chains.values()];
    await Promise.all(pending);
    await stopping;
    expect(native.overlaps).toEqual([]);
    expect(native.maxInFlight).toBe(1);
    expect(native.inFlight).toBe(0);
    // Nothing is left subscribed once stop() resolved, and nothing was subscribed that was not there.
    expect(native.liveDirs()).toEqual([]);
    expect(native.failedSubscribes).toEqual([]);
    expect(native.unsubscribedAt.size).toBeGreaterThan(0); // the scenario did subscribe and release repeatedly
  });

  it('every batch is handed to the guest sandbox as reported, before any filtering (reviews RV-1, RV-2: it compares the protected entries a batch names)', async () => {
    const native = new RecordingNative();
    const seen: { root: string; events: WatchedPathEvent[] }[] = [];
    const sandbox: FeatureModule = {
      name: 'sandbox-recorder',
      create: () => ({
        sandbox: {
          preflight: async () => ({ ok: true, platform: 'linux' }),
          wrap: async () => {
            throw new Error('not in this test');
          },
          setAllowedDomains: async () => {},
          fileEvents: (root: string, events: readonly WatchedPathEvent[]) => {
            seen.push({ root, events: [...events] });
          },
        },
      }),
      register: () => toDisposable(() => {}),
    };
    const f = await start(native, {}, [sandbox]);
    await waitFor(() => watcherOf(f).watchedRoots().includes('main'), { what: 'the main subscription' });
    const mainDir = f.t.ctx.roots.main.realPath;
    const events: NativeWatcherEvent[] = [
      { path: join(mainDir, '.envrc'), type: 'create' },
      { path: join(mainDir, '.claude', 'settings.local.json'), type: 'update' },
      { path: join(mainDir, 'notes.md.smurg-1a2b.tmp'), type: 'create' }, // a temp name the watcher itself ignores
      { path: join(mainDir, 'gone'), type: 'delete' },
    ];
    native.emit(mainDir, events);
    await waitFor(() => seen.length === 1, { what: 'the batch handed to the sandbox' });
    expect(seen[0]?.root).toBe(mainDir);
    expect([...(seen[0]?.events ?? [])].sort((a, b) => a.path.localeCompare(b.path))).toEqual([...events].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it('the guest sandbox gets a batch as it arrives, not after the debounce or behind the previous batch\'s recheck; a watcher error makes it look at everything it guards (reviews GR-3, GR-1)', async () => {
    const native = new RecordingNative();
    const seen: { root: string; events: WatchedPathEvent[] }[] = [];
    const gaps: string[] = [];
    const sandbox: FeatureModule = {
      name: 'sandbox-recorder',
      create: () => ({
        sandbox: {
          preflight: async () => ({ ok: true, platform: 'linux' }),
          wrap: async () => {
            throw new Error('not in this test');
          },
          setAllowedDomains: async () => {},
          fileEvents: (root: string, events: readonly WatchedPathEvent[]) => {
            seen.push({ root, events: [...events] });
          },
          fileWatchGap: (root: string) => {
            gaps.push(root);
          },
        },
      }),
      register: () => toDisposable(() => {}),
    };
    // A debounce far longer than the test: the files module's own batch is never processed meanwhile.
    const f = await start(native, { debounceMs: 60_000, maxWaitMs: 60_000 }, [sandbox]);
    const changed: DaemonEvents['file.changed'][] = [];
    f.t.ctx.bus.on('file.changed', (event) => changed.push(event));
    await waitFor(() => watcherOf(f).watchedRoots().includes('main'), { what: 'the main subscription' });
    const mainDir = f.t.ctx.roots.main.realPath;
    native.emit(mainDir, [{ path: join(mainDir, 'sub', '.envrc'), type: 'create' }]);
    native.emit(mainDir, [{ path: join(mainDir, 'dist', 'a.js'), type: 'create' }]);
    // Synchronously, one call per native batch, while the files module still waits for its quiet period.
    expect(seen.map((batch) => batch.events.map((event) => event.path))).toEqual([[join(mainDir, 'sub', '.envrc')], [join(mainDir, 'dist', 'a.js')]]);
    expect(changed).toEqual([]);
    expect(gaps).toEqual([]);
    const callback = native.callbacks.find((sub) => sub.dir === mainDir)?.fn as Callback;
    callback(new Error('Events were dropped by the FSEvents client'), []);
    expect(gaps).toEqual([mainDir]);
  });

  it('the events of a removed root, or of a stopped watcher, reach nobody', async () => {
    const native = new RecordingNative();
    const f = await start(native);
    const changed: DaemonEvents['file.changed'][] = [];
    f.t.ctx.bus.on('file.changed', (event) => changed.push(event));
    const dir = await makeWorktreeDir(f, 'wt_native_gone');
    await register(f, 'wt_native_gone', dir);
    await waitFor(() => watcherOf(f).watchedRoots().includes('wt:wt_native_gone'), { what: 'the worktree subscription' });
    const callback = native.callbacks.find((sub) => sub.dir === dir)?.fn as Callback;
    await f.t.ctx.roots.unregisterWorktree('wt_native_gone');
    // unregisterWorktree resolved: the native subscription is already released (the worktree manager deletes next).
    expect(native.liveDirs()).not.toContain(dir);
    callback(null, [{ path: join(dir, 'late.txt'), type: 'create' }]);
    await watcherOf(f).stop();
    const mainDir = f.t.ctx.roots.main.realPath;
    const main = native.callbacks.find((sub) => sub.dir === mainDir)?.fn as Callback;
    main(null, [{ path: join(mainDir, 'after-stop.txt'), type: 'create' }]);
    await delay(200);
    expect(changed).toEqual([]);
    expect(native.liveDirs()).toEqual([]);
  });

  it('a root that vanished while its subscribe waited in the queue is never handed to the native module', async () => {
    const native = new RecordingNative();
    const f = await start(native);
    const first = await makeWorktreeDir(f, 'wt_native_first');
    const doomed = await makeWorktreeDir(f, 'wt_native_doomed');
    let open!: () => void;
    native.gate = new Promise<void>((resolve) => (open = resolve));
    await register(f, 'wt_native_first', first);
    await waitFor(() => native.inFlight === 1, { what: "the first worktree's subscribe to be held in flight" });
    await register(f, 'wt_native_doomed', doomed); // its subscribe waits in the queue behind the first one
    await delay(50);
    await rm(doomed, { recursive: true });
    native.gate = null;
    open();
    await waitFor(() => watcherOf(f).watchedRoots().includes('wt:wt_native_first'), { what: 'the first worktree subscription' });
    await delay(100);
    expect(native.subscribed).not.toContain(doomed);
    expect(native.failedSubscribes).toEqual([]);
    expect(watcherOf(f).watchedRoots()).not.toContain('wt:wt_native_doomed');
    expect(native.maxInFlight).toBe(1);
  });

  it('a root that is gone is released only after the native module reported it deleted (FSEvents stops that stream itself), then watched again when it is back', async () => {
    const native = new RecordingNative();
    const f = await start(native, { rootCheckMs: 20, rootGoneGraceMs: 150, rootGoneTimeoutMs: 20_000, waitForNativeRootDelete: true });
    const dir = await makeWorktreeDir(f, 'wt_native_moved');
    await register(f, 'wt_native_moved', dir);
    const key = 'wt:wt_native_moved';
    await waitFor(() => watcherOf(f).watchedRoots().includes(key), { what: 'the worktree subscription' });
    await rename(dir, `${dir}-away`);
    // The periodic check notices first: live updates pause, but the subscription is not released yet.
    await waitFor(() => !watcherOf(f).watchedRoots().includes(key), { what: 'the root to be seen gone' });
    await delay(300);
    expect(native.liveDirs()).toContain(dir);
    // The native module reports the root deleted (and, being FSEvents, stops the stream on its own thread now).
    const reportedAt = performance.now();
    native.emit(dir, [{ path: dir, type: 'delete' }]);
    await waitFor(() => !native.liveDirs().includes(dir), { what: 'the release' });
    expect((native.unsubscribedAt.get(dir) as number) - reportedAt).toBeGreaterThanOrEqual(140);
    await rename(`${dir}-away`, dir);
    await waitFor(() => watcherOf(f).watchedRoots().includes(key), { what: 'the root to be watched again' });
    expect(native.subscribed.filter((d) => d === dir)).toHaveLength(2);
    expect(native.maxInFlight).toBe(1);
  });
});
