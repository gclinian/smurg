// TEST ONLY. Small HAND-MADE files in the shapes smurg 0.4.0 wrote, for the unit tests of the upgrade mechanism
// (test/state-steps.test.ts, test/workspace-folder.test.ts, test/two-phase-start.test.ts). They prove the mechanism;
// what the published versions REALLY wrote is under test/fixtures/published/ and is opened by test/upgrade/.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StateFileError } from '../../src/core/state-file-error.ts';

export const GiB = 1024 * 1024 * 1024;
export const WS = 'ws_test_0123456789abcdef';

/** A state.json as smurg 0.4.0 wrote it: six settings, no `item` on a root. Hand-made, small. */
export function stateOfV040(workspaceId: string = WS): Record<string, unknown> {
  return {
    version: 1,
    workspaceId,
    members: [
      { userId: 'dev:host', displayName: 'Host', role: 'host', color: '#112233', joinedAt: 1_000, lastSeenAt: 2_000, status: 'active' },
      { userId: 'dev:amy', displayName: 'Amy', role: 'editor', color: '#445566', joinedAt: 1_100, lastSeenAt: 2_100, status: 'active' },
      { userId: 'dev:carl', displayName: 'Carl', role: 'editor', color: '#778899', joinedAt: 1_200, lastSeenAt: 1_900, status: 'kicked', kickedAt: 1_950 },
    ],
    devices: [
      { deviceId: 'dv_amy', userId: 'dev:amy', publicKeyHex: 'aa'.repeat(32), name: 'Amy laptop', kind: 'web', addedAt: 1_100, lastSeenAt: 2_100, revoked: false, inviteId: 'inv_used' },
      { deviceId: 'dv_carl', userId: 'dev:carl', publicKeyHex: 'cc'.repeat(32), name: 'Carl laptop', kind: 'cli', addedAt: 1_200, lastSeenAt: 1_900, revoked: true, revokedAt: 1_950 },
    ],
    invites: [
      { id: 'inv_used', keyIdHex: '11'.repeat(16), pskHex: '22'.repeat(32), role: 'editor', createdAt: 1_050, createdBy: 'dev:host', maxUses: 1, uses: 1, revoked: false, host: false },
      { id: 'inv_revoked', keyIdHex: '33'.repeat(16), pskHex: '44'.repeat(32), role: 'agent', createdAt: 1_060, createdBy: 'dev:host', expiresAt: 9_000_000, uses: 0, revoked: true, host: false },
      { id: 'inv_open', keyIdHex: '55'.repeat(16), pskHex: '66'.repeat(32), role: 'viewer', createdAt: 1_070, createdBy: null, uses: 2, revoked: false, host: false },
    ],
    settings: { humanLockIdleMs: 45_000, agentLockTimeoutMs: 90_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: ['data'], diskReserveBytes: 5 * GiB, diskReservePercent: 3 },
    worktreeRoots: [{ worktreeId: 'wt_1', realPath: '/tmp/project/.smurg/worktrees/wt_1', ownerUserId: 'dev:amy', sharedLinks: [{ path: 'data', mainPath: 'data', targetRealPath: '/tmp/project/data' }], registeredAt: 1_500 }],
  };
}

/** A suggestions.json as smurg 0.4.0 wrote it: no `origin`. */
export function suggestionsOfV040(): Record<string, unknown> {
  const base = { sessionId: 'ses_1', author: { userId: 'dev:amy', displayName: 'Amy' }, createdAt: 1_600, sessionOwnerUserId: 'dev:host' };
  return {
    version: 1,
    suggestions: [
      { id: 'sg_1', ...base, text: 'rename the helper', status: 'accepted', resolvedAt: 1_700, finalText: 'rename the helper', source: { file: { root: { kind: 'main' }, path: 'src/a.ts' }, startLine: 3, endLine: 5 } },
      { id: 'sg_2', ...base, text: 'add a test', status: 'rejected', resolvedAt: 1_710, rejectReason: 'later' },
      { id: 'sg_3', ...base, text: 'tidy up', status: 'rejected', resolvedAt: 1_720, closedReason: 'session-ended', editedAt: 1_650 },
      { id: 'sg_4', ...base, text: 'still waiting', status: 'pending' },
    ],
  };
}

/** The refusal `run` throws (fails when it does not throw one). */
export function refusalOf(run: () => unknown): StateFileError {
  try {
    run();
  } catch (err) {
    if (err instanceof StateFileError) return err;
    throw err;
  }
  throw new Error('not refused');
}

/** The refusal `run` rejects with (fails when it resolves, or rejects with something else). */
export async function rejectionOf(run: Promise<unknown>): Promise<StateFileError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof StateFileError) return err;
    throw err;
  }
  throw new Error('not refused');
}

/**
 * Everything below `dir`, byte for byte: every name with its kind, its mode and (for a file) the SHA-256 of its
 * bytes, (for a symlink) where it points. Two equal snapshots: nothing was created, removed, renamed, chmod-ed or
 * written. Modification times are not compared (a read does not change them, and a rewrite with the same bytes is
 * caught by nothing here: tests that care compare `mtimeMs` themselves).
 */
export async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string, name: string): Promise<void> => {
    let st;
    try {
      st = await lstat(path);
    } catch {
      return;
    }
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) out[name] = `link ${mode} -> ${await readlink(path)}`;
    else if (st.isDirectory()) {
      out[`${name}/`] = `dir ${mode}`;
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${name}/${entry}`);
    } else if (st.isFile()) {
      // A file this user may not read (a test of exactly that) is still named with its mode and size.
      const bytes = await readFile(path).catch(() => null);
      out[name] = `file ${mode} ${st.size} ${bytes === null ? 'unreadable' : createHash('sha256').update(bytes).digest('hex')}`;
    }
    else out[name] = `other ${mode}`;
  };
  await walk(dir, '.');
  return out;
}
