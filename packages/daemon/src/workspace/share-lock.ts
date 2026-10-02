// One daemon per shared folder. The daemon locked only its workspace (ctl / hook sockets), so the same
// folder could be hosted twice (another relay origin, another SMURG_HOME), or a folder and its sub-folder at once: two
// watchers, two lock managers (R8's locks no longer hold against the other workspace's agents), and each daemon
// emptying `.smurg/trash` under the other.
//
// The lock lives WITH the folder, so it holds whatever state dir or relay the other daemon uses:
//  - the daemon listens on a Unix socket of its own in its private run dir (`<runDir>/<short>.<hex4>.lk`, one per
//    daemon instance) for as long as it runs; the kernel drops the listener when the process dies, so a crash never
//    leaves a lock that looks alive (the socket FILE it leaves is swept by the next start of that workspace);
//  - `<share>/.smurg/daemon-lock.json` (created O_EXCL, 0600) names that socket. A marker whose socket accepts a
//    connection is a live daemon: refused. One whose socket is gone is stale (a crash): taken over.
//  - an ANCESTOR folder's marker with a live socket refuses the share too (the inner folder is already shared).
// Not covered: a DESCENDANT hosted by a daemon of another state dir while this one starts (finding it would mean
// walking the whole tree); the CLI refuses overlaps among the daemons of one state dir.
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { open, readFile, readdir, unlink } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { SOCKET_PATH_MAX_BYTES, assertSocketPath, shortRunId } from '../core/sockets.ts';
import { errnoCode } from './fs-util.ts';

export const SHARE_LOCK_MARKER = 'daemon-lock.json';
const MARKER_MAX_BYTES = 4_096;
const PROBE_TIMEOUT_MS = 1_000;

export class ShareLockError extends Error {
  /** 'shared': this folder is hosted by another daemon; 'ancestor-shared': a folder above it is. */
  readonly reason: 'shared' | 'ancestor-shared' | 'running';
  constructor(reason: 'shared' | 'ancestor-shared' | 'running', message: string) {
    super(message);
    this.name = 'ShareLockError';
    this.reason = reason;
  }
}

export interface ShareLock {
  readonly markerPath: string;
  /** This daemon's lock socket (named in the marker). */
  readonly socketPath: string;
  /** Stops holding the folder (the marker goes only when it is still ours). Idempotent. */
  release(): Promise<void>;
}

interface Marker {
  readonly socket: string;
  readonly workspaceId?: string;
}

async function readMarker(path: string): Promise<Marker | null | 'unreadable'> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = errnoCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' ? null : 'unreadable';
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MARKER_MAX_BYTES) return 'unreadable';
    const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return 'unreadable';
    const { socket, workspaceId } = parsed as Record<string, unknown>;
    if (typeof socket !== 'string') return 'unreadable';
    return { socket, ...(typeof workspaceId === 'string' ? { workspaceId: workspaceId.slice(0, 64) } : {}) };
  } catch {
    return 'unreadable';
  } finally {
    await handle.close();
  }
}

/** Whether something listens on the Unix socket `path` (connect, then hang up at once). */
function socketIsLive(path: string): Promise<boolean> {
  if (!isAbsolute(path) || path.includes('\u0000') || Buffer.byteLength(path, 'utf8') > SOCKET_PATH_MAX_BYTES) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (live: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    // A listener that does not even accept within the timeout is treated as live (fail closed: do not take over).
    const timer = setTimeout(() => done(true), PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function markerIsLive(marker: Marker | null | 'unreadable'): Promise<boolean> {
  return marker !== null && marker !== 'unreadable' && (await socketIsLive(marker.socket));
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function createMarker(path: string, text: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** Removes lock socket files of `workspaceId` in `runDir` that nobody listens on any more (a crashed daemon's). */
async function sweepStaleSockets(runDir: string, workspaceId: string): Promise<void> {
  const pattern = new RegExp(`^${shortRunId(workspaceId)}\\.[0-9a-f]{4}\\.lk$`);
  const names = await readdir(runDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(runDir, name);
    if (!(await socketIsLive(path))) await unlink(path).catch(() => {});
  }
}

/**
 * Takes the folder `shareRealPath` (its `.smurg/` must exist) for this daemon, or throws ShareLockError. The lock
 * socket is created in `runDir` (the daemon's private run dir).
 */
export async function acquireShareLock(input: { readonly shareRealPath: string; readonly runDir: string; readonly workspaceId: string }): Promise<ShareLock> {
  const { shareRealPath, runDir, workspaceId } = input;
  for (let dir = dirname(shareRealPath); ; dir = dirname(dir)) {
    const marker = await readMarker(join(dir, '.smurg', SHARE_LOCK_MARKER));
    if (await markerIsLive(marker)) {
      throw new ShareLockError('ancestor-shared', `a folder that contains it (${dir}) is already shared by another smurg`);
    }
    if (dirname(dir) === dir) break;
  }

  await sweepStaleSockets(runDir, workspaceId);
  const server = createServer((socket) => socket.destroy());
  let socketPath = '';
  for (let attempt = 0; ; attempt++) {
    socketPath = assertSocketPath(join(runDir, `${shortRunId(workspaceId)}.${randomBytes(2).toString('hex')}.lk`));
    try {
      await listen(server, socketPath);
      break;
    } catch (err) {
      // A name another daemon instance of this workspace holds: draw another one.
      if (errnoCode(err) !== 'EADDRINUSE' || attempt >= 8) throw err;
    }
  }
  const closeServer = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).then(() => unlink(socketPath).catch(() => {}));

  const markerPath = join(shareRealPath, '.smurg', SHARE_LOCK_MARKER);
  const text = `${JSON.stringify({ v: 1, socket: socketPath, workspaceId, pid: process.pid, startedAt: Date.now() })}\n`;
  try {
    for (let attempt = 0; ; attempt++) {
      if (await createMarker(markerPath, text)) break;
      const holder = await readMarker(markerPath);
      // A marker naming the socket this daemon just bound is a crashed predecessor's that had the same name: stale.
      const ours = holder !== null && holder !== 'unreadable' && holder.socket === socketPath;
      if (!ours && (await markerIsLive(holder))) {
        const other = holder !== null && holder !== 'unreadable' && holder.workspaceId !== undefined ? ` (workspace ${holder.workspaceId})` : '';
        throw new ShareLockError('shared', `this folder is already shared by another smurg${other}`);
      }
      if (attempt >= 1) throw new ShareLockError('shared', 'this folder is being shared by another smurg that is starting');
      await unlink(markerPath).catch(() => {}); // stale: its daemon is gone
    }
  } catch (err) {
    await closeServer();
    throw err;
  }

  let released = false;
  return {
    markerPath,
    socketPath,
    release: async () => {
      if (released) return;
      released = true;
      const current = await readFile(markerPath, 'utf8').catch(() => null);
      if (current === text) await unlink(markerPath).catch(() => {});
      await closeServer();
    },
  };
}
