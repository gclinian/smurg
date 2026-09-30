// Platform and dependency checks of the guest sandbox (ARCHITECTURE §7.6 "Preflight"). srt's own dependency API is
// not enough: on macOS it checks nothing (not even /usr/bin/sandbox-exec), and on Linux it does not notice the
// Ubuntu 24.04+ AppArmor restriction on user namespaces (docs/research/sandbox.md Q6, Linux notes). Everything here
// is asynchronous: the daemon's event loop runs srt's proxies and the hook socket.
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SOCKET_PATH_MAX_BYTES } from '../core/sockets.ts';
import type { LinuxTools, SandboxPlatform } from './policy.ts';
import { SandboxRefusal, dependencyRefusal } from './refusal.ts';

/** Where Linux distributions install bubblewrap, socat and ripgrep. PATH is not consulted: tool paths are config. */
export const LINUX_TOOL_DIRS: readonly string[] = Object.freeze(['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin']);

/** 1 ⇒ unprivileged user namespaces are restricted by AppArmor (Ubuntu 24.04+ default). */
export const APPARMOR_USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

export interface CheckIo {
  /** Resolves true when `path` is an executable regular file for this user. */
  isExecutable(path: string): Promise<boolean>;
  /** File contents, or null when it cannot be read. */
  readText(path: string): Promise<string | null>;
}

export const nodeCheckIo: CheckIo = {
  isExecutable: async (path) => {
    try {
      await access(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
};

export function supportedPlatform(platform: NodeJS.Platform): SandboxPlatform {
  if (platform === 'darwin' || platform === 'linux') return platform;
  throw new SandboxRefusal('unsupported-platform', `guest sandboxes need macOS or Linux, this is ${platform}`);
}

export async function findTool(name: string, dirs: readonly string[], io: CheckIo): Promise<string | null> {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await io.isExecutable(candidate)) return candidate;
  }
  return null;
}

/** macOS: the launcher srt hard-codes. A missing or non-executable one refuses (R5.4). */
export async function checkDarwinLauncher(sandboxExecPath: string, io: CheckIo): Promise<void> {
  if (!(await io.isExecutable(sandboxExecPath))) {
    throw dependencyRefusal('darwin', ['sandbox-exec'], `${sandboxExecPath} is missing or not executable`);
  }
}

/** Linux: bubblewrap, socat and ripgrep, resolved to absolute paths (srt gets them in its base config). */
export async function findLinuxTools(dirs: readonly string[], io: CheckIo): Promise<LinuxTools> {
  const [bwrap, socat, rg] = await Promise.all([findTool('bwrap', dirs, io), findTool('socat', dirs, io), findTool('rg', dirs, io)]);
  const missing = [bwrap === null ? 'bubblewrap (bwrap)' : null, socat === null ? 'socat' : null, rg === null ? 'ripgrep (rg)' : null].filter(
    (name): name is string => name !== null,
  );
  if (bwrap === null || socat === null || rg === null) {
    throw dependencyRefusal('linux', missing, `not found in ${dirs.join(':')}: ${missing.join(', ')}`);
  }
  return { bwrap, socat, rg };
}

/**
 * Whether AppArmor restricts unprivileged user namespaces (true), does not (false), or the kernel has no such switch
 * (null). A restriction is not a refusal by itself: an AppArmor profile for bwrap lifts it, and only the functional
 * self-test can tell. It decides which message a failed self-test gets.
 */
export async function appArmorRestrictsUserns(io: CheckIo): Promise<boolean | null> {
  const text = await io.readText(APPARMOR_USERNS_SYSCTL);
  if (text === null) return null;
  return text.trim() === '1';
}

/**
 * srt 0.0.77 runs its HTTP proxy backend on a Unix socket at `<os.tmpdir()>/srt-mux-<pid>-<n>.sock` (mux-proxy.js).
 * Node does not fail on a path longer than the platform limit: it binds a silently TRUNCATED path, which is the same
 * for every process sharing the TMPDIR prefix, so srt fails with EADDRINUSE at random (or binds somewhere unexpected).
 * When TMPDIR is too deep, the service lets srt create them in the daemon's run dir instead (SrtRuntime.acquire's
 * socketDir), and refuses with this reason only when that does not fit either.
 */
export function srtSocketDirProblem(tmpDir: string, pid: number): string | null {
  // macOS / Linux mux backend, and the Linux network bridge (linux-sandbox-utils.js: claude-socks-<16 hex>.sock).
  const samples = [`srt-mux-${pid}-zzzzzz.sock`, `claude-socks-${'f'.repeat(16)}.sock`].map((name) => join(tmpDir, name));
  const bytes = Math.max(...samples.map((sample) => Buffer.byteLength(sample, 'utf8')));
  if (bytes <= SOCKET_PATH_MAX_BYTES) return null;
  return `srt's proxy socket would live at a ${bytes}-byte path under TMPDIR (at most ${SOCKET_PATH_MAX_BYTES} work); start the daemon with a shorter TMPDIR`;
}

/** srt's own dependency verdict (Linux: bwrap / socat / rg / seccomp helper, uid 0 without CAP_SETFCAP). */
export function srtDependencyRefusal(platform: SandboxPlatform, errors: readonly string[]): SandboxRefusal | null {
  if (errors.length === 0) return null;
  return dependencyRefusal(platform, errors, `srt dependency check: ${errors.join('; ')}`);
}
