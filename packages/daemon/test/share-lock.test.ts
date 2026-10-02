// One daemon per shared folder: the same folder hosted through another relay origin or from another
// SMURG_HOME, or a folder inside one already shared, is refused; a crashed daemon's lock is taken over.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemon } from '../src/daemon.ts';
import { silentLogger } from '../src/core/logger.ts';
import { SHARE_LOCK_MARKER, ShareLockError, acquireShareLock, type ShareLock } from '../src/workspace/share-lock.ts';
import { MEMORY_RELAY_ORIGIN, TEST_HOST_NAME, TEST_HOST_USER, createTempDir, createTempRunDir, createTestDaemon, removeTempDir, removeTempRunDir, type TestDaemon } from '../src/testing/index.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

async function tempDir(label: string): Promise<string> {
  const dir = await createTempDir(label);
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

async function runDir(): Promise<string> {
  const dir = await createTempRunDir();
  cleanups.push(() => removeTempRunDir(dir));
  return dir;
}

/** A second daemon on `shareDir` from ANOTHER state dir (another SMURG_HOME, another relay origin: another workspace id). */
async function otherDaemon(shareDir: string, workspaceId: string) {
  const base = await tempDir('other-home');
  return createDaemon({
    config: {
      stateDir: join(base, 'state'),
      runDir: await runDir(),
      shareDir,
      workspaceId,
      hostUserId: TEST_HOST_USER,
      hostName: TEST_HOST_NAME,
      relayUrl: MEMORY_RELAY_ORIGIN,
      webOrigin: MEMORY_RELAY_ORIGIN,
      keepAwake: false,
    },
    identityKeys: { get: () => null, refresh: async () => {} },
    modules: [],
    log: silentLogger,
    homeDir: join(base, 'home'),
  });
}

describe('one daemon per shared folder', () => {
  it('refuses the same folder from another state dir / relay while the first daemon runs; takes it once that one stopped', async () => {
    const t: TestDaemon = await createTestDaemon({ modules: [] });
    cleanups.push(() => t.cleanup());
    const marker = JSON.parse(await readFile(join(t.root, '.smurg', SHARE_LOCK_MARKER), 'utf8')) as { socket: string; workspaceId: string };
    expect(marker.workspaceId).toBe(t.workspaceId);
    expect(marker.socket.startsWith(`${t.runDir}/`) && marker.socket.endsWith('.lk')).toBe(true);

    await expect(otherDaemon(t.root, 'ws_test_other_relay_0001')).rejects.toMatchObject({ name: 'ShareLockError', reason: 'shared' });
    await t.daemon.stop();
    await expect(readFile(join(t.root, '.smurg', SHARE_LOCK_MARKER), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await otherDaemon(t.root, 'ws_test_other_relay_0001');
    await second.stop();
  });

  it('refuses a folder inside a shared one', async () => {
    const t: TestDaemon = await createTestDaemon({ modules: [], project: { files: { 'src/app.ts': 'x\n' } } });
    cleanups.push(() => t.cleanup());
    await expect(otherDaemon(join(t.root, 'src'), 'ws_test_nested_000001')).rejects.toMatchObject({ name: 'ShareLockError', reason: 'ancestor-shared' });
  });

  it("takes over a crashed daemon's lock (marker left behind, nobody listening), also when it named the same socket", async () => {
    const base = await tempDir('lock');
    const share = join(base, 'project');
    await mkdir(join(share, '.smurg'), { recursive: true });
    const run = await runDir();
    // What a SIGKILLed daemon leaves: the marker, naming a socket nobody listens on (not even a socket file).
    await writeFile(join(share, '.smurg', SHARE_LOCK_MARKER), JSON.stringify({ v: 1, socket: join(run, 'dead.lk'), workspaceId: 'ws_dead' }), { mode: 0o600 });
    const lock: ShareLock = await acquireShareLock({ shareRealPath: share, runDir: run, workspaceId: 'ws_a' });
    cleanups.push(() => lock.release());
    expect(JSON.parse(await readFile(lock.markerPath, 'utf8'))).toMatchObject({ workspaceId: 'ws_a', socket: lock.socketPath });
    // …and a live one is not taken over, not even by the same workspace.
    await expect(acquireShareLock({ shareRealPath: share, runDir: run, workspaceId: 'ws_b' })).rejects.toBeInstanceOf(ShareLockError);
    await expect(acquireShareLock({ shareRealPath: share, runDir: run, workspaceId: 'ws_a' })).rejects.toBeInstanceOf(ShareLockError);
    await lock.release();
    const third = await acquireShareLock({ shareRealPath: share, runDir: run, workspaceId: 'ws_b' });
    await third.release();
    expect(dirname(lock.markerPath)).toBe(join(share, '.smurg'));
  });

  it('a crashed daemon of the SAME workspace (same run dir) does not block its next start', async () => {
    const base = await tempDir('crash');
    const share = join(base, 'project');
    await mkdir(join(share, '.smurg'), { recursive: true });
    const run = await runDir();
    const first = await acquireShareLock({ shareRealPath: share, runDir: run, workspaceId: 'ws_same' });
    // Simulate SIGKILL: the listener is gone, the socket file and the marker stay.
    const markerText = await readFile(first.markerPath, 'utf8');
    await first.release();
    await writeFile(first.markerPath, markerText, { mode: 0o600 });
    const { createServer } = await import('node:net');
    const ghost = createServer();
    await new Promise<void>((resolve) => ghost.listen(first.socketPath, resolve));
    await new Promise<void>((resolve) => ghost.close(() => resolve())); // leaves no listener (file may stay)
    const next = await acquireShareLock({ shareRealPath: share, runDir: run, workspaceId: 'ws_same' });
    cleanups.push(() => next.release());
    expect(JSON.parse(await readFile(next.markerPath, 'utf8'))).toMatchObject({ socket: next.socketPath });
  });
});
