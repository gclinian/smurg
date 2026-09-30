// TEST ONLY. The test run's safety net for what a test leaves behind when it cannot clean up itself (gate-stability,
// 2026-09-29): a test worker that dies hard (a native crash of @parcel/watcher killed one with SIGTRAP in a full gate
// run) never runs its `finally` / afterEach, and its temp dirs (`smurg-test-daemon-*`, `/tmp/smurg-run-*`) and the
// background jobs it started stayed on the machine.
//
// Every directory a test helper creates and every long-lived process a test starts is REGISTERED here, with its
// identity (dev/ino of the directory; a marker that is in the process's command line). After the run, the owner of the
// registry (the first vitest globalSetup of the run, in vitest's main process) removes what is still there AND is
// still the same thing, and says so on stderr: a green run of tests that clean up after themselves prints nothing.
// Nothing is ever selected by a name pattern or by scanning the machine: only what this run registered.
//
// The registry is a directory named in SMURG_TEST_RUN_REGISTRY (inherited by the forks and by every process a test
// spawns with process.env); each process appends to its own file. Only node built-ins: vitest's main process loads
// this module (globalSetup) without the daemon.
//
// A directory's identity is (dev, ino), and the registering process keeps the directory OPEN until it exits: ext4 (the
// usual Linux /tmp) hands a freed inode number out again at once, so a directory removed and re-created at the same
// path would otherwise come back with the registered inode number (and even the same birth time, whose clock ticks in
// milliseconds). An open directory's inode is not freed when the directory is removed, so whatever is created at its
// path meanwhile gets another number, on every file system. APFS never reuses inode numbers soon; there it changes
// nothing.
import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RUN_REGISTRY_ENV = 'SMURG_TEST_RUN_REGISTRY';
const REGISTRY_PREFIX = 'smurg-test-run-';
/** Every directory the registry may remove is named like this (the test helpers' prefixes). */
const REMOVABLE_PREFIX = 'smurg-';

type Entry =
  | { readonly kind: 'dir'; readonly path: string; readonly dev: number; readonly ino: number }
  | { readonly kind: 'process'; readonly pid: number; readonly marker: string };

function append(entry: Entry): void {
  const registry = process.env[RUN_REGISTRY_ENV];
  if (!registry) return;
  try {
    appendFileSync(join(registry, `${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // The run is over (the registry is gone) or this process runs outside a registered run: nothing to do.
  }
}

/** Open handles on the directories this process registered, by registry (see the top of this file). */
const pinned = new Map<string, number[]>();

/** Keeps `dir` open for the life of this process (or until its registry is swept here); false when it changed. */
function pin(registry: string, dir: string, info: { readonly dev: number; readonly ino: number }): boolean {
  let fd: number;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    return false;
  }
  const opened = fstatSync(fd);
  if (opened.dev !== info.dev || opened.ino !== info.ino) {
    closeSync(fd);
    return false;
  }
  const fds = pinned.get(registry);
  if (fds) fds.push(fd);
  else pinned.set(registry, [fd]);
  return true;
}

function unpin(registry: string): void {
  for (const fd of pinned.get(registry) ?? []) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
  pinned.delete(registry);
}

/** Records a directory this process just created (call it right after mkdtemp). */
export function registerTestDir(dir: string): void {
  const registry = process.env[RUN_REGISTRY_ENV];
  if (!registry) return;
  try {
    const info = lstatSync(dir);
    // Pinned first: a directory that cannot be held open is not registered (its identity would not be reliable).
    if (info.isDirectory() && pin(registry, dir, info)) append({ kind: 'dir', path: dir, dev: info.dev, ino: info.ino });
  } catch {
    // Not there any more: nothing to remove later.
  }
}

/**
 * Records a process a test started that may outlive the test's worker (a nohup job, a detached child). `marker` is a
 * string unique to this process that is in its command line (the tests' random tokens): the teardown signals the pid
 * only while its command line still contains it (pids are reused).
 */
export function registerTestProcess(pid: number, marker: string): void {
  if (!Number.isInteger(pid) || pid <= 1 || marker.length < 6) return;
  append({ kind: 'process', pid, marker });
}

/**
 * Registers the direct children of THIS process whose command line contains `commandIncludes` (read-only `ps`), each
 * with its whole command line as its identity: for processes a library spawned on the test's behalf without handing
 * out their pid (the workerd processes of a local relay: they outlive a worker that dies, serving forever).
 */
export async function registerOwnChildren(commandIncludes: string): Promise<void> {
  if (!process.env[RUN_REGISTRY_ENV]) return;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('/bin/ps', ['-ax', '-ww', '-o', 'pid=,ppid=,command=']));
  } catch {
    return;
  }
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[2]) !== process.pid || !(match[3] as string).includes(commandIncludes)) continue;
    registerTestProcess(Number(match[1]), (match[3] as string).trim());
  }
}

function readEntries(registry: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of readdirSync(registry)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(registry, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as Entry);
      } catch {
        // A line torn by a process killed mid-write: its directory, if any, was not registered.
      }
    }
  }
  return entries;
}

async function commandOf(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
    return stdout.trim();
  } catch {
    return ''; // no such process
  }
}

/** Removes what the run's tests registered and left behind; returns a line per leftover. */
async function sweep(registry: string): Promise<string[]> {
  const report: string[] = [];
  const entries = readEntries(registry);
  const own = new Set([process.pid, process.ppid]);
  // Processes first: a leftover job may still write into a leftover directory.
  for (const entry of entries) {
    if (entry.kind !== 'process' || own.has(entry.pid)) continue;
    const command = await commandOf(entry.pid);
    if (!command.includes(entry.marker)) continue;
    try {
      process.kill(entry.pid, 'SIGKILL');
      report.push(`process ${entry.pid} (${command.replace(/^\S*\//, '').slice(0, 120)})`);
    } catch {
      // Gone meanwhile.
    }
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    if (!isAbsolute(entry.path) || !basename(entry.path).startsWith(REMOVABLE_PREFIX)) continue;
    let info;
    try {
      info = lstatSync(entry.path);
    } catch {
      continue; // removed by its test, as it should be
    }
    if (!info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino) continue; // not the one registered
    rmSync(entry.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    report.push(`directory ${entry.path}`);
  }
  return report;
}

/** What a vitest globalSetup receives, as far as the registry uses it. */
export interface RegistryProject {
  readonly vitest?: { onClose?(fn: () => unknown): void };
}

const DUMP_CLEANUP = Symbol.for('smurg.test.vitestDumpCleanup');

/**
 * vitest 5.0.2 dumps the transformed modules it hands to `forks` workers into `<os.tmpdir()>/<21 chars>/ssr`. A
 * project's own dump dir is removed when the project closes, but a run whose root config IS the project (`pnpm
 * --filter <pkg> test`, `vitest run` inside a package) dumps into the Vitest instance's directory, which vitest never
 * removes: one directory per run. Remove exactly that directory (the path vitest chose) when vitest closes.
 */
function removeVitestDumpDirOnClose(project: RegistryProject): void {
  const vitest = project.vitest as (RegistryProject['vitest'] & { _tmpDir?: unknown; [DUMP_CLEANUP]?: true }) | undefined;
  if (!vitest || typeof vitest.onClose !== 'function' || vitest[DUMP_CLEANUP]) return;
  vitest[DUMP_CLEANUP] = true;
  const dir = vitest._tmpDir;
  // Only the directory vitest named, directly in the OS temp dir (where vitest puts it: join(tmpdir(), nanoid())).
  if (typeof dir !== 'string' || !isAbsolute(dir) || dirname(dir) !== tmpdir()) return;
  vitest.onClose(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * globalSetup: opens the run's registry (the first call in vitest's main process owns it; later calls from the other
 * projects' globalSetups share it) and returns the teardown. The owner's teardown runs after every test file of the
 * run finished: it removes the leftovers, reports them, and deletes the registry.
 */
export function startRunRegistry(project: RegistryProject = {}): () => Promise<void> {
  removeVitestDumpDirOnClose(project);
  const existing = process.env[RUN_REGISTRY_ENV];
  // Shared only with this very process (the name carries its pid): a registry inherited from an outer run is not ours.
  if (existing && basename(existing).startsWith(`${REGISTRY_PREFIX}${process.pid}-`)) return async () => {};
  const registry = mkdtempSync(join(realpathSafe(tmpdir()), `${REGISTRY_PREFIX}${process.pid}-`));
  process.env[RUN_REGISTRY_ENV] = registry;
  const previous = existing;
  return async () => {
    try {
      const leftovers = await sweep(registry);
      if (leftovers.length > 0) {
        process.stderr.write(`[smurg test run] removed ${leftovers.length} leftover(s) that tests did not clean up (a worker that died, or a test that leaks):\n${leftovers.map((line) => `  ${line}\n`).join('')}`);
      }
    } finally {
      unpin(registry);
      rmSync(registry, { recursive: true, force: true });
      if (process.env[RUN_REGISTRY_ENV] === registry) {
        if (previous === undefined) delete process.env[RUN_REGISTRY_ENV];
        else process.env[RUN_REGISTRY_ENV] = previous;
      }
    }
  };
}
