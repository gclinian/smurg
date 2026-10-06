// ARCHITECTURE §8 with the REAL CLI (node + packages/cli/src/main.ts, spawned as the host would run it) against a
// daemon that composes every module (DEFAULT_FEATURE_MODULES): `smurg status`, `smurg attach` (inside a PTY this
// test creates, through the control socket: no relay, no Noise) to a terminal session the host opened from the web,
// and `smurg stop`. SMURG_HOME is the daemon's state dir, so the CLI finds the sockets where production puts them.
// Then the same CLI and agent sessions (DESIGN v0.5.0 §6), against a daemon whose agent services are the in-memory
// fakes: `smurg attach` lists them and names the workspace's address, `smurg attach <an agent session>` says where
// conversations open and exits 2, `smurg status` shows the agents, `smurg stop` says how many sessions are paused.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildAgentSession, buildTopic, fakesModule, fakesOf } from '../../src/core/fakes/index.ts';
import { createLocalControlModule } from '../../src/local/module.ts';
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
    // (The wording is the CLI's own catalog; only the facts are checked here.)
    expect(status.stdout).toContain(d.workspaceId);
    expect(status.stdout).toContain('Claude Code:');

    // The host opened a terminal from the web (a relay client); the same session is then attached from the CLI.
    const host = await d.connectHost();
    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 90, rows: 25 });
    const web = terminalText(host.conn, session.id);
    await host.conn.request('session.attach', { sessionId: session.id });

    // smurg attach without a session: the list, with the terminal as number 1.
    const list = await smurg(env, ['attach', '--workspace', d.workspaceId], home);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`\\n1\\s+${session.id}\\s`));

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

  it('agent sessions: listed with topic, status and title and the address where conversations open; attaching one is refused (exit 2); status and stop count them', async () => {
    const smurgHome = await createTempRunDir();
    cleanups.push(() => removeTempRunDir(smurgHome));
    const base = await createTempDir('cli-home');
    cleanups.push(() => removeTempDir(base));
    const home = join(base, 'home');
    await mkdir(home, { recursive: true });
    const control = createLocalControlModule();
    t = await createTestDaemon({ stateDir: smurgHome, modules: [fakesModule({ handlers: true }), control] });
    cleanups.push(() => control.whenClosed());
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
    const fakes = fakesOf(d.ctx);
    const host = await d.connectHost();
    const { session: shell } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 90, rows: 25, title: 'build' });
    fakes.topics.put(buildTopic({ id: 'tp_checkout', name: 'Checkout', slug: 'checkout' }));
    fakes.agents.adopt(buildAgentSession({ id: 'ses_checkout_talk', purpose: 'discussion', topicId: 'tp_checkout', topicName: 'Checkout', status: 'waiting-answer', modeFixed: true, createdAt: d.clock.now() + 1 }));
    fakes.agents.adopt(
      buildAgentSession({ id: 'ses_checkout_item', purpose: 'item', topicId: 'tp_checkout', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1, status: 'running', createdAt: d.clock.now() + 2 }),
    );
    const address = `https://relay.smurg.test/w/${d.workspaceId}`;

    const list = await smurg(env, ['attach'], home);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`\\n1\\s+${shell.id}\\s+terminal\\s.*\\sbuild\\n`));
    expect(list.stdout).toMatch(/\nses_checkout_talk\s+waiting for an answer\s+Checkout\s+Discussion\n/);
    expect(list.stdout).toMatch(/\nses_checkout_item\s+running\s+Checkout\s+1 \u00b7 Cart API\n/);
    expect(list.stdout.endsWith(`\nAgent conversations open in the browser: ${address}\n`)).toBe(true);

    // In a terminal (a PTY this test creates): the sentence and exit 2, without attaching.
    let outer = '';
    const terminal = pty.spawn('/bin/sh', ['-c', `${process.execPath} ${CLI_MAIN} attach ses_checkout_talk; echo "attach-exit=$?"; exec sleep 60`], { name: 'xterm-256color', cols: 200, rows: 25, cwd: home, env });
    cleanups.push(() => {
      try {
        terminal.kill(); // the PTY this test spawned
      } catch {
        // already gone
      }
    });
    terminal.onData((data) => (outer += data));
    await waitFor(() => outer.includes('attach-exit='), { timeoutMs: 30_000, what: 'the CLI to refuse' });
    expect(outer).toContain('attach-exit=2');
    expect(outer).toContain('smurg: Session "Discussion" is an agent conversation, not a terminal');
    expect(outer).toContain(`Agent conversations open in the browser: ${address}`);
    expect(outer).not.toContain('Attaching to session');

    const status = await smurg(env, ['status'], home);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('  Agent sessions: 1 running, 1 waiting for a person, 0 stopped without a report or failed, 0 idle\n');
    expect(status.stdout).toContain('  Topics: 1 (0 paused)\n');

    const stop = await smurg(env, ['stop'], home);
    expect(stop.code).toBe(0);
    expect(stop.stdout.endsWith('Stopped sharing.\n2 agent sessions are paused. They continue when you share this folder again.\n')).toBe(true);
    expect(d.daemon.status().stopped).toBe(true);
  });
});
