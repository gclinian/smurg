// The in-sandbox hook self-test (review SEC-D-05 follow-up) with the REAL srt, the REAL hook server and the REAL
// `smurg hook` (node + packages/cli/src/main.ts, how sessions run it in development): before a guest AGENT session
// starts, the sandbox runs the hook inside that session's own policy with a probe event and requires the daemon's
// answer. Claude Code lets a tool run when its hook cannot start, so a hook that cannot start inside the sandbox means
// no file locks: such a session is refused (sandbox_unavailable, reason hook-self-test-failed, audited).
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SmurgError } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookServer, SandboxSpec } from '../../src/core/interfaces.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { createSandboxFixture, guestEnv, printWarningsOnFailure, sandboxPlatform, type SandboxFixture, type SandboxFixtureOptions } from './helpers.ts';

const TIMEOUT = 90_000;
const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url));
const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));

let current: SandboxFixture | undefined;

afterEach(async (context) => {
  printWarningsOnFailure(current, context);
  await current?.cleanup();
  current = undefined;
});

async function fixture(options: Omit<SandboxFixtureOptions, 'extraModules'> = {}): Promise<SandboxFixture> {
  current = await createSandboxFixture({ selfCommand: { file: process.execPath, args: [CLI_MAIN] }, ...options, extraModules: [hooksModule] });
  return current;
}

/** A registered agent session's spec (the hook token and socket in its environment), in main or worktree mode. */
async function agentSpec(f: SandboxFixture, sessionId: string, root: { readonly worktreeId: string; readonly dir: string } | null = null): Promise<SandboxSpec> {
  const hooks: HookServer = f.ctx.services.hooks;
  const credentials = hooks.registerSession({ sessionId, ownerUserId: 'dev:alice', agentName: 'Claude（alice）', root: root === null ? { kind: 'main' } : { kind: 'worktree', worktreeId: root.worktreeId }, sandboxed: true });
  const guest = await f.guest('alice');
  const base = f.spec({ sessionId, command: 'echo agent-started', guest, settingsDir: await f.settingsDir(sessionId, '{}\n'), env: { ...guestEnv(guest), ...credentials.env } });
  if (root === null) return base;
  const worktreesDir = f.ctx.roots.worktreesDir;
  return { ...base, rootPath: root.dir, denyReadPaths: [f.share, worktreesDir], denyWritePaths: [f.share, worktreesDir] };
}

async function refusal(f: SandboxFixture, spec: SandboxSpec): Promise<SmurgError> {
  const err = await f.sandbox.wrap(spec).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SmurgError);
  return err as SmurgError;
}

async function refusals(f: SandboxFixture): Promise<unknown[]> {
  return (await f.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'sandbox.refused').map((entry) => entry.detail);
}

describe.runIf(sandboxPlatform)('the in-sandbox hook self-test before a guest agent session (SEC-D-05 follow-up, real srt + real hook)', () => {
  it('main mode: the real `smurg hook` starts inside the session policy, reaches the socket and answers for this session', async () => {
    const f = await fixture();
    const started = Date.now();
    await expect(f.sandbox.wrap(await agentSpec(f, 'ses_probe_main'))).resolves.toMatchObject({ cwd: f.share });
    console.info(`[hook-selftest] main-mode wrap incl. canary + hook self-test: ${Date.now() - started} ms`);
    expect(await refusals(f)).toEqual([]);
  }, TIMEOUT);

  it('worktree mode: the same, with the share and the sibling worktrees denied', async () => {
    const f = await fixture({ git: true });
    const dir = join(f.share, '.smurg', 'worktrees', 'wt_probe');
    await mkdir(dir, { recursive: true });
    await f.ctx.roots.registerWorktree({ worktreeId: 'wt_probe', dir, ownerUserId: 'dev:alice', sharedLinks: [] });
    const real = await realpath(dir);
    await expect(f.sandbox.wrap(await agentSpec(f, 'ses_probe_wt', { worktreeId: 'wt_probe', dir: real }))).resolves.toMatchObject({ cwd: real });
    expect(await refusals(f)).toEqual([]);
  }, TIMEOUT);

  it('a hook entry point the guest cannot read (a script in the host home) is refused: hook-self-test-failed, audited — the static check alone let it through', async () => {
    const f = await fixture({ selfCommand: { file: '/bin/bash', args: ['./tools/smurg-hook.sh'] } });
    await mkdir(join(f.home, 'tools'), { recursive: true });
    await writeFile(join(f.home, 'tools', 'smurg-hook.sh'), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_MAIN)} hook\n`, { mode: 0o755 });
    const refused = await refusal(f, await agentSpec(f, 'ses_probe_unreadable'));
    expect(refused.code).toBe('sandbox_unavailable');
    expect(refused.detail).toEqual({ reason: 'hook-self-test-failed' });
    expect(await refusals(f)).toEqual([expect.objectContaining({ reason: 'hook-self-test-failed' })]);
  }, TIMEOUT);

  it('an entry point the guest can read that loads its code from where it cannot (outside the carve-outs) is refused', async () => {
    const f = await fixture({ selfCommand: { file: process.execPath, args: ['./bin/smurg-entry.mjs'] } });
    await mkdir(join(f.home, 'bin'), { recursive: true });
    await writeFile(join(f.home, 'bin', 'smurg-entry.mjs'), `const { runHookCli } = await import(${JSON.stringify(HOOK_CLI)});\nprocess.exitCode = await runHookCli();\n`);
    const refused = await refusal(f, await agentSpec(f, 'ses_probe_import'));
    expect(refused.detail).toEqual({ reason: 'hook-self-test-failed' });
  }, TIMEOUT);

  it('the hook socket missing is refused, and so is a token the daemon does not know', async () => {
    const f = await fixture();
    const spec = await agentSpec(f, 'ses_probe_nosocket');
    const socket = f.ctx.config.runPaths.hook;
    await rename(socket, `${socket}.away`);
    try {
      expect((await refusal(f, spec)).detail).toEqual({ reason: 'hook-self-test-failed' });
    } finally {
      await rename(`${socket}.away`, socket);
    }
    await expect(f.sandbox.wrap(spec)).resolves.toMatchObject({ cwd: f.share }); // back: the control
    f.ctx.services.hooks.unregisterSession('ses_probe_nosocket');
    expect((await refusal(f, spec)).detail).toEqual({ reason: 'hook-self-test-failed' });
  }, TIMEOUT);
});
