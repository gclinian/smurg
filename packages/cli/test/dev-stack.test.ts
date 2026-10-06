// scripts/dev-stack.sh.
//
// Always: which `claude` the stack's agent sessions run is never chosen for nobody. With a `claude` on PATH and no
// terminal, the script refuses before it starts anything and names its two switches (--stand-in-claude,
// --real-claude). The `claude` of this test is a file that only exits: the machine's own is never looked at.
//
// End to end — OPT-IN (SMURG_TEST_DEV_STACK=1): it starts the real relay (wrangler dev), the Vite dev server and
// `smurg host` with --stand-in-claude, which takes a while and needs two free ports. It checks that the links are
// printed and work (a CLI guest joins through the real relay with its device key), that an agent session of the stack
// runs the STAND-IN (never a real Claude Code), and that Ctrl-C (SIGINT to the script, a process this test started)
// stops every process group the script started. The script's own dir, fake HOME and SMURG_HOME live under a temp dir
// this test removes; nothing touches ~/.smurg.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@smurg/daemon/testing';
import { parseInviteUrl } from '@smurg/protocol';
import { RelayApi } from '@smurg/protocol/client';
import { RelayWorkspaceChannel } from '../src/channel/relay-channel.ts';
import { loadCredentials, sessionFor } from '../src/state/credentials.ts';
import { statePaths } from '../src/state/paths.ts';
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

/** Members of a process group (pid and command line), read from `ps` (nothing is signalled). */
async function groupMembers(pgid: number): Promise<string[]> {
  const { stdout } = await run('/bin/ps', ['-A', '-o', 'pid=,pgid=,command='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && Number(match[2]) === pgid)
    .map((match) => `${match[1]} ${(match[3] as string).slice(0, 200)}`);
}

/** The command lines of every process that names `needle` (a directory only this test knows). Nothing is signalled. */
async function processesNaming(needle: string): Promise<string[]> {
  const { stdout } = await run('/bin/ps', ['-A', '-o', 'command='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').filter((line) => line.includes(needle));
}

describe('scripts/dev-stack.sh: which claude', () => {
  it('with a claude on PATH and nobody at a terminal it starts nothing and asks for --stand-in-claude or --real-claude', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    // "A Claude Code is installed": a file named claude that could only exit. It is never run.
    const bin = join(dirs.home, 'bin');
    await mkdir(bin, { recursive: true });
    const ran = join(dirs.home, 'claude-was-run');
    await writeFile(join(bin, 'claude'), `#!/bin/sh\necho run >> '${ran}'\nexit 1\n`);
    await chmod(join(bin, 'claude'), 0o755);
    const dir = join(dirs.home, 'stack');
    const relayPort = await freePort();
    let webPort = await freePort();
    while (webPort === relayPort) webPort = await freePort();
    const env = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? '/usr/bin:/bin'}` };
    const outcome = await run(SCRIPT, ['--dir', dir, '--relay-port', String(relayPort), '--web-port', String(webPort)], { env, timeout: 60_000 }).then(
      (result) => ({ code: 0, ...result }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
    );
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain(`a Claude Code is installed on this computer (${await realpath(join(bin, 'claude'))})`);
    expect(outcome.stderr).toContain('--stand-in-claude');
    expect(outcome.stderr).toContain('--real-claude');
    // Nothing was started, made or run: no relay, no web server, no host, not even the stack's folder, and the file
    // named claude was not executed.
    expect(outcome.stdout).not.toContain('starting');
    expect((await readdir(dirs.home)).sort()).toEqual(['bin', 'project']);
    expect(await processesNaming(dir)).toEqual([]);
    // (a folder too long for a socket path would have got its state directory here: scripts/dev-stack.ts chooseStateDir)
    const fallback = `/tmp/smurg-dev-${typeof process.getuid === 'function' ? process.getuid() : 0}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
    expect(existsSync(fallback)).toBe(false);
    // The two switches exclude each other (decided before anything else).
    const both = await run(SCRIPT, ['--stand-in-claude', '--real-claude'], { env, timeout: 60_000 }).then(
      () => ({ code: 0, stderr: '' }),
      (err: { code?: number; stderr?: string }) => ({ code: err.code ?? -1, stderr: err.stderr ?? '' }),
    );
    expect(both).toMatchObject({ code: 2, stderr: expect.stringContaining('exclude each other') });
  }, 120_000);
});

describe.skipIf(!ENABLED)('scripts/dev-stack.sh (SMURG_TEST_DEV_STACK=1)', () => {
  it('starts relay, web and smurg host with the stand-in claude, prints working links, an agent session runs the stand-in, and Ctrl-C stops every process group it started', async () => {
    const guest = await makeDirs();
    cleanups.push(() => guest.cleanup());
    const dir = join(guest.home, 'stack');
    const relayPort = await freePort();
    let webPort = await freePort();
    while (webPort === relayPort) webPort = await freePort();
    const child = spawn(SCRIPT, ['--dir', dir, '--relay-port', String(relayPort), '--web-port', String(webPort), '--role', 'agent', '--stand-in-claude'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
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
    const invite = /invite link \(role agent\): (\S+)/.exec(out)?.[1] as string;
    expect(invite.startsWith(`http://localhost:${webPort}/join/`)).toBe(true);
    // Said before anything started, and again in the summary: what the agent sessions of this stack run.
    const standIn = join(dir, 'stand-in-claude');
    expect(out.indexOf('agent sessions: the STAND-IN for Claude Code')).toBeGreaterThan(-1);
    expect(out.indexOf('agent sessions: the STAND-IN for Claude Code')).toBeLessThan(out.indexOf('starting the relay'));
    expect(out).toContain(join(standIn, 'fake-claude-scenario.json'));
    expect(out).not.toContain('REAL Claude Code');

    // The web dev server serves the app; a CLI guest joins through the real relay with the printed invite.
    const page = await fetch(`http://localhost:${webPort}/`);
    expect(page.status).toBe(200);
    const env = isolatedEnv(guest);
    const relay = `http://localhost:${relayPort}`;
    await run(process.execPath, [CLI_MAIN, 'login', '--relay', relay, '--dev-user', 'amy'], { env, timeout: 60_000 });
    const joined = await run(process.execPath, [CLI_MAIN, 'attach', '--invite', invite, '--relay', relay], { env, timeout: 60_000 });
    expect(joined.stdout).toContain('through the relay');

    // Amy (Agent access) opens an agent session through the relay, as the web app would: the stack's daemon starts
    // the stand-in (its echo file records every start), never a Claude Code of this machine.
    const paths = statePaths(env);
    const login = sessionFor(await loadCredentials(paths), relay, Date.now());
    if (login === null) throw new Error('no relay login for amy');
    const channel = await RelayWorkspaceChannel.open({
      relay: new RelayApi({ relayUrl: relay, auth: { kind: 'bearer', token: login.token } }),
      workspaceId: parseInviteUrl(invite).workspaceId,
      stateDir: paths.stateDir,
      invite: null,
      deviceName: 'dev-stack test',
    });
    try {
      const { session } = await channel.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, firstMessage: 'hello' });
      expect(session).toMatchObject({ kind: 'agent', purpose: 'free', openedBy: { userId: 'dev:amy' } });
      await waitFor(
        async () => {
          const found = (await channel.request('session.list', {})).sessions.find((item) => item.id === session.id);
          return found?.kind === 'agent' && found.status === 'idle' && found.lastSeq !== undefined && found.lastSeq > 3;
        },
        { timeoutMs: 60_000, what: 'the agent session to answer and be idle' },
      );
      const page = await channel.request('session.watch', { sessionId: session.id });
      expect(page.session.claudeVersion).toBe('2.1.288');
      expect(page.events.filter((event) => event.kind === 'text').map((event) => (event.kind === 'text' ? event.text : ''))).toEqual([expect.stringContaining('This is the stand-in for Claude Code')]);
      const echoed = (await readFile(join(standIn, 'fake-claude-echo.jsonl'), 'utf8')).split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as { kind: string; session: string | null });
      expect(echoed.filter((entry) => entry.kind === 'argv').map((entry) => entry.session)).toEqual([session.id]);
    } finally {
      channel.close();
    }

    process.kill(pid as number, 'SIGINT');
    expect(await exited).toBe(0);
    expect(out).toContain('everything has stopped');
    for (const pgid of pgids) expect(await groupMembers(pgid)).toEqual([]);
    // ... and nothing that was started for this stack is left, the stand-in's process included.
    await waitFor(async () => (await processesNaming(dir)).length === 0, { timeoutMs: 15_000, what: 'every process of the stack to be gone' });
  });
});
