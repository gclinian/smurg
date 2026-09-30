// Unix socket paths (ARCHITECTURE §7.1): `<runDir>/<short>.ctl` (control socket: host only),
// `<runDir>/<short>.hook` (hook + MCP socket, the only socket exposed into guest sandboxes) and the shared-folder lock
// `<runDir>/<short>.<hex4>.lk` (one per daemon instance, workspace/share-lock.ts).
//
// macOS limits sun_path to 104 bytes including the terminating NUL (Linux: 108). Node does NOT fail on a longer path:
// it binds the socket at a silently truncated path in another directory (verified by the contract review), where it
// sits outside the private run dir and no sandbox allow-list entry matches it. So every socket path is checked here
// and anything too long fails closed, before any bind or connect.
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

/** Longest socket path in bytes that works on every supported host (macOS: 104 including NUL). */
export const SOCKET_PATH_MAX_BYTES = 103;

export class SocketPathError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'SocketPathError';
    this.path = path;
  }
}

/** Returns `path` unchanged, or throws SocketPathError when it is relative, contains NUL, or is too long. */
export function assertSocketPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) throw new SocketPathError(String(path), 'socket path must be absolute');
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > SOCKET_PATH_MAX_BYTES) {
    throw new SocketPathError(path, `socket path is ${bytes} bytes; at most ${SOCKET_PATH_MAX_BYTES} work on macOS (set a shorter runDir)`);
  }
  return path;
}

/** The 12-character `<short>` of a workspace's socket names: stable per workspace, filesystem-safe. */
export function shortRunId(workspaceId: string): string {
  return createHash('sha256').update(`smurg-run:${workspaceId}`).digest('base64url').slice(0, 12).replace(/[-_]/g, 'x');
}

export interface RunPaths {
  /** Control socket (`smurg stop`, status, local attach). */
  readonly ctl: string;
  /** Hook + MCP socket. */
  readonly hook: string;
  /** pid file of the running daemon. */
  readonly pid: string;
}

/** The run paths of a workspace, each socket path already checked with assertSocketPath. */
export function runPathsFor(runDir: string, workspaceId: string): RunPaths {
  const short = shortRunId(workspaceId);
  return {
    ctl: assertSocketPath(join(runDir, `${short}.ctl`)),
    hook: assertSocketPath(join(runDir, `${short}.hook`)),
    pid: join(runDir, `${short}.pid`),
  };
}
