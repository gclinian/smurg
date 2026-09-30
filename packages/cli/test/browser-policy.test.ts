// OWNER-02 / CLI-07: `smurg` never starts the person's browser in an automated run. The one opener (cli/io.ts
// openInBrowser) is checked here with node:child_process MOCKED, so no real browser can start even if the policy
// broke: SMURG_NO_BROWSER, CI, SSH, a stdin / stdout that is not a terminal and a Linux without a display all mean
// "print the URL, spawn nothing". `host` and `attach` take --no-browser like `login`. Spawned CLIs (isolatedEnv, pipes)
// print the login URL and the relay never sees the browser's request. A guest whose invite points at a different
// origin than their login (the dev stack: web :5173, relay :8787) is told which origin and how to fix it (OWNER-03).
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
import { CLI_MAIN, isolatedEnv, makeDirs, testIo, type Dirs } from './helpers.ts';

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

const URL_ = 'http://127.0.0.1:9/auth/cli/start?x=1';
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
  it('smurg host without a relay session: prints the login URL, says it did not open a browser, the relay sees no browser', async () => {
    const s = await setup();
    const out = await runUntil(s.dirs, ['host', s.dirs.project, '--relay', s.relay.origin, '--no-keep-awake'], (o) => o.includes('等待登入完成'));
    expect(out).toContain(`${s.relay.origin}/auth/cli/start?`);
    await new Promise((r) => setTimeout(r, 300));
    expect(out).toContain('沒有自動開啟瀏覽器');
    expect(s.relay.requests.map((r) => r.path)).not.toContain('/auth/cli/start');
  });

  it('smurg attach --invite with split origins (logged in to the relay, invite on the web origin): names both origins and the fix, no browser', async () => {
    const s = await setup();
    const login = await runUntil(s.dirs, ['login', '--relay', s.relay.origin, '--dev-user', 'amy'], (o) => o.includes('已登入'));
    expect(login).toContain('已登入');
    const out = await runUntil(s.dirs, ['attach', '--invite', invite(s.web.origin)], (o) => o.includes('等待登入完成'));
    expect(out).toContain(`但還沒有登入 ${s.web.origin}`);
    expect(out).toContain(`--relay ${s.relay.origin}`);
    expect(out).toContain(`${s.web.origin}/auth/cli/start?`);
    expect(out).toContain('程序列表（ps）'); // the argv warning (CLI-08)
    expect(s.web.requests.map((r) => r.path)).not.toContain('/auth/cli/start');
    expect(s.relay.requests.map((r) => r.path)).not.toContain('/auth/cli/start');
  });

  it('--no-browser on host and attach: the injected opener is never called even where opening is allowed', async () => {
    const s = await setup();
    const env = { HOME: s.dirs.home, SMURG_HOME: s.dirs.stateDir };
    // attach: the login URL is completed by the test (as a person would in their browser); the relay then forgets the
    // session, so the connection ends at once as closed(login-required).
    const io = testIo({ env, openUrl: async () => true, readSecret: async () => invite(s.web.origin) });
    const attach = runAttach(['--invite', '-', '--no-browser'], commandContext(io));
    await waitFor(() => /https?:\/\/\S+\/auth\/cli\/start\S+/.test(io.out()), { what: 'the login URL' });
    expect(io.opened).toEqual([]);
    expect(io.out()).toContain('沒有自動開啟瀏覽器');
    await browserOpening(/https?:\/\/\S+\/auth\/cli\/start\S+/.exec(io.out())?.[0] as string);
    await waitFor(() => s.web.tokens.size > 0, { what: 'the CLI token' });
    s.web.tokens.clear();
    await expect(attach).rejects.toThrow('relay 的登入已失效');
    expect(io.err()).toBe(''); // --invite - : no argv warning
    expect(io.opened).toEqual([]);

    // host: a folder that is already being shared is refused BEFORE any login; the login itself honours --no-browser.
    const hostIo = testIo({ env, openUrl: async () => true });
    const host = runCli(['host', s.dirs.project, '--relay', s.relay.origin, '--no-browser', '--no-keep-awake'], hostIo);
    await waitFor(() => hostIo.out().includes('等待登入完成'), { what: 'the host login prompt' });
    expect(hostIo.opened).toEqual([]);
    expect(hostIo.out()).toContain('沒有自動開啟瀏覽器');
    // Let the login time out quickly is not possible from here: complete it with a login error instead.
    s.relay.loginError = 'access_denied';
    await browserOpening(/https?:\/\/\S+\/auth\/cli\/start\S+/.exec(hostIo.out())?.[0] as string);
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

describe('the invite link stays off the command line (CLI-08, SEC-E-06)', () => {
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
        await waitFor(() => out.includes(`${s.web.origin}/auth/cli/start?`), { timeoutMs: 30_000, what: `the login prompt (${mode})` });
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
    expect(prompts[0]).toContain('不會顯示在畫面上');
    expect(typed.err()).toBe('');

    const cancelled = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir }, readSecret: async () => null });
    await expect(inviteLink(commandContext(cancelled), '-')).rejects.toThrow('沒有收到邀請連結');

    const fromEnv = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir, SMURG_INVITE: ` ${link}\n` } });
    expect(await inviteLink(commandContext(fromEnv), undefined)).toBe(link);
    expect(await inviteLink(commandContext(fromEnv), undefined, 'ws_invitefromenv_01')).toBe(link);
    expect(await inviteLink(commandContext(fromEnv), undefined, 'ws_someotherspace_02')).toBeUndefined();
    expect(fromEnv.err()).toBe('');

    const argv = testIo({ env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } });
    expect(await inviteLink(commandContext(argv), link)).toBe(link);
    expect(argv.err()).toContain('歷史紀錄');
    expect(argv.err()).toContain('--invite -');
    expect(argv.err()).not.toContain(link);
  });
});
