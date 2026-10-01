// Smoke test of the single executable (scripts/build-sea.ts runs it after every build). Skipped unless
// SMURG_SEA_BINARY names a built binary:
//   SMURG_SEA_BINARY=packages/cli/dist/smurg-darwin-arm64 pnpm --filter @smurg/cli exec vitest run test/sea.test.ts
// It runs the BINARY (no Node from node_modules, no source files) with an isolated environment: `--version`, the
// host's NODE_OPTIONS ignored, `smurg hook` / `smurg mcp` and their start-up time, then a real workspace: `smurg login
// --dev-user` against a fake relay HTTP API, `smurg host` with every production module (node-pty, the file watcher and
// the docs worker extracted from the binary), a host terminal session created through the control socket and shown by
// `smurg attach` in a real PTY (keystrokes in, output back, Ctrl-] out, terminal restored), and `smurg stop`.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runPathsFor } from '@smurg/daemon';
import { waitFor } from '@smurg/daemon/testing';
import { LocalWorkspaceChannel } from '../src/channel/local-channel.ts';
import { startFakeRelay } from './fake-relay.ts';
import { isolatedEnv, makeDirs, type Dirs } from './helpers.ts';
import { localTerminal } from './viewer.ts';

const run = promisify(execFile);
const BINARY = process.env['SMURG_SEA_BINARY'] ? resolve(process.env['SMURG_SEA_BINARY']) : null;
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface Setup {
  readonly bin: string;
  readonly dirs: Dirs;
  readonly cache: string;
  readonly env: Record<string, string>;
}

async function setup(): Promise<Setup> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const cache = join(dirs.home, 'cache');
  return { bin: BINARY as string, dirs, cache, env: isolatedEnv(dirs, { SMURG_CACHE_DIR: cache }) };
}

function runWithInput(bin: string, args: readonly string[], input: string, env: Record<string, string>): Promise<{ code: number | null; ms: number; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, ms: performance.now() - started, stdout }));
    child.stdin.end(input);
  });
}

const PRE_TOOL_USE = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/tmp/x.txt' }, cwd: '/tmp' });

describe.skipIf(BINARY === null)('the single executable (SMURG_SEA_BINARY)', () => {
  it('smurg --version works from the binary alone, and the host NODE_OPTIONS never reaches it', async () => {
    const s = await setup();
    const { stdout } = await run(s.bin, ['--version'], { env: s.env, cwd: s.dirs.home, timeout: 30_000 });
    // A release build prints its --version (build-sea.ts), any other build `<package version>-dev`.
    expect(stdout).toMatch(/^smurg \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \(protocol v1, daemon \S+, node \d+\.\d+\.\d+\)\n$/);
    if (process.env['SMURG_SEA_VERSION']) expect(stdout.startsWith(`smurg ${process.env['SMURG_SEA_VERSION']} (`)).toBe(true);
    // The binary runs on this machine, so it is this machine's build: its release name is smurg-<platform>-<arch>
    // (the asset scripts/install.sh downloads), unless --out gave it another name.
    if (/^smurg-(darwin|linux)-(arm64|x64)$/.test(basename(s.bin))) expect(basename(s.bin)).toBe(`smurg-${process.platform}-${process.arch}`);
    const poisoned = await run(s.bin, ['--version'], { env: { ...s.env, NODE_OPTIONS: '--require=/nonexistent/preload.js' }, timeout: 30_000 });
    expect(poisoned.stdout).toBe(stdout);
  });

  it('smurg hook fails closed without a daemon and starts in well under 300 ms; smurg mcp answers initialize', async () => {
    const s = await setup();
    await runWithInput(s.bin, ['hook'], PRE_TOOL_USE, s.env); // first start: the OS scans the new binary once
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const hook = await runWithInput(s.bin, ['hook'], PRE_TOOL_USE, s.env);
      expect(hook.code).toBe(0);
      expect(JSON.parse(hook.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      times.push(hook.ms);
    }
    console.info(`SEA smurg hook: ${times.map((t) => Math.round(t)).join(', ')} ms`);
    expect(Math.min(...times)).toBeLessThan(300);
    const mcp = await runWithInput(s.bin, ['mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`, s.env);
    expect(mcp.code).toBe(0);
    expect(JSON.parse(mcp.stdout.split('\n')[0] as string)).toMatchObject({ id: 1, result: { serverInfo: { name: 'smurg' } } });
    // Neither needed the native parts: nothing was extracted.
    await expect(lstat(s.cache)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('smurg licenses prints the embedded LICENSE and third-party notices (srt Apache-2.0, Node.js LICENSE); --third-party is the release file', async () => {
    const s = await setup();
    const all = await run(s.bin, ['licenses'], { env: s.env, cwd: s.dirs.home, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const license = await readFile(join(REPO_ROOT, 'LICENSE'), 'utf8');
    expect(all.stdout.startsWith(license)).toBe(true);
    const thirdParty = await run(s.bin, ['licenses', '--third-party'], { env: s.env, cwd: s.dirs.home, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    expect(all.stdout).toBe(`${license}\n${thirdParty.stdout}`);
    // srt's own Apache-2.0 LICENSE (and NOTICE, if its package has one), and the Node.js runtime's LICENSE.
    const srt = join(REPO_ROOT, 'packages', 'daemon', 'node_modules', '@anthropic-ai', 'sandbox-runtime');
    expect(thirdParty.stdout).toContain('\n@anthropic-ai/sandbox-runtime@');
    const srtLicense = (await readFile(join(srt, 'LICENSE'), 'utf8')).replace(/[ \t]+$/gm, '').trim();
    expect(thirdParty.stdout).toContain(srtLicense);
    for (const name of await readdir(srt)) if (/^notice/i.test(name)) expect(thirdParty.stdout).toContain((await readFile(join(srt, name), 'utf8')).replace(/[ \t]+$/gm, '').trim());
    expect(thirdParty.stdout).toMatch(/\nnode@\d+\.\d+\.\d+ \(the Node\.js runtime\)\n/);
    expect(thirdParty.stdout).toContain('Node.js is licensed for use as follows:');
    expect(thirdParty.stdout).not.toContain('In the copy of this file that is built');
    // The file build-sea.ts writes next to the binary is the same text.
    const beside = join(resolve(s.bin, '..'), 'THIRD-PARTY-NOTICES.txt');
    if (await lstat(beside).then(() => true, () => false)) expect(await readFile(beside, 'utf8')).toBe(thirdParty.stdout);
  });

  it('login, host with every production module, a terminal session through smurg attach in a real PTY, and smurg stop', async () => {
    const s = await setup();
    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    await writeFile(join(s.dirs.project, 'notes.txt'), 'hello\n');
    const login = await run(s.bin, ['login', '--relay', relay.origin, '--dev-user', 'host'], { env: s.env, timeout: 30_000 });
    expect(login.stdout).toContain('dev:host');

    const host: ChildProcess = spawn(s.bin, ['host', s.dirs.project, '--relay', relay.origin, '--no-keep-awake'], { env: s.env, cwd: s.dirs.project, stdio: ['ignore', 'pipe', 'pipe'] });
    const hostPid = host.pid;
    if (!Number.isInteger(hostPid) || (hostPid as number) <= 1 || hostPid === process.pid) throw new Error('host did not start');
    let hostOut = '';
    let hostErr = '';
    host.stdout?.on('data', (chunk: Buffer) => (hostOut += chunk.toString('utf8')));
    host.stderr?.on('data', (chunk: Buffer) => (hostErr += chunk.toString('utf8')));
    const hostExit = new Promise<number | null>((resolveExit) => host.once('exit', (code) => resolveExit(code)));
    let hostAlive = true;
    void hostExit.then(() => {
      hostAlive = false;
    });
    cleanups.push(async () => {
      // Only the process this test spawned, by its recorded pid.
      if (hostAlive) process.kill(hostPid as number, 'SIGTERM');
      await Promise.race([hostExit, new Promise((r) => setTimeout(r, 15_000))]);
      if (hostAlive) process.kill(hostPid as number, 'SIGKILL');
    });
    await waitFor(() => (hostOut.match(/\/join\//g) ?? []).length === 2 || !hostAlive, { timeoutMs: 60_000, what: 'the host summary' });
    if (!hostAlive) throw new Error(`smurg host ended: ${hostErr}${hostOut}`);
    // The start prints only the two links (owner decision 2026-10-01); the workspace id is in them.
    const workspaceId = (/\/join\/(ws_[A-Za-z0-9_-]+)#/.exec(hostOut) as RegExpExecArray)[1] as string;

    // The native parts were extracted into the cache, verified, private.
    const nativeDirs = (await readdir(s.cache)).filter((name) => name.startsWith('native-'));
    expect(nativeDirs).toHaveLength(1);
    const native = join(s.cache, nativeDirs[0] as string);
    expect((await lstat(join(native, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'))).isFile()).toBe(true);
    if (process.platform === 'darwin') expect((await lstat(join(native, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'))).mode & 0o777).toBe(0o700);
    if (process.platform === 'linux') {
      // Linux: node-pty needs no spawn-helper (forkpty); srt's seccomp helper is extracted executable, owner only.
      await expect(lstat(join(native, 'node-pty', 'prebuilds', `linux-${process.arch}`, 'spawn-helper'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(join(native, 'vendor', 'seccomp', process.arch, 'apply-seccomp'))).mode & 0o777).toBe(0o700);
    }
    expect((await lstat(join(native, 'parcel-watcher', 'watcher.node'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(native, 'lib', 'compute-worker.ts'))).isFile()).toBe(true);
    expect((await lstat(native)).mode & 0o777).toBe(0o700);

    // A host terminal session (node-pty inside the binary), created through the control socket.
    const ctl = runPathsFor(join(s.dirs.stateDir, 'run'), workspaceId).ctl;
    const channel = await LocalWorkspaceChannel.open(ctl, { deviceName: 'sea smoke' });
    cleanups.push(() => channel.close());
    const { session } = await channel.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'sea' });

    const script = `${s.bin} attach ${session.id} --workspace ${workspaceId}; echo "attach-exit=$?"; exec sleep 120`;
    const local = localTerminal(script, s.env, s.dirs.project, 100, 30);
    cleanups.push(() => local.kill());
    await waitFor(() => local.text.includes('Ctrl-]'), { timeoutMs: 30_000, what: 'the attach' });
    await waitFor(async () => (await channel.request('session.list', {})).sessions.some((x) => x.id === session.id && x.cols === 100), { timeoutMs: 15_000, what: 'the owner-sized PTY' });
    local.outer.write('echo sea-$((6*7))\r');
    await waitFor(() => local.text.includes('sea-42'), { timeoutMs: 15_000, what: 'the session output' });
    local.outer.write('\x1d');
    await waitFor(() => local.text.includes('attach-exit=0'), { timeoutMs: 15_000, what: 'the detach' });

    // An open document follows a change on disk: the file watcher (native @parcel/watcher) sees it and the docs
    // module reconciles it on its compute worker (extracted from the binary).
    let syncs = 0;
    channel.on('doc.sync', () => {
      syncs += 1;
    });
    const opened = await channel.request('doc.open', { file: { root: { kind: 'main' }, path: 'notes.txt' } });
    expect(opened.canEdit).toBe(true);
    await waitFor(() => syncs > 0, { what: 'the initial sync' });
    const before = syncs;
    await writeFile(join(s.dirs.project, 'notes.txt'), 'hello\nworld from disk\n');
    await waitFor(() => syncs > before, { timeoutMs: 15_000, what: 'the disk change in the document' });
    channel.close();

    const log = await readFile(join(s.dirs.stateDir, 'logs', `${workspaceId}.log`), 'utf8');
    expect(log).toContain('daemon started');
    expect(log).not.toContain('file watcher unavailable');
    expect(log).not.toContain('document compute worker');

    const stop = await run(s.bin, ['stop', '--workspace', workspaceId], { env: s.env, timeout: 60_000 });
    expect(stop.stdout).toContain('已停止分享');
    expect(await hostExit).toBe(0);
    expect(hostOut).toContain('已停止分享');
  });
});
