// One schema-valid payload per request type (and per one-way client message). Typed as a mapped type over the
// registry, so a request type added to @smurg/protocol without a sample here is a compile error.
// Payloads point at objects that do not exist (dev:nobody, *_nope ids): where a real handler runs (admin.*), an
// allowed request ends in not_found instead of changing the workspace.
import type { InboundNotifyType } from '../../src/core/interfaces.ts';
import type { PayloadInputOf, RequestType } from '@smurg/protocol';

const MiB = 1024 * 1024;
const MAIN = { kind: 'main' } as const;
const FILE = { root: MAIN, path: 'src/app.ts' };
const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

export const REQUEST_SAMPLES: { readonly [T in RequestType]: PayloadInputOf<T> } = {
  'channel.leave': {},
  'file.tree': { root: MAIN, path: '' },
  'file.stat': FILE,
  'file.create': { file: FILE, kind: 'file' },
  'file.rename': { root: MAIN, from: 'a.txt', to: 'b.txt' },
  'file.delete': { file: FILE },
  'file.read': { file: FILE },
  'file.write': { file: FILE, content: bytes(3) },
  'file.upload.plan': { root: MAIN, entries: [{ path: 'photos', kind: 'dir' }], onConflict: 'fail' },
  'file.upload.begin': { root: MAIN, path: 'big.bin', size: 10, chunkSize: 4 * MiB, lastModified: 0 },
  'file.upload.hashes': { uploadId: 'up_nope', from: 0, count: 1 },
  'file.upload.chunk': { uploadId: 'up_nope', index: 0, hash: bytes(32), data: bytes(10) },
  'file.upload.commit': { uploadId: 'up_nope', rootHash: bytes(32) },
  'file.upload.abort': { uploadId: 'up_nope' },
  'file.download.begin': { file: FILE },
  'doc.open': { file: FILE },
  'doc.conflict.list': {},
  'doc.conflict.resolve': { conflictId: 'c_nope', action: 'dismiss' },
  'doc.conflict.get': { conflictId: 'c_nope' },
  'lock.list': {},
  'lock.release': { file: FILE },
  'lock.forceRelease': { file: FILE },
  'activity.list': {},
  'session.create': { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 },
  'session.list': {},
  'session.loginStatus': { sessionId: 'sess_nope' },
  'session.attach': { sessionId: 'sess_nope' },
  'session.end': { sessionId: 'sess_nope' },
  'suggest.create': { sessionId: 'sess_nope', text: 'please run the tests' },
  'suggest.edit': { suggestionId: 'sg_nope', text: 'better' },
  'suggest.withdraw': { suggestionId: 'sg_nope' },
  'suggest.accept': { suggestionId: 'sg_nope' },
  'suggest.reject': { suggestionId: 'sg_nope' },
  'suggest.list': {},
  'worktree.list': {},
  'worktree.remove': { worktreeId: 'wt_nope' },
  'worktree.merge.request': { worktreeId: 'wt_nope' },
  'worktree.merge.list': {},
  'worktree.merge.diff': { requestId: 'mr_nope' },
  'worktree.merge.fileDiff': { requestId: 'mr_nope', path: 'src/app.ts' },
  'worktree.merge.approve': { requestId: 'mr_nope' },
  'worktree.merge.reject': { requestId: 'mr_nope' },
  'admin.invite.create': { role: 'viewer', maxUses: 1 },
  'admin.invite.list': {},
  'admin.invite.revoke': { inviteId: 'inv_nope' },
  'admin.member.list': {},
  'admin.member.setRole': { userId: 'dev:nobody', role: 'viewer' },
  'admin.member.kick': { userId: 'dev:nobody' },
  'admin.session.terminate': { sessionId: 'sess_nope' },
  'admin.audit.query': { limit: 1 },
  'admin.settings.get': {},
  'admin.settings.set': {},
};

export const NOTIFY_SAMPLES: { readonly [T in InboundNotifyType]: PayloadInputOf<T> } = {
  'doc.sync': { docId: 'doc_nope', data: new Uint8Array([0, 0, 1, 0]) },
  'doc.awareness': { docId: 'doc_nope', data: bytes(8) },
  'doc.close': { docId: 'doc_nope' },
  'presence.update': { activeFile: null },
  'session.detach': { sessionId: 'sess_nope' },
  'exec.input': { sessionId: 'sess_nope', data: bytes(1) },
  'exec.resize': { sessionId: 'sess_nope', cols: 80, rows: 24 },
  'file.download.ack': { downloadId: 'dl_nope', index: 0 },
  'file.download.cancel': { downloadId: 'dl_nope' },
};
