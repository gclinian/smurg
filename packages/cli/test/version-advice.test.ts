// A member's command refused with `version` (0.5.1, DESIGN B3).
//
// Where it comes from (W/FOUND-U6 proof p6, W/FOUND-REAL t04 and t05, run with the real 0.4.0 and 0.5.0): the refusal a
// client receives is the bare word `version` (the verdict is `{ ok: false, reason }` in a strict schema of every
// published version), and `smurg attach` said "update smurg" to whoever ran it: also to a member on the newest smurg
// whose HOST had not updated. The command cannot know the host's number without a wire change, so it finds out the one
// thing it can: what `smurg update` would find. Three texts:
//   a newer smurg is published  -> update this one;
//   this one is the newest      -> the host's smurg is the older one: the host stops sharing, updates, shares again;
//   it cannot ask               -> both, this computer's step first.
// The lookup is tested against a stand-in fetch; the channel against a stand-in Connection that ends where the client
// SDK ends after such a refusal (`rejected` / `version`): at the first connect, and at a later reconnect.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionRelay, ConnectionState } from '@smurg/protocol/client';
import type { Welcome } from '@smurg/protocol';
import { RelayWorkspaceChannel, describeTerminalState } from '../src/channel/relay-channel.ts';
import type { ChannelEnd } from '../src/channel/channel.ts';
import { formatFailure } from '../src/cli/errors.ts';
import { runAttach } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { renderText } from '../src/i18n/index.ts';
import type { UpdateNoticeDeps } from '../src/update/notice.ts';
import { VERSION_ADVICE_TIMEOUT_MS, lookUpOwnVersion, versionRefusalAdvice, versionRefusalText } from '../src/update/version-advice.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';

/** The stand-in Connection: what a test scripted is what it reaches. */
const fake = vi.hoisted(() => {
  type State = { kind: string; reason?: string; welcome?: unknown };
  const script: { atOpen: State; welcome: unknown; made: FakeConnection[] } = { atOpen: { kind: 'rejected', reason: 'version' }, welcome: null, made: [] };
  class FakeConnection {
    private state: State = { kind: 'idle' };
    private readonly listeners = new Set<(state: State) => void>();
    closed = false;

    constructor() {
      script.made.push(this);
    }

    start(): void {
      this.set(script.atOpen);
    }

    /** Moves to `state` and tells the subscribers, as the SDK's engine does. */
    set(state: State): void {
      this.state = state;
      for (const listener of [...this.listeners]) listener(state);
    }

    whenOnline(): Promise<unknown> {
      return this.state.kind === 'online' ? Promise.resolve(script.welcome) : Promise.reject(new Error(`connection is ${this.state.kind}`));
    }

    getState(): State {
      return this.state;
    }

    subscribe(listener: (state: State) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    onWelcome(): () => void {
      return () => {};
    }

    close(): void {
      this.closed = true;
    }
  }
  return { script, FakeConnection };
});

vi.mock('@smurg/protocol/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@smurg/protocol/client')>()), Connection: fake.FakeConnection }));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  fake.script.made.length = 0;
  fake.script.atOpen = { kind: 'rejected', reason: 'version' };
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

async function setup(): Promise<{ dirs: Dirs; env: Record<string, string> }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  return { dirs, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir, SMURG_INSTALL_BASE_URL: 'http://127.0.0.1:9' } };
}

/** A released single executable of `version` (the tests themselves run from source). */
const released = (version: string, fetch: typeof globalThis.fetch, timeoutMs?: number): UpdateNoticeDeps => ({ executable: '/nonexistent/bin/smurg', version, fetch, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

/** A downloads site whose latest/VERSION says `latest`; records what was asked. */
function site(latest: string | (() => Promise<Response>)): { fetch: typeof globalThis.fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return typeof latest === 'string' ? new Response(`${latest}\n`, { status: 200 }) : latest();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const TEXT = {
  updateHere: (current: string, latest: string): string =>
    `This smurg (${current}) and the host's smurg are different versions and cannot connect, and a newer smurg (${latest}) is published: update this one (smurg update), then connect again.`,
  hostOlder: (current: string): string => `The host's smurg is older than this one (${current}; no newer smurg is published): the host stops sharing, runs smurg update and shares again. Then connect again.`,
  both: "This smurg and the host's smurg are different versions and cannot connect. First run smurg update here. If it says this is the latest version, the host's smurg is the older one: the host stops sharing, runs smurg update and shares again.",
};

describe("what smurg update's own lookup says about this smurg (lookUpOwnVersion)", () => {
  it('a newer smurg is published; this is the newest (or newer than anything published)', async () => {
    const { env } = await setup();
    const io = testIo({ env });
    const newer = site('0.5.1');
    expect(await lookUpOwnVersion(io, released('0.5.0', newer.fetch))).toEqual({ kind: 'newer-published', current: '0.5.0', latest: '0.5.1' });
    // Exactly the request of `smurg update`: <downloads>/latest/VERSION, and nothing else.
    expect(newer.asked).toEqual(['http://127.0.0.1:9/latest/VERSION']);
    expect(await lookUpOwnVersion(io, released('0.5.1', site('0.5.1').fetch))).toEqual({ kind: 'newest', current: '0.5.1' });
    expect(await lookUpOwnVersion(io, released('0.6.0', site('0.5.1').fetch))).toEqual({ kind: 'newest', current: '0.6.0' });
    // A pre-release of the published version is older than it, as `smurg update` orders them.
    expect(await lookUpOwnVersion(io, released('0.5.1-rc.1', site('0.5.1').fetch))).toEqual({ kind: 'newer-published', current: '0.5.1-rc.1', latest: '0.5.1' });
  });

  it('it cannot ask: the site fails, answers something else or never answers; the person said no (SMURG_NO_UPDATE_CHECK); smurg runs from source', async () => {
    const { env } = await setup();
    const io = testIo({ env });
    for (const broken of [
      site(() => Promise.reject(new TypeError('fetch failed'))),
      site(() => Promise.resolve(new Response('no', { status: 500 }))),
      site(() => Promise.resolve(new Response('<html>', { status: 200 }))),
      site('not-a-version'),
    ]) {
      expect(await lookUpOwnVersion(io, released('0.5.0', broken.fetch))).toEqual({ kind: 'unknown' });
      expect(broken.asked).toHaveLength(1);
    }
    // A site that never answers: given up within the timeout (never the whole command hanging).
    const never = site(() => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(await lookUpOwnVersion(io, released('0.5.0', never.fetch, 150))).toEqual({ kind: 'unknown' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(VERSION_ADVICE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);

    // Nothing is asked at all:
    const optedOut = site('9.9.9');
    expect(await lookUpOwnVersion(testIo({ env: { ...env, SMURG_NO_UPDATE_CHECK: '1' } }), released('0.5.0', optedOut.fetch))).toEqual({ kind: 'unknown' });
    const fromSource = site('9.9.9');
    expect(await lookUpOwnVersion(io, { executable: null, version: '0.5.0', fetch: fromSource.fetch })).toEqual({ kind: 'unknown' });
    // … and the tests' own default (no seam: this process is not the single executable) asks nothing either.
    expect(await lookUpOwnVersion(io)).toEqual({ kind: 'unknown' });
    const badSite = site('9.9.9');
    expect(await lookUpOwnVersion(testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: 'ftp://example.invalid' } }), released('0.5.0', badSite.fetch))).toEqual({ kind: 'unknown' });
    expect(await lookUpOwnVersion(io, released('not a version', site('9.9.9').fetch))).toEqual({ kind: 'unknown' });
    expect([...optedOut.asked, ...fromSource.asked, ...badSite.asked]).toEqual([]);
  });

  it('the three texts, in both languages: who has to act is said, and "update smurg" is never said to the side that is already newest', () => {
    const updateHere = versionRefusalText({ kind: 'newer-published', current: '0.5.0', latest: '0.5.1' });
    const hostOlder = versionRefusalText({ kind: 'newest', current: '0.5.1' });
    const both = versionRefusalText({ kind: 'unknown' });
    expect(renderText('en', updateHere)).toBe(TEXT.updateHere('0.5.0', '0.5.1'));
    expect(renderText('en', hostOlder)).toBe(TEXT.hostOlder('0.5.1'));
    expect(renderText('en', both)).toBe(TEXT.both);
    // The member's own step comes first when nobody could be asked.
    expect(TEXT.both.indexOf('run smurg update here')).toBeLessThan(TEXT.both.indexOf('the host stops sharing'));
    expect(renderText('en', hostOlder)).not.toMatch(/update this one|run smurg update here/);
    expect(renderText('zh-TW', updateHere)).toBe('這個 smurg（0.5.0）和主人的 smurg 版本不同，無法連線，而且已經有更新的版本（0.5.1）：請更新這個 smurg（smurg update），再重新連線。');
    expect(renderText('zh-TW', hostOlder)).toBe('主人的 smurg 比這個（0.5.1，目前沒有更新的版本）舊：請主人停止分享、執行 smurg update，再重新分享；然後你再重新連線。');
    expect(renderText('zh-TW', both)).toBe(
      '這個 smurg 和主人的 smurg 版本不同，無法連線。請先在這台電腦執行 smurg update；如果它說已經是最新版本，就是主人的 smurg 比較舊：請主人停止分享、執行 smurg update，再重新分享。',
    );
    // What the connection itself can say (no lookup) is the text that names both sides.
    expect(renderText('en', describeTerminalState({ kind: 'rejected', reason: 'version' } as ConnectionState).message)).toBe(TEXT.both);
  });
});

describe('smurg attach through the relay, refused with `version`', () => {
  const WORKSPACE = 'ws_version_refused_001';
  const relayFor = async (): Promise<ConnectionRelay> => ({}) as ConnectionRelay;

  const cases: readonly [string, (env: Record<string, string>) => { update: UpdateNoticeDeps; extraEnv?: Record<string, string> }, string][] = [
    ['the lookup says a newer smurg is published: update this one', () => ({ update: released('0.5.0', site('0.5.1').fetch) }), TEXT.updateHere('0.5.0', '0.5.1')],
    ["the lookup says this is the newest: the host's smurg is the older one", () => ({ update: released('0.5.1', site('0.5.1').fetch) }), TEXT.hostOlder('0.5.1')],
    ['the lookup cannot be made (the site is down): both steps, this computer\'s first', () => ({ update: released('0.5.0', site(() => Promise.reject(new TypeError('fetch failed'))).fetch) }), TEXT.both],
    ['the lookup may not be made (SMURG_NO_UPDATE_CHECK=1): both steps', () => ({ update: released('0.5.0', site('0.5.1').fetch), extraEnv: { SMURG_NO_UPDATE_CHECK: '1' } }), TEXT.both],
  ];

  for (const [name, make, expected] of cases) {
    it(name, async () => {
      const { env } = await setup();
      const { update, extraEnv } = make(env);
      const io = testIo({ env: { ...env, ...extraEnv } });
      const failure = await runAttach(['--workspace', WORKSPACE, '--relay', 'http://127.0.0.1:9'], commandContext(io), { relayFor, update }).then(
        () => null,
        (err: unknown) => formatFailure(err, 'en'),
      );
      expect(failure).toEqual({ text: `smurg: ${expected}\n`, exitCode: 1 });
      expect(fake.script.made).toHaveLength(1);
      expect(fake.script.made[0]?.closed).toBe(true);
    });
  }

  it('a refusal at a later reconnect (the host came back as another version) ends the attach with the same words, once the lookup answered', async () => {
    const { dirs } = await setup();
    const welcome = { workspace: { name: 'tidepool' }, member: { userId: 'dev:amy' } } as unknown as Welcome;
    fake.script.welcome = welcome;
    fake.script.atOpen = { kind: 'online', welcome };
    let answer: (text: string) => void = () => {};
    const asked = new Promise<string>((resolve) => {
      answer = resolve;
    });
    let lookups = 0;
    const channel = await RelayWorkspaceChannel.open({
      relay: await relayFor(),
      workspaceId: WORKSPACE,
      stateDir: dirs.stateDir,
      invite: null,
      deviceName: 'smurg CLI (test)',
      versionRefused: () => {
        lookups += 1;
        return asked;
      },
    });
    const ends: ChannelEnd[] = [];
    channel.onEnd((end) => ends.push(end));
    const conn = fake.script.made[0] as InstanceType<typeof fake.FakeConnection>;
    conn.set({ kind: 'rejected', reason: 'version' });
    // Not announced before the words are known; a state that follows changes nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ends).toEqual([]);
    conn.set({ kind: 'closed', reason: 'local' });
    answer(TEXT.hostOlder('0.5.1'));
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(ends[0]).toEqual({ reason: 'rejected', message: TEXT.hostOlder('0.5.1') });
    expect(lookups).toBe(1);
    // Asked afterwards, a listener gets the same end at once.
    const late: ChannelEnd[] = [];
    channel.onEnd((end) => late.push(end));
    await vi.waitFor(() => expect(late).toEqual(ends));
  });

  it('every other refusal keeps its own text and asks the downloads site nothing', async () => {
    const { env } = await setup();
    fake.script.atOpen = { kind: 'rejected', reason: 'device-revoked' };
    const downloads = site('9.9.9');
    const failure = await runAttach(['--workspace', WORKSPACE, '--relay', 'http://127.0.0.1:9'], commandContext(testIo({ env })), { relayFor, update: released('0.5.0', downloads.fetch) }).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    expect(failure?.text).toContain("This device's key was revoked");
    expect(downloads.asked).toEqual([]);
    // And the helper never rejects, whatever the seams do.
    await expect(versionRefusalAdvice(testIo({ env }), { executable: '/nonexistent/bin/smurg', version: '0.5.0', fetch: (() => { throw new Error('boom'); }) as unknown as typeof globalThis.fetch })).resolves.toEqual({ id: 'channel.rejected.version' });
  });
});
