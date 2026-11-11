// A new sticky note (DESIGN 0.8.0 D1.2, D1.3, D2.5): `sticky.create` as the caller, through the real file service, in
// one serialization per workspace; the folder notes/ is made when it is missing; the index has the note at once.
import { lstat, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTE_NAME_MAX_CHARS, type SmurgError } from '@smurg/protocol';
import { AMY, startNotes } from './support.ts';

const refused = (promise: Promise<unknown>): Promise<SmurgError> => promise.then(
  () => {
    throw new Error('the request was not refused');
  },
  (err: unknown) => err as SmurgError,
);

describe('sticky.create (D2.5)', { timeout: 60_000 }, () => {
  it('an Editor makes the first note with notes/ missing: the folder and an empty file, the note in the index at once, every member told', async () => {
    const s = await startNotes();
    const { note } = await s.amy.conn.request('sticky.create', { name: 'Payment form' });
    expect(note).toEqual({ name: 'Payment form', links: [] });
    expect((await lstat(join(s.root, 'notes'))).isDirectory()).toBe(true);
    expect(await readFile(join(s.root, 'notes', 'Payment form.md'), 'utf8')).toBe('');
    // Told at once, before the watcher's own report (which then changes nothing).
    expect(s.changes).toEqual([{ upserted: [{ name: 'Payment form', links: [] }], removed: [], truncated: false }]);
    expect((await s.leo.conn.request('sticky.list', {})).notes).toEqual([{ name: 'Payment form', links: [] }]);
    // A second one goes into the folder that is there now.
    await s.mei.conn.request('sticky.create', { name: 'Home' });
    expect((await readdir(join(s.root, 'notes'))).sort()).toEqual(['Home.md', 'Payment form.md']);
  });

  it('the audit log and the activity feed name the person, for the folder and for the note', async () => {
    const s = await startNotes();
    await s.amy.conn.request('sticky.create', { name: 'Home' });
    const { entries } = await s.host.conn.request('admin.audit.query', {});
    const creates = entries.filter((entry) => entry.action === 'file.create');
    expect(creates.map((entry) => [entry.target, entry.actor, entry.detail])).toEqual(
      expect.arrayContaining([
        ['main:notes', { kind: 'user', userId: AMY, displayName: 'Amy' }, { kind: 'dir' }],
        ['main:notes/Home.md', { kind: 'user', userId: AMY, displayName: 'Amy' }, { kind: 'file' }],
      ]),
    );
    const { events } = await s.leo.conn.request('activity.list', {});
    expect(events.filter((event) => event.kind === 'file.create' && event.file?.path === 'notes/Home.md').map((event) => event.actor)).toEqual([{ kind: 'user', userId: AMY, displayName: 'Amy' }]);
  });

  it('a name that exists is refused, and so is one that folds equal (Home, home), against a fresh listing', async () => {
    const s = await startNotes({ files: { 'notes/Home.md': 'Hello\n' } });
    for (const name of ['Home', 'home', 'HOME']) {
      const error = await refused(s.amy.conn.request('sticky.create', { name }));
      expect(error).toMatchObject({ code: 'conflict', detail: { reason: 'exists' }, text: { id: 'sticky.create.exists', params: { name: 'Home' } } });
    }
    expect(await readFile(join(s.root, 'notes', 'Home.md'), 'utf8')).toBe('Hello\n');
    // A file the index has not seen yet (the watcher is slower than this request): the fresh listing finds it.
    await writeFile(join(s.root, 'notes', 'cart.md'), 'x');
    expect(await refused(s.amy.conn.request('sticky.create', { name: 'Cart' }))).toMatchObject({ code: 'conflict', text: { id: 'sticky.create.exists', params: { name: 'cart' } } });
    expect((await readdir(join(s.root, 'notes'))).sort()).toEqual(['Home.md', 'cart.md']);
  });

  it.each([
    ['', 'empty'],
    ['x'.repeat(NOTE_NAME_MAX_CHARS + 1), 'too-long'],
    ['a/b', 'markup'],
    ['[[x', 'markup'],
    ['a|b', 'markup'],
    ['Tab\there', 'white-space'],
    ['X Y', 'white-space'],
    ['Ho​me', 'unseen'],
    ['Café', 'not-nfc'],
    ['..', 'dot-name'],
    [' Home', 'edge'],
    ['Home.', 'edge'],
    ['CLAUDE', 'host-only'],
    ['claude.local', 'host-only'],
  ])('%j is refused (%s), and nothing is written, not even notes/', async (name, problem) => {
    const s = await startNotes();
    const error = await refused(s.amy.conn.request('sticky.create', { name }));
    expect(error).toMatchObject({ code: 'bad_request', detail: { reason: 'invalid-name', problem }, text: { id: 'sticky.name.invalid' } });
    await expect(lstat(join(s.root, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(s.changes).toEqual([]);
  });

  it('two creates at once: of one name, one is made and one refused; of two names that fold equal, the same', async () => {
    const s = await startNotes();
    const same = await Promise.allSettled([s.amy.conn.request('sticky.create', { name: 'Cart' }), s.mei.conn.request('sticky.create', { name: 'Cart' })]);
    expect(same.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const twins = await Promise.allSettled([s.amy.conn.request('sticky.create', { name: 'Stock' }), s.mei.conn.request('sticky.create', { name: 'stock' })]);
    expect(twins.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    // Whichever came first is the note; the other is refused with its name.
    const made = (twins.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{ note: { name: string } }>).value.note.name;
    expect((twins.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict', text: { id: 'sticky.create.exists', params: { name: made } } });
    expect((await readdir(join(s.root, 'notes'))).sort()).toEqual(['Cart.md', `${made}.md`]);
    expect(s.service.index.list().map((note) => note.name)).toEqual(['Cart', made]);
  });

  it('a Viewer may not; a notes that is a file or a symlink is no folder to write into', async () => {
    const s = await startNotes({ files: { notes: 'a file\n' } });
    expect(await refused(s.leo.conn.request('sticky.create', { name: 'Home' }))).toMatchObject({ code: 'forbidden' });
    expect(await refused(s.amy.conn.request('sticky.create', { name: 'Home' }))).toMatchObject({ code: 'conflict', text: { id: 'file.notADirectory' } });
    expect(await readFile(join(s.root, 'notes'), 'utf8')).toBe('a file\n');

    const linked = await startNotes({ files: { 'src/app.ts': '' }, prepare: (root) => symlink('src', join(root, 'notes')) });
    expect(await refused(linked.amy.conn.request('sticky.create', { name: 'Home' }))).toMatchObject({ code: 'conflict', text: { id: 'file.notADirectory' } });
    expect(await readdir(join(linked.root, 'src'))).toEqual(['app.ts']);
  });
});
