// ARCHITECTURE §8 with the REAL CLI (node + packages/cli/src/main.ts, spawned as the host would run it) against a
// daemon that composes every module (DEFAULT_FEATURE_MODULES): `smurg status`, `smurg attach` (inside a PTY this
// test creates, through the control socket: no relay, no Noise) to a terminal session the host opened from the web,
// and `smurg stop`. SMURG_HOME is the daemon's state dir, so the CLI finds the sockets where production puts them.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTempDir, createTempRunDir, createTestDaemon, removeTempDir, removeTempRunDir, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { CLI_MAIN, terminalText } from './support.ts';

const execFileAsync = promisify(execFile);

let t: TestDaemon | null = null;
const cleanups: (() => Promise<void> | void)[] = [];
const savedShell = process.env['SHELL'];

beforeAll(() => {
  process.env['SHELL'] = '/bin/sh';
});

afterAll(() => {
  if (savedShell === undefined) delete process.env['SHELL'];
  else process.env['SHELL'] = savedShell;
});

afterEach(async () => {
  await t?.cleanup();
  t = null;
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function smurg(env: Record<string, string>, args: readonly string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_MAIN, ...args], { env, cwd, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === 'number' ? failed.code : -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

describe('local control socket + the real CLI, every module composed', { timeout: 120_000 }, () => {
  it('smurg status / attach / stop against a daemon with all modules', async () => {
    const smurgHome = await createTempRunDir();
    cleanups.push(() => removeTempRunDir(smurgHome));
    const base = await createTempDir('cli-home');
    cleanups.push(() => removeTempDir(base));
    const home = join(base, 'home');
    await mkdir(home, { recursive: true });
    t = await createTestDaemon({ stateDir: smurgHome });
    const d = t;
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      SMURG_HOME: smurgHome,
      SHELL: '/bin/sh',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SMURG_LANG: 'en',
      TMPDIR: process.env['TMPDIR'] ?? '/tmp',
      SMURG_NO_BROWSER: '1',
    };

    // smurg status: the running daemon, found through its control socket.
    const status = await smurg(env, ['status'], home);
    expect(status.code).toBe(0);
    // (The wording is the CLI's own catalog; only the fact is checked here.)
    expect(status.stdout).toContain(d.workspaceId);

    // The host opened a terminal from the web (a relay client); the same session is then attached from the CLI.
    const host = await d.connectHost();
    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 90, rows: 25 });
    const web = terminalText(host.conn, session.id);
    await host.conn.request('session.attach', { sessionId: session.id });

    const cli = `${process.execPath} ${CLI_MAIN} attach ${session.id} --workspace ${d.workspaceId}`;
    let outer = '';
    const terminal = pty.spawn('/bin/sh', ['-c', `${cli}; echo "attach-exit=$?"; exec sleep 60`], { name: 'xterm-256color', cols: 90, rows: 25, cwd: home, env });
    cleanups.push(() => {
      try {
        terminal.kill(); // the PTY this test spawned
      } catch {
        // already gone
      }
    });
    terminal.onData((data) => (outer += data));
    // Attached: keystrokes typed in the CLI's terminal run in the session, and both the CLI and the web viewer see it.
    await waitFor(() => {
      const now = d.ctx.services.sessions.get(session.id);
      return now?.kind === 'terminal' && now.attached === 2;
    }, { timeoutMs: 30_000, what: 'the CLI to attach' });
    terminal.write('echo cli-$((3*4))\r');
    await waitFor(() => outer.includes('cli-12'), { timeoutMs: 20_000, what: 'the output in the CLI\'s terminal' });
    await waitFor(() => web.text().includes('cli-12'), { timeoutMs: 20_000, what: 'the same output at the web viewer' });
    const audit = await host.conn.request('admin.audit.query', { limit: 100 });
    expect(audit.entries.some((e) => e.action === 'auth.connect' && e.detail?.['mode'] === 'local')).toBe(true);
    // Ctrl-] detaches (exit 0); the session keeps running.
    terminal.write('\x1d');
    await waitFor(() => outer.includes('attach-exit='), { timeoutMs: 20_000, what: 'the CLI to exit' });
    expect(outer).toContain('attach-exit=0');
    expect(d.ctx.services.sessions.get(session.id)?.status).toBe('running');

    // smurg stop: returns once the daemon is stopped (sessions ended, sockets gone).
    const ptyPid = (d.ctx.services.sessions as SessionManagerImpl).ptyPid(session.id);
    expect(ptyPid).toBeGreaterThan(1);
    const stop = await smurg(env, ['stop', '--workspace', d.workspaceId], home);
    expect(stop.code).toBe(0);
    expect(d.daemon.status().stopped).toBe(true);
    // The session's PTY process is gone (signal 0 only probes; nothing is signalled here).
    expect(() => process.kill(ptyPid as number, 0)).toThrow();
    expect(d.relay.hostOnline('ws')).toBe(false);
    const after = await smurg(env, ['status'], home);
    expect(after.code).toBe(3);
  });
});
