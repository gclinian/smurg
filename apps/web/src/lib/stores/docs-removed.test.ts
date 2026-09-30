// Review WEB-01: open documents follow delete / rename of their file instead of silently accepting text nobody saves.
import { MAIN_ROOT, fileRefKey, type FileRef } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { T0, makeActivity, makeWelcome } from '../../testing/fixtures.ts';
import { createManualScheduler } from '../../testing/services.tsx';
import { isDocEditable, renamedFrom } from './docs.ts';
import { createWorkspaceStores } from './index.ts';

const OLD: FileRef = { root: MAIN_ROOT, path: 'src/todo 清單.md' };
const NEW_PATH = 'src/待辦清單.md';
const OTHER: FileRef = { root: MAIN_ROOT, path: 'README.md' };
const MEI = { kind: 'user', userId: 'dev:mei', displayName: '陳美玲' } as const;

const docIdOf = (ids: Map<string, string>, path: string): string => {
  if (!ids.has(path)) ids.set(path, `doc_${ids.size + 1}`);
  return ids.get(path) as string;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function setup() {
  const conn = new FakeConnection();
  const scheduler = createManualScheduler(T0);
  const { stores, dispose } = createWorkspaceStores(conn, { scheduler });
  const ids = new Map<string, string>();
  conn.handle('doc.open', ({ file }) => ({ docId: docIdOf(ids, file.path), epoch: 'epoch_1', canEdit: true, meta: { eol: 'LF', bom: false, mixedEol: false } }));
  conn.start();
  conn.admit(makeWelcome({ role: 'editor' }));
  await stores.docs.open(OTHER);
  await stores.docs.open(OLD);
  await flush();
  return { conn, stores, scheduler, dispose };
}

const docOf = (stores: Awaited<ReturnType<typeof setup>>['stores'], file: FileRef) => stores.docs.getState().docs.get(fileRefKey(file));

describe('docs store: open documents whose file is deleted or renamed (WEB-01)', () => {
  it('an unlink of the open file marks it removed (with who did it), stops it being editable and clears presence', async () => {
    const { conn, stores, dispose } = await setup();
    expect(stores.presence.getState().activeFile).toEqual(OLD);
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: OLD.path, change: 'unlink', by: MEI }] });
    const doc = docOf(stores, OLD);
    expect(doc?.removed).toEqual({ at: T0, by: MEI, movedTo: null });
    expect(isDocEditable(doc)).toBe(false);
    expect(stores.presence.getState().activeFile).toBeNull();
    expect(conn.notificationsOf('presence.update').at(-1)?.payload).toEqual({ activeFile: null });
    // Other open documents are untouched.
    expect(docOf(stores, OTHER)?.removed).toBeNull();
    dispose();
  });

  it('a folder above it going away counts too; the file coming back clears the mark', async () => {
    const { conn, stores, dispose } = await setup();
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'src', change: 'unlinkDir' }] });
    expect(docOf(stores, OLD)?.removed).toMatchObject({ by: null, movedTo: null });
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: OLD.path, change: 'add' }] });
    expect(docOf(stores, OLD)?.removed).toBeNull();
    expect(stores.presence.getState().activeFile).toEqual(OLD);
    // A delete-and-recreate in one batch (git checkout) never shows as removed.
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: OLD.path, change: 'unlink' }, { path: OLD.path, change: 'add' }] });
    expect(docOf(stores, OLD)?.removed).toBeNull();
    dispose();
  });

  it("someone else's rename is recognised from the activity feed, whether it arrives before or after the unlink", async () => {
    const { conn, stores, dispose } = await setup();
    const rename = makeActivity({ kind: 'file.rename', actor: MEI, file: { root: MAIN_ROOT, path: NEW_PATH }, summary: `重新命名 ${OLD.path} → ${NEW_PATH}` });
    conn.emit('activity.event', { event: rename });
    conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: OLD.path, change: 'unlink' }] });
    expect(docOf(stores, OLD)?.removed).toEqual({ at: T0, by: MEI, movedTo: NEW_PATH });

    const late = await setup();
    late.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'src', change: 'unlinkDir' }] });
    expect(docOf(late.stores, OLD)?.removed?.movedTo).toBeNull();
    late.conn.emit('activity.event', { event: makeActivity({ kind: 'file.rename', actor: MEI, file: { root: MAIN_ROOT, path: 'lib' }, summary: '重新命名 src → lib' }) });
    expect(docOf(late.stores, OLD)?.removed).toMatchObject({ by: MEI, movedTo: 'lib/todo 清單.md' });
    dispose();
    late.dispose();
  });

  it('renamedFrom only trusts the exact summary of the daemon', () => {
    const at = { root: MAIN_ROOT, path: 'b.md' };
    expect(renamedFrom(makeActivity({ kind: 'file.rename', file: at, summary: '重新命名 a.md → b.md' }))).toBe('a.md');
    expect(renamedFrom(makeActivity({ kind: 'file.rename', file: at, summary: '重新命名 a.md → c.md' }))).toBeNull();
    expect(renamedFrom(makeActivity({ kind: 'file.rename', file: at, summary: '重新命名 a…' }))).toBeNull();
    expect(renamedFrom(makeActivity({ kind: 'file.delete', file: at, summary: '重新命名 a.md → b.md' }))).toBeNull();
  });

  it('followRename (the local user renamed it) re-opens the new path in the same tab position and keeps it active', async () => {
    const { conn, stores, dispose } = await setup();
    await stores.docs.open({ root: MAIN_ROOT, path: 'z.md' }, { activate: false });
    expect(stores.docs.getState().order).toEqual([fileRefKey(OTHER), fileRefKey(OLD), fileRefKey({ root: MAIN_ROOT, path: 'z.md' })]);
    stores.docs.followRename(MAIN_ROOT, OLD.path, NEW_PATH);
    await flush();
    const renamed = fileRefKey({ root: MAIN_ROOT, path: NEW_PATH });
    expect(stores.docs.getState().order).toEqual([fileRefKey(OTHER), renamed, fileRefKey({ root: MAIN_ROOT, path: 'z.md' })]);
    expect(stores.docs.getState().activeKey).toBe(renamed);
    expect(stores.docs.getState().docs.get(renamed)?.status).toBe('open');
    expect(docOf(stores, OLD)).toBeUndefined();
    expect(conn.notificationsOf('doc.close').map((n) => n.payload.docId)).toEqual(['doc_2']);
    expect(stores.presence.getState().activeFile).toEqual({ root: MAIN_ROOT, path: NEW_PATH });
    dispose();
  });
});
