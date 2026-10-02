// scripts/dev-stack.sh end to end — OPT-IN (SMURG_TEST_DEV_STACK=1): it starts the real relay (wrangler dev), the Vite
// dev server and `smurg host`, which takes a while and needs two free ports. It checks that the links are printed and
// work (a CLI guest joins through the real relay with its device key), and that Ctrl-C (SIGINT to the script, a process
// this test started) stops every process group the script started. The script's own dir, fake HOME and SMURG_HOME live
// under a temp dir this test removes; nothing touches ~/.smurg.
import { execFile, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@smurg/daemon/testing';
import { CLI_MAIN, isolatedEnv, makeDirs } from './helpers.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../scripts/dev-stack.sh', import.meta.url));
const ENABLED = process.env['SMURG_TEST_DEV_STACK'] === '1';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Members of a process group, read from `ps` (nothing is signalled). */
async function groupMembers(pgid: number): Promise<string[]> {
  const { stdout } = await run('/bin/ps', ['-A', '-o', 'pid=,pgid=']);
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length === 2 && Number(cols[1]) === pgid)
    .map((cols) => cols[0] as string);
}

describe.skipIf(!ENABLED)('scripts/dev-stack.sh (SMURG_TEST_DEV_STACK=1)', () => {
  it('starts relay, web and smurg host, prints working links, and Ctrl-C stops every process group it started', async () => {
    const guest = await makeDirs();
    cleanups.push(() => guest.cleanup());
    const dir = join(guest.home, 'stack');
    const relayPort = await freePort();
    let webPort = await freePort();
    while (webPort === relayPort) webPort = await freePort();
    const child = spawn(SCRIPT, ['--dir', dir, '--relay-port', String(relayPort), '--web-port', String(webPort)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const pid = child.pid;
    if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('dev-stack did not start');
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
    let alive = true;
    void exited.then(() => {
      alive = false;
    });
    cleanups.push(async () => {
      if (alive) process.kill(pid as number, 'SIGINT');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 60_000))]);
    });
    cleanups.push(async () => {
      // The state dir falls back to /tmp when the dir is too long for a socket path: remove whichever was used.
      const state = /SMURG_HOME=(\S+?)\)/.exec(out)?.[1];
      if (state && state.startsWith('/tmp/smurg-dev-')) await rm(state, { recursive: true, force: true });
    });
    await waitFor(() => out.includes('process groups') || !alive, { timeoutMs: 180_000, what: 'the dev stack' });
    if (!alive) throw new Error(`dev-stack ended early:\n${out}`);
    const groups = /process groups: relay (\d+), web (\d+), smurg host (\d+)/.exec(out) as RegExpExecArray;
    const pgids = [Number(groups[1]), Number(groups[2]), Number(groups[3])];
    const invite = /invite link \(role editor\): (\S+)/.exec(out)?.[1] as string;
    expect(invite.startsWith(`http://localhost:${webPort}/join/`)).toBe(true);

    // The web dev server serves the app; a CLI guest joins through the real relay with the printed invite.
    const page = await fetch(`http://localhost:${webPort}/`);
    expect(page.status).toBe(200);
    const env = isolatedEnv(guest);
    const relay = `http://localhost:${relayPort}`;
    await run(process.execPath, [CLI_MAIN, 'login', '--relay', relay, '--dev-user', 'amy'], { env, timeout: 60_000 });
    const joined = await run(process.execPath, [CLI_MAIN, 'attach', '--invite', invite, '--relay', relay], { env, timeout: 60_000 });
    expect(joined.stdout).toContain('through the relay');

    process.kill(pid as number, 'SIGINT');
    expect(await exited).toBe(0);
    expect(out).toContain('everything has stopped');
    for (const pgid of pgids) expect(await groupMembers(pgid)).toEqual([]);
  });
});
