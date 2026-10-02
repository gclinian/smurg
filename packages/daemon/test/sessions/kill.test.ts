// R2.2 (a kicked user's session processes are terminated within 3 s), R11.1 (the host terminates any session) and the
// documented limit of ARCHITECTURE §11 D-3, with real processes. Every process these tests look for carries a unique
// random token in its command line; the only process a test signals itself is its own D-3 escapee, by the pid it read
// for that token, after checking the command line again. Nothing else is ever signalled by a test.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_HOST_USER, createTempRunDir, createTestDaemon, registerTestProcess, removeTempRunDir, type TestDaemon } from '../../src/testing/index.ts';
import { TestViewer, sleep, typeInto, waitFor } from './helpers.ts';
import { startSessionStack, type SessionStack } from './setup.ts';

const execFileAsync = promisify(execFile);
const CRASH_CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));
const stacks: SessionStack[] = [];
const viewers: TestViewer[] = [];
/** Tokens of processes this file started (for the final safety net: kill only what carries one of them). */
const tokens: string[] = [];

/**
 * Pids whose full command line contains `needle` (read-only: `ps`). Every needle carries one of this file's tokens, so
 * what it finds was started by these tests: each pid is registered with the test run (with the needle as its identity),
 * which ends it after the run if this worker dies before its afterEach does.
 */
async function pidsOf(needle: string): Promise<number[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'pid=,command=']);
  const pids = stdout
    .split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  for (const pid of pids) registerTestProcess(pid, needle);
  return pids;
}

async function commandOf(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  return stdout.trim();
}

/** Kills a process THIS test started, identified by its unique token, after re-reading its command line. */
async function killOwnProcess(pid: number, token: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (!(await commandOf(pid)).includes(token)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

afterEach(async () => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
  for (const stack of stacks.splice(0)) await stack.cleanup();
  // Safety net: nothing a test started may outlive it (only processes carrying this file's own tokens).
  for (const token of tokens.splice(0)) for (const pid of await pidsOf(token)) await killOwnProcess(pid, token);
});

async function stack(): Promise<SessionStack> {
  const s = await startSessionStack();
  stacks.push(s);
  return s;
}

function token(label: string): string {
  // A plausible `sleep` argument nobody else uses: 7 random digits.
  const value = `${label}${randomInt(1_000_000, 9_999_999)}`;
  tokens.push(value);
  return value;
}

describe('R2 kicking a member', { timeout: 60_000 }, () => {
  it('a kicked user loses all access within 3 s and their session processes are ended — a background job, a nohup job, a job ignoring SIGHUP/SIGTERM and a detached daemon', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 160, rows: 40 });
    const view = new TestViewer(carol.conn, session.id);
    viewers.push(view);
    await view.attach({ cols: 160, rows: 40 });
    const bg = token('61');
    const nohupped = token('62');
    const stubborn = token('63');
    const detached = token('smurg-r22-detached-');
    typeInto(carol.conn, session.id, `sleep ${bg} &\r`);
    typeInto(carol.conn, session.id, `nohup sleep ${nohupped} >/dev/null 2>&1 &\r`);
    typeInto(carol.conn, session.id, `sh -c "trap '' HUP TERM; exec sleep ${stubborn}" &\r`);
    // setsid + reparented to init, but it keeps the session's environment: found by the env marker.
    typeInto(
      carol.conn,
      session.id,
      `'${process.execPath}' -e "require('child_process').spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)', '${detached}'], { detached: true, stdio: 'ignore' }).unref()"\r`,
    );
    const needles = [`sleep ${bg}`, `sleep ${nohupped}`, `sleep ${stubborn}`, detached];
    await waitFor(async () => (await Promise.all(needles.map(pidsOf))).every((pids) => pids.length > 0), 'every job to run');
    // The stubborn construct really ignores SIGHUP and SIGTERM: proven on a twin this test spawns and signals itself.
    const twinToken = token('64');
    const twin = spawn('/bin/sh', ['-c', `trap '' HUP TERM; exec sleep ${twinToken}`], { stdio: 'ignore' });
    registerTestProcess(twin.pid as number, twinToken);
    await sleep(300);
    process.kill(twin.pid as number, 'SIGHUP');
    process.kill(twin.pid as number, 'SIGTERM');
    await sleep(300);
    expect(twin.exitCode).toBeNull();
    expect(twin.signalCode).toBeNull();
    twin.kill('SIGKILL');

    const t0 = Date.now();
    await host.conn.request('admin.member.kick', { userId: 'dev:carol' });
    await waitFor(async () => (await Promise.all(needles.map(pidsOf))).every((pids) => pids.length === 0), 'every process of the kicked user to be gone', 3_000);
    const elapsed = Date.now() - t0;
    console.info(`[R2.2] kick → all session processes gone after ${elapsed} ms`);
    expect(elapsed).toBeLessThan(3_000);
    expect(s.sessions.get(session.id)?.status).toBe('exited');
  });

  it('a guest\'s nohup job survives neither a natural `exit` of its session (remembered descendants) nor a kick', async () => {
    const s = await stack();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 });
    const job = token('66');
    typeInto(carol.conn, session.id, `nohup sleep ${job} >/dev/null 2>&1 &\r`);
    await waitFor(async () => (await pidsOf(`sleep ${job}`)).length > 0, 'the nohup job');
    await sleep(2_600); // at least one descendant scan while the shell runs
    typeInto(carol.conn, session.id, 'exit\r');
    await waitFor(() => s.sessions.get(session.id)?.status === 'exited', 'the natural exit');
    await waitFor(async () => (await pidsOf(`sleep ${job}`)).length === 0, 'the orphaned job to be gone', 5_000);
  });

  it('D-3 limit (documented, not covered): a process that setsid()s AND scrubs its environment survives the end of its session — the test then kills its own escapee', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 160, rows: 40 });
    const view = new TestViewer(host.conn, session.id);
    viewers.push(view);
    await view.attach({ cols: 160, rows: 40 });
    const escapee = token('9');
    const covered = token('8');
    // Escapes: detached (setsid, reparented to init) with an EMPTY environment (no SMURG_SESSION_ID).
    typeInto(host.conn, session.id, `'${process.execPath}' -e "require('child_process').spawn('/bin/sleep', ['${escapee}'], { detached: true, stdio: 'ignore', env: {} }).unref()"\r`);
    // Control: a plain background job of the same session IS covered.
    typeInto(host.conn, session.id, `sleep ${covered} &\r`);
    await waitFor(async () => (await pidsOf(`sleep ${escapee}`)).length > 0 && (await pidsOf(`sleep ${covered}`)).length > 0, 'both processes');

    await host.conn.request('session.end', { sessionId: session.id });
    await waitFor(async () => (await pidsOf(`sleep ${covered}`)).length === 0, 'the covered job to be gone', 3_000);
    await sleep(500);
    const survivors = await pidsOf(`sleep ${escapee}`);
    // This is exactly what ARCHITECTURE §11 D-3 says is NOT covered, on macOS and Linux alike since D-15 (no session
    // has a sandbox or a PID namespace any more, whoever opened it).
    expect(survivors).toHaveLength(1);
    for (const pid of survivors) await killOwnProcess(pid, escapee);
    await waitFor(async () => (await pidsOf(`sleep ${escapee}`)).length === 0, 'the escapee to be gone');
  });
});

describe('R11 the host console', { timeout: 60_000 }, () => {
  it('the host can end any session from the console with one click — an Agent access member\'s session and the host\'s own, processes included', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    const guestSession = (await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 })).session;
    const hostSession = (await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 })).session;
    const a = token('71');
    const b = token('72');
    typeInto(carol.conn, guestSession.id, `sleep ${a} &\r`);
    typeInto(host.conn, hostSession.id, `sleep ${b} &\r`);
    await waitFor(async () => (await pidsOf(`sleep ${a}`)).length > 0 && (await pidsOf(`sleep ${b}`)).length > 0, 'both jobs');

    const states: string[] = [];
    host.conn.on('session.state', ({ session }) => states.push(`${session.id}:${session.status}`));
    const seenByOwner: { endReason?: string; endedBy?: { userId: string } }[] = [];
    carol.conn.on('session.state', ({ session }) => {
      if (session.id === guestSession.id && session.status === 'exited') seenByOwner.push(session);
    });
    await host.conn.request('admin.session.terminate', { sessionId: guestSession.id });
    await host.conn.request('admin.session.terminate', { sessionId: hostSession.id });
    expect(s.sessions.get(guestSession.id)?.status).toBe('exited');
    expect(s.sessions.get(hostSession.id)?.status).toBe('exited');
    expect(await pidsOf(`sleep ${a}`)).toEqual([]);
    expect(await pidsOf(`sleep ${b}`)).toEqual([]);
    await waitFor(() => states.includes(`${guestSession.id}:exited`) && states.includes(`${hostSession.id}:exited`), 'session.state to every member');
    // The owner learns it was the host, not a normal exit.
    await waitFor(() => seenByOwner.length > 0, 'the exited state at the owner');
    expect(seenByOwner.at(-1)).toMatchObject({ endReason: 'terminated', endedBy: { userId: TEST_HOST_USER } });
    const listed = (await carol.conn.request('session.list', {})).sessions.find((x) => x.id === guestSession.id);
    expect(listed).toMatchObject({ status: 'exited', endReason: 'terminated', endedBy: { userId: TEST_HOST_USER } });
    const entries = await s.t.ctx.audit.query({ limit: 100 });
    const terminated = entries.filter((e) => e.action === 'session.terminate');
    expect(terminated.map((e) => e.target).sort()).toEqual([guestSession.id, hostSession.id].sort());
    expect(terminated.every((e) => e.actor.kind === 'user' && e.actor.userId === TEST_HOST_USER)).toBe(true);
    // A non-host cannot use the console's terminate.
    await expect(carol.conn.request('admin.session.terminate', { sessionId: hostSession.id })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('a daemon that died hard', { timeout: 120_000 }, () => {
  it('the processes its sessions started do not outlive the NEXT start: live.json names them, identity-checked', async () => {
    const base = await createTempRunDir(); // short: the child's sockets live in <base>/s/run
    const stateDir = join(base, 's');
    const root = join(base, 'share');
    await mkdir(root, { recursive: true });
    const workspaceId = `ws_test_${randomBytes(9).toString('base64url')}`;
    const pidFile = join(base, 'job.pid');
    const seconds = token('');
    let jobPid = 0;
    let restarted: TestDaemon | null = null;
    // The child is killed hard and can never clean up after itself: its temp dir lives inside `base`, which this
    // test removes. (With the inherited TMPDIR every run left one smurg-test-daemon-* dir in the user's temp dir.)
    const childTmp = join(base, 'tmp');
    await mkdir(childTmp, { recursive: true });
    const child = spawn(process.execPath, [CRASH_CHILD, stateDir, root, workspaceId, pidFile, seconds], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SHELL: '/bin/sh', TMPDIR: childTmp },
    });
    registerTestProcess(child.pid as number, seconds); // in its argv
    try {
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk.slice(0, 4_000)));
      await waitFor(() => out.includes('READY') || child.exitCode !== null, 'the child daemon and its background job', 60_000);
      expect(child.exitCode, err).toBe(null);
      jobPid = Number((await readFile(pidFile, 'utf8')).trim());
      registerTestProcess(jobPid, `sleep ${seconds}`);
      expect(await commandOf(jobPid)).toContain(`sleep ${seconds}`);
      // The crash: our own child, by the pid we spawned.
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      await sleep(1_000);
      // Control: the nohup job outlived the daemon (reparented), as the reviewer observed.
      expect(await commandOf(jobPid)).toContain(`sleep ${seconds}`);
      // The next start on the same state (and share: the crashed daemon's share lock is stale) ends it.
      restarted = await createTestDaemon({ stateDir, root, workspaceId });
      await waitFor(async () => !(await commandOf(jobPid)).includes(`sleep ${seconds}`), 'the leftover job to be ended', 10_000);
      expect(JSON.parse(await readFile(join(restarted.ctx.state.dir, 'sessions.json'), 'utf8'))).toMatchObject({ live: [] });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (jobPid > 1) await killOwnProcess(jobPid, `sleep ${seconds}`);
      await restarted?.cleanup();
      await removeTempRunDir(base);
    }
  });
});
