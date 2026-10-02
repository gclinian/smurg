import { MAIN_ROOT, lockedError, type FileEntry, type FileRef, type Role, type RootRef } from '@smurg/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { HOST_USER, T0, makeAgentLock, makeEntry, makeHumanLock } from '../../testing/fixtures.ts';
import { createManualScheduler, renderInWorkspace } from '../../testing/services.tsx';
import { FilesPanel } from './index.tsx';

type Fs = Map<string, FileEntry[]>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function defaultFs(): Fs {
  return new Map([
    ['', [makeEntry('src', 'dir'), makeEntry('data', 'dir', { readOnly: true }), makeEntry('README.md')]],
    ['src', [makeEntry('src/app.ts'), makeEntry('src/lib', 'dir')]],
    ['src/lib', [makeEntry('src/lib/util.ts')]],
    ['data', [makeEntry('data/train.csv', 'file', { readOnly: true })]],
  ]);
}

/**
 * The files panel on a FakeConnection whose file.tree answers from `fs` (per root: `fsFor(root)`), with a manual
 * scheduler for the files store's coalesced re-listing, and every command the panel dispatches recorded.
 */
function renderFiles(options: { role?: Role; fs?: Fs; fsFor?: (root: RootRef) => Fs } = {}) {
  const scheduler = createManualScheduler(T0);
  const fs = options.fs ?? defaultFs();
  const view = renderInWorkspace(<FilesPanel />, { role: options.role ?? 'editor', scheduler });
  view.conn.handle('file.tree', ({ root, path }) => ({ entries: (options.fsFor?.(root) ?? fs).get(path) ?? [], truncated: false }));
  view.conn.handle('lock.list', () => ({ locks: [] }));
  const dispatched: { [K in keyof CommandMap]?: CommandMap[K][] } = {};
  const record = <K extends keyof CommandMap>(name: K) =>
    view.session.commands.handle(name, (payload) => {
      (dispatched[name] ??= [] as never[]).push(payload as never);
    });
  record('openFile');
  record('download');
  record('startUpload');
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await act(flush);
  };
  /** Lets the files store's coalescing timer run, then the re-list requests settle. */
  const refresh = async (): Promise<void> => {
    act(() => scheduler.advance(100));
    await settle();
  };
  const row = (name: string | RegExp) => screen.getByRole('treeitem', { name });
  const treePaths = () => screen.queryAllByRole('treeitem').map((node) => node.getAttribute('data-row-path'));
  return { ...view, fs, scheduler, dispatched, settle, refresh, row, treePaths };
}

function treeRequests(view: ReturnType<typeof renderFiles>): string[] {
  return view.conn.requestsOf('file.tree').map((request) => request.payload.path);
}

describe('FilesPanel: a lazily loaded tree per root, kept live by file.changed', () => {
  it('lists the root first and a folder only when it is expanded; collapsing forgets it', async () => {
    const view = renderFiles();
    await view.settle();
    expect(view.treePaths()).toEqual(['data', 'src', 'README.md']);
    expect(treeRequests(view)).toEqual(['']);

    fireEvent.click(view.row('src'));
    await view.settle();
    expect(view.row('src').getAttribute('aria-expanded')).toBe('true');
    expect(view.treePaths()).toEqual(['data', 'src', 'src/lib', 'src/app.ts', 'README.md']);
    expect(view.row('app.ts').getAttribute('aria-level')).toBe('2');
    expect(treeRequests(view)).toEqual(['', 'src']);

    fireEvent.click(view.row('src'));
    expect(view.treePaths()).toEqual(['data', 'src', 'README.md']);
    // Reopened: listed again (a collapsed folder is not kept fresh, so its cached listing was dropped).
    fireEvent.click(view.row('src'));
    await view.settle();
    expect(treeRequests(view)).toEqual(['', 'src', 'src']);
  });

  it('tree updates: file.changed adds and removes entries (coalesced into one re-list per folder)', async () => {
    const view = renderFiles();
    await view.settle();
    fireEvent.click(view.row('src'));
    await view.settle();
    const before = treeRequests(view).length;

    view.fs.set('', [...(view.fs.get('') ?? []), makeEntry('NOTES.md')]);
    view.fs.set('src', [...(view.fs.get('src') ?? []), makeEntry('src/new.ts')]);
    act(() => {
      view.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'NOTES.md', change: 'add' }] });
      view.conn.emit('file.changed', {
        root: MAIN_ROOT,
        changes: [
          { path: 'src/new.ts', change: 'add', by: { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude (Ian)' } },
          { path: 'src/app.ts', change: 'change' },
        ],
      });
    });
    await view.refresh();
    expect(view.treePaths()).toEqual(['data', 'src', 'src/lib', 'src/app.ts', 'src/new.ts', 'NOTES.md', 'README.md']);
    // Three changes in two folders: exactly two re-lists.
    expect(treeRequests(view).slice(before).sort()).toEqual(['', 'src']);

    // The folder is deleted on the host: it disappears, and so does everything that was listed below it.
    view.fs.set('', (view.fs.get('') ?? []).filter((entry) => entry.path !== 'src'));
    act(() => view.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'src', change: 'unlinkDir' }] }));
    await view.refresh();
    expect(view.treePaths()).toEqual(['data', 'NOTES.md', 'README.md']);
    // A change in a folder nobody expanded costs nothing.
    const count = treeRequests(view).length;
    act(() => view.conn.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'elsewhere/x.ts', change: 'add' }] }));
    await view.refresh();
    expect(treeRequests(view)).toHaveLength(count);
  });

  it('badges: locked by a person, being changed by which agent, recently changed by whom; read-only entries marked', async () => {
    const now = Date.now();
    const agent = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude (Ian)' };
    const fs: Fs = new Map([
      [
        '',
        [
          makeEntry('agent.ts'),
          makeEntry('human.ts'),
          makeEntry('recent.ts', 'file', { mtime: now - 2 * 60_000, lastModifiedBy: agent }),
          makeEntry('shared', 'dir', { readOnly: true }),
        ],
      ],
    ]);
    const view = renderFiles({ fs });
    await view.settle();
    act(() => {
      view.conn.emit('lock.state', { file: { root: MAIN_ROOT, path: 'agent.ts' }, lock: makeAgentLock('agent.ts') });
      view.conn.emit('lock.state', { file: { root: MAIN_ROOT, path: 'human.ts' }, lock: makeHumanLock('human.ts', { userId: 'dev:bob', displayName: 'Bob' }) });
    });
    expect(view.row('agent.ts').getAttribute('aria-description')).toBe('Claude (Ian) is editing this file; it cannot be edited for now');
    expect(within(view.row('agent.ts')).getByText('Claude (Ian) editing')).toBeTruthy();
    expect(view.row('human.ts').getAttribute('aria-description')).toBe('Being edited by Bob; agents cannot change it for now');
    expect(view.row('recent.ts').getAttribute('aria-description')).toBe('Recently changed by Claude (Ian) (2 minutes ago)');
    expect(view.row('shared').getAttribute('aria-description')).toBe('Read-only (shared folder)');

    // The agent finished: its badge goes away with the lock.
    act(() => view.conn.emit('lock.state', { file: { root: MAIN_ROOT, path: 'agent.ts' }, lock: null }));
    expect(view.row('agent.ts').getAttribute('aria-description')).toBeNull();
  });
});

describe('FilesPanel: create / rename / delete (with confirmation) and the context menu', () => {
  it('creates a file through a validated name dialog and opens it', async () => {
    const view = renderFiles();
    view.conn.handle('file.create', ({ file, kind }) => ({ entry: makeEntry(file.path, kind) }));
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    const dialog = screen.getByRole('dialog', { name: 'New file' });
    const input = within(dialog).getByLabelText('File name');
    fireEvent.change(input, { target: { value: 'readme.md' } });
    expect(within(dialog).getByText('This folder already has an item with this name (upper and lower case count as the same)')).toBeTruthy();
    fireEvent.change(input, { target: { value: '筆記.md' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await view.settle();
    expect(view.conn.requestsOf('file.create').map((r) => r.payload)).toEqual([{ file: { root: MAIN_ROOT, path: '筆記.md' }, kind: 'file' }]);
    expect(view.dispatched.openFile).toEqual([{ file: { root: MAIN_ROOT, path: '筆記.md' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the header creates in the root until a row is focused, then in that row\'s folder (never in the first row by default)', async () => {
    const view = renderFiles();
    await view.settle();
    // Nothing focused: the root, although the first row of the tree is the folder `src`.
    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    expect(within(screen.getByRole('dialog', { name: 'New file' })).getByText('Location: root folder')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'New file' })).getByRole('button', { name: 'Cancel' }));
    // The person focuses a file inside an expanded folder: that folder.
    fireEvent.click(view.row('src'));
    await view.settle();
    fireEvent.focus(view.row('app.ts'));
    fireEvent.click(screen.getByRole('button', { name: 'New file' }));
    expect(within(screen.getByRole('dialog', { name: 'New file' })).getByText('Location: src')).toBeTruthy();
  });

  it('renames with F2 and deletes with Delete only after confirming; a locked file names its holder', async () => {
    const view = renderFiles();
    view.conn.handle('file.rename', ({ to }) => ({ entry: makeEntry(to) }));
    await view.settle();
    const readme = view.row('README.md');
    readme.focus();
    fireEvent.keyDown(readme, { key: 'F2' });
    const rename = screen.getByRole('dialog', { name: 'Rename "README.md"' });
    fireEvent.change(within(rename).getByLabelText('New name'), { target: { value: '讀我.md' } });
    fireEvent.click(within(rename).getByRole('button', { name: 'Rename' }));
    await view.settle();
    expect(view.conn.requestsOf('file.rename').map((r) => r.payload)).toEqual([{ root: MAIN_ROOT, from: 'README.md', to: '讀我.md' }]);

    // Delete: cancelling sends nothing.
    fireEvent.keyDown(view.row('README.md'), { key: 'Delete' });
    const confirm = screen.getByRole('alertdialog', { name: 'Delete "README.md"?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(view.conn.requestsOf('file.delete')).toHaveLength(0);

    // Confirmed, but an agent holds the file: the daemon refuses and the toast names the agent.
    view.conn.handle('file.delete', () => {
      throw lockedError(makeAgentLock('README.md'), 'locked');
    });
    fireEvent.keyDown(view.row('README.md'), { key: 'Delete' });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await view.settle();
    expect(view.conn.requestsOf('file.delete').map((r) => r.payload)).toEqual([{ file: { root: MAIN_ROOT, path: 'README.md' } }]);
    expect(await screen.findByText('Claude (Ian) is editing this file. Try again in a moment.')).toBeTruthy();
    // The dialog stays open (nothing was deleted); confirming again after the agent finished works.
    view.conn.handle('file.delete', () => ({}));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await view.settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('file.delete')).toHaveLength(2);
  });

  it('a rename re-points the open tab to the new name; the delete confirmation names who has the file open', async () => {
    const view = renderFiles();
    view.conn.handle('file.rename', ({ to }) => ({ entry: makeEntry(to) }));
    view.conn.handle('doc.open', () => ({ docId: 'doc_1', epoch: 'epoch_1', canEdit: true, meta: { eol: 'LF', bom: false, mixedEol: false } }));
    await view.settle();
    await act(async () => {
      await view.stores.docs.open({ root: MAIN_ROOT, path: 'README.md' });
    });
    const readme = view.row('README.md');
    readme.focus();
    fireEvent.keyDown(readme, { key: 'F2' });
    const rename = screen.getByRole('dialog', { name: 'Rename "README.md"' });
    fireEvent.change(within(rename).getByLabelText('New name'), { target: { value: '讀我.md' } });
    fireEvent.click(within(rename).getByRole('button', { name: 'Rename' }));
    await view.settle();
        expect([...view.stores.docs.getState().docs.values()].map((doc) => doc.file.path)).toEqual(['讀我.md']);

    // Someone else has README.md open (presence) and a human lock on src/app.ts: deleting names them.
    act(() =>
      view.conn.emit('presence.state', {
        members: [{ userId: 'dev:ming', displayName: '王小明', role: 'editor', color: '#16a34a', online: true, joinedAt: T0, connections: 1, activeFile: { root: MAIN_ROOT, path: 'README.md' } }],
        agents: [],
      }),
    );
    fireEvent.keyDown(view.row('README.md'), { key: 'Delete' });
    expect(within(screen.getByRole('alertdialog')).getByRole('note').textContent).toContain('This file is open or being edited by 王小明.');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    act(() => view.conn.emit('lock.state', { file: { root: MAIN_ROOT, path: 'src/app.ts' }, lock: makeHumanLock('src/app.ts', { userId: 'dev:mei', displayName: '陳美玲' }) }));
    fireEvent.keyDown(view.row('src'), { key: 'Delete' });
    expect(within(screen.getByRole('alertdialog')).getByRole('note').textContent).toContain('Files in this folder are open or being edited by 陳美玲.');
  });

  it("the host's context menu force-releases a lock after naming its holder; a guest's has no such item", async () => {
    const view = renderFiles({ role: 'host' });
    view.conn.handle('lock.list', () => ({ locks: [makeHumanLock('README.md', { userId: 'dev:ming', displayName: '王小明' })] }));
    view.conn.handle('lock.forceRelease', () => ({}));
    await act(async () => {
      await view.stores.locks.reload();
    });
    await view.settle();
    fireEvent.contextMenu(view.row('README.md'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Force release the lock/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Force release the lock on "README.md"?' });
    expect(dialog.textContent).toContain('This file is being edited by 王小明.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Force release' }));
    await waitFor(() => expect(view.conn.requestsOf('lock.forceRelease').map((r) => r.payload)).toEqual([{ file: { root: MAIN_ROOT, path: 'README.md' } }]));
  });

  it('the context menu offers download (a file as is, a folder as zip) through the command bus', async () => {
    const view = renderFiles();
    await view.settle();
    fireEvent.contextMenu(view.row('README.md'), { clientX: 10, clientY: 10 });
    let menu = screen.getByRole('menu', { name: 'Actions for "README.md"' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open', 'Rename…F2', 'Delete…Delete', 'Download', 'Copy path']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Download' }));
    fireEvent.contextMenu(view.row('src'), { clientX: 10, clientY: 10 });
    menu = screen.getByRole('menu', { name: 'Actions for "src"' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Download (zip)' }));
    await view.settle();
    expect(view.dispatched.download).toEqual([{ file: { root: MAIN_ROOT, path: 'README.md' } }, { file: { root: MAIN_ROOT, path: 'src' }, zip: true }]);
  });

  it('read-only entries (a shared folder of a worktree) offer no rename, delete, new file or upload', async () => {
    const view = renderFiles();
    await view.settle();
    fireEvent.contextMenu(view.row('data'), { clientX: 1, clientY: 1 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Download (zip)', 'Copy path']);
    fireEvent.keyDown(view.row('data'), { key: 'Delete' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

/** A DataTransfer as a browser hands it to a drop handler: emptied as soon as the handler returns. */
function fakeDrop(entries: FileSystemEntry[]) {
  let alive = true;
  const items = entries.map((entry) => ({ kind: 'file', type: '', webkitGetAsEntry: () => (alive ? entry : null), getAsFile: () => null }));
  const dataTransfer = {
    types: ['Files'],
    get items() {
      return alive ? items : [];
    },
    files: [],
    dropEffect: 'none',
  };
  return { dataTransfer, expire: () => (alive = false) };
}

describe('FilesPanel: uploads by drag and drop go to the transfer feature (startUpload)', () => {
  it('collects the dropped items SYNCHRONOUSLY in the drop handler and hands them over with the target folder', async () => {
    const view = renderFiles();
    await view.settle();
    const entry = { name: '報告.pdf', isFile: true, isDirectory: false, fullPath: '/報告.pdf' } as unknown as FileSystemEntry;
    const folder = { name: '照片', isFile: false, isDirectory: true, fullPath: '/照片' } as unknown as FileSystemEntry;
    const drop = fakeDrop([entry, folder]);
    fireEvent.dragOver(view.row('src'), { dataTransfer: drop.dataTransfer });
    expect(view.row('src').getAttribute('data-drop-target')).toBe('true');
    expect(screen.getByText('Drop to upload into "src"')).toBeTruthy();
    fireEvent.drop(view.row('src'), { dataTransfer: drop.dataTransfer });
    drop.expire(); // the browser empties the DataTransfer right after the handler
    await view.settle();
    expect(view.dispatched.startUpload).toHaveLength(1);
    const upload = view.dispatched.startUpload?.[0];
    expect(upload?.root).toEqual(MAIN_ROOT);
    expect(upload?.targetDir).toBe('src');
    expect(upload?.source).toMatchObject({ kind: 'drop', entries: [entry, folder] });

    // Dropped on a file: into that file's folder (the root here).
    const again = fakeDrop([entry]);
    fireEvent.drop(view.row('README.md'), { dataTransfer: again.dataTransfer });
    again.expire();
    await view.settle();
    expect(view.dispatched.startUpload?.[1]?.targetDir).toBe('');

    // A read-only folder is not a drop target.
    const refused = fakeDrop([entry]);
    fireEvent.drop(view.row('data'), { dataTransfer: refused.dataTransfer });
    refused.expire();
    await view.settle();
    expect(view.dispatched.startUpload).toHaveLength(2);
  });
});

describe('FilesPanel: roles (UI hiding only; the daemon enforces)', () => {
  it('a viewer sees no write actions: no new file / folder / upload, no rename / delete, drops are ignored', async () => {
    const view = renderFiles({ role: 'viewer' });
    await view.settle();
    expect(screen.queryByRole('button', { name: 'New file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();

    fireEvent.contextMenu(view.row('README.md'), { clientX: 1, clientY: 1 });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open', 'Download', 'Copy path']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.contextMenu(view.row('src'), { clientX: 1, clientY: 1 });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Download (zip)', 'Copy path']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.keyDown(view.row('README.md'), { key: 'F2' });
    fireEvent.keyDown(view.row('README.md'), { key: 'Delete' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    const drop = fakeDrop([{ name: 'x', isFile: true, isDirectory: false } as unknown as FileSystemEntry]);
    fireEvent.dragOver(view.row('src'), { dataTransfer: drop.dataTransfer });
    expect(view.row('src').getAttribute('data-drop-target')).toBeNull();
    fireEvent.drop(view.row('src'), { dataTransfer: drop.dataTransfer });
    await view.settle();
    expect(view.dispatched.startUpload).toBeUndefined();

    // Downloading is for everyone.
    fireEvent.contextMenu(view.row('README.md'), { clientX: 1, clientY: 1 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Download' }));
    await view.settle();
    expect(view.dispatched.download).toEqual([{ file: { root: MAIN_ROOT, path: 'README.md' } }]);
  });
});

describe('FilesPanel: keyboard (WAI-ARIA tree) and commands', () => {
  it('arrows move, Right expands / enters, Left collapses / goes to the parent, Enter opens a file', async () => {
    const view = renderFiles();
    await view.settle();
    const data = view.row('data');
    data.focus();
    fireEvent.keyDown(data, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(view.row('src')));
    fireEvent.keyDown(view.row('src'), { key: 'ArrowRight' });
    await view.settle();
    expect(view.row('src').getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(view.row('src'), { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(view.row('lib')));
    fireEvent.keyDown(view.row('lib'), { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(view.row('app.ts')));
    fireEvent.keyDown(view.row('app.ts'), { key: 'Enter' });
    await view.settle();
    expect(view.dispatched.openFile).toEqual([{ file: { root: MAIN_ROOT, path: 'src/app.ts' } }]);
    fireEvent.keyDown(view.row('app.ts'), { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(view.row('src')));
    fireEvent.keyDown(view.row('src'), { key: 'ArrowLeft' });
    expect(view.row('src').getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(view.row('src'), { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(view.row('README.md')));
    // Only one row is in the tab order (roving tabindex).
    expect(screen.getAllByRole('treeitem').filter((node) => node.tabIndex === 0)).toHaveLength(1);
  });

  it('revealFile expands every folder above the file and focuses it', async () => {
    const view = renderFiles();
    await view.settle();
    const file: FileRef = { root: MAIN_ROOT, path: 'src/lib/util.ts' };
    await act(async () => {
      await view.session.commands.dispatch('revealFile', { file });
    });
    await view.settle();
    expect(view.treePaths()).toContain('src/lib/util.ts');
    await waitFor(() => expect(document.activeElement).toBe(view.row('util.ts')));
  });

  it('shows the root the worktree switcher selected (files store activeRoot), with its own tree', async () => {
    const worktree: RootRef = { kind: 'worktree', worktreeId: 'wt_1' };
    const worktreeFs: Fs = new Map([['', [makeEntry('only-in-worktree.ts')]]]);
    const view = renderFiles({ fsFor: (root) => (root.kind === 'worktree' ? worktreeFs : defaultFs()) });
    await view.settle();
    expect(view.treePaths()).toEqual(['data', 'src', 'README.md']);
    act(() => view.stores.files.setActiveRoot(worktree));
    await view.settle();
    expect(view.treePaths()).toEqual(['only-in-worktree.ts']);
    expect(view.conn.lastRequest('file.tree')?.payload.root).toEqual(worktree);
    expect(screen.getByRole('tree', { name: 'File tree of Worktree: wt_1' })).toBeTruthy();
    fireEvent.keyDown(view.row('only-in-worktree.ts'), { key: 'Enter' });
    await view.settle();
    expect(view.dispatched.openFile).toEqual([{ file: { root: worktree, path: 'only-in-worktree.ts' } }]);
  });
});
