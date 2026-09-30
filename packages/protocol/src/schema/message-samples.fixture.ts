// Test fixture (not exported by any entry point): at least one valid and one invalid payload for every message type,
// and the same for the `.ok` result of every request. Typed as Record<MessageType, …> so adding a type to the
// registry without samples is a compile error; registry.test.ts and codec.test.ts run every sample.
import { MAX_CHUNK_SIZE, UPLOAD_HASHES_PAGE_MAX } from '../constants.ts';
import type { MessageType } from './registry.ts';

export type SampleSet = { readonly valid: readonly unknown[]; readonly invalid: readonly unknown[] };
export type MessageSamples = { readonly payload: SampleSet; readonly result?: SampleSet };

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export const T = 1_727_000_000_000;
export const HOST = 'github:12345';
export const AMY = 'dev:amy';
export const MAIN = { kind: 'main' } as const;
export const WT = { kind: 'worktree', worktreeId: 'wt_1' } as const;
export const FILE = { root: MAIN, path: 'src/app.ts' };
export const WT_FILE = { root: WT, path: 'docs/讀我.md' };
export const HASH = 'a'.repeat(64);
export const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

export const member = { userId: HOST, displayName: 'Ian', role: 'host', color: '#ff8800', online: true, joinedAt: T };
export const guestMember = { userId: AMY, displayName: 'Amy', role: 'editor', color: '#3366cc', online: true, joinedAt: T };
export const entry = { name: 'app.ts', path: 'src/app.ts', kind: 'file', size: 12, mtime: T };
export const disk = {
  totalBytes: 500 * GiB,
  availableBytes: 30 * GiB,
  reserveBytes: 25 * GiB,
  pendingBytes: 0,
  requestedBytes: 10 * GiB,
  freeAfterBytes: 20 * GiB,
  ok: false,
};
export const humanLock = {
  kind: 'human',
  file: FILE,
  holders: [{ userId: AMY, displayName: 'Amy', lastActivityAt: T }],
  acquiredAt: T,
};
export const agentActor = { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST, displayName: 'Claude（Ian）' };
export const agentLock = {
  kind: 'agent',
  file: FILE,
  sessionId: 'sess_1',
  ownerUserId: HOST,
  agentName: 'Claude（Ian）',
  acquiredAt: T,
  expiresAt: T + 60_000,
};
export const session = {
  id: 'sess_1',
  kind: 'agent',
  ownerUserId: HOST,
  ownerName: 'Ian',
  title: 'Claude',
  sandboxed: false,
  root: MAIN,
  status: 'running',
  cols: 120,
  rows: 40,
  createdAt: T,
  login: 'logged-in',
  attached: 1,
};
export const suggestion = {
  id: 'sg_1',
  sessionId: 'sess_1',
  author: { userId: AMY, displayName: 'Amy' },
  text: '請幫這個函式加上測試\n\tthanks',
  source: { file: FILE, startLine: 3, endLine: 9 },
  status: 'pending',
  createdAt: T,
};
export const conflict = {
  id: 'c_1',
  file: FILE,
  createdAt: T,
  source: agentActor,
  humans: [{ userId: AMY, displayName: 'Amy' }],
  hunks: [{ humanText: 'amy()', agentText: 'agent()', baseText: 'base()', startLine: 3 }],
  agentVersionBytes: 120,
  status: 'open',
};
export const worktree = {
  id: 'wt_1',
  ownerUserId: AMY,
  ownerName: 'Amy',
  branch: 'smurg/amy/wt_1',
  sessionId: 'sess_2',
  kept: false,
  createdAt: T,
  sharedDirs: ['data'],
};
export const mergeRequest = {
  id: 'mr_1',
  worktreeId: 'wt_1',
  requestedBy: { userId: AMY, displayName: 'Amy' },
  message: 'add tests',
  commit: '0123456789abcdef0123456789abcdef01234567',
  status: 'pending',
  createdAt: T,
};
export const activity = { id: 'ev_1', at: T, actor: agentActor, kind: 'agent.edit', file: FILE, summary: '修改了 src/app.ts' };
export const invite = { id: 'inv_1', role: 'editor', createdAt: T, expiresAt: T + 3_600_000, maxUses: 3, uses: 0, revoked: false };
export const device = { deviceId: 'dev_1', name: 'Chrome on macOS', kind: 'web', addedAt: T, lastSeenAt: T, revoked: false };
export const audit = {
  id: 'a_1',
  at: T,
  actor: { kind: 'user', userId: HOST, displayName: 'Ian' },
  action: 'file.write',
  target: 'src/app.ts',
  outcome: 'ok',
  detail: { bytes: 12 },
};
export const publicSettings = {
  humanLockIdleMs: 30_000,
  agentLockTimeoutMs: 60_000,
  uploadChunkSize: 4 * MiB,
  sharedDirs: ['data', 'checkpoints'],
};
export const hostSettings = {
  ...publicSettings,
  allowedDomains: ['api.anthropic.com', '*.npmjs.org', 'registry.example.com:8443'],
  diskReserveBytes: 5 * GiB,
  diskReservePercent: 5,
};
export const empty = {};
const emptyOnly: SampleSet = { valid: [{}], invalid: [{ extra: 1 }, null, []] };

export const MESSAGE_SAMPLES: Record<MessageType, MessageSamples> = {
  // ---- channel.* ------------------------------------------------------------------------------------------------
  'channel.memberUpdated': {
    payload: { valid: [{ member: guestMember }], invalid: [{ member: { ...guestMember, role: 'owner' } }, {}] },
  },
  'channel.settingsUpdated': {
    payload: {
      valid: [{ settings: publicSettings }, { settings: { ...publicSettings, guestSubscriptionLogin: false } }],
      invalid: [
        { settings: hostSettings },
        { settings: { ...publicSettings, uploadChunkSize: 16 * MiB } },
        { settings: { ...publicSettings, guestSubscriptionLogin: 'yes' } },
        {},
      ],
    },
  },
  'channel.closed': {
    payload: {
      valid: [{ reason: 'kicked' }, { reason: 'role-changed', message: '你的角色已變更' }],
      invalid: [{ reason: 'bored' }, { reason: 'kicked', message: 'a\u001b[31mred' }],
    },
  },
  'channel.ack': { payload: { valid: [{ upTo: 0 }, { upTo: 42 }], invalid: [{ upTo: -1 }, { upTo: 1.5 }, { upTo: 2 ** 53 }] } },
  'channel.leave': { payload: emptyOnly, result: emptyOnly },
  error: {
    payload: {
      valid: [
        { code: 'forbidden', message: '你沒有權限執行這個動作' },
        { code: 'insufficient_disk', message: 'no space', detail: { disk } },
      ],
      invalid: [
        { code: 'teapot', message: 'x' },
        { code: 'internal', message: 'x'.repeat(2_001) },
        { code: 'internal', message: 'x', detail: { constructor: 1 } },
      ],
    },
  },

  // ---- file.* ---------------------------------------------------------------------------------------------------
  'file.tree': {
    payload: {
      valid: [{ root: MAIN, path: '' }, { root: WT, path: 'docs', depth: 3 }],
      invalid: [{ root: MAIN, path: '../etc' }, { root: MAIN, path: '/abs' }, { root: MAIN, path: '', depth: 0 }],
    },
    result: {
      valid: [{ entries: [entry, { name: 'src', path: 'src', kind: 'dir', size: 0, mtime: -1000 }], truncated: false }],
      invalid: [{ entries: [{ ...entry, kind: 'socket' }], truncated: false }, { entries: [] }],
    },
  },
  'file.stat': {
    payload: { valid: [FILE, { root: MAIN, path: '' }], invalid: [{ root: MAIN, path: 'a\\b' }, { root: { kind: 'other' }, path: 'a' }] },
    result: { valid: [{ entry: { ...entry, lock: humanLock, lastModifiedBy: agentActor } }], invalid: [{ entry: { ...entry, size: -1 } }] },
  },
  'file.create': {
    payload: {
      valid: [{ file: FILE, kind: 'file' }, { file: WT_FILE, kind: 'dir' }],
      invalid: [{ file: { root: MAIN, path: '' }, kind: 'file' }, { file: FILE, kind: 'symlink' }],
    },
    result: { valid: [{ entry }], invalid: [{ entry: { ...entry, name: 'a/b' } }] },
  },
  'file.rename': {
    payload: {
      valid: [{ root: MAIN, from: 'a.txt', to: 'b/c.txt' }],
      invalid: [{ root: MAIN, from: 'a.txt', to: 'b//c.txt' }, { root: MAIN, from: 'a.txt' }],
    },
    result: { valid: [{ entry }], invalid: [{}] },
  },
  'file.delete': {
    payload: { valid: [{ file: FILE }], invalid: [{ file: { root: MAIN, path: 'a/./b' } }] },
    result: emptyOnly,
  },
  'file.read': {
    payload: {
      valid: [{ file: FILE }, { file: FILE, maxBytes: 1024 }],
      invalid: [{ file: FILE, maxBytes: 5 * MiB + 1 }, { file: { root: MAIN, path: 'C:/x' } }],
    },
    result: {
      valid: [{ content: bytes(12), hash: HASH, truncated: false }],
      invalid: [{ content: 'text', hash: HASH, truncated: false }, { content: bytes(1), hash: 'A'.repeat(64), truncated: false }],
    },
  },
  'file.write': {
    payload: {
      valid: [{ file: FILE, content: bytes(3) }, { file: FILE, content: new Uint8Array(0), ifMatchHash: HASH }],
      invalid: [{ file: FILE, content: [1, 2, 3] }, { file: FILE, content: bytes(5 * MiB + 1) }],
    },
    result: { valid: [{ entry, hash: HASH }], invalid: [{ entry, hash: 'nothex' }] },
  },
  'file.changed': {
    payload: {
      valid: [{ root: MAIN, changes: [{ path: 'src/app.ts', change: 'change', by: agentActor }, { path: 'tmp', change: 'unlinkDir' }] }],
      invalid: [{ root: MAIN, changes: [] }, { root: MAIN, changes: [{ path: 'a', change: 'moved' }] }],
    },
  },

  // ---- transfer -------------------------------------------------------------------------------------------------
  'file.upload.plan': {
    payload: {
      valid: [
        {
          root: MAIN,
          entries: [
            { path: 'photos', kind: 'dir' },
            { path: 'photos/empty', kind: 'dir' },
            { path: 'photos/cafe\u0301.jpg', kind: 'file', size: 10 * GiB },
          ],
          onConflict: 'rename',
        },
      ],
      invalid: [
        { root: MAIN, entries: [{ path: 'a', kind: 'file' }], onConflict: 'fail' },
        { root: MAIN, entries: [{ path: 'a', kind: 'dir', size: 1 }], onConflict: 'fail' },
        { root: MAIN, entries: [], onConflict: 'fail' },
      ],
    },
    result: {
      valid: [{ disk, renamed: [{ from: 'photos/a.jpg', to: 'photos/a (1).jpg' }] }],
      invalid: [{ disk: { ...disk, ok: 'yes' }, renamed: [] }],
    },
  },
  'file.upload.begin': {
    payload: {
      valid: [
        { root: MAIN, path: 'big.bin', size: 10 * GiB, chunkSize: 4 * MiB, lastModified: T },
        { root: WT, path: 'big.bin', size: 0, chunkSize: 1 * MiB, lastModified: 0, uploadId: 'up_1', onConflict: 'overwrite' },
      ],
      invalid: [
        { root: MAIN, path: 'big.bin', size: 1, chunkSize: 512 * KiB, lastModified: T },
        { root: MAIN, path: 'big.bin', size: 1, chunkSize: 9 * MiB, lastModified: T },
        { root: MAIN, path: 'big.bin', size: 2 ** 53, chunkSize: 4 * MiB, lastModified: T },
      ],
    },
    result: {
      valid: [{ uploadId: 'up_1', chunkCount: 2560, have: bytes(320, 0), received: 0, resumed: false, disk }],
      invalid: [{ uploadId: 'up 1', chunkCount: 1, have: bytes(1), received: 0, resumed: false, disk }],
    },
  },
  'file.upload.hashes': {
    payload: {
      valid: [{ uploadId: 'up_1', from: 0, count: 64 }],
      invalid: [{ uploadId: 'up_1', from: 0, count: 0 }, { uploadId: 'up_1', from: 0, count: UPLOAD_HASHES_PAGE_MAX + 1 }],
    },
    result: { valid: [{ hashes: bytes(64) }, { hashes: new Uint8Array(0) }], invalid: [{ hashes: bytes(33) }] },
  },
  'file.upload.chunk': {
    payload: {
      valid: [{ uploadId: 'up_1', index: 3, hash: bytes(32), data: bytes(4 * MiB) }],
      invalid: [
        { uploadId: 'up_1', index: 3, hash: bytes(31), data: bytes(10) },
        { uploadId: 'up_1', index: 3, hash: bytes(32), data: bytes(MAX_CHUNK_SIZE + 1) },
        { uploadId: 'up_1', index: 3, hash: bytes(32), data: new Uint8Array(0) },
        { uploadId: 'up_1', index: 3, hash: bytes(32), data: new Int8Array(4) },
      ],
    },
    result: { valid: [{ index: 3 }], invalid: [{ index: -3 }] },
  },
  'file.upload.commit': {
    payload: { valid: [{ uploadId: 'up_1', rootHash: bytes(32) }], invalid: [{ uploadId: 'up_1', rootHash: HASH }] },
    result: { valid: [{ entry }], invalid: [{ entry: {} }] },
  },
  'file.upload.abort': { payload: { valid: [{ uploadId: 'up_1' }], invalid: [{ uploadId: '' }] }, result: emptyOnly },
  'file.download.begin': {
    payload: {
      valid: [{ file: { root: MAIN, path: '' }, zip: true }, { file: FILE, offset: 8 * MiB, ifMatch: '12-1727000000000123-99' }],
      invalid: [{ file: FILE, zip: true, offset: 5 }, { file: FILE, ifMatch: 'has space' }],
    },
    result: {
      valid: [{ downloadId: 'dl_1', name: 'app.ts', size: 12, etag: '12-1-2', zip: false }, { downloadId: 'dl_2', name: 'Smurg.zip', zip: true }],
      invalid: [{ downloadId: 'dl_1', name: '../x', zip: false }],
    },
  },
  'file.download.chunk': {
    payload: {
      valid: [{ downloadId: 'dl_1', index: 0, offset: 0, data: bytes(1024) }],
      invalid: [{ downloadId: 'dl_1', index: 0, offset: 0, data: new Uint8Array(0) }, { downloadId: 'dl_1', index: 0, data: bytes(1) }],
    },
  },
  'file.download.ack': { payload: { valid: [{ downloadId: 'dl_1', index: 7 }], invalid: [{ downloadId: 'dl_1', index: '7' }] } },
  'file.download.end': {
    payload: {
      valid: [
        { downloadId: 'dl_2', totalBytes: 163_093_384, skipped: [{ path: 'a-fifo', reason: 'special-file' }], zip64: false },
        { downloadId: 'dl_3', totalBytes: 0, skipped: [], zip64: false, error: { code: 'internal', message: 'disk error' } },
      ],
      invalid: [{ downloadId: 'dl_2', totalBytes: 1, skipped: [{ path: '/etc/passwd', reason: 'x' }], zip64: false }],
    },
  },
  'file.download.cancel': { payload: { valid: [{ downloadId: 'dl_1' }], invalid: [{ downloadId: 'dl/1' }] } },

  // ---- doc.* ----------------------------------------------------------------------------------------------------
  'doc.open': {
    payload: { valid: [{ file: FILE }, { file: WT_FILE }], invalid: [{ file: { root: MAIN, path: '' } }, { path: 'src/app.ts' }] },
    result: {
      valid: [
        { docId: 'doc_1', epoch: 'e1', canEdit: true, meta: { eol: 'CRLF', bom: true, mixedEol: false } },
        { docId: 'doc_1', epoch: 'e1', canEdit: false, lock: agentLock, meta: { eol: 'LF', bom: false, mixedEol: true } },
      ],
      invalid: [{ docId: 'doc_1', epoch: 'e1', canEdit: true, meta: { eol: '\n', bom: false, mixedEol: false } }],
    },
  },
  'doc.reset': { payload: { valid: [{ docId: 'doc_1', epoch: 'e2' }], invalid: [{ docId: 'doc_1' }] } },
  'doc.sync': {
    payload: {
      valid: [{ docId: 'doc_1', data: new Uint8Array([0, 0, 1, 0]) }],
      invalid: [{ docId: 'doc_1', data: new Uint8Array(0) }, { docId: 'doc_1', data: 'AAE=' }],
    },
  },
  'doc.awareness': {
    payload: { valid: [{ docId: 'doc_1', data: bytes(40) }], invalid: [{ docId: 'doc_1', data: bytes(256 * KiB + 1) }] },
  },
  'doc.close': { payload: { valid: [{ docId: 'doc_1' }], invalid: [{ docId: 'doc_1', force: true }] } },
  'doc.saved': {
    payload: { valid: [{ docId: 'doc_1', file: FILE, hash: HASH, at: T }], invalid: [{ docId: 'doc_1', file: FILE, hash: HASH, at: -1 }] },
  },
  'doc.rejected': {
    payload: {
      valid: [{ docId: 'doc_1', reason: 'agent-locked', lock: agentLock }, { docId: 'doc_1', reason: 'read-only' }, { docId: 'doc_1', reason: 'file-unavailable' }],
      invalid: [{ docId: 'doc_1', reason: 'because' }],
    },
  },
  'doc.conflict': {
    payload: {
      valid: [{ conflict }, { conflict: { ...conflict, hunks: [{ ...conflict.hunks[0], truncated: true }], hunksOmitted: 3 } }],
      invalid: [{ conflict: { ...conflict, hunks: [{ ...conflict.hunks[0], startLine: 0 }] } }, { conflict: { ...conflict, agentVersion: 'x' } }],
    },
  },
  'doc.conflict.list': {
    payload: emptyOnly,
    result: { valid: [{ conflicts: [conflict] }, { conflicts: [] }], invalid: [{ conflicts: [{ ...conflict, status: 'closed' }] }] },
  },
  'doc.conflict.resolve': {
    payload: {
      valid: [{ conflictId: 'c_1', action: 'dismiss' }, { conflictId: 'c_1', action: 'apply-agent-version' }],
      invalid: [{ conflictId: 'c_1', action: 'merge' }],
    },
    result: { valid: [{ conflict: { ...conflict, status: 'applied' } }], invalid: [{ conflict: null }] },
  },
  'doc.conflict.get': {
    payload: { valid: [{ conflictId: 'c_1' }], invalid: [{ conflictId: 1 }] },
    result: { valid: [{ conflict, agentVersion: bytes(120) }], invalid: [{ conflict, agentVersion: 'agent text' }] },
  },

  // ---- lock / presence / activity ----------------------------------------------------------------------------------
  'lock.state': {
    payload: { valid: [{ file: FILE, lock: humanLock }, { file: FILE, lock: null }], invalid: [{ file: FILE }, { file: FILE, lock: { kind: 'human', file: FILE, holders: [], acquiredAt: T } }] },
  },
  'lock.list': {
    payload: emptyOnly,
    result: { valid: [{ locks: [humanLock, agentLock] }], invalid: [{ locks: [{ ...agentLock, kind: 'robot' }] }] },
  },
  'lock.release': { payload: { valid: [{ file: FILE }], invalid: [{ file: { root: MAIN, path: '' } }] }, result: emptyOnly },
  'lock.forceRelease': { payload: { valid: [{ file: WT_FILE }], invalid: [{}] }, result: emptyOnly },
  'presence.heartbeat': { payload: { valid: [{ at: T }], invalid: [{ at: 'now' }] } },
  'presence.state': {
    payload: {
      valid: [
        {
          members: [{ ...member, connections: 2, activeFile: FILE }],
          agents: [{ sessionId: 'sess_1', ownerUserId: HOST, displayName: 'Claude（Ian）', color: '#f59e0b', status: 'running' }],
        },
      ],
      invalid: [{ members: [member], agents: [] }],
    },
  },
  'presence.update': {
    payload: { valid: [{ activeFile: FILE }, { activeFile: null }, {}], invalid: [{ activeFile: { root: MAIN, path: '..' } }] },
  },
  'activity.event': {
    payload: {
      valid: [{ event: activity }, { event: { ...activity, via: 'bash' } }],
      invalid: [{ event: { ...activity, kind: 'agent.dance' } }, { event: { ...activity, via: 'zsh' } }, { event: { ...activity, via: '' } }],
    },
  },
  'activity.list': {
    payload: { valid: [{}, { limit: 50, before: T }], invalid: [{ limit: 501 }, { limit: 0 }] },
    result: { valid: [{ events: [activity] }], invalid: [{ events: [{ ...activity, summary: 'x'.repeat(501) }] }] },
  },
  'activity.notify': {
    payload: {
      valid: [{ notification: { id: 'n_1', at: T, from: agentActor, text: 'Amy，src/app.ts 我改好了', file: FILE } }],
      invalid: [{ notification: { id: 'n_1', at: T, from: agentActor, text: '' } }],
    },
  },

  // ---- session.* / exec.* -------------------------------------------------------------------------------------
  'session.create': {
    payload: {
      valid: [
        { kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40 },
        { kind: 'terminal', workspace: { mode: 'worktree', worktreeId: 'wt_1' }, cols: 80, rows: 24, title: 'shell', apiKey: 'sk-ant-api03-abc' },
        { kind: 'login', workspace: { mode: 'main' }, cols: 120, rows: 40 },
      ],
      invalid: [
        { kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40, sandboxed: false },
        { kind: 'login', workspace: { mode: 'main' }, cols: 120, rows: 40, command: 'claude auth login' },
        { kind: 'oauth', workspace: { mode: 'main' }, cols: 120, rows: 40 },
        { kind: 'agent', workspace: { mode: 'elsewhere' }, cols: 120, rows: 40 },
        { kind: 'agent', workspace: { mode: 'main' }, cols: 0, rows: 40 },
        { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24, apiKey: 'has space' },
      ],
    },
    result: { valid: [{ session }], invalid: [{ session: { ...session, status: 'paused' } }] },
  },
  'session.list': {
    payload: emptyOnly,
    result: { valid: [{ sessions: [session, { ...session, id: 'sess_2', status: 'exited', exitCode: 3, endedAt: T + 1 }] }], invalid: [{ sessions: {} }] },
  },
  'session.loginStatus': {
    payload: { valid: [{ sessionId: 'sess_1' }], invalid: [{ sessionId: 'sess 1' }] },
    result: { valid: [{ login: 'logged-out' }], invalid: [{ login: 'maybe' }] },
  },
  'session.attach': {
    payload: {
      valid: [{ sessionId: 'sess_1' }, { sessionId: 'sess_1', haveOffset: 1_000_000, cols: 100, rows: 30 }],
      invalid: [{ sessionId: 'sess_1', cols: 100 }, { sessionId: 'sess_1', haveOffset: -1 }],
    },
    result: {
      valid: [{ session, mode: 'snapshot', data: bytes(2048), cols: 120, rows: 40, nextOffset: 99 }],
      invalid: [{ session, mode: 'replay', data: bytes(1), cols: 120, rows: 40, nextOffset: 99 }],
    },
  },
  'session.detach': { payload: { valid: [{ sessionId: 'sess_1' }], invalid: [{}] } },
  'session.end': {
    payload: { valid: [{ sessionId: 'sess_1' }, { sessionId: 'sess_1', keepWorktree: true }], invalid: [{ sessionId: 'sess_1', keepWorktree: 'yes' }] },
    result: emptyOnly,
  },
  'session.state': { payload: { valid: [{ session }], invalid: [{ session: { ...session, cols: 1001 } }] } },
  'session.importConfig': {
    payload: {
      valid: [{ files: [{ relPath: 'CLAUDE.md', content: bytes(10) }, { relPath: 'skills/tdd/SKILL.md', content: bytes(5) }] }],
      invalid: [
        { files: [{ relPath: 'settings.json', content: bytes(1) }] },
        { files: [{ relPath: 'commands', content: bytes(1) }] },
        { files: [{ relPath: 'commands/../../x', content: bytes(1) }] },
        { files: [] },
        // Each file is within its own cap, but together they exceed one request's content cap (7 MiB).
        { files: Array.from({ length: 8 }, (_, i) => ({ relPath: `skills/s${i}.md`, content: bytes(1 * MiB) })) },
      ],
    },
    result: { valid: [{ written: ['CLAUDE.md', 'commands/review.md'] }], invalid: [{ written: ['.ssh/id_rsa'] }] },
  },
  'exec.output': {
    payload: {
      valid: [{ sessionId: 'sess_1', offset: 0, data: bytes(64 * KiB) }],
      invalid: [{ sessionId: 'sess_1', offset: 0, data: new Uint8Array(0) }, { sessionId: 'sess_1', offset: 0.5, data: bytes(1) }],
    },
  },
  'exec.input': {
    payload: { valid: [{ sessionId: 'sess_1', data: new Uint8Array([0x1b, 0x5b, 0x41]) }], invalid: [{ sessionId: 'sess_1', data: 'ls\r' }] },
  },
  'exec.resize': {
    payload: { valid: [{ sessionId: 'sess_1', cols: 80, rows: 24 }], invalid: [{ sessionId: 'sess_1', cols: 80 }, { sessionId: 'sess_1', cols: 80, rows: 1001 }] },
  },

  // ---- suggest.* ------------------------------------------------------------------------------------------------
  'suggest.create': {
    payload: {
      valid: [{ sessionId: 'sess_1', text: 'please run the tests' }, { sessionId: 'sess_1', text: 'look here', source: { file: FILE, startLine: 1, endLine: 1 } }],
      invalid: [
        { sessionId: 'sess_1', text: 'paste\u001b[201~rm -rf ~\r' },
        { sessionId: 'sess_1', text: '   \n\t' },
        { sessionId: 'sess_1', text: 'x', source: { file: FILE, startLine: 5, endLine: 4 } },
        { sessionId: 'sess_1', text: 'evil \u202e reversed' },
      ],
    },
    result: { valid: [{ suggestion }], invalid: [{ suggestion: { ...suggestion, status: 'auto-accepted' } }] },
  },
  'suggest.edit': {
    payload: { valid: [{ suggestionId: 'sg_1', text: 'better wording' }], invalid: [{ suggestionId: 'sg_1', text: '' }] },
    result: { valid: [{ suggestion }], invalid: [{}] },
  },
  'suggest.withdraw': {
    payload: { valid: [{ suggestionId: 'sg_1' }], invalid: [{ suggestionId: 'sg_1', reason: 'x' }] },
    result: { valid: [{ suggestion: { ...suggestion, status: 'withdrawn', resolvedAt: T } }], invalid: [{ suggestion: { ...suggestion, author: 'Amy' } }] },
  },
  'suggest.accept': {
    payload: { valid: [{ suggestionId: 'sg_1' }, { suggestionId: 'sg_1', text: 'edited by owner' }], invalid: [{ suggestionId: 'sg_1', text: 'x'.repeat(64 * KiB + 1) }] },
    result: {
      valid: [{ suggestion: { ...suggestion, status: 'accepted-modified', resolvedAt: T, finalText: 'edited by owner' } }],
      invalid: [{ suggestion: { ...suggestion, createdAt: 'yesterday' } }],
    },
  },
  'suggest.reject': {
    payload: { valid: [{ suggestionId: 'sg_1' }, { suggestionId: 'sg_1', reason: '先不要' }], invalid: [{ suggestionId: 'sg_1', reason: 'line1\nline2' }] },
    result: { valid: [{ suggestion: { ...suggestion, status: 'rejected', resolvedAt: T, rejectReason: '先不要' } }], invalid: [{ suggestion: null }] },
  },
  'suggest.list': {
    payload: { valid: [{}, { sessionId: 'sess_1' }], invalid: [{ sessionId: null }] },
    result: { valid: [{ suggestions: [suggestion] }], invalid: [{ suggestions: [{ ...suggestion, id: '' }] }] },
  },
  'suggest.updated': { payload: { valid: [{ suggestion }], invalid: [{ suggestion: { ...suggestion, text: 42 } }] } },

  // ---- worktree.* -----------------------------------------------------------------------------------------------
  'worktree.list': {
    payload: emptyOnly,
    result: { valid: [{ worktrees: [worktree] }], invalid: [{ worktrees: [{ ...worktree, sharedDirs: ['/data'] }] }] },
  },
  'worktree.remove': { payload: { valid: [{ worktreeId: 'wt_1' }], invalid: [{ worktreeId: '../wt' }] }, result: emptyOnly },
  'worktree.merge.request': {
    payload: { valid: [{ worktreeId: 'wt_1' }, { worktreeId: 'wt_1', message: 'done\n- tests' }], invalid: [{ worktreeId: 'wt_1', message: 'x'.repeat(4_001) }] },
    result: {
      valid: [{ request: mergeRequest }, { request: { ...mergeRequest, commit: 'a'.repeat(64) } }],
      invalid: [{ request: { ...mergeRequest, status: 'open' } }, { request: { ...mergeRequest, commit: 'HEAD' } }, { request: { ...mergeRequest, commit: undefined } }],
    },
  },
  'worktree.merge.list': {
    payload: emptyOnly,
    result: {
      valid: [{ requests: [mergeRequest, { ...mergeRequest, id: 'mr_2', status: 'conflict', conflictFiles: ['src/app.ts'], decidedAt: T }] }],
      invalid: [{ requests: [{ ...mergeRequest, conflictFiles: ['../x'] }] }],
    },
  },
  'worktree.merge.diff': {
    payload: { valid: [{ requestId: 'mr_1' }], invalid: [{ requestId: 'mr_1', context: 3 }] },
    result: {
      valid: [
        {
          diff: 'diff --git a/src/app.ts b/src/app.ts\n+x\n',
          truncated: false,
          files: [
            { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 },
            { path: 'img.png', status: 'added', additions: 0, deletions: 0, binary: true },
            { path: 'b.ts', status: 'renamed', additions: 0, deletions: 0, oldPath: 'a.ts' },
          ],
        },
      ],
      invalid: [{ diff: 'x', truncated: false, files: [{ path: 'a', status: 'M', additions: 1, deletions: 0 }] }, { diff: 'x\u0000', truncated: false, files: [] }],
    },
  },
  'worktree.merge.fileDiff': {
    payload: { valid: [{ requestId: 'mr_1', path: 'src/app.ts' }], invalid: [{ requestId: 'mr_1', path: '../x' }, { requestId: 'mr_1', path: '' }, { requestId: 'mr_1' }] },
    result: {
      valid: [
        { path: 'src/app.ts', diff: 'diff --git a/src/app.ts b/src/app.ts\n+x\n', truncated: false, binary: false },
        { path: 'img.png', diff: '', truncated: false, binary: true },
      ],
      invalid: [{ path: 'src/app.ts', diff: 'x', truncated: false }, { path: '/etc/passwd', diff: '', truncated: false, binary: false }],
    },
  },
  'worktree.merge.approve': {
    payload: { valid: [{ requestId: 'mr_1' }], invalid: [{}] },
    result: { valid: [{ request: { ...mergeRequest, status: 'merged', decidedAt: T } }], invalid: [{ request: { ...mergeRequest, requestedBy: HOST } }] },
  },
  'worktree.merge.reject': {
    payload: { valid: [{ requestId: 'mr_1' }, { requestId: 'mr_1', reason: '請先修正測試' }], invalid: [{ requestId: 'mr_1', reason: 7 }] },
    result: { valid: [{ request: { ...mergeRequest, status: 'rejected', decidedAt: T, rejectReason: '請先修正測試' } }], invalid: [{ request: {} }] },
  },
  'worktree.updated': { payload: { valid: [{ worktree }], invalid: [{ worktree: { ...worktree, kept: 1 } }] } },
  'worktree.merge.updated': { payload: { valid: [{ request: mergeRequest }], invalid: [{ request: mergeRequest, extra: true }] } },
  'worktree.removed': { payload: { valid: [{ worktreeId: 'wt_1' }], invalid: [{ worktree }] } },

  // ---- admin.* --------------------------------------------------------------------------------------------------
  'admin.invite.create': {
    payload: {
      valid: [{ role: 'editor' }, { role: 'runner', expiresInSec: 86_400, maxUses: 5 }],
      invalid: [{ role: 'host' }, { role: 'viewer', maxUses: 0 }],
    },
    result: {
      valid: [{ invite, url: 'https://smurg.app/join/AbCdEfGh_-012345#k=abc&s=def' }],
      invalid: [{ invite, url: 'javascript alert(1)' }],
    },
  },
  'admin.invite.list': { payload: emptyOnly, result: { valid: [{ invites: [invite] }], invalid: [{ invites: [{ ...invite, uses: -1 }] }] } },
  'admin.invite.revoke': { payload: { valid: [{ inviteId: 'inv_1' }], invalid: [{ inviteId: '' }] }, result: emptyOnly },
  'admin.member.list': {
    payload: emptyOnly,
    result: { valid: [{ members: [{ ...guestMember, devices: [device] }] }], invalid: [{ members: [guestMember] }] },
  },
  'admin.member.setRole': {
    payload: { valid: [{ userId: AMY, role: 'runner' }], invalid: [{ userId: AMY, role: 'host' }, { userId: 'amy', role: 'viewer' }] },
    result: { valid: [{ member: { ...guestMember, role: 'runner' } }], invalid: [{ member: { ...guestMember, avatarUrl: 'http://x/y.png' } }] },
  },
  'admin.member.kick': { payload: { valid: [{ userId: AMY }], invalid: [{ userId: 'root' }] }, result: emptyOnly },
  'admin.session.terminate': { payload: { valid: [{ sessionId: 'sess_2' }], invalid: [{ session: 'sess_2' }] }, result: emptyOnly },
  'admin.audit.query': {
    payload: { valid: [{}, { limit: 100, before: T }], invalid: [{ before: -5 }] },
    result: { valid: [{ entries: [audit] }], invalid: [{ entries: [{ ...audit, action: 'coffee.make' }] }, { entries: [{ ...audit, detail: { prototype: {} } }] }] },
  },
  'admin.audit.entry': { payload: { valid: [{ entry: audit }], invalid: [{ entry: { ...audit, outcome: 'meh' } }] } },
  'admin.settings.get': {
    payload: emptyOnly,
    result: {
      valid: [{ settings: hostSettings }],
      invalid: [{ settings: { ...hostSettings, uploadChunkSize: 16 * MiB } }, { settings: { ...hostSettings, guestSubscriptionLogin: true } }],
    },
  },
  'admin.settings.set': {
    payload: {
      valid: [{}, { diskReserveBytes: 10 * GiB }, { allowedDomains: ['pypi.org'], sharedDirs: ['data'] }],
      invalid: [
        { allowedDomains: ['https://evil.example'] },
        { allowedDomains: ['EXAMPLE.com'] },
        { diskReservePercent: 101 },
        { sandbox: false },
        { humanLockIdleMs: 10 },
        // configuration, not a console setting (ARCHITECTURE §11 D-12)
        { guestSubscriptionLogin: false },
      ],
    },
    result: { valid: [{ settings: hostSettings }], invalid: [{ settings: { ...hostSettings, allowedDomains: ['a..b'] } }] },
  },
};
