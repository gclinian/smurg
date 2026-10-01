// `smurg login` / `smurg logout` through their modules with an injected io and a fake relay: the device-code login
// (what it prints, the page it opens and when, the polling with its interval and slow_down, a passing network problem,
// Ctrl-C, expiry, 「拒絕」, the token saved 0600 and never printed), `smurg host` logging in first, the dev login only
// for a relay on a local hostname, zh-TW errors, exit codes.
import { lstat, readFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@smurg/daemon/testing';
import { runCli } from '../src/cli/run.ts';
import { loadCredentials } from '../src/state/credentials.ts';
import { statePaths } from '../src/state/paths.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';

// These tests are about a CLI WITHOUT a built-in relay (CLI-12), whatever src/relay/default-relay.ts ships: no test may
// ever reach the real hosted relay. test/default-relay.test.ts covers a CLI with one.
vi.mock('../src/relay/default-relay.ts', () => ({ DEFAULT_RELAY_URL: null }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
});

async function setup(): Promise<{ dirs: Dirs; relay: FakeRelay; env: Record<string, string> }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const relay = await startFakeRelay();
  cleanups.push(() => relay.close());
  return { dirs, relay, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } };
}

/**
 * The login's clock: every wait it asks for is recorded and moves the clock instead of taking time. `onWait(n)` runs
 * before the n-th wait (from 1) ends: that is where the person acts in the browser.
 */
function virtualTime(onWait: (n: number) => Promise<void> | void = () => {}) {
  let now = Date.parse('2026-10-01T08:00:00Z');
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    delay: async (ms: number) => {
      waits.push(ms);
      now += ms;
      await onWait(waits.length);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** The code the CLI printed (`輸入代碼：XXXX-XXXX`). */
function printedCode(out: string): string {
  const code = /輸入代碼：([A-Z]{4}-[A-Z]{4})/.exec(out)?.[1];
  if (code === undefined) throw new Error(`no code printed:\n${out}`);
  return code;
}

/** The person on /device: enters `code` (as printed) and presses 允許 or 拒絕. */
async function decide(fake: FakeRelay, code: string, decision: 'allow' | 'deny' = 'allow'): Promise<void> {
  const res = await fetch(`${fake.origin}/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, decision }).toString(),
  });
  expect(res.status).toBe(200);
}

const tokenPolls = (fake: FakeRelay) => fake.requests.filter((r) => r.path === '/auth/device/token').length;

describe('smurg login (device code)', () => {
  it('prints the /device page and the code, opens only the page, polls every interval until allowed, saves the token 0600 and never prints it', async () => {
    const s = await setup();
    s.relay.device = { interval: 5, expiresIn: 600 };
    let io!: TestIo;
    const time = virtualTime(async (n) => {
      if (n === 2) await decide(s.relay, printedCode(io.out()));
    });
    io = testIo({ env: s.env, openUrl: async () => true, now: time.now, delay: time.delay });
    expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(0);
    expect(io.err()).toBe('');
    const code = printedCode(io.out());
    expect(io.out().startsWith(`在任何裝置（電腦或手機）打開：\n  ${s.relay.origin}/device\n輸入代碼：${code}   （10 分鐘內有效）\n`)).toBe(true);
    expect(io.out()).toContain('（已經用這台電腦的瀏覽器打開上面的網址）\n');
    expect(io.out()).toContain('等待你在瀏覽器裡按「允許」…（按 Ctrl-C 取消）\n');
    expect(io.out()).toContain(`已登入 ${s.relay.origin}：Ian（github:4242）`);
    // Only the page: a link that carries the code is what a phisher would send (the code is typed by the person).
    expect(io.opened).toEqual([`${s.relay.origin}/device`]);
    // One poll per interval: pending, then (after the person allowed it) the session.
    expect(time.waits).toEqual([5_000, 5_000]);
    expect(s.relay.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /auth/device/start',
      'POST /auth/device/token',
      'POST /device',
      'POST /auth/device/token',
    ]);
    const paths = statePaths(s.env);
    expect((await lstat(paths.credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700);
    const saved = (await loadCredentials(paths)).relays[s.relay.origin];
    expect(saved?.userId).toBe('github:4242');
    // The token is a secret: never printed; nor is the device code (`<code>.<secret>`).
    expect(io.out()).not.toContain(saved?.token as string);
    expect(io.out()).not.toMatch(/[A-Z]{8}\.[A-Za-z0-9_-]{43}/);
    expect(io.out().indexOf('（已經用這台電腦的瀏覽器打開上面的網址）')).toBeLessThan(io.out().indexOf('等待你在瀏覽器裡按'));
  });

  it('opens this machine\'s browser only when allowed: never with --no-browser; a refused opener (SSH, no display) only prints', async () => {
    const s = await setup();
    const noBrowser = testIo({ env: s.env, openUrl: browserOpening, ...virtualTime(async (n) => { if (n === 1) await decide(s.relay, printedCode(noBrowser.out())); }) });
    expect(await runCli(['login', '--relay', s.relay.origin, '--no-browser'], noBrowser)).toBe(0);
    expect(noBrowser.opened).toEqual([]);
    expect(noBrowser.out()).toContain(`  ${s.relay.origin}/device\n`);
    expect(noBrowser.out()).not.toContain('已經用這台電腦的瀏覽器打開');

    // processIo's opener answers false over SSH, in CI, without a terminal or a display (cli/io.ts browserBlock): the
    // page and the code are printed all the same, and nothing claims a browser was opened.
    const refused = testIo({ env: { ...s.env, SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' }, openUrl: async () => false, ...virtualTime(async (n) => { if (n === 1) await decide(s.relay, printedCode(refused.out())); }) });
    expect(await runCli(['login', '--relay', s.relay.origin], refused)).toBe(0);
    expect(refused.opened).toEqual([`${s.relay.origin}/device`]);
    expect(refused.out()).toContain(`在任何裝置（電腦或手機）打開：\n  ${s.relay.origin}/device\n`);
    expect(refused.out()).not.toContain('已經用這台電腦的瀏覽器打開');
    expect(refused.out()).not.toMatch(/ssh -N|127\.0\.0\.1:\d+\/callback/);
  });

  it('polls 5 s more slowly after each slow_down, and keeps trying through a passing network or relay problem', async () => {
    const s = await setup();
    s.relay.device = { interval: 5, expiresIn: 600 };
    s.relay.pollScript = ['authorization_pending', 'slow_down', 'http_503', 'network', 'slow_down', 'authorization_pending'];
    let io!: TestIo;
    const time = virtualTime(async (n) => {
      if (n === 1) await decide(s.relay, printedCode(io.out()));
    });
    io = testIo({ env: s.env, now: time.now, delay: time.delay });
    expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(0);
    expect(time.waits).toEqual([5_000, 5_000, 10_000, 10_000, 10_000, 15_000, 15_000]);
    expect(tokenPolls(s.relay)).toBe(7);
    expect(io.out().split(`（暫時無法連線到 relay（${s.relay.origin}），會繼續重試）`)).toHaveLength(2);
    expect(io.out()).toContain('已登入');
  });

  it('Ctrl-C while waiting ends the login (exit 130, SIGTERM 143): nothing is saved and the polling stops', async () => {
    for (const [signal, exit] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const s = await setup();
      const io = testIo({ env: s.env, delay: () => new Promise((resolve) => setTimeout(resolve, 20)) });
      const run = runCli(['login', '--relay', s.relay.origin], io);
      await waitFor(() => tokenPolls(s.relay) >= 2, { what: 'the login polling' });
      io.signal(signal);
      expect(await run).toBe(exit);
      expect(io.err()).toBe('smurg：已取消登入\n');
      const polls = tokenPolls(s.relay);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(tokenPolls(s.relay)).toBe(polls);
      await expect(lstat(statePaths(s.env).credentials)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('an expired code ends the login with exit 4: the relay\'s expired_token, or the deadline without asking again', async () => {
    const s = await setup();
    s.relay.pollScript = ['authorization_pending', 'expired_token'];
    const io = testIo({ env: s.env, ...virtualTime() });
    expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(4);
    expect(io.err()).toContain('smurg：代碼已過期，登入沒有完成\n');
    expect(io.err()).toContain('請重新執行，並在 10 分鐘內到瀏覽器輸入代碼、按「允許」。');
    await expect(lstat(statePaths(s.env).credentials)).rejects.toMatchObject({ code: 'ENOENT' });

    // Nobody enters the code: after expiresIn the CLI stops on its own clock, without another poll.
    const t = await setup();
    t.relay.device = { interval: 5, expiresIn: 30 };
    const time = virtualTime();
    const late = testIo({ env: t.env, now: time.now, delay: time.delay });
    expect(await runCli(['login', '--relay', t.relay.origin], late)).toBe(4);
    expect(late.out()).toContain('（1 分鐘內有效）');
    expect(late.err()).toContain('代碼已過期');
    expect(time.waits).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(tokenPolls(t.relay)).toBe(5);
  });

  it('「拒絕」 in the browser ends the login with exit 4 and a zh-TW warning; nothing is saved', async () => {
    const s = await setup();
    let io!: TestIo;
    io = testIo({ env: s.env, ...virtualTime(async (n) => { if (n === 1) await decide(s.relay, printedCode(io.out()), 'deny'); }) });
    expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(4);
    expect(io.err()).toContain('smurg：登入被拒絕：瀏覽器裡按了「拒絕」\n');
    expect(io.err()).toContain('可能有別人拿到了這組代碼');
    expect(Object.keys((await loadCredentials(statePaths(s.env))).relays)).toEqual([]);
  });

  it('a relay that refuses to start one: too many logins from this network (429), or no device login yet (404)', async () => {
    const s = await setup();
    s.relay.startError = { status: 429, error: 'too_many_requests' };
    const busy = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', s.relay.origin], busy)).toBe(4);
    expect(busy.err()).toContain('這個網路在 10 分鐘內開始了太多次登入');
    s.relay.startError = { status: 404, error: 'not_found' };
    const old = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', s.relay.origin], old)).toBe(4);
    expect(old.err()).toContain(`這個 relay 還不支援用代碼登入（${s.relay.origin}）`);
    expect(busy.out()).not.toContain('輸入代碼');
    expect(tokenPolls(s.relay)).toBe(0);
  });

  it('smurg host without a session logs in by code first (the same lines); 「拒絕」 stops it before anything is shared (exit 4)', async () => {
    const s = await setup();
    let io!: TestIo;
    io = testIo({ env: s.env, openUrl: async () => true, ...virtualTime(async (n) => { if (n === 1) await decide(s.relay, printedCode(io.out()), 'deny'); }) });
    expect(await runCli(['host', s.dirs.project, '--relay', s.relay.origin, '--no-keep-awake'], io)).toBe(4);
    const out = io.out();
    expect(out).toContain('尚未登入 relay，先進行登入。\n在任何裝置（電腦或手機）打開：\n');
    expect(out).toContain(`  ${s.relay.origin}/device\n輸入代碼：${printedCode(out)}   （10 分鐘內有效）\n`);
    expect(io.opened).toEqual([`${s.relay.origin}/device`]);
    expect(io.err()).toContain('登入被拒絕');
    expect(s.relay.requests.map((r) => r.path)).not.toContain('/api/workspaces');
    await expect(lstat(statePaths(s.env).credentials)).rejects.toMatchObject({ code: 'ENOENT' });
    // The login that is allowed goes on to share: host-relay.test.ts (its hosts log in through this fake relay's /device).
  });
});

describe('smurg login --dev-user and options', () => {
  it('--dev-user uses the relay dev login for a relay on a local hostname', async () => {
    const s = await setup();
    const io = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', s.relay.origin, '--dev-user', 'amy'], io)).toBe(0);
    expect(io.out()).toContain('dev:amy');
    expect((await loadCredentials(statePaths(s.env))).relays[s.relay.origin]?.userId).toBe('dev:amy');
    expect((await lstat(statePaths(s.env).credentials)).mode & 0o777).toBe(0o600);
    expect(s.relay.requests.map((r) => r.path)).toEqual(['/auth/dev/token']);
  });

  it('--dev-user is refused for a relay that is not on a local hostname (exit 2), without any request', async () => {
    const s = await setup();
    const calls: string[] = [];
    const io = testIo({ env: s.env });
    const guarded = { ...io, fetch: (async (url: string) => {
      calls.push(String(url));
      throw new Error('no network in this test');
    }) as unknown as typeof fetch };
    expect(await runCli(['login', '--relay', 'https://relay.example.com', '--dev-user', 'amy'], guarded)).toBe(2);
    expect(io.err()).toContain('--dev-user 只能用在本機的 relay');
    expect(calls).toEqual([]);
    await expect(lstat(statePaths(s.env).credentials)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a relay URL that is not https (http only for localhost), and --provider (the login method is chosen in the browser now)', async () => {
    const s = await setup();
    const io = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', 'http://relay.example.com'], io)).toBe(2);
    expect(io.err()).toContain('--relay 的網址不正確');
    const io2 = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', s.relay.origin, '--provider', 'github'], io2)).toBe(2);
    expect(io2.err()).toContain('不認得的選項 --provider');
    expect(s.relay.requests).toEqual([]);
  });

  it('--help describes the device-code login and no longer offers --provider', async () => {
    const io = testIo({ env: {} });
    expect(await runCli(['login', '--help'], io)).toBe(0);
    expect(io.out()).toContain('用法：smurg login [--relay 網址] [--dev-user 名稱] [--no-browser]');
    expect(io.out()).toContain('在任何裝置（電腦或手機）的瀏覽器打開網址');
    expect(io.out()).not.toContain('--provider');
  });
});

describe('no built-in relay (CLI-12)', () => {
  it('without --relay, SMURG_RELAY_URL or an earlier login, login and host refuse (exit 2) instead of guessing a domain', async () => {
    const s = await setup();
    const login = testIo({ env: s.env, openUrl: browserOpening });
    expect(await runCli(['login'], login)).toBe(2);
    expect(login.err()).toContain('沒有指定 relay');
    expect(login.err()).toContain('--relay');
    const host = testIo({ env: s.env, openUrl: browserOpening });
    expect(await runCli(['host', s.dirs.project, '--no-keep-awake'], host)).toBe(2);
    expect(host.err()).toContain('沒有指定 relay');
    expect([...login.opened, ...host.opened]).toEqual([]);
    expect(s.relay.requests).toEqual([]);
    // SMURG_RELAY_URL, then the relay of the last login, are used when given.
    const fromEnv = testIo({ env: { ...s.env, SMURG_RELAY_URL: s.relay.origin } });
    expect(await runCli(['login', '--dev-user', 'amy'], fromEnv)).toBe(0);
    expect(fromEnv.out()).toContain(`已登入 ${s.relay.origin}`);
    const remembered = testIo({ env: s.env });
    expect(await runCli(['logout'], remembered)).toBe(0);
    expect(remembered.out()).toContain(`已登出 ${s.relay.origin}`);
  });
});

describe('smurg logout', () => {
  it('forgets the relay session; --all forgets every one', async () => {
    const s = await setup();
    await runCli(['login', '--relay', s.relay.origin, '--dev-user', 'amy'], testIo({ env: s.env }));
    const io = testIo({ env: s.env });
    expect(await runCli(['logout', '--relay', s.relay.origin], io)).toBe(0);
    expect(io.out()).toContain('已登出');
    expect((await loadCredentials(statePaths(s.env))).relays).toEqual({});
    await runCli(['login', '--relay', s.relay.origin, '--dev-user', 'amy'], testIo({ env: s.env }));
    const all = testIo({ env: s.env });
    expect(await runCli(['logout', '--all'], all)).toBe(0);
    await expect(readFile(statePaths(s.env).credentials)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
