// `smurg status` and `smurg stop` through their modules (injected io) against a daemon whose state dir is SMURG_HOME,
// so the CLI finds its control socket as in production. zh-TW output and exit codes (3 when nothing runs).
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, createDaemon, silentLogger, type Daemon } from '@smurg/daemon';
import { waitFor } from '@smurg/daemon/testing';
import { runCli } from '../src/cli/run.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { statePaths } from '../src/state/paths.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)().catch(() => {});
});

async function hostDaemon(dirs: Dirs, workspaceId: string, folder = dirs.project): Promise<Daemon> {
  const daemon = await createDaemon({
    config: { stateDir: dirs.stateDir, shareDir: folder, workspaceId, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
    modules: DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local'),
    log: silentLogger,
    homeDir: dirs.home,
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  return daemon;
}

async function setup(): Promise<{ dirs: Dirs; env: Record<string, string> }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  return { dirs, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } };
}

describe('smurg status', () => {
  it('says that nothing is shared (exit 3) when no daemon runs', async () => {
    const { env } = await setup();
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(3);
    expect(io.out()).toContain('No workspace is being shared.');
  });

  it('lists every running daemon with its relay, connections, fingerprint, keep-awake, the Bash-attribution switch and log file', async () => {
    const { dirs, env } = await setup();
    const a = await hostDaemon(dirs, 'ws_status_aaaaaaaaaaaa');
    const other = join(dirs.home, 'other');
    await (await import('node:fs/promises')).mkdir(other);
    await hostDaemon(dirs, 'ws_status_bbbbbbbbbbbb', other);
    await rememberSharedFolder(statePaths(env), { folder: dirs.project, relay: 'http://localhost:8787', workspaceId: 'ws_status_aaaaaaaaaaaa', createdAt: 1 });
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(0);
    expect(io.out()).toContain('Workspace ws_status_aaaaaaaaaaaa');
    expect(io.out()).toContain('Workspace ws_status_bbbbbbbbbbbb');
    expect(io.out()).toContain(`  Folder: ${dirs.project}\n`);
    // The same zh-TW words as the host's summary, never the daemon's English reason.
    expect(io.out()).toContain('  Keep-awake: off (turned off with --no-keep-awake)\n');
    expect(io.out()).not.toContain('disabled');
    expect(io.out()).toContain(`  Daemon process: ${process.pid}`);
    // What `smurg host` no longer prints at the start (owner decision 2026-10-01).
    expect(io.out()).toContain(`  Daemon key fingerprint: ${a.fingerprint}\n`);
    expect(io.out()).toContain(`  Log: ${join(dirs.stateDir, 'logs', 'ws_status_aaaaaaaaaaaa.log')}\n`);
    expect(io.out()).toContain('  Relay: interactive connection not used, file transfer not used\n');
    // The one switch left (§11 D-13); there is no guest sandbox, no guest login and no main-workspace switch any more.
    expect(io.out()).toContain("  Notices of agents' shell commands: on\n");
    for (const gone of ['sandbox', 'subscription', 'main workspace', 'runner']) expect(io.out(), gone).not.toContain(gone);
    const one = testIo({ env });
    expect(await runCli(['status', '--workspace', 'ws_status_nothing000'], one)).toBe(3);
    expect(one.out()).toContain('No smurg host is running for workspace');
  });
});

describe('smurg stop', () => {
  it('asks the daemon to stop through the control socket and waits until it is gone', async () => {
    const { dirs, env } = await setup();
    const daemon = await hostDaemon(dirs, 'ws_stop_cccccccccccccc');
    const io = testIo({ env });
    expect(await runCli(['stop'], io)).toBe(0);
    expect(io.out()).toContain('Stopped sharing.');
    expect(daemon.status().stopped).toBe(true);
    const again = testIo({ env });
    expect(await runCli(['stop'], again)).toBe(3);
    expect(again.err()).toContain('No smurg host is running');
  });

  it('picks the workspace of the current folder; with several running and no hint it asks for --workspace (exit 2)', async () => {
    const { dirs, env } = await setup();
    const a = await hostDaemon(dirs, 'ws_stop_dddddddddddddd');
    const other = join(dirs.home, 'other');
    await (await import('node:fs/promises')).mkdir(other);
    const b = await hostDaemon(dirs, 'ws_stop_eeeeeeeeeeeeee', other);
    await rememberSharedFolder(statePaths(env), { folder: other, relay: 'http://localhost:8787', workspaceId: 'ws_stop_eeeeeeeeeeeeee', createdAt: 1 });
    const ambiguous = testIo({ env, cwd: dirs.home });
    expect(await runCli(['stop'], ambiguous)).toBe(2);
    expect(ambiguous.err()).toContain('choose one with --workspace');
    const inFolder = testIo({ env, cwd: other });
    expect(await runCli(['stop'], inFolder)).toBe(0);
    await waitFor(() => b.status().stopped, { what: 'b to stop' });
    expect(a.status().stopped).toBe(false);
    const byFlag = testIo({ env, cwd: dirs.home });
    expect(await runCli(['stop', '--workspace', 'ws_stop_dddddddddddddd'], byFlag)).toBe(0);
    expect(a.status().stopped).toBe(true);
  });

  it('refuses a malformed workspace id (exit 2)', async () => {
    const { env } = await setup();
    const io = testIo({ env });
    expect(await runCli(['stop', '--workspace', '../etc'], io)).toBe(2);
    expect(io.err()).toContain('Not a workspace ID');
  });
});
