// SandboxService (ARCHITECTURE §7.6 "Sandbox", core/interfaces.ts): the only way a guest process gets started.
//
//   wrap(spec)   platform + dependencies → srt initialized (once) → the spec resolved against the daemon's own view
//                (roots, state dir, hook socket) → policy → canary self-test WITH THAT POLICY through node-pty →
//                the real command, wrapped and hardened. Any failure: SmurgError('sandbox_unavailable') with
//                detail.reason, audit `sandbox.refused`. There is no fallback to an unsandboxed process.
//   preflight()  the same checks with a synthetic session inside the daemon state dir (for a UI or a start check);
//                it reports and does not audit.
//
// Two additions (2026-09-29):
//   * an AGENT session (its environment carries the hook's session token) is started only after the real `smurg hook`
//     ran inside that session's own policy with a probe event and brought back the daemon's answer (review SEC-D-05:
//     Claude Code lets a tool run when its hook cannot start, so a hook that cannot start means no file locks). Nothing
//     is cached: every agent launch runs it.
//   * the Claude LOGIN process of a guest (ARCHITECTURE §11 D-12; a spec with `loginProcess: true`)
//     runs in mode 'login': the guest dir only, nothing of the share, and the one extra right to listen on loopback,
//     added by the hardening step (bind + accept, never an outbound connection).
// And on Linux (reviews RV-1, RV-2, 2026-10-01): bubblewrap's mounts cannot follow a protected entry the host replaces,
// removes or creates while a guest process runs, so ProtectedEntryGuard (guard.ts) records what each wrap() saw and
// revokes what runs in a root where that changed (onRevoked; the sessions module ends it).
//
// Launch inputs come from ctx.config (hostHome, stateDir, runPaths.hook, sessions.selfCommand), never from
// os.homedir() or process.env. Nothing here blocks the event loop except inside srt itself (see gotchas).
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, readdirSync, renameSync, rmdirSync, type Dirent, type Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath, rm, rmdir, mkdir, unlink } from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { SmurgError, allowedDomainSchema } from '@smurg/protocol';
import { z } from 'zod';
// The hook socket's wire format (a dependency-free protocol file, like the MCP server uses): the self-test must send
// exactly what the daemon's hook server answers.
import { HOOK_ENV, HOOK_PROBE_EVENT, HOOK_PROBE_FIELD, hookProbeAnswer } from '../hooks/wire.ts';
import type { DaemonContext } from '../core/context.ts';
import type { PersistentDocument, SandboxPreflight, SandboxRevocation, SandboxService, SandboxSpec, WatchedPathEvent, WrappedCommand } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import {
  LINUX_TOOL_DIRS,
  appArmorRestrictsUserns,
  bwrapUsernsBlocked,
  checkBwrapFeatures,
  checkDarwinLauncher,
  findLinuxTools,
  nodeCheckIo,
  srtDependencyRefusal,
  srtSocketDirProblem,
  supportedPlatform,
  type CheckIo,
} from './checks.ts';
import { addPlaceholderExcludes, removePlaceholderExcludes } from './git-exclude.ts';
import { ProtectedEntryGuard, holdInode, type GuardBreach, type GuardTicket, type GuardWalk } from './guard.ts';
import { DARWIN_SANDBOX_EXEC, HardeningError, SRT_PINNED_VERSION, hardenDarwinCommand, hardenLinuxCommand, linuxArgsFilePath, shellQuote } from './harden.ts';
import {
  HOST_ONLY_DIR_NAMES,
  HOST_ONLY_FILE_NAMES,
  HOST_PERSONAL_FILES,
  PolicyError,
  SRT_GLOB_CHARS,
  SRT_OWN_WRITE_PATHS,
  buildBaseConfig,
  buildSessionPolicy,
  isStrictlyUnder,
  readCarveOutProblem,
  type CarveOutRegions,
  type LinuxTools,
  type SandboxPlatform,
  type SessionMode,
  type SessionPolicy,
  type SessionPolicyInput,
  type SrtBaseConfig,
} from './policy.ts';
import { DAEMON_CWD_UNRESOLVABLE_MESSAGE, SandboxRefusal, isSandboxRefusal, refusalMessage } from './refusal.ts';
import { RuntimeBrokenError, RuntimeBusyError, RuntimeInitError, loadSrt, processSrtRuntime, type SrtApi, type SrtRuntime } from './runtime.ts';
import { createNodePtyRunner, isDirectory, judgeSelfTest, prepareSelfTest, selfTestScript, type PtyRunner } from './selftest.ts';

export interface SandboxServiceOptions {
  /** Default: process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Default: the real srt, imported lazily. */
  readonly loadSrt?: () => Promise<SrtApi>;
  /** Default: the process-wide runtime. */
  readonly runtime?: SrtRuntime;
  /** Default: node-pty. */
  readonly runner?: PtyRunner;
  readonly io?: CheckIo;
  /** macOS launcher checked by the preflight (tests inject a missing one: R5.4). */
  readonly sandboxExecPath?: string;
  readonly linuxToolDirs?: readonly string[];
  /** Generous: the self-test runs on busy machines. */
  readonly selfTestTimeoutMs?: number;
  /** The shell srt runs the command with inside the sandbox, and the outer shell. */
  readonly shell?: string;
  /** The temp dir srt puts its proxy socket in (srt reads os.tmpdir() itself; injectable for the length check's tests). */
  readonly tmpDir?: () => string;
  /** Linux: tasks per guest sandbox (default LINUX_GUEST_TASK_LIMIT; tests use a small one to see it hold). */
  readonly linuxTaskLimit?: number;
  /** The kernel release (default os.release(); linuxCountsTasksPerUserNamespace decides on it). */
  readonly kernelRelease?: () => string;
  /** Linux: how often the protected entries of a root with guest processes are compared again (guard.ts GUARD_POLL_MS). */
  readonly guardPollMs?: number;
  /** Linux: the least time between two walks of such a root for new protected names (guard.ts GUARD_WALK_MS). */
  readonly guardWalkMs?: number;
}

interface Ready {
  readonly platform: SandboxPlatform;
  readonly hostHome: string;
  readonly hostHomeExists: boolean;
  readonly stateDir: string;
  readonly linuxTools: LinuxTools | null;
  /** Linux: srt's network bridge sockets (realpaths), carved out of every guest policy; [] on macOS. */
  readonly proxySockets: readonly string[];
}

interface ResolvedSpec {
  readonly input: SessionPolicyInput;
  readonly tmpDir: string;
  /** Login mode on macOS: the programs the process may exec (the shell first); null otherwise. */
  readonly execAllow: readonly string[] | null;
  /** Linux agent / terminal processes: the root's protected entries as this wrap saw them (ProtectedEntryGuard). */
  readonly ticket: GuardTicket | null;
}

/**
 * The spec of a guest's Claude LOGIN process (ARCHITECTURE §11 D-12; SandboxSpec.loginProcess / loginPrograms in
 * core/interfaces.ts): `rootPath` is the guest's home inside `guestDir`. Only the sessions module builds one. The
 * programs are the claude binary, the no-op BROWSER and `/usr/bin/security` (Claude Code's keychain attempt, which the
 * hardened profile makes fail fast so the credential lands in the guest's config dir).
 */
export interface LoginSandboxSpec extends SandboxSpec {
  readonly loginProcess: true;
  readonly loginPrograms: readonly string[];
}

function isLoginSpec(spec: SandboxSpec): boolean {
  return spec.loginProcess === true;
}

/** The hook self-test's own limit (the hook's deadline is 5 s; a busy machine starts node slowly). */
const HOOK_SELF_TEST_TIMEOUT_MS = 20_000;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables that change what the UNSANDBOXED outer bash does before it execs the sandbox (startup files, parsing,
 * imported functions, the dynamic loader). The spawn environment is the sessions module's clean allow-list; these are
 * refused anyway because a mistake there would run code outside the sandbox.
 */
const OUTER_SHELL_ENV = new Set(['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'IFS', 'CDPATH', 'GLOBIGNORE', 'PS4', 'PROMPT_COMMAND', 'BASH_XTRACEFD', 'EXECIGNORE', 'POSIXLY_CORRECT', 'SMURG_TTY', 'SMURG_NEW_SESSION', 'SMURG_STAT']);
const OUTER_SHELL_ENV_PREFIX = /^(?:BASH_FUNC_|DYLD_|LD_)/;
const SCRIPT_ENTRY = /\.(?:[cm]?[jt]s)$/;

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** realpath of an existing directory, or a PolicyError naming `label`. */
async function existingDir(label: string, p: unknown): Promise<string> {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new PolicyError(`${label} must be an absolute path`);
  const real = await realpathOrNull(p);
  if (real === null || !(await isDirectory(real))) throw new PolicyError(`${label} does not exist or is not a directory`);
  return real;
}

async function existingPath(label: string, p: unknown): Promise<string> {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new PolicyError(`${label} must be an absolute path`);
  const real = await realpathOrNull(p);
  if (real === null) throw new PolicyError(`${label} does not exist`);
  return real;
}

/**
 * A deny path as the kernel will see it without following its LAST component: realpath of the parent plus the name.
 * A symlink (a shared-dir link inside a worktree) is denied as itself; what it points to has its own rules. A path
 * whose parent does not exist yet keeps its lexical form.
 */
async function denyPathForm(p: unknown): Promise<string> {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new PolicyError('deny paths must be absolute');
  const lexical = resolve(p);
  if (lexical === '/') return lexical;
  const parent = await realpathOrNull(dirname(lexical));
  return parent === null ? lexical : join(parent, basename(lexical));
}

function stringArray(label: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new PolicyError(`${label} must be a list`);
  return value;
}

function isAtOrUnderAny(p: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => p === dir || isStrictlyUnder(p, dir));
}

/** Linux: the most existing host-only entries below the top of a root protected one read-only mount each. */
const LINUX_NESTED_HOST_ONLY_MAX = 1000;
/** Directories the nested walk does not enter (srt's own mandatory-deny scan skips node_modules too). */
const LINUX_NESTED_WALK_SKIP: ReadonlySet<string> = new Set(['node_modules']);
/**
 * Directory listings the nested walk keeps in flight (review RCR-7): one after the other it cost ~40 µs per directory
 * (2.0–2.5 s for 50k directories on the Linux VM), sixteen at a time ~0.2 s, with the same result.
 */
const LINUX_NESTED_WALK_CONCURRENCY = 16;
/** Log lines per wrap() naming nested host-only entries the Linux sandbox cannot deny (warnUnprotected). */
const UNPROTECTED_WARN_LINES = 20;
/** Paths a `sandbox.protected-changed` event names (the rest is counted). */
const PROTECTED_CHANGED_SHOWN = 20;

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

/**
 * Linux: the most tasks (processes and threads) one guest sandbox may hold (review attack F2, a partial mitigation;
 * ARCHITECTURE §12 "Resource limits"). Set with `ulimit -u` as the first step INSIDE the sandbox, i.e. after bubblewrap
 * made the guest's own user namespace: since Linux 5.14 RLIMIT_NPROC is counted per user namespace (ucounts), so the
 * limit counts this sandbox's tasks only, whatever the host user runs (measured on 6.8: with the host user at 141
 * tasks, a sandbox limited to 32 still started 27 processes of its own). Set OUTSIDE (before bwrap) it would cap the
 * host user's whole count and break guests whenever the host is busy. It cannot be raised from inside (the hard limit
 * is lowered too). Well above what a build or a test run of a guest normally holds, well below the host user's own
 * limit (31414 on the 8 GB test VM): a fork bomb in one sandbox no longer takes every process slot of the host user,
 * so the daemon can still start processes. Memory, disk and CPU stay unlimited, and the limit is per sandbox: a guest
 * with the most sessions (SessionLimits.maxSessionsPerUser, 8) can hold eight times as many. On an older kernel (or a
 * release string that does not say) it is not set at all: there it would count every task of the host user.
 */
export const LINUX_GUEST_TASK_LIMIT = 4096;

/**
 * Whether this Linux kernel counts RLIMIT_NPROC per user namespace (5.14 and later: "Reimplement RLIMIT_NPROC on top
 * of ucounts"), from `os.release()` ("6.8.0-85-generic"). False when the release cannot be read.
 */
export function linuxCountsTasksPerUserNamespace(release: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\D|$)/.exec(release);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 5 || (major === 5 && minor >= 14);
}

/** Why an existing nested host-only entry cannot be denied on Linux (NestedHostOnly.unprotected). */
export type UnprotectedReason = 'glob-characters' | 'not-utf8';

export interface NestedHostOnly {
  /** Denied literally: one read-only bind each (SessionPolicyInput.nestedHostOnlyPaths). Sorted. */
  readonly deny: readonly string[];
  /**
   * Entries srt cannot be given, so guests can write them (logged for the host; review attack F1): a path with a glob
   * character (`*`, `?`, `[`, `]`: srt drops such a write deny on Linux without a word, and a refused one used to refuse
   * every guest session in that root), or one that is not UTF-8 (no JavaScript string spells it: srt would deny a path
   * that does not exist, and bubblewrap would put a mount point there). `path` is the UTF-8 reading (lossy for the
   * second kind). Sorted by path.
   */
  readonly unprotected: readonly { readonly path: string; readonly reason: UnprotectedReason }[];
}

const SLASH = Buffer.from('/');

/**
 * Linux: the host-only entries (HOST_ONLY_DIR_NAMES, HOST_ONLY_FILE_NAMES) that exist BELOW the top of `root`. srt
 * drops write-deny globs on Linux (bubblewrap binds concrete paths only: `<root>/**\/.claude` protected nothing), so
 * each existing match becomes a literal deny (a read-only bind) instead. A NEW name below the top cannot be blocked
 * with mounts at all (ARCHITECTURE §12). The walk follows no symlink, does not enter a match (denied whole) or the
 * top-level `.smurg` (denied), and skips node_modules. It runs on every wrap() (a list kept from an earlier walk would
 * miss a repository the host cloned since) and lists up to LINUX_NESTED_WALK_CONCURRENCY directories at once. Names are
 * read as bytes, so a directory whose name is not UTF-8 is still entered and what is below it reported. Null when
 * there are more than LINUX_NESTED_HOST_ONLY_MAX entries (denied and unprotected together). `personal`, when given,
 * also receives the host's personal memory files met on the way (`CLAUDE.local.md` below the top, UTF-8 paths only):
 * srt read-denies them by glob, and the sandbox guard records them (guard.ts); more than LINUX_NESTED_HOST_ONLY_MAX of
 * them is null too (review GR-6: a subset, taken in whatever order the listings finished, differed from wrap to wrap,
 * and the guard took each difference for a change).
 */
export async function nestedHostOnlyPaths(root: string, concurrency = LINUX_NESTED_WALK_CONCURRENCY, personal?: string[]): Promise<NestedHostOnly | null> {
  const walked = await walkNestedHostOnly(root, concurrency, personal);
  return walked.tooMany ? null : { deny: walked.deny, unprotected: walked.unprotected };
}

/**
 * nestedHostOnlyPaths' walk, which also says what it found when there are too many (the guard's walk, review GR-1:
 * what is new among them is named to the host).
 */
async function walkNestedHostOnly(root: string, concurrency = LINUX_NESTED_WALK_CONCURRENCY, personal?: string[]): Promise<NestedHostOnly & { readonly tooMany: boolean }> {
  const names = new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES]);
  const personalNames = new Set(HOST_PERSONAL_FILES.filter((rel) => !rel.includes('/')));
  const deny: string[] = [];
  const unprotected: { path: string; reason: UnprotectedReason }[] = [];
  const queue: Buffer[] = [];
  let found = 0;
  let tooMany = false;
  const list = (dir: Buffer): Promise<Dirent<Buffer>[]> => readdir(dir, { withFileTypes: true, encoding: 'buffer' }).catch(() => []);
  const rootBytes = Buffer.from(root, 'utf8');
  for (const entry of await list(rootBytes)) {
    const name = entry.name.toString('utf8');
    if (entry.isDirectory() && !names.has(name) && !LINUX_NESTED_WALK_SKIP.has(name)) queue.push(Buffer.concat([rootBytes, SLASH, entry.name]));
  }
  const visit = async (dir: Buffer): Promise<void> => {
    for (const entry of await list(dir)) {
      const name = entry.name.toString('utf8');
      const bytes = Buffer.concat([dir, SLASH, entry.name]);
      if (names.has(name)) {
        found++;
        if (found > LINUX_NESTED_HOST_ONLY_MAX) tooMany = true;
        const path = bytes.toString('utf8');
        if (!Buffer.from(path, 'utf8').equals(bytes)) unprotected.push({ path, reason: 'not-utf8' });
        else if (SRT_GLOB_CHARS.test(path)) unprotected.push({ path, reason: 'glob-characters' });
        else deny.push(path);
      } else if (entry.isDirectory() && !LINUX_NESTED_WALK_SKIP.has(name)) {
        queue.push(bytes);
      } else if (personal !== undefined && personalNames.has(name)) {
        const path = bytes.toString('utf8');
        if (!Buffer.from(path, 'utf8').equals(bytes)) continue;
        if (personal.length >= LINUX_NESTED_HOST_ONLY_MAX) tooMany = true;
        else personal.push(path);
      }
    }
  };
  await new Promise<void>((done) => {
    let active = 0;
    const pump = (): void => {
      while (!tooMany && active < Math.max(1, concurrency) && queue.length > 0) {
        active++;
        void visit(queue.pop() as Buffer).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && (tooMany || queue.length === 0)) done();
    };
    pump();
  });
  return { deny: deny.sort(), unprotected: unprotected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), tooMany };
}

/** The existing protected entries below the top of `root` the guard records (guard.ts GuardWalk; review GR-1). */
export async function guardWalk(root: string): Promise<GuardWalk> {
  const personal: string[] = [];
  const walked = await walkNestedHostOnly(root, undefined, personal);
  return { found: guardedEntries(walked, personal), complete: !walked.tooMany };
}

/** What a wrap() records for the guard: denied entries, the unprotected ones a path names, the personal files. */
function guardedEntries(nested: NestedHostOnly, personal: readonly string[]): string[] {
  return [...nested.deny, ...nested.unprotected.filter((entry) => entry.reason !== 'not-utf8').map((entry) => entry.path), ...personal];
}

/**
 * srt's own test for a mount point an earlier sandbox left behind (linux-sandbox-utils.js isStaleBwrapMountPoint;
 * also worktree/stage-commit.ts sandboxMountPoints): bubblewrap makes it with ensure_file(dest, 0444) — an empty
 * regular file with no write bit and one link. Files made on purpose carry write bits, content or more links.
 */
function isStaleMountPointFile(st: Stats): boolean {
  return st.isFile() && st.size === 0 && (st.mode & 0o222) === 0 && st.nlink === 1;
}

/** The names of `names` that do not exist in `dir` (lstat: a dangling symlink exists). */
async function absentNames(dir: string, names: readonly string[]): Promise<string[]> {
  const found = await Promise.all(names.map((name) => lstat(join(dir, name)).then(() => true, (err: NodeJS.ErrnoException) => err.code !== 'ENOENT')));
  return names.filter((_name, i) => !found[i]);
}

/**
 * Linux: the empty directories the service makes in a session root for the absent host-only DIRECTORY names
 * (holdPlaceholderDirs), and the absent host-only FILE names at the top of the root, where bubblewrap leaves srt's
 * mount point (an empty 0444 file) while a guest process runs; recorded in the workspace state before either can exist.
 * The service removes its directories once no wrap() is in flight and no WrappedCommand it handed out is unreleased
 * (srt removes its files once its count of running wraps is zero), and then empties the record. A daemon that died
 * first (SIGKILL, OOM, power loss) leaves them in the host's project: an empty `.git/` would make the next start take
 * a non-repository for a git repository, and an empty `.mcp.json` / `.envrc` trips up the host's own Claude Code and
 * direnv. The next daemon removes, before its first sandbox, the recorded directories that are still empty and the
 * recorded files that still look exactly like srt's leftovers (isStaleMountPointFile; srt itself would only take them
 * at the next guest sandbox in that root). None of the dead daemon's sandboxes survives it (bubblewrap runs with
 * --die-with-parent), and nothing is removed while a sandbox of this daemon runs (removing a mount point under a
 * running sandbox detaches its mount and lifts the deny).
 */
/**
 * How long a change of a placeholder or of srt's mount point, announced by this service, is attributed to the system
 * (FileService.expectChange; announceOwn): from the wrap() that makes them to the canary's mount points being reported.
 */
const OWN_CHANGE_TTL_MS = 10_000;

const PLACEHOLDER_DOCUMENT = 'sandbox-placeholders';
/** The most recent entries kept (at most seven names per root: the share and each worktree). */
const PLACEHOLDER_RECORD_MAX = 1000;
const placeholderDocumentSchema = z.strictObject({ paths: z.array(z.string().min(1).max(4096)).max(PLACEHOLDER_RECORD_MAX) });
type PlaceholderDocument = z.output<typeof placeholderDocumentSchema>;

/** The nearest ancestor directory holding pnpm-workspace.yaml (dev: smurg runs from its source checkout). */
async function findWorkspaceRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    if ((await realpathOrNull(join(dir, 'pnpm-workspace.yaml'))) !== null) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class SandboxServiceImpl implements SandboxService {
  private readonly ctx: DaemonContext;
  private readonly platformName: NodeJS.Platform;
  private readonly loadApi: () => Promise<SrtApi>;
  private readonly runtime: SrtRuntime;
  private readonly runner: PtyRunner;
  private readonly io: CheckIo;
  private readonly sandboxExecPath: string;
  private readonly linuxToolDirs: readonly string[];
  private readonly selfTestTimeoutMs: number;
  private readonly shell: string;
  private readonly tmpDir: () => string;
  private readonly linuxTaskLimit: number;
  private readonly kernelRelease: () => string;
  /** Linux: the host was told once that its kernel gets no task limit (taskLimitPrefix). */
  private taskLimitSkipLogged = false;
  /** This service's identity as the srt runtime's owner. */
  private readonly owner = Object.freeze({ kind: 'smurg-sandbox-owner' });
  private api: SrtApi | null = null;
  private allowedDomains: readonly string[] | null = null;
  private ready: Ready | null = null;
  private disposed = false;
  /** The bwrap whose options checkBwrapFeatures accepted (asked once per binary). */
  private bwrapChecked: string | null = null;
  /** WrappedCommands handed out and not yet released (release()). */
  private readonly issued = new WeakSet<WrappedCommand>();
  /** Linux: the placeholder record (PLACEHOLDER_DOCUMENT), opened on first use. */
  private placeholders: Promise<PersistentDocument<PlaceholderDocument>> | null = null;
  /** The same document once it is open (dropOwnPlaceholders updates it synchronously). */
  private placeholderRecord: PersistentDocument<PlaceholderDocument> | null = null;
  /** Linux: the sweep of a previous daemon's placeholders, run once before this service's first sandbox. */
  private placeholderSweep: Promise<void> | null = null;
  /** Linux: the sweep has finished (from then on the record holds only this service's own placeholders). */
  private placeholderSweepDone = false;
  /**
   * wrap() calls in flight plus WrappedCommands handed out and not yet released (review RCR-1). While it is above
   * zero the service's own placeholder directories stay: a wrap() in flight chose its policy while they existed, and a
   * sandbox that runs has them mounted.
   */
  private live = 0;
  /**
   * Linux: the empty host-only directories this service made (path → the directory's dev / ino, and a descriptor that
   * holds its inode until it is removed: ext4 hands a freed inode number straight back, so without it a host's own
   * directory made at that name in its place could carry the same dev / ino; review RV-3), holdPlaceholderDirs.
   */
  private readonly ownPlaceholders = new Map<string, { readonly dev: bigint; readonly ino: bigint; readonly fd: number | null }>();
  /**
   * Linux: the top-level `.mcp.json` / `.envrc` paths that were absent when a wrap() made its placeholders while
   * something of this service ran (srt tracks them as its mount points; srtCleanup keeps the host's own file there).
   * Emptied with the placeholders.
   */
  private readonly placeholderFiles = new Set<string>();
  /** Linux: the share's `.git/info/exclude` carries this service's placeholder lines (review GR-4; git-exclude.ts). */
  private excludeWritten = false;
  /** Linux: the writes of those lines, one at a time. */
  private excludeChain: Promise<unknown> = Promise.resolve();
  /** Linux: what a running guest's mounts cannot follow (reviews RV-1, RV-2; guard.ts). */
  private readonly guard: ProtectedEntryGuard;
  /** Linux: nested host-only entries already named in the log as not deniable (warnUnprotected). */
  private readonly warnedUnprotected = new Set<string>();
  /** Linux: warnUnprotected's memory is full and the log said so (review GR-9). */
  private warnedUnprotectedFull = false;
  /** The outcome of the last preflight() (lastPreflight: `smurg status`). */
  private lastCheck: SandboxPreflight | null = null;

  constructor(ctx: DaemonContext, options: SandboxServiceOptions = {}) {
    this.ctx = ctx;
    this.platformName = options.platform ?? process.platform;
    this.loadApi = options.loadSrt ?? loadSrt;
    this.runtime = options.runtime ?? processSrtRuntime;
    this.runner = options.runner ?? createNodePtyRunner();
    this.io = options.io ?? nodeCheckIo;
    this.sandboxExecPath = options.sandboxExecPath ?? DARWIN_SANDBOX_EXEC;
    this.linuxToolDirs = options.linuxToolDirs ?? LINUX_TOOL_DIRS;
    this.selfTestTimeoutMs = options.selfTestTimeoutMs ?? 30_000;
    this.shell = options.shell ?? '/bin/bash';
    this.tmpDir = options.tmpDir ?? tmpdir;
    const taskLimit = options.linuxTaskLimit ?? LINUX_GUEST_TASK_LIMIT;
    if (!Number.isSafeInteger(taskLimit) || taskLimit < 1) throw new RangeError('linuxTaskLimit must be a positive integer');
    this.linuxTaskLimit = taskLimit;
    this.kernelRelease = options.kernelRelease ?? osRelease;
    this.guard = new ProtectedEntryGuard({
      log: ctx.log,
      onBreach: (breach) => this.reportBreach(breach),
      walk: guardWalk,
      ...(options.guardPollMs === undefined ? {} : { pollMs: options.guardPollMs }),
      ...(options.guardWalkMs === undefined ? {} : { walkMs: options.guardWalkMs }),
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // SandboxService
  // ------------------------------------------------------------------------------------------------------------------

  async preflight(): Promise<SandboxPreflight> {
    let result: SandboxPreflight;
    try {
      const ready = await this.ensureReady();
      // The synthetic root below says nothing about where the daemon runs: a working directory inside the share would
      // refuse every guest session, so the host is told now (linux-binary F1).
      await this.checkDaemonCwd(ready, [this.ctx.roots.main.realPath]);
      await this.syntheticSelfTest(ready);
      result = { ok: true, platform: ready.platform };
    } catch (err) {
      const refusal = this.toRefusal(err);
      this.ctx.log.warn('guest sandbox preflight failed', { reason: refusal.reason, why: refusal.internal });
      result = { ok: false, reason: refusal.reason, detail: refusal.message };
    }
    this.lastCheck = result;
    return result;
  }

  lastPreflight(): SandboxPreflight | null {
    return this.lastCheck;
  }

  async wrap(spec: SandboxSpec): Promise<WrappedCommand> {
    // Counted from before the spec is resolved (review RCR-1): the placeholder directories this wrap's policy relies on
    // stay until it failed or what it hands out is released.
    this.live++;
    let handedOut = false;
    try {
      const wrapped = await this.wrapCounted(spec);
      handedOut = true;
      return wrapped;
    } finally {
      if (!handedOut) this.unhold();
    }
  }

  private async wrapCounted(spec: SandboxSpec): Promise<WrappedCommand> {
    /** Linux: the guard's record this wrap entered, until it is handed out or the wrap fails. */
    let ticket: GuardTicket | null = null;
    try {
      const ready = await this.ensureReady();
      const resolved = await this.resolveSpec(spec, ready);
      ticket = resolved.ticket;
      const policy = buildSessionPolicy(resolved.input);
      if (policy.dropped.length > 0) this.ctx.log.debug('redundant sandbox write denies dropped', { count: policy.dropped.length });
      await this.checkDaemonCwd(ready, policy.writeRoots);
      const loopbackListen = resolved.input.mode === 'login';
      // The canary runs system tools (cat, ls, stty): it gets the login's network rules but not its exec allow-list.
      await this.selfTest(ready, policy, resolved.input.rootPath, resolved.input.guestDir, undefined, loopbackListen);
      // An agent session (it carries the hook's session token): the real hook must work inside this very policy.
      if (typeof spec.env[HOOK_ENV.token] === 'string') await this.hookSelfTest(ready, policy, resolved, spec);
      // srt forces TMPDIR=/tmp/claude (shared by every guest); Claude Code 2.1.283 also puts its own files under
      // `${CLAUDE_CODE_TMPDIR:-/tmp}/claude-<uid>`, which is the HOST user's own Claude temp dir and stays denied.
      // Both point into the guest's private dir instead (verified on 2.1.220 and 2.1.283, test/sandbox).
      const tmp = shellQuote(resolved.tmpDir);
      const inner = `${this.taskLimitPrefix(ready)}export TMPDIR=${tmp} CLAUDE_CODE_TMPDIR=${tmp}; ${spec.command}`;
      const command = await this.wrapHardened(ready, inner, policy, loopbackListen, resolved.execAllow);
      const wrapped: WrappedCommand = Object.freeze({ file: this.shell, args: Object.freeze(['-c', command]), env: Object.freeze({ ...spec.env }), cwd: resolved.input.rootPath });
      if (ticket !== null) {
        const entered = ticket;
        ticket = null;
        // issue() makes srt's mount points for the names that were absent (guard.ts placeMountPoints).
        this.announceOwn(HOST_ONLY_FILE_NAMES.map((name) => join(resolved.input.rootPath, name)).filter((path) => this.placeholderFiles.has(path)));
        if (!this.guard.issue(entered, wrapped)) {
          // srt counted the command; nothing will run it.
          this.srtCleanup(await this.srt());
          // The daemon is stopping (dispose() let the guard go first; review GR-10): not a change of anything.
          if (this.disposed || this.ctx.stopping.aborted || this.guard.isDisposed()) throw new SandboxRefusal('wrap-failed', 'the daemon is stopping');
          // A protected entry of the root changed after this wrap chose its policy (reviews RV-1, RV-2): what srt was
          // told may not be what is there now.
          throw new SandboxRefusal('protected-changed', 'a protected entry of the session root changed while the sandbox was being prepared');
        }
      }
      this.issued.add(wrapped);
      return wrapped;
    } catch (err) {
      if (ticket !== null) this.guard.leave(ticket);
      const refusal = this.toRefusal(err);
      const target = typeof spec?.sessionId === 'string' && spec.sessionId.length > 0 ? spec.sessionId.slice(0, 200) : 'unknown';
      this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'sandbox.refused', outcome: 'denied', target, detail: { reason: refusal.reason, platform: this.platformName } });
      this.ctx.log.warn('guest sandbox refused', { reason: refusal.reason, why: refusal.internal, session: target });
      throw new SmurgError('sandbox_unavailable', refusal.message, { reason: refusal.reason });
    }
  }

  /**
   * Linux: the sandboxed shell's first step, at most linuxTaskLimit tasks in this sandbox (LINUX_GUEST_TASK_LIMIT; set
   * inside the guest's user namespace, so it counts this sandbox only). It fails only when the hard limit is already
   * lower, which then stays. Nothing on macOS (Seatbelt has no resource control, and macOS counts processes per user
   * with no namespace), nor on a kernel that would count the host user's tasks too (logged once).
   */
  private taskLimitPrefix(ready: Ready): string {
    if (ready.platform !== 'linux') return '';
    const release = this.kernelRelease();
    if (linuxCountsTasksPerUserNamespace(release)) return `ulimit -u ${this.linuxTaskLimit} 2>/dev/null; `;
    if (!this.taskLimitSkipLogged) {
      this.taskLimitSkipLogged = true;
      this.ctx.log.warn('guest sandboxes get no task limit: this kernel counts tasks per user, not per sandbox (Linux 5.14 or later needed)', { kernel: release.slice(0, 80) });
    }
    return '';
  }

  /**
   * The process of a WrappedCommand this service handed out has exited, or was never started. srt counts every wrap:
   * on Linux the mount-point files bubblewrap left on the host for absent write-denied names (`<share>/.mcp.json`,
   * `.envrc`) are removed when the count is back to zero, and this service's own placeholder directories
   * (`<share>/.claude/`, holdPlaceholderDirs) when nothing of it runs or is being wrapped; never earlier (deleting one
   * under a running sandbox would detach its mount and lift the deny). Idempotent; an unknown object is ignored.
   */
  release(wrapped: WrappedCommand): void {
    if (!this.issued.delete(wrapped)) return;
    // Before srt's cleanup and the placeholders' removal: the guard's last look sees them as the process left them.
    this.guard.release(wrapped);
    if (this.api !== null) this.srtCleanup(this.api);
    this.unhold();
  }

  /**
   * srt's cleanupAfterCommand. Once srt's count of running wraps is zero it removes every path it tracked that is an
   * EMPTY regular file, whatever its mode (linux-sandbox-utils.js cleanupBwrapMountPoints). A top-level `.mcp.json` /
   * `.envrc` that is no longer the mount point but the host's own empty file (review GR-4: a `git checkout` while a
   * guest ran put the tracked empty file there; it was deleted from the host's working tree afterwards) would go with
   * it. So such a file — empty but with a write bit or a second link, which neither bubblewrap's ensure_file nor the
   * guard ever makes — is moved aside for the call and put back at once, synchronously (nothing of the daemon runs in
   * between). Only the names this service saw absent while something of it ran (placeholderFiles).
   */
  private srtCleanup(api: SrtApi): void {
    if (this.placeholderFiles.size > 0) this.announceOwn(this.placeholderFiles);
    const aside: (readonly [string, string])[] = [];
    for (const path of this.placeholderFiles) {
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.size !== 0 || isStaleMountPointFile(st)) continue;
        const moved = `${path}.smurg-${randomBytes(6).toString('hex')}.tmp`;
        renameSync(path, moved);
        aside.push([moved, path]);
      } catch {
        // gone, or not ours to move: srt decides
      }
    }
    try {
      api.cleanupAfterCommand();
    } finally {
      for (const [moved, path] of aside) {
        try {
          renameSync(moved, path);
        } catch (err) {
          this.ctx.log.warn('could not put the host\'s file back after the sandbox cleanup', { path, aside: moved, error: (err as NodeJS.ErrnoException).code ?? 'unknown' });
        }
      }
    }
  }

  /**
   * Linux (reviews RV-1, RV-2): `listener` runs once the sandbox of `wrapped` no longer holds (a protected entry of
   * its root was replaced, removed or created while it ran; guard.ts); the caller ends the process.
   */
  onRevoked(wrapped: WrappedCommand, listener: (revocation: SandboxRevocation) => void): () => void {
    return this.guard.onRevoked(wrapped, listener);
  }

  /** The file watcher's batch for the root at `rootPath` (Linux: compared with what running guests were started with). */
  fileEvents(rootPath: string, events: readonly WatchedPathEvent[]): void {
    if (this.platformName !== 'linux') return;
    this.guard.changed(rootPath, events);
  }

  /** The file watcher reported an error for the root at `rootPath` (Linux: everything guarded there is compared now). */
  fileWatchGap(rootPath: string): void {
    if (this.platformName !== 'linux') return;
    void this.guard.rescan(rootPath);
  }

  /**
   * A protected entry changed while guest processes ran in its root (or were being started there): the log, and the
   * host's terminal through `sandbox.protected-changed` (packages/cli host.ts). The revoked processes' owners (the
   * sessions module) end them.
   */
  private reportBreach(breach: GuardBreach): void {
    const info = this.ctx.roots.list().find((root) => root.realPath === breach.root);
    const rel = breach.paths.map((path) => relative(breach.root, path) || '.');
    const shown = rel.slice(0, PROTECTED_CHANGED_SHOWN);
    const more = rel.length - shown.length + (breach.more ?? 0);
    this.ctx.log.warn(
      breach.revoked > 0
        ? 'a host-only entry changed while guest processes ran in its folder; the Linux sandbox cannot follow that, so they are ended'
        : 'a host-only entry changed while guest processes ran in its folder (the Linux sandbox cannot follow that); check it',
      { root: info?.key ?? 'unknown', paths: shown.join(', '), more, revoked: breach.revoked },
    );
    if (info === undefined) return;
    this.ctx.bus.emit('sandbox.protected-changed', { root: info.ref, paths: shown, more, revoked: breach.revoked });
  }

  /** One wrap() finished without handing anything out, or one WrappedCommand was released. */
  private unhold(): void {
    this.live--;
    if (this.live === 0) this.dropOwnPlaceholders();
  }

  /**
   * Linux, once nothing of this service runs or is being wrapped (`live` is 0): removes the empty host-only
   * directories it made (holdPlaceholderDirs) that are still the same empty directory (a host who filled one, or put
   * another in its place, keeps it), and empties the placeholder record (no placeholder of this service can exist now;
   * before the sweep ran the record is a previous daemon's, and only this service's own entries are dropped).
   * Synchronous on purpose (at most five small lstat / readdir / rmdir per root): a wrap() that starts right after must
   * find each name either still there or already gone, never vanishing under its policy.
   */
  private dropOwnPlaceholders(): void {
    this.placeholderFiles.clear();
    if (this.excludeWritten) {
      // srt's files went with its cleanup just before this (the count reached zero), the directories go below.
      this.excludeWritten = false;
      removePlaceholderExcludes(this.ctx.roots.main.realPath, this.ctx.log);
    }
    if (this.ownPlaceholders.size === 0 && !this.placeholderSweepDone) return;
    const own = [...this.ownPlaceholders];
    this.ownPlaceholders.clear();
    this.announceOwn(own.map(([path]) => path));
    for (const [path, id] of own) {
      try {
        const st = lstatSync(path, { bigint: true });
        if (st.isDirectory() && st.dev === id.dev && st.ino === id.ino && readdirSync(path).length === 0) rmdirSync(path);
      } catch {
        // gone, or not inspectable: nothing of ours to remove
      } finally {
        if (id.fd !== null) closeQuietly(id.fd);
      }
    }
    // The record is open whenever a placeholder was made (recorded first) and once the sweep ran; updated in this same
    // turn, so no wrap() can record a name between the removal and this update.
    const doc = this.placeholderRecord;
    if (doc === null || doc.get().paths.length === 0) return;
    const ownPaths = new Set(own.map(([path]) => path));
    const failed = (err: unknown): void => this.ctx.log.warn('sandbox placeholder record not saved', { error: err instanceof Error ? err.message : String(err) });
    try {
      doc.update((draft) => ({ paths: this.placeholderSweepDone ? [] : draft.paths.filter((p) => !ownPaths.has(p)) }));
      doc.flush().catch(failed);
    } catch (err) {
      failed(err); // kept: the next start's sweep checks every entry before it removes anything
    }
  }

  async setAllowedDomains(domains: readonly string[]): Promise<void> {
    const valid: string[] = [];
    for (const domain of domains) {
      if (allowedDomainSchema.safeParse(domain).success) valid.push(domain);
      else this.ctx.log.warn('invalid allow-list entry ignored', { entry: String(domain).slice(0, 80) });
    }
    this.allowedDomains = Object.freeze([...new Set(valid)]);
    if (this.ready === null || !this.runtime.isOwnedBy(this.owner)) return; // applied at the next initialize
    try {
      await this.runtime.update(this.owner, this.baseConfig(this.ready));
    } catch (err) {
      const refusal = this.toRefusal(err);
      this.ctx.log.error('guest sandbox allow-list update failed; guest network closed', { reason: refusal.reason, why: refusal.internal });
      throw new SmurgError('sandbox_unavailable', refusal.message, { reason: refusal.reason });
    }
  }

  /**
   * Daemon stop: stops srt's proxies. Idempotent. The sessions module has ended every guest process by now; the
   * placeholder record is saved, empty once nothing of this service runs (review RCR-5: a record kept after a clean
   * stop made the next start remove the host's own empty `.vscode` / `.claude` made in between). A placeholder still
   * held (a WrappedCommand never released) stays recorded: removing a mount point under a sandbox that might still run
   * would lift its deny, so the next start's sweep takes it.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.ready = null;
    this.guard.dispose();
    // Placeholders still held stay (recorded: the next start's sweep takes them); their descriptors go now, once.
    for (const [path, id] of this.ownPlaceholders) {
      if (id.fd === null) continue;
      closeQuietly(id.fd);
      this.ownPlaceholders.set(path, { dev: id.dev, ino: id.ino, fd: null });
    }
    await this.runtime.release(this.owner);
    try {
      await this.placeholderSweep;
      await this.placeholderRecord?.flush();
    } catch (err) {
      this.ctx.log.warn('sandbox placeholder record not saved', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Readiness
  // ------------------------------------------------------------------------------------------------------------------

  private currentDomains(): readonly string[] {
    if (this.allowedDomains === null) this.allowedDomains = Object.freeze([...this.ctx.settings.get().allowedDomains]);
    return this.allowedDomains;
  }

  private baseConfig(ready: Ready): SrtBaseConfig {
    return buildBaseConfig({
      platform: ready.platform,
      hostHome: ready.hostHome,
      stateDir: ready.stateDir,
      hookSocketPath: this.ctx.config.runPaths.hook,
      allowedDomains: this.currentDomains(),
      ...(ready.linuxTools === null ? {} : { linuxTools: ready.linuxTools }),
    });
  }

  private async ensureReady(): Promise<Ready> {
    if (this.disposed || this.ctx.stopping.aborted) throw new SandboxRefusal('wrap-failed', 'the daemon is stopping');
    const platform = supportedPlatform(this.platformName);
    if (platform === 'linux') await this.sweepPlaceholders();
    const configuredHome = this.ctx.config.sessions.hostHome;
    if (configuredHome === null) throw new SandboxRefusal('no-host-home', 'config.sessions.hostHome is null');
    const realHome = await realpathOrNull(configuredHome);
    const hostHome = realHome ?? resolve(configuredHome);
    const stateDir = await realpath(this.ctx.config.stateDir);
    const linuxTools = platform === 'darwin' ? null : await findLinuxTools(this.linuxToolDirs, this.io);
    if (platform === 'darwin') await checkDarwinLauncher(this.sandboxExecPath, this.io);
    if (linuxTools !== null && this.bwrapChecked !== linuxTools.bwrap) {
      const tooOld = await checkBwrapFeatures(linuxTools.bwrap, this.io);
      if (tooOld !== null) throw tooOld;
      this.bwrapChecked = linuxTools.bwrap;
    }
    // srt's proxy sockets go under TMPDIR; when that is too deep (test harnesses), into the daemon's run dir instead.
    let socketDir: string | undefined;
    if (srtSocketDirProblem(this.tmpDir(), process.pid) !== null) {
      const problem = srtSocketDirProblem(this.ctx.config.runDir, process.pid);
      if (problem !== null) throw new SandboxRefusal('init-failed', problem);
      socketDir = this.ctx.config.runDir;
    }
    const api = await this.srt();
    if (api.version !== null && api.version !== SRT_PINNED_VERSION) {
      throw new SandboxRefusal('hardening-failed', `srt ${api.version} is installed; the hardening is verified against ${SRT_PINNED_VERSION} only`);
    }
    if (!api.isSupportedPlatform()) throw new SandboxRefusal('unsupported-platform', 'srt does not support this platform');
    const deps = await api.checkDependenciesAsync();
    const depRefusal = srtDependencyRefusal(platform, deps.errors);
    if (depRefusal !== null) throw depRefusal;
    const prepared: Ready = { platform, hostHome, hostHomeExists: realHome !== null && (await isDirectory(realHome)), stateDir, linuxTools, proxySockets: [] };
    await this.runtime.acquire(this.owner, api, this.baseConfig(prepared), socketDir === undefined ? {} : { socketDir });
    if (!api.isSandboxingEnabled()) throw new SandboxRefusal('init-failed', 'srt reports sandboxing as not enabled after initialize');
    const ready: Ready = { ...prepared, proxySockets: platform === 'linux' ? await this.linuxProxySockets(api) : [] };
    this.ready = ready;
    return ready;
  }

  /**
   * Linux (review linux-binary F1): srt resolves its mandatory write denies against the daemon's OWN working directory
   * on every wrap (linux-sandbox-utils.js linuxGetCwdMandatoryDenyPaths: `.bashrc`, `.gitconfig`, `.gitmodules`,
   * `.profile`, `.ripgreprc`, …, `.claude/commands`, `.claude/agents`). A working directory at or below a write root (a
   * `smurg host .` typed inside the project) made bubblewrap put eight more empty 0444 files into the host's project
   * for as long as a guest process ran, and a project with a `.claude/` of its own refused every guest session ("Can't
   * create file at <share>/.claude/commands: Read-only file system", reported as a failed self-test). `smurg host`
   * therefore runs from an empty directory of its own (packages/cli host.ts, `<stateDir>/cwd`); any caller that does
   * not is refused here with a reason that says so. An ancestor of the share is harmless (srt skips denies outside the
   * write roots). macOS: srt's denies there are patterns, and bubblewrap's mount points do not exist.
   */
  private async checkDaemonCwd(ready: Ready, writeRoots: readonly string[]): Promise<void> {
    if (ready.platform !== 'linux') return;
    let cwd: string;
    try {
      cwd = await realpath(process.cwd());
    } catch (err) {
      // Not "started inside the share" (review RV-4): `smurg host` runs from <stateDir>/cwd, and this one was removed
      // while the daemon ran (or a caller's cwd is gone). A restart makes it again.
      throw new SandboxRefusal('daemon-cwd', `the daemon's working directory cannot be resolved: ${err instanceof Error ? err.message : String(err)}`, { message: DAEMON_CWD_UNRESOLVABLE_MESSAGE });
    }
    const inside = writeRoots.find((root) => cwd === root || isStrictlyUnder(cwd, root));
    if (inside !== undefined) throw new SandboxRefusal('daemon-cwd', `the daemon's working directory ${cwd} is at or inside ${inside}, where the guest sandbox writes`);
  }

  private placeholderDoc(): Promise<PersistentDocument<PlaceholderDocument>> {
    this.placeholders ??= this.ctx.state.document(PLACEHOLDER_DOCUMENT, placeholderDocumentSchema, () => ({ paths: [] })).then((doc) => {
      this.placeholderRecord = doc;
      return doc;
    });
    return this.placeholders;
  }

  /**
   * Linux, once, before this service's first sandbox: removes the recorded placeholders (PLACEHOLDER_DOCUMENT) that are
   * still EMPTY directories or files exactly like srt's leftovers (never a symlink, a directory with content or a file
   * someone wrote), then forgets the record.
   */
  private sweepPlaceholders(): Promise<void> {
    this.placeholderSweep ??= (async () => {
      // A crashed daemon's lines in .git/info/exclude (review GR-4): none of this service's placeholders exists yet.
      removePlaceholderExcludes(this.ctx.roots.main.realPath, this.ctx.log);
      const doc = await this.placeholderDoc();
      const recorded = [...doc.get().paths];
      if (recorded.length === 0) {
        this.placeholderSweepDone = true;
        return;
      }
      let removed = 0;
      for (const path of recorded) {
        try {
          const st = await lstat(path);
          if (st.isDirectory() && (await readdir(path)).length === 0) {
            this.announceOwn([path]);
            await rmdir(path);
            removed++;
          } else if (HOST_ONLY_FILE_NAMES.includes(basename(path)) && isStaleMountPointFile(st)) {
            this.announceOwn([path]);
            await unlink(path);
            removed++;
          }
        } catch {
          // gone, or not inspectable: nothing of ours to remove
        }
      }
      // Only the dead daemon's entries: a placeholder this service made meanwhile (it cannot have: the sweep runs before
      // this service's first sandbox) would stay recorded.
      doc.update((draft) => ({ paths: draft.paths.filter((path) => !recorded.includes(path) || this.ownPlaceholders.has(path)) }));
      await doc.flush();
      this.placeholderSweepDone = true;
      if (removed > 0) this.ctx.log.info('removed sandbox mount points a previous daemon left in the project', { count: removed });
    })();
    return this.placeholderSweep;
  }

  /** Linux: records `paths` (placeholders about to be made) on disk before they are made. */
  private async recordPlaceholders(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const doc = await this.placeholderDoc();
    const known = new Set(doc.get().paths);
    if (paths.every((path) => known.has(path))) return;
    doc.update((draft) => {
      const next = [...draft.paths.filter((path) => !paths.includes(path)), ...paths];
      return { paths: next.slice(-PLACEHOLDER_RECORD_MAX) };
    });
    await doc.flush();
  }

  /**
   * Linux (review RCR-1): makes every HOST_ONLY_DIR_NAME that is absent at the top of `root` exist as an empty
   * directory of this service's own, recorded first (the crash sweep), so every srt wrap of this wrap() — the canary,
   * the hook probe, the session itself — finds an existing directory and binds it read-only. bubblewrap then makes no
   * mount point for these names at all: srt would otherwise decide their form on each wrap from whether they exist at
   * that moment, and another guest's process ending in between (srt removes its mount points when its count of running
   * wraps reaches zero) turned them into empty 0444 FILES in the host's project for the whole session (`mkdir -p
   * .claude/x`: "Not a directory"; git: "invalid gitfile format"), while a name that appeared in between made bubblewrap
   * abort ("Can't create file … Read-only file system"). The directories stay while `live` is above zero
   * (dropOwnPlaceholders). A name someone else creates meanwhile is left to them.
   */
  private async holdPlaceholderDirs(root: string): Promise<void> {
    const paths = (await absentNames(root, HOST_ONLY_DIR_NAMES)).map((name) => join(root, name));
    // srt's file form stays for these (bubblewrap mounts /dev/null on them); recorded so a crash does not leave them.
    const files = (await absentNames(root, HOST_ONLY_FILE_NAMES)).map((name) => join(root, name));
    await this.recordPlaceholders([...paths, ...files]);
    for (const path of files) this.placeholderFiles.add(path);
    // The directories made below, srt's files bubblewrap makes for this wrap()'s canary: not the host's changes.
    this.announceOwn([...paths, ...files]);
    // The host's git must not take them for the host's own (review GR-4: `git add -A` committed srt's empty files,
    // `git stash -u` / `git clean -fd` removed them and ended the guests). Listed before they exist.
    if (root === this.ctx.roots.main.realPath && paths.length + files.length > 0) {
      const names = [...paths, ...files].map((path) => basename(path)).filter((name) => name !== '.git');
      const added = this.excludeChain.then(() => addPlaceholderExcludes(root, names, this.ctx.log));
      this.excludeChain = added.catch(() => false);
      if (await added) this.excludeWritten = true;
    }
    for (const path of paths) {
      try {
        await mkdir(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new PolicyError(`cannot make the empty ${basename(path)} directory the sandbox mounts read-only: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      }
      const held = await holdInode(path);
      if (held === null) continue;
      // The host removed this service's earlier one while something still ran (review GR-8): its descriptor goes now.
      const previous = this.ownPlaceholders.get(path);
      if (previous !== undefined && previous.fd !== null) closeQuietly(previous.fd);
      this.ownPlaceholders.set(path, held);
    }
  }

  /**
   * What this service makes or removes at the top of a root, or has srt and bubblewrap make or remove there (the
   * placeholder directories, srt's `.mcp.json` / `.envrc` mount points), is announced to the files module as the
   * system's doing (FileService.expectChange, OWN_CHANGE_TTL_MS), so that the watcher does not report it as an external
   * change in the activity feed and the audit log each time a guest process starts or the last one ends. The file tree
   * still shows it. A real change of the same name by the host inside that window is attributed alike (the guard sees
   * it either way, as it gets every watcher batch before any attribution).
   */
  private announceOwn(paths: Iterable<string>): void {
    const files = this.ctx.services.files;
    if (isStubService(files)) return;
    const roots = this.ctx.roots.list();
    for (const path of paths) {
      const root = roots.find((info) => info.realPath === dirname(path));
      if (root === undefined) continue;
      try {
        files.expectChange({ root: root.ref, path: basename(path) }, SYSTEM_ACTOR, OWN_CHANGE_TTL_MS);
      } catch (err) {
        this.ctx.log.debug('sandbox: own change not announced', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
      }
    }
  }

  /**
   * Linux: srt's HTTP / SOCKS bridge sockets (one file when srt's mux serves both), which the guest's network
   * namespace reaches the proxy through. They must exist: without them every guest would be offline, and a guest
   * policy without them would not say why.
   */
  private async linuxProxySockets(api: SrtApi): Promise<string[]> {
    const paths = api.linuxProxySockets();
    if (paths.length === 0) throw new SandboxRefusal('init-failed', 'srt reports no Linux network bridge socket');
    const real: string[] = [];
    for (const path of paths) {
      const resolved = await realpathOrNull(path);
      if (resolved === null) throw new SandboxRefusal('init-failed', `srt's network bridge socket is missing: ${path}`);
      if (!real.includes(resolved)) real.push(resolved);
    }
    return real;
  }

  private async srt(): Promise<SrtApi> {
    if (this.api !== null) return this.api;
    try {
      this.api = await this.loadApi();
    } catch (err) {
      throw new SandboxRefusal('init-failed', `cannot load srt: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    return this.api;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Spec → policy input (the daemon's own view decides; the spec only names things)
  // ------------------------------------------------------------------------------------------------------------------

  private async resolveSpec(spec: SandboxSpec, ready: Ready): Promise<ResolvedSpec> {
    if (typeof spec !== 'object' || spec === null) throw new PolicyError('no sandbox spec');
    if (typeof spec.command !== 'string' || spec.command.trim() === '' || spec.command.includes('\u0000')) throw new PolicyError('the command is empty or invalid');
    const envNames = this.checkEnv(spec.env);
    const share = this.ctx.roots.main.realPath;
    const worktreesDir = this.ctx.roots.worktreesDir;
    const root = await existingDir('session root', spec.rootPath);
    const guestDir = await existingDir('guest dir', spec.guestDir);
    let mode: SessionMode;
    if (isLoginSpec(spec)) {
      // The login process (D-12): its root is the guest's own home; it runs no hook and gets nothing of the share.
      if (!isStrictlyUnder(root, guestDir)) throw new SandboxRefusal('root-unknown', 'the login process must run inside its guest dir');
      if (typeof spec.env[HOOK_ENV.token] === 'string' || typeof spec.env[HOOK_ENV.socket] === 'string') throw new PolicyError('the login process carries no hook token');
      mode = 'login';
    } else if (root === share) mode = 'main';
    else if (this.ctx.roots.list().some((info) => info.ref.kind === 'worktree' && info.realPath === root)) mode = 'worktree';
    else throw new SandboxRefusal('root-unknown', 'the session root is neither the share nor a registered worktree');
    const settingsDir = await existingDir('settings dir', spec.settingsDir);
    const readOnlyPaths = await Promise.all(stringArray('readOnlyPaths', spec.readOnlyPaths).map((p) => existingPath('read-only path', p)));
    const shareGit = await realpathOrNull(join(share, '.git'));
    const extraReadPaths = (await Promise.all(stringArray('extraReadPaths', spec.extraReadPaths).map((p) => existingPath('extra read path', p))))
      // `<share>/.git` (ARCHITECTURE §7.6) is there for the shared clone's objects: the sandbox carves out exactly
      // `.git/objects` itself, so the host's .git/config (remote URLs can hold tokens), hooks and logs stay hidden.
      .filter((p) => !(mode === 'worktree' && p === shareGit));
    const extraDenyRead = await Promise.all(stringArray('denyReadPaths', spec.denyReadPaths).map((p) => denyPathForm(p)));
    const extraDenyWrite = await Promise.all(stringArray('denyWritePaths', spec.denyWritePaths).map((p) => denyPathForm(p)));
    let nestedHostOnly: readonly string[] = [];
    /** Linux: every existing protected entry below the top that the guard records (guard.ts). */
    let guarded: string[] = [];
    if (ready.platform === 'linux' && !isLoginSpec(spec)) {
      const personal: string[] = [];
      const nested = await nestedHostOnlyPaths(root, undefined, personal);
      if (nested === null) throw new PolicyError(`more than ${LINUX_NESTED_HOST_ONLY_MAX} host-only entries, or more than ${LINUX_NESTED_HOST_ONLY_MAX} CLAUDE.local.md, below the top of the session root`);
      // An entry srt cannot be given is left out and named in the log, never a reason to refuse: guests make
      // directories, and one oddly named one refused every guest session in this root (review attack F1).
      this.warnUnprotected(nested.unprotected);
      nestedHostOnly = nested.deny;
      guarded = guardedEntries(nested, personal);
    }
    const hookSocketPath = this.ctx.config.runPaths.hook;
    if (typeof spec.hookSocketPath !== 'string' || normalize(spec.hookSocketPath) !== hookSocketPath) {
      throw new PolicyError('the hook socket is not the daemon hook socket');
    }
    const gitObjects = mode === 'worktree' ? await realpathOrNull(join(share, '.git', 'objects')) : null;
    const shareGitObjectsDir = gitObjects !== null && (await isDirectory(gitObjects)) && isStrictlyUnder(gitObjects, share) ? gitObjects : null;
    const self = mode === 'login' ? { paths: [], unreachable: false } : await this.selfCommandPaths({ platform: ready.platform, mode, hostHome: ready.hostHome, stateDir: ready.stateDir, shareDir: share, worktreesDir });
    // An agent session (it carries the hook's session token) needs `smurg hook` to run inside this very sandbox.
    if (self.unreachable && typeof spec.env[HOOK_ENV.token] === 'string') {
      throw new SandboxRefusal('hook-unreachable', `the smurg hook command cannot be exposed to a ${mode}-mode guest sandbox (config.sessions.selfCommand)`);
    }
    const selfCommandPaths = self.paths;
    if (mode === 'login' && readOnlyPaths.length > 0) throw new PolicyError('the login process gets no shared dirs');
    const envTmp = spec.env['TMPDIR'];
    const tmpCandidate = typeof envTmp === 'string' && isAbsolute(envTmp) ? ((await realpathOrNull(envTmp)) ?? resolve(envTmp)) : null;
    if (ready.platform === 'linux' && mode !== 'login') await this.holdPlaceholderDirs(root);
    const tmpDir = tmpCandidate !== null && isStrictlyUnder(tmpCandidate, guestDir) ? tmpCandidate : join(guestDir, 'tmp');
    let execAllow: string[] | null = null;
    if (mode === 'login' && ready.platform === 'darwin') {
      const programs = stringArray('loginPrograms', spec.loginPrograms);
      if (programs.length === 0) throw new PolicyError('the login process needs its program list');
      execAllow = [await existingPath('the sandbox shell', this.shell), ...(await Promise.all(programs.map((p) => existingPath('login program', p))))];
      for (const program of execAllow) {
        if (isAtOrUnderAny(program, [ready.stateDir, guestDir, share])) throw new PolicyError('a login program must not live where the daemon or a guest writes');
      }
    }
    // Linux, last (nothing after it may throw): the root's protected entries as this wrap sees them, with the
    // placeholders in place and before srt expands its globs (reviews RV-1, RV-2; wrapCounted hands the ticket back).
    const ticket = ready.platform === 'linux' && mode !== 'login' ? await this.guard.enter(root, guarded) : null;
    return {
      tmpDir,
      execAllow,
      ticket,
      input: {
        platform: ready.platform,
        hostHome: ready.hostHome,
        stateDir: ready.stateDir,
        shareDir: share,
        worktreesDir,
        mode,
        rootPath: root,
        guestDir,
        settingsDir,
        readOnlyPaths,
        extraReadPaths,
        selfCommandPaths,
        shareGitObjectsDir,
        extraDenyRead,
        extraDenyWrite,
        ...(nestedHostOnly.length > 0 ? { nestedHostOnlyPaths: nestedHostOnly } : {}),
        hookSocketPath,
        envNames,
        proxySocketPaths: ready.proxySockets,
      },
    };
  }

  /**
   * Linux: names in the log, once per daemon, each existing nested host-only entry the sandbox cannot deny (srt cannot
   * be given its path, NestedHostOnly.unprotected): guests can write it like a NEW nested name (ARCHITECTURE §12), and
   * the host should know, since an entry made by the host itself (a nested repository in `app/[slug]/`) is unprotected
   * too. At most UNPROTECTED_WARN_LINES lines per wrap, then a count.
   */
  private warnUnprotected(entries: NestedHostOnly['unprotected']): void {
    const fresh = entries.filter((entry) => !this.warnedUnprotected.has(entry.path));
    if (fresh.length === 0) return;
    // Its memory full (review GR-9: fresh names were never remembered then, so every later wrap logged 21 lines):
    // said once, then no more names.
    if (this.warnedUnprotected.size >= LINUX_NESTED_HOST_ONLY_MAX) {
      if (!this.warnedUnprotectedFull) {
        this.warnedUnprotectedFull = true;
        this.ctx.log.warn('more host-only entries guests can write than this log names; no more are named until smurg restarts', { count: fresh.length });
      }
      return;
    }
    for (const entry of fresh.slice(0, UNPROTECTED_WARN_LINES)) {
      const message =
        entry.reason === 'glob-characters'
          ? 'guests can write this host-only entry: the Linux sandbox cannot deny a path with glob characters'
          : 'guests can write this host-only entry: its path is not UTF-8, which the Linux sandbox cannot name (host-private files below that directory are not hidden either)';
      this.ctx.log.warn(message, { path: entry.path, why: entry.reason });
    }
    if (fresh.length > UNPROTECTED_WARN_LINES) this.ctx.log.warn('more host-only entries guests can write (not listed)', { count: fresh.length - UNPROTECTED_WARN_LINES });
    for (const entry of fresh) if (this.warnedUnprotected.size < LINUX_NESTED_HOST_ONLY_MAX) this.warnedUnprotected.add(entry.path);
  }

  private checkEnv(env: unknown): string[] {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new PolicyError('the environment must be an object');
    const names: string[] = [];
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME.test(name) || OUTER_SHELL_ENV.has(name) || OUTER_SHELL_ENV_PREFIX.test(name)) throw new PolicyError(`environment variable ${name.slice(0, 40)} is not allowed for a guest process`);
      if (typeof value !== 'string' || value.includes('\u0000')) throw new PolicyError(`environment variable ${name} has an invalid value`);
      names.push(name);
    }
    return names;
  }

  /**
   * Read carve-outs for `smurg hook` / `smurg mcp` inside the sandbox (config.sessions.selfCommand): the executable,
   * and for a script entry (dev: `node <repo>/packages/cli/src/main.ts`) the workspace's packages and node_modules.
   * A path that cannot be a safe carve-out (inside the share in worktree mode, under the state dir, …) is not exposed,
   * and `unreachable` says so: the hook could not even start inside the sandbox. Claude Code treats a hook that cannot
   * start as a NON-blocking error and runs the edit anyway (claude-hooks.md §1.2), so an agent session is then
   * refused (review SEC-D-05): without its hook, the R8 agent lock would silently not exist.
   */
  private async selfCommandPaths(regions: CarveOutRegions): Promise<{ readonly paths: string[]; readonly unreachable: boolean }> {
    const self = this.ctx.config.sessions.selfCommand;
    if (self === null) return { paths: [], unreachable: true };
    let unreachable = false;
    const candidates: string[] = [];
    const file = await realpathOrNull(self.file);
    if (file !== null) candidates.push(file);
    else unreachable = true;
    for (const arg of self.args) {
      if (!isAbsolute(arg) || !SCRIPT_ENTRY.test(arg)) continue;
      const real = await realpathOrNull(arg);
      if (real === null) {
        unreachable = true;
        continue;
      }
      const workspace = await findWorkspaceRoot(dirname(real));
      if (workspace === null) {
        candidates.push(real);
        continue;
      }
      for (const sub of ['packages', 'node_modules', 'package.json']) {
        const p = await realpathOrNull(join(workspace, sub));
        if (p !== null) candidates.push(p);
      }
    }
    const kept: string[] = [];
    for (const candidate of [...new Set(candidates)]) {
      const problem = /[*?[\]\u0000-\u001f\u007f]/.test(candidate) ? 'unsafe characters' : readCarveOutProblem(candidate, regions, false);
      if (problem === null) kept.push(candidate);
      else {
        unreachable = true;
        this.ctx.log.warn('smurg command path not exposed to the guest sandbox', { problem });
      }
    }
    return { paths: kept, unreachable };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Wrapping and the self-test
  // ------------------------------------------------------------------------------------------------------------------

  /** `loopbackListen` and `execAllow`: the login process only (§11 D-12). */
  private async wrapHardened(ready: Ready, command: string, policy: SessionPolicy, loopbackListen = false, execAllow: readonly string[] | null = null): Promise<string> {
    const raw = await this.runtime.wrap(this.owner, command, this.shell, policy.perSession);
    try {
      const launcher = ready.platform === 'darwin' ? DARWIN_SANDBOX_EXEC : (ready.linuxTools as LinuxTools).bwrap;
      if (raw === command || !raw.includes(launcher)) throw new SandboxRefusal('launcher-missing', `the wrapped command does not run through ${launcher}`);
      if (ready.platform === 'darwin') return hardenDarwinCommand(raw, { shell: this.shell, writeRoots: policy.writeRoots, srtOwnWritePaths: SRT_OWN_WRITE_PATHS, loopbackListen, execAllow });
      return hardenLinuxCommand(raw, (ready.linuxTools as LinuxTools).bwrap, { loopbackListen, argsFileWords: await this.linuxArgsFileWords(raw), writableBinds: [...policy.writeRoots, ...ready.proxySockets] });
    } catch (err) {
      // srt counted this wrap (it does not count a command it returned unwrapped); nothing will run it.
      if (raw !== command) this.srtCleanup(await this.srt());
      throw err;
    }
  }

  /**
   * srt's arguments file (a large mount list goes there instead of onto the command line), read so the hardening sees
   * every mount. It is an unnamed file of THIS process, reached through its own /proc entry; anything else is refused.
   */
  private async linuxArgsFileWords(raw: string): Promise<string[] | null> {
    const path = linuxArgsFilePath(raw);
    if (path === null) return null;
    if (!path.startsWith(`/proc/${process.pid}/fd/`)) throw new HardeningError('the bwrap arguments file is not one of this process');
    const words = (await readFile(path, 'utf8')).split('\u0000');
    if (words.pop() !== '') throw new HardeningError('the bwrap arguments file does not end with a NUL');
    return words;
  }

  /**
   * The in-sandbox hook self-test (review SEC-D-05 follow-up): the real `smurg hook` (config.sessions.selfCommand),
   * run through exactly the session's policy and hardening on a fresh pty with the session's own environment (hook
   * socket, token), is fed a probe event with a fresh nonce and must print the daemon's answer for THIS session. It
   * fails when the hook cannot start (unreadable, not executable), cannot reach the socket, or answers anything else.
   */
  private async hookSelfTest(ready: Ready, policy: SessionPolicy, resolved: ResolvedSpec, spec: SandboxSpec): Promise<void> {
    const self = this.ctx.config.sessions.selfCommand;
    if (self === null) throw new SandboxRefusal('hook-unreachable', 'config.sessions.selfCommand is not set');
    const nonce = randomBytes(16).toString('hex');
    const probe = JSON.stringify({ hook_event_name: HOOK_PROBE_EVENT, [HOOK_PROBE_FIELD]: nonce });
    const hook = [self.file, ...self.args, 'hook'].map(shellQuote).join(' ');
    const tmp = shellQuote(resolved.tmpDir);
    // printf is a shell builtin: the only program started is the hook itself.
    const script = `export TMPDIR=${tmp} CLAUDE_CODE_TMPDIR=${tmp}; printf '%s' ${shellQuote(probe)} | ${hook}`;
    const command = await this.wrapHardened(ready, script, policy);
    let result;
    try {
      result = await this.runner.run({ file: this.shell, args: ['-c', command], cwd: resolved.input.rootPath, env: { ...spec.env }, timeoutMs: HOOK_SELF_TEST_TIMEOUT_MS });
    } catch (err) {
      throw new SandboxRefusal('hook-self-test-failed', `the hook self-test could not start: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      // The probe has exited (or never started): srt may drop its count of it (see release()).
      this.srtCleanup(await this.srt());
    }
    const expected = JSON.stringify(hookProbeAnswer(nonce, spec.sessionId));
    if (result.output.includes(expected)) return;
    const why = result.timedOut
      ? 'the hook did not finish in time'
      : result.output.trim() === ''
        ? `the hook printed nothing (exit ${result.exitCode}): it did not start, or it could not reach the hook socket`
        : `the hook answered something else (exit ${result.exitCode})`;
    throw new SandboxRefusal('hook-self-test-failed', why);
  }

  /** The canary check with `policy` (the session's own), through the same wrapping and a real pty. */
  private async selfTest(ready: Ready, policy: SessionPolicy, root: string, guestDir: string, canaryParent?: string, loopbackListen = false): Promise<void> {
    const parent = canaryParent ?? (await this.ctx.state.privateDir('sandbox-selftest'));
    const plan = await prepareSelfTest(parent);
    try {
      const script = selfTestScript(plan, { hostHome: ready.hostHomeExists ? ready.hostHome : null, root, tty: true });
      const command = await this.wrapHardened(ready, script, policy, loopbackListen);
      let result;
      try {
        result = await this.runner.run({
          file: this.shell,
          args: ['-c', command],
          cwd: root,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: guestDir, LANG: 'C', TERM: 'xterm-256color' },
          timeoutMs: this.selfTestTimeoutMs,
        });
      } catch (err) {
        throw new SandboxRefusal('self-test-failed', `the self-test could not start: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      } finally {
        // Linux: srt counts every wrap and removes bubblewrap's mount-point files once none runs (release()).
        this.srtCleanup(await this.srt());
      }
      const problem = await judgeSelfTest(plan, result);
      if (problem !== null) {
        // AppArmor is named only when it is the cause: the restriction is on AND a bare bwrap cannot create its
        // namespaces the way the restriction makes it fail. A self-test that fails for any other reason (a policy
        // that leaks) keeps its own reason, whatever the sysctl says.
        if (ready.platform === 'linux' && (await appArmorRestrictsUserns(this.io)) === true) {
          const probe = await bwrapUsernsBlocked((ready.linuxTools as LinuxTools).bwrap, this.io);
          if (probe.blocked) throw new SandboxRefusal('apparmor-userns', `self-test failed (${problem}); bwrap alone fails too (${probe.detail}) while kernel.apparmor_restrict_unprivileged_userns=1`);
        }
        const output = result.output.replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new SandboxRefusal('self-test-failed', ready.platform === 'linux' && output !== '' ? `${problem}; output: ${output}` : problem);
      }
    } finally {
      await rm(plan.canaryDir, { recursive: true, force: true });
    }
  }

  /** preflight(): a throwaway session root, guest dir and settings dir next to the canary, inside the state dir. */
  private async syntheticSelfTest(ready: Ready): Promise<void> {
    const parent = await this.ctx.state.privateDir('sandbox-selftest');
    const scratch = join(parent, `preflight-${randomBytes(12).toString('hex')}`);
    const root = join(scratch, 'root');
    const guestDir = join(scratch, 'guest');
    const settingsDir = join(scratch, 'settings');
    const canaries = join(scratch, 'canaries');
    try {
      await Promise.all([root, guestDir, settingsDir, canaries].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
      // Linux: the host-only directory names exist, as a session's placeholders do (holdPlaceholderDirs).
      if (ready.platform === 'linux') await Promise.all(HOST_ONLY_DIR_NAMES.map((name) => mkdir(join(root, name))));
      const real = await realpath(scratch);
      const policy = buildSessionPolicy({
        platform: ready.platform,
        hostHome: ready.hostHome,
        stateDir: ready.stateDir,
        shareDir: join(real, 'root'),
        worktreesDir: join(real, 'root', '.smurg', 'worktrees'),
        mode: 'main',
        rootPath: join(real, 'root'),
        guestDir: join(real, 'guest'),
        settingsDir: join(real, 'settings'),
        readOnlyPaths: [],
        extraReadPaths: [],
        selfCommandPaths: [],
        shareGitObjectsDir: null,
        extraDenyRead: [],
        extraDenyWrite: [],
        hookSocketPath: this.ctx.config.runPaths.hook,
        envNames: [],
        proxySocketPaths: ready.proxySockets,
      });
      await this.selfTest(ready, policy, join(real, 'root'), join(real, 'guest'), join(real, 'canaries'));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private toRefusal(err: unknown): SandboxRefusal {
    if (isSandboxRefusal(err)) return err;
    if (err instanceof PolicyError) return new SandboxRefusal('policy-invalid', err.message, { cause: err });
    if (err instanceof RuntimeBusyError) return new SandboxRefusal('runtime-busy', err.message, { cause: err });
    if (err instanceof RuntimeInitError) {
      // initialize() re-checks srt's dependencies with the final config (e.g. bwrapPath) and throws this text.
      if (err.message.includes('Sandbox dependencies not available')) return new SandboxRefusal('dependency-missing', err.message, { cause: err });
      return new SandboxRefusal('init-failed', err.message, { cause: err });
    }
    if (err instanceof RuntimeBrokenError) return new SandboxRefusal('config-update-failed', err.message, { cause: err });
    if (err instanceof HardeningError) return new SandboxRefusal('hardening-failed', err.message, { cause: err });
    const internal = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
    return new SandboxRefusal('wrap-failed', internal, { cause: err, message: refusalMessage('wrap-failed') });
  }
}
