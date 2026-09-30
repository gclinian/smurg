// The guest sandbox policy (ARCHITECTURE §7.6 "Sandbox", §11 D-4): a PURE translation of already-resolved paths into
// the configuration of srt (@anthropic-ai/sandbox-runtime 0.0.77). No fs, no process state: the service resolves
// realpaths, decides the mode and passes everything in, so the whole policy is unit-testable for any platform.
//
// srt's model, which every rule below is written against (verified in docs/research/sandbox.md and in the srt
// source, macos-sandbox-utils.js generateReadRules / generateWriteRules):
//  * READ: everything is readable, then `denyRead` regions, then `allowRead` carve-outs (an allow wins over a deny
//    that contains it), then every literal deny STRICTLY inside a literal allow and every glob deny again. A deny
//    EQUAL to an allow loses: validateSessionPolicy refuses that contradiction instead of letting it happen.
//  * WRITE: nothing is writable except `allowWrite` (plus srt's own stdio / /tmp/claude), then `denyWrite` wins. A
//    `denyWrite` that CONTAINS a write root denies the root itself, so such entries are dropped (writes outside the
//    roots are denied by default anyway).
//  * NETWORK / Unix sockets / pty are workspace-wide (initialize / updateConfig), filesystem and credentials are per
//    process (wrapWithSandbox customConfig).
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { HOST_PERSONAL_FILES as PROTOCOL_HOST_PERSONAL_FILES, HOST_PRIVATE_FILE_NAMES } from '@smurg/protocol';

export type SandboxPlatform = 'darwin' | 'linux';

/** Broad regions a guest may not read (besides the host home): other users, external disks, temp dirs. */
export const DARWIN_BROAD_DENY_READ: readonly string[] = Object.freeze(['/Users', '/Volumes', '/private/tmp', '/private/var/folders']);

/**
 * Linux: other users, temp dirs, removable media, and every directory that holds Unix sockets of the host session
 * (`/run`, `/var/run`: dbus, systemd --user, docker, ssh / gpg agents; `/tmp`: X11, the daemon's own run dir in
 * tests) or of a container manager the host user's GROUPS can drive (`/var/snap` holds snap LXD's
 * `lxd/common/lxd/unix.socket`, and Ubuntu puts its first user in the `lxd` group; `/var/lib/lxd`, `/var/lib/incus`:
 * the same for deb installs): the sandbox keeps the host user's supplementary groups. On Linux srt cannot allow-list
 * one socket (seccomp blocks every AF_UNIX socket or none), so `allowAllUnixSockets` is on and hiding the socket
 * directories is what keeps them unreachable; abstract sockets are cut off by the network namespace
 * (docs/research/sandbox.md, "Linux, verified"). A socket in any other directory the host user can reach stays
 * connectable: that residual is documented (ARCHITECTURE §12).
 */
export const LINUX_BROAD_DENY_READ: readonly string[] = Object.freeze(['/home', '/root', '/tmp', '/var/tmp', '/run', '/var/run', '/mnt', '/media', '/var/snap', '/var/lib/lxd', '/var/lib/incus']);

/**
 * Names the host's UNSANDBOXED tools load automatically (ARCHITECTURE §5.2, isHostOnlyPath in @smurg/protocol):
 * writable by the host only, at any depth of the session root. On APFS, Seatbelt already matches every spelling the
 * file system folds onto these names (`.VSCODE`, `.vſcode`, `.MCP.json`), verified by test/sandbox; on a
 * case-sensitive file system the byte-wise name is the only one tools load.
 */
export const HOST_ONLY_DIR_NAMES: readonly string[] = Object.freeze(['.claude', '.git', '.smurg', '.vscode', '.idea']);
export const HOST_ONLY_FILE_NAMES: readonly string[] = Object.freeze(['.mcp.json', '.envrc']);

/**
 * The host's personal Claude Code files inside the share: they can hold `env` secrets and hook commands, and a guest's
 * own Claude Code would load them as project-local settings / memory. Hidden (read-denied) at any depth, together with
 * direnv's `.envrc` (deploy keys, API tokens). The SAME lists PathGuard refuses to non-host people (isHostPrivatePath
 * in @smurg/protocol, review SEC-D-03): one definition, so the sandbox and the file API cannot drift apart.
 */
export const HOST_PERSONAL_FILES: readonly string[] = PROTOCOL_HOST_PERSONAL_FILES;
export const HOST_PRIVATE_READ_DENIED_NAMES: readonly string[] = HOST_PRIVATE_FILE_NAMES;

/** Memory files Claude Code loads from every ANCESTOR of its working directory (claude-hooks.md §5.1, M3). */
export const ANCESTOR_MEMORY_NAMES: readonly string[] = Object.freeze(['CLAUDE.md', 'CLAUDE.local.md', '.claude']);

/**
 * Private ranges an allow-listed HOSTNAME may not resolve to (srt already denies loopback, link-local, multicast and
 * cloud metadata addresses built in). An IP literal the host puts on the allow-list is the host's explicit choice.
 */
export const DENIED_PRIVATE_RANGES: readonly string[] = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7']);

/**
 * Variables that override or redirect a Claude login (claude-hooks.md §4). srt runs `env -u` on them, so they cannot
 * reach a guest even if the spawn environment were not the clean allow-list it must be. A name the session's own
 * environment sets on purpose (the guest's own `apiKey`, the test-only mock API URL) is left alone.
 */
export const LOGIN_OVERRIDE_ENV_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'SSH_AUTH_SOCK',
]);

/** srt's default TMPDIR for sandboxed processes, in both spellings (Seatbelt matches the resolved /private one). */
export const SRT_SHARED_TMP: readonly string[] = Object.freeze(['/tmp/claude', '/private/tmp/claude']);

/** Paths srt itself always makes writable (sandbox-utils.js SANDBOX_OWN_WRITE_PATHS): stdio devices and /tmp/claude. */
export const SRT_OWN_WRITE_PATHS: readonly string[] = Object.freeze([
  '/dev/stdout',
  '/dev/stderr',
  '/dev/null',
  '/dev/tty',
  '/dev/dtracehelper',
  '/dev/autofs_nowait',
  '/tmp/claude',
  '/private/tmp/claude',
]);

// ---------------------------------------------------------------------------------------------------------------------
// srt configuration shapes (the subset smurg uses; validated against srt's own zod schema before use, runtime.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface SrtNetworkConfig {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly strictAllowlist: true;
  readonly deniedResolvedAddresses: readonly string[];
  readonly allowUnixSockets: readonly string[];
  readonly allowAllUnixSockets: boolean;
  readonly allowLocalBinding: false;
}

export interface SrtFilesystemConfig {
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

export interface SrtCredentialsConfig {
  readonly envVars: readonly { readonly name: string; readonly mode: 'deny' }[];
}

/** Workspace-wide: SandboxManager.initialize() / updateConfig(). Always passed WHOLE. */
export interface SrtBaseConfig {
  readonly network: SrtNetworkConfig;
  /** Fallback for a wrap without customConfig (never used by smurg): see nothing of the home, write nothing. */
  readonly filesystem: SrtFilesystemConfig;
  readonly allowPty: true;
  readonly allowGitConfig: false;
  /** Linux: absolute tool paths, so neither srt nor the outer shell looks anything up on PATH. */
  readonly bwrapPath?: string;
  readonly socatPath?: string;
  readonly ripgrep?: { readonly command: string };
}

/** Per process: wrapWithSandbox(cmd, shell, customConfig). */
export interface SrtSessionConfig {
  readonly filesystem: SrtFilesystemConfig;
  readonly credentials: SrtCredentialsConfig;
  readonly allowPty: true;
}

export interface LinuxTools {
  readonly bwrap: string;
  readonly socat: string;
  readonly rg: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs (every path already symlink-free and absolute; the service resolves them)
// ---------------------------------------------------------------------------------------------------------------------

export interface BasePolicyInput {
  readonly platform: SandboxPlatform;
  readonly hostHome: string;
  readonly stateDir: string;
  /** The hook + MCP socket: the only Unix socket a guest may reach. */
  readonly hookSocketPath: string;
  readonly allowedDomains: readonly string[];
  /** Linux only. */
  readonly linuxTools?: LinuxTools;
}

/**
 * `login` (ARCHITECTURE §11 D-12): the Claude subscription login process of a guest. It needs nothing of the share:
 * its root is the guest's own home (inside the guest dir), the share and every worktree are denied explicitly, and it
 * writes only the guest dir. Its one extra right (loopback listen) is added by the hardening step, not here.
 */
export type SessionMode = 'main' | 'worktree' | 'login';

export interface SessionPolicyInput {
  readonly platform: SandboxPlatform;
  readonly hostHome: string;
  readonly stateDir: string;
  /** realpath of the main share. */
  readonly shareDir: string;
  /** `<share>/.smurg/worktrees` (where every worktree lives). */
  readonly worktreesDir: string;
  readonly mode: SessionMode;
  /** The share (main mode), the session's worktree (worktree mode), or the guest's home (login mode). Read + write. */
  readonly rootPath: string;
  /** The guest's private dir (HOME, CLAUDE_CONFIG_DIR, TMPDIR): read + write. Strictly inside stateDir. */
  readonly guestDir: string;
  /** Daemon-owned settings dir of the session: read only. */
  readonly settingsDir: string;
  /** Shared read-only dirs (D12), inside the share. */
  readonly readOnlyPaths: readonly string[];
  /** Other read-only carve-outs (the claude binary). */
  readonly extraReadPaths: readonly string[];
  /** Read-only carve-outs for smurg's own `hook` / `mcp` entry point (config.sessions.selfCommand). */
  readonly selfCommandPaths: readonly string[];
  /** Worktree mode: realpath of `<share>/.git/objects` (the shared clone's alternates), or null. */
  readonly shareGitObjectsDir: string | null;
  /** Extra denies from the SandboxSpec (the sessions module's view of host-only / hidden paths). */
  readonly extraDenyRead: readonly string[];
  readonly extraDenyWrite: readonly string[];
  readonly hookSocketPath: string;
  /** Names the spawn environment sets on purpose; their login-override deny is skipped. */
  readonly envNames: readonly string[];
  /**
   * Linux: srt's network bridge sockets (SandboxManager.getLinuxHttpSocketPath / getLinuxSocksSocketPath), the only
   * way out of the guest's network namespace. srt binds them in before its file system mounts, so a read-denied
   * directory holding them (`/tmp`, or the daemon's run dir) would hide them and cut the guest off from the allow-list
   * too (measured: every request failed). Read-only file carve-outs, like the hook socket. Default: none (macOS).
   */
  readonly proxySocketPaths?: readonly string[];
  /** Linux: the HOST_ONLY_DIR_NAMES missing at the top of the root when the service looked (linuxDirPlaceholderDenies). */
  readonly absentHostOnlyDirs?: readonly string[];
}

export interface SessionPolicy {
  readonly perSession: SrtSessionConfig;
  /** allowWrite, for the check that srt's profile grants writes to exactly these (plus SRT_OWN_WRITE_PATHS). */
  readonly writeRoots: readonly string[];
  /** Entries of the input that were dropped as redundant (for the log). */
  readonly dropped: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Path helpers (lexical; inputs are normalised absolute POSIX paths)
// ---------------------------------------------------------------------------------------------------------------------

/** `p` is `dir` or lies below it (by segment). */
export function isAtOrUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);
}

export function isStrictlyUnder(p: string, dir: string): boolean {
  return p !== dir && isAtOrUnder(p, dir);
}

/** Proper ancestors of an absolute path, nearest first, ending with '/'. */
export function properAncestors(p: string): string[] {
  const out: string[] = [];
  let current = p;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/**
 * Characters srt reads as glob syntax (`*`, `?`, `[`, `]`): a path containing them would be compiled into a pattern
 * that no longer matches the path, which turns a deny into nothing (fail OPEN). Control characters cannot be spelled
 * in a Seatbelt string. Both are refused.
 */
const UNSAFE_PATH = /[*?[\]\u0000-\u001f\u007f]/;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

function checkPath(label: string, p: string): string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new PolicyError(`${label} must be an absolute path`);
  if (UNSAFE_PATH.test(p)) throw new PolicyError(`${label} contains characters the sandbox cannot express (glob or control characters)`);
  const n = normalize(p);
  const trimmed = n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
  if (trimmed !== p) throw new PolicyError(`${label} is not a normalised path`);
  return p;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

interface CheckedPaths {
  readonly hostHome: string;
  readonly stateDir: string;
  readonly share: string;
  readonly worktreesDir: string;
  readonly root: string;
  readonly guestDir: string;
  readonly settingsDir: string;
  readonly extraRead: readonly string[];
  readonly extraDenyRead: readonly string[];
  readonly extraDenyWrite: readonly string[];
  readonly readOnly: readonly string[];
  readonly selfPaths: readonly string[];
  readonly proxySockets: readonly string[];
}

/**
 * The login process's policy (mode 'login', ARCHITECTURE §11 D-12): the guest dir (its home, config dir and temp dir)
 * read + write, the daemon-owned settings dir and the claude binary read-only, NOTHING of the share or any worktree
 * (denied explicitly, wherever the share lives), no hook socket and no smurg command (it runs no hook). Everything else
 * is the guests' common policy (broad deny regions, the host home and the state dir denied, login overrides unset),
 * including the ancestor memory files an agent session of the same guest may not read (those of the share, and of the
 * login's own root and working directory): the login process reads nothing an agent session cannot.
 */
function buildLoginPolicy(input: SessionPolicyInput, p: CheckedPaths): SessionPolicy {
  if (!isStrictlyUnder(p.root, p.guestDir)) throw new PolicyError('the login process must run in the guest dir');
  if (p.readOnly.length > 0 || p.selfPaths.length > 0 || input.shareGitObjectsDir !== null) throw new PolicyError('the login process gets no share paths and no smurg command');
  if (!isStrictlyUnder(p.worktreesDir, p.share)) throw new PolicyError('the worktrees dir must be inside the share');
  if (!isStrictlyUnder(p.guestDir, p.stateDir)) throw new PolicyError('the guest dir must be inside the daemon state dir (other guests are hidden with it)');
  if (!isStrictlyUnder(p.settingsDir, p.stateDir)) throw new PolicyError('the session settings dir must be inside the daemon state dir');
  if (isAtOrUnder(p.settingsDir, p.guestDir)) throw new PolicyError('the session settings dir must not be writable by the guest');
  if (isAtOrUnder(p.guestDir, p.share) || isAtOrUnder(p.share, p.guestDir)) throw new PolicyError('the guest dir and the share must not overlap');
  const denyRead = unique([
    ...broadDenyRead(input.platform),
    p.hostHome,
    p.stateDir,
    p.share,
    p.worktreesDir,
    ...ancestorMemoryDenies(p.share),
    ...ancestorMemoryDenies(p.root),
    ...ancestorMemoryDenies(p.settingsDir),
    ...p.extraDenyRead,
  ]);
  const allowRead = unique([p.guestDir, p.settingsDir, ...p.proxySockets, ...p.extraRead]);
  const allowSet = new Set(allowRead);
  for (const deny of denyRead) {
    if (allowSet.has(deny)) throw new PolicyError('a path is both denied and allowed for reading');
  }
  const regions = { platform: input.platform, mode: 'login' as const, hostHome: p.hostHome, stateDir: p.stateDir, shareDir: p.share, worktreesDir: p.worktreesDir };
  const structural = new Set([p.guestDir, p.settingsDir, ...p.proxySockets]);
  for (const allow of allowRead) {
    const problem = readCarveOutProblem(allow, regions, structural.has(allow));
    if (problem !== null) throw new PolicyError(problem);
  }
  const writeRoots = [p.guestDir];
  const dropped: string[] = [];
  const denyWrite: string[] = [];
  for (const deny of unique([p.settingsDir, p.share, ...(input.platform === 'darwin' ? SRT_SHARED_TMP : []), ...p.extraDenyWrite])) {
    if (writeRoots.includes(deny)) throw new PolicyError('a write root is also denied for writing');
    if (writeRoots.some((w) => isStrictlyUnder(w, deny))) {
      dropped.push(deny);
      continue;
    }
    denyWrite.push(deny);
  }
  const envNames = new Set(input.envNames);
  return {
    perSession: {
      filesystem: { denyRead, allowRead, allowWrite: writeRoots, denyWrite },
      credentials: { envVars: LOGIN_OVERRIDE_ENV_VARS.filter((name) => !envNames.has(name)).map((name) => ({ name, mode: 'deny' as const })) },
      allowPty: true,
    },
    writeRoots,
    dropped,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------------

export function broadDenyRead(platform: SandboxPlatform): readonly string[] {
  return platform === 'darwin' ? DARWIN_BROAD_DENY_READ : LINUX_BROAD_DENY_READ;
}

/** The workspace-wide configuration: initialize() once, updateConfig() with the WHOLE object on every change. */
export function buildBaseConfig(input: BasePolicyInput): SrtBaseConfig {
  checkPath('hostHome', input.hostHome);
  checkPath('stateDir', input.stateDir);
  checkPath('hook socket', input.hookSocketPath);
  if (input.platform === 'linux' && input.linuxTools === undefined) throw new PolicyError('Linux needs the resolved bwrap / socat / rg paths');
  const linux = input.platform === 'linux' && input.linuxTools !== undefined ? input.linuxTools : null;
  if (linux !== null) for (const [name, path] of Object.entries(linux)) checkPath(name, path);
  return {
    network: {
      allowedDomains: unique(input.allowedDomains),
      deniedDomains: [],
      strictAllowlist: true,
      deniedResolvedAddresses: [...DENIED_PRIVATE_RANGES],
      // macOS: exactly one socket (compiled to a `subpath` of the socket FILE). Linux ignores the list (see
      // LINUX_BROAD_DENY_READ): allowAllUnixSockets plus hidden socket directories.
      allowUnixSockets: [input.hookSocketPath],
      allowAllUnixSockets: input.platform === 'linux',
      allowLocalBinding: false,
    },
    filesystem: { denyRead: unique([...broadDenyRead(input.platform), input.hostHome, input.stateDir]), allowRead: [], allowWrite: [], denyWrite: [] },
    allowPty: true,
    allowGitConfig: false,
    ...(linux !== null ? { bwrapPath: linux.bwrap, socatPath: linux.socat, ripgrep: { command: linux.rg } } : {}),
  };
}

export interface CarveOutRegions {
  readonly platform: SandboxPlatform;
  readonly mode: SessionMode;
  readonly hostHome: string;
  readonly stateDir: string;
  readonly shareDir: string;
  readonly worktreesDir: string;
}

/**
 * Why `allow` may not be a read carve-out, or null. Regions that must stay unreadable whatever else is allowed: an
 * allow EQUAL to one would open it, and an allow that CONTAINS one would re-deny the carve-outs inside it (srt re-emits
 * nested denies after the allows), so both are refused. In worktree mode nothing of the share is readable except the
 * structural carve-outs (the worktree itself, the shared dirs, `.git/objects`), which the caller marks `structural`.
 */
export function readCarveOutProblem(allow: string, regions: CarveOutRegions, structural: boolean): string | null {
  if (allow === '/') return 'the file system root cannot be allowed for reading';
  const guarded = [
    regions.hostHome,
    regions.stateDir,
    ...broadDenyRead(regions.platform),
    ...(regions.mode !== 'main' ? [regions.shareDir, regions.worktreesDir] : []),
  ];
  if (guarded.some((region) => isAtOrUnder(region, allow))) return 'a read carve-out would contain a region guests may not read';
  if (regions.mode === 'worktree' && !structural && isAtOrUnder(allow, regions.shareDir)) {
    return 'in worktree mode only the worktree, the shared dirs and .git/objects of the share are readable';
  }
  if (regions.mode === 'login' && isAtOrUnder(allow, regions.shareDir)) return 'the login process may read nothing of the share';
  if (!structural && isAtOrUnder(allow, regions.stateDir)) return 'the daemon state dir is not readable by guests';
  return null;
}

/** `<root>/**\/<name>` for every host-only name, plus the literal root-level paths (Linux expands globs to existing paths only). */
export function hostOnlyWriteDenies(root: string): string[] {
  const names = [...HOST_ONLY_DIR_NAMES, ...HOST_ONLY_FILE_NAMES];
  return [...names.map((name) => join(root, name)), ...names.map((name) => `${root}/**/${name}`)];
}

/**
 * Linux: a child name that never exists, below each host-only DIRECTORY name at the top of the root. bubblewrap can
 * only block an ABSENT write-denied name by mounting something on it, and the mount point it creates for that is left
 * in the host's share (srt removes it once no sandbox runs, SandboxService.release). For a leaf deny srt mounts
 * /dev/null, i.e. an empty 0444 FILE `.claude` / `.git` / `.vscode` appears in the host's project and the host's own
 * tools break on it (`mkdir .claude` EEXIST, git "invalid gitfile format"). For an absent INTERMEDIATE component srt
 * mounts an empty read-only directory instead (linux-sandbox-utils.js "Fix 2"), which the host sees as an ordinary
 * empty directory it can use (git ignores an empty `.git/`): denying this child makes srt choose that form. When the
 * name exists, the child is inside a read-only deny and srt makes no mount point for it.
 */
export const LINUX_DIR_PLACEHOLDER_CHILD = '.smurg-no-such-entry';

/**
 * The child denies for the host-only directory names `absent` (names the service found missing at the top of the
 * root). Only for absent ones: under an existing name (bound read-only) srt would still put a mount point for the
 * child there whenever the root lies below a read-deny tmpfs (as it does under /home), and bubblewrap cannot create it
 * in a read-only mount ("Can't create file … Read-only file system": measured, the sandbox did not start).
 */
export function linuxDirPlaceholderDenies(root: string, absent: readonly string[]): string[] {
  return HOST_ONLY_DIR_NAMES.filter((name) => absent.includes(name)).map((name) => join(root, name, LINUX_DIR_PLACEHOLDER_CHILD));
}

/** Host-personal files (and `.envrc`) hidden at any depth of the root. */
export function hostPersonalReadDenies(root: string): string[] {
  return [...HOST_PERSONAL_FILES, ...HOST_PRIVATE_READ_DENIED_NAMES].flatMap((rel) => [join(root, rel), `${root}/**/${rel}`]);
}

/** `<ancestor>/CLAUDE.md`, `CLAUDE.local.md` and `.claude` for every proper ancestor of the root. */
export function ancestorMemoryDenies(root: string): string[] {
  return properAncestors(root).flatMap((ancestor) => ANCESTOR_MEMORY_NAMES.map((name) => join(ancestor, name)));
}

/**
 * The per-process policy of one guest process. Throws PolicyError when the inputs contradict each other or cannot be
 * expressed safely; never "fixes" a deny away (only drops write denies that are redundant by construction).
 */
export function buildSessionPolicy(input: SessionPolicyInput): SessionPolicy {
  const { platform, mode } = input;
  const hostHome = checkPath('hostHome', input.hostHome);
  const stateDir = checkPath('stateDir', input.stateDir);
  const share = checkPath('share', input.shareDir);
  const worktreesDir = checkPath('worktrees dir', input.worktreesDir);
  const root = checkPath('session root', input.rootPath);
  const guestDir = checkPath('guest dir', input.guestDir);
  const settingsDir = checkPath('settings dir', input.settingsDir);
  const hookSocket = checkPath('hook socket', input.hookSocketPath);
  const readOnly = input.readOnlyPaths.map((p) => checkPath('read-only path', p));
  const extraRead = input.extraReadPaths.map((p) => checkPath('extra read path', p));
  const selfPaths = input.selfCommandPaths.map((p) => checkPath('smurg command path', p));
  const extraDenyRead = input.extraDenyRead.map((p) => checkPath('deny-read path', p));
  const extraDenyWrite = input.extraDenyWrite.map((p) => checkPath('deny-write path', p));
  const gitObjects = input.shareGitObjectsDir === null ? null : checkPath('share git objects', input.shareGitObjectsDir);
  const proxySockets = (input.proxySocketPaths ?? []).map((p) => checkPath('proxy socket', p));
  if (platform !== 'linux' && proxySockets.length > 0) throw new PolicyError('proxy socket carve-outs are for Linux only');

  // ---- layout rules (ARCHITECTURE §7.1, §7.6) ----
  if (mode === 'login') return buildLoginPolicy(input, { hostHome, stateDir, share, worktreesDir, root, guestDir, settingsDir, extraRead, extraDenyRead, extraDenyWrite, readOnly, selfPaths, proxySockets });
  if (mode === 'main' && root !== share) throw new PolicyError('main-workspace mode must run in the share');
  if (mode === 'worktree' && !isStrictlyUnder(root, worktreesDir)) throw new PolicyError('worktree mode must run in a worktree below .smurg/worktrees');
  if (!isStrictlyUnder(worktreesDir, share)) throw new PolicyError('the worktrees dir must be inside the share');
  if (!isStrictlyUnder(guestDir, stateDir)) throw new PolicyError('the guest dir must be inside the daemon state dir (other guests are hidden with it)');
  if (!isStrictlyUnder(settingsDir, stateDir)) throw new PolicyError('the session settings dir must be inside the daemon state dir');
  if (isAtOrUnder(settingsDir, guestDir) || isAtOrUnder(settingsDir, root)) throw new PolicyError('the session settings dir must not be writable by the guest');
  if (isAtOrUnder(root, stateDir) && mode === 'worktree') throw new PolicyError('a worktree must not be inside the daemon state dir');
  if (root === hostHome || isStrictlyUnder(hostHome, root)) throw new PolicyError('the session root must not contain the host home');
  if (isAtOrUnder(stateDir, root) || isAtOrUnder(guestDir, root)) throw new PolicyError('the session root must not contain the daemon state dir');
  for (const p of readOnly) {
    if (!isStrictlyUnder(p, share)) throw new PolicyError('a shared read-only dir must be inside the share');
    if (mode === 'worktree' && isAtOrUnder(p, worktreesDir)) throw new PolicyError('a shared read-only dir must not be a worktree');
  }

  // ---- read ----
  const hiddenInShare = mode === 'main' ? [join(share, '.smurg')] : [share, worktreesDir];
  const denyRead = unique([
    ...broadDenyRead(platform),
    hostHome,
    stateDir,
    ...hiddenInShare,
    ...ancestorMemoryDenies(root),
    ...hostPersonalReadDenies(root),
    ...extraDenyRead,
  ]);
  const allowRead = unique([
    root,
    guestDir,
    settingsDir,
    hookSocket,
    ...proxySockets,
    ...readOnly,
    ...extraRead,
    ...selfPaths,
    ...(mode === 'worktree' && gitObjects !== null ? [gitObjects] : []),
  ]);

  // An allow EQUAL to a deny wins in srt: that would silently void the deny. Refuse the contradiction.
  const allowSet = new Set(allowRead);
  for (const deny of denyRead) {
    if (allowSet.has(deny)) throw new PolicyError('a path is both denied and allowed for reading');
  }
  const regions = { platform, mode, hostHome, stateDir, shareDir: share, worktreesDir };
  const structural = new Set([root, guestDir, settingsDir, hookSocket, ...proxySockets, ...readOnly, ...(gitObjects === null ? [] : [gitObjects])]);
  for (const allow of allowRead) {
    const problem = readCarveOutProblem(allow, regions, structural.has(allow));
    if (problem !== null) throw new PolicyError(problem);
  }

  // ---- write ----
  const writeRoots = unique([root, guestDir]);
  const dropped: string[] = [];
  const denyWrite: string[] = [];
  const candidates = unique([
    ...hostOnlyWriteDenies(root),
    ...(platform === 'linux' ? linuxDirPlaceholderDenies(root, input.absentHostOnlyDirs ?? []) : []),
    ...readOnly,
    settingsDir,
    ...(mode === 'main' ? [join(share, '.smurg')] : []),
    // srt always makes /tmp/claude writable: one scratch dir shared by every guest. Guests never need it (TMPDIR and
    // CLAUDE_CODE_TMPDIR point into their own dir), so it is closed on macOS. Not on Linux, where denying a path that
    // does not exist makes bubblewrap create a placeholder file on the host.
    ...(platform === 'darwin' ? SRT_SHARED_TMP : []),
    ...extraDenyWrite,
  ]);
  for (const deny of candidates) {
    if (writeRoots.includes(deny)) throw new PolicyError('a write root is also denied for writing');
    // A deny that contains a write root would make the root read-only; outside the roots nothing is writable anyway.
    if (writeRoots.some((w) => isStrictlyUnder(w, deny))) {
      dropped.push(deny);
      continue;
    }
    denyWrite.push(deny);
  }

  const envNames = new Set(input.envNames);
  return {
    perSession: {
      filesystem: { denyRead, allowRead, allowWrite: writeRoots, denyWrite },
      credentials: { envVars: LOGIN_OVERRIDE_ENV_VARS.filter((name) => !envNames.has(name)).map((name) => ({ name, mode: 'deny' as const })) },
      allowPty: true,
    },
    writeRoots,
    dropped,
  };
}
