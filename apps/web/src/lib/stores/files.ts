// File trees, one per root (main workspace or a worktree), loaded directory by directory with file.tree (depth 1) and
// kept fresh by file.changed: a change re-lists the directories it touches that are currently loaded (coalesced).
// Also the plain file.* requests (stat, read, write, create, rename, delete) and the active root of the tree.
import {
  MAIN_ROOT,
  isHiddenTempName,
  isRelPathWithin,
  parentRelPath,
  rootRefEquals,
  rootRefKey,
  type FileEntry,
  type FileRef,
  type ResultOf,
  type RootRef,
} from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { describeError } from '../errors.ts';
import { compareText } from '../format.ts';
import type { AreaLifecycle, LoadStatus, StoreContext } from './base.ts';

export interface DirListing {
  readonly root: RootRef;
  /** `""` is the root directory. */
  readonly path: string;
  readonly status: LoadStatus;
  /** Daemon order; editor temp files (`*.tmp.<pid>.<hex>`, `.x.smurg-<hex>.tmp`) are already filtered out. */
  readonly entries: readonly FileEntry[];
  /** More than 10,000 entries exist; only the first ones are listed. */
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface RootTree {
  readonly root: RootRef;
  /** Loaded directories by path. A directory that is not here was never expanded (or was forgotten). */
  readonly dirs: ReadonlyMap<string, DirListing>;
}

export interface FilesState {
  /** The root the file tree shows (main workspace or a worktree, R9). */
  readonly activeRoot: RootRef;
  /** By rootRefKey(root). */
  readonly trees: ReadonlyMap<string, RootTree>;
}

export interface FilesStore extends ReadableStore<FilesState> {
  /** Switches the tree to another root and loads its top level. */
  setActiveRoot(root: RootRef): void;
  /**
   * Lists a directory (cached; `force` re-lists). Concurrent calls share one request. Rejects with the daemon's error;
   * the listing then has status 'error'.
   */
  loadDir(root: RootRef, path: string, options?: { force?: boolean }): Promise<DirListing>;
  /** Drops a directory and everything below it from the cache (a collapsed folder is no longer kept fresh). */
  forgetDir(root: RootRef, path: string): void;
  stat(file: FileRef): Promise<FileEntry>;
  read(file: FileRef, maxBytes?: number): Promise<ResultOf<'file.read'>>;
  /** Small non-collaborative writes only (text is edited through doc.*); refused with `locked` while locked. */
  write(file: FileRef, content: Uint8Array, ifMatchHash?: string): Promise<ResultOf<'file.write'>>;
  create(file: FileRef, kind: 'file' | 'dir'): Promise<FileEntry>;
  rename(root: RootRef, from: string, to: string): Promise<FileEntry>;
  delete(file: FileRef): Promise<void>;
}

/** Delay that coalesces bursts of file.changed (a `git checkout` touches many files at once). */
export const FILE_REFRESH_DELAY_MS = 75;

export const INITIAL_FILES_STATE: FilesState = Object.freeze({ activeRoot: MAIN_ROOT, trees: new Map() });

// ---- selectors

export function selectDir(state: FilesState, root: RootRef, path: string): DirListing | undefined {
  return state.trees.get(rootRefKey(root))?.dirs.get(path);
}

/** The entry for `file` from its parent's listing (undefined when the parent is not loaded). */
export function selectEntry(state: FilesState, file: FileRef): FileEntry | undefined {
  const parent = parentRelPath(file.path);
  if (parent === null) return undefined;
  return selectDir(state, file.root, parent)?.entries.find((entry) => entry.path === file.path);
}

export const selectActiveRoot = (state: FilesState): RootRef => state.activeRoot;

/** Directories first, then names in the collation of the viewer's language (numbers compared numerically). */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = (entry: FileEntry): number => (entry.kind === 'dir' ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || compareText(a.name, b.name));
}

export function createFilesArea(): { store: FilesStore; lifecycle: AreaLifecycle } {
  const state = createStore<FilesState>(INITIAL_FILES_STATE);
  let ctx: StoreContext | null = null;
  const inflight = new Map<string, Promise<DirListing>>();
  /** Directories that changed while their listing was in flight. */
  const relist = new Set<string>();
  const pendingRefresh = new Map<string, { root: RootRef; paths: Set<string> }>();
  let refreshTimer: unknown = null;

  const context = (): StoreContext => {
    if (!ctx) throw new Error('files store is not bound to a connection');
    return ctx;
  };

  const setListing = (listing: DirListing): void => {
    state.setState((previous) => {
      const key = rootRefKey(listing.root);
      const tree = previous.trees.get(key) ?? { root: listing.root, dirs: new Map<string, DirListing>() };
      const dirs = new Map(tree.dirs);
      dirs.set(listing.path, listing);
      const trees = new Map(previous.trees);
      trees.set(key, { root: tree.root, dirs });
      return { ...previous, trees };
    });
  };

  const dropDirs = (root: RootRef, path: string): void => {
    state.setState((previous) => {
      const key = rootRefKey(root);
      const tree = previous.trees.get(key);
      if (!tree) return previous;
      const dirs = new Map([...tree.dirs].filter(([dir]) => !isRelPathWithin(dir, path)));
      if (dirs.size === tree.dirs.size) return previous;
      const trees = new Map(previous.trees);
      trees.set(key, { root: tree.root, dirs });
      return { ...previous, trees };
    });
  };

  const dropRoot = (root: RootRef): void => {
    state.setState((previous) => {
      const key = rootRefKey(root);
      if (!previous.trees.has(key) && !rootRefEquals(previous.activeRoot, root)) return previous;
      const trees = new Map(previous.trees);
      trees.delete(key);
      return { activeRoot: rootRefEquals(previous.activeRoot, root) ? MAIN_ROOT : previous.activeRoot, trees };
    });
  };

  const loadDir = (root: RootRef, path: string, options: { force?: boolean } = {}): Promise<DirListing> => {
    const c = context();
    const flightKey = `${rootRefKey(root)}\u0000${path}`;
    const existing = selectDir(state.getState(), root, path);
    if (existing && existing.status === 'ready' && !options.force) return Promise.resolve(existing);
    const running = inflight.get(flightKey);
    if (running) {
      // A listing asked for before this change may not contain it: list again once the running request is done.
      if (options.force) relist.add(flightKey);
      return running;
    }
    setListing({
      root,
      path,
      status: 'loading',
      entries: existing?.entries ?? [],
      truncated: existing?.truncated ?? false,
      error: null,
    });
    const generation = c.generation();
    const promise = c.conn
      .request('file.tree', { root, path, depth: 1 })
      .then(
        (result) => {
          const listing: DirListing = {
            root,
            path,
            status: 'ready',
            entries: result.entries.filter((entry) => !isHiddenTempName(entry.name) && entry.path !== path),
            truncated: result.truncated,
            error: null,
          };
          if (c.generation() === generation) setListing(listing);
          return listing;
        },
        (error: unknown) => {
          if (c.generation() === generation) {
            setListing({ root, path, status: 'error', entries: existing?.entries ?? [], truncated: false, error: describeError(error) });
          }
          throw error;
        },
      )
      .finally(() => {
        if (inflight.get(flightKey) !== promise) return;
        inflight.delete(flightKey);
        if (relist.delete(flightKey) && c.generation() === generation && selectDir(state.getState(), root, path) !== undefined) {
          loadDir(root, path, { force: true }).catch((error: unknown) => ctx?.reportError('files', error));
        }
      });
    inflight.set(flightKey, promise);
    return promise;
  };

  const flushRefresh = (): void => {
    refreshTimer = null;
    const batches = [...pendingRefresh.values()];
    pendingRefresh.clear();
    for (const { root, paths } of batches) {
      for (const path of paths) {
        if (selectDir(state.getState(), root, path) === undefined) continue; // forgotten meanwhile
        loadDir(root, path, { force: true }).catch((error: unknown) => ctx?.reportError('files', error));
      }
    }
  };

  const scheduleRefresh = (root: RootRef, path: string): void => {
    if (selectDir(state.getState(), root, path) === undefined) return;
    const key = rootRefKey(root);
    let batch = pendingRefresh.get(key);
    if (!batch) {
      batch = { root, paths: new Set() };
      pendingRefresh.set(key, batch);
    }
    batch.paths.add(path);
    if (refreshTimer === null && ctx) refreshTimer = ctx.scheduler.setTimeout(flushRefresh, FILE_REFRESH_DELAY_MS);
  };

  const refreshParentOf = (file: FileRef): void => {
    const parent = parentRelPath(file.path);
    if (parent !== null) scheduleRefresh(file.root, parent);
  };

  const store: FilesStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    setActiveRoot(root) {
      state.setState((previous) => ({ ...previous, activeRoot: root }));
      loadDir(root, '').catch((error: unknown) => ctx?.reportError('files', error));
    },
    loadDir,
    forgetDir(root, path) {
      dropDirs(root, path);
    },
    async stat(file) {
      return (await context().conn.request('file.stat', file)).entry;
    },
    read(file, maxBytes) {
      return context().conn.request('file.read', maxBytes === undefined ? { file } : { file, maxBytes });
    },
    async write(file, content, ifMatchHash) {
      const result = await context().conn.request('file.write', ifMatchHash === undefined ? { file, content } : { file, content, ifMatchHash });
      refreshParentOf(file);
      return result;
    },
    async create(file, kind) {
      const { entry } = await context().conn.request('file.create', { file, kind });
      refreshParentOf(file);
      return entry;
    },
    async rename(root, from, to) {
      const { entry } = await context().conn.request('file.rename', { root, from, to });
      refreshParentOf({ root, path: from });
      refreshParentOf({ root, path: to });
      dropDirs(root, from);
      return entry;
    },
    async delete(file) {
      await context().conn.request('file.delete', { file });
      dropDirs(file.root, file.path);
      refreshParentOf(file);
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offChanged = c.conn.on('file.changed', ({ root, changes }) => {
        for (const change of changes) {
          if (change.change === 'unlinkDir') dropDirs(root, change.path);
          else if (change.change === 'unlink') dropDirs(root, change.path); // a file that replaced a dir
          const parent = parentRelPath(change.path);
          if (parent !== null) scheduleRefresh(root, parent);
        }
      });
      const offRemoved = c.conn.on('worktree.removed', ({ worktreeId }) => dropRoot({ kind: 'worktree', worktreeId }));
      return () => {
        offChanged();
        offRemoved();
        if (refreshTimer !== null) c.scheduler.clearTimeout(refreshTimer);
        refreshTimer = null;
        pendingRefresh.clear();
      };
    },
    reset() {
      // Keep what is on screen (no flash of an empty tree); load() re-lists every known directory.
      inflight.clear();
      relist.clear();
      pendingRefresh.clear();
    },
    async load() {
      const current = state.getState();
      const known: { root: RootRef; path: string }[] = [];
      for (const tree of current.trees.values()) for (const path of tree.dirs.keys()) known.push({ root: tree.root, path });
      if (!known.some((dir) => rootRefEquals(dir.root, current.activeRoot) && dir.path === '')) known.unshift({ root: current.activeRoot, path: '' });
      const results = await Promise.allSettled(known.map((dir) => loadDir(dir.root, dir.path, { force: true })));
      // A worktree removed while we were away: its root is gone; fall back to the main workspace.
      results.forEach((result, index) => {
        const dir = known[index];
        if (result.status === 'rejected' && dir && dir.root.kind === 'worktree' && dir.path === '') dropRoot(dir.root);
      });
      const failed = results.find((result) => result.status === 'rejected');
      if (failed && failed.status === 'rejected') ctx?.reportError('files', failed.reason);
    },
  };

  return { store, lifecycle };
}
