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
//
// Launch inputs come from ctx.config (hostHome, stateDir, runPaths.hook, sessions.selfCommand), never from
// os.homedir() or process.env. Nothing here blocks the event loop except inside srt itself (see gotchas).
import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm, rmdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { SmurgError, allowedDomainSchema } from '@smurg/protocol';
import { z } from 'zod';
// The hook socket's wire format (a dependency-free protocol file, like the MCP server uses): the self-test must send
// exactly what the daemon's hook server answers.
import { HOOK_ENV, HOOK_PROBE_EVENT, HOOK_PROBE_FIELD, hookProbeAnswer } from '../hooks/wire.ts';
import type { DaemonContext } from '../core/context.ts';
import type { PersistentDocument, SandboxPreflight, SandboxService, SandboxSpec, WrappedCommand } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
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
import { DARWIN_SANDBOX_EXEC, HardeningError, SRT_PINNED_VERSION, hardenDarwinCommand, hardenLinuxCommand, linuxArgsFilePath, shellQuote } from './harden.ts';
import {
  HOST_ONLY_DIR_NAMES,
  HOST_ONLY_FILE_NAMES,
  PolicyError,
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
import { SandboxRefusal, isSandboxRefusal, refusalMessage } from './refusal.ts';
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
 * Linux: the host-only entries (HOST_ONLY_DIR_NAMES, HOST_ONLY_FILE_NAMES) that exist BELOW the top of `root`. srt
 * drops write-deny globs on Linux (bubblewrap binds concrete paths only: `<root>/**\/.claude` protected nothing), so
 * each existing match becomes a literal deny (a read-only bind) instead. A NEW name below the top cannot be blocked
 * with mounts at all (ARCHITECTURE §12). The walk follows no symlink, does not enter a match (denied whole) or the
 * top-level `.smurg` (denied), and skips node_modules. Null when there are more than LINUX_NESTED_HOST_ONLY_MAX.
 */
async function nestedHostOnlyPaths(root: string): Promise<string[] | null> {
  const names = new Set([...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES]);
  const found: string[] = [];
  const queue: string[] = [];
  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of top) if (entry.isDirectory() && !names.has(entry.name) && !LINUX_NESTED_WALK_SKIP.has(entry.name)) queue.push(join(root, entry.name));
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (names.has(entry.name)) {
        found.push(path);
        if (found.length > LINUX_NESTED_HOST_ONLY_MAX) return null;
      } else if (entry.isDirectory() && !LINUX_NESTED_WALK_SKIP.has(entry.name)) {
        queue.push(path);
      }
    }
  }
  return found.sort();
}

/** The names of `names` that do not exist in `dir` (lstat: a dangling symlink exists). */
async function absentNames(dir: string, names: readonly string[]): Promise<string[]> {
  const found = await Promise.all(names.map((name) => lstat(join(dir, name)).then(() => true, (err: NodeJS.ErrnoException) => err.code !== 'ENOENT')));
  return names.filter((_name, i) => !found[i]);
}

/**
 * Linux: the empty directories bubblewrap may make in a session root for the absent host-only DIRECTORY names
 * (policy.ts linuxDirPlaceholderDenies), recorded in the workspace state before a sandbox can make them. srt removes
 * them once no sandbox of this daemon runs; a daemon that died first (SIGKILL, OOM, power loss) leaves them in the
 * host's project, where srt cannot tell them from the host's own empty directories and an empty `.git/` would make
 * the next start take a non-repository for a git repository. The next daemon removes the recorded ones that are still
 * empty directories before it starts its first sandbox (none of the dead daemon's survives it: bubblewrap runs with
 * --die-with-parent), and never while a sandbox of its own runs (removing a mount point under a running sandbox
 * detaches its mount and lifts the deny).
 */
const PLACEHOLDER_DOCUMENT = 'sandbox-placeholders';
/** The most recent entries kept (five names per root: the share and each worktree). */
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
  /** Linux: the sweep of a previous daemon's placeholders, run once before this service's first sandbox. */
  private placeholderSweep: Promise<void> | null = null;

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
  }

  // ------------------------------------------------------------------------------------------------------------------
  // SandboxService
  // ------------------------------------------------------------------------------------------------------------------

  async preflight(): Promise<SandboxPreflight> {
    try {
      const ready = await this.ensureReady();
      await this.syntheticSelfTest(ready);
      return { ok: true, platform: ready.platform };
    } catch (err) {
      const refusal = this.toRefusal(err);
      this.ctx.log.warn('guest sandbox preflight failed', { reason: refusal.reason, why: refusal.internal });
      return { ok: false, reason: refusal.reason, detail: refusal.message };
    }
  }

  async wrap(spec: SandboxSpec): Promise<WrappedCommand> {
    try {
      const ready = await this.ensureReady();
      const resolved = await this.resolveSpec(spec, ready);
      const policy = buildSessionPolicy(resolved.input);
      if (policy.dropped.length > 0) this.ctx.log.debug('redundant sandbox write denies dropped', { count: policy.dropped.length });
      const loopbackListen = resolved.input.mode === 'login';
      // The canary runs system tools (cat, ls, stty): it gets the login's network rules but not its exec allow-list.
      await this.selfTest(ready, policy, resolved.input.rootPath, resolved.input.guestDir, undefined, loopbackListen);
      // An agent session (it carries the hook's session token): the real hook must work inside this very policy.
      if (typeof spec.env[HOOK_ENV.token] === 'string') await this.hookSelfTest(ready, policy, resolved, spec);
      // srt forces TMPDIR=/tmp/claude (shared by every guest); Claude Code 2.1.283 also puts its own files under
      // `${CLAUDE_CODE_TMPDIR:-/tmp}/claude-<uid>`, which is the HOST user's own Claude temp dir and stays denied.
      // Both point into the guest's private dir instead (verified on 2.1.220 and 2.1.283, test/sandbox).
      const tmp = shellQuote(resolved.tmpDir);
      const inner = `export TMPDIR=${tmp} CLAUDE_CODE_TMPDIR=${tmp}; ${spec.command}`;
      const command = await this.wrapHardened(ready, inner, policy, loopbackListen, resolved.execAllow);
      const wrapped: WrappedCommand = Object.freeze({ file: this.shell, args: Object.freeze(['-c', command]), env: Object.freeze({ ...spec.env }), cwd: resolved.input.rootPath });
      this.issued.add(wrapped);
      return wrapped;
    } catch (err) {
      const refusal = this.toRefusal(err);
      const target = typeof spec?.sessionId === 'string' && spec.sessionId.length > 0 ? spec.sessionId.slice(0, 200) : 'unknown';
      this.ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'sandbox.refused', outcome: 'denied', target, detail: { reason: refusal.reason, platform: this.platformName } });
      this.ctx.log.warn('guest sandbox refused', { reason: refusal.reason, why: refusal.internal, session: target });
      throw new SmurgError('sandbox_unavailable', refusal.message, { reason: refusal.reason });
    }
  }

  /**
   * The process of a WrappedCommand this service handed out has exited, or was never started. srt counts every wrap:
   * on Linux the mount-point files bubblewrap left on the host for absent write-denied names (`<share>/.mcp.json`, an
   * empty `<share>/.claude/`) are removed when the count is back to zero, i.e. when no sandbox of this daemon runs, and
   * never earlier (deleting one under a running sandbox would detach its mount and lift the deny). Idempotent; an
   * unknown object is ignored.
   */
  release(wrapped: WrappedCommand): void {
    if (!this.issued.delete(wrapped)) return;
    this.api?.cleanupAfterCommand();
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

  /** Daemon stop: stops srt's proxies. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.ready = null;
    await this.runtime.release(this.owner);
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

  private placeholderDoc(): Promise<PersistentDocument<PlaceholderDocument>> {
    this.placeholders ??= this.ctx.state.document(PLACEHOLDER_DOCUMENT, placeholderDocumentSchema, () => ({ paths: [] }));
    return this.placeholders;
  }

  /**
   * Linux, once, before this service's first sandbox: removes the recorded placeholders (PLACEHOLDER_DOCUMENT) that are
   * still EMPTY directories (never a symlink, a file or a directory with content), then forgets the record.
   */
  private sweepPlaceholders(): Promise<void> {
    this.placeholderSweep ??= (async () => {
      const doc = await this.placeholderDoc();
      const recorded = [...doc.get().paths];
      if (recorded.length === 0) return;
      let removed = 0;
      for (const path of recorded) {
        try {
          if ((await lstat(path)).isDirectory() && (await readdir(path)).length === 0) {
            await rmdir(path);
            removed++;
          }
        } catch {
          // gone, or not inspectable: nothing of ours to remove
        }
      }
      doc.update(() => ({ paths: [] }));
      await doc.flush();
      if (removed > 0) this.ctx.log.info('removed sandbox mount points a previous daemon left in the project', { count: removed });
    })();
    return this.placeholderSweep;
  }

  /** Linux: records `paths` (placeholders a sandbox about to start may make) on disk before it starts. */
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
    if (ready.platform === 'linux' && !isLoginSpec(spec)) {
      const nested = await nestedHostOnlyPaths(root);
      if (nested === null) throw new PolicyError(`more than ${LINUX_NESTED_HOST_ONLY_MAX} host-only entries below the top of the session root`);
      extraDenyWrite.push(...nested);
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
    const absentHostOnlyDirs = ready.platform === 'linux' && mode !== 'login' ? await absentNames(root, HOST_ONLY_DIR_NAMES) : [];
    await this.recordPlaceholders(absentHostOnlyDirs.map((name) => join(root, name)));
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
    return {
      tmpDir,
      execAllow,
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
        hookSocketPath,
        envNames,
        proxySocketPaths: ready.proxySockets,
        absentHostOnlyDirs,
      },
    };
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
      if (raw !== command) (await this.srt()).cleanupAfterCommand();
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
      (await this.srt()).cleanupAfterCommand();
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
        (await this.srt()).cleanupAfterCommand();
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
        // the fresh root has none of them: the preflight exercises the directory-form placeholders too
        absentHostOnlyDirs: ready.platform === 'linux' ? [...HOST_ONLY_DIR_NAMES] : [],
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
