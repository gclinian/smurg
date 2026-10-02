// `smurg update` and `smurg uninstall` with the REAL single executable (opt-in like sea.test.ts: skipped unless
// SMURG_SEA_BINARY names a built binary):
//   SMURG_SEA_BINARY=packages/cli/dist/smurg-darwin-arm64 pnpm --filter @smurg/cli exec vitest run test/sea-update.test.ts
// The binary is COPIED into a scratch HOME (<home>/.local/bin/smurg) and only that copy runs, with an isolated
// environment (HOME, SMURG_HOME and SMURG_CACHE_DIR in temp dirs) and a local HTTP server as the downloads site: the
// built binary itself, the real ~/.local/bin and the real ~/.smurg are never touched, and nothing reaches the network.
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { statePaths } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { HOST_TARGET, fakeExecutable, release, startDownloads } from './downloads-server.ts';
import { isolatedEnv, makeDirs, type Dirs } from './helpers.ts';

const run = promisify(execFile);
const BINARY = process.env['SMURG_SEA_BINARY'] ? resolve(process.env['SMURG_SEA_BINARY']) : null;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** A copy of the binary installed as the installer would: <home>/.local/bin/smurg (0755), in a scratch HOME. */
async function installed(): Promise<{ dirs: Dirs; smurg: string; cache: string }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const bin = join(await realpath(dirs.home), '.local', 'bin');
  await mkdir(bin, { recursive: true });
  const smurg = join(bin, 'smurg');
  await copyFile(BINARY as string, smurg);
  await chmod(smurg, 0o755);
  return { dirs, smurg, cache: join(dirs.home, 'cache') };
}

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the copy; stdin is a pipe (never a terminal). */
function smurgRun(smurg: string, args: readonly string[], env: Record<string, string>): Promise<Outcome> {
  return new Promise((done) => {
    execFile(smurg, args, { env, timeout: 120_000 }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

describe.skipIf(BINARY === null)('the single executable updates and uninstalls itself (SMURG_SEA_BINARY)', () => {
  it('smurg update: already the newest; --check; then a newer release from the stand-in site replaces the executable in place', async () => {
    const { dirs, smurg, cache } = await installed();
    const server = await startDownloads();
    cleanups.push(() => server.close());
    const env = isolatedEnv(dirs, { SMURG_CACHE_DIR: cache, SMURG_INSTALL_BASE_URL: server.base });
    const own = /^smurg (\S+) \(/.exec((await run(smurg, ['--version'], { env, timeout: 60_000 })).stdout)?.[1] as string;
    expect(own).toMatch(/^\d+\.\d+\.\d+/);

    server.routes['latest/VERSION'] = `${own}\n`;
    const newest = await smurgRun(smurg, ['update'], env);
    expect(newest).toEqual({ code: 0, stdout: `smurg ${own} is the latest version.\n`, stderr: '' });

    Object.assign(server.routes, release('99.0.0'));
    const check = await smurgRun(smurg, ['update', '--check'], env);
    expect(check).toEqual({ code: 0, stdout: `Version 99.0.0 is available (this is ${own}). Run smurg update to update.\nChangelog: https://smurg.ai/docs/changelog/\n`, stderr: '' });
    expect((await lstat(smurg)).size).toBeGreaterThan(1_000_000);

    // A release whose file does not match its SHA256SUMS changes nothing.
    const good = server.routes[`v99.0.0/${HOST_TARGET}`] as string;
    server.routes[`v99.0.0/${HOST_TARGET}`] = `${good}# tampered\n`;
    const tampered = await smurgRun(smurg, ['update'], env);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain('does not match');
    expect((await lstat(smurg)).size).toBeGreaterThan(1_000_000);
    expect(await readdir(dirname(smurg))).toEqual(['smurg']);

    server.routes[`v99.0.0/${HOST_TARGET}`] = good;
    const updated = await smurgRun(smurg, ['update'], env);
    expect(updated.stderr).toBe('');
    expect(updated.code).toBe(0);
    expect(updated.stdout).toBe(
      [`Downloading smurg 99.0.0 (${HOST_TARGET}, ${server.base}/v99.0.0)...`, `Updated smurg: ${own} -> 99.0.0 (${smurg})`, 'Changelog: https://smurg.ai/docs/changelog/', ''].join('\n'),
    );
    expect(await readFile(smurg, 'utf8')).toBe(fakeExecutable('99.0.0'));
    expect((await lstat(smurg)).mode & 0o777).toBe(0o755);
    expect(await readdir(dirname(smurg))).toEqual(['smurg']);
    expect((await run(smurg, ['--version'], { env, timeout: 30_000 })).stdout).toBe('smurg 99.0.0 (fake, protocol v2)\n');
    // The state dir and the cache were not needed for any of it.
    expect(await exists(cache)).toBe(false);
  });

  it('smurg uninstall: refuses without a terminal and --yes; --yes removes the executable, the state dir and the cache of the scratch HOME, not the project folder', async () => {
    const { dirs, smurg, cache } = await installed();
    const env = isolatedEnv(dirs, { SMURG_CACHE_DIR: cache });
    const project = await realpath(dirs.project);
    await rememberSharedFolder(statePaths(env), { folder: project, relay: 'http://localhost:8787', workspaceId: 'ws_sea_uninstall_0000', createdAt: 1 });
    await mkdir(join(project, '.smurg', 'worktrees', 'wt1'), { recursive: true });
    await writeFile(join(project, '.smurg', 'worktrees', 'wt1', 'unmerged.txt'), 'work\n');
    await mkdir(join(cache, 'native-0123456789abcdef', 'node-pty'), { recursive: true });
    // The platform's default cache root, inside the scratch HOME.
    const standard = process.platform === 'darwin' ? join(dirs.home, 'Library', 'Caches', 'smurg') : join(dirs.home, '.cache', 'smurg');
    await mkdir(join(standard, 'native-fedcba9876543210'), { recursive: true });

    const refused = await smurgRun(smurg, ['uninstall'], env);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain('smurg uninstall will remove:');
    expect(refused.stdout).toContain(`  ${smurg} (`);
    expect(refused.stderr).toContain('Not run in a terminal, so smurg cannot ask; nothing was removed');
    expect(await exists(smurg)).toBe(true);
    expect(await exists(join(dirs.stateDir, 'workspaces.json'))).toBe(true);

    const removed = await smurgRun(smurg, ['uninstall', '--yes'], env);
    expect(removed.stderr).toBe('');
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain('smurg was removed from this computer.');
    expect(removed.stdout).toContain(`  ${join(project, '.smurg')}  smurg's data inside a project folder`);
    expect(await exists(smurg)).toBe(false);
    expect(await exists(dirs.stateDir)).toBe(false);
    expect(await exists(join(cache, 'native-0123456789abcdef'))).toBe(false);
    expect(await exists(standard)).toBe(false);
    expect(await readFile(join(project, '.smurg', 'worktrees', 'wt1', 'unmerged.txt'), 'utf8')).toBe('work\n');
    expect(await exists(dirname(smurg))).toBe(true);
  });
});
