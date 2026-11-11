// The index of the sticky notes (DESIGN 0.8.0 D1.3, D1.5, D2.2, D2.4): the real files module (its watcher on a real
// folder of this Linux disk) and the real sticky module; every member who may read files lists it and is told what
// changed, a Viewer included.
import { chmod, link, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, NOTES_MAX, NOTE_MAX_BYTES, collectPages, type FileRef, type NoteInfo } from '@smurg/protocol';
import { PathDeniedError } from '../../src/core/errors.ts';
import type { ResolveOptions } from '../../src/core/interfaces.ts';
import { waitFor } from '../../src/testing/index.ts';
import { startNotes, type NotesStack } from './support.ts';

const notes = async (s: NotesStack): Promise<NoteInfo[]> => (await s.leo.conn.request('sticky.list', {})).notes;
const named = (s: NotesStack, name: string): NoteInfo | null => s.service.index.list().find((note) => note.name === name) ?? null;
const until = (what: string, predicate: () => boolean): Promise<void> => waitFor(predicate, { timeoutMs: 10_000, what });
/** An error of the operating system, as node:fs gives it. */
const osError = (code: string): Error => Object.assign(new Error(`${code}: the file system said no`), { code });
/** Each PathGuard call of `method` for `path` throws the next of `errors` (then it works again); the rest go through. */
function failing(s: NotesStack, method: 'resolve' | 'openRead', path: string, errors: Error[]): void {
  const paths = s.t.ctx.paths as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = (paths[method] as (...args: unknown[]) => Promise<unknown>).bind(s.t.ctx.paths);
  paths[method] = async (...args: unknown[]) => {
    const ref = method === 'resolve' ? (args[0] as FileRef) : (args[0] as { ref: FileRef }).ref;
    if (ref.path === path && errors.length > 0) throw errors.shift() as Error;
    return real(...(args as [never, ResolveOptions]));
  };
}

describe('the index of notes/ (D2.2)', { timeout: 60_000 }, () => {
  it('starts empty without notes/, reads nothing, and says so', async () => {
    const s = await startNotes({ files: { 'README.md': 'See [[Home]].\n' } });
    expect(await s.leo.conn.request('sticky.list', {})).toEqual({ notes: [], hasMore: false, truncated: false, sources: [] });
    expect(s.service.index.invalid()).toBe(0);
    expect(s.changes).toEqual([]);
  });

  it('starts with notes/: each note by its name, in order, with its links, and nothing else of its content', async () => {
    const s = await startNotes({
      files: {
        'notes/Home.md': '# Home\n\nStart with [[Checkout]], then [[Payment form]] and [[checkout]] again.\n',
        'notes/Checkout.md': 'Back to [[Home]]. `[[Not a link]]`\n',
        'notes/結帳流程.md': '',
      },
    });
    expect(await notes(s)).toEqual([
      { name: 'Checkout', links: ['Home'] },
      { name: 'Home', links: ['Checkout', 'Payment form'] },
      { name: '結帳流程', links: [] },
    ]);
    expect(s.service.index.find('home')?.name).toBe('Home');
    // The start announces nothing: a member asks for the list.
    expect(s.changes).toEqual([]);
  });

  it('a new note, a change of its links, a save that changes no link (nothing is sent), a note that goes', async () => {
    const s = await startNotes({ files: { 'notes/Home.md': 'See [[Cart]].\n' } });
    await writeFile(join(s.root, 'notes', 'Cart.md'), 'Part of [[Home]].\n');
    await until('the new note', () => named(s, 'Cart') !== null);
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes).toEqual([{ upserted: [{ name: 'Cart', links: ['Home'] }], removed: [], truncated: false }]);

    // Its links change: the note is sent again, alone.
    await writeFile(join(s.root, 'notes', 'Cart.md'), 'Part of [[Home]]; see [[Stock]].\n');
    await until('the new link', () => named(s, 'Cart')?.links.length === 2);
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes.at(-1)).toEqual({ upserted: [{ name: 'Cart', links: ['Home', 'Stock'] }], removed: [], truncated: false });

    // Typing that changes no link: read again, and nobody is told anything.
    const sent = s.changes.length;
    const before = s.service.index.listings();
    await writeFile(join(s.root, 'notes', 'Cart.md'), 'Part of [[Home]] (the shop); see [[Stock]] soon.\n');
    await s.listed(before, 'the save to be read');
    expect(s.changes).toHaveLength(sent);

    // It goes: its name is sent as removed.
    await rm(join(s.root, 'notes', 'Cart.md'));
    await until('the note to go', () => named(s, 'Cart') === null);
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes.at(-1)).toEqual({ upserted: [], removed: ['Cart'], truncated: false });
    expect(await notes(s)).toEqual([{ name: 'Home', links: ['Cart'] }]);
  });

  it('notes/ made in one burst with its files is listed again whole (the watcher misses files of a new folder on Linux)', async () => {
    const s = await startNotes();
    await mkdir(join(s.root, 'notes'));
    await Promise.all([writeFile(join(s.root, 'notes', 'Home.md'), '[[A]]\n'), writeFile(join(s.root, 'notes', 'A.md'), '[[Home]]\n')]);
    await until('both notes', () => s.service.index.list().length === 2);
    expect(await notes(s)).toEqual([
      { name: 'A', links: ['Home'] },
      { name: 'Home', links: ['A'] },
    ]);
    // notes/ goes as a whole: every note goes with it.
    await rm(join(s.root, 'notes'), { recursive: true });
    await until('the notes to go', () => s.service.index.list().length === 0);
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes.at(-1)).toMatchObject({ upserted: [], truncated: false });
    expect([...(s.changes.at(-1)?.removed ?? [])].sort()).toEqual(['A', 'Home']);
  });

  it(`a note over ${NOTE_MAX_BYTES} bytes is oversized and not read; one of exactly that size is read`, async () => {
    const at = `[[Home]]${'x'.repeat(NOTE_MAX_BYTES - 8)}`;
    const s = await startNotes({ files: { 'notes/Big.md': `${at}y`, 'notes/Exact.md': at } });
    expect(await notes(s)).toEqual([
      { name: 'Big', links: [], oversized: true },
      { name: 'Exact', links: ['Home'] },
    ]);
  });

  it('a note that is not UTF-8 is unreadable, with no links', async () => {
    const s = await startNotes({ files: { 'notes/Broken.md': new Uint8Array([0x5b, 0x5b, 0x41, 0x5d, 0x5d, 0xff, 0xfe, 0x0a]) } });
    expect(await notes(s)).toEqual([{ name: 'Broken', links: [], unreadable: true }]);
  });

  it('a symlink and a hard link to .envrc are read as a member without rights reads them: unreadable, with no links', async () => {
    const s = await startNotes({
      files: { '.envrc': 'export TOKEN=1 # [[Secret]]\n', 'notes/Home.md': '[[Linked]] [[Hard]]\n' },
      prepare: async (root) => {
        await symlink('../.envrc', join(root, 'notes', 'Linked.md'));
        await link(join(root, '.envrc'), join(root, 'notes', 'Hard.md'));
      },
    });
    expect(await notes(s)).toEqual([
      { name: 'Hard', links: [], unreadable: true },
      { name: 'Home', links: ['Linked', 'Hard'] },
      { name: 'Linked', links: [], unreadable: true },
    ]);
    // Nothing of what they lead to went anywhere: the index holds only names and flags.
    expect(JSON.stringify(s.service.index.list())).not.toContain('Secret');
    // Nothing was audited for what the index was refused: it is nobody.
    const { entries } = await s.host.conn.request('admin.audit.query', {});
    expect(entries.filter((entry) => entry.action === 'path.denied')).toEqual([]);
  });

  it('notes that is a symlink counts as no folder: nothing is listed, nothing read', async () => {
    const s = await startNotes({
      files: { 'src/Home.md': '[[Src]]\n' },
      prepare: async (root) => {
        await symlink('src', join(root, 'notes'));
      },
    });
    expect(await notes(s)).toEqual([]);
    // Made a real folder again: listed.
    await rm(join(s.root, 'notes'));
    await mkdir(join(s.root, 'notes'));
    await writeFile(join(s.root, 'notes', 'Home.md'), '[[A]]\n');
    await until('the real folder', () => named(s, 'Home') !== null);
  });

  it('Home and home on this Linux disk: the first by code unit is the note, the other shadowed and not read; links reach the note', async () => {
    const s = await startNotes({ files: { 'notes/Home.md': '[[A]]\n', 'notes/home.md': '[[B]]\n' } });
    expect(await notes(s)).toEqual([
      { name: 'Home', links: ['A'] },
      { name: 'home', links: [], shadowed: true },
    ]);
    expect(s.service.index.find('HOME')?.name).toBe('Home');
    // The note goes: its twin is the note now, and is read.
    await rm(join(s.root, 'notes', 'Home.md'));
    await until('home to be the note', () => named(s, 'home')?.shadowed === undefined && named(s, 'Home') === null);
    expect(named(s, 'home')).toEqual({ name: 'home', links: ['B'] });
  });

  it(`at most ${NOTES_MAX} notes, the first by name: the ${NOTES_MAX + 1}st is not listed, and the index says it is truncated`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= NOTES_MAX; i++) files[`notes/Note ${String(i).padStart(3, '0')}.md`] = `[[Note ${String(i + 1).padStart(3, '0')}]]\n`;
    const s = await startNotes({ files });
    const page = await s.leo.conn.request('sticky.list', {});
    expect(page.truncated).toBe(true);
    const all = await collectPages(async (after) => {
      const next = await s.leo.conn.request('sticky.list', after === undefined ? {} : { after });
      return { items: next.notes, hasMore: next.hasMore };
    }, (note) => note.name);
    expect(all).toHaveLength(NOTES_MAX);
    expect(all.at(-1)?.name).toBe(`Note ${NOTES_MAX - 1}`);
    expect(all.some((note) => note.name === `Note ${NOTES_MAX}`)).toBe(false);
    // The pages go on after the name a member gives (500 small notes fit one page, so collectPages asked once).
    expect(await s.leo.conn.request('sticky.list', { after: `Note ${NOTES_MAX - 2}` })).toEqual({
      notes: [{ name: `Note ${NOTES_MAX - 1}`, links: [`Note ${NOTES_MAX}`] }],
      hasMore: false,
      truncated: true,
      sources: [],
    });
    expect((await s.leo.conn.request('sticky.list', { after: `Note ${NOTES_MAX - 1}` })).notes).toEqual([]);
    // One goes: the last one is listed now, and the index is no longer truncated.
    await rm(join(s.root, 'notes', 'Note 000.md'));
    await until('the index to be whole', () => !s.service.index.truncated());
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes.at(-1)).toEqual({ upserted: [{ name: `Note ${NOTES_MAX}`, links: [`Note ${NOTES_MAX + 1}`] }], removed: ['Note 000'], truncated: false });
  });

  it('a name that is no note is not listed, and is counted invalid', async () => {
    const s = await startNotes({
      files: {
        'notes/Home.md': '',
        'notes/x.txt': '[[A]]',
        'notes/x.MD': '[[A]]',
        'notes/CLAUDE.md': '[[A]]',
        'notes/a b .md': '[[A]]',
        'notes/a|b.md': '[[A]]',
        'notes/drafts/Deep.md': '[[A]]',
      },
    });
    expect(await notes(s)).toEqual([{ name: 'Home', links: [] }]);
    expect(s.service.index.invalid()).toBe(6);
    // A change below a folder of notes/ changes no note.
    const before = s.service.index.listings();
    await writeFile(join(s.root, 'notes', 'drafts', 'Deep.md'), '[[B]]');
    await writeFile(join(s.root, 'notes', 'Home.md'), '[[C]]\n');
    await s.listed(before, 'the change to be read');
    await until('the link', () => named(s, 'Home')?.links[0] === 'C');
  });

  it('after a watcher error everything is read again (a watcher that saw nothing: only the error reaches the index)', async () => {
    const s = await startNotes({ watch: false, files: { 'notes/Home.md': '[[A]]\n' } });
    await writeFile(join(s.root, 'notes', 'Home.md'), '[[B]]\n');
    await writeFile(join(s.root, 'notes', 'New.md'), '');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(named(s, 'Home')?.links).toEqual(['A']);
    s.t.ctx.bus.emit('file.watch-error', { root: MAIN_ROOT });
    await until('everything read again', () => named(s, 'Home')?.links[0] === 'B' && named(s, 'New') !== null);
    // A save of the editor reaches it too (the docs module's doc.saved).
    await writeFile(join(s.root, 'notes', 'New.md'), '[[Home]]\n');
    s.t.ctx.bus.emit('doc.saved', { file: { root: MAIN_ROOT, path: 'notes/New.md' }, docId: 'doc_1', hash: 'a'.repeat(64), at: 1 });
    await until('the saved note', () => named(s, 'New')?.links[0] === 'Home');
    // A rename on disk is a note that goes and one that comes.
    await rename(join(s.root, 'notes', 'New.md'), join(s.root, 'notes', 'Newer.md'));
    s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes/New.md', change: 'unlink' }, { path: 'notes/Newer.md', change: 'add' }] });
    await until('the rename', () => named(s, 'Newer') !== null && named(s, 'New') === null);
  });

  it('a listing of notes/ that fails (EACCES) keeps the index as it was, tells nobody anything, and is tried again until it goes through', async () => {
    const s = await startNotes({ watch: false, files: { 'notes/Home.md': '[[A]]\n', 'notes/A.md': '' } });
    const before = await notes(s);
    // A change the next listing reads: the only one, since no watcher reports anything after it.
    await writeFile(join(s.root, 'notes', 'A.md'), '[[Home]]\n');
    await chmod(join(s.root, 'notes'), 0o000);
    try {
      s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes/A.md', change: 'change' }] });
      await until('the listing to fail', () => s.logs.some((line) => line.message === 'sticky notes not listed'));
      expect(await notes(s)).toEqual(before);
      expect(s.changes).toEqual([]);
    } finally {
      await chmod(join(s.root, 'notes'), 0o755);
    }
    // Nothing on disk is reported again: the index tries again by itself.
    await until('the listing to be tried again', () => named(s, 'A')?.links[0] === 'Home');
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes).toEqual([{ upserted: [{ name: 'A', links: ['Home'] }], removed: [], truncated: false }]);
  });

  it('a look at notes/ that fails for a passing reason (an I/O error) is no missing folder: nothing goes, and it is tried again', async () => {
    const s = await startNotes({ watch: false, files: { 'notes/Home.md': '[[A]]\n' } });
    await writeFile(join(s.root, 'notes', 'Home.md'), '[[B]]\n');
    failing(s, 'resolve', 'notes', [osError('EIO'), new PathDeniedError('changed', 'notes')]);
    s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes/Home.md', change: 'change' }] });
    await until('the change, after two failed looks', () => named(s, 'Home')?.links[0] === 'B');
    await s.leo.conn.request('sticky.list', {});
    expect(s.changes).toEqual([{ upserted: [{ name: 'Home', links: ['B'] }], removed: [], truncated: false }]);
    expect(s.logs.filter((line) => line.message === 'sticky notes not listed')).toHaveLength(2);
  });

  it('a read of a note that fails for a passing reason (too many open files, the file replaced while it is read) leaves the note as it was and reads it again; it is never unreadable for that', async () => {
    const s = await startNotes({ watch: false, files: { 'notes/Home.md': '[[A]]\n', 'notes/New.md': '[[Home]]\n' } });
    await writeFile(join(s.root, 'notes', 'Home.md'), '[[B]]\n');
    await writeFile(join(s.root, 'notes', 'Late.md'), '[[Home]]\n');
    failing(s, 'openRead', 'notes/Home.md', [osError('EMFILE'), new PathDeniedError('changed', 'notes/Home.md')]);
    s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes/Home.md', change: 'change' }, { path: 'notes/Late.md', change: 'add' }] });
    await until('the change, after two failed reads', () => named(s, 'Home')?.links[0] === 'B');
    await s.leo.conn.request('sticky.list', {});
    // The new note came at once; Home kept what it had until it was read.
    expect(s.changes).toEqual([
      { upserted: [{ name: 'Late', links: ['Home'] }], removed: [], truncated: false },
      { upserted: [{ name: 'Home', links: ['B'] }], removed: [], truncated: false },
    ]);
    expect(await notes(s)).toEqual([
      { name: 'Home', links: ['B'] },
      { name: 'Late', links: ['Home'] },
      { name: 'New', links: ['Home'] },
    ]);
  });

  it('a note that keeps failing to be read holds up no other change: that one is read after its quiet period, not after the next try\'s longer wait', async () => {
    const s = await startNotes({ watch: false, files: { 'notes/Home.md': '', 'notes/Bad.md': '' } });
    failing(s, 'openRead', 'notes/Bad.md', Array.from({ length: 1000 }, () => osError('EIO')));
    s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes/Bad.md', change: 'change' }] });
    const tries = (): number => s.logs.filter((line) => line.message === 'sticky notes not read; read again later').length;
    await waitFor(() => tries() >= 7, { timeoutMs: 20_000, what: 'seven tries, each later than the last' });
    await writeFile(join(s.root, 'notes', 'Good.md'), '[[Home]]\n');
    const at = performance.now();
    s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes/Good.md', change: 'add' }] });
    await until('the new note', () => named(s, 'Good') !== null);
    // The try after the seventh waits 30 ms × 2^7 (3.8 s); the change waits its 30 ms.
    expect(performance.now() - at).toBeLessThan(1_500);
    // Bad stays as it was read at the start.
    expect(named(s, 'Bad')).toEqual({ name: 'Bad', links: [] });
  });

  it('a note whose file mode keeps everyone from reading it is unreadable (that lasts until the file changes)', async () => {
    const s = await startNotes({
      files: { 'notes/Home.md': '[[Closed]]\n', 'notes/Closed.md': '[[Secret]]\n' },
      prepare: (root) => chmod(join(root, 'notes', 'Closed.md'), 0o000),
    });
    expect(await notes(s)).toEqual([
      { name: 'Closed', links: [], unreadable: true },
      { name: 'Home', links: ['Closed'] },
    ]);
    expect(s.logs.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([]);
  });
});
