// SandboxService with injected seams (platform, srt, the pty runner, file checks): every refusal reason, the Linux
// branch on any machine (the real bubblewrap runs in r5.sandbox.test.ts on Linux), live allow-list changes, and the
// process-wide srt runtime.
import { execFile } from 'node:child_process';
import { existsSync, fstatSync, lstatSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { SmurgError, type AuditEntry } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FileChange, SandboxSpec } from '../../src/core/interfaces.ts';
import { filesInstanceOf, filesModule } from '../../src/files/module.ts';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { APPARMOR_USERNS_SYSCTL, srtSocketDirProblem, type CheckIo } from '../../src/sandbox/checks.ts';
import { createSandboxModule } from '../../src/sandbox/module.ts';
import { PLACEHOLDER_EXCLUDE_HEADER } from '../../src/sandbox/git-exclude.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { SrtRuntime, RuntimeBusyError, type SrtApi } from '../../src/sandbox/runtime.ts';
import { LINUX_GUEST_TASK_LIMIT, SandboxServiceImpl, linuxCountsTasksPerUserNamespace, type SandboxServiceOptions } from '../../src/sandbox/service.ts';
import type { PtyRunInput, PtyRunResult, PtyRunner } from '../../src/sandbox/selftest.ts';
import { buildBaseConfig } from '../../src/sandbox/policy.ts';
import { LINUX_SESSION_PRELUDE, shellQuote } from '../../src/sandbox/harden.ts';
import { waitFor } from '../../src/testing/index.ts';
import { createSandboxFixture, printWarningsOnFailure, type SandboxFixture, type SandboxFixtureOptions } from './helpers.ts';
import { fakeSrt, syntheticDarwinCommand, syntheticDarwinProfile, syntheticLinuxCommand, type FakeSrt, type FakeSrtOptions } from './synthetic-srt.ts';

const execFileAsync = promisify(execFile);

const TIMEOUT = 60_000;
const DARWIN_EXEC = new Set(['/usr/bin/sandbox-exec']);
const LINUX_EXEC = new Set(['/usr/bin/bwrap', '/usr/bin/socat', '/usr/bin/rg']);

/** What `bwrap --help` of bubblewrap 0.9.0 says about the options the Linux hardening adds (and an older one lacks). */
const BWRAP_HELP = [
  '    --disable-userns             Disable further use of user namespaces inside sandbox',
  '    --remount-ro DEST            Remount DEST as readonly; does not recursively remount',
  '    --chmod OCTAL PATH           Change permissions of PATH (must already exist)',
].join('\n');

/** A bwrap run: `--help` answers BWRAP_HELP, the user-namespace probe succeeds, unless `run` says otherwise. */
function io(executable: ReadonlySet<string>, texts: Readonly<Record<string, string>> = {}, run?: CheckIo['run']): CheckIo {
  return {
    isExecutable: async (path) => executable.has(path),
    readText: async (path) => texts[path] ?? null,
    run: run ?? (async (_file, args) => (args[0] === '--help' ? { code: 0, stdout: BWRAP_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' })),
  };
}

/** How the fake `smurg hook` answers the in-sandbox hook self-test (review SEC-D-05 follow-up). */
type HookMode = 'answers' | 'silent' | 'wrong-session' | 'wrong-nonce' | 'timeout';

/** Answers the self-test like a working sandbox (prints the nonce), or as `mode` says; the hook probe as `hook` says. */
function runner(mode: 'ok' | 'exit1' | 'leak-canary' | 'write-probe' | 'no-marker' | 'timeout' | 'spawn-fails' = 'ok', hook: HookMode = 'answers'): PtyRunner & { readonly runs: PtyRunInput[] } {
  const runs: PtyRunInput[] = [];
  return {
    runs,
    async run(input): Promise<PtyRunResult> {
      runs.push(input);
      const command = input.args[1] ?? '';
      const probe = /"hook_event_name":"SmurgProbe","smurg_probe":"([0-9a-f]{32})"/.exec(command.replace(/'"'"'/g, "'"));
      if (probe !== null) {
        const nonce = probe[1] as string;
        const answer = (n: string, sessionId: string): string => `${JSON.stringify({ smurgProbe: { nonce: n, sessionId } })}\r\n`;
        switch (hook) {
          case 'answers':
            return { exitCode: 0, output: answer(nonce, 'ses_unit'), timedOut: false };
          case 'silent':
            return { exitCode: 0, output: '', timedOut: false };
          case 'wrong-session':
            return { exitCode: 0, output: answer(nonce, 'ses_other'), timedOut: false };
          case 'wrong-nonce':
            return { exitCode: 0, output: answer('0'.repeat(32), 'ses_unit'), timedOut: false };
          case 'timeout':
            return { exitCode: null, output: '', timedOut: true };
        }
      }
      const nonce = /SMURG-SANDBOX-SELFTEST-OK-([0-9a-f]+)/.exec(command)?.[1] ?? 'none';
      const marker = `SMURG-SANDBOX-SELFTEST-OK-${nonce}\r\n`;
      switch (mode) {
        case 'ok':
          return { exitCode: 0, output: marker, timedOut: false };
        case 'exit1':
          return { exitCode: 1, output: 'bwrap: setting up uid map: Permission denied\r\n', timedOut: false };
        case 'leak-canary': {
          const secretPath = /(\/[^'"\s]*canary-secret)/.exec(command)?.[1] as string;
          return { exitCode: 0, output: `${await readFile(secretPath, 'utf8')}${marker}`, timedOut: false };
        }
        case 'write-probe': {
          await writeFile(/(\/[^'"\s]*canary-probe)/.exec(command)?.[1] as string, 'x');
          return { exitCode: 0, output: marker, timedOut: false };
        }
        case 'no-marker':
          return { exitCode: 0, output: 'ok\r\n', timedOut: false };
        case 'timeout':
          return { exitCode: null, output: '', timedOut: true };
        case 'spawn-fails':
          throw new Error('posix_spawnp failed.');
      }
    },
  };
}

/** runner() whose next run waits until the test lets it go (holdNext): a wrap() held in its canary self-test. */
function holdingRunner(): ReturnType<typeof runner> & { holdNext(): { readonly reached: Promise<void>; release(): void } } {
  const inner = runner();
  let pending: { readonly reached: () => void; readonly wait: Promise<void> } | null = null;
  return {
    runs: inner.runs,
    async run(input) {
      const hold = pending;
      pending = null;
      if (hold !== null) {
        hold.reached();
        await hold.wait;
      }
      return inner.run(input);
    },
    holdNext() {
      let reached: () => void = () => {};
      let release: () => void = () => {};
      const atHold = new Promise<void>((resolve) => (reached = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      pending = { reached, wait };
      return { reached: atHold, release };
    },
  };
}

interface Harness {
  readonly f: SandboxFixture;
  readonly srt: FakeSrt;
  readonly run: ReturnType<typeof runner>;
}

let current: SandboxFixture | undefined;

afterEach(async (context) => {
  printWarningsOnFailure(current, context);
  await current?.cleanup();
  current = undefined;
});

async function harness(
  platform: NodeJS.Platform,
  options: { readonly srt?: FakeSrtOptions; readonly runner?: ReturnType<typeof runner>; readonly service?: Partial<SandboxServiceOptions>; readonly fixture?: Omit<SandboxFixtureOptions, 'module'> } = {},
): Promise<Harness> {
  // Linux: srt's bridge socket, created once the fixture (its run dir) exists; the service resolves it.
  const bridge = (): string => join((current as SandboxFixture).runDir, 'claude-http-unit.sock');
  const srtOptions: FakeSrtOptions = options.srt ?? { platform: platform === 'linux' ? 'linux' : 'darwin' };
  const srt = fakeSrt(srtOptions.platform === 'linux' && srtOptions.proxySockets === undefined ? { ...srtOptions, proxySockets: () => [bridge()] } : srtOptions);
  const run = options.runner ?? runner();
  const module = createSandboxModule({
    platform,
    loadSrt: async () => srt,
    runtime: new SrtRuntime(),
    runner: run,
    io: io(platform === 'linux' ? LINUX_EXEC : DARWIN_EXEC),
    // Linux: a kernel that counts tasks per user namespace (the task limit is set), whatever this machine runs
    kernelRelease: () => '6.8.0-85-generic',
    ...options.service,
  });
  current = await createSandboxFixture({ ...options.fixture, module });
  if (platform === 'linux') await writeFile(bridge(), '');
  return { f: current, srt, run };
}

async function specFor(f: SandboxFixture, overrides: Partial<SandboxSpec> = {}): Promise<SandboxSpec> {
  const guest = await f.guest('alice');
  return f.spec({ sessionId: 'ses_unit', command: 'echo hi', guest, settingsDir: await f.settingsDir('ses_unit', '{}\n'), ...overrides });
}

async function refusal(f: SandboxFixture, spec: SandboxSpec): Promise<SmurgError> {
  const err = await f.sandbox.wrap(spec).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SmurgError);
  return err as SmurgError;
}

async function refusedAudit(f: SandboxFixture): Promise<AuditEntry[]> {
  return (await f.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'sandbox.refused');
}

describe('SandboxService refusals (fail closed, sandbox_unavailable + audit)', () => {
  it('refuses a platform without a guest sandbox', async () => {
    const { f } = await harness('win32');
    // The last check is kept for `smurg status` (DaemonStatus.sandbox): nothing before the first one.
    expect(f.daemon.status().sandbox).toBeNull();
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    expect(f.daemon.status().sandbox).toEqual({ ok: false, reason: 'unsupported-platform' });
    const err = await refusal(f, await specFor(f));
    expect(err.code).toBe('sandbox_unavailable');
    expect(err.detail).toEqual({ reason: 'unsupported-platform' });
    expect(await refusedAudit(f)).toEqual([expect.objectContaining({ target: 'ses_unit', outcome: 'denied', detail: expect.objectContaining({ reason: 'unsupported-platform' }) })]);
  }, TIMEOUT);

  it('R5.4 (Linux, injected) a missing bubblewrap / socat / ripgrep refuses with the install hint', async () => {
    const { f, srt } = await harness('linux', { service: { io: io(new Set()) } });
    const pre = await f.sandbox.preflight();
    expect(pre).toMatchObject({ ok: false, reason: 'dependency-missing' });
    if (pre.ok) return;
    for (const text of ['bubblewrap', 'socat', 'ripgrep', 'apt-get install bubblewrap socat ripgrep']) expect(pre.detail).toContain(text);
    const err = await refusal(f, await specFor(f));
    expect(err.detail).toEqual({ reason: 'dependency-missing' });
    expect(err.message).toContain('bubblewrap');
    expect(srt.calls.initialize).toHaveLength(0);
    expect(await refusedAudit(f)).toHaveLength(1);
  }, TIMEOUT);

  it('R5.4 (macOS, injected) a missing sandbox-exec refuses and names it', async () => {
    const { f, srt } = await harness('darwin', { service: { io: io(new Set()) } });
    const err = await refusal(f, await specFor(f));
    expect(err.detail).toEqual({ reason: 'dependency-missing' });
    expect(err.message).toContain('sandbox-exec');
    expect(srt.calls.wrap).toHaveLength(0);
  }, TIMEOUT);

  it('refuses when srt’s own dependency check reports errors', async () => {
    const { f } = await harness('linux', { srt: { platform: 'linux', dependencyErrors: ['bubblewrap (bwrap) not installed'] } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'dependency-missing' });
  }, TIMEOUT);

  /** A bwrap that AppArmor's user-namespace restriction stops (the text measured on Ubuntu 24.04 without a profile). */
  const blockedBwrap: CheckIo['run'] = async (_file, args) =>
    args[0] === '--help' ? { code: 0, stdout: BWRAP_HELP, stderr: '' } : { code: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied\n' };

  it('Linux: a failed self-test while AppArmor restricts user namespaces AND a bare bwrap fails like that names the AppArmor fix', async () => {
    const run = runner('exit1');
    const probes: string[][] = [];
    const bwrapRun: CheckIo['run'] = async (file, args, timeoutMs) => {
      probes.push([file, ...args]);
      return blockedBwrap(file, args, timeoutMs);
    };
    const { f } = await harness('linux', { runner: run, service: { io: io(LINUX_EXEC, { [APPARMOR_USERNS_SYSCTL]: '1\n' }, bwrapRun) } });
    const pre = await f.sandbox.preflight();
    expect(pre).toMatchObject({ ok: false, reason: 'apparmor-userns' });
    if (pre.ok) return;
    expect(pre.detail).toContain('AppArmor');
    expect(pre.detail).toContain('apparmor_restrict_unprivileged_userns');
    expect(run.runs).toHaveLength(1);
    // the probe is bwrap alone, by its absolute path, creating the user and network namespaces a sandbox needs
    expect(probes.at(-1)).toEqual(['/usr/bin/bwrap', '--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true']);
    expect(f.warnings().join('\n')).toContain('setting up uid map: Permission denied');
  }, TIMEOUT);

  it('Linux: the same failure without the AppArmor restriction is a plain self-test failure', async () => {
    const { f } = await harness('linux', { runner: runner('exit1'), service: { io: io(LINUX_EXEC, { [APPARMOR_USERNS_SYSCTL]: '0\n' }, blockedBwrap) } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'self-test-failed' });
  }, TIMEOUT);

  it('Linux: a self-test that fails while bwrap itself works is NOT blamed on AppArmor, even with the restriction on (a policy that leaks)', async () => {
    // Measured on Ubuntu 24.04 before the Linux hardening: the smurg-bwrap profile was loaded, bwrap worked, and the
    // canary found the host home listable (exit 23); the refusal wrongly told the host to fix AppArmor.
    const { f } = await harness('linux', { runner: runner('leak-canary'), service: { io: io(LINUX_EXEC, { [APPARMOR_USERNS_SYSCTL]: '1\n' }) } });
    const pre = await f.sandbox.preflight();
    expect(pre).toMatchObject({ ok: false, reason: 'self-test-failed' });
    if (pre.ok) return;
    expect(pre.detail).not.toContain('AppArmor');
  }, TIMEOUT);

  it('Linux: a bubblewrap without the options the hardening adds (older than 0.8) refuses with the upgrade hint, before srt starts', async () => {
    const old: CheckIo['run'] = async () => ({ code: 0, stdout: '    --remount-ro DEST            Remount DEST as readonly\n', stderr: '' });
    const { f, srt } = await harness('linux', { service: { io: io(LINUX_EXEC, {}, old) } });
    const pre = await f.sandbox.preflight();
    expect(pre).toMatchObject({ ok: false, reason: 'dependency-missing' });
    if (pre.ok) return;
    expect(pre.detail).toContain('bubblewrap');
    expect(pre.detail).toContain('0.8');
    expect(srt.calls.initialize).toHaveLength(0);
    expect(f.warnings().join('\n')).toMatch(/--disable-userns, --chmod/);
  }, TIMEOUT);

  it.each(['leak-canary', 'write-probe', 'no-marker', 'timeout', 'spawn-fails'] as const)('the self-test refuses when the canary run shows %s', async (mode) => {
    const { f } = await harness('darwin', { runner: runner(mode) });
    const err = await refusal(f, await specFor(f));
    expect(err.detail).toEqual({ reason: 'self-test-failed' });
  }, TIMEOUT);

  it('srt that returns the command unwrapped is refused (the launcher is missing)', async () => {
    const { f } = await harness('darwin', { srt: { platform: 'darwin', wrapResult: (command) => command } });
    expect((await refusal(f, await specFor(f))).detail).toEqual({ reason: 'launcher-missing' });
  }, TIMEOUT);

  it('a profile the hardening does not recognise is refused', async () => {
    const withoutKeychainLines = (command: string, custom: { filesystem: { allowWrite: readonly string[] } }): string =>
      syntheticDarwinCommand(command, syntheticDarwinProfile(custom.filesystem.allowWrite).replace('(allow mach-lookup (global-name "com.apple.SecurityServer"))\n', ''));
    const { f } = await harness('darwin', { srt: { platform: 'darwin', wrapResult: withoutKeychainLines } });
    expect((await refusal(f, await specFor(f))).detail).toEqual({ reason: 'hardening-failed' });
  }, TIMEOUT);

  it('an srt version other than the pinned one is refused', async () => {
    const { f, srt } = await harness('darwin', { srt: { platform: 'darwin', version: '0.0.78' } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'hardening-failed' });
    expect(srt.calls.initialize).toHaveLength(0);
  }, TIMEOUT);

  it('a failed initialize is init-failed, and srt is reset (its config would otherwise stay set)', async () => {
    const { f, srt } = await harness('darwin', { srt: { platform: 'darwin', initializeError: new Error('proxy failed') } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'init-failed' });
    expect(srt.calls.reset).toBe(1);
  }, TIMEOUT);

  it('srt’s own dependency failure inside initialize() is reported as a missing dependency', async () => {
    const { f } = await harness('linux', { srt: { platform: 'linux', initializeError: new Error('Sandbox dependencies not available: bubblewrap (bwrap) not installed') } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'dependency-missing' });
  }, TIMEOUT);

  it('the socket-length check covers srt’s longest socket name on both platforms', () => {
    expect(srtSocketDirProblem('/private/var/folders/ab/cdefgh/T', 12345)).toBeNull();
    // 103 bytes is the limit: a TMPDIR that fits the macOS mux name but not the Linux bridge name is still refused
    const dir = `/tmp/${'d'.repeat(103 - '/tmp/'.length - '/claude-socks-ffffffffffffffff.sock'.length + 1)}`;
    expect(Buffer.byteLength(`${dir}/srt-mux-12345-zzzzzz.sock`)).toBeLessThanOrEqual(103);
    expect(srtSocketDirProblem(dir, 12345)).toContain('shorter TMPDIR');
  });

  it('a TMPDIR too deep for srt’s proxy sockets: srt creates them in the daemon’s short run dir, and TMPDIR is restored', async () => {
    const { f, srt } = await harness('darwin', { service: { tmpDir: () => `/private/tmp/${'x'.repeat(90)}` } });
    const before = process.env['TMPDIR'];
    expect(await f.sandbox.preflight()).toEqual({ ok: true, platform: 'darwin' });
    expect(f.ctx.services.sandbox.lastPreflight?.()).toEqual({ ok: true, platform: 'darwin' });
    expect(f.daemon.status().sandbox).toEqual({ ok: true, reason: null });
    expect(srt.calls.initializeTmpdir).toEqual([f.runDir]);
    expect(process.env['TMPDIR']).toBe(before);
  }, TIMEOUT);

  it('… and refuses with that reason when the run dir does not fit either (Node would bind a truncated path)', async () => {
    const { f, srt } = await harness('darwin');
    const deep = `/private/tmp/${'x'.repeat(90)}`;
    const ctx = { ...f.ctx, config: { ...f.ctx.config, runDir: deep } };
    const service = new SandboxServiceImpl(ctx, { platform: 'darwin', loadSrt: async () => srt, runtime: new SrtRuntime(), runner: runner(), io: io(DARWIN_EXEC), tmpDir: () => deep });
    expect(await service.preflight()).toMatchObject({ ok: false, reason: 'init-failed' });
    expect(srt.calls.initialize).toHaveLength(0);
  }, TIMEOUT);

  it('no configured host home: nothing to protect, nothing may run', async () => {
    const { f, srt } = await harness('darwin');
    const ctx = { ...f.ctx, config: { ...f.ctx.config, sessions: { ...f.ctx.config.sessions, hostHome: null } } };
    const service = new SandboxServiceImpl(ctx, { platform: 'darwin', loadSrt: async () => srt, runtime: new SrtRuntime(), runner: runner(), io: io(DARWIN_EXEC) });
    expect(await service.preflight()).toMatchObject({ ok: false, reason: 'no-host-home' });
  }, TIMEOUT);

  it('the spec is checked against the daemon’s own view: root, hook socket, guest dir, environment', async () => {
    const { f } = await harness('darwin');
    const other = join(f.base, 'elsewhere');
    await import('node:fs/promises').then((fs) => fs.mkdir(other, { recursive: true }));
    expect((await refusal(f, await specFor(f, { rootPath: other }))).detail).toEqual({ reason: 'root-unknown' });
    expect((await refusal(f, await specFor(f, { hookSocketPath: join(f.runDir, 'other.hook') }))).detail).toEqual({ reason: 'policy-invalid' });
    expect((await refusal(f, await specFor(f, { guestDir: other }))).detail).toEqual({ reason: 'policy-invalid' });
    const guest = await f.guest('alice');
    const badEnvs: Record<string, string>[] = [{ BASH_ENV: '/tmp/x' }, { 'BASH_FUNC_env%%': '() { :; }' }, { DYLD_INSERT_LIBRARIES: '/x' }, { PATH: 'a\u0000b' }];
    for (const bad of badEnvs) {
      const spec = await specFor(f, { env: { ...f.spec({ command: 'x', guest, settingsDir: '/x' }).env, ...bad } });
      expect((await refusal(f, spec)).detail, JSON.stringify(Object.keys(bad))).toEqual({ reason: 'policy-invalid' });
    }
    expect((await refusal(f, await specFor(f, { command: '   ' }))).detail).toEqual({ reason: 'policy-invalid' });
    expect(await refusedAudit(f)).toHaveLength(8);
  }, TIMEOUT);
});

describe('the hook must be able to run inside the sandbox (review SEC-D-05)', () => {
  const agentEnv = (f: SandboxFixture, env: Readonly<Record<string, string>>): Record<string, string> => ({ ...env, SMURG_HOOK_SOCKET: f.ctx.config.runPaths.hook, SMURG_SESSION_TOKEN: 'tok_unit_0123456789' });

  it('an agent session whose `smurg hook` lies where the guest may not read (the state dir) is refused: hook-unreachable, audited', async () => {
    const { f } = await harness('darwin', { fixture: { selfCommand: { file: '.smurg/bin/smurg', args: [] } } });
    await mkdir(join(f.stateDir, 'bin'), { recursive: true });
    await writeFile(join(f.stateDir, 'bin', 'smurg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const spec = await specFor(f);
    const refused = await refusal(f, { ...spec, env: agentEnv(f, spec.env) });
    expect(refused.detail).toEqual({ reason: 'hook-unreachable' });
    expect(await refusedAudit(f)).toEqual([expect.objectContaining({ outcome: 'denied', detail: expect.objectContaining({ reason: 'hook-unreachable' }) })]);
    // A terminal (no hook token) does not run the hook: it still starts.
    await expect(f.sandbox.wrap(spec)).resolves.toMatchObject({ cwd: f.share });
  }, TIMEOUT);

  it('… and so is one whose hook entry script is inside the share in worktree mode, or missing', async () => {
    const { f } = await harness('darwin', { fixture: { git: true, selfCommand: { file: '/bin/sh', args: ['./projects/app/tools/smurg-cli/main.mjs'] } } });
    await mkdir(join(f.share, 'tools', 'smurg-cli'), { recursive: true });
    await writeFile(join(f.share, 'tools', 'smurg-cli', 'main.mjs'), 'process.exit(0)\n');
    // Main mode: the share is the session's own root, readable inside: fine.
    const spec = await specFor(f);
    await expect(f.sandbox.wrap({ ...spec, env: agentEnv(f, spec.env) })).resolves.toMatchObject({ cwd: f.share });
    // Worktree mode: the share is denied inside, so the hook could not start.
    const wtDir = join(f.share, '.smurg', 'worktrees', 'wt_hook');
    await mkdir(wtDir, { recursive: true });
    await f.ctx.roots.registerWorktree({ worktreeId: 'wt_hook', dir: wtDir, ownerUserId: 'dev:alice', sharedLinks: [] });
    const wtSpec = await specFor(f, { rootPath: await import('node:fs/promises').then((fs) => fs.realpath(wtDir)) });
    expect((await refusal(f, { ...wtSpec, env: agentEnv(f, wtSpec.env) })).detail).toEqual({ reason: 'hook-unreachable' });
  }, TIMEOUT);

  it('control: a hook command outside every denied region that answers the self-test lets the agent session start', async () => {
    const { f } = await harness('darwin', { fixture: { selfCommand: { file: '/usr/bin/true', args: [] } } });
    const spec = await specFor(f);
    await expect(f.sandbox.wrap({ ...spec, env: agentEnv(f, spec.env) })).resolves.toMatchObject({ cwd: f.share });
    expect(await refusedAudit(f)).toEqual([]);
  }, TIMEOUT);
});

// The in-sandbox hook self-test (review SEC-D-05 follow-up), with a fake srt and a fake pty runner: what the service
// sends and how it judges the answer. The real hook in the real sandbox: test/sandbox/hook-selftest.real.test.ts.
describe('the hook self-test before an agent session (SEC-D-05 follow-up, service logic)', () => {
  const agentEnv = (f: SandboxFixture, env: Readonly<Record<string, string>>): Record<string, string> => ({ ...env, SMURG_HOOK_SOCKET: f.ctx.config.runPaths.hook, SMURG_SESSION_TOKEN: 'tok_unit_0123456789' });

  it('runs the configured `smurg hook` once, through the session’s own policy, with the session’s environment and a fresh nonce', async () => {
    const { f, srt, run } = await harness('darwin', { fixture: { selfCommand: { file: '/usr/bin/true', args: ['--flag'] } } });
    const spec = await specFor(f);
    await f.sandbox.wrap({ ...spec, env: agentEnv(f, spec.env) });
    await f.sandbox.wrap({ ...spec, env: agentEnv(f, spec.env) });
    const probes = run.runs.filter((r) => (r.args[1] ?? '').includes('SmurgProbe'));
    expect(probes).toHaveLength(2); // nothing cached: every launch runs it
    const nonces = probes.map((r) => /smurg_probe":"([0-9a-f]{32})/.exec(r.args[1] ?? '')?.[1]);
    expect(new Set(nonces).size).toBe(2);
    expect(probes[0]?.args[1]).toContain(`/usr/bin/true --flag hook`);
    expect(probes[0]?.env).toMatchObject({ SMURG_SESSION_TOKEN: 'tok_unit_0123456789', SMURG_HOOK_SOCKET: f.ctx.config.runPaths.hook });
    expect(probes[0]?.cwd).toBe(f.share);
    // The probe was wrapped with the same per-session policy as the session's own command.
    const customs = srt.calls.wrap.map((c) => JSON.stringify(c.custom));
    expect(new Set(customs.slice(-3)).size).toBe(1);
    // A terminal (no hook token) runs no probe.
    const before = run.runs.length;
    await f.sandbox.wrap(spec);
    expect(run.runs.slice(before).filter((r) => (r.args[1] ?? '').includes('SmurgProbe'))).toEqual([]);
  }, TIMEOUT);

  it.each<[HookMode, RegExp]>([
    ['silent', /printed nothing/],
    ['wrong-session', /answered something else/],
    ['wrong-nonce', /answered something else/],
    ['timeout', /did not finish in time/],
  ])('refuses the agent session when the hook is %s: sandbox_unavailable hook-self-test-failed, audited, actionable zh-TW message', async (mode, why) => {
    const { f } = await harness('darwin', { runner: runner('ok', mode), fixture: { selfCommand: { file: '/usr/bin/true', args: [] } } });
    const spec = await specFor(f);
    const refused = await refusal(f, { ...spec, env: agentEnv(f, spec.env) });
    expect(refused.code).toBe('sandbox_unavailable');
    expect(refused.detail).toEqual({ reason: 'hook-self-test-failed' });
    expect(refused.message).toMatch(/檔案鎖程式失敗.*拒絕開啟客人的 agent session.*請主人確認/);
    expect(refused.message).not.toMatch(/\/(?:Users|home|private)\//); // no host path in what the guest sees
    expect(await refusedAudit(f)).toEqual([expect.objectContaining({ outcome: 'denied', target: 'ses_unit', detail: expect.objectContaining({ reason: 'hook-self-test-failed' }) })]);
    expect(f.warnings().join('\n')).toMatch(why);
  }, TIMEOUT);
});

describe('SandboxService happy paths with a fake srt', () => {
  it('Linux: absolute tools, all Unix sockets with their directories hidden, srt’s bridge socket carved out, bwrap exec’d hardened', async () => {
    const { f, srt, run } = await harness('linux');
    expect(await f.sandbox.preflight()).toEqual({ ok: true, platform: 'linux' });
    const base = srt.calls.initialize[0];
    expect(base).toMatchObject({ bwrapPath: '/usr/bin/bwrap', socatPath: '/usr/bin/socat', ripgrep: { command: '/usr/bin/rg' }, network: { allowAllUnixSockets: true, allowUnixSockets: [f.ctx.config.runPaths.hook] } });
    expect(base?.filesystem.denyRead).toEqual(expect.arrayContaining(['/run', '/var/run', '/home', '/tmp', '/var/snap', f.home, f.stateDir]));
    const wrapped = await f.sandbox.wrap(await specFor(f));
    const command = wrapped.args[1] as string;
    expect(command.startsWith(`${LINUX_SESSION_PRELUDE}exec /usr/bin/bwrap "\${SMURG_NEW_SESSION[@]}" --die-with-parent `)).toBe(true);
    expect(command).not.toContain('--new-session --die-with-parent');
    expect(command).toContain('CLAUDE_CODE_TMPDIR=');
    // appended right before bwrap's `--`: no nested user namespace, the read-deny tmpfs hidden and read-only
    const tail = command.slice(0, command.indexOf(' -- /bin/bash -c '));
    expect(tail).toContain(' --disable-userns ');
    expect(tail).toContain(' --chmod 0111 /home ');
    const tmpfs = [...tail.matchAll(/ --tmpfs (\S+)/g)].map((m) => m[1] as string);
    expect(tmpfs).toContain('/home');
    for (const dir of tmpfs) expect(tail).toContain(` --remount-ro ${dir}`);
    expect(run.runs).toHaveLength(2); // the preflight's self-test and the session's own
    const allowRead = srt.calls.wrap.at(-1)?.custom.filesystem.allowRead;
    expect(allowRead).toContain(f.ctx.config.runPaths.hook);
    expect(allowRead).toContain(join(f.runDir, 'claude-http-unit.sock'));
  }, TIMEOUT);

  it('Linux: without srt’s bridge socket the guest would be offline, so nothing starts', async () => {
    const { f } = await harness('linux', { srt: { platform: 'linux', proxySockets: () => [join((current as SandboxFixture).base, 'missing.sock')] } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'init-failed' });
    expect(f.warnings().join('\n')).toContain('bridge socket is missing');
  }, TIMEOUT);

  it('Linux: the absent host-only directory names are made as empty directories, recorded first with the file names srt will hold, for as long as a guest process runs; a later daemon removes what a dead one left that is still untouched', async () => {
    const { f, srt } = await harness('linux');
    const record = async (): Promise<{ paths: string[] }> => JSON.parse(await readFile(join(f.ctx.state.dir, 'sandbox-placeholders.json'), 'utf8')) as { paths: string[] };
    const names = ['.claude', '.git', '.idea', '.vscode'];
    await f.sandbox.wrap(await specFor(f)); // never released: the daemon "dies" with the guest process running
    // `.smurg` exists in every share; the others are absent in this one and exist now as the service's empty
    // directories; `.mcp.json` / `.envrc` are recorded for bubblewrap's file mount points (made by the real srt only)
    expect((await record()).paths.sort()).toEqual([...names, '.envrc', '.mcp.json'].map((name) => join(f.share, name)).sort());
    for (const name of names) {
      expect(lstatSync(join(f.share, name)).isDirectory(), name).toBe(true);
      expect(readdirSync(join(f.share, name)), name).toEqual([]);
    }
    // bubblewrap is asked for no mount point for them: every srt wrap sees existing directories, the same policy each time
    for (const call of srt.calls.wrap) expect(call.custom.filesystem.denyWrite.filter((p) => p.includes('.smurg-no-such-entry'))).toEqual([]);
    expect(srt.calls.wrap.at(-1)?.custom).toEqual(srt.calls.wrap.at(-2)?.custom);
    // srt's file mount points (empty, 0444) exist once the command is handed out: the service makes them as bubblewrap
    // would (sandbox/guard.ts placeMountPoints), so that the host's removal of one while the guest runs is noticed.
    for (const name of ['.mcp.json', '.envrc']) {
      const st = lstatSync(join(f.share, name));
      expect([st.isFile(), st.size, (st.mode & 0o777).toString(8)], name).toEqual([true, 0, '444']);
    }
    // What the dead daemon leaves (srt's empty 0444 `.mcp.json`), plus the host's own work meanwhile.
    await unlink(join(f.share, '.envrc'));
    await writeFile(join(f.share, '.envrc'), '', { mode: 0o644 }); // the host's own, empty but writable
    await writeFile(join(f.share, '.vscode', 'settings.json'), '{}\n');
    await mkdir(join(f.base, 'elsewhere'));
    await rmdir(join(f.share, '.idea'));
    await symlink(join(f.base, 'elsewhere'), join(f.share, '.idea'));
    const next = new SandboxServiceImpl(f.ctx, {
      platform: 'linux',
      loadSrt: async () => fakeSrt({ platform: 'linux', proxySockets: () => [join(f.runDir, 'claude-http-unit.sock')] }),
      runtime: new SrtRuntime(),
      runner: runner(),
      io: io(LINUX_EXEC),
    });
    try {
      expect(await next.preflight()).toEqual({ ok: true, platform: 'linux' });
      expect(existsSync(join(f.share, '.claude'))).toBe(false); // an empty placeholder: removed
      expect(existsSync(join(f.share, '.git'))).toBe(false);
      expect(existsSync(join(f.share, '.mcp.json'))).toBe(false); // exactly srt's leftover: removed
      expect(lstatSync(join(f.share, '.envrc')).isFile()).toBe(true); // written by someone: kept
      expect(await readFile(join(f.share, '.vscode', 'settings.json'), 'utf8')).toBe('{}\n'); // content: kept
      expect(lstatSync(join(f.share, '.idea')).isSymbolicLink()).toBe(true); // not a directory: kept
      expect(existsSync(join(f.base, 'elsewhere'))).toBe(true);
      expect((await record()).paths).toEqual([]);
    } finally {
      await next.dispose();
    }
  }, TIMEOUT);

  it('Linux: a guest process that ends while another wrap() is in flight removes none of the directories that wrap chose its policy with (review RCR-1); they go, and the record empties, once nothing runs or is being wrapped', async () => {
    const run = holdingRunner();
    const { f, srt } = await harness('linux', { runner: run });
    const names = ['.claude', '.git', '.idea', '.vscode'];
    const present = (): string[] => names.filter((name) => existsSync(join(f.share, name)));
    const record = async (): Promise<string[]> => (JSON.parse(await readFile(join(f.ctx.state.dir, 'sandbox-placeholders.json'), 'utf8')) as { paths: string[] }).paths.sort();
    const a = await f.sandbox.wrap(await specFor(f, { sessionId: 'ses_a' }));
    expect(present()).toEqual(names);
    // B's canary is held: B's policy was chosen while A's directories exist. A's process ends now.
    const hold = run.holdNext();
    const bWrap = f.sandbox.wrap(await specFor(f, { sessionId: 'ses_b' }));
    await hold.reached;
    const cleanups = srt.calls.cleanups;
    f.sandbox.release?.(a);
    expect(srt.calls.cleanups).toBe(cleanups + 1); // srt learns that A ended…
    expect(present()).toEqual(names); // …but nothing B relies on vanished
    hold.release();
    const b = await bWrap;
    expect(present()).toEqual(names);
    // every srt wrap of B (canary, session) saw the same existing directories: one policy, no child deny
    const bCalls = srt.calls.wrap.slice(-2);
    expect(bCalls[0]?.custom).toEqual(bCalls[1]?.custom);
    for (const name of names) expect(bCalls[1]?.custom.filesystem.denyWrite).toContain(join(f.share, name));
    expect(await record()).toEqual([...names, '.envrc', '.mcp.json'].map((name) => join(f.share, name)).sort());
    f.sandbox.release?.(b);
    expect(present()).toEqual([]); // at once: a wrap() starting now finds them gone, never vanishing under it
    await waitFor(async () => (await record()).length === 0, { what: 'the placeholder record to be emptied' });
  }, TIMEOUT);

  it('Linux: a wrap() that is refused gives its placeholders back at once', async () => {
    const { f } = await harness('linux', { runner: runner('no-marker') });
    expect((await refusal(f, await specFor(f))).detail).toEqual({ reason: 'self-test-failed' });
    expect(['.claude', '.git', '.idea', '.vscode'].filter((name) => existsSync(join(f.share, name)))).toEqual([]);
  }, TIMEOUT);

  it('Linux: after a clean stop the record is empty, so an empty directory the host makes before the next start survives it (review RCR-5); a dead daemon’s record outlives a daemon that ran no guest', async () => {
    const { f } = await harness('linux');
    const service = f.ctx.services.sandbox as SandboxServiceImpl;
    const doc = await f.ctx.state.document('sandbox-placeholders', z.object({ paths: z.array(z.string()) }), () => ({ paths: [] }));
    const w = await f.sandbox.wrap(await specFor(f));
    expect(doc.get().paths).toHaveLength(6);
    f.sandbox.release?.(w);
    await service.dispose(); // a clean stop
    expect(doc.get().paths).toEqual([]);
    const onDisk = JSON.parse(await readFile(join(f.ctx.state.dir, 'sandbox-placeholders.json'), 'utf8')) as { paths: string[] };
    expect(onDisk.paths).toEqual([]);
    await mkdir(join(f.share, '.vscode')); // the host's own, before adding a file to it
    const nextService = (): SandboxServiceImpl =>
      new SandboxServiceImpl(f.ctx, { platform: 'linux', loadSrt: async () => fakeSrt({ platform: 'linux', proxySockets: () => [join(f.runDir, 'claude-http-unit.sock')] }), runtime: new SrtRuntime(), runner: runner(), io: io(LINUX_EXEC) });
    const second = nextService();
    try {
      expect(await second.preflight()).toEqual({ ok: true, platform: 'linux' });
      expect(lstatSync(join(f.share, '.vscode')).isDirectory()).toBe(true);
    } finally {
      await second.dispose();
    }
    // A daemon that died left an empty `.claude` and its record; the next one runs no guest and stops cleanly…
    await mkdir(join(f.share, '.claude'));
    doc.update(() => ({ paths: [join(f.share, '.claude')] }));
    await doc.flush();
    await nextService().dispose();
    expect(doc.get().paths).toEqual([join(f.share, '.claude')]);
    // …so the one after it still removes the leftover before its first sandbox.
    const fourth = nextService();
    try {
      expect(await fourth.preflight()).toEqual({ ok: true, platform: 'linux' });
      expect(existsSync(join(f.share, '.claude'))).toBe(false);
      expect(lstatSync(join(f.share, '.vscode')).isDirectory()).toBe(true);
    } finally {
      await fourth.dispose();
    }
  }, TIMEOUT);

  it('Linux: a daemon whose working directory is in the share or a guest dir is refused (daemon-cwd), and its preflight says so; an ancestor of the share is fine (review linux-binary F1)', async () => {
    const { f, srt } = await harness('linux');
    const before = process.cwd();
    const guest = await f.guest('alice');
    await mkdir(join(f.share, 'src'), { recursive: true });
    try {
      for (const dir of [f.share, join(f.share, 'src'), guest.home]) {
        process.chdir(dir);
        const pre = await f.sandbox.preflight();
        if (dir === guest.home) expect(pre).toEqual({ ok: true, platform: 'linux' }); // the preflight looks at the share
        else expect(pre).toMatchObject({ ok: false, reason: 'daemon-cwd' });
        const err = await refusal(f, await specFor(f));
        expect(err.detail).toEqual({ reason: 'daemon-cwd' });
        expect(err.message).toContain('分享的資料夾以外');
      }
      expect(srt.calls.wrap.filter((call) => call.custom.filesystem.allowWrite.includes(f.share))).toEqual([]); // nothing of the session was wrapped
      expect(['.claude', '.git', '.idea', '.vscode'].filter((name) => existsSync(join(f.share, name)))).toEqual([]);
      expect(f.warnings().join('\n')).toContain('where the guest sandbox writes');
      process.chdir(dirname(f.share));
      expect(await f.sandbox.preflight()).toEqual({ ok: true, platform: 'linux' });
      f.sandbox.release?.(await f.sandbox.wrap(await specFor(f)));
    } finally {
      process.chdir(before);
    }
  }, TIMEOUT);

  it('Linux: a daemon whose working directory was removed while it ran is refused (daemon-cwd) with a text that says so, not "started inside the share" (review RV-4)', async () => {
    const { f } = await harness('linux');
    const before = process.cwd();
    const gone = join(f.base, 'daemon-cwd-gone');
    await mkdir(gone);
    try {
      process.chdir(gone);
      await rmdir(gone);
      const pre = await f.sandbox.preflight();
      expect(pre).toMatchObject({ ok: false, reason: 'daemon-cwd' });
      expect(pre.ok ? '' : pre.detail).toContain('工作目錄已經不存在');
      const err = await refusal(f, await specFor(f));
      expect(err.detail).toEqual({ reason: 'daemon-cwd' });
      expect(err.message).toContain('請主人重新執行 smurg host');
      expect(err.message).not.toContain('分享的資料夾裡面啟動');
      expect(f.warnings().join('\n')).toContain('cannot be resolved');
    } finally {
      process.chdir(before);
    }
  }, TIMEOUT);

  it('Linux: a protected entry the host changes while a guest process runs revokes that process (once; at once for a later listener) and tells the host; an in-place edit and other guests coming and going change nothing; a wrap() in flight meanwhile is refused (reviews RV-1, RV-2)', async () => {
    const run = holdingRunner();
    const { f } = await harness('linux', { runner: run, fixture: { files: { '.envrc': 'export A=1\n', 'sub/x.txt': 'x\n' } } });
    const service = f.ctx.services.sandbox;
    const events: unknown[] = [];
    f.ctx.bus.on('sandbox.protected-changed', (event) => events.push(event));
    const a = await f.sandbox.wrap(await specFor(f, { sessionId: 'ses_a' }));
    const revoked: unknown[] = [];
    const stop = f.sandbox.onRevoked?.(a, (revocation) => revoked.push(revocation));
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));
    // An in-place edit keeps the entry (the guest's mount holds), and another guest's process coming and going
    // (srt's mount points and the service's placeholders) is no change.
    await writeFile(join(f.share, '.envrc'), 'export A=2\n', { flag: 'a' });
    service.fileEvents?.(f.share, [{ path: join(f.share, '.envrc'), type: 'update' }]);
    f.sandbox.release?.(await f.sandbox.wrap(await specFor(f, { sessionId: 'ses_b' })));
    await settle();
    expect(revoked).toEqual([]);
    expect(events).toEqual([]);
    // The host's editor saves atomically, and the host makes a read-denied file in a subfolder: one batch.
    await writeFile(join(f.share, '.envrc.tmp'), 'export A=3\n');
    await rename(join(f.share, '.envrc.tmp'), join(f.share, '.envrc'));
    await writeFile(join(f.share, 'sub', 'CLAUDE.local.md'), 'notes\n');
    service.fileEvents?.(f.share, [
      { path: join(f.share, '.envrc.tmp'), type: 'delete' },
      { path: join(f.share, '.envrc'), type: 'create' },
      { path: join(f.share, 'sub', 'CLAUDE.local.md'), type: 'create' },
    ]);
    await waitFor(() => revoked.length > 0, { what: 'the revocation' });
    await settle();
    const paths = [join(f.share, '.envrc'), join(f.share, 'sub', 'CLAUDE.local.md')];
    expect(revoked).toEqual([{ root: f.share, paths }]);
    expect(events).toEqual([{ root: { kind: 'main' }, paths: ['.envrc', 'sub/CLAUDE.local.md'], more: 0, revoked: 1 }]);
    const late: unknown[] = [];
    f.sandbox.onRevoked?.(a, (revocation) => late.push(revocation));
    expect(late).toEqual([{ root: f.share, paths }]);
    expect(f.warnings().join('\n')).toContain('so they are ended');
    stop?.();
    f.sandbox.release?.(a);
    // A wrap() whose policy was chosen before the change (held at its canary) is not handed out.
    const c = await f.sandbox.wrap(await specFor(f, { sessionId: 'ses_c' }));
    const hold = run.holdNext();
    const inFlight = f.sandbox.wrap(await specFor(f, { sessionId: 'ses_d' })).then(
      () => null,
      (err: unknown) => err as SmurgError,
    );
    await hold.reached;
    await rmdir(join(f.share, '.vscode')); // the host's `git clean -fd` takes the service's empty placeholder
    service.fileEvents?.(f.share, [{ path: join(f.share, '.vscode'), type: 'delete' }]);
    await waitFor(() => events.length === 2, { what: 'the second notice' });
    hold.release();
    const refused = await inFlight;
    expect(refused).toBeInstanceOf(SmurgError);
    expect(refused?.detail).toEqual({ reason: 'protected-changed' });
    expect(refused?.message).toContain('請再試一次');
    expect((await refusedAudit(f)).map((entry) => entry.detail?.['reason'])).toContain('protected-changed');
    expect(events[1]).toEqual({ root: { kind: 'main' }, paths: ['.vscode'], more: 0, revoked: 1 });
    f.sandbox.release?.(c);
  }, TIMEOUT);

  it('Linux: the host\'s own empty directory made in place of a service placeholder while a guest runs is kept when the guest ends (review RV-3: the placeholder\'s inode is held, so the new one cannot reuse its number)', async () => {
    const { f } = await harness('linux');
    let kept = 0;
    for (let i = 0; i < 5; i++) {
      const wrapped = await f.sandbox.wrap(await specFor(f, { sessionId: `ses_e3_${i}` }));
      await rmdir(join(f.share, '.vscode'));
      await mkdir(join(f.share, '.vscode')); // the host's own, empty for now
      f.sandbox.release?.(wrapped);
      if (existsSync(join(f.share, '.vscode'))) kept++;
      await rmdir(join(f.share, '.vscode'));
    }
    expect(kept).toBe(5);
    expect(['.claude', '.git', '.idea'].filter((name) => existsSync(join(f.share, name)))).toEqual([]);
  }, TIMEOUT);

  it('Linux: oddly named directories a guest made in the share refuse nobody (review attack F1): control characters are denied literally, glob characters cannot be and are named in the log, once', async () => {
    const { f, srt } = await harness('linux');
    const p = (...rel: string[]): string => join(f.share, ...rel);
    for (const dir of [p('ev*il', '.git'), p('brack[et]'), p('ctl\u0001x', '.git'), p('nl\nline', '.claude'), p('sane', '.vscode')]) await mkdir(dir, { recursive: true });
    await writeFile(p('brack[et]', '.mcp.json'), '{}\n');
    await writeFile(p('sane', '.vscode', 'tasks.json'), '{}\n');
    const unprotectedLines = (): string[] => f.warnings().filter((line) => line.includes('guests can write this host-only entry'));
    // every guest's session starts, again and again
    for (const guestName of ['alice', 'bob', 'alice']) {
      const guest = await f.guest(guestName);
      const wrapped = await f.sandbox.wrap(f.spec({ sessionId: 'ses_unit', command: 'echo hi', guest, settingsDir: await f.settingsDir(`ses_${guestName}`, '{}\n') }));
      f.sandbox.release?.(wrapped);
      const denyWrite = srt.calls.wrap.at(-1)?.custom.filesystem.denyWrite ?? [];
      expect(denyWrite).toEqual(expect.arrayContaining([p('ctl\u0001x', '.git'), p('nl\nline', '.claude'), p('sane', '.vscode')]));
      // only the policy's own `<root>/**/<name>` patterns (srt drops them on Linux), no walked path with a glob character
      expect(denyWrite.filter((path) => /[*?[\]]/.test(path.replace(`${f.share}/**/`, '')))).toEqual([]);
    }
    expect(await refusedAudit(f)).toEqual([]);
    // named once per daemon, with why, the path quoted so no character of it can forge a log line
    expect(unprotectedLines()).toHaveLength(2);
    expect(unprotectedLines()[0]).toContain(`path=${JSON.stringify(p('brack[et]', '.mcp.json'))} why=glob-characters`);
    expect(unprotectedLines()[1]).toContain(`path=${JSON.stringify(p('ev*il', '.git'))} why=glob-characters`);
    // the session command: at most LINUX_GUEST_TASK_LIMIT tasks in the sandbox (review attack F2), set inside it
    expect(srt.calls.wrap.at(-1)?.command.startsWith(`ulimit -u ${LINUX_GUEST_TASK_LIMIT} 2>/dev/null; export TMPDIR=`)).toBe(true);
  }, TIMEOUT);

  it('Linux, a git share: while guest processes run, the absent placeholders are listed in .git/info/exclude (one block of the sandbox\'s own, the host\'s lines kept), so the host\'s `git add -A` / `git status` leave them alone; the block goes with them, and one a crashed daemon left goes before the first sandbox (review GR-4)', async () => {
    const { f } = await harness('linux', { fixture: { git: true } });
    const exclude = join(f.share, '.git', 'info', 'exclude');
    const git = async (...args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd: f.share, env: f.gitEnv() })).stdout;
    // The host's own line, and a block a crashed daemon left behind that names the host's own (untracked) .vscode.
    await writeFile(exclude, `${await readFile(exclude, 'utf8')}/build/\n${PLACEHOLDER_EXCLUDE_HEADER}\n/.vscode\n`);
    await mkdir(join(f.share, '.vscode'));
    await writeFile(join(f.share, '.vscode', 'settings.json'), '{}\n');
    const wrapped = await f.sandbox.wrap(await specFor(f));
    const during = await readFile(exclude, 'utf8');
    expect(during.split(PLACEHOLDER_EXCLUDE_HEADER)).toHaveLength(2); // one block: the crashed daemon's went first
    expect(during.split(`${PLACEHOLDER_EXCLUDE_HEADER}\n`)[1]).toBe('/.claude\n/.envrc\n/.idea\n/.mcp.json\n');
    expect(during).toContain('/.smurg/');
    expect(during).toContain('/build/\n');
    for (const name of ['.mcp.json', '.envrc', '.claude', '.idea']) expect(existsSync(join(f.share, name)), name).toBe(true);
    // The host's git sees its own new file and none of the placeholders.
    expect(await git('status', '--porcelain', '--untracked-files=all')).toBe('?? .vscode/settings.json\n');
    await git('add', '-A');
    expect(await git('diff', '--cached', '--name-only')).toBe('.vscode/settings.json\n');
    f.sandbox.release?.(wrapped);
    const after = await readFile(exclude, 'utf8');
    expect(after).not.toContain(PLACEHOLDER_EXCLUDE_HEADER);
    expect(after).toContain('/.smurg/');
    expect(after.endsWith('/build/\n')).toBe(true);
  }, TIMEOUT);

  it("Linux: srt's cleanup takes its own empty mount points, never the host's own empty file that took the name while a guest ran (a `git checkout` of a branch that tracks an empty .envrc; review GR-4)", async () => {
    let share = '';
    const { f } = await harness('linux', {
      srt: {
        platform: 'linux',
        // What srt does when its count of wrapped commands is back to zero: every tracked path that is an empty file goes.
        onMountPointCleanup: () => {
          for (const name of ['.mcp.json', '.envrc']) {
            try {
              const st = statSync(join(share, name));
              if (st.isFile() && st.size === 0) unlinkSync(join(share, name));
            } catch {
              // absent
            }
          }
        },
      },
    });
    share = f.share;
    const wrapped = await f.sandbox.wrap(await specFor(f));
    expect((lstatSync(join(f.share, '.envrc')).mode & 0o777).toString(8)).toBe('444');
    await unlink(join(f.share, '.envrc'));
    await writeFile(join(f.share, '.envrc'), '', { mode: 0o644 }); // the checkout's tracked empty file
    f.sandbox.release?.(wrapped);
    expect(existsSync(join(f.share, '.mcp.json'))).toBe(false); // srt's own: gone
    const kept = lstatSync(join(f.share, '.envrc'));
    expect([kept.isFile(), kept.size, (kept.mode & 0o777).toString(8)]).toEqual([true, 0, '644']);
    expect(readdirSync(f.share).filter((name) => name.includes('.smurg-'))).toEqual([]);
  }, TIMEOUT);

  it('Linux: a placeholder the host removed while something of the service still ran, made again by a later wrap(), does not keep the earlier one\'s descriptor open (review GR-8)', async () => {
    const { f } = await harness('linux', { service: { guardPollMs: 3_600_000 } });
    const keep = await f.sandbox.wrap(await specFor(f, { sessionId: 'ses_keep' })); // the service stays live
    const own = (f.ctx.services.sandbox as unknown as { ownPlaceholders: Map<string, { readonly ino: bigint; readonly fd: number | null }> }).ownPlaceholders;
    const vscode = join(f.share, '.vscode');
    const held: { readonly fd: number; readonly ino: bigint }[] = [];
    const record = (): void => {
      const entry = own.get(vscode);
      if (entry !== undefined && entry.fd !== null) held.push({ fd: entry.fd, ino: entry.ino });
    };
    record();
    for (let round = 0; round < 4; round++) {
      await rmdir(vscode); // the host's `git clean -fd`
      const again = await f.sandbox.wrap(await specFor(f, { sessionId: `ses_again_${round}` }));
      f.sandbox.release?.(again);
      record();
    }
    expect(held).toHaveLength(5);
    // Every earlier descriptor was closed: none of them still holds its (removed) directory.
    const leaked = held.slice(0, -1).filter(({ fd, ino }) => {
      try {
        return fstatSync(fd, { bigint: true }).ino === ino;
      } catch {
        return false;
      }
    });
    expect(leaked).toEqual([]);
    f.sandbox.release?.(keep);
  }, TIMEOUT);

  it("Linux: what the sandbox makes and removes at the top of a root for a guest (its placeholder directories, srt's mount points) is the system's change, not an external one (the activity feed and the audit log said 「外部程式」 changed .claude, .mcp.json, … at every guest start and end); the host's own change of a file is still external", async () => {
    let share = '';
    const { f } = await harness('linux', {
      // srt at count zero: every tracked path that is an empty file goes.
      srt: {
        platform: 'linux',
        onMountPointCleanup: () => {
          for (const name of ['.mcp.json', '.envrc']) {
            try {
              const st = statSync(join(share, name));
              if (st.isFile() && st.size === 0) unlinkSync(join(share, name));
            } catch {
              // absent
            }
          }
        },
      },
      fixture: { extraModules: [filesModule] },
    });
    share = f.share;
    await waitFor(() => filesInstanceOf(f.ctx)?.watcher?.watchedRoots().includes('main') === true, { what: 'the file watcher on the share' });
    const changes: FileChange[] = [];
    f.ctx.bus.on('file.changed', (event) => {
      if (event.root.kind === 'main') changes.push(...event.changes);
    });
    const names = ['.claude', '.vscode', '.idea', '.mcp.json', '.envrc'];
    const srtFiles = ['.mcp.json', '.envrc'];
    const wrapped = await f.sandbox.wrap(await specFor(f));
    await waitFor(() => srtFiles.every((name) => changes.some((c) => c.path === name)), { timeoutMs: 15_000, what: "the watcher reporting srt's mount points" });
    f.sandbox.release?.(wrapped);
    expect(names.filter((name) => existsSync(join(f.share, name)))).toEqual([]);
    await waitFor(() => srtFiles.every((name) => changes.some((c) => c.path === name && c.change === 'unlink')), { timeoutMs: 15_000, what: 'the watcher reporting their removal' });
    await writeFile(join(f.share, 'host-notes.txt'), 'the host writes\n');
    await waitFor(() => changes.some((c) => c.path === 'host-notes.txt'), { timeoutMs: 15_000, what: "the host's own change" });
    expect(changes.filter((c) => names.includes(c.path) && c.by?.kind !== 'system')).toEqual([]);
    expect(changes.find((c) => c.path === 'host-notes.txt')?.by).toBeUndefined();
  }, TIMEOUT);

  it('Linux: the log of host-only entries guests can write says once that it is full, then nothing more (review GR-9: every wrap logged 21 lines once 1000 names were remembered)', () => {
    const log = createMemoryLogger();
    const ctx = { log } as unknown as ConstructorParameters<typeof SandboxServiceImpl>[0];
    const service = new SandboxServiceImpl(ctx, { platform: 'linux', runner: runner(), kernelRelease: () => '6.8.0-85-generic' }) as unknown as {
      warnUnprotected(entries: { path: string; reason: 'glob-characters' | 'not-utf8' }[]): void;
    };
    const batch = (k: number): { path: string; reason: 'glob-characters' }[] => Array.from({ length: 999 }, (_, i) => ({ path: `/share/g${k}*${i}/.git`, reason: 'glob-characters' }));
    const renamed = batch(2);
    const perWrap: number[] = [];
    for (const entries of [batch(1), renamed, renamed, renamed, renamed]) {
      const before = log.lines.length;
      service.warnUnprotected(entries);
      perWrap.push(log.lines.length - before);
    }
    expect(perWrap).toEqual([21, 21, 1, 0, 0]);
    expect(log.lines.at(-1)?.message).toContain('no more are named until smurg restarts');
  });

  it('Linux: a wrap() in flight when the daemon stops is refused as such, not as a protected entry that changed (review GR-10)', async () => {
    const run = holdingRunner();
    const { f } = await harness('linux', { runner: run });
    const hold = run.holdNext();
    const inFlight = f.sandbox.wrap(await specFor(f)).then(
      () => null,
      (err: unknown) => err as SmurgError,
    );
    await hold.reached;
    // What SandboxServiceImpl.dispose() does first: the guard goes.
    ((f.ctx.services.sandbox as unknown as { guard: { dispose(): void } }).guard).dispose();
    hold.release();
    const refused = await inFlight;
    expect(refused).toBeInstanceOf(SmurgError);
    expect(refused?.detail).toEqual({ reason: 'wrap-failed' });
    expect(refused?.message).not.toContain('請再試一次');
    expect((await refusedAudit(f)).map((entry) => entry.detail?.['reason'])).toEqual(['wrap-failed']);
  }, TIMEOUT);

  it('Linux: more than 1000 CLAUDE.local.md below the top of the root refuse the wrap like more than 1000 host-only entries, instead of a different subset on every wrap (review GR-6)', async () => {
    const { f } = await harness('linux');
    for (let i = 0; i <= 1000; i += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 1001 - i) }, async (_, k) => {
          await mkdir(join(f.share, `g${(i + k) % 37}`, `p${i + k}`), { recursive: true });
          await writeFile(join(f.share, `g${(i + k) % 37}`, `p${i + k}`, 'CLAUDE.local.md'), 'x\n');
        }),
      );
    }
    const err = await refusal(f, await specFor(f));
    expect(err.detail).toEqual({ reason: 'policy-invalid' });
    expect(f.warnings().join('\n')).toContain('CLAUDE.local.md');
  }, TIMEOUT);

  it('macOS: the same share needs no literal list: Seatbelt denies every host-only name at any depth by pattern, nothing is logged, no task limit is set', async () => {
    const { f, srt } = await harness('darwin');
    const p = (...rel: string[]): string => join(f.share, ...rel);
    for (const dir of [p('ev*il', '.git'), p('brack[et]'), p('ctl\u0001x', '.git'), p('nl\nline', '.claude'), p('sane', '.vscode')]) await mkdir(dir, { recursive: true });
    await writeFile(p('brack[et]', '.mcp.json'), '{}\n');
    for (const guestName of ['alice', 'bob']) {
      const guest = await f.guest(guestName);
      await f.sandbox.wrap(f.spec({ sessionId: 'ses_unit', command: 'echo hi', guest, settingsDir: await f.settingsDir(`ses_${guestName}`, '{}\n') }));
    }
    const denyWrite = srt.calls.wrap.at(-1)?.custom.filesystem.denyWrite ?? [];
    for (const name of ['.git', '.claude', '.vscode', '.mcp.json']) expect(denyWrite).toContain(`${f.share}/**/${name}`);
    expect(denyWrite.filter((path) => path.startsWith(`${f.share}/`) && !path.includes('/**/') && path.split('/').length > f.share.split('/').length + 1)).toEqual([]);
    expect(f.warnings()).toEqual([]);
    expect(srt.calls.wrap.at(-1)?.command.startsWith('export TMPDIR=')).toBe(true);
  }, TIMEOUT);

  it('Linux: the task limit needs a kernel that counts tasks per user namespace (5.14 or later, review attack F2); on an older one it is left out and the host is told once', async () => {
    for (const [release, counts] of [
      ['6.8.0-85-generic', true],
      ['5.14.0-427.el9.x86_64', true],
      ['5.15.0-1', true],
      ['10.0', true],
      ['5.13.19', false],
      ['5.10.0-28-amd64', false],
      ['4.19.0', false],
      ['', false],
      ['unknown', false],
      ['5', false],
    ] as const) {
      expect(linuxCountsTasksPerUserNamespace(release), release).toBe(counts);
    }
    const { f, srt } = await harness('linux', { service: { kernelRelease: () => '5.10.0-28-amd64' } });
    for (const guestName of ['alice', 'bob']) {
      const guest = await f.guest(guestName);
      const wrapped = await f.sandbox.wrap(f.spec({ sessionId: 'ses_unit', command: 'echo hi', guest, settingsDir: await f.settingsDir(`ses_${guestName}`, '{}\n') }));
      f.sandbox.release?.(wrapped);
      expect(srt.calls.wrap.at(-1)?.command.startsWith('export TMPDIR=')).toBe(true);
    }
    const told = f.warnings().filter((line) => line.includes('guest sandboxes get no task limit'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('kernel=5.10.0-28-amd64');
    expect(await refusedAudit(f)).toEqual([]);
  }, TIMEOUT);

  it('macOS: the working directory does not matter (srt’s denies there are patterns, no mount points)', async () => {
    const { f } = await harness('darwin');
    const before = process.cwd();
    try {
      process.chdir(f.share);
      expect(await f.sandbox.preflight()).toEqual({ ok: true, platform: 'darwin' });
      await f.sandbox.wrap(await specFor(f));
    } finally {
      process.chdir(before);
    }
  }, TIMEOUT);

  it('macOS: the session command is exported into the guest tmp and hardened; the self-test used the same policy', async () => {
    const { f, srt, run } = await harness('darwin');
    const spec = await specFor(f, { command: 'exec claude --settings x' });
    const wrapped = await f.sandbox.wrap(spec);
    expect(wrapped).toMatchObject({ file: '/bin/bash', cwd: f.share, env: spec.env });
    expect(wrapped.args[1]).toContain('exec claude --settings x');
    const [selfTest, session] = srt.calls.wrap;
    const tmp = shellQuote(spec.env['TMPDIR'] as string);
    expect(session?.command).toBe(`export TMPDIR=${tmp} CLAUDE_CODE_TMPDIR=${tmp}; exec claude --settings x`);
    expect(selfTest?.custom).toEqual(session?.custom);
    expect(run.runs[0]?.cwd).toBe(f.share);
  }, TIMEOUT);
});

describe('live network allow-list (updateConfig with the WHOLE configuration)', () => {
  it('host settings changes reach srt through the bus; invalid entries are dropped', async () => {
    const { f, srt } = await harness('darwin');
    expect((await f.sandbox.preflight()).ok).toBe(true);
    await f.setAllowedDomains(['api.anthropic.com', '*.claude.ai']);
    await new Promise((resolve) => setImmediate(resolve));
    const update = srt.calls.update.at(-1);
    expect(update?.network.allowedDomains).toEqual(['api.anthropic.com', '*.claude.ai']);
    // the whole configuration, not only the network part
    expect(update).toEqual(buildBaseConfig({ platform: 'darwin', hostHome: f.home, stateDir: f.stateDir, hookSocketPath: f.ctx.config.runPaths.hook, allowedDomains: ['api.anthropic.com', '*.claude.ai'] }));
    await f.sandbox.setAllowedDomains(['example.com', 'NOT A DOMAIN', 'https://x.example']);
    expect(srt.calls.update.at(-1)?.network.allowedDomains).toEqual(['example.com']);
  }, TIMEOUT);

  it('a failed update closes the network for running guests and refuses every later wrap', async () => {
    const { f, srt } = await harness('darwin', { srt: { platform: 'darwin', updateError: new Error('bad range') } });
    expect((await f.sandbox.preflight()).ok).toBe(true);
    const err = await f.sandbox.setAllowedDomains(['example.com']).then(
      () => null,
      (e: unknown) => e as SmurgError,
    );
    expect(err?.detail).toEqual({ reason: 'config-update-failed' });
    expect(srt.calls.update.map((c) => c.network.allowedDomains)).toEqual([['example.com'], []]);
    expect((await refusal(f, await specFor(f))).detail).toEqual({ reason: 'config-update-failed' });
  }, TIMEOUT);

  it('before srt is initialized, a change is only remembered (initialize uses it)', async () => {
    const { f, srt } = await harness('darwin');
    await f.ctx.settings.update({ allowedDomains: ['pypi.org'] }, SYSTEM_PRINCIPAL);
    expect(srt.calls.update).toHaveLength(0);
    expect((await f.sandbox.preflight()).ok).toBe(true);
    expect(srt.calls.initialize[0]?.network.allowedDomains).toEqual(['pypi.org']);
  }, TIMEOUT);

  it('the daemon’s stop resets srt (proxies closed)', async () => {
    const { f, srt } = await harness('darwin');
    expect((await f.sandbox.preflight()).ok).toBe(true);
    await f.daemon.stop();
    expect(srt.calls.reset).toBe(1);
  }, TIMEOUT);
});

describe('SrtRuntime: one owner per process', () => {
  const config = buildBaseConfig({ platform: 'darwin', hostHome: '/Users/h', stateDir: '/Users/h/.smurg', hookSocketPath: '/tmp/r/a.hook', allowedDomains: [] });

  it('a second daemon in the same process is refused until the first releases srt', async () => {
    const runtime = new SrtRuntime();
    const srt: SrtApi = fakeSrt({ platform: 'darwin' });
    const a = {};
    const b = {};
    await runtime.acquire(a, srt, config);
    await expect(runtime.acquire(b, srt, config)).rejects.toBeInstanceOf(RuntimeBusyError);
    await expect(runtime.wrap(b, 'x', '/bin/bash', { filesystem: config.filesystem, credentials: { envVars: [] }, allowPty: true })).rejects.toBeInstanceOf(RuntimeBusyError);
    await runtime.release(a);
    await runtime.acquire(b, srt, config);
    expect(runtime.isOwnedBy(b)).toBe(true);
    await runtime.release(b);
  });

  it('the owner acquiring again with a changed config applies it with updateConfig; nothing is wrapped before initialize', async () => {
    const runtime = new SrtRuntime();
    const srt = fakeSrt({ platform: 'darwin' });
    const owner = {};
    await expect(runtime.wrap(owner, 'x', '/bin/bash', { filesystem: config.filesystem, credentials: { envVars: [] }, allowPty: true })).rejects.toBeInstanceOf(RuntimeBusyError);
    expect(srt.calls.wrap).toHaveLength(0);
    await runtime.acquire(owner, srt, config);
    await runtime.acquire(owner, srt, config);
    expect(srt.calls.update).toHaveLength(0);
    await runtime.acquire(owner, srt, { ...config, network: { ...config.network, allowedDomains: ['a.example'] } });
    expect(srt.calls.initialize).toHaveLength(1);
    expect(srt.calls.update).toHaveLength(1);
    await runtime.release(owner);
  });
});

// ARCHITECTURE §11 D-12, the login process with a fake srt and an injected platform: the wiring of mode 'login'.
// macOS runs it for real in login-policy.real.test.ts, Linux in test/sessions/login.real.test.ts (its own network namespace).
describe('the login process (D-12, service wiring)', () => {
  async function loginSpec(f: SandboxFixture, programs: readonly string[] = ['/usr/bin/true']): Promise<SandboxSpec> {
    const guest = await f.guest('alice');
    return { ...f.spec({ sessionId: 'ses_login_unit', command: 'echo login', guest, settingsDir: await f.settingsDir('ses_login_unit', '{}\n'), rootPath: guest.home }), loginProcess: true, loginPrograms: programs } as SandboxSpec;
  }

  it('macOS: mode login (guest dir only), the listen rules and the exec allow-list on the real command, not on the canary', async () => {
    const { f, srt } = await harness('darwin');
    const wrapped = await f.sandbox.wrap(await loginSpec(f, ['/usr/bin/true']));
    const custom = srt.calls.wrap.at(-1)?.custom;
    expect(custom?.filesystem.allowWrite).toEqual([(await f.guest('alice')).dir]);
    expect(custom?.filesystem.denyRead).toEqual(expect.arrayContaining([f.share, f.ctx.roots.worktreesDir]));
    expect(custom?.filesystem.allowRead).not.toContain(f.ctx.config.runPaths.hook);
    expect(wrapped.args[1]).toContain('(allow network-bind (local tcp "localhost:*"))');
    expect(wrapped.args[1]).toContain('(allow network-inbound (local tcp "localhost:*"))');
    // The allow-list names the shell as Seatbelt sees it, resolved (/bin/bash on macOS; /usr/bin/bash where /bin is a
    // link, as on the Linux machines this injected-platform test also runs on).
    expect(wrapped.args[1]).toContain(`(allow process-exec (literal ${JSON.stringify(realpathSync('/bin/bash'))}) (literal "/usr/bin/true"))`);
    expect(wrapped.cwd).toBe((await f.guest('alice')).home);
    // The canary ran before, with the login's network rules but without the exec list (it needs cat, ls, stty).
    const canary = srt.calls.wrap.find((c) => c.command.includes('SMURG-SANDBOX-SELFTEST-OK'));
    expect(canary).toBeDefined();
  }, TIMEOUT);

  it('Linux: the login runs in its own network namespace (its loopback is not the host’s); without --unshare-net nothing starts', async () => {
    const { f, srt } = await harness('linux');
    const wrapped = await f.sandbox.wrap(await loginSpec(f));
    const guest = await f.guest('alice');
    expect(wrapped.args[1]).toContain(' --unshare-net ');
    expect(wrapped.args[1]).toContain(' --disable-userns ');
    expect(wrapped.args[1]).not.toContain('process-exec');
    expect(wrapped.cwd).toBe(guest.home);
    const custom = srt.calls.wrap.at(-1)?.custom;
    expect(custom?.filesystem.allowWrite).toEqual([guest.dir]);
    expect(custom?.filesystem.denyRead).toEqual(expect.arrayContaining([f.share, f.ctx.roots.worktreesDir]));
    expect(custom?.filesystem.allowRead).not.toContain(f.ctx.config.runPaths.hook);
    // srt's bridge socket (the login reaches claude.ai through the proxy like any guest process)
    expect(custom?.filesystem.allowRead).toContain(join(f.runDir, 'claude-http-unit.sock'));
    await f.cleanup(); // a second fixture follows (afterEach removes only the current one)
    // Without its own network namespace a guest process would have the host's network (srt's proxy and its
    // allow-list would be bypassable): the login AND an ordinary guest process are refused.
    const { f: g } = await harness('linux', { srt: { platform: 'linux', wrapResult: (command) => syntheticLinuxCommand(command).replace(' --unshare-net', '') } });
    expect((await refusal(g, await specFor(g))).detail).toEqual({ reason: 'hardening-failed' });
    expect((await refusal(g, await loginSpec(g))).detail).toEqual({ reason: 'hardening-failed' });
    expect(g.warnings().join('\n')).toContain('--unshare-net');
  }, TIMEOUT);
});
