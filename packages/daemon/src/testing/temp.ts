// TEST ONLY. Temporary folders for state dirs and shared projects. Everything lives under one `smurg-test-*`
// directory in the OS temp dir and is removed by cleanup; git runs with an isolated HOME and no global/system config,
// so tests never read or write the developer's git settings (ARCHITECTURE §0 rule 4). Every directory made here is
// registered with the test run (run-registry.ts): one whose test never got to its cleanup (a worker that died) is
// removed at the end of the run.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { SOCKET_PATH_MAX_BYTES } from '../core/sockets.ts';
import { registerTestDir } from './run-registry.ts';

const execFileAsync = promisify(execFile);
const PREFIX = 'smurg-test-';

/** A fresh private (0700) directory under the OS temp dir, symlink-free (macOS /var → /private/var). */
export async function createTempDir(label = 'tmp'): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await realpath(await mkdtemp(join(base, `${PREFIX}${label.replace(/[^a-z0-9-]/gi, '')}-`)));
  registerTestDir(dir);
  return dir;
}

/** Removes a directory created by createTempDir (refuses anything else). */
export async function removeTempDir(dir: string): Promise<void> {
  const base = await realpath(tmpdir());
  const name = dir.slice(base.length + 1);
  if (!dir.startsWith(base + sep) || !name.startsWith(PREFIX) || name.includes(sep)) throw new Error(`refusing to remove ${dir}`);
  await rm(dir, { recursive: true, force: true });
}

const RUN_PREFIX = 'smurg-run-';
/**
 * The longest socket name anything creates in a run dir. Not the daemon's own `<12 chars>.hook` (17 bytes): when
 * TMPDIR is too deep the sandbox module lets srt create its proxy sockets here (sandbox/checks.ts,
 * srtSocketDirProblem), and srt's names are twice as long. Budgeting for the hook socket only made every real-sandbox
 * test refuse to start under macOS's default TMPDIR (/var/folders/…/T), while passing under a short one.
 */
const LONGEST_SOCKET_NAMES = [
  'abcdefghijkl.hook',
  `srt-mux-${'9'.repeat(7)}-zzzzzz.sock`, // pid: up to 7 digits on Linux
  `claude-socks-${'f'.repeat(16)}.sock`,
];

async function runDirBases(): Promise<string[]> {
  const bases = [await realpath(tmpdir())];
  const tmp = await realpath('/tmp').catch(() => null);
  if (tmp !== null && !bases.includes(tmp)) bases.push(tmp);
  return bases;
}

/**
 * A fresh private (0700) directory for the daemon's Unix sockets (DaemonConfigInput.runDir), short enough for
 * macOS's 103-byte socket paths: under the OS temp dir when that is short enough, else under /tmp. It is the one
 * test directory that may not live below a long sandbox TMPDIR (a socket path there would be truncated silently).
 */
export async function createTempRunDir(): Promise<string> {
  for (const base of await runDirBases()) {
    // mkdtemp appends 6 characters.
    const longest = Math.max(...LONGEST_SOCKET_NAMES.map((name) => Buffer.byteLength(join(base, `${RUN_PREFIX}XXXXXX`, name))));
    if (longest > SOCKET_PATH_MAX_BYTES) continue;
    const dir = await realpath(await mkdtemp(join(base, RUN_PREFIX)));
    registerTestDir(dir);
    return dir;
  }
  throw new Error('no temp directory is short enough for Unix socket paths');
}

/** Removes a directory created by createTempRunDir (refuses anything else). */
export async function removeTempRunDir(dir: string): Promise<void> {
  const bases = await runDirBases();
  const ok = bases.some((base) => dir.startsWith(base + sep) && dir.slice(base.length + 1).startsWith(RUN_PREFIX) && !dir.slice(base.length + 1).includes(sep));
  if (!ok) throw new Error(`refusing to remove ${dir}`);
  await rm(dir, { recursive: true, force: true });
}

export interface TempProjectOptions {
  /** Relative path → content (directories are created as needed). */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** Initialise a git repository and commit the files. */
  readonly git?: boolean;
}

/** Environment for git in tests: no global or system config, an isolated HOME, a fixed identity. */
export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'smurg test',
    GIT_AUTHOR_EMAIL: 'test@smurg.invalid',
    GIT_COMMITTER_NAME: 'smurg test',
    GIT_COMMITTER_EMAIL: 'test@smurg.invalid',
  };
}

/** Creates `<parent>/<name>` with the given files (and optionally a git repo inside it). Returns its realpath. */
export async function createTempProject(parent: string, name = 'project', options: TempProjectOptions = {}): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  if (options.git) {
    const home = join(parent, '.git-home');
    await mkdir(home, { recursive: true });
    const env = isolatedGitEnv(home);
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
    await execFileAsync('git', ['add', '-A'], { cwd: dir, env });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'initial'], { cwd: dir, env });
  }
  return realpath(dir);
}
