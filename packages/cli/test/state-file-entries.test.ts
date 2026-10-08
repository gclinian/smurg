// An ENTRY of `~/.smurg/workspaces.json` or `~/.smurg/credentials.json` that this smurg cannot read (0.5.1).
//
// Where it comes from (W/FOUND-U6; the lead's decision on W/NEEDS-LEAD.md "From K3A" item 2): 0.5.1 refuses a FILE it
// cannot read (state-file-version.test.ts), but inside a version-1 file an entry that fails a field check (a workspace
// id in a form this smurg does not know, a folder path over 4096 characters, a session without a token, something
// that is no object at all) was skipped without a word and was GONE at the next write: `smurg host` of any other
// folder rewrote the list without it. For a later smurg that wrote the entry, that is a shared folder that lost its
// workspace (new members, new invite links, a new daemon key at its next `smurg host`), or a login that is gone.
//
// Now such an entry is kept: every write puts it back exactly as it was, at its place, and the command says once, on
// stderr, how many entries of which file it could not read. This smurg does not USE the entry (it cannot read it).
//
// One thing followed from "does not use it" and is closed here (F0's open item; the lead's decision): `smurg host` of
// the very folder such an entry is FOR found no entry it could read and gave the folder a NEW workspace, without a
// word about what that leaves behind (the members, the invite links, the daemon's key): the silent reset. Now it
// stops, names the entry and the file, and makes nothing.
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock, type Daemon, type HostSocketFactory } from '@smurg/daemon';
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { CliError, formatFailure } from '../src/cli/errors.ts';
import { runCli } from '../src/cli/run.ts';
import { commandContext } from '../src/commands/context.ts';
import { runHost } from '../src/commands/host.ts';
import { loadCredentials, removeSessions, saveSession, sessionFor } from '../src/state/credentials.ts';
import { statePaths, type StatePaths } from '../src/state/paths.ts';
import { loadWorkspaces, lookUpSharedFolder, rememberJoined, rememberSharedFolder, sharedFolderFor } from '../src/state/workspaces.ts';
import { CLI_VERSION } from '../src/version.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

async function setup(): Promise<{ dirs: Dirs; env: Record<string, string>; paths: StatePaths }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
  return { dirs, env, paths: statePaths(env) };
}

/** A private file as smurg writes it: JSON with two spaces and a last newline, 0600. Returns its text. */
async function put(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  return text;
}

/** The lines of `entry` as they stand in a file smurg wrote, `depth` levels in: what "byte for byte" is checked on. */
function block(entry: unknown, depth: number): string {
  return JSON.stringify(entry, null, 2)
    .split('\n')
    .map((line) => `${'  '.repeat(depth)}${line}`)
    .join('\n');
}

const RELAY = 'https://app.smurg.ai';
const TIDEPOOL = { folder: '/work/tidepool', relay: RELAY, workspaceId: 'ws_x0ero8pS70bWM5G4VbZ1NA', createdAt: 1791377829732 };
const HARBOUR = { folder: '/work/harbour', relay: RELAY, workspaceId: 'ws_Zm9yIHRoZSB0ZXN0IG9ubHk', createdAt: 1791377829900 };
/** As a later smurg might write one: a workspace id in another form, and fields this smurg has never seen. */
const LATER_SHARED = { folder: '/work/atoll', relay: RELAY, workspaceId: 'w2:9f3c1e77-52aa-4c0e-b1d3-7a6f0c2e4b19', createdAt: 1791377830000, region: 'eu', hosts: ['github:4242'] };
/** A folder path longer than this smurg takes (4096), otherwise as 0.5.0 writes it. */
const LONG_FOLDER = { folder: `/work/${'deep/'.repeat(900)}leaf`, relay: RELAY, workspaceId: 'ws_bG9uZyBmb2xkZXIgcGF0aA', createdAt: 1791377830100 };
const JOINED = { workspaceId: 'ws_am9pbmVkIGFzIGEgZ3Vlc3Q', relay: RELAY, name: 'tidepool', joinedAt: 1791378217394 };
/** No relay (this smurg needs one), and a field of a later smurg. */
const LATER_JOINED = { workspaceId: 'ws_bGF0ZXIgam9pbmVkIG9uZQ', relays: [RELAY, 'https://eu.smurg.ai'], name: 'atoll', joinedAt: 1791378217500 };

const WORKSPACES = { version: 1, shared: [TIDEPOOL, LATER_SHARED, 'not an entry at all', LONG_FOLDER, HARBOUR], joined: [LATER_JOINED, JOINED] };

const noteWorkspaces = (count: number, path: string): string =>
  `Note: The workspace list (workspaces.json) holds ${count} ${count === 1 ? 'entry' : 'entries'} this smurg cannot read (this is ${CLI_VERSION}); ${count === 1 ? 'it is' : 'they are'} left exactly as ${count === 1 ? 'it is' : 'they are'}, and this smurg does not use ${count === 1 ? 'it' : 'them'}: ${path}\n` +
  '  If a newer smurg was ever used on this computer, run smurg update.\n';

describe('workspaces.json: an entry this smurg cannot read is kept, at its place, exactly as it was', () => {
  it('reading uses the entries it can read and nothing else', async () => {
    const { paths } = await setup();
    await put(paths.workspaces, WORKSPACES);
    const book = await loadWorkspaces(paths);
    expect(book).toEqual({ shared: [TIDEPOOL, HARBOUR], joined: [JOINED] });
    expect(sharedFolderFor(book, '/work/atoll', RELAY)).toBeNull();
  });

  it('remembering another shared folder, and another joined workspace, writes every entry back: the file is the old one plus the new entry', async () => {
    const { paths } = await setup();
    const before = await put(paths.workspaces, WORKSPACES);
    const added = { folder: '/work/reef', relay: RELAY, workspaceId: 'ws_YSBuZXcgc2hhcmVkIG9uZQ', createdAt: 1791400000000 };
    await rememberSharedFolder(paths, added);
    const after = await readFile(paths.workspaces, 'utf8');
    expect(after).toBe(`${JSON.stringify({ version: 1, shared: [...WORKSPACES.shared, added], joined: WORKSPACES.joined }, null, 2)}\n`);
    for (const entry of [LATER_SHARED, LONG_FOLDER]) expect(after).toContain(`\n${block(entry, 2)},\n`);
    expect(after).toContain('\n    "not an entry at all",\n');
    expect(after).toContain(`\n${block(LATER_JOINED, 2)},\n`);
    expect(before.length).toBeLessThan(after.length);

    // A shared folder that is remembered AGAIN (the same folder and relay) takes the place at the end, as it always
    // has; a joined workspace likewise. The entries this smurg cannot read stay where they are.
    const again = { ...TIDEPOOL, workspaceId: 'ws_dGlkZXBvb2wgYWdhaW4gMDE', createdAt: 1791400000500 };
    await rememberSharedFolder(paths, again);
    const joinedAgain = { ...JOINED, name: 'tidepool, renamed', joinedAt: 1791400000900 };
    await rememberJoined(paths, joinedAgain);
    expect(await readFile(paths.workspaces, 'utf8')).toBe(
      `${JSON.stringify({ version: 1, shared: [LATER_SHARED, 'not an entry at all', LONG_FOLDER, HARBOUR, added, again], joined: [LATER_JOINED, joinedAgain] }, null, 2)}\n`,
    );
  });

  it('a list that is there and is no list is not "empty": the file is refused and left as it is', async () => {
    const { paths } = await setup();
    for (const odd of [{ version: 1, shared: { '/work/tidepool': TIDEPOOL }, joined: [] }, { version: 1, shared: [TIDEPOOL], joined: 'none' }]) {
      const before = await put(paths.workspaces, odd);
      for (const run of [() => loadWorkspaces(paths), () => rememberSharedFolder(paths, HARBOUR), () => rememberJoined(paths, JOINED)]) {
        const failure = await run().then(
          () => null,
          (err: unknown) => {
            expect(err).toBeInstanceOf(CliError);
            return formatFailure(err, 'en').text;
          },
        );
        expect(failure).toContain(`smurg: The workspace list (workspaces.json) is not in the expected format: ${paths.workspaces}\n  Nothing was changed.`);
      }
      expect(await readFile(paths.workspaces, 'utf8')).toBe(before);
    }
    // A list that is not there at all holds nothing that could be lost.
    await put(paths.workspaces, { version: 1 });
    expect(await loadWorkspaces(paths)).toEqual({ shared: [], joined: [] });
  });
});

/** `smurg host <the project>` against a fake relay (already logged in), started and stopped; the whole terminal. */
async function host(dirs: Dirs, env: Record<string, string>, lang: 'en' | 'zh-TW', now: number, at?: FakeRelay): Promise<{ code: number; out: string; err: string; relay: string }> {
  const relay = at ?? (await startFakeRelay());
  if (at === undefined) cleanups.push(() => relay.close());
  const token = 'stored.host-token-for-test';
  relay.tokens.set(token, relay.loginAs);
  // (saveSession reads and writes credentials.json, not the workspace list.)
  await saveSession(statePaths(env), relay.origin, { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: relay.loginAs }, Date.now());
  const issuer = new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock);
  // The in-memory relay serves ONE workspace id, and a folder that is new gets its id in this very run.
  let memory: MemoryRelay | null = null;
  const socketFactory: HostSocketFactory = (url, ...rest) => {
    memory ??= new MemoryRelay(/\/(ws_[A-Za-z0-9_-]+)\//.exec(String(url))?.[1] ?? 'ws_unknown');
    return memory.hostSocketFactory()(url, ...rest);
  };
  const io = testIo({ env: { ...env, SMURG_LANG: lang }, openUrl: browserOpening, now: () => now });
  let ready: (daemon: Daemon) => void = () => {};
  const started = new Promise<Daemon>((resolve) => {
    ready = resolve;
  });
  const ctx = commandContext(io);
  const done = runHost([dirs.project, '--relay', relay.origin, '--no-keep-awake'], ctx, {
    daemon: { socketFactory, identityKeys: { get: (kid: string) => (kid === issuer.kid ? issuer.publicKey : null), refresh: async () => {} } },
    onReady: (daemon) => ready(daemon),
  }).catch((err: unknown) => {
    const failure = formatFailure(err, ctx.lang);
    io.stderr.write(failure.text);
    return failure.exitCode as number;
  });
  let ended = false;
  void done.then(() => {
    ended = true;
  });
  cleanups.push(async () => {
    if (!ended) io.signal('SIGTERM');
    await done;
  });
  if ((await Promise.race([started, done.then(() => null)])) !== null) {
    await waitFor(() => (io.out().match(/\/join\//g) ?? []).length === 2, { what: 'the two links' });
    io.signal('SIGTERM');
  }
  return { code: await done, out: io.out(), err: io.err(), relay: relay.origin };
}

describe('smurg host of ANOTHER folder beside entries this smurg cannot read', () => {
  it('the entry survives byte for byte, the new folder is added, and the command says ONCE how many entries of which file it could not read (both languages)', async () => {
    for (const lang of ['en', 'zh-TW'] as const) {
      const { dirs, env, paths } = await setup();
      const before = await put(paths.workspaces, WORKSPACES);
      const NOW = 1791424800000;
      const t = await host(dirs, env, lang, NOW);
      expect(t.code, t.err).toBe(0);
      const after = await readFile(paths.workspaces, 'utf8');
      const written = JSON.parse(after) as { shared: { folder: string; relay: string; workspaceId: string; createdAt: number }[] };
      const added = written.shared.at(-1);
      expect(added).toEqual({ folder: await realpath(dirs.project), relay: t.relay, workspaceId: expect.stringMatching(/^ws_[A-Za-z0-9_-]{22}$/), createdAt: NOW });
      // The whole file: what it was, with the one new entry at the end of `shared`. Nothing else moved or changed.
      expect(after).toBe(`${JSON.stringify({ version: 1, shared: [...WORKSPACES.shared, added], joined: WORKSPACES.joined }, null, 2)}\n`);
      // Byte for byte: each entry this smurg could not read stands in the file exactly as it stood before.
      for (const kept of [`\n${block(LATER_SHARED, 2)},\n`, '\n    "not an entry at all",\n', `\n${block(LONG_FOLDER, 2)},\n`, `\n${block(LATER_JOINED, 2)},\n`]) {
        expect(before).toContain(kept);
        expect(after).toContain(kept);
      }
      // Said once (the command reads the list several times), on stderr, and nothing else is there.
      expect(t.err).toBe(
        lang === 'en'
          ? noteWorkspaces(4, paths.workspaces)
          : `注意：工作區紀錄檔（workspaces.json）裡有 4 筆資料這個 smurg（${CLI_VERSION}）讀不懂；它們會原封不動地留著，這個 smurg 不會使用它們：${paths.workspaces}\n  如果這台電腦用過較新版的 smurg，請執行 smurg update。\n`,
      );
      expect(t.out).toContain('/join/');
    }
  }, 120_000);

  it('a list without such an entry says nothing', async () => {
    const { dirs, env, paths } = await setup();
    await put(paths.workspaces, { version: 1, shared: [TIDEPOOL], joined: [JOINED] });
    const t = await host(dirs, env, 'en', 1791424800000);
    expect(t.code, t.err).toBe(0);
    expect(t.err).toBe('');
  }, 120_000);
});

describe('smurg host of the folder whose OWN entry this smurg cannot read', () => {
  const NOW = 1791424800000;
  const noteZh = (count: number, path: string): string =>
    `注意：工作區紀錄檔（workspaces.json）裡有 ${count} 筆資料這個 smurg（${CLI_VERSION}）讀不懂；它們會原封不動地留著，這個 smurg 不會使用它們：${path}\n  如果這台電腦用過較新版的 smurg，請執行 smurg update。\n`;

  it('which entry is a folder\'s own: the one that names the folder, unless it names another relay', async () => {
    const { paths } = await setup();
    const atoll = '/work/atoll';
    const otherRelay = { ...LATER_SHARED, relay: 'https://eu.smurg.ai' };
    const noRelay = { folder: atoll, relays: [RELAY], workspaceId: 'ws_bm8gcmVsYXkgaW4gdGhpcw', createdAt: '2026-10-08' };
    await put(paths.workspaces, { version: 1, shared: [TIDEPOOL, 'not an entry at all', LONG_FOLDER, otherRelay, LATER_SHARED, noRelay, HARBOUR], joined: [LATER_JOINED] });
    // An entry this smurg reads is found as before, and nothing else is said about the folder.
    expect(await lookUpSharedFolder(paths, TIDEPOOL.folder, RELAY)).toEqual({ entry: TIDEPOOL, unread: null });
    // The folder's own entry that cannot be read: its place in the list as the file has it (counted from 1) and the
    // fields that do not fit (names of an entry's fields, never anything the file holds). The first such entry.
    expect(await lookUpSharedFolder(paths, atoll, RELAY)).toEqual({ entry: null, unread: { place: 5, fields: ['workspaceId'] } });
    // At another relay the folder is another share: the entry that names THAT relay is its own, and so is the one
    // whose relay cannot be read (it may be this one's).
    expect(await lookUpSharedFolder(paths, atoll, 'https://eu.smurg.ai')).toEqual({ entry: null, unread: { place: 4, fields: ['workspaceId'] } });
    expect(await lookUpSharedFolder(paths, atoll, 'https://third.example')).toEqual({ entry: null, unread: { place: 6, fields: ['relay', 'createdAt'] } });
    // A folder no entry names: new, as before. What cannot be told to be any folder's (no object, no folder that can
    // be compared) is kept and counted, and is nobody's own.
    expect(await lookUpSharedFolder(paths, '/work/reef', RELAY)).toEqual({ entry: null, unread: null });
    expect(await lookUpSharedFolder(paths, LONG_FOLDER.folder, RELAY)).toEqual({ entry: null, unread: { place: 3, fields: ['folder'] } });
    // No file at all: nothing was ever shared.
    const fresh = await setup();
    expect(await lookUpSharedFolder(fresh.paths, atoll, RELAY)).toEqual({ entry: null, unread: null });
  });

  it('stops, names the entry and the file, and makes NO new workspace: the list, the relay and the state folder are as they were (both languages)', async () => {
    for (const lang of ['en', 'zh-TW'] as const) {
      const { dirs, env, paths } = await setup();
      const relay = await startFakeRelay();
      cleanups.push(() => relay.close());
      // As a later smurg might write THIS folder's entry: a workspace id in another form, fields this smurg never saw.
      const own = { ...LATER_SHARED, folder: await realpath(dirs.project), relay: relay.origin };
      const before = await put(paths.workspaces, { version: 1, shared: [TIDEPOOL, 'not an entry at all', own, HARBOUR], joined: [JOINED] });
      const t = await host(dirs, env, lang, NOW, relay);
      expect(t.code).toBe(1);
      expect(t.out).toBe('');
      const workspacesDir = join(paths.stateDir, 'workspaces');
      expect(t.err).toBe(
        lang === 'en'
          ? `${noteWorkspaces(2, paths.workspaces)}smurg: This folder's entry in the workspace list (workspaces.json) is not in a form this smurg can read (this is ${CLI_VERSION}): entry 3 of "shared" in ${paths.workspaces}\n` +
              '  What this smurg cannot read in the entry: workspaceId\n' +
              '  Nothing was changed, and smurg host did not start: the entry is the only link from this folder to its workspace, and without it smurg host would give the folder a new workspace (new members, new invite links, a new daemon key).\n' +
              `  If a newer smurg was ever used on this computer, run smurg update, then smurg host again. Otherwise repair the entry or put a copy of the file back: an entry holds "folder" (the folder's full path), "relay" (the relay's URL), "workspaceId" (the name of the workspace's folder in ${workspacesDir}) and "createdAt" (a whole number).\n`
          : `${noteZh(2, paths.workspaces)}smurg：工作區紀錄檔（workspaces.json）裡，這個資料夾的那筆資料這個 smurg（${CLI_VERSION}）讀不懂：${paths.workspaces} 的「shared」第 3 筆\n` +
              '  這筆資料裡讀不懂的欄位：workspaceId\n' +
              '  沒有更動任何東西，smurg host 也沒有啟動：這筆資料是這個資料夾和它的工作區之間唯一的連結，少了它，smurg host 會幫資料夾建立新的工作區（成員、邀請連結、daemon 金鑰都是新的）。\n' +
              `  如果這台電腦用過較新版的 smurg，請執行 smurg update，再執行一次 smurg host。否則請修好這筆資料，或把這個檔案的備份放回來：一筆資料有「folder」（資料夾的完整路徑）、「relay」（relay 的網址）、「workspaceId」（工作區在 ${workspacesDir} 裡的資料夾名稱）和「createdAt」（一個整數）。\n`,
      );
      // Never a value of the entry.
      expect(t.err).not.toContain('w2:');
      // Nothing was made: the list is byte for byte what it was, no workspace was claimed at the relay, no workspace
      // folder (no key, no state) was created.
      expect(await readFile(paths.workspaces, 'utf8')).toBe(before);
      expect([...relay.workspaces.keys()]).toEqual([]);
      expect(await readdir(workspacesDir).catch(() => [])).toEqual([]);
    }
  }, 120_000);

  it('the same folder shared through ANOTHER relay is another share: an entry that names that other relay does not stop this one', async () => {
    const { dirs, env, paths } = await setup();
    const elsewhere = { ...LATER_SHARED, folder: await realpath(dirs.project), relay: 'https://eu.smurg.ai' };
    await put(paths.workspaces, { version: 1, shared: [elsewhere], joined: [] });
    const t = await host(dirs, env, 'en', NOW);
    expect(t.code, t.err).toBe(0);
    expect(t.err).toBe(noteWorkspaces(1, paths.workspaces));
    const written = JSON.parse(await readFile(paths.workspaces, 'utf8')) as { shared: unknown[] };
    expect(written.shared).toEqual([elsewhere, { folder: elsewhere.folder, relay: t.relay, workspaceId: expect.stringMatching(/^ws_[A-Za-z0-9_-]{22}$/), createdAt: NOW }]);
  }, 120_000);
});

describe('credentials.json: a login this smurg cannot read is kept under its relay, exactly as it was', () => {
  const GOOD = { token: 'eyJhbGciOiJFZERTQSJ9.made-up_for.the-test', userId: 'dev:host', displayName: 'host', provider: 'dev', savedAt: 1791377823330, expiresAt: 1791982623330 };
  /** As a later smurg might write one: no `token` (it keeps it elsewhere), and a field this smurg has never seen. */
  const LATER = { tokenRef: 'keychain:smurg/eu', userId: 'github:4242', displayName: 'Ian', provider: 'github', savedAt: 1791377900000, expiresAt: 1791982700000, scopes: ['host'] };
  const CREDENTIALS = { version: 1, defaultRelay: 'http://localhost:18740', relays: { 'https://eu.smurg.ai': LATER, 'http://localhost:18740': GOOD, 'https://old.example': 'gone' } };
  const SESSION = { token: 'new.login-token_1', tokenType: 'Bearer' as const, expiresIn: 3600, user: { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' as const } };
  const AMY = { token: 'new.login-token_1', userId: 'dev:amy', displayName: 'Amy', provider: 'dev', savedAt: 1_000, expiresAt: 3_601_000 };

  it('reading uses the logins it can read; a new login is added and every other entry is written back as it was', async () => {
    const { paths } = await setup();
    await put(paths.credentials, CREDENTIALS);
    const loaded = await loadCredentials(paths);
    expect(loaded).toEqual({ defaultRelay: 'http://localhost:18740', relays: { 'http://localhost:18740': GOOD } });
    expect(sessionFor(loaded, 'https://eu.smurg.ai', 5)).toBeNull();
    await saveSession(paths, RELAY, SESSION, 1_000);
    const after = await readFile(paths.credentials, 'utf8');
    expect(after).toBe(`${JSON.stringify({ version: 1, defaultRelay: RELAY, relays: { ...CREDENTIALS.relays, [RELAY]: AMY } }, null, 2)}\n`);
    expect(after).toContain(`\n${block(LATER, 2).replace('    {', '    "https://eu.smurg.ai": {')},\n`);
    expect(after).toContain('\n    "https://old.example": "gone",\n');
  });

  it('logging out of one relay, and of every relay, removes the logins this smurg reads and keeps the entries it cannot read', async () => {
    const { paths } = await setup();
    await put(paths.credentials, { ...CREDENTIALS, relays: { ...CREDENTIALS.relays, [RELAY]: AMY } });
    expect(await removeSessions(paths, RELAY)).toBe(1);
    expect(await readFile(paths.credentials, 'utf8')).toBe(`${JSON.stringify(CREDENTIALS, null, 2)}\n`);
    // An entry this smurg cannot read is no login of its own to log out of.
    expect(await removeSessions(paths, 'https://eu.smurg.ai')).toBe(0);
    expect(await readFile(paths.credentials, 'utf8')).toBe(`${JSON.stringify(CREDENTIALS, null, 2)}\n`);
    expect(await removeSessions(paths, 'all')).toBe(1);
    expect(await readFile(paths.credentials, 'utf8')).toBe(`${JSON.stringify({ version: 1, defaultRelay: null, relays: { 'https://eu.smurg.ai': LATER, 'https://old.example': 'gone' } }, null, 2)}\n`);
    // With nothing left that this smurg cannot read, logging out everywhere removes the file, as it always has.
    await put(paths.credentials, { version: 1, defaultRelay: RELAY, relays: { [RELAY]: AMY } });
    expect(await removeSessions(paths, 'all')).toBe(1);
    await expect(readFile(paths.credentials, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a new login to the relay of such an entry takes its place: the person asked for exactly that login', async () => {
    const { paths } = await setup();
    await put(paths.credentials, CREDENTIALS);
    await saveSession(paths, 'https://eu.smurg.ai', SESSION, 1_000);
    expect(await readFile(paths.credentials, 'utf8')).toBe(`${JSON.stringify({ version: 1, defaultRelay: 'https://eu.smurg.ai', relays: { ...CREDENTIALS.relays, 'https://eu.smurg.ai': AMY } }, null, 2)}\n`);
  });

  it('the command says once how many logins it could not read (smurg logout, both languages), and never shows a value of them', async () => {
    for (const lang of ['en', 'zh-TW'] as const) {
      const { env, paths } = await setup();
      await put(paths.credentials, CREDENTIALS);
      const io = testIo({ env: { ...env, SMURG_LANG: lang } });
      expect(await runCli(['logout', '--relay', 'http://localhost:18740'], io)).toBe(0);
      expect(io.err()).toBe(
        lang === 'en'
          ? `Note: The login file (credentials.json) holds 2 entries this smurg cannot read (this is ${CLI_VERSION}); they are left exactly as they are, and this smurg does not use them: ${paths.credentials}\n  If a newer smurg was ever used on this computer, run smurg update.\n`
          : `注意：登入資料檔（credentials.json）裡有 2 筆資料這個 smurg（${CLI_VERSION}）讀不懂；它們會原封不動地留著，這個 smurg 不會使用它們：${paths.credentials}\n  如果這台電腦用過較新版的 smurg，請執行 smurg update。\n`,
      );
      expect(`${io.out()}${io.err()}`).not.toContain('keychain:');
      expect(await readFile(paths.credentials, 'utf8')).toBe(`${JSON.stringify({ version: 1, defaultRelay: null, relays: { 'https://eu.smurg.ai': LATER, 'https://old.example': 'gone' } }, null, 2)}\n`);
    }
  });
});
