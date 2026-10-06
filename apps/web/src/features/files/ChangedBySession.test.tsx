// Code mode's file tree beside an agent session (DESIGN §5.6, §3.11): the list "Changed by this session" above the
// tree (the files the session beside the editor changed with its edit tools: a click opens one), and the folder
// `specs/<topic>/` of a work item's worktree, which is read-only for everyone.
import { MAIN_ROOT, type ConversationEvent, type ResultInputOf, type RootRef, type SessionInfo, type Topic, type WorktreeInfo } from '@smurg/protocol';
import { buildEvent, buildTopic } from '@smurg/protocol/testing';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { T0, makeAgentSession, makeEntry, makeSession, makeWorktree } from '../../testing/fixtures.ts';
import { createManualScheduler, renderInWorkspace } from '../../testing/services.tsx';
import { FilesPanel } from './index.tsx';
import { checkNewName, entryBadges, isEntryWritable, isItemSpecPath } from './tree-model.ts';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const WT: RootRef = { kind: 'worktree', worktreeId: 'wt_item' };

const AGENT = makeAgentSession({ id: 'sess_item', purpose: 'item', topicId: 'topic_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, attempt: 1, title: undefined, root: WT, status: 'running' });

/** An edit tool call on `path` that finished (`ok`), as two events from `seq`. */
function edit(seq: number, path: string, options: { ok?: boolean; root?: RootRef; name?: string; verb?: 'edit' | 'create' | 'read' } = {}): ConversationEvent[] {
  const toolUseId = `tu_${seq}`;
  return [
    buildEvent('tool.started', { seq, toolUseId, tool: { name: options.name ?? 'Edit', verb: options.verb ?? 'edit', target: path, file: { root: options.root ?? WT, path } } }),
    buildEvent('tool.finished', { seq: seq + 1, toolUseId, ok: options.ok ?? true }),
  ];
}

function watchReply(session: SessionInfo, events: ConversationEvent[]): ResultInputOf<'session.watch'> {
  if (session.kind !== 'agent') throw new Error('a conversation belongs to an agent session');
  return { session, events, firstSeq: events[0]?.seq ?? 0, nextSeq: (events.at(-1)?.seq ?? 0) + 1, hasEarlier: false, hasMore: false, streaming: [], questions: [], permissions: [], suggestions: [], moreCards: [] };
}

interface Setup {
  sessions?: SessionInfo[];
  events?: ConversationEvent[];
  worktrees?: WorktreeInfo[];
  topics?: Topic[];
  entries?: (root: RootRef, path: string) => ReturnType<typeof makeEntry>[];
  role?: 'host' | 'agent' | 'editor' | 'viewer';
}

async function renderFiles(setup: Setup = {}) {
  const sessions = setup.sessions ?? [AGENT];
  const view = renderInWorkspace(<FilesPanel />, { role: setup.role ?? 'agent', scheduler: createManualScheduler(T0) });
  view.conn.handle('file.tree', ({ root, path }) => ({ entries: setup.entries?.(root, path) ?? (path === '' ? [makeEntry('src', 'dir'), makeEntry('README.md')] : []), truncated: false }));
  view.conn.handle('lock.list', () => ({ locks: [] }));
  view.conn.handle('session.list', () => ({ sessions, hasMore: false }));
  view.conn.handle('worktree.list', () => ({ worktrees: setup.worktrees ?? [] }));
  view.conn.handle('worktree.merge.list', () => ({ requests: [] }));
  view.conn.handle('topic.list', () => ({ topics: setup.topics ?? [], hasMore: false }));
  view.conn.handle('session.watch', ({ sessionId }) => watchReply(sessions.find((session) => session.id === sessionId) ?? AGENT, setup.events ?? []));
  const opened: CommandMap['openFile'][] = [];
  view.session.commands.handle('openFile', (payload) => {
    opened.push(payload);
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await act(flush);
  };
  // The stores were asked before the handlers existed: ask again, as a reconnect would.
  await act(async () => {
    await Promise.all([view.stores.sessions.reload(), view.stores.worktrees.reload(), view.stores.topics.reload()].map((load) => load.catch(() => undefined)));
  });
  await settle();
  return { ...view, opened, settle };
}

describe('files panel: "Changed by this session"', () => {
  it('nothing is shown while no session is beside the editor, and nothing for a plain terminal', async () => {
    const terminal = makeSession({ id: 'sess_term' });
    const view = await renderFiles({ sessions: [AGENT, terminal] });
    expect(screen.queryByRole('region', { name: /^Files changed by/ })).toBeNull();
    act(() => view.stores.columns.setCodeSession('sess_term'));
    await view.settle();
    expect(screen.queryByRole('region', { name: /^Files changed by/ })).toBeNull();
    expect(view.conn.requestsOf('session.watch')).toHaveLength(0);
    // The tree itself is there as always.
    expect(screen.getByRole('tree', { name: 'File tree of Main workspace' })).toBeTruthy();
  });

  it('lists the files the session changed with its edit tools, newest change first and each once; a click opens the file', async () => {
    const view = await renderFiles({
      events: [
        ...edit(1, 'src/cart.ts'),
        ...edit(3, 'src/cart.test.ts', { name: 'Write', verb: 'create' }),
        // A read is not a change; an edit that failed changed nothing.
        ...edit(5, 'README.md', { name: 'Read', verb: 'read' }),
        ...edit(7, 'src/broken.ts', { ok: false }),
        ...edit(9, 'src/cart.ts'),
      ],
    });
    act(() => view.stores.columns.setCodeSession('sess_item'));
    await view.settle();
    // The list watches the conversation without asking for streaming text.
    expect(view.conn.requestsOf('session.watch').map((request) => request.payload)).toEqual([{ sessionId: 'sess_item', live: false }]);
    const list = screen.getByRole('region', { name: 'Files changed by 1 · Cart API' });
    expect(within(list).getByText('Changed by this session')).toBeTruthy();
    expect(within(list).getByText('1 · Cart API')).toBeTruthy();
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['src/cart.ts', 'src/cart.test.ts']);
    expect(within(list).getByRole('button', { name: /^Changed by this session/ }).textContent).toContain('2');

    fireEvent.click(within(list).getByRole('button', { name: 'src/cart.test.ts' }));
    expect(view.opened).toEqual([{ file: { root: WT, path: 'src/cart.test.ts' } }]);

    // A new edit arrives while the list is on screen: it goes to the top.
    act(() => view.conn.emit('session.events', { sessionId: 'sess_item', events: edit(11, 'src/api.ts') }));
    await view.settle();
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['src/api.ts', 'src/cart.ts', 'src/cart.test.ts']);
  });

  it('a session that has changed nothing says so; the list folds; another session shows its own files', async () => {
    const other = makeAgentSession({ id: 'sess_free', title: 'try the parser', root: MAIN_ROOT });
    const view = await renderFiles({ sessions: [AGENT, other] });
    act(() => view.stores.columns.setCodeSession('sess_free'));
    await view.settle();
    const list = screen.getByRole('region', { name: 'Files changed by try the parser' });
    expect(within(list).getByText('This session has not changed a file yet.')).toBeTruthy();
    const toggle = within(list).getByRole('button', { name: /^Changed by this session/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(list).queryByText('This session has not changed a file yet.')).toBeNull();

    // Choosing another session stops watching the first and watches the new one.
    act(() => view.stores.columns.setCodeSession('sess_item'));
    await view.settle();
    expect(screen.getByRole('region', { name: 'Files changed by 1 · Cart API' })).toBeTruthy();
    expect(view.conn.requestsOf('session.watch').map((request) => request.payload.sessionId)).toEqual(['sess_free', 'sess_item']);
    // No session: the list goes.
    act(() => view.stores.columns.setCodeSession(null));
    await view.settle();
    expect(screen.queryByRole('region', { name: /^Files changed by/ })).toBeNull();
  });

  it('a changed file of another root than the tree shows says so in its tooltip, and still opens in its own root', async () => {
    const view = await renderFiles({ events: edit(1, 'src/cart.ts') });
    act(() => view.stores.columns.setCodeSession('sess_item'));
    await view.settle();
    // The tree shows the main workspace; the session works in its worktree.
    const file = within(screen.getByRole('region', { name: 'Files changed by 1 · Cart API' })).getByRole('button', { name: 'src/cart.ts' });
    expect(file.getAttribute('title')).toBe('src/cart.ts (in another folder than the tree shows)');
    fireEvent.click(file);
    expect(view.opened).toEqual([{ file: { root: WT, path: 'src/cart.ts' } }]);
    act(() => view.stores.files.setActiveRoot(WT));
    await view.settle();
    expect(within(screen.getByRole('region', { name: 'Files changed by 1 · Cart API' })).getByRole('button', { name: 'src/cart.ts' }).getAttribute('title')).toBe('src/cart.ts');
  });
});

describe("files panel: a work item's worktree keeps its topic's folder read-only for everyone", () => {
  const TOPIC = buildTopic({ id: 'topic_1', name: 'Checkout', slug: 'checkout' });
  const ITEM_WORKTREE = makeWorktree({ id: 'wt_item', topicId: 'topic_1', itemId: 'cart-api', branch: 'smurg/checkout/cart-api', kept: false });
  const entries = (_root: RootRef, path: string) =>
    path === ''
      ? [makeEntry('specs', 'dir'), makeEntry('src', 'dir')]
      : path === 'specs'
        ? [makeEntry('specs/checkout', 'dir'), makeEntry('specs/other', 'dir')]
        : path === 'specs/checkout'
          ? [makeEntry('specs/checkout/SPEC.md', 'file', { readOnly: true }), makeEntry('specs/checkout/PLAN.md', 'file', { readOnly: true })]
          : [];

  it('the rule (pure): inside specs/<slug>/ nothing is writable, the badge says why, and a new name there is refused, for the host too', () => {
    expect(isItemSpecPath('specs/checkout', 'checkout')).toBe(true);
    expect(isItemSpecPath('specs/checkout/reports/cart-api.md', 'checkout')).toBe(true);
    expect(isItemSpecPath('specs/other/SPEC.md', 'checkout')).toBe(false);
    expect(isItemSpecPath('specs', 'checkout')).toBe(false);
    expect(isItemSpecPath('specs/checkout/SPEC.md', undefined)).toBe(false);
    const host = { canWrite: true, isHost: true, itemSlug: 'checkout' };
    expect(isEntryWritable(makeEntry('specs/checkout', 'dir'), 'specs/checkout', host)).toBe(false);
    expect(isEntryWritable(makeEntry('specs/checkout/SPEC.md'), 'specs/checkout/SPEC.md', host)).toBe(false);
    expect(isEntryWritable(makeEntry('specs/other', 'dir'), 'specs/other', host)).toBe(true);
    expect(isEntryWritable(makeEntry('src', 'dir'), 'src', host)).toBe(true);
    // The main workspace (no item): the same folder is everyone's to edit.
    expect(isEntryWritable(makeEntry('specs/checkout', 'dir'), 'specs/checkout', { canWrite: true, isHost: false })).toBe(true);

    const badges = entryBadges(makeEntry('specs/checkout/SPEC.md', 'file', { readOnly: true }), { lock: null, now: T0, selfUserId: 'dev:amy', isHost: true, itemSlug: 'checkout' });
    expect(badges.map((badge) => [badge.kind, badge.label])).toEqual([
      ['item-spec', "Read-only here: the spec and the plan this work item was started from, and the agent's own report. Edit the spec and the plan in the main workspace."],
    ]);
    // Without the item it is the daemon's plain read-only mark.
    expect(entryBadges(makeEntry('data/x.csv', 'file', { readOnly: true }), { lock: null, now: T0, selfUserId: 'dev:amy', isHost: true, itemSlug: 'checkout' }).map((badge) => badge.kind)).toEqual(['read-only']);

    expect(checkNewName('notes.md', 'specs/checkout', [], { isHost: true, itemSlug: 'checkout' })).toEqual({
      ok: false,
      message: "This folder is read-only in a work item's worktree: it holds the spec and the plan the item was started from.",
    });
    expect(checkNewName('notes.md', 'specs/other', [], { isHost: true, itemSlug: 'checkout' })).toEqual({ ok: true, path: 'specs/other/notes.md' });
    expect(checkNewName('notes.md', 'specs/checkout', [], { isHost: true })).toEqual({ ok: true, path: 'specs/checkout/notes.md' });
  });

  it('in the item\'s worktree the folder offers no new file, rename, delete or upload; beside it everything is as usual', async () => {
    const view = await renderFiles({ role: 'host', worktrees: [ITEM_WORKTREE], topics: [TOPIC], entries });
    act(() => view.stores.files.setActiveRoot(WT));
    await view.settle();
    fireEvent.click(screen.getByRole('treeitem', { name: 'specs' }));
    await view.settle();
    const folder = screen.getByRole('treeitem', { name: 'checkout' });
    expect(folder.getAttribute('aria-description')).toMatch(/^Read-only here: the spec and the plan this work item was started from/);
    fireEvent.contextMenu(folder);
    const menu = screen.getByRole('menu', { name: 'Actions for "checkout"' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Download (zip)', 'Copy path']);
    fireEvent.keyDown(menu, { key: 'Escape' });
    // F2 and Delete do nothing there.
    fireEvent.keyDown(folder, { key: 'F2' });
    fireEvent.keyDown(folder, { key: 'Delete' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Another topic's folder in the same worktree is an ordinary folder.
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'other' }));
    const other = within(screen.getByRole('menu', { name: 'Actions for "other"' }))
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(other).toEqual(['New file', 'New folder', 'Upload files…', 'Upload folder…', 'Rename…F2', 'Delete…Delete', 'Download (zip)', 'Copy path']);
  });

  it('the same folder in the main workspace stays editable (people write the spec and the plan there)', async () => {
    const view = await renderFiles({ role: 'editor', worktrees: [ITEM_WORKTREE], topics: [TOPIC], entries: (root, path) => entries(root, path).map((entry) => ({ ...entry, readOnly: false })) });
    await view.settle();
    fireEvent.click(screen.getByRole('treeitem', { name: 'specs' }));
    await view.settle();
    const folder = screen.getByRole('treeitem', { name: 'checkout' });
    expect(folder.getAttribute('aria-description')).toBeNull();
    fireEvent.contextMenu(folder);
    expect(
      within(screen.getByRole('menu', { name: 'Actions for "checkout"' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['New file', 'New folder', 'Upload files…', 'Upload folder…', 'Rename…F2', 'Delete…Delete', 'Download (zip)', 'Copy path']);
  });
});
