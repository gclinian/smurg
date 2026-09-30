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

export function syntheticLinuxCommand(command: string, bwrap = '/usr/bin/bwrap'): string {
  return `${shellQuote(bwrap)} --new-session --die-with-parent --unshare-net --unshare-pid --ro-bind / / -- /bin/bash -c ${shellQuote(command)}`;
}

export interface FakeSrt extends SrtApi {
  readonly calls: {
    readonly initialize: SrtBaseConfig[];
    /** os.tmpdir() as srt would have seen it while initialize() ran (its proxy sockets go there). */
    readonly initializeTmpdir: string[];
    readonly update: SrtBaseConfig[];
    readonly wrap: { command: string; custom: SrtSessionConfig }[];
    reset: number;
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
}

export function fakeSrt(options: FakeSrtOptions): FakeSrt {
  const calls = { initialize: [] as SrtBaseConfig[], initializeTmpdir: [] as string[], update: [] as SrtBaseConfig[], wrap: [] as { command: string; custom: SrtSessionConfig }[], reset: 0 };
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
      return options.platform === 'darwin' ? syntheticDarwinCommand(command, syntheticDarwinProfile(custom.filesystem.allowWrite)) : syntheticLinuxCommand(command);
    },
    cleanupAfterCommand: () => {},
    reset: async () => {
      calls.reset++;
    },
    validate: () => null,
  };
}
