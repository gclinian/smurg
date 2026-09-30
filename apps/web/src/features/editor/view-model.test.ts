import { MAIN_ROOT, fileRefKey, type LockInfo } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import type { OpenDoc } from '../../lib/stores/docs.ts';
import type { LocksState } from '../../lib/stores/locks.ts';
import { T0, makeAgentLock, makeHumanLock } from '../../testing/fixtures.ts';
import type { DocSessionState } from './doc-session.ts';
import {
  SAVE_STALE_MS,
  classifyOpenFailure,
  droppedMessage,
  editorView,
  liveLockOf,
  offersDownload,
  rejectionMessage,
  saveIndicator,
} from './view-model.ts';

const FILE = { root: MAIN_ROOT, path: 'src/app.ts' };

function openDoc(overrides: Partial<OpenDoc> = {}): OpenDoc {
  return {
    key: fileRefKey(FILE),
    file: FILE,
    status: 'open',
    docId: 'doc_1',
    epoch: 'epoch_1',
    editableBase: true,
    lock: null,
    meta: { eol: 'LF', bom: false, mixedEol: false },
    generation: 1,
    error: null,
    saved: null,
    rejected: null,
    removed: null,
    ...overrides,
  };
}

function session(overrides: Partial<DocSessionState> = {}): DocSessionState {
  return {
    key: fileRefKey(FILE),
    replica: 0,
    replicaSynced: true,
    live: true,
    epoch: 'epoch_1',
    pendingSave: false,
    lastLocalEditAt: null,
    lastSavedAt: null,
    dropped: null,
    recovery: null,
    openFailure: null,
    ...overrides,
  };
}

describe('editor view-model: who may type, and why not', () => {
  it('agent 正在修改的檔案，所有人的編輯器暫時唯讀並顯示提示；完成後自動恢復可編輯 — the view-model', () => {
    const agentLock = makeAgentLock(FILE.path);
    const locked = editorView({ doc: openDoc({ lock: agentLock }), session: session(), userId: 'dev:amy' });
    expect(locked).toMatchObject({ readOnly: true, reason: 'agent-lock', agentName: 'Claude（Ian）' });
    expect(locked.message).toBe('Claude（Ian）正在修改，暫時無法輸入');
    // Every member, including the host and the agent's owner, is read-only while the agent holds the file.
    expect(editorView({ doc: openDoc({ lock: agentLock }), session: session(), userId: 'dev:host' }).readOnly).toBe(true);
    // lock.state { lock: null } arrives: editable again, nothing to click.
    const released = editorView({ doc: openDoc({ lock: null }), session: session(), userId: 'dev:amy' });
    expect(released).toMatchObject({ readOnly: false, reason: null, message: null, agentName: null });
  });

  it('a viewer is always read-only, with or without locks, before and after they change', () => {
    const viewerDoc = openDoc({ editableBase: false });
    for (const lock of [null, makeAgentLock(FILE.path), makeHumanLock(FILE.path)] as (LockInfo | null)[]) {
      const view = editorView({ doc: { ...viewerDoc, lock }, session: session(), userId: 'dev:viewer' });
      expect(view.readOnly).toBe(true);
    }
    expect(editorView({ doc: viewerDoc, session: session(), userId: 'dev:viewer' }).reason).toBe('no-permission');
    // Also while reconnecting: never a misleading "loading" reason for a viewer.
    expect(editorView({ doc: { ...viewerDoc, status: 'reopening' }, session: session({ live: false }), userId: 'dev:v' }).reason).toBe('no-permission');
  });

  it('read-only until the replica holds the daemon text, and while reconnecting', () => {
    expect(editorView({ doc: openDoc({ status: 'opening', docId: null }), session: undefined, userId: 'dev:amy' }).reason).toBe('loading');
    expect(editorView({ doc: openDoc(), session: session({ replicaSynced: false }), userId: 'dev:amy' }).reason).toBe('loading');
    expect(editorView({ doc: openDoc({ status: 'reopening' }), session: session({ live: false }), userId: 'dev:amy' }).reason).toBe('offline');
    expect(editorView({ doc: openDoc({ status: 'error' }), session: session(), userId: 'dev:amy' }).reason).toBe('error');
  });

  it('the human edit lock: who shares it, and whether 「讓 agent 先改」 is offered (only to a holder)', () => {
    const shared: LockInfo = {
      kind: 'human',
      file: FILE,
      holders: [
        { userId: 'dev:amy', displayName: 'Amy', lastActivityAt: T0 },
        { userId: 'dev:bob', displayName: 'Bob', lastActivityAt: T0 },
      ],
      acquiredAt: T0,
    };
    const mine = editorView({ doc: openDoc({ lock: shared }), session: session(), userId: 'dev:amy' });
    expect(mine.readOnly).toBe(false);
    expect(mine.humanLock).toMatchObject({ iHold: true, others: ['Bob'] });
    const theirs = editorView({ doc: openDoc({ lock: shared }), session: session(), userId: 'dev:carol' });
    expect(theirs.humanLock).toMatchObject({ iHold: false, others: ['Amy', 'Bob'] });
    // Humans share the lock: another person's lock never makes the editor read-only.
    expect(theirs.readOnly).toBe(false);
  });

  it('the live lock (locks store) wins over the one doc.open returned', () => {
    const view = editorView({ doc: openDoc({ lock: makeAgentLock(FILE.path) }), session: session(), userId: 'dev:amy', lock: null });
    expect(view.readOnly).toBe(false);
  });
});

describe('autosave indicator (D13: no save button)', () => {
  it('idle → saving after a local edit → saved when doc.saved arrives; warns when nothing is confirmed for a while', () => {
    expect(saveIndicator(undefined, T0)).toEqual({ kind: 'idle' });
    expect(saveIndicator(session(), T0)).toEqual({ kind: 'idle' });
    const pending = session({ pendingSave: true, lastLocalEditAt: T0 });
    expect(saveIndicator(pending, T0 + 300)).toEqual({ kind: 'saving' });
    expect(saveIndicator(pending, T0 + SAVE_STALE_MS)).toEqual({ kind: 'stale' });
    expect(saveIndicator(session({ lastSavedAt: T0 + 500 }), T0 + 600)).toEqual({ kind: 'saved', at: T0 + 500 });
  });
});

describe('doc.rejected explanations', () => {
  it('names the agent for an agent lock and says the change was dropped otherwise', () => {
    expect(rejectionMessage('agent-locked', 'Claude（Ian）')).toContain('Claude（Ian）');
    expect(rejectionMessage('read-only', null)).toContain('唯讀');
    // REL-01: a file moved or deleted on disk: the unsaved text is in the conflict panel, NOT discarded.
    expect(rejectionMessage('file-unavailable', null)).toContain('衝突面板');
    expect(rejectionMessage('file-unavailable', null)).not.toContain('捨棄');
    expect(rejectionMessage('forbidden', null)).toContain('權限');
  });
});

describe('dropped replicas (REL-07)', () => {
  it('claims no loss when nothing was lost, says so when the text was sent again, and leaves recoveries to their own notice', () => {
    expect(droppedMessage({ reason: 'epoch', outcome: 'none' })).toBe('主人電腦重新載入了這個檔案，已同步最新內容。');
    expect(droppedMessage({ reason: 'epoch', outcome: 'restored' })).toContain('重新送出');
    expect(droppedMessage({ reason: 'diverged', outcome: 'restored' })).toContain('重新送出');
    expect(droppedMessage({ reason: 'epoch', outcome: 'recovery' })).toBeNull();
    expect(droppedMessage({ reason: 'epoch', outcome: 'checking' })).toBeNull();
    expect(droppedMessage({ reason: 'rejected', outcome: 'none' })).toBeNull();
  });
});

describe('files the editor refuses', () => {
  it('classifies by the structured error (code + detail.reason), never by message text, and offers the download', () => {
    expect(classifyOpenFailure({ code: 'too_large', reason: 'too-large' })).toBe('too-large');
    expect(classifyOpenFailure({ code: 'bad_request', reason: 'binary' })).toBe('binary');
    expect(classifyOpenFailure({ code: 'bad_request', reason: 'invalid-utf8' })).toBe('encoding');
    expect(classifyOpenFailure({ code: 'bad_request', reason: 'utf16-or-utf32-bom' })).toBe('encoding');
    expect(classifyOpenFailure({ code: 'bad_request', reason: 'not-a-file' })).toBe('not-a-file');
    expect(classifyOpenFailure({ code: 'not_found', reason: null })).toBe('not-found');
    expect(classifyOpenFailure(null)).toBe('other');
    for (const refusal of ['too-large', 'binary', 'encoding'] as const) expect(offersDownload(refusal)).toBe(true);
    expect(offersDownload('not-found')).toBe(false);
    expect(offersDownload('not-a-file')).toBe(false);
  });
});

describe('liveLockOf: the lock of an open document from the locks store', () => {
  const locksState = (status: LocksState['status'], locks: LockInfo[]): LocksState => ({
    status,
    error: null,
    locks: new Map(locks.map((lock) => [fileRefKey(lock.file), lock])),
  });

  it('undefined until lock.list answered (the view falls back to what doc.open reported), then the lock or null', () => {
    const agent = makeAgentLock('src/app.ts');
    expect(liveLockOf(locksState('loading', [agent]), FILE)).toBeUndefined();
    expect(liveLockOf(locksState('ready', [agent]), FILE)).toBe(agent);
    expect(liveLockOf(locksState('ready', []), FILE)).toBeNull();
  });

  it('matches a lock announced under another spelling of the same file (the daemon folds lock keys), never another root', () => {
    const upper: LockInfo = { ...makeAgentLock('SRC/App.ts'), file: { root: MAIN_ROOT, path: 'SRC/App.ts' } };
    expect(liveLockOf(locksState('ready', [upper]), FILE)).toBe(upper);
    const elsewhere: LockInfo = { ...makeAgentLock('src/app.ts'), file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'src/app.ts' } };
    expect(liveLockOf(locksState('ready', [elsewhere]), FILE)).toBeNull();
    // The live lock wins over the one doc.open reported.
    const view = editorView({ doc: openDoc({ lock: makeAgentLock('src/app.ts') }), session: session(), userId: 'dev:amy', lock: liveLockOf(locksState('ready', []), FILE) });
    expect(view.readOnly).toBe(false);
  });
});
