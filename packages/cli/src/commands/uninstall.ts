// `smurg uninstall [--keep-data] [--yes]` (owner decision 2026-10-02): removes smurg from this machine.
//
// What it removes, and nothing else:
//  - the single executable itself (process.execPath);
//  - smurg's cache: every `native-<id>` directory an executable extracted its native modules into (all builds, in the
//    cache root in force and in the platform's default one; ../sea/native.ts), and a cache root that is empty afterwards;
//  - the state dir (`~/.smurg`, ../state/paths.ts): the relay logins, the device key, every workspace's keys, members
//    and invites, the logs, the run sockets. `--keep-data` keeps it.
// What it never touches: the `.smurg/` folders inside shared project folders (worktrees and work that is not merged yet
// live there). It LISTS the ones it knows (workspaces.json, and one around the current directory) so the person can
// delete them; it does not edit shell profiles either (the installer only printed the PATH line), it says so.
//
// Order: everything is looked at and every refusal happens BEFORE anything changes; then the plan is printed (paths and
// sizes) and the person is asked to confirm (y/N) at a terminal (`--yes` skips the question; without a terminal
// and without `--yes` it refuses); then every running `smurg host` of this state dir is stopped as `smurg stop` does
// and waited for (one that cannot be stopped aborts with nothing removed); then the cache, the state dir, and the
// executable last (a failure before it leaves a `smurg` to run again).
//
// Guards (fail closed): only the single executable uninstalls itself (a source checkout is told what to delete by
// hand). The state dir is removed only when its real path is not `/`, not a top-level directory, not the home
// directory or anything around it or around the system's home directories; a SMURG_HOME other than ~/.smurg must also
// look like a state dir (only entries smurg creates). A state dir that is a symlink is unlinked, never followed.
// Removal never follows a symlink out of what it removes (rm unlinks them), and each path is removed only while it
// is still the file or directory that was looked at (device and inode).
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { HOMES_PARENTS } from '@smurg/daemon';
import { booleanOption, parseArgs } from '../cli/args.ts';
import { CliError, isCliError, usageError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import { runningDaemons, type RunningDaemon } from '../channel/discover.ts';
import { nativeCacheEntry, nativeCacheRoots, seaExecutable } from '../sea/native.ts';
import { homeDirOf } from '../state/paths.ts';
import { loadWorkspaces } from '../state/workspaces.ts';
import { INSTALL_COMMAND } from '../update/downloads.ts';
import { m, type Text } from '../i18n/index.ts';
import { say, tr, type CommandContext } from './context.ts';
import { STOP_WAIT_MS, requestStop, waitUntilStopped } from './stop.ts';

/** Test seams (the real ones: this executable and platform). */
export interface UninstallDeps {
  /** The single executable this process is; null: running from source. Default: seaExecutable(). */
  readonly executable?: string | null;
  readonly platform?: NodeJS.Platform;
  /** How long a running `smurg host` may take to stop. Default: `smurg stop`'s 30 s. */
  readonly stopWaitMs?: number;
}

/** What a state dir holds at its top (ARCHITECTURE §7.1; `cwd` was the daemon's working directory until 0.2.0). */
const STATE_ENTRIES: readonly string[] = ['credentials.json', 'device.key', 'workspaces.json', 'run', 'pins', 'logs', 'sessions', 'workspaces', 'cwd', '.DS_Store'];
/** A private file being replaced (../state/private-file.ts, @smurg/protocol/node key-file.ts). */
const STATE_TEMP_ENTRY = /^\.[A-Za-z0-9._-]+\.[0-9a-f]{12,16}\.tmp$/;
/** What the daemon creates inside a shared folder's `.smurg/` (ARCHITECTURE §7.1). */
const PROJECT_ENTRIES: readonly string[] = ['daemon-lock.json', 'worktrees', 'trash', 'uploads'];
/** Sizes are a courtesy: a tree with more entries than this is shown without one. */
const MEASURE_MAX_ENTRIES = 20_000;

type Kind = 'file' | 'directory' | 'symlink';

interface Removal {
  readonly path: string;
  readonly kind: Kind;
  /** What the person reads next to the path. */
  readonly what: Text;
  readonly bytes: number | null;
  /** The file or directory that was looked at: removed only while the path still is this one. */
  readonly dev: number;
  readonly ino: number;
}

function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown';
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** The bytes of a file, or of every file below a directory (no symlink is followed); null: too many entries to count. */
async function measure(path: string): Promise<number | null> {
  let bytes = 0;
  let entries = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let st;
    try {
      st = await lstat(current);
    } catch {
      continue;
    }
    if ((entries += 1) > MEASURE_MAX_ENTRIES) return null;
    if (!st.isDirectory()) {
      bytes += st.size;
      continue;
    }
    try {
      for (const name of await readdir(current)) pending.push(join(current, name));
    } catch {
      // unreadable: counted as far as it goes
    }
  }
  return bytes;
}

function formatSize(bytes: number | null): Text {
  if (bytes === null) return '';
  if (bytes < 1_000) return m('uninstall.size.bytes', { bytes });
  if (bytes < 1_000_000) return m('uninstall.size.kb', { kb: Math.round(bytes / 1_000) });
  return m('uninstall.size.mb', { mb: (bytes / 1_000_000).toFixed(1) });
}

async function removalOf(path: string, kind: Kind, what: Text, st: { readonly dev: number; readonly ino: number; readonly size: number }): Promise<Removal> {
  return { path, kind, what, bytes: kind === 'symlink' ? null : kind === 'file' ? st.size : await measure(path), dev: st.dev, ino: st.ino };
}

function refusal(message: Text, stateDir: string): CliError {
  return new CliError(message, { exitCode: EXIT.usage, hint: m('uninstall.refusal.hint', { stateDir }) });
}

/**
 * The state dir as something to remove: null when there is none; a refusal (nothing was changed yet) when removing it
 * could take more than smurg's own state.
 */
async function stateRemoval(ctx: CommandContext, home: string): Promise<{ readonly removal: Removal; readonly linkTarget: string | null } | null> {
  const stateDir = ctx.paths.stateDir;
  const st = await lstat(stateDir).catch(() => null);
  if (st === null) return null;
  if (st.isSymbolicLink()) {
    const target = await realpath(stateDir).catch(() => null);
    return { removal: await removalOf(stateDir, 'symlink', m('uninstall.what.stateSymlink'), st), linkTarget: target };
  }
  if (!st.isDirectory()) throw refusal(m('uninstall.state.notDirectory', { stateDir }), stateDir);
  const real = await realpath(stateDir);
  const realHome = await realpath(home).catch(() => home);
  if (real === sep || real.split(sep).filter((part) => part !== '').length < 2) throw refusal(m('uninstall.state.topLevel', { path: real }), stateDir);
  if (isInside(realHome, real)) throw refusal(m(real === realHome ? 'uninstall.state.isHome' : 'uninstall.state.containsHome', { path: real }), stateDir);
  for (const homes of HOMES_PARENTS) {
    const realHomes = await realpath(homes).catch(() => null);
    if (realHomes !== null && isInside(realHomes, real)) throw refusal(m('uninstall.state.containsHomes', { path: real }), stateDir);
  }
  if (stateDir !== join(home, '.smurg')) {
    // A SMURG_HOME of the person's choosing: removed as a whole only when nothing but smurg's own entries is in it.
    const foreign = (await readdir(real)).filter((name) => !STATE_ENTRIES.includes(name) && !STATE_TEMP_ENTRY.test(name)).sort();
    if (foreign.length > 0) {
      throw refusal(m('uninstall.state.foreign', { path: real, names: foreign.slice(0, 5), total: foreign.length }), stateDir);
    }
  }
  return { removal: await removalOf(stateDir, 'directory', m('uninstall.what.state'), st), linkTarget: null };
}

/** Every native dir of every build in the cache roots, and the roots themselves (removed afterwards when empty). */
async function cacheRemovals(roots: readonly string[]): Promise<{ readonly removals: Removal[]; readonly roots: string[] }> {
  const removals: Removal[] = [];
  const present: string[] = [];
  for (const root of roots) {
    const top = await lstat(root).catch(() => null);
    if (top === null || !top.isDirectory()) continue; // missing, or a symlink: never followed
    present.push(root);
    for (const name of (await readdir(root).catch(() => [])).sort()) {
      if (nativeCacheEntry(name) === null) continue;
      const path = join(root, name);
      const st = await lstat(path).catch(() => null);
      if (st !== null && st.isDirectory()) removals.push(await removalOf(path, 'directory', m('uninstall.what.cache'), st));
    }
  }
  return { removals, roots: present };
}

/**
 * The `.smurg/` folders of shared project folders that are still on disk: the folders workspaces.json remembers, and a
 * folder around the current directory that carries the daemon's own entries. Listed, never removed.
 */
async function projectFolders(ctx: CommandContext): Promise<string[]> {
  const stateReal = await realpath(ctx.paths.stateDir).catch(() => ctx.paths.stateDir);
  /** A real directory (not a symlink) that is not the state dir itself (~/.smurg, seen from the home directory). */
  const isProjectData = async (path: string): Promise<boolean> => {
    if ((await lstat(path).catch(() => null))?.isDirectory() !== true) return false;
    return (await realpath(path).catch(() => path)) !== stateReal;
  };
  const found = new Set<string>();
  const book = await loadWorkspaces(ctx.paths).catch(() => ({ shared: [], joined: [] }));
  for (const entry of book.shared) {
    const path = join(entry.folder, '.smurg');
    if (await isProjectData(path)) found.add(path);
  }
  for (let dir = ctx.io.cwd; ; dir = dirname(dir)) {
    const path = join(dir, '.smurg');
    if ((await isProjectData(path)) && (await readdir(path).catch(() => [])).some((name) => PROJECT_ENTRIES.includes(name))) found.add(path);
    if (dirname(dir) === dir) break;
  }
  return [...found].sort();
}

/** Removes one planned path, only while it is still what the plan looked at; a symlink is unlinked, never followed. */
async function remove(removal: Removal): Promise<void> {
  const st = await lstat(removal.path).catch(() => null);
  if (st === null) return; // already gone
  if (st.dev !== removal.dev || st.ino !== removal.ino) throw new CliError(m('uninstall.changed', { path: removal.path }));
  if (removal.kind === 'directory') await rm(removal.path, { recursive: true, force: true });
  else await unlink(removal.path);
}

export async function runUninstall(argv: readonly string[], ctx: CommandContext, deps: UninstallDeps = {}): Promise<number> {
  const args = parseArgs(argv, { options: { 'keep-data': { kind: 'boolean' }, yes: { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    say(ctx, m('usage.uninstall'));
    return EXIT.ok;
  }
  const { io } = ctx;
  const keepData = booleanOption(args, 'keep-data') === true;
  const yes = booleanOption(args, 'yes') === true;
  const home = homeDirOf(io.env);
  const stateDir = ctx.paths.stateDir;
  const cacheRoots = nativeCacheRoots(io.env, deps.platform ?? process.platform, home);
  const executable = deps.executable === undefined ? seaExecutable() : deps.executable;
  if (executable === null) {
    throw new CliError(m('uninstall.fromSource'), { exitCode: EXIT.usage, hint: m('uninstall.fromSource.hint', { stateDir, cacheRoots }) });
  }

  // ---- look at everything; every refusal happens here, before anything changes
  const exe = await lstat(executable).catch(() => null);
  if (exe === null || !exe.isFile()) throw new CliError(m('uninstall.noExecutable', { executable }), { exitCode: EXIT.usage });
  try {
    await access(dirname(executable), fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new CliError(m('uninstall.notWritable', { executable, dir: dirname(executable) }), { hint: m('uninstall.notWritable.hint') });
  }
  const state = keepData ? null : await stateRemoval(ctx, home);
  const cache = await cacheRemovals(cacheRoots);
  const projects = await projectFolders(ctx);
  const running = await runningDaemons(ctx.paths);
  const self = await removalOf(executable, 'file', m('uninstall.what.executable'), exe);
  // The executable goes last: a failure before it leaves a `smurg` to run again.
  const removals: Removal[] = [...cache.removals, ...(state ? [state.removal] : []), self];

  // ---- say exactly what will happen
  const lines = [tr(ctx, m('uninstall.plan.heading')), ...[self, ...(state ? [state.removal] : []), ...cache.removals].map((r) => tr(ctx, m('uninstall.plan.item', { path: r.path, size: formatSize(r.bytes), what: r.what })))];
  if (state?.removal.kind === 'directory') lines.push(tr(ctx, m('uninstall.plan.stateNote')));
  if (running.length > 0) lines.push('', tr(ctx, m('uninstall.plan.stops', { ids: running.map((d) => d.status.workspaceId) })));
  const kept: string[] = [];
  if (keepData) kept.push(tr(ctx, m('uninstall.kept.state', { stateDir })));
  if (state?.linkTarget) kept.push(tr(ctx, m('uninstall.kept.linkTarget', { target: state.linkTarget })));
  for (const path of projects) kept.push(tr(ctx, m('uninstall.kept.project', { path })));
  if (kept.length > 0) lines.push('', tr(ctx, m('uninstall.kept.heading')), ...kept);
  say(ctx, lines.join('\n'));

  // ---- ask
  if (!yes) {
    if (!io.terminal.isTTY) throw usageError(m('uninstall.noTerminal'), m('uninstall.noTerminal.hint'));
    const answer = await io.readLine(tr(ctx, m('uninstall.question')));
    if (answer === null || !/^(?:y|yes)$/i.test(answer)) throw new CliError(m('uninstall.cancelled'));
  }

  // ---- stop every running share first; one that does not stop aborts with nothing removed
  const waitMs = deps.stopWaitMs ?? STOP_WAIT_MS;
  for (const daemon of running) {
    say(ctx, m('stop.stopping', { workspaceId: daemon.status.workspaceId }));
    try {
      await requestStop(daemon);
      await waitUntilStopped(ctx, daemon, waitMs);
    } catch (err) {
      throw stopFailure(daemon, err);
    }
  }
  // … including a share that started while the question was open.
  const still = await runningDaemons(ctx.paths);
  if (still.length > 0) throw stopFailure(still[0] as RunningDaemon, null);
  if (running.length > 0) say(ctx, m('host.stopped'));

  // ---- remove: the cache, the state dir, the executable last
  const removed: string[] = [];
  for (const removal of removals) {
    try {
      await remove(removal);
      removed.push(removal.path);
    } catch (err) {
      const rest = removals.filter((r) => !removed.includes(r.path)).map((r) => r.path);
      throw new CliError(isCliError(err) ? err.text : m('uninstall.removeFailed', { path: removal.path, code: codeOf(err) }), { hint: m('uninstall.removeFailed.hint', { removed: [...removed], rest }), cause: err });
    }
  }
  // A cache root that held nothing else goes too (rmdir refuses a directory that is not empty).
  for (const root of cache.roots) {
    if (await rmdir(root).then(() => true, () => false)) removed.push(root);
  }

  const left = [...kept, tr(ctx, m('uninstall.left.path', { dir: dirname(executable) }))];
  say(ctx, m('uninstall.done', { removed, left, install: INSTALL_COMMAND }));
  return EXIT.ok;
}

function stopFailure(daemon: RunningDaemon, err: unknown): CliError {
  return new CliError(m('uninstall.stopFailed', { workspaceId: daemon.status.workspaceId, ...(isCliError(err) ? { reason: err.text } : {}) }), {
    hint: m('uninstall.stopFailed.hint'),
    cause: err ?? undefined,
  });
}
