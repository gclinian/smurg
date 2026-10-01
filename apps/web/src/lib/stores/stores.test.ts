import { MAIN_ROOT, SmurgError, fileRefKey } from '@smurg/protocol';
import type { InteractiveRequestType } from '@smurg/protocol/client';
import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import {
  T0,
  fileRef,
  makeActivity,
  makeAgentLock,
  makeConflict,
  makeEntry,
  makeHumanLock,
  makeMember,
  makeMergeRequest,
  makeSession,
  makeSuggestion,
  makeWelcome,
  makeWorktree,
  presenceOf,
} from '../../testing/fixtures.ts';
import { createManualScheduler } from '../../testing/services.tsx';
import { createWorkspaceStores } from './index.ts';
import { FILE_REFRESH_DELAY_MS, selectDir, selectEntry } from './files.ts';
import { isDocEditable, selectActiveDoc } from './docs.ts';
import { selectPendingForOwner } from './suggestions.ts';

/** Requests every non-admin store sends on a fresh channel. */
const BASE_LOADS: readonly InteractiveRequestType[] = [
  'file.tree',
  'lock.list',
  'session.list',
  'suggest.list',
  'activity.list',
  'doc.conflict.list',
  'worktree.list',
  'worktree.merge.list',
];
const ADMIN_LOADS: readonly InteractiveRequestType[] = ['admin.member.list', 'admin.invite.list', 'admin.settings.get', 'admin.audit.query'];

type WelcomeOptions = NonNullable<Parameters<typeof makeWelcome>[0]>;

function setup(base: WelcomeOptions = {}) {
  const conn = new FakeConnection();
  const scheduler = createManualScheduler(T0);
  const { stores, dispose } = createWorkspaceStores(conn, { scheduler });
  conn.start();
  const admit = (options: { resumed?: boolean; role?: WelcomeOptions['role']; channelId?: string } = {}) =>
    conn.admit(makeWelcome({ ...base, ...(options.role ? { role: options.role } : {}), ...(options.channelId ? { channelId: options.channelId } : {}) }), {
      resumed: options.resumed ?? false,
    });
  return { conn, stores, dispose, scheduler, admit };
}

/** Answers every pending initial load with an empty snapshot. */
function answerEmpty(conn: FakeConnection): void {
  const answers: Partial<Record<InteractiveRequestType, unknown>> = {
    'file.tree': { entries: [], truncated: false },
    'lock.list': { locks: [] },
    'session.list': { sessions: [] },
    'suggest.list': { suggestions: [] },
    'activity.list': { events: [] },
    'doc.conflict.list': { conflicts: [] },
    'worktree.list': { worktrees: [] },
    'worktree.merge.list': { requests: [] },
    'admin.member.list': { members: [] },
    'admin.invite.list': { invites: [] },
    'admin.settings.get': {
      settings: { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [], diskReserveBytes: 0, diskReservePercent: 5 },
    },
    'admin.audit.query': { entries: [] },
  };
  for (const [type, result] of Object.entries(answers) as [InteractiveRequestType, never][]) {
    while (conn.pendingOf(type).length > 0) conn.respond(type, result);
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('workspace stores: initial load, live updates, full resync', () => {
  it('every store loads once on the first admission (resumed = false)', async () => {
    const { conn, stores, admit } = setup();
    admit();
    for (const type of BASE_LOADS) expect(conn.requestsOf(type), type).toHaveLength(1);
    for (const type of ADMIN_LOADS) expect(conn.requestsOf(type), type).toHaveLength(0);
    conn.respond('session.list', { sessions: [makeSession()] });
    conn.respond('file.tree', { entries: [makeEntry('README.md'), makeEntry('src', 'dir')], truncated: false });
    await flush();
    expect(stores.sessions.getState().status).toBe('ready');
    expect(stores.sessions.getState().sessions.get('sess_1')?.title).toBe('Claude');
    expect(selectDir(stores.files.getState(), MAIN_ROOT, '')?.entries.map((e) => e.path)).toEqual(['README.md', 'src']);
    expect(stores.workspace.getState()).toMatchObject({ generation: 1, resumed: false });
    expect(stores.workspace.getState().member?.role).toBe('editor');
  });

  it('a resumed admission reloads nothing: the daemon replays what was missed', async () => {
    const { conn, admit } = setup();
    admit();
    answerEmpty(conn);
    await flush();
    const before = conn.requests.length;
    conn.hostOffline('silence');
    admit({ resumed: true });
    expect(conn.requests.length).toBe(before);
  });

  it('a NON-resumed admission resets every store and reloads a fresh snapshot', async () => {
    const { conn, stores, admit } = setup();
    admit();
    conn.respond('session.list', { sessions: [makeSession({ id: 'old' })] });
    conn.respond('suggest.list', { suggestions: [makeSuggestion()] });
    conn.respond('lock.list', { locks: [makeHumanLock('a.txt')] });
    answerEmpty(conn);
    await flush();
    expect(stores.sessions.getState().sessions.has('old')).toBe(true);
    expect(stores.locks.getState().locks.size).toBe(1);

    conn.relayUnreachable();
    admit({ resumed: false, channelId: 'ch_2' });
    expect(stores.workspace.getState().generation).toBe(2);
    // Reset at once (nothing from the old logical channel survives) …
    expect(stores.sessions.getState().sessions.size).toBe(0);
    expect(stores.locks.getState().locks.size).toBe(0);
    expect(stores.suggestions.getState().suggestions.size).toBe(0);
    for (const type of BASE_LOADS) expect(conn.requestsOf(type), type).toHaveLength(2);
    // … and filled from the new snapshot.
    conn.respond('session.list', { sessions: [makeSession({ id: 'new' })] });
    await flush();
    expect([...stores.sessions.getState().sessions.keys()]).toEqual(['new']);
  });

  it('drops a snapshot that answers an older channel', async () => {
    const { conn, stores, admit } = setup();
    admit();
    const stale = conn.pendingOf('session.list')[0]!;
    // The reconnect happens while the first list is still in flight; the FakeConnection (like the SDK) fails the old
    // request with connection-lost, and even a late answer would be dropped by the generation check.
    admit({ resumed: false, channelId: 'ch_2' });
    expect(stale.status).toBe('rejected');
    conn.respond('session.list', { sessions: [makeSession({ id: 'fresh' })] });
    await flush();
    expect([...stores.sessions.getState().sessions.keys()]).toEqual(['fresh']);
  });

  it('live events update the stores', async () => {
    const { conn, stores, admit } = setup();
    admit();
    answerEmpty(conn);
    await flush();
    conn.emit('session.state', { session: makeSession({ id: 's2', status: 'exited' }) });
    conn.emit('suggest.updated', { suggestion: makeSuggestion({ id: 'x1' }) });
    conn.emit('lock.state', { file: fileRef('a.txt'), lock: makeAgentLock('a.txt') });
    conn.emit('activity.event', { event: makeActivity({ id: 'e2', at: T0 + 5 }) });
    conn.emit('doc.conflict', { conflict: makeConflict() });
    conn.emit('worktree.updated', { worktree: makeWorktree() });
    conn.emit('worktree.merge.updated', { request: makeMergeRequest() });
    conn.emit('presence.state', { members: [presenceOf(makeMember())], agents: [] });
    conn.emit('channel.settingsUpdated', { settings: { humanLockIdleMs: 10_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 1024 * 1024, sharedDirs: ['data'] } });
    expect(stores.sessions.getState().sessions.get('s2')?.status).toBe('exited');
    expect(stores.suggestions.getState().suggestions.has('x1')).toBe(true);
    expect(stores.locks.getState().locks.get(fileRefKey(fileRef('a.txt')))?.kind).toBe('agent');
    expect(stores.activity.getState().events[0]?.id).toBe('e2');
    expect(stores.conflicts.getState().conflicts.size).toBe(1);
    expect(stores.worktrees.getState().worktrees.size).toBe(1);
    expect(stores.worktrees.getState().mergeRequests.size).toBe(1);
    expect(stores.presence.getState()).toMatchObject({ received: true });
    expect(stores.workspace.getState().settings?.sharedDirs).toEqual(['data']);
    conn.emit('lock.state', { file: fileRef('a.txt'), lock: null });
    expect(stores.locks.getState().locks.size).toBe(0);
    conn.emit('worktree.removed', { worktreeId: 'wt_1' });
    expect(stores.worktrees.getState().worktrees.size).toBe(0);
  });

  it('a failed load is kept as a zh-TW error and reported', async () => {
    const { conn, stores, admit } = setup();
    admit();
    conn.fail('session.list', new SmurgError('internal', 'not implemented: sessions'));
    await flush();
    expect(stores.sessions.getState()).toMatchObject({ status: 'error', error: '主人端發生內部錯誤' });
    expect(stores.errors.getState().at(-1)).toMatchObject({ area: 'sessions', message: '主人端發生內部錯誤' });
  });

  it('files: file.changed re-lists the loaded parent directories once per burst', async () => {
    const { conn, stores, admit, scheduler } = setup();
    admit();
    conn.respond('file.tree', { entries: [makeEntry('src', 'dir')], truncated: false });
    await flush();
    void stores.files.loadDir(MAIN_ROOT, 'src');
    conn.respond('file.tree', { entries: [makeEntry('src/a.ts')], truncated: false });
    await flush();
    const before = conn.requestsOf('file.tree').length;
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'src/b.ts', change: 'add' }, { path: 'src/c.ts', change: 'add' }, { path: 'other/x', change: 'add' }] });
    expect(conn.requestsOf('file.tree').length).toBe(before); // coalesced, not yet
    scheduler.advance(FILE_REFRESH_DELAY_MS);
    const refreshed = conn.requestsOf('file.tree').slice(before);
    expect(refreshed.map((r) => r.payload.path)).toEqual(['src']);
    conn.respond('file.tree', { entries: [makeEntry('src/a.ts'), makeEntry('src/b.ts'), makeEntry('src/c.ts')], truncated: false });
    await flush();
    expect(selectEntry(stores.files.getState(), fileRef('src/b.ts'))?.name).toBe('b.ts');
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'src', change: 'unlinkDir' }] });
    expect(selectDir(stores.files.getState(), MAIN_ROOT, 'src')).toBeUndefined();
  });

  it('files: a change while the listing is in flight lists the directory again afterwards', async () => {
    const { conn, admit, scheduler } = setup();
    admit();
    expect(conn.requestsOf('file.tree')).toHaveLength(1);
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'new.txt', change: 'add' }] });
    scheduler.advance(FILE_REFRESH_DELAY_MS);
    expect(conn.requestsOf('file.tree')).toHaveLength(1); // joined the running request …
    conn.respond('file.tree', { entries: [], truncated: false });
    await flush();
    expect(conn.requestsOf('file.tree')).toHaveLength(2); // … and re-listed after it
  });

  it('files: hides editor temp files and falls back to the main root when a worktree disappears', async () => {
    const { conn, stores, admit } = setup();
    admit();
    conn.respond('file.tree', { entries: [makeEntry('a.ts'), makeEntry('a.ts.tmp.123.0123456789ab'), makeEntry('.a.ts.smurg-0123456789ab.tmp')], truncated: false });
    await flush();
    expect(selectDir(stores.files.getState(), MAIN_ROOT, '')?.entries.map((e) => e.name)).toEqual(['a.ts']);
    stores.files.setActiveRoot({ kind: 'worktree', worktreeId: 'wt_1' });
    expect(stores.files.getState().activeRoot).toEqual({ kind: 'worktree', worktreeId: 'wt_1' });
    conn.emit('worktree.removed', { worktreeId: 'wt_1' });
    expect(stores.files.getState().activeRoot).toEqual(MAIN_ROOT);
  });

  it('docs: buffers Yjs traffic until the editor binds, reopens after a resync with a new generation', async () => {
    const { conn, stores, admit } = setup();
    admit();
    answerEmpty(conn);
    await flush();
    const opening = stores.docs.open(fileRef('src/app.ts'));
    conn.respond('doc.open', { docId: 'd1', epoch: 'e1', canEdit: true, meta: { eol: 'LF', bom: false, mixedEol: false } });
    const doc = await opening;
    expect(doc).toMatchObject({ docId: 'd1', epoch: 'e1', status: 'open', generation: 1 });
    expect(conn.notificationsOf('presence.update').at(-1)?.payload).toEqual({ activeFile: fileRef('src/app.ts') });
    // Step 1 and the awareness snapshot arrive before the provider exists …
    conn.emit('doc.sync', { docId: 'd1', data: new Uint8Array([0, 1]) });
    conn.emit('doc.awareness', { docId: 'd1', data: new Uint8Array([7]) });
    const received: string[] = [];
    const off = stores.docs.onDocMessages('d1', {
      sync: (data) => received.push(`sync:${[...data].join(',')}`),
      awareness: (data) => received.push(`aw:${[...data].join(',')}`),
    });
    // … and are delivered in order on bind, then live.
    conn.emit('doc.sync', { docId: 'd1', data: new Uint8Array([0, 2]) });
    expect(received).toEqual(['sync:0,1', 'aw:7', 'sync:0,2']);
    stores.docs.sendSync('d1', new Uint8Array([0, 0, 1]));
    expect(conn.notificationsOf('doc.sync')).toHaveLength(1);
    off();

    // An agent lock makes it read-only everywhere; releasing it restores editing.
    expect(isDocEditable(selectActiveDoc(stores.docs.getState()))).toBe(true);
    conn.emit('lock.state', { file: fileRef('src/app.ts'), lock: makeAgentLock('src/app.ts') });
    expect(isDocEditable(selectActiveDoc(stores.docs.getState()))).toBe(false);
    conn.emit('lock.state', { file: fileRef('src/app.ts'), lock: null });
    expect(isDocEditable(selectActiveDoc(stores.docs.getState()))).toBe(true);

    // Full resync: the tab stays, the doc is opened again and gets a new generation (the editor rebinds).
    admit({ resumed: false, channelId: 'ch_2' });
    expect(selectActiveDoc(stores.docs.getState())?.status).toBe('reopening');
    conn.respond('doc.open', { docId: 'd2', epoch: 'e2', canEdit: true, meta: { eol: 'LF', bom: false, mixedEol: false } });
    await flush();
    expect(selectActiveDoc(stores.docs.getState())).toMatchObject({ docId: 'd2', epoch: 'e2', generation: 2, status: 'open' });
    conn.emit('doc.reset', { docId: 'd2', epoch: 'e3' });
    expect(selectActiveDoc(stores.docs.getState())).toMatchObject({ epoch: 'e3', generation: 3 });
    stores.docs.close(doc.key);
    expect(conn.notificationsOf('doc.close').at(-1)?.payload).toEqual({ docId: 'd2' });
    expect(stores.docs.getState().docs.size).toBe(0);
  });

  it('admin: loaded only for the host, dropped when the role is lost', async () => {
    const host = setup({ role: 'host' });
    host.admit();
    for (const type of ADMIN_LOADS) expect(host.conn.requestsOf(type), type).toHaveLength(1);
    answerEmpty(host.conn);
    await flush();
    expect(host.stores.admin.getState()).toMatchObject({ enabled: true, status: 'ready' });
    host.conn.emit('admin.audit.entry', {
      entry: { id: 'au1', at: T0, actor: { kind: 'system' }, action: 'auth.connect', outcome: 'ok' },
    });
    expect(host.stores.admin.getState().audit).toHaveLength(1);

    // A single-use invite was used: the table follows without a reload (WEB-05); bursts are coalesced.
    expect(host.conn.requestsOf('admin.invite.list')).toHaveLength(1);
    host.conn.handle('admin.invite.list', () => ({ invites: [{ id: 'inv_1', role: 'editor', createdAt: T0, maxUses: 1, uses: 1, revoked: false }] }));
    for (const id of ['au2', 'au3']) {
      host.conn.emit('admin.audit.entry', { entry: { id, at: T0 + 1, actor: { kind: 'system' }, action: 'auth.join', target: 'inv_1', outcome: 'ok' } });
    }
    host.scheduler.advance(1_000);
    await flush();
    expect(host.conn.requestsOf('admin.invite.list')).toHaveLength(2);
    expect(host.stores.admin.getState().invites).toMatchObject([{ id: 'inv_1', uses: 1 }]);

    const guest = setup({ role: 'editor' });
    guest.admit();
    for (const type of ADMIN_LOADS) expect(guest.conn.requestsOf(type), type).toHaveLength(0);
    expect(guest.stores.admin.getState().enabled).toBe(false);
  });

  it('role change on a resumed channel is applied to the stores (and reported once)', async () => {
    const { conn, stores, admit } = setup();
    admit({ role: 'editor' });
    answerEmpty(conn);
    await flush();
    conn.setState({ kind: 'connecting', attempt: 1, retryAt: 0, cause: 'role-changed' });
    admit({ resumed: true, role: 'viewer' });
    expect(stores.workspace.getState().roleChange).toMatchObject({ from: 'editor', to: 'viewer' });
    expect(stores.workspace.getState().generation).toBe(1);
  });

  it('suggestions: the owner sees what waits for them', async () => {
    const { conn, stores, admit } = setup({ role: 'host' });
    admit();
    conn.respond('session.list', { sessions: [makeSession({ id: 'mine', ownerUserId: 'dev:host' }), makeSession({ id: 'theirs', ownerUserId: 'dev:bob' })] });
    conn.respond('suggest.list', {
      suggestions: [makeSuggestion({ id: 'a', sessionId: 'mine' }), makeSuggestion({ id: 'b', sessionId: 'theirs' }), makeSuggestion({ id: 'c', sessionId: 'mine', status: 'accepted' })],
    });
    await flush();
    const pending = selectPendingForOwner(stores.suggestions.getState(), stores.sessions.getState().sessions, 'dev:host');
    expect(pending.map((s) => s.id)).toEqual(['a']);
    const accepting = stores.suggestions.accept('a', '改過的內容');
    expect(conn.lastRequest('suggest.accept')?.payload).toEqual({ suggestionId: 'a', text: '改過的內容' });
    conn.respond('suggest.accept', { suggestion: makeSuggestion({ id: 'a', sessionId: 'mine', status: 'accepted-modified', finalText: '改過的內容' }) });
    await accepting;
    expect(stores.suggestions.getState().suggestions.get('a')?.status).toBe('accepted-modified');
  });

  it('sessions: terminal output and resizes reach the viewer of that session, in order', async () => {
    const { conn, stores, admit } = setup();
    admit();
    const got: string[] = [];
    const off = stores.sessions.stream('s1', {
      output: (chunk) => got.push(`out@${chunk.offset}`),
      resize: (size) => got.push(`resize ${size.cols}x${size.rows}`),
    });
    conn.emit('exec.output', { sessionId: 's1', offset: 0, data: new Uint8Array([65]) });
    conn.emit('exec.resize', { sessionId: 's1', cols: 100, rows: 30 });
    conn.emit('exec.output', { sessionId: 's1', offset: 1, data: new Uint8Array([66]) });
    conn.emit('exec.output', { sessionId: 'other', offset: 0, data: new Uint8Array([67]) });
    expect(got).toEqual(['out@0', 'resize 100x30', 'out@1']);
    off();
    conn.emit('exec.output', { sessionId: 's1', offset: 2, data: new Uint8Array([68]) });
    expect(got).toHaveLength(3);
    stores.sessions.input('s1', new Uint8Array([13]));
    expect(conn.notificationsOf('exec.input')).toHaveLength(1);
  });

  it('presence: the active file is re-sent after a full resync', async () => {
    const { conn, stores, admit } = setup();
    admit();
    stores.presence.setActiveFile(fileRef('README.md'));
    expect(conn.notificationsOf('presence.update')).toHaveLength(1);
    stores.presence.setActiveFile(fileRef('README.md'));
    expect(conn.notificationsOf('presence.update')).toHaveLength(1);
    admit({ resumed: false, channelId: 'ch_2' });
    expect(conn.notificationsOf('presence.update')).toHaveLength(2);
    expect(stores.presence.getState().members.map((m) => m.userId)).toEqual(['dev:amy']);
  });

  it('dispose() detaches every listener', () => {
    const { conn, dispose } = setup();
    expect(conn.listenerCount('session.state')).toBe(1);
    dispose();
    expect(conn.listenerCount('session.state')).toBe(0);
    expect(conn.listenerCount('file.changed')).toBe(0);
  });
});

describe('workspace stores: a daemon without a feature module', () => {
  it('shows "not supported yet" in the store and does not raise a toast', async () => {
    const conn = new FakeConnection();
    const { stores } = createWorkspaceStores(conn);
    conn.start();
    conn.admit(makeWelcome());
    conn.fail('worktree.list', new SmurgError('internal', 'not implemented: worktree.list', { reason: 'not-implemented', service: 'worktree.list' }));
    await flush();
    expect(stores.worktrees.getState()).toMatchObject({ status: 'error', error: '主人電腦上的 smurg 還不支援這項功能。' });
    expect(stores.errors.getState()).toEqual([]);
  });
});

describe('docs: Yjs traffic that overtakes the doc.open answer', () => {
  it('keeps sync step 1 that arrives before the docId is recorded, and drops strays after a while', async () => {
    const conn = new FakeConnection();
    const scheduler = createManualScheduler(T0);
    const { stores } = createWorkspaceStores(conn, { scheduler });
    conn.start();
    conn.admit(makeWelcome());
    const opening = stores.docs.open(fileRef('a.md'));
    // The answer is resolved, but its continuation has not run yet when step 1 is dispatched.
    conn.respond('doc.open', { docId: 'd9', epoch: 'e9', canEdit: true, meta: { eol: 'LF', bom: false, mixedEol: false } });
    conn.emit('doc.sync', { docId: 'd9', data: new Uint8Array([0, 9]) });
    conn.emit('doc.sync', { docId: 'stray', data: new Uint8Array([1]) });
    await opening;
    const got: number[][] = [];
    stores.docs.onDocMessages('d9', { sync: (data) => got.push([...data]), awareness: () => {} });
    expect(got).toEqual([[0, 9]]);
    scheduler.advance(11_000);
    conn.emit('doc.sync', { docId: 'another', data: new Uint8Array([2]) }); // prunes old strays
    const stray: number[][] = [];
    stores.docs.onDocMessages('stray', { sync: (data) => stray.push([...data]), awareness: () => {} });
    expect(stray).toEqual([]);
  });
});
