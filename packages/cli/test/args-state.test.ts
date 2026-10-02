// Argument parsing (zh-TW usage errors) and the CLI's private state files: every path under one state dir
// (SMURG_HOME), JSON files written 0600 in a 0700 dir and refused when anyone else could read them.
import { chmod, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, parseCount, parseDuration } from '../src/cli/args.ts';
import { CliError } from '../src/cli/errors.ts';
import { loadCredentials, removeSessions, saveSession, sessionFor } from '../src/state/credentials.ts';
import { statePaths } from '../src/state/paths.ts';
import { loadWorkspaces, newWorkspaceId, rememberJoined, rememberSharedFolder, sharedFolderContaining, sharedFolderFor } from '../src/state/workspaces.ts';
import { makeDirs, type Dirs } from './helpers.ts';

let dirs: Dirs | null = null;
afterEach(async () => {
  await dirs?.cleanup();
  dirs = null;
});

const spec = { options: { relay: { kind: 'string' as const }, all: { kind: 'boolean' as const }, help: { kind: 'boolean' as const, short: 'h' } }, positionals: ['folder'], minPositionals: 1 };

describe('parseArgs', () => {
  it('reads --name value, --name=value, booleans, --no-flag, -h and --', () => {
    expect(parseArgs(['--relay', 'http://localhost:8787', 'dir'], spec)).toEqual({ options: { relay: 'http://localhost:8787' }, positionals: ['dir'] });
    expect(parseArgs(['--relay=https://x.test', '--all', 'dir'], spec).options).toEqual({ relay: 'https://x.test', all: true });
    expect(parseArgs(['--no-all', 'dir'], spec).options).toEqual({ all: false });
    expect(parseArgs(['-h'], spec).options).toEqual({ help: true });
    expect(parseArgs(['--', '--weird-folder'], spec).positionals).toEqual(['--weird-folder']);
  });

  it('refuses unknown options, missing values, repeats and surplus or missing positionals, with exit code 2', () => {
    const fails = (argv: string[], text: string): void => {
      let error: unknown;
      try {
        parseArgs(argv, spec);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
      expect((error as CliError).message).toContain(text);
    };
    fails(['--bogus', 'dir'], 'Unknown option --bogus');
    fails(['--relay'], 'needs a value');
    fails(['--relay', 'a', '--relay', 'b', 'dir'], 'can be given only once');
    fails(['a', 'b'], 'Unexpected argument "b"');
    fails([], 'Missing argument <folder>');
    fails(['--all=yes', 'dir'], 'does not take a value');
    // A flag and its negation together: the parser does not guess which one was meant.
    fails(['--all', '--no-all', 'dir'], 'Options --all and --no-all cannot be used together');
    fails(['--no-all', '--all', 'dir'], 'cannot be used together');
    fails(['--no-relay', 'dir'], 'Unknown option --no-relay');
    // Repeating the same form is harmless.
    expect(parseArgs(['--no-all', '--no-all', 'dir'], spec).options).toEqual({ all: false });
  });

  it('parses durations and counts', () => {
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('12h')).toBe(43_200);
    expect(parseDuration('7d')).toBe(604_800);
    expect(parseDuration('2w')).toBe(1_209_600);
    expect(parseDuration('7 days')).toBeNull();
    expect(parseCount('5')).toBe(5);
    expect(parseCount('0')).toBe(0);
    expect(parseCount('-1')).toBeNull();
    expect(parseCount('1.5')).toBeNull();
  });
});

describe('state paths', () => {
  it('derive from SMURG_HOME, else ~/.smurg of $HOME; a relative SMURG_HOME is refused', () => {
    expect(statePaths({ SMURG_HOME: '/tmp/x', HOME: '/home/amy' })).toEqual({
      stateDir: '/tmp/x',
      runDir: '/tmp/x/run',
      credentials: '/tmp/x/credentials.json',
      workspaces: '/tmp/x/workspaces.json',
      logsDir: '/tmp/x/logs',
    });
    expect(statePaths({ HOME: '/home/amy' }).stateDir).toBe('/home/amy/.smurg');
    expect(() => statePaths({ SMURG_HOME: 'relative/dir' })).toThrow(/absolute path/);
  });
});

describe('credentials.json', () => {
  const session = { token: 'tok.abc-123_x', tokenType: 'Bearer' as const, expiresIn: 3600, user: { userId: 'dev:amy', displayName: 'Amy', provider: 'dev' as const } };

  it('is written 0600 inside a 0700 dir, keyed by relay origin, and forgotten by logout', async () => {
    dirs = await makeDirs();
    const paths = statePaths({ SMURG_HOME: join(dirs.stateDir, 'fresh'), HOME: dirs.home });
    await saveSession(paths, 'http://localhost:8787', session, 1_000);
    expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.credentials)).mode & 0o777).toBe(0o600);
    const loaded = await loadCredentials(paths);
    expect(loaded.defaultRelay).toBe('http://localhost:8787');
    expect(sessionFor(loaded, 'http://localhost:8787', 2_000)?.token).toBe('tok.abc-123_x');
    expect(sessionFor(loaded, 'http://localhost:8787', 1_000 + 3_600_000)).toBeNull();
    expect(sessionFor(loaded, 'https://other.test', 2_000)).toBeNull();
    expect(await removeSessions(paths, 'http://localhost:8787')).toBe(1);
    expect(Object.keys((await loadCredentials(paths)).relays)).toEqual([]);
  });

  it('is refused (never repaired) when group or others could read it', async () => {
    dirs = await makeDirs();
    const paths = statePaths({ SMURG_HOME: dirs.stateDir, HOME: dirs.home });
    await saveSession(paths, 'http://localhost:8787', session, 1_000);
    await chmod(paths.credentials, 0o644);
    await expect(loadCredentials(paths)).rejects.toThrow(/can be read by other users/);
    expect((await lstat(paths.credentials)).mode & 0o777).toBe(0o644);
  });

  it('an unreadable file is a clear error, not a silent reset', async () => {
    dirs = await makeDirs();
    const paths = statePaths({ SMURG_HOME: dirs.stateDir, HOME: dirs.home });
    await writeFile(paths.credentials, '{not json', { mode: 0o600 });
    await expect(loadCredentials(paths)).rejects.toThrow(/not in the expected format/);
    expect(await readFile(paths.credentials, 'utf8')).toBe('{not json');
  });
});

describe('workspaces.json', () => {
  it('maps shared folders (per relay) to workspace ids and remembers joined workspaces', async () => {
    dirs = await makeDirs();
    const paths = statePaths({ SMURG_HOME: dirs.stateDir, HOME: dirs.home });
    const id = newWorkspaceId();
    expect(id).toMatch(/^ws_[A-Za-z0-9_-]{22}$/);
    await rememberSharedFolder(paths, { folder: '/work/app', relay: 'https://smurg.app', workspaceId: id, createdAt: 1 });
    await rememberJoined(paths, { workspaceId: 'ws_joined_0123456789', relay: 'https://smurg.app', name: 'Team', joinedAt: 2 });
    const book = await loadWorkspaces(paths);
    expect(sharedFolderFor(book, '/work/app', 'https://smurg.app')?.workspaceId).toBe(id);
    expect(sharedFolderFor(book, '/work/app', 'http://localhost:8787')).toBeNull();
    expect(sharedFolderContaining(book, '/work/app/src/deep')?.workspaceId).toBe(id);
    expect(sharedFolderContaining(book, '/work/application')).toBeNull();
    expect(book.joined.map((j) => j.workspaceId)).toEqual(['ws_joined_0123456789']);
    expect((await lstat(paths.workspaces)).mode & 0o777).toBe(0o600);
  });
});
