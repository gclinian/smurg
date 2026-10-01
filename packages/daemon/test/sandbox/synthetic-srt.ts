// TEST ONLY. srt-shaped command strings and a fake SrtApi for unit tests that must not depend on the real sandbox.
// The layout copies srt 0.0.77's macOS output (verified against the real thing in harden.test.ts): an `env` prefix,
// `/usr/bin/sandbox-exec -p '<profile>' <shell> -c '<command>'`, the Security-daemon lines, the write-root rules and
// the pty section last.
import { tmpdir } from 'node:os';
import { SRT_DARWIN_PTY_SECTION, shellQuote } from '../../src/sandbox/harden.ts';
import type { SrtBaseConfig, SrtSessionConfig } from '../../src/sandbox/policy.ts';
import type { SrtApi } from '../../src/sandbox/runtime.ts';

export function syntheticDarwinProfile(writeRoots: readonly string[], options: { readonly extraLines?: readonly string[] } = {}): string {
  const subpaths = ['/dev/stdout', '/dev/null', '/tmp/claude', '/private/tmp/claude', ...writeRoots].map((p) => `  (subpath ${JSON.stringify(p)})`);
  return [
    '(version 1)',
    '(deny default (with message "t"))',
    '',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow mach-lookup',
    '  (global-name "com.apple.logd")',
    '  (global-name "com.apple.securityd.xpc")',
    ')',
    "; Specific safe system-sockets, doesn't allow network access",
    '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
    '(allow file-ioctl file-read-data file-write-data',
    '  (require-all',
    '    (literal "/dev/null")',
    '    (vnode-type CHARACTER-DEVICE)',
    '  )',
    ')',
    '; Network',
    '(allow network-outbound (remote ip "localhost:1234"))',
    '; File read',
    '(allow file-read*)',
    '(allow file-write-unlink file-write-create',
    ...subpaths,
    '  (with message "t"))',
    '; File write',
    '(allow file-write*',
    ...subpaths,
    '  (with message "t"))',
    '(deny file-write*',
    '  (subpath "/x/.git/hooks")',
    '  (with message "t"))',
    ...(options.extraLines ?? []),
    '',
    SRT_DARWIN_PTY_SECTION,
  ].join('\n');
}

export function syntheticDarwinCommand(command: string, profile: string, shell = '/bin/bash'): string {
  return `env -u ANTHROPIC_API_KEY SANDBOX_RUNTIME=1 TMPDIR=/tmp/claude 'HTTP_PROXY=http://srt:tok@localhost:1234' /usr/bin/sandbox-exec -p ${shellQuote(profile)} ${shellQuote(shell)} -c ${shellQuote(command)}`;
}

/**
 * srt 0.0.77's Linux shape (compared with its real output in r5.sandbox.test.ts on Linux): session and namespace
 * options, the environment, the bridge socket binds, then the file system mounts (`mounts`), a fresh /dev, the pid and
 * user namespaces, no capabilities, a fresh /proc, and `-- <shell> -c <command>`.
 */
export function syntheticLinuxCommand(command: string, bwrap = '/usr/bin/bwrap', mounts: readonly string[] = ['--ro-bind', '/', '/', '--tmpfs', '/home']): string {
  const words = [
    bwrap,
    '--new-session',
    '--die-with-parent',
    '--unsetenv',
    'ANTHROPIC_API_KEY',
    '--unshare-net',
    '--setenv',
    'SANDBOX_RUNTIME',
    '1',
    ...mounts,
    '--dev',
    '/dev',
    '--unshare-pid',
    '--unshare-user',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--',
    '/bin/bash',
    '-c',
    command,
  ];
  return words.map(shellQuote).join(' ');
}

/**
 * The mounts srt derives from a per-session config, simplified: the bridge sockets bound first, `--ro-bind / /`, the
 * write roots, then a tmpfs over every read-deny entry not inside another one (globs skipped, deepest last) with the
 * write roots and read carve-outs below it bound back.
 */
export function syntheticLinuxMounts(custom: SrtSessionConfig, sockets: readonly string[] = []): string[] {
  const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`);
  const fs = custom.filesystem;
  const denies = fs.denyRead.filter((d) => !/[*?[\]]/.test(d)).sort((a, b) => a.split('/').length - b.split('/').length);
  const landings = denies.filter((d, i) => !denies.slice(0, i).some((e) => e !== d && under(d, e)));
  const out: string[] = [...sockets.flatMap((s) => ['--bind', s, s]), '--ro-bind', '/', '/', ...fs.allowWrite.flatMap((w) => ['--bind', w, w])];
  for (const landing of [...new Set(landings)]) {
    out.push('--tmpfs', landing);
    const writes = fs.allowWrite.filter((w) => w !== landing && under(w, landing));
    for (const w of writes) out.push('--bind', w, w);
    for (const r of fs.allowRead) if (r !== landing && under(r, landing) && !writes.some((w) => under(r, w))) out.push('--ro-bind', r, r);
  }
  return out;
}

export interface FakeSrt extends SrtApi {
  readonly calls: {
    readonly initialize: SrtBaseConfig[];
    /** os.tmpdir() as srt would have seen it while initialize() ran (its proxy sockets go there). */
    readonly initializeTmpdir: string[];
    readonly update: SrtBaseConfig[];
    readonly wrap: { command: string; custom: SrtSessionConfig }[];
    reset: number;
    /** cleanupAfterCommand() calls (srt's count of running wraps goes down by one each). */
    cleanups: number;
  };
}

export interface FakeSrtOptions {
  readonly platform: 'darwin' | 'linux';
  readonly version?: string | null;
  readonly dependencyErrors?: readonly string[];
  readonly initializeError?: Error;
  readonly updateError?: Error;
  /** Replaces the wrap result (e.g. the command unchanged, a profile without the expected lines). */
  readonly wrapResult?: (command: string, custom: SrtSessionConfig) => string;
  /** Linux: the bridge sockets srt reports after initialize() (must exist: the service resolves them). */
  readonly proxySockets?: () => readonly string[];
}

export function fakeSrt(options: FakeSrtOptions): FakeSrt {
  const calls = { initialize: [] as SrtBaseConfig[], initializeTmpdir: [] as string[], update: [] as SrtBaseConfig[], wrap: [] as { command: string; custom: SrtSessionConfig }[], reset: 0, cleanups: 0 };
  let updates = 0;
  return {
    calls,
    version: options.version === undefined ? '0.0.77' : options.version,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => calls.initialize.length > 0 && !options.initializeError,
    checkDependenciesAsync: async () => ({ errors: [...(options.dependencyErrors ?? [])], warnings: [] }),
    initialize: async (config) => {
      calls.initialize.push(config);
      calls.initializeTmpdir.push(tmpdir());
      if (options.initializeError) throw options.initializeError;
    },
    updateConfig: (config) => {
      calls.update.push(config);
      updates++;
      // the first update fails when asked to; the fallback (network closed) goes through
      if (options.updateError && updates === 1) throw options.updateError;
    },
    wrapWithSandbox: async (command, _shell, custom) => {
      calls.wrap.push({ command, custom });
      if (options.wrapResult) return options.wrapResult(command, custom);
      return options.platform === 'darwin'
        ? syntheticDarwinCommand(command, syntheticDarwinProfile(custom.filesystem.allowWrite))
        : syntheticLinuxCommand(command, '/usr/bin/bwrap', syntheticLinuxMounts(custom, options.proxySockets?.() ?? []));
    },
    cleanupAfterCommand: () => {
      calls.cleanups++;
    },
    linuxProxySockets: () => (options.platform === 'linux' ? (options.proxySockets?.() ?? []) : []),
    reset: async () => {
      calls.reset++;
    },
    validate: () => null,
  };
}
