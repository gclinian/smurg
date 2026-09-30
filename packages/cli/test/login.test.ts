// `smurg login` / `smurg logout` through their modules with an injected io: the loopback login (PKCE-bound code,
// state checked, token saved 0600), the dev login only for a relay on a local hostname, zh-TW errors, exit codes.
import { lstat, readFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run.ts';
import { loadCredentials } from '../src/state/credentials.ts';
import { statePaths } from '../src/state/paths.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';
import { cliLoginConfirmCode } from '@smurg/protocol/client';

// These tests are about a CLI WITHOUT a built-in relay (CLI-12), whatever src/relay/default-relay.ts ships: no test may
// ever reach the real hosted relay. test/default-relay.test.ts covers a CLI with one.
vi.mock('../src/relay/default-relay.ts', () => ({ DEFAULT_RELAY_URL: null }));

let dirs: Dirs | null = null;
let relay: FakeRelay | null = null;
afterEach(async () => {
  await relay?.close();
  await dirs?.cleanup();
  relay = null;
  dirs = null;
});

async function setup(): Promise<{ dirs: Dirs; relay: FakeRelay; env: Record<string, string> }> {
  dirs = await makeDirs();
  relay = await startFakeRelay();
  return { dirs, relay, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } };
}

describe('smurg login', () => {
  it('loopback login: opens the relay, receives the code on 127.0.0.1, exchanges it with the PKCE verifier, saves the token 0600', async () => {
    const s = await setup();
    const io = testIo({ env: s.env, openUrl: browserOpening });
    const code = await runCli(['login', '--relay', s.relay.origin], io);
    expect(io.err()).toBe('');
    expect(code).toBe(0);
    expect(io.opened).toHaveLength(1);
    const opened = new URL(io.opened[0] as string);
    expect(opened.origin).toBe(s.relay.origin);
    expect(opened.pathname).toBe('/auth/cli/start');
    expect(opened.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The confirmation code the relay's page shows for this login's state (review SEC-E-03) is printed next to the URL.
    expect(io.out()).toContain(`確認碼：${cliLoginConfirmCode(opened.searchParams.get('state') as string)}`);
    expect(io.out()).toContain('已登入');
    expect(io.out()).toContain('github:4242');
    const paths = statePaths(s.env);
    expect((await lstat(paths.credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700);
    const saved = (await loadCredentials(paths)).relays[s.relay.origin];
    expect(saved?.userId).toBe('github:4242');
    // The token is a secret: never printed.
    expect(io.out()).not.toContain(saved?.token as string);
    expect(s.relay.requests.map((r) => r.path)).toEqual(['/auth/cli/start', '/auth/cli/token']);
  });

  it('a callback with the relay error ends the login with exit 4 and a zh-TW message; nothing is saved', async () => {
    const s = await setup();
    s.relay.loginError = 'access_denied';
    const io = testIo({ env: s.env, openUrl: browserOpening });
    expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(4);
    expect(io.err()).toContain('登入失敗（access_denied）');
    expect(Object.keys((await loadCredentials(statePaths(s.env))).relays)).toEqual([]);
  });

  it('a request with a wrong state is ignored; the login keeps waiting for the real callback', async () => {
    const s = await setup();
    const io = testIo({
      env: s.env,
      openUrl: async (url) => {
        const port = new URL(url).searchParams.get('port');
        const forged = await fetch(`http://127.0.0.1:${port}/callback?code=forged&state=${'x'.repeat(32)}`);
        expect(forged.status).toBe(400);
        return browserOpening(url);
      },
    });
    expect(await runCli(['login', '--relay', s.relay.origin], io)).toBe(0);
    expect(s.relay.requests.filter((r) => r.path === '/auth/cli/token')).toHaveLength(1);
  });

  it('--dev-user uses the relay dev login for a relay on a local hostname', async () => {
    const s = await setup();
    const io = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', s.relay.origin, '--dev-user', 'amy'], io)).toBe(0);
    expect(io.out()).toContain('dev:amy');
    expect((await loadCredentials(statePaths(s.env))).relays[s.relay.origin]?.userId).toBe('dev:amy');
    expect((await lstat(statePaths(s.env).credentials)).mode & 0o777).toBe(0o600);
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

  it('refuses a relay URL that is not https (http only for localhost) and bad option combinations', async () => {
    const s = await setup();
    const io = testIo({ env: s.env });
    expect(await runCli(['login', '--relay', 'http://relay.example.com'], io)).toBe(2);
    expect(io.err()).toContain('--relay 的網址不正確');
    const io2 = testIo({ env: s.env });
    expect(await runCli(['login', '--provider', 'myspace'], io2)).toBe(2);
    expect(io2.err()).toContain('--provider 只能是 github 或 google');
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
