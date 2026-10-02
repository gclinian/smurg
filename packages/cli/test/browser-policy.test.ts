// OWNER-02 / CLI-07: `smurg` never starts the person's browser in an automated run. The one opener (cli/io.ts
// openInBrowser) is checked here with node:child_process MOCKED, so no real browser can start even if the policy
// broke: SMURG_NO_BROWSER, CI, SSH, a stdin / stdout that is not a terminal and a Linux without a display all mean
// "print the URL, spawn nothing". `host` and `attach` take --no-browser like `login`. Spawned CLIs (isolatedEnv, pipes)
// print the login page (/device) and its code, and the relay never sees the browser's request. A guest whose invite points at a different
// origin than their login (the dev stack: web :5173, relay :8787) is told which origin and how to fix it.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@smurg/daemon/testing';
import { buildInviteUrl } from '@smurg/protocol';
import { browserBlock, openInBrowser, processIo, type BrowserSituation } from '../src/cli/io.ts';
import { runAttach, inviteLink } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { runCli } from '../src/cli/run.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { CLI_MAIN, isolatedEnv, makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';

const opener = vi.hoisted(() => ({ calls: [] as { file: string; args: readonly string[] }[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Stands in for /usr/bin/open and xdg-open: records the call, starts nothing.
    execFile: (file: string, args: readonly string[], _options: unknown, callback: (err: Error | null) => void) => {
      opener.calls.push({ file, args });
      queueMicrotask(() => callback(null));
      return { on: () => undefined };
    },
  };
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  opener.calls.length = 0;
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

const URL_ = 'http://127.0.0.1:9/device';
const desktop = (env: Record<string, string> = {}, platform: NodeJS.Platform = 'darwin'): BrowserSituation => ({ env, stdinIsTTY: true, stdoutIsTTY: true, platform });

function invite(origin: string, workspaceId = 'ws_browserpolicy_0123'): string {
  return buildInviteUrl(origin, workspaceId, new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32)));
}

describe('browser policy (cli/io.ts)', () => {
  it('blocks the opener for automated runs, SSH, no terminal and no display; allows a desktop terminal', () => {
    expect(browserBlock(desktop())).toBeNull();
    expect(browserBlock(desktop({ DISPLAY: ':0' }, 'linux'))).toBeNull();
    expect(browserBlock(desktop({ SMURG_NO_BROWSER: '1' }))).toBe('disabled');
    expect(browserBlock(desktop({ SMURG_NO_BROWSER: 'yes' }))).toBe('disabled');
    expect(browserBlock(desktop({ SMURG_NO_BROWSER: '0' }))).toBeNull();
    expect(browserBlock(desktop({ CI: 'true' }))).toBe('ci');
    expect(browserBlock(desktop({ CI: 'false' }))).toBeNull();
    expect(browserBlock(desktop({ SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' }))).toBe('ssh');
    expect(browserBlock(desktop({ SSH_TTY: '/dev/ttys004' }))).toBe('ssh');
    expect(browserBlock({ ...desktop(), stdoutIsTTY: false })).toBe('not-a-terminal');
    expect(browserBlock({ ...desktop(), stdinIsTTY: false })).toBe('not-a-terminal');
    expect(browserBlock(desktop({}, 'linux'))).toBe('no-display');
    expect(browserBlock(desktop({}, 'win32'))).toBe('unsupported-platform');
  });

  it('openInBrowser spawns nothing when blocked, and only /usr/bin/open or xdg-open (mocked here) when allowed', async () => {
    for (const situation of [
      desktop({ SMURG_NO_BROWSER: '1' }),
      desktop({ CI: '1' }),
      desktop({ SSH_CLIENT: '10.0.0.2 50000 22' }),
      { ...desktop(), stdoutIsTTY: false },
      desktop({}, 'linux'),
    ]) {
      expect(await openInBrowser(URL_, situation)).toBe(false);
    }
    expect(await openInBrowser('file:///etc/passwd', desktop())).toBe(false);
    expect(opener.calls).toEqual([]);
    // The control: the same function does reach the opener when nothing blocks it.
    expect(await openInBrowser(URL_, desktop())).toBe(true);
    expect(await openInBrowser(URL_, desktop({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'))).toBe(true);
    expect(opener.calls).toEqual([
      { file: '/usr/bin/open', args: [URL_] },
      { file: 'xdg-open', args: [URL_] },
    ]);
  });

  it('this test run itself can never reach the real opener: SMURG_NO_BROWSER is set for every CLI test', async () => {
    expect(process.env['SMURG_NO_BROWSER']).toBe('1');
    expect(await processIo().openUrl(URL_)).toBe(false);
    expect(opener.calls).toEqual([]);
  });
});

async function setup(): Promise<{ dirs: Dirs; relay: FakeRelay; web: FakeRelay }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const relay = await startFakeRelay();
  cleanups.push(() => relay.close());
  // A second origin standing in for the dev stack's web server (the origin invite links carry).
  const web = await startFakeRelay();
  cleanups.push(() => web.close());
  return { dirs, relay, web };
}

/** Runs the real CLI (node main.ts, pipes, isolatedEnv) until `until` holds; kills only that child, by its pid. */
async function runUntil(dirs: Dirs, args: readonly string[], until: (out: string) => boolean): Promise<string> {
  const child = spawn(process.execPath, [CLI_MAIN, ...args], { env: isolatedEnv(dirs), cwd: dirs.project, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('the CLI did not start');
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let alive = true;
  void exited.then(() => {
    alive = false;
  });
  try {
    await waitFor(() => until(out) || !alive, { timeoutMs: 30_000, what: 'the CLI output' });
  } finally {
    if (alive) child.kill('SIGTERM');
    await exited;
  }
  return out;
}

describe('commands that log in never open a browser in an automated run', () => {
  it('smurg host without a relay session: prints the login page and the code, opens no browser, the relay sees no browser', async () => {
    const s = await setup();
    const out = await runUntil(s.dirs, ['host', s.dirs.project, '--relay', s.relay.origin, '--no-keep-awake'], (o) => o.includes('Waiting for you to approve the request in your browser'));
    expect(out).toContain(`On any device (a computer or a phone), open:\n  ${s.relay.origin}/device\nEnter the code: `);
    await new Promise((r) => setTimeout(r, 300));
    expect(out).not.toContain('was opened in this computer');
    expect(s.relay.requests.map((r) => r.path)).not.toContain('/device');
  });

  it('smurg login over SSH: the page and the code are printed and the opener is never reached; the control on a desktop opens /device (never with the code)', async () => {
    const s = await setup();
    const env = { HOME: s.dirs.home, SMURG_HOME: s.dirs.stateDir };
    for (const [situation, calls] of [
      [desktop({ SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' }), []],
      [desktop(), [{ file: '/usr/bin/open', args: [`${s.relay.origin}/device`] }]],
    ] as const) {
      opener.calls.length = 0;
      // The person allows the login in some browser once the CLI waits (GET /device on the fake relay).
      const io: TestIo = testIo({ env, openUrl: (url) => openInBrowser(url, situation), delay: async () => void (await browserOpening(`${s.relay.origin}/device`)) });
      expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(0);
      expect(io.out()).toContain(`  ${s.relay.origin}/device\nEnter the code: `);
      expect(opener.calls).toEqual(calls);
      expect(io.out().includes('was opened in this computer')).toBe(calls.length > 0);
    }
  });

  it('smurg attach --invite with split origins (logged in to the relay, invite on the web origin): names both origins and the fix, no browser', async () => {
    const s = await setup();
    const login = await runUntil(s.dirs, ['login', '--relay', s.relay.origin, '--dev-user', 'amy'], (o) => o.includes('Logged in to'));
    expect(login).toContain('Logged in to');
    const out = await runUntil(s.dirs, ['attach', '--invite', invite(s.web.origin)], (o) => o.includes('Waiting for you to approve the request in your browser'));
    expect(out).toContain(`but not to ${s.web.origin}`);
    expect(out).toContain(`--relay ${s.relay.origin}`);
    expect(out).toContain(`  ${s.web.origin}/device\n`);
    expect(out).toContain('the process list (ps)'); // the argv warning
    expect(s.web.requests.map((r) => r.path)).not.toContain('/device');
    expect(s.relay.requests.map((r) => r.path)).not.toContain('/device');
  });

  it('--no-browser on host and attach: the injected opener is never called even where opening is allowed', async () => {
    const s = await setup();
    const env = { HOME: s.dirs.home, SMURG_HOME: s.dirs.stateDir };
    // attach: the login URL is completed by the test (as a person would in their browser); the relay then forgets the
    // session, so the connection ends at once as closed(login-required).
    const io = testIo({ env, openUrl: async () => true, readSecret: async () => invite(s.web.origin) });
    const attach = runAttach(['--invite', '-', '--no-browser'], commandContext(io));
    await waitFor(() => io.out().includes('Waiting for you to approve the request in your browser'), { what: 'the login page and code' });
    expect(io.opened).toEqual([]);
    expect(io.out()).not.toContain('was opened in this computer');
    await browserOpening(/https?:\/\/\S+\/device$/m.exec(io.out())?.[0] as string);
    await waitFor(() => s.web.tokens.size > 0, { what: 'the CLI token' });
    s.web.tokens.clear();
    await expect(attach).rejects.toThrow('The relay login is no longer valid');
    expect(io.err()).toBe(''); // --invite - : no argv warning
    expect(io.opened).toEqual([]);

    // host: a folder that is already being shared is refused BEFORE any login; the login itself honours --no-browser.
    const hostIo = testIo({ env, openUrl: async () => true });
    const host = runCli(['host', s.dirs.project, '--relay', s.relay.origin, '--no-browser', '--no-keep-awake'], hostIo);
    await waitFor(() => hostIo.out().includes('Waiting for you to approve the request in your browser'), { what: 'the host login prompt' });
    expect(hostIo.opened).toEqual([]);
    expect(hostIo.out()).not.toContain('was opened in this computer');
    // Waiting for the code to expire is not possible from here: end the login by denying it instead.
    s.relay.loginError = 'access_denied';
    await browserOpening(/https?:\/\/\S+\/device$/m.exec(hostIo.out())?.[0] as string);
    expect(await host).toBe(4);
    expect(hostIo.opened).toEqual([]);
  });
});

/** `ps -o args=` of a process this test started (read only; spawn, because execFile is mocked in this file). */
function argsOf(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('/bin/ps', ['-o', 'args=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    ps.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    ps.once('error', reject);
    ps.once('exit', () => resolve(text));
  });
}

describe('the invite link stays off the command line', () => {
  it('the real CLI with --invite - reads the link from stdin: the secret is not in its process arguments (control: in argv it is)', async () => {
    const s = await setup();
    const link = invite(s.web.origin);
    const secret = /[#&]s=([^&]+)/.exec(link)?.[1] as string;
    for (const mode of ['stdin', 'argv'] as const) {
      const args = mode === 'stdin' ? ['attach', '--invite', '-'] : ['attach', '--invite', link];
      const child = spawn(process.execPath, [CLI_MAIN, ...args], { env: isolatedEnv(s.dirs), cwd: s.dirs.project, stdio: ['pipe', 'pipe', 'pipe'] });
      const pid = child.pid;
      if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('the CLI did not start');
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.stdin?.end(mode === 'stdin' ? `${link}\n` : '');
      try {
        // The invite was used: the CLI asks to log in to the invite's origin (and waits there).
        await waitFor(() => out.includes(`${s.web.origin}/device\n`), { timeoutMs: 30_000, what: `the login prompt (${mode})` });
        const psArgs = await argsOf(pid as number);
        expect(psArgs.includes(secret), `${mode}: ${psArgs.replace(secret, '<secret>')}`).toBe(mode === 'argv');
      } finally {
        child.kill('SIGTERM');
        await exited;
      }
    }
  });


  it('--invite - reads it without echo; SMURG_INVITE is used for its own workspace only; argv works with a warning', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const link = invite('http://localhost:5173', 'ws_invitefromenv_01');
    const prompts: string[] = [];
    const typed = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir }, readSecret: async (p) => (prompts.push(p), link) });
    expect(await inviteLink(commandContext(typed), '-')).toBe(link);
    expect(prompts[0]).toContain('it is not shown on screen');
    expect(typed.err()).toBe('');

    const cancelled = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir }, readSecret: async () => null });
    await expect(inviteLink(commandContext(cancelled), '-')).rejects.toThrow('No invite link was received');

    const fromEnv = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir, SMURG_INVITE: ` ${link}\n` } });
    expect(await inviteLink(commandContext(fromEnv), undefined)).toBe(link);
    expect(await inviteLink(commandContext(fromEnv), undefined, 'ws_invitefromenv_01')).toBe(link);
    expect(await inviteLink(commandContext(fromEnv), undefined, 'ws_someotherspace_02')).toBeUndefined();
    expect(fromEnv.err()).toBe('');

    const argv = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } });
    expect(await inviteLink(commandContext(argv), link)).toBe(link);
    expect(argv.err()).toContain('shell history');
    expect(argv.err()).toContain('--invite -');
    expect(argv.err()).not.toContain(link);
  });
});
