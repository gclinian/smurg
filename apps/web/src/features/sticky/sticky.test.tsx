// The sticky notes (DESIGN 0.8.0 D7.3-D7.6): the list of notes grown from Home, the open note read as Markdown with
// its wiki links, the pages without a note, the lock line, and the index in the store; and the edit half (D7.5): Edit
// with the shared editor, "Add a sticky note", "Ask Claude about this sticky note".
import { NOTES_MAX, SmurgError, noteTree, type NoteInfo } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectNoteTree } from '../../lib/stores/sticky.ts';
import { makeAgentLock, makeHumanLock, makeWelcome } from '../../testing/fixtures.ts';
import { setupStores } from '../../testing/stores.ts';
import { DOCUMENT_TEXT_INTERVAL_MS } from '../editor/standalone.tsx';
import { HOME_KEY, ancestorsOf, homeRows, linkLineAfter, noteKey, notLinkedRows } from './model.ts';
import { NOTES, notePath, openNotes } from './test-support.tsx';

const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
});

async function shown(options: Parameters<typeof openNotes>[0] = {}) {
  const view = openNotes(options);
  disposers.push(() => view.session.dispose());
  await view.settle();
  return view;
}

const list = (): HTMLElement => screen.getByRole('complementary', { name: 'All sticky notes' });
const note = (): HTMLElement => screen.getByRole('main', { name: 'Open sticky note' });
const rows = (name: string): (string | null)[][] =>
  within(within(list()).getByRole('tree', { name })).getAllByRole('treeitem').map((row) => [row.getAttribute('aria-label'), row.getAttribute('aria-level'), row.getAttribute('aria-expanded')]);
const row = (name: string): HTMLElement => within(list()).getByRole('treeitem', { name });

describe('the list of sticky notes (D7.4)', () => {
  it('Home first, each note under the note that reached it first, in link order; the notes Home does not reach under "Not linked", by name', async () => {
    await shown();
    expect(rows('Sticky notes from Home')).toEqual([
      ['Home', '1', 'true'],
      ['Checkout', '2', 'false'],
      ['Ideas', '2', null],
    ]);
    // Checkout is folded: its note below shows when it unfolds (its twisty only folds).
    await userEvent.click(row('Checkout').querySelector('[data-tree-twisty]') as HTMLElement);
    expect(rows('Sticky notes from Home')).toEqual([
      ['Home', '1', 'true'],
      ['Checkout', '2', 'true'],
      ['Payment form', '3', null],
      ['Ideas', '2', null],
    ]);
    expect(within(list()).getByRole('heading', { level: 2, name: 'Not linked' }).getAttribute('title')).toBe('No sticky note links to these from Home.');
    expect(rows('Not linked')).toEqual([
      ['Apple', '1', null],
      ['Zebra', '1', null],
    ]);
    // Home's row is the open note's.
    expect(row('Home').getAttribute('aria-selected')).toBe('true');
    // No control inside a row: a row is one tab stop.
    expect(list().querySelectorAll('[role="tree"] button, [role="tree"] a, [role="tree"] input')).toHaveLength(0);
  });

  it('a row opens its note: Home, which has notes below, opens with a click and unfolds; the rows above an open note unfold', async () => {
    const view = await shown({ path: notePath('Payment form') });
    // The rows above Payment form unfolded by themselves, and its row is marked.
    expect(row('Checkout').getAttribute('aria-expanded')).toBe('true');
    expect(row('Payment form').getAttribute('aria-selected')).toBe('true');
    await userEvent.click(within(row('Home')).getByText('Home'));
    expect(view.path()).toBe(notePath('Home'));
    await view.settle();
    expect(within(note()).getByRole('heading', { level: 2, name: 'Home' })).toBeTruthy();
    // Enter on a row with notes below opens it too; the twisty folds it and opens nothing.
    row('Checkout').focus();
    await userEvent.keyboard('{Enter}');
    expect(view.path()).toBe(notePath('Checkout'));
    await userEvent.click(row('Checkout').querySelector('[data-tree-twisty]') as HTMLElement);
    expect(row('Checkout').getAttribute('aria-expanded')).toBe('false');
    expect(view.path()).toBe(notePath('Checkout'));
    // A note linked from nowhere opens from "Not linked".
    await userEvent.click(within(list()).getByText('Zebra'));
    expect(view.path()).toBe(notePath('Zebra'));
  });

  it('a row the person folded stays folded whatever else changes in the index; a way to the note unfolds the rows above it again', async () => {
    const view = await shown({ path: notePath('Payment form') });
    expect(row('Checkout').getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(row('Checkout').querySelector('[data-tree-twisty]') as HTMLElement);
    expect(row('Checkout').getAttribute('aria-expanded')).toBe('false');
    // Somebody changes the links of another note: the row the person folded stays folded (review S3-R3).
    act(() => view.conn.emit('sticky.changed', { upserted: [{ name: 'Zebra', links: ['Apple'] }], removed: [], truncated: false }));
    await view.settle();
    expect(row('Checkout').getAttribute('aria-expanded')).toBe('false');
    // Going to the note again (a link, an address) unfolds the rows above it.
    view.navigate(notePath('Home'));
    view.navigate(notePath('Payment form'));
    await view.settle();
    expect(row('Checkout').getAttribute('aria-expanded')).toBe('true');
  });

  it('a note that cannot be read, a fold twin, and the index cut at its limit are said in words', async () => {
    const notes: NoteInfo[] = [{ name: 'Home', links: ['Broken'] }, { name: 'Broken', links: [], unreadable: true }, { name: 'home', links: [], shadowed: true }];
    await shown({ notes, texts: { Home: '[[Broken]]' } });
    expect(row('Broken, cannot be read').closest('[role="tree"]')?.getAttribute('aria-label')).toBe('Sticky notes from Home');
    expect(rows('Not linked')).toEqual([['home, not read: Home has the same name', '1', null]]);
    expect(within(row('home, not read: Home has the same name')).getByText('same name as Home')).toBeTruthy();
    cleanup();
    await shown({ list: () => ({ notes: [...NOTES], hasMore: false, truncated: true, sources: [] }) });
    expect(within(list()).getByText(`Only the first ${NOTES_MAX} sticky notes are listed.`)).toBeTruthy();
  });

  it('the rows are pure: the tree of the index, the notes above a note', () => {
    const tree = noteTree(NOTES);
    const notes = new Map(NOTES.map((info) => [noteKey(info.name), info]));
    expect(homeRows(tree.home, notes).map((one) => [one.id, one.depth, one.children?.map((child) => child.name)])).toEqual([[HOME_KEY, 0, ['Checkout', 'Ideas']]]);
    expect(ancestorsOf(tree.home, 'Payment form')).toEqual([HOME_KEY, noteKey('Checkout')]);
    expect(ancestorsOf(tree.home, 'payment FORM')).toEqual([HOME_KEY, noteKey('Checkout')]);
    expect(ancestorsOf(tree.home, 'Home')).toEqual([]);
    expect(ancestorsOf(tree.home, 'Apple')).toEqual([]);
    expect(ancestorsOf(null, 'Home')).toEqual([]);
    expect(notLinkedRows([{ name: 'home', links: [], shadowed: true }], notes)).toEqual([{ id: 'shadowed:home', name: 'home', depth: 0, unreadable: false, twinOf: 'Home' }]);
  });
});

describe('the open sticky note (D7.5)', () => {
  it('is read as Markdown inside one sticky note: its name, its text, its links as <a href> to the notes\' pages', async () => {
    const view = await shown();
    const card = within(note()).getByRole('article', { name: 'Home' });
    expect(within(card).getByRole('heading', { level: 2, name: 'Home' })).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 3, name: 'Welcome' })).toBeTruthy();
    const checkout = within(card).getByRole('link', { name: 'Checkout' });
    expect(checkout.getAttribute('href')).toBe(notePath('Checkout'));
    expect(checkout.getAttribute('title')).toBe('Open the sticky note Checkout');
    // A link to a note not written yet is drawn apart and says so; a link in code is code.
    const refunds = card.querySelector('a.md-wiki--missing') as HTMLElement;
    expect(refunds.textContent).toBe('Refunds (not written yet)');
    expect(refunds.getAttribute('href')).toBe(notePath('Refunds'));
    expect(within(card).getByText('[[Not a link]]').tagName).toBe('CODE');
    // A plain click follows the link in the app; the address is the note's.
    await userEvent.click(checkout);
    expect(view.path()).toBe(notePath('Checkout'));
    await view.settle();
    // A link written in another case leads to the note on disk.
    expect(within(note()).getByRole('link', { name: 'home' }).getAttribute('href')).toBe(notePath('Home'));
    expect(within(note()).getByText('Pay with', { exact: false })).toBeTruthy();
  });

  it('only a note the index lists is held as a shared document; a quick switch from one note to the next opens and closes one document each', async () => {
    const view = await shown({ path: notePath('Home') });
    expect(view.opened()).toEqual(['notes/Home.md']);
    view.navigate(notePath('Checkout'));
    view.navigate(notePath('Ideas'));
    await view.settle();
    view.navigate(notePath('Payment form'));
    await view.settle();
    expect(view.opened()).toEqual(['notes/Home.md', 'notes/Checkout.md', 'notes/Ideas.md', 'notes/Payment form.md']);
    expect(view.held()).toEqual(['notes/Payment form.md']);
    expect(view.conn.notificationsOf('doc.close')).toHaveLength(3);
    // A name the index does not list asks the host for no file; nor does a note it could not read.
    view.navigate(notePath('Not here'));
    await view.settle();
    expect(view.opened()).toHaveLength(4);
    expect(view.held()).toEqual([]);
  });

  it('a note the index could not read is not asked for: the page says why', async () => {
    const view = await shown({ notes: [{ name: 'Home', links: [] }, { name: 'Broken', links: [], unreadable: true }], path: notePath('Broken') });
    expect(view.opened()).toEqual([]);
    // Only what is true of every note the index could not read: the file may be a plain text file the host keeps from
    // members, one nobody may read, or one whose first read failed for a moment (review S3-HON-1).
    expect(within(note()).getByText('smurg could not read the file of this sticky note.')).toBeTruthy();
  });

  it('a resumed channel asks for the index again and keeps what is on screen: the open note stays held, the list keeps its rows and its focus', async () => {
    const view = await shown({ path: notePath('Checkout') });
    const name = within(note()).getByRole('heading', { level: 2, name: 'Checkout' });
    const home = row('Home');
    act(() => home.focus());
    const asked = view.conn.requestsOf('sticky.list').length;
    act(() => view.conn.admit(makeWelcome({ role: 'editor' }), { resumed: true }));
    // While the answer is on its way, nothing goes away (review S3-R1).
    expect(within(note()).getByRole('heading', { level: 2, name: 'Checkout' })).toBe(name);
    expect(row('Home')).toBe(home);
    await view.settle();
    expect(view.conn.requestsOf('sticky.list')).toHaveLength(asked + 1);
    expect(within(note()).getByRole('heading', { level: 2, name: 'Checkout' })).toBe(name);
    expect(row('Home')).toBe(home);
    expect(document.activeElement).toBe(home);
    expect(view.opened()).toEqual(['notes/Checkout.md']);
    expect(view.conn.notificationsOf('doc.close')).toHaveLength(0);
    expect(view.held()).toEqual(['notes/Checkout.md']);
  });

  it('a spinner until the note\'s text is there, then the text; an empty note says it is empty; a large one says its links are not followed', async () => {
    const view = openNotes({ notes: [{ name: 'Home', links: [] }, { name: 'Big', links: [], oversized: true }], texts: { Home: '', Big: 'Large.' } });
    disposers.push(() => view.session.dispose());
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(note().textContent).toMatch(/Loading the sticky notes…|Opening the sticky note…/);
    await view.settle();
    expect(note().textContent).toContain('This sticky note is empty.');
    view.navigate(notePath('Big'));
    await view.settle();
    expect(note().textContent).toContain('Large.');
    expect(note().textContent).toContain('This sticky note is larger than 64 KiB: the list on the left does not follow its links.');
  });

  it('the address takes the name on disk: /notes/home shows Home and says Home', async () => {
    const view = await shown({ path: notePath('home') });
    expect(view.path()).toBe(notePath('Home'));
    expect(within(note()).getByRole('heading', { level: 2, name: 'Home' })).toBeTruthy();
    expect(view.opened()).toEqual(['notes/Home.md']);
  });

  it('one line says when Claude holds the note\'s lock, and goes when it lets go', async () => {
    const view = await shown();
    expect(within(note()).queryByRole('status')).toBeNull();
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
    expect(within(note()).getByRole('status').textContent).toBe('Claude is writing this sticky note.');
    // A member editing the note holds a person's lock: that is not Claude writing (review S3-T1).
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeHumanLock('notes/Home.md') }));
    expect(within(note()).queryByRole('status')).toBeNull();
    // Another note's lock says nothing here.
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: null }));
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Ideas.md' }, lock: makeAgentLock('notes/Ideas.md') }));
    expect(within(note()).queryByRole('status')).toBeNull();
  });
});

describe('the pages without a sticky note (D7.6)', () => {
  it('a link to a note not written yet leads to its page; "Write this sticky note" writes it, and the page becomes the note', async () => {
    const view = await shown();
    await userEvent.click(within(note()).getByRole('link', { name: /^Refunds/ }));
    expect(view.path()).toBe(notePath('Refunds'));
    await view.settle();
    expect(within(note()).getByRole('heading', { level: 2, name: 'Refunds' })).toBeTruthy();
    expect(note().textContent).toContain('This sticky note is not written yet.');
    view.bridge.addFile({ root: { kind: 'main' }, path: 'notes/Refunds.md' }, '');
    view.conn.handle('sticky.create', ({ name }) => ({ note: { name, links: [] } }));
    await userEvent.click(within(note()).getByRole('button', { name: 'Write this sticky note' }));
    await view.settle();
    expect(view.conn.requestsOf('sticky.create').map((request) => request.payload)).toEqual([{ name: 'Refunds' }]);
    expect(note().textContent).toContain('This sticky note is empty.');
    expect(view.opened()).toContain('notes/Refunds.md');
    // The list has it at once, under "Not linked" until Home links to it.
    expect(within(within(list()).getByRole('tree', { name: 'Not linked' })).getByRole('treeitem', { name: 'Refunds' }).getAttribute('aria-selected')).toBe('true');
  });

  it('no Home yet: the first page, and "Write the first sticky note" writes Home; somebody else writing it first is no failure', async () => {
    const view = await shown({ notes: [] });
    expect(within(list()).getByText('No sticky notes yet.')).toBeTruthy();
    expect(within(note()).getByRole('heading', { level: 2, name: 'Start with one sticky note' })).toBeTruthy();
    expect(note().textContent).toContain('Every sticky note grows from the first one, Home: a sticky note links to the next with [[Name]].');
    view.conn.handle('sticky.create', () => {
      throw new SmurgError('conflict', msg('sticky.create.exists', { name: 'Home' }), { reason: 'exists' });
    });
    view.notes.push({ name: 'Home', links: [] });
    await userEvent.click(within(note()).getByRole('button', { name: 'Write the first sticky note' }));
    await view.settle();
    expect(view.conn.requestsOf('sticky.create').map((request) => request.payload)).toEqual([{ name: 'Home' }]);
    expect(within(note()).getByRole('article', { name: 'Home' })).toBeTruthy();
    expect(within(note()).queryByRole('alert')).toBeNull();
  });

  it('"exists" for a note the index still does not list (its file is past the sticky notes the index lists) is said with the host\'s words', async () => {
    const view = await shown({ path: notePath('Refunds') });
    view.conn.handle('sticky.create', () => {
      throw new SmurgError('conflict', msg('sticky.create.exists', { name: 'Refunds' }), { reason: 'exists' });
    });
    const asked = view.conn.requestsOf('sticky.list').length;
    await userEvent.click(within(note()).getByRole('button', { name: 'Write this sticky note' }));
    await view.settle();
    // The index was asked again, and still does not list it: the page says what the host said (review S3-R4).
    expect(view.conn.requestsOf('sticky.list')).toHaveLength(asked + 1);
    expect(within(note()).getByRole('heading', { level: 2, name: 'Refunds' })).toBeTruthy();
    expect(within(note()).getByRole('alert').textContent).toBe('The sticky note was not written: There is already a sticky note named Refunds.');
  });

  it('a refusal is said with the host\'s words', async () => {
    const view = await shown({ path: notePath('Refunds') });
    view.conn.handle('sticky.create', () => {
      throw new SmurgError('conflict', msg('sticky.create.full', { max: NOTES_MAX }), { reason: 'full' });
    });
    await userEvent.click(within(note()).getByRole('button', { name: 'Write this sticky note' }));
    await view.settle();
    expect(within(note()).getByRole('alert').textContent).toBe(
      `The sticky note was not written: There are already ${NOTES_MAX} sticky notes, the most smurg can list. Delete one in the file tree of Code mode first.`,
    );
  });

  it('a Viewer sees no button to write: the first page and a missing note\'s page say who can', async () => {
    await shown({ role: 'viewer', notes: [] });
    expect(note().textContent).toContain('There is no sticky note yet. A member who can edit writes the first one.');
    expect(within(note()).queryByRole('button')).toBeNull();
    cleanup();
    await shown({ role: 'viewer', path: notePath('Refunds') });
    expect(note().textContent).toContain('This sticky note is not written yet.');
    expect(note().textContent).toContain('A member who can edit can write it.');
    expect(within(note()).queryByRole('button')).toBeNull();
    // Reading is the same for a Viewer.
    cleanup();
    await shown({ role: 'viewer' });
    expect(within(note()).getByRole('heading', { level: 3, name: 'Welcome' })).toBeTruthy();
  });

  it('the index could not be loaded: both parts say so, and "Try again" asks again', async () => {
    let refuse = true;
    const view = await shown({
      list: () => {
        if (refuse) throw new SmurgError('internal', 'the index failed');
        return { notes: [...NOTES], hasMore: false, truncated: false, sources: [] };
      },
    });
    expect(within(list()).getByRole('alert').textContent).toMatch(/^The sticky notes could not be loaded: /);
    refuse = false;
    await userEvent.click(within(note()).getByRole('button', { name: 'Try again' }));
    await view.settle();
    expect(within(note()).getByRole('article', { name: 'Home' })).toBeTruthy();
  });
});

describe('the open sticky note, edited (D7.5)', () => {
  const tools = (): HTMLElement => within(note()).getByRole('group', { name: 'What to do with this sticky note' });
  const roomOf = (view: Awaited<ReturnType<typeof shown>>, name: string) => {
    const room = view.bridge.rooms.get(view.keyOf(name));
    if (room === undefined) throw new Error(`no room for ${name}`);
    return room;
  };
  const addDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Add a sticky note' });
  const nameBox = (): HTMLElement => within(addDialog()).getByRole('textbox', { name: 'Name of the new sticky note' });

  it('Edit shows the shared editor of that one note, the same document the Read view shows, without "Send to agent"', async () => {
    const view = await shown({ role: 'host' });
    expect(within(tools()).getByRole('radio', { name: 'Read' }).getAttribute('aria-checked')).toBe('true');
    // No editor until Edit is chosen.
    expect(view.fake.bindings).toHaveLength(0);
    await userEvent.click(within(tools()).getByRole('radio', { name: 'Edit' }));
    await view.settle();
    await waitFor(() => expect(view.fake.bindings).toHaveLength(1));
    expect(within(note()).getByRole('group', { name: 'Editor for notes/Home.md' })).toBeTruthy();
    expect(view.fake.bindings[0]?.ytext.toString()).toBe(roomOf(view, 'Home').text);
    await waitFor(() => expect(view.fake.editors.at(-1)?.readOnly).toBe(false));
    // The host could send a selection anywhere, but not from here: Claude for the sticky notes is beside the note.
    expect(screen.queryByRole('button', { name: /Send to agent/ })).toBeNull();
    expect(view.fake.editors.at(-1)?.actions.has('smurg.sendToAgent')).toBe(false);
    // One document: the Read view and the editor are the same replica, opened once.
    expect(view.opened()).toEqual(['notes/Home.md']);
    act(() => view.fake.bindings[0]?.ytext.insert(0, 'Typed here. '));
    await userEvent.click(within(tools()).getByRole('radio', { name: 'Read' }));
    await waitFor(() => expect(within(note()).getByText(/Typed here\./)).toBeTruthy(), { timeout: DOCUMENT_TEXT_INTERVAL_MS * 10 });
    // The editor is kept, hidden, like a tab's.
    expect(view.fake.editors.at(-1)?.disposed).toBe(false);
    expect((note().querySelector('.sticky-card__editor') as HTMLElement).hidden).toBe(true);
  });

  it('a Viewer reads: no Edit, no "Add a sticky note", nothing to do with the note without the view\'s "Ask Claude"', async () => {
    await shown({ role: 'viewer' });
    expect(within(note()).getByRole('heading', { level: 3, name: 'Welcome' })).toBeTruthy();
    expect(within(note()).queryByRole('radio', { name: 'Edit' })).toBeNull();
    expect(within(note()).queryByRole('button', { name: 'Add a sticky note' })).toBeNull();
    expect(within(note()).queryByRole('group', { name: 'What to do with this sticky note' })).toBeNull();
    expect(within(note()).queryByRole('button')).toBeNull();
  });

  it('"Add a sticky note": the name goes to sticky.create once, however often Add is pressed; then `- [[Name]]` at the end of the open note, in one local transaction', async () => {
    const view = await shown({ path: notePath('Checkout') });
    const room = roomOf(view, 'Checkout');
    const before = room.text;
    const updates: unknown[] = [];
    room.doc.on('update', (_update: Uint8Array, origin: unknown) => updates.push(origin));
    await userEvent.click(within(tools()).getByRole('button', { name: 'Add a sticky note' }));
    expect(addDialog().textContent).toContain('A new, empty sticky note. Its link goes at the end of Checkout.');
    await userEvent.type(nameBox(), 'Coupons');
    const add = within(addDialog()).getByRole('button', { name: 'Add' });
    await userEvent.click(add);
    await userEvent.click(add);
    await userEvent.type(nameBox(), '{Enter}');
    expect(view.conn.requestsOf('sticky.create').map((request) => request.payload)).toEqual([{ name: 'Coupons' }]);
    // Nothing is written into the note before the new note is there.
    expect(room.text).toBe(before);
    await act(async () => {
      view.conn.respond('sticky.create', { note: { name: 'Coupons', links: [] } });
    });
    await view.settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.conn.requestsOf('sticky.create')).toHaveLength(1);
    expect(room.text).toBe(`${before}\n- [[Coupons]]\n`);
    expect(updates).toHaveLength(1);
    expect(within(note()).getByRole('status').textContent).toBe('Coupons is linked at the end of Checkout.');
    // The link leads to the new note (no "not written yet"): the store has it from sticky.create's answer.
    await waitFor(() => expect(within(note()).getByRole('link', { name: 'Coupons' }).classList.contains('md-wiki--missing')).toBe(false), { timeout: DOCUMENT_TEXT_INTERVAL_MS * 10 });
    // The open note's row unfolds: once the index has the link, the new row shows under it.
    act(() => view.conn.emit('sticky.changed', { upserted: [{ name: 'Checkout', links: ['Payment form', 'Home', 'Coupons'] }], removed: [], truncated: false }));
    expect(rows('Sticky notes from Home')).toEqual([
      ['Home', '1', 'true'],
      ['Checkout', '2', 'true'],
      ['Payment form', '3', null],
      ['Coupons', '3', null],
      ['Ideas', '2', null],
    ]);
  });

  it('"exists" is no failure: the link is added all the same, spelled as the index has the note on disk', async () => {
    const view = await shown({ path: notePath('Apple') });
    view.conn.handle('sticky.create', () => {
      throw new SmurgError('conflict', msg('sticky.create.exists', { name: 'Ideas' }), { reason: 'exists' });
    });
    await userEvent.click(within(tools()).getByRole('button', { name: 'Add a sticky note' }));
    await userEvent.type(nameBox(), 'ideas');
    await userEvent.click(within(addDialog()).getByRole('button', { name: 'Add' }));
    await view.settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(roomOf(view, 'Apple').text).toBe('An apple.\n- [[Ideas]]\n');
  });

  it('a refusal is said in the dialog with the host\'s words, and nothing is written into the note', async () => {
    const view = await shown();
    const refusal = msg('sticky.name.invalid', { rule: 'markup' });
    view.conn.handle('sticky.create', () => {
      throw new SmurgError('bad_request', refusal, { reason: 'invalid-name' });
    });
    const before = roomOf(view, 'Home').text;
    await userEvent.click(within(tools()).getByRole('button', { name: 'Add a sticky note' }));
    // Nothing to add yet: the button waits for a name.
    expect((within(addDialog()).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(nameBox(), 'a*b');
    await userEvent.click(within(addDialog()).getByRole('button', { name: 'Add' }));
    await view.settle();
    expect(within(addDialog()).getByRole('alert').textContent).toBe(`The sticky note was not written: ${renderEnglish(refusal)}`);
    expect(roomOf(view, 'Home').text).toBe(before);
  });

  it('the note became read-only while the name was on its way (Claude took its lock): nothing is written into it, the page says so, and the new note is under "Not linked"', async () => {
    const view = await shown();
    const before = roomOf(view, 'Home').text;
    await userEvent.click(within(tools()).getByRole('button', { name: 'Add a sticky note' }));
    await userEvent.type(nameBox(), 'Refunds');
    await userEvent.click(within(addDialog()).getByRole('button', { name: 'Add' }));
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: makeAgentLock('notes/Home.md') }));
    // The button goes while the note takes no change; the dialog on its way stays.
    expect(within(tools()).queryByRole('button', { name: 'Add a sticky note', hidden: true })).toBeNull();
    expect(addDialog()).toBeTruthy();
    await act(async () => {
      view.conn.respond('sticky.create', { note: { name: 'Refunds', links: [] } });
    });
    await view.settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(roomOf(view, 'Home').text).toBe(before);
    expect(within(note()).getByText('The link to Refunds was not added: Home cannot be changed right now. Refunds is under "Not linked" until a sticky note links to it.')).toBeTruthy();
    expect(within(within(list()).getByRole('tree', { name: 'Not linked' })).getByRole('treeitem', { name: 'Refunds' })).toBeTruthy();
    // Claude lets go: the button is back.
    act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: 'notes/Home.md' }, lock: null }));
    expect(within(tools()).getByRole('button', { name: 'Add a sticky note' })).toBeTruthy();
  });

  it('the note became read-only while the name was on its way, and the new note is not under "Not linked": the page says only that the link was not added (review S4-R4, S4-SEC-1)', async () => {
    // Ideas already links to Coupons before Coupons is written (a "not written yet" link, D7.6), so the new note is
    // under Ideas the moment it exists; Checkout is there, under Home; Home is never under "Not linked".
    const notes = NOTES.map((one) => (one.name === 'Ideas' ? { ...one, links: ['Checkout', 'Coupons'] } : one));
    const cases = [
      { from: 'Home', typed: 'Coupons', answer: 'created' },
      { from: 'Home', typed: 'checkout', answer: 'exists' },
      { from: 'Checkout', typed: 'Home', answer: 'exists' },
    ] as const;
    for (const { from, typed, answer } of cases) {
      const view = await shown({ path: notePath(from), notes });
      const what = `${typed} from ${from}`;
      const before = roomOf(view, from).text;
      if (answer === 'exists') {
        view.conn.handle('sticky.create', () => {
          throw new SmurgError('conflict', msg('sticky.create.exists', { name: typed }), { reason: 'exists' });
        });
      }
      await userEvent.click(within(tools()).getByRole('button', { name: 'Add a sticky note' }));
      await userEvent.type(nameBox(), typed);
      // Claude takes the note's lock while the dialog is open (an "exists" is answered at once).
      act(() => view.conn.emit('lock.state', { file: { root: { kind: 'main' }, path: `notes/${from}.md` }, lock: makeAgentLock(`notes/${from}.md`) }));
      await userEvent.click(within(addDialog()).getByRole('button', { name: 'Add' }));
      if (answer === 'created') {
        await act(async () => {
          view.conn.respond('sticky.create', { note: { name: 'Coupons', links: [] } });
        });
      }
      await view.settle();
      expect(screen.queryByRole('dialog'), what).toBeNull();
      expect(roomOf(view, from).text, what).toBe(before);
      const linked = typed === 'checkout' ? 'Checkout' : typed;
      expect(within(note()).getByText(`The link to ${linked} was not added: ${from} cannot be changed right now.`), what).toBeTruthy();
      expect(note().textContent, what).not.toContain('"Not linked"');
      expect(within(within(list()).getByRole('tree', { name: 'Not linked' })).queryByRole('treeitem', { name: linked }), what).toBeNull();
      // Where the list has it: in the tree grown from Home (Coupons under Ideas, whose row is folded).
      const tree = selectNoteTree(view.stores.sticky.getState());
      expect(linked === 'Home' ? tree.home?.name : ancestorsOf(tree.home, linked), what).toEqual(linked === 'Home' ? 'Home' : linked === 'Coupons' ? [HOME_KEY, noteKey('Ideas')] : [HOME_KEY]);
      cleanup();
    }
  });

  it('"Ask Claude about this sticky note" hands the view the note\'s name on disk; without the view\'s handler there is no button', async () => {
    const ask = vi.fn();
    const view = await shown({ path: notePath('payment form'), onAskClaude: ask });
    expect(view.path()).toBe(notePath('Payment form'));
    await userEvent.click(within(tools()).getByRole('button', { name: 'Ask Claude about this sticky note' }));
    expect(ask.mock.calls).toEqual([['Payment form']]);
    cleanup();
    // A Viewer the view gives the handler (it decides who has a box in Claude's conversation) has only that button.
    await shown({ role: 'viewer', onAskClaude: ask });
    expect(within(tools()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Ask Claude about this sticky note']);
    cleanup();
    await shown();
    expect(within(note()).queryByRole('button', { name: 'Ask Claude about this sticky note' })).toBeNull();
  });

  it('the line of a new link: on a line of its own, after a line break when the note does not end with one', () => {
    expect(linkLineAfter('', 'Ideas')).toBe('- [[Ideas]]\n');
    expect(linkLineAfter('Text.\n', 'Ideas')).toBe('- [[Ideas]]\n');
    expect(linkLineAfter('Text.', 'Payment form')).toBe('\n- [[Payment form]]\n');
    expect(linkLineAfter('- [[A]]\n', '結帳流程')).toBe('- [[結帳流程]]\n');
  });
});

describe('the index in the store (D7.3)', () => {
  const index = (notes: readonly NoteInfo[], extra: { hasMore?: boolean; truncated?: boolean } = {}) => ({ notes: [...notes], hasMore: extra.hasMore ?? false, truncated: extra.truncated ?? false, sources: [] });

  it('is not loaded when a channel opens; the notes view asks for it once, every page of it, and again after a resync', async () => {
    const { conn, stores, admit, flush, dispose } = setupStores({ role: 'editor' });
    disposers.push(dispose);
    admit();
    await flush();
    expect(conn.requestsOf('sticky.list')).toHaveLength(0);
    // Two pages (the list rule).
    conn.handle('sticky.list', ({ after }) => (after === undefined ? index(NOTES.slice(0, 3), { hasMore: true }) : index(NOTES.slice(3))));
    await act(async () => {
      await stores.sticky.want();
    });
    expect(conn.requestsOf('sticky.list').map((request) => request.payload)).toEqual([{}, { after: 'Home' }]);
    expect(stores.sticky.getState()).toMatchObject({ status: 'ready', wanted: true, truncated: false });
    expect([...stores.sticky.getState().notes.values()].map((one) => one.name)).toEqual(NOTES.map((one) => one.name));
    await act(async () => {
      await stores.sticky.want();
    });
    expect(conn.requestsOf('sticky.list')).toHaveLength(2);
    // A new logical channel: asked again. A resumed one too (what every member is told is not replayed).
    admit({ channelId: 'ch_2' });
    await flush();
    expect(conn.requestsOf('sticky.list')).toHaveLength(4);
    admit({ resumed: true });
    await flush();
    expect(conn.requestsOf('sticky.list')).toHaveLength(6);
  });

  it('asked again on a resumed channel, the index stays ready while the answer comes; a refresh that fails keeps it and is reported', async () => {
    const { conn, stores, admit, flush, dispose } = setupStores({ role: 'editor' });
    disposers.push(dispose);
    admit();
    await flush();
    conn.handle('sticky.list', () => index(NOTES));
    await act(async () => {
      await stores.sticky.want();
    });
    const notes = stores.sticky.getState().notes;
    const seen: string[] = [];
    const off = stores.sticky.subscribe(() => seen.push(stores.sticky.getState().status));
    disposers.push(off);
    admit({ resumed: true });
    await flush();
    expect(conn.requestsOf('sticky.list')).toHaveLength(2);
    for (const [key, one] of notes) expect(stores.sticky.getState().notes.get(key)).toBe(one);
    const refreshed = stores.sticky.getState().notes;
    conn.handle('sticky.list', () => {
      throw new SmurgError('internal', 'the index failed');
    });
    admit({ resumed: true });
    await flush();
    expect(conn.requestsOf('sticky.list')).toHaveLength(3);
    expect(stores.sticky.getState()).toMatchObject({ status: 'ready', error: null });
    expect(stores.sticky.getState().notes).toBe(refreshed);
    expect(stores.errors.getState().map((event) => event.area)).toEqual(['sticky']);
    // Neither refresh showed the index as loading or failed (review S3-R1).
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((status) => status === 'ready')).toBe(true);
  });

  it('sticky.changed changes only what it names; a note that did not change keeps its object, and the tree follows', async () => {
    const { conn, stores, admit, flush, dispose } = setupStores({ role: 'viewer' });
    disposers.push(dispose);
    admit();
    await flush();
    // Before the index is asked for, a change shows nothing.
    act(() => conn.emit('sticky.changed', { upserted: [{ name: 'Lone', links: [] }], removed: [], truncated: false }));
    expect(stores.sticky.getState().notes.size).toBe(0);
    conn.handle('sticky.list', () => index(NOTES));
    await act(async () => {
      await stores.sticky.want();
    });
    const before = stores.sticky.getState();
    const tree = selectNoteTree(before);
    expect(selectNoteTree(before)).toBe(tree);
    act(() => conn.emit('sticky.changed', { upserted: [{ name: 'Ideas', links: ['Checkout', 'Apple'] }], removed: ['Zebra'], truncated: false }));
    const after = stores.sticky.getState();
    expect(after.notes.get(HOME_KEY)).toBe(before.notes.get(HOME_KEY));
    expect(after.notes.get(noteKey('Ideas'))?.links).toEqual(['Checkout', 'Apple']);
    expect(after.notes.has(noteKey('Zebra'))).toBe(false);
    expect(selectNoteTree(after).notLinked).toEqual([]);
    // A fold twin is kept apart from the note it shadows; when the note goes, the twin is the note.
    act(() => conn.emit('sticky.changed', { upserted: [{ name: 'home', links: [], shadowed: true }], removed: [], truncated: true }));
    expect(stores.sticky.getState().notes.get(HOME_KEY)?.name).toBe('Home');
    expect([...stores.sticky.getState().shadowed.keys()]).toEqual(['home']);
    expect(stores.sticky.getState().truncated).toBe(true);
    act(() => conn.emit('sticky.changed', { upserted: [{ name: 'home', links: ['Ideas'] }], removed: ['Home'], truncated: false }));
    expect(stores.sticky.getState().notes.get(HOME_KEY)).toEqual({ name: 'home', links: ['Ideas'] });
    expect(stores.sticky.getState().shadowed.size).toBe(0);
    // A list that says the same keeps every object.
    const listed = stores.sticky.getState().notes;
    conn.handle('sticky.list', () => index([...listed.values()]));
    await act(async () => {
      await stores.sticky.reload();
    });
    for (const [key, one] of listed) expect(stores.sticky.getState().notes.get(key)).toBe(one);
  });

  it('sticky.create puts the index\'s note into the store before it answers', async () => {
    const { conn, stores, admit, flush, dispose } = setupStores({ role: 'editor' });
    disposers.push(dispose);
    admit();
    await flush();
    conn.handle('sticky.list', () => index([]));
    await act(async () => {
      await stores.sticky.want();
    });
    conn.handle('sticky.create', ({ name }) => ({ note: { name, links: [] } }));
    let made: NoteInfo | undefined;
    await act(async () => {
      made = await stores.sticky.create('Home');
    });
    expect(made).toEqual({ name: 'Home', links: [] });
    expect(stores.sticky.getState().notes.get(HOME_KEY)).toBe(made);
  });
});
