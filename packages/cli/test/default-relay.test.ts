// The built-in relay (src/relay/default-relay.ts, DEFAULT_RELAY_URL): null ships today and keeps CLI-12's refusal;
// once the project's hosted relay is filled in, `smurg host` / `login` / `logout` / `attach` use it when nothing else
// names a relay (--relay, SMURG_RELAY_URL, the relay of the last login, an invite link, a remembered join), say so
// before they talk to it (`smurg host`: its login names the relay; the start shows only the links), show it in --help,
// and `smurg status` names it for a running share. Here the built-in value is swapped for a fake relay on 127.0.0.1: no
// test reaches the real hosted relay.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_MODULES, systemClock, type Daemon } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { relayOrigin } from '@smurg/protocol/relay';
import { runCli } from '../src/cli/run.ts';
import { commandContext } from '../src/commands/context.ts';
import { runHost } from '../src/commands/host.ts';
import { pickRelay } from '../src/relay/relay.ts';
import { loadCredentials } from '../src/state/credentials.ts';
import { statePaths } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { echoSessions } from './fixtures/echo-sessions.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';

const builtIn = vi.hoisted(() => ({ url: null as string | null }));
vi.mock('../src/relay/default-relay.ts', () => ({
  get DEFAULT_RELAY_URL(): string | null {
    return builtIn.url;
  },
}));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  builtIn.url = null;
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

async function setup(): Promise<{ dirs: Dirs; relay: FakeRelay; env: Record<string, string> }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const relay = await startFakeRelay();
  cleanups.push(() => relay.close());
  return { dirs, relay, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } };
}

describe('the value that ships', () => {
  it('is null or the exact https origin of a relay (no path, no placeholder)', async () => {
    const { DEFAULT_RELAY_URL } = await vi.importActual<typeof import('../src/relay/default-relay.ts')>('../src/relay/default-relay.ts');
    if (DEFAULT_RELAY_URL === null) return;
    expect(relayOrigin(DEFAULT_RELAY_URL).origin).toBe(DEFAULT_RELAY_URL);
    expect(DEFAULT_RELAY_URL.startsWith('https://')).toBe(true);
    expect(DEFAULT_RELAY_URL).not.toMatch(/[<>]|example|subdomain|localhost|127\.0\.0\.1/i);
  });
});

describe('relay choice', () => {
  it('--relay, then SMURG_RELAY_URL, then the last login, then the built-in relay; without one: the CLI-12 refusal', () => {
    const io = testIo({ env: {} });
    const none = { defaultRelay: null, relays: {} };
    const hosted = 'https://smurg-relay.example-sub.workers.dev';
    expect(pickRelay('https://a.example.org', io, { defaultRelay: 'https://b.example.org', relays: {} }, hosted)).toEqual({ origin: 'https://a.example.org', source: 'flag' });
    expect(pickRelay(undefined, testIo({ env: { SMURG_RELAY_URL: 'https://e.example.org' } }), none, hosted)).toEqual({ origin: 'https://e.example.org', source: 'env' });
    expect(pickRelay(undefined, io, { defaultRelay: 'https://b.example.org', relays: {} }, hosted)).toEqual({ origin: 'https://b.example.org', source: 'login' });
    expect(pickRelay(undefined, io, none, hosted)).toEqual({ origin: hosted, source: 'built-in' });
    expect(() => pickRelay(undefined, io, none, null)).toThrow('No relay was given');
  });

  it('while the built-in relay is null, login and host refuse exactly as before, and --help says there is none', async () => {
    const s = await setup();
    const login = testIo({ env: s.env, openUrl: browserOpening });
    expect(await runCli(['login'], login)).toBe(2);
    expect(login.err()).toContain('smurg: No relay was given');
    expect(login.err()).toContain('This smurg has no built-in public relay (docs: https://smurg.ai/docs/hosting/');
    const host = testIo({ env: s.env, openUrl: browserOpening });
    expect(await runCli(['host', s.dirs.project, '--no-keep-awake'], host)).toBe(2);
    expect(host.err()).toContain('smurg: No relay was given');
    expect(s.relay.requests).toEqual([]);
    for (const command of ['host', 'login']) {
      const help = testIo({ env: s.env });
      expect(await runCli([command, '--help'], help)).toBe(0);
      expect(help.out()).toContain('there is no built-in relay');
    }
    const attachHelp = testIo({ env: s.env });
    expect(await runCli(['attach', '--help'], attachHelp)).toBe(0);
    expect(attachHelp.out()).toContain("(default: the invite link's URL, or the relay you used last)");
  });

  it('with a built-in relay: login uses it (and says so), --help shows it, SMURG_RELAY_URL and --relay still win', async () => {
    const s = await setup();
    builtIn.url = s.relay.origin;
    const login = testIo({ env: s.env });
    expect(await runCli(['login', '--dev-user', 'amy'], login)).toBe(0);
    expect(login.out()).toContain(`Using smurg's built-in public relay: ${s.relay.origin}`);
    expect(login.out()).toContain(`Logged in to ${s.relay.origin}`);
    expect((await loadCredentials(statePaths(s.env))).relays[s.relay.origin]?.userId).toBe('dev:amy');
    for (const command of ['host', 'login', 'attach']) {
      const help = testIo({ env: s.env });
      expect(await runCli([command, '--help'], help)).toBe(0);
      expect(help.out()).toContain(`the built-in public relay ${s.relay.origin}`);
    }
    // Another relay named in the environment: used, and no built-in notice.
    const other = await startFakeRelay();
    cleanups.push(() => other.close());
    const viaEnv = testIo({ env: { ...s.env, SMURG_RELAY_URL: other.origin } });
    expect(await runCli(['login', '--dev-user', 'amy'], viaEnv)).toBe(0);
    expect(viaEnv.out()).toContain(`Logged in to ${other.origin}`);
    expect(viaEnv.out()).not.toContain('built-in public relay');
    // The last login is remembered from now on (credentials.json), before the built-in relay.
    const remembered = testIo({ env: s.env });
    expect(await runCli(['logout'], remembered)).toBe(0);
    expect(remembered.out()).toContain(`Logged out of ${other.origin}`);
  });

  it('smurg host without --relay shares through the built-in relay; `smurg status` names it (the start shows only the links)', async () => {
    const s = await setup();
    builtIn.url = s.relay.origin;
    // The in-memory relay serves one workspace id: pre-seed the folder's id as an earlier `smurg host` would have.
    const workspaceId = `ws_host_${randomBytes(8).toString('hex')}`;
    await rememberSharedFolder(statePaths(s.env), { folder: await realpath(s.dirs.project), relay: s.relay.origin, workspaceId, createdAt: 1 });
    const memory = new MemoryRelay(workspaceId);
    const issuer = new TestIdentityIssuer(s.relay.origin, generateKeyPairSync('ed25519'), systemClock);
    const echo = echoSessions();
    const io = testIo({ env: s.env, openUrl: browserOpening });
    let ready: (daemon: Daemon) => void = () => {};
    const readyPromise = new Promise<Daemon>((resolve) => {
      ready = resolve;
    });
    const done = runHost([s.dirs.project, '--no-keep-awake'], commandContext(io), {
      daemon: {
        socketFactory: memory.hostSocketFactory(),
        identityKeys: { get: (kid) => (kid === issuer.kid ? issuer.publicKey : null), refresh: async () => {} },
        modules: [echo.module, ...DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local')],
      },
      onReady: (daemon) => ready(daemon),
    });
    cleanups.push(async () => {
      io.signal('SIGTERM');
      await done.catch(() => {});
    });
    await Promise.race([readyPromise, done.then((code) => Promise.reject(new Error(`host ended early (${code}): ${io.err()}`)))]);
    await waitFor(() => memory.hostOnline('ws'), { what: 'the daemon at the relay' });
    // Owner decision 2026-10-01: no relay notice of `smurg host` itself (its login, when one is needed, names the relay).
    expect(io.out()).not.toContain('built-in public relay');
    expect(io.out()).toContain(`${s.relay.origin}/join/${workspaceId}#k=`);
    expect(s.relay.workspaces.get(workspaceId)).toBe('github:4242');
    const status = testIo({ env: s.env });
    expect(await runCli(['status'], status)).toBe(0);
    expect(status.out()).toContain(`  Relay: ${s.relay.origin} (smurg's built-in public relay), interactive connection `);
    io.signal('SIGTERM');
    expect(await done).toBe(0);
  });
});
