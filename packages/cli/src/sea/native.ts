// Native parts of the single executable (Node SEA, scripts/build-sea.ts; pty-packaging.md §6.5, V10). Inside a SEA,
// `require` can load only built-in modules, and native addons (and node-pty's spawn-helper, which macOS runs through
// posix_spawn) must be real files. So the build embeds them as SEA assets with a sha256 manifest, and at run time they
// are extracted once into a per-build cache dir (`native-<id>`: builds never mix), atomically (temp dir + rename), and
// verified on every process start before anything is loaded from there:
//
//   <cache>/native-<id>/node-pty/{package.json, lib/**, prebuilds/<platform>-<arch>/{pty.node, spawn-helper}}
//   <cache>/native-<id>/parcel-watcher/watcher.node
//   <cache>/native-<id>/lib/compute-worker.ts        the docs module's worker (a CJS bundle; see below)
//
// The bundle's banner (build-sea.ts) sets `globalThis.__smurgSea = { dir, manifest }` and points every bundled
// `import.meta.url` at `<dir>/lib/smurg.cjs`, so code that locates files next to itself finds them in that dir: the
// docs compute worker (`./compute-worker.ts`). <cache> is $SMURG_CACHE_DIR, else ~/Library/Caches/smurg (macOS) or
// $XDG_CACHE_HOME/smurg (~/.cache/smurg).
//
// Other builds' dirs (an upgrade) are removed after NATIVE_KEEP_DAYS without use (pruneNativeCache).
//
// Outside a SEA (running from source) nothing here is used: node-pty and @parcel/watcher load from node_modules.
// Synchronous file system calls are deliberate: this runs once, before the daemon starts (`smurg host`), or from a
// synchronous `require` of node-pty; after the first successful verification the result is remembered.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

export interface NativeFile {
  readonly sha256: string;
  /** 0o600 for data, 0o700 for executables (spawn-helper). */
  readonly mode: number;
}

export interface NativeManifest {
  /** First 16 hex of the sha256 over every file's name and hash: the cache dir name. */
  readonly id: string;
  /** Relative path inside the native dir → file; the SEA asset key is `native/<path>`. */
  readonly files: Readonly<Record<string, NativeFile>>;
}

interface SeaState {
  readonly dir: string;
  readonly manifest: NativeManifest;
}

interface SeaModule {
  isSea(): boolean;
  getRawAsset(key: string): ArrayBuffer;
}

export class NativeExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeExtractionError';
  }
}

/** The state the SEA banner prepared; null when this is not the single executable. */
function seaState(): SeaState | null {
  const state = (globalThis as { __smurgSea?: SeaState }).__smurgSea;
  return state && typeof state.dir === 'string' && state.manifest ? state : null;
}

function seaModule(): SeaModule {
  const sea = process.getBuiltinModule?.('node:sea') as SeaModule | undefined;
  if (!sea?.isSea()) throw new NativeExtractionError('not running as a single executable');
  return sea;
}

/** True inside the single executable. */
export function isSeaBuild(): boolean {
  return seaState() !== null;
}

/**
 * The single executable this process IS (process.execPath: absolute, symlinks resolved), or null when smurg runs from
 * source (process.execPath is then the person's Node). `smurg update` replaces this file and `smurg uninstall` removes
 * it, so both refuse on null.
 */
export function seaExecutable(): string | null {
  try {
    const sea = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
    return sea?.isSea?.() === true ? process.execPath : null;
  } catch {
    return null;
  }
}

const NATIVE_DIR = /^native-[0-9a-f]{16}$/;
const NATIVE_TEMP_DIR = /^\.native-[0-9a-f]{16}-[A-Za-z0-9]+$/;

/** What an entry of a cache root is: a build's native dir, an extraction's temp dir, or not ours (null). */
export function nativeCacheEntry(name: string): 'build' | 'temp' | null {
  if (NATIVE_DIR.test(name)) return 'build';
  return NATIVE_TEMP_DIR.test(name) ? 'temp' : null;
}

/**
 * The cache roots a single executable of this person may have extracted into: the one in force ($SMURG_CACHE_DIR when
 * absolute, else the platform's default) and the default itself; the rule of the bundle's banner
 * (scripts/build-sea.ts), which decides the dir before this module is loaded. `home` is the person's home directory.
 */
export function nativeCacheRoots(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, home: string): string[] {
  const xdg = env['XDG_CACHE_HOME'];
  const standard = platform === 'darwin' ? join(home, 'Library', 'Caches', 'smurg') : join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.cache'), 'smurg');
  const override = env['SMURG_CACHE_DIR'];
  const roots = override !== undefined && isAbsolute(override) ? [override, standard] : [standard];
  const own = seaState();
  if (own !== null) roots.unshift(dirname(own.dir));
  return [...new Set(roots.map((root) => (root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root)))];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file present, a regular file (never a symlink), with the manifest's hash. */
function verify(dir: string, manifest: NativeManifest): boolean {
  try {
    const top = lstatSync(dir);
    if (!top.isDirectory()) return false;
    for (const [rel, file] of Object.entries(manifest.files)) {
      const path = join(dir, rel);
      const st = lstatSync(path);
      if (!st.isFile()) return false;
      if (sha256(readFileSync(path)) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeRelative(rel: string): boolean {
  return rel.length > 0 && !rel.startsWith('/') && !rel.split('/').some((part) => part === '' || part === '.' || part === '..');
}

let verifiedDir: string | null = null;

/** Days another build's native dir may stay unused (no smurg of that build started) before it is removed. */
export const NATIVE_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * An upgrade leaves the old build's `native-<id>` dir behind (about 20 MiB each). Every start of a build touches its
 * own dir; this removes the dirs of OTHER builds unused for NATIVE_KEEP_DAYS, and extraction temp dirs older than a
 * day. Only entries named like ours, only real directories (never through a symlink); best effort, never throws.
 * Returns the names removed.
 */
export function pruneNativeCache(root: string, current: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (name === basename(current)) continue;
    const kind = nativeCacheEntry(name);
    if (kind === null) continue;
    const native = kind === 'build';
    const path = join(root, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs <= (native ? NATIVE_KEEP_DAYS : 1) * DAY_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // in use by a concurrent start, permissions, …: try again next time
    }
  }
  return removed;
}

/**
 * Extracts (when needed) and verifies the native files of this build; returns their dir, or null outside a SEA.
 * Throws NativeExtractionError when they cannot be put in place or do not verify (fail closed: nothing is loaded).
 */
export function ensureSeaNative(): string | null {
  const state = seaState();
  if (state === null) return null;
  if (verifiedDir === state.dir) return verifiedDir;
  const { dir, manifest } = state;
  if (!verify(dir, manifest)) {
    const sea = seaModule();
    const root = dirname(dir);
    let tmp: string;
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      tmp = mkdtempSync(join(root, `.native-${manifest.id}-`));
    } catch (err) {
      throw new NativeExtractionError(`cannot create ${root}`, { cause: err });
    }
    try {
      for (const [rel, file] of Object.entries(manifest.files)) {
        if (!safeRelative(rel)) throw new NativeExtractionError(`bad path in the native manifest: ${rel}`);
        const dest = join(tmp, ...rel.split('/'));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        writeFileSync(dest, new Uint8Array(sea.getRawAsset(`native/${rel}`)), { mode: file.mode, flag: 'wx' });
        chmodSync(dest, file.mode);
      }
      // A stale or tampered copy is replaced as a whole; a concurrent start may have won the race meanwhile.
      rmSync(dir, { recursive: true, force: true });
      try {
        renameSync(tmp, dir);
      } catch (err) {
        if (!verify(dir, manifest)) throw err;
      }
    } catch (err) {
      throw err instanceof NativeExtractionError ? err : new NativeExtractionError(`cannot extract the native files to ${dir}`, { cause: err });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    if (!verify(dir, manifest)) throw new NativeExtractionError(`the native files in ${dir} do not verify`);
  }
  verifiedDir = dir;
  try {
    const now = new Date();
    utimesSync(dir, now, now); // this build is in use
  } catch {
    // not fatal
  }
  pruneNativeCache(dirname(dir), dir);
  return dir;
}

function requireFrom(path: string): NodeJS.Require {
  return createRequire(path.endsWith(sep) ? path : `${path}${sep}`);
}

/** node-pty from the verified native dir (its own loader finds prebuilds/<platform>-<arch> next to lib/). */
export function loadNodePty(): unknown {
  const dir = ensureSeaNative();
  if (dir === null) throw new NativeExtractionError('node-pty: not a single executable');
  return requireFrom(join(dir, 'node-pty'))('./lib/index.js');
}

/** The @parcel/watcher native binding from the verified native dir. */
export function loadParcelWatcherBinding(): unknown {
  const dir = ensureSeaNative();
  if (dir === null) throw new NativeExtractionError('@parcel/watcher: not a single executable');
  return requireFrom(join(dir, 'parcel-watcher'))('./watcher.node');
}
