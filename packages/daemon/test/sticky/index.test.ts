// The index of the sticky notes (DESIGN 0.8.0 D1.3, D1.5, D2.2, D2.4): the real files module (its watcher on a real
// folder of this Linux disk) and the real sticky module; every member who may read files lists it and is told what
// changed, a Viewer included.
import { link, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, NOTES_MAX, NOTE_MAX_BYTES, collectPages, type NoteInfo } from '@smurg/protocol';
import { waitFor } from '../../src/testing/index.ts';
import { startNotes, type NotesStack } from './support.ts';

const notes = async (s: NotesStack): Promise<NoteInfo[]> => (await s.leo.conn.request('sticky.list', {})).notes;
const named = (s: NotesStack, name: string): NoteInfo | null => s.service.index.list().find((note) => note.name === name) ?? null;
const until = (what: string, predicate: () => boolean): Promise<void> => waitFor(predicate, { timeoutMs: 10_000, what });

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
});
