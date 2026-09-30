// SandboxService with injected seams (platform, srt, the pty runner, file checks): every refusal reason, the Linux
// branch (implemented from docs/research/sandbox.md and srt's source; it cannot run on this macOS machine, so it is
// unit-tested here and listed as unverified), live allow-list changes, and the process-wide srt runtime.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError, type AuditEntry } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '../../src/core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { APPARMOR_USERNS_SYSCTL, srtSocketDirProblem, type CheckIo } from '../../src/sandbox/checks.ts';
import { createSandboxModule } from '../../src/sandbox/module.ts';
import { SrtRuntime, RuntimeBusyError, type SrtApi } from '../../src/sandbox/runtime.ts';
import { SandboxServiceImpl, type SandboxServiceOptions } from '../../src/sandbox/service.ts';
import type { PtyRunInput, PtyRunResult, PtyRunner } from '../../src/sandbox/selftest.ts';
import { buildBaseConfig } from '../../src/sandbox/policy.ts';
import { shellQuote } from '../../src/sandbox/harden.ts';
import { createSandboxFixture, printWarningsOnFailure, type SandboxFixture, type SandboxFixtureOptions } from './helpers.ts';
import { fakeSrt, syntheticDarwinCommand, syntheticDarwinProfile, syntheticLinuxCommand, type FakeSrt, type FakeSrtOptions } from './synthetic-srt.ts';

const TIMEOUT = 60_000;
const DARWIN_EXEC = new Set(['/usr/bin/sandbox-exec']);
const LINUX_EXEC = new Set(['/usr/bin/bwrap', '/usr/bin/socat', '/usr/bin/rg']);

function io(executable: ReadonlySet<string>, texts: Readonly<Record<string, string>> = {}): CheckIo {
  return { isExecutable: async (path) => executable.has(path), readText: async (path) => texts[path] ?? null };
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
          const { readFile } = await import('node:fs/promises');
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
  const srt = fakeSrt(options.srt ?? { platform: platform === 'linux' ? 'linux' : 'darwin' });
  const run = options.runner ?? runner();
  const module = createSandboxModule({
    platform,
    loadSrt: async () => srt,
    runtime: new SrtRuntime(),
    runner: run,
    io: io(platform === 'linux' ? LINUX_EXEC : DARWIN_EXEC),
    ...options.service,
  });
  current = await createSandboxFixture({ ...options.fixture, module });
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
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'unsupported-platform' });
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

  it('Linux: a failed self-test while AppArmor restricts user namespaces names the AppArmor fix', async () => {
    const run = runner('exit1');
    const { f } = await harness('linux', { runner: run, service: { io: io(LINUX_EXEC, { [APPARMOR_USERNS_SYSCTL]: '1\n' }) } });
    const pre = await f.sandbox.preflight();
    expect(pre).toMatchObject({ ok: false, reason: 'apparmor-userns' });
    if (pre.ok) return;
    expect(pre.detail).toContain('AppArmor');
    expect(pre.detail).toContain('apparmor_restrict_unprivileged_userns');
    expect(run.runs).toHaveLength(1);
  }, TIMEOUT);

  it('Linux: the same failure without the AppArmor restriction is a plain self-test failure', async () => {
    const { f } = await harness('linux', { runner: runner('exit1'), service: { io: io(LINUX_EXEC, { [APPARMOR_USERNS_SYSCTL]: '0\n' }) } });
    expect(await f.sandbox.preflight()).toMatchObject({ ok: false, reason: 'self-test-failed' });
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
  it('Linux (unverified at runtime): absolute tools, all Unix sockets with their directories hidden, bwrap exec’d', async () => {
    const { f, srt, run } = await harness('linux');
    expect(await f.sandbox.preflight()).toEqual({ ok: true, platform: 'linux' });
    const base = srt.calls.initialize[0];
    expect(base).toMatchObject({ bwrapPath: '/usr/bin/bwrap', socatPath: '/usr/bin/socat', ripgrep: { command: '/usr/bin/rg' }, network: { allowAllUnixSockets: true, allowUnixSockets: [f.ctx.config.runPaths.hook] } });
    expect(base?.filesystem.denyRead).toEqual(expect.arrayContaining(['/run', '/var/run', '/home', '/tmp', f.home, f.stateDir]));
    const wrapped = await f.sandbox.wrap(await specFor(f));
    expect(wrapped.args[1]?.startsWith('exec /usr/bin/bwrap --new-session --die-with-parent ')).toBe(true);
    expect(wrapped.args[1]).toContain('CLAUDE_CODE_TMPDIR=');
    expect(run.runs).toHaveLength(2); // the preflight's self-test and the session's own
    expect(srt.calls.wrap.at(-1)?.custom.filesystem.allowRead).toContain(f.ctx.config.runPaths.hook);
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
// macOS runs it for real in login-policy.real.test.ts; Linux is implemented from srt's source and UNVERIFIED at runtime.
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
    expect(wrapped.args[1]).toContain('(allow process-exec (literal "/bin/bash") (literal "/usr/bin/true"))');
    expect(wrapped.cwd).toBe((await f.guest('alice')).home);
    // The canary ran before, with the login's network rules but without the exec list (it needs cat, ls, stty).
    const canary = srt.calls.wrap.find((c) => c.command.includes('SMURG-SANDBOX-SELFTEST-OK'));
    expect(canary).toBeDefined();
  }, TIMEOUT);

  it('Linux (unverified at runtime): the login needs its own network namespace; without --unshare-net it is refused', async () => {
    const { f } = await harness('linux');
    const wrapped = await f.sandbox.wrap(await loginSpec(f));
    expect(wrapped.args[1]).toContain(' --unshare-net ');
    expect(wrapped.args[1]).not.toContain('process-exec');
    await f.cleanup(); // a second fixture follows (afterEach removes only the current one)
    const { f: g } = await harness('linux', { srt: { platform: 'linux', wrapResult: (command) => syntheticLinuxCommand(command).replace(' --unshare-net', '') } });
    // An ordinary guest process still starts (its loopback isolation is srt's business; this check is the login's).
    await expect(g.sandbox.wrap(await specFor(g))).resolves.toBeDefined();
    const refused = await refusal(g, await loginSpec(g));
    expect(refused.detail).toEqual({ reason: 'hardening-failed' });
  }, TIMEOUT);
});
