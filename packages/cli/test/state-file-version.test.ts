// `~/.smurg/workspaces.json` and `~/.smurg/credentials.json` that this smurg cannot read (0.5.1, DESIGN B5).
//
// Where it comes from (W/FOUND-U6, proof p3, run against v0.5.0): a file whose `version` was not 1 was read as EMPTY
// without a word, and the next write replaced it. For workspaces.json that is every link from a shared folder to its
// workspace: `smurg host` then made a NEW workspace for the folder (new members, new invite links, a new daemon key),
// the same loss as moving the workspace's state away, and silent. For credentials.json it is every login.
//
// Now such a file is a refusal that changes nothing: a `version` above 1 says a newer smurg wrote it (`smurg update`),
// anything else that the file is not in its format; never "empty", and never written over. What 0.4.0 and 0.5.0 wrote
// (version 1) is read as before. `smurg status` and `smurg stop` still work beside a list they cannot read (they find
// the daemons by their sockets), so that "stop sharing first, then smurg update" never becomes a circle.
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCtlControl, runPathsFor, type CtlStatus } from '@smurg/daemon';
import { CliError, formatFailure } from '../src/cli/errors.ts';
import { runCli } from '../src/cli/run.ts';
import { loadCredentials, removeSessions, saveSession } from '../src/state/credentials.ts';
import { statePaths, type StatePaths } from '../src/state/paths.ts';
import { loadWorkspaces, rememberJoined, rememberSharedFolder, sharedFolderFor } from '../src/state/workspaces.ts';
import { CLI_VERSION } from '../src/version.ts';
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

/** A private file as smurg writes it (0600); returns its bytes. */
async function put(path: string, text: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  return readFile(path);
}

/** The file is byte for byte what it was, with its mode, and nothing was put beside it (no temp file, no new file). */
async function expectUntouched(path: string, bytes: Buffer, siblings: readonly string[]): Promise<void> {
  expect((await readFile(path)).equals(bytes), `${path} changed`).toBe(true);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await readdir(dirname(path))).sort()).toEqual([...siblings].sort());
}

const failureOf = (run: Promise<unknown>): Promise<{ text: string; exitCode: number } | null> =>
  run.then(
    () => null,
    (err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      return formatFailure(err, 'en');
    },
  );

/** As a later smurg might write them: `version` 2 and a shape this smurg has never seen. */
const WORKSPACES_V2 = `${JSON.stringify({ version: 2, folders: { '/work/app': { relay: 'https://app.smurg.ai', workspace: 'ws_x0ero8pS70bWM5G4VbZ1NA', since: 1791377829732 } }, memberships: [] }, null, 2)}\n`;
const CREDENTIALS_V2 = `${JSON.stringify({ version: 2, accounts: [{ relay: 'https://app.smurg.ai', token: 'made.up-token_for.the-test', user: 'google:1' }] }, null, 2)}\n`;

/** As 0.4.0 wrote them (W/REAL/fixture-0.4.0/sh and ivan/sh; a made-up token of the same alphabet, a neutral folder). */
const WORKSPACES_040 = `${JSON.stringify(
  {
    version: 1,
    shared: [{ folder: '/work/tidepool', relay: 'http://localhost:18740', workspaceId: 'ws_x0ero8pS70bWM5G4VbZ1NA', createdAt: 1791377829732 }],
    joined: [{ workspaceId: 'ws_Zm9yIHRoZSB0ZXN0IG9ubHk', relay: 'http://localhost:18740', name: 'project', joinedAt: 1791378217394 }],
  },
  null,
  2,
)}\n`;
const CREDENTIALS_040 = `${JSON.stringify(
  {
    version: 1,
    defaultRelay: 'http://localhost:18740',
    relays: { 'http://localhost:18740': { token: 'eyJhbGciOiJFZERTQSJ9.made-up_for.the-test', userId: 'dev:host', displayName: 'host', provider: 'dev', savedAt: 1791377823330, expiresAt: 1791982623330 } },
  },
  null,
  2,
)}\n`;

const SESSION = { token: 'new.login-token_1', tokenType: 'Bearer' as const, expiresIn: 3600, user: { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' as const } };

describe('what 0.4.0 and 0.5.0 wrote is read as before (version 1)', () => {
  it('workspaces.json: the folder still leads to its workspace id, and a write keeps every entry', async () => {
    const { paths } = await setup();
    await put(paths.workspaces, WORKSPACES_040);
    const book = await loadWorkspaces(paths);
    expect(sharedFolderFor(book, '/work/tidepool', 'http://localhost:18740')?.workspaceId).toBe('ws_x0ero8pS70bWM5G4VbZ1NA');
    expect(book.joined).toEqual([{ workspaceId: 'ws_Zm9yIHRoZSB0ZXN0IG9ubHk', relay: 'http://localhost:18740', name: 'project', joinedAt: 1791378217394 }]);
    await rememberSharedFolder(paths, { folder: '/work/other', relay: 'https://app.smurg.ai', workspaceId: 'ws_other_folder_00001', createdAt: 5 });
    const after = JSON.parse(await readFile(paths.workspaces, 'utf8')) as { version: number; shared: unknown[]; joined: unknown[] };
    expect(after.version).toBe(1);
    expect(after.shared).toHaveLength(2);
    expect(after.joined).toEqual(JSON.parse(WORKSPACES_040).joined);
  });

  it('credentials.json: the stored login is used, and another login is added beside it', async () => {
    const { paths } = await setup();
    await put(paths.credentials, CREDENTIALS_040);
    const loaded = await loadCredentials(paths);
    expect(loaded.defaultRelay).toBe('http://localhost:18740');
    expect(loaded.relays['http://localhost:18740']).toMatchObject({ userId: 'dev:host', token: 'eyJhbGciOiJFZERTQSJ9.made-up_for.the-test', expiresAt: 1791982623330 });
    await saveSession(paths, 'https://app.smurg.ai', SESSION, 1_000);
    const after = JSON.parse(await readFile(paths.credentials, 'utf8')) as { version: number; relays: Record<string, unknown> };
    expect(after.version).toBe(1);
    expect(Object.keys(after.relays).sort()).toEqual(['http://localhost:18740', 'https://app.smurg.ai']);
  });

  it('no file at all is still "nothing yet": an empty list, not logged in', async () => {
    const { paths } = await setup();
    expect(await loadWorkspaces(paths)).toEqual({ shared: [], joined: [] });
    expect(await loadCredentials(paths)).toEqual({ defaultRelay: null, relays: {} });
  });
});

describe('workspaces.json written by a newer smurg (version 2)', () => {
  it('is refused with the reason and the way forward, by every read and every write; the file stays byte for byte', async () => {
    const { paths } = await setup();
    const bytes = await put(paths.workspaces, WORKSPACES_V2);
    const expected = {
      text: `smurg: The workspace list (workspaces.json) was written by a newer smurg than this one (this is ${CLI_VERSION}): ${paths.workspaces}\n  Run smurg update. Nothing was changed.\n`,
      exitCode: 1,
    };
    expect(await failureOf(loadWorkspaces(paths))).toEqual(expected);
    expect(await failureOf(rememberSharedFolder(paths, { folder: '/work/app', relay: 'https://app.smurg.ai', workspaceId: 'ws_a_brand_new_one_001', createdAt: 9 }))).toEqual(expected);
    expect(await failureOf(rememberJoined(paths, { workspaceId: 'ws_a_brand_new_one_001', relay: 'https://app.smurg.ai', name: 'x', joinedAt: 9 }))).toEqual(expected);
    await expectUntouched(paths.workspaces, bytes, ['workspaces.json']);
  });

  it('smurg host says why it stops: no new workspace is made for the folder, nobody is asked to log in, nothing is written', async () => {
    const { dirs, env, paths } = await setup();
    const bytes = await put(paths.workspaces, WORKSPACES_V2);
    const project = await realpath(dirs.project);
    for (const lang of ['en', 'zh-TW'] as const) {
      const io = testIo({ env: { ...env, SMURG_LANG: lang } });
      expect(await runCli(['host', project, '--relay', 'http://127.0.0.1:9'], io)).toBe(1);
      expect(io.err()).toBe(
        lang === 'en'
          ? `smurg: The workspace list (workspaces.json) was written by a newer smurg than this one (this is ${CLI_VERSION}): ${paths.workspaces}\n  Run smurg update. Nothing was changed.\n`
          : `smurg：工作區紀錄檔（workspaces.json）是較新版的 smurg 寫的（這個 smurg 是 ${CLI_VERSION}）：${paths.workspaces}\n  請執行 smurg update。沒有更動任何東西。\n`,
      );
      expect(io.out()).toBe('');
      expect(io.opened).toEqual([]);
    }
    // No state of a new workspace, no log, no login, no lock in the folder.
    await expectUntouched(paths.workspaces, bytes, ['workspaces.json']);
    expect(await readdir(project)).toEqual([]);
  });

  it('smurg attach refuses too (it would write the list after joining)', async () => {
    const { env, paths } = await setup();
    const bytes = await put(paths.workspaces, WORKSPACES_V2);
    const io = testIo({ env });
    expect(await runCli(['attach'], io)).toBe(1);
    expect(io.err()).toContain('was written by a newer smurg than this one');
    await expectUntouched(paths.workspaces, bytes, ['workspaces.json']);
  });
});

describe('credentials.json written by a newer smurg (version 2)', () => {
  it('is refused by every read and write (a login, a logout); the file stays byte for byte and the token is never shown', async () => {
    const { paths } = await setup();
    const bytes = await put(paths.credentials, CREDENTIALS_V2);
    const expected = {
      text: `smurg: The login file (credentials.json) was written by a newer smurg than this one (this is ${CLI_VERSION}): ${paths.credentials}\n  Run smurg update. Nothing was changed.\n`,
      exitCode: 1,
    };
    expect(await failureOf(loadCredentials(paths))).toEqual(expected);
    expect(await failureOf(saveSession(paths, 'https://app.smurg.ai', SESSION, 1_000))).toEqual(expected);
    expect(await failureOf(removeSessions(paths, 'https://app.smurg.ai'))).toEqual(expected);
    expect(await failureOf(removeSessions(paths, 'all'))).toEqual(expected);
    await expectUntouched(paths.credentials, bytes, ['credentials.json']);
  });

  it('smurg host says why it stops, before it picks a relay or makes a workspace', async () => {
    const { dirs, env, paths } = await setup();
    const bytes = await put(paths.credentials, CREDENTIALS_V2);
    const io = testIo({ env });
    expect(await runCli(['host', await realpath(dirs.project), '--relay', 'http://127.0.0.1:9'], io)).toBe(1);
    expect(io.err()).toBe(`smurg: The login file (credentials.json) was written by a newer smurg than this one (this is ${CLI_VERSION}): ${paths.credentials}\n  Run smurg update. Nothing was changed.\n`);
    expect(io.err()).not.toContain('made.up-token');
    await expectUntouched(paths.credentials, bytes, ['credentials.json']);
  });
});

describe('a file that is there and is not in its format is refused too: never read as empty, never written over', () => {
  const NOT_WORKSPACES = ['[]', '"workspaces"', '7', '{}', '{"shared":[],"joined":[]}', '{"version":"1","shared":[]}', '{"version":0,"shared":[]}', '{"version":null}', '{"version":-2}', '{"version":[2]}'];
  const NOT_CREDENTIALS = [...NOT_WORKSPACES, '{"version":1}', '{"version":1,"relays":[]}', '{"version":1,"relays":"none"}'];

  it('workspaces.json: the hint says what the file holds instead of "delete it"', async () => {
    const { dirs, env, paths } = await setup();
    for (const text of NOT_WORKSPACES) {
      const bytes = await put(paths.workspaces, text);
      const expected = {
        text:
          `smurg: The workspace list (workspaces.json) is not in the expected format: ${paths.workspaces}\n` +
          '  Nothing was changed. If a newer smurg was ever used on this computer, run smurg update. Otherwise repair it or put a copy back: it links every shared folder to its workspace, and without it smurg host gives a folder a new workspace (new members, new invite links, a new daemon key).\n',
        exitCode: 1,
      };
      expect(await failureOf(loadWorkspaces(paths)), text).toEqual(expected);
      expect(await failureOf(rememberSharedFolder(paths, { folder: '/work/app', relay: 'https://app.smurg.ai', workspaceId: 'ws_a_brand_new_one_001', createdAt: 9 })), text).toEqual(expected);
      const io = testIo({ env });
      expect(await runCli(['host', await realpath(dirs.project), '--relay', 'http://127.0.0.1:9'], io), text).toBe(1);
      expect(io.err(), text).toBe(expected.text);
      await expectUntouched(paths.workspaces, bytes, ['workspaces.json']);
    }
  });

  it('credentials.json: the same, with its own way forward', async () => {
    const { paths } = await setup();
    for (const text of NOT_CREDENTIALS) {
      const bytes = await put(paths.credentials, text);
      const expected = {
        text:
          `smurg: The login file (credentials.json) is not in the expected format: ${paths.credentials}\n` +
          '  Nothing was changed. If a newer smurg was ever used on this computer, run smurg update. Otherwise move the file away and log in again (smurg login).\n',
        exitCode: 1,
      };
      expect(await failureOf(loadCredentials(paths)), text).toEqual(expected);
      expect(await failureOf(saveSession(paths, 'https://app.smurg.ai', SESSION, 1_000)), text).toEqual(expected);
      await expectUntouched(paths.credentials, bytes, ['credentials.json']);
    }
  });

  it('a file that is not JSON is "not in the expected format", never "a newer smurg"', async () => {
    const { paths } = await setup();
    const bytes = await put(paths.workspaces, '{"version": 2, "folders": {');
    const failure = await failureOf(loadWorkspaces(paths));
    expect(failure?.text).toContain('is not in the expected format');
    expect(failure?.text).not.toContain('newer smurg than this one');
    await expectUntouched(paths.workspaces, bytes, ['workspaces.json']);
  });
});

describe('smurg status and smurg stop do not need the workspace list', () => {
  const status = (workspaceId: string): CtlStatus => ({
    workspaceId,
    started: true,
    stopped: false,
    relay: { interactive: 'online', transfer: 'online' },
    connections: 0,
    onlineMembers: 0,
    power: { active: false, mechanism: 'none', pid: null, reason: 'disabled' },
    handshakes: { handshakes: 0, accepted: 0, failed: 0, refusedByRateLimit: 0, kickedForFailures: 0, kickedIdle: 0 },
  });

  /** A stand-in control socket: answers `status`, and stops listening when asked to stop (as a daemon does). */
  async function standIn(env: Record<string, string>, workspaceId: string): Promise<{ listening: () => boolean }> {
    const path = runPathsFor(statePaths(env).runDir, workspaceId).ctl;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let listening = true;
    const server = createServer((socket) => {
      socket.on('error', () => undefined);
      socket.once('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.subarray(5).toString('utf8')) as { op: string };
        if (request.op === 'stop') {
          socket.end(encodeCtlControl({ ok: true, op: 'stop' }));
          listening = false;
          server.close();
        } else socket.end(encodeCtlControl({ ok: true, op: 'status', status: status(workspaceId) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => (listening ? server.close(() => resolve()) : resolve())));
    return { listening: () => listening };
  }

  it('with a list a newer smurg wrote: status shows the share and says in one note why it names no folder; stop stops it; the list is untouched', async () => {
    const { dirs, env, paths } = await setup();
    const bytes = await put(paths.workspaces, WORKSPACES_V2);
    const id = 'ws_book_newer_00001';
    const host = await standIn(env, id);
    const shown = testIo({ env, cwd: dirs.project });
    expect(await runCli(['status'], shown)).toBe(0);
    expect(shown.out()).toContain(`Workspace ${id}\n`);
    expect(shown.out()).not.toContain('  Folder:');
    expect(shown.out()).toContain(`Note: The workspace list (workspaces.json) was written by a newer smurg than this one (this is ${CLI_VERSION}): ${paths.workspaces}\n  Run smurg update. Nothing was changed.\n`);
    const stopped = testIo({ env, cwd: dirs.project });
    expect(await runCli(['stop'], stopped)).toBe(0);
    expect(stopped.out()).toBe(`Stopping the share of workspace ${id}...\nStopped sharing.\n`);
    expect(host.listening()).toBe(false);
    // Nothing shared any more: the usual answer and exit code, and the note.
    const none = testIo({ env });
    expect(await runCli(['status'], none)).toBe(3);
    expect(none.out()).toContain('No workspace is being shared.\nNote: The workspace list (workspaces.json) was written by a newer smurg');
    await expectUntouched(paths.workspaces, bytes, ['run', 'workspaces.json']);
  });
});
