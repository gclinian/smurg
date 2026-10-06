import { MAIN_ROOT, rootRefKey, type FileEntry, type LockInfo } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import type { DirListing, FilesState } from '../../lib/stores/files.ts';
import { HOST_USER, T0, makeAgentLock, makeEntry, makeHumanLock, makeMember } from '../../testing/fixtures.ts';
import { INITIAL_LOCKS_STATE } from '../../lib/stores/locks.ts';
import { INITIAL_PRESENCE_STATE } from '../../lib/stores/presence.ts';
import { RECENT_CHANGE_MS, ancestorsOf, checkNewName, entryBadges, flattenTree, isEntryWritable, peopleUsing, targetDirOf } from './tree-model.ts';

function listing(path: string, entries: FileEntry[], overrides: Partial<DirListing> = {}): DirListing {
  return { root: MAIN_ROOT, path, status: 'ready', entries, truncated: false, error: null, ...overrides };
}

function stateOf(...dirs: DirListing[]): FilesState {
  return { activeRoot: MAIN_ROOT, trees: new Map([[rootRefKey(MAIN_ROOT), { root: MAIN_ROOT, dirs: new Map(dirs.map((d) => [d.path, d])) }]]) };
}

const badgeCtx = { lock: undefined, now: T0, selfUserId: 'dev:amy', isHost: false };

describe('flattenTree: the visible rows of a lazily loaded tree', () => {
  it('folders first, the collation of the language with numbers compared numerically, children right under their expanded folder', () => {
    const state = stateOf(
      listing('', [makeEntry('b.txt'), makeEntry('src', 'dir'), makeEntry('檔案10.md'), makeEntry('檔案2.md'), makeEntry('docs', 'dir')]),
      listing('src', [makeEntry('src/main.ts'), makeEntry('src/lib', 'dir')]),
    );
    const rows = flattenTree(state, MAIN_ROOT, new Set(['src']));
    expect(rows.map((r) => [r.path, r.level, r.kind])).toEqual([
      ['docs', 1, 'entry'],
      ['src', 1, 'entry'],
      ['src/lib', 2, 'entry'],
      ['src/main.ts', 2, 'entry'],
      // English collation (the files store's sortEntries) puts Latin before Han; zh-TW does the opposite
      // (FilesPanel.zh-TW.test.tsx).
      ['b.txt', 1, 'entry'],
      ['檔案2.md', 1, 'entry'],
      ['檔案10.md', 1, 'entry'],
    ]);
    expect(rows.find((r) => r.path === 'src')).toMatchObject({ expanded: true, posInSet: 2, setSize: 5 });
    expect(rows.find((r) => r.path === 'docs')).toMatchObject({ expanded: false });
  });

  it("a worktree's shared folders (symlinks, D12) are read-only folders that expand; other links stay links", () => {
    const state = stateOf(
      listing('', [makeEntry('data', 'symlink'), makeEntry('other-link', 'symlink'), makeEntry('src', 'dir')]),
      listing('data', [makeEntry('data/train.csv', 'file', { readOnly: true })]),
    );
    const rows = flattenTree(state, MAIN_ROOT, new Set(['data']), new Set(['data']));
    expect(rows.map((r) => [r.path, r.entry?.kind, r.expanded])).toEqual([
      ['data', 'dir', true],
      ['data/train.csv', 'file', false],
      ['src', 'dir', false],
      ['other-link', 'symlink', false],
    ]);
    expect(rows[0]?.entry?.readOnly).toBe(true);
    expect(entryBadges(rows[0]!.entry!, badgeCtx).map((b) => b.kind)).toEqual(['read-only']);
  });

  it('an expanded folder shows loading, error, empty and truncated states as rows of its own level', () => {
    const state = stateOf(
      listing('', [makeEntry('a', 'dir'), makeEntry('b', 'dir'), makeEntry('c', 'dir'), makeEntry('d', 'dir')]),
      listing('b', [], { status: 'error', error: 'Not found' }),
      listing('c', []),
      listing('d', [makeEntry('d/x')], { truncated: true }),
    );
    const rows = flattenTree(state, MAIN_ROOT, new Set(['a', 'b', 'c', 'd']));
    expect(rows.filter((r) => r.kind !== 'entry').map((r) => [r.kind, r.path, r.level])).toEqual([
      ['loading', 'a', 2],
      ['error', 'b', 2],
      ['empty', 'c', 2],
      ['truncated', 'd', 2],
    ]);
  });

  it('keeps showing the previous entries while a folder is re-listed (no flash of an empty tree)', () => {
    const state = stateOf(listing('', [makeEntry('a.ts')], { status: 'loading' }));
    expect(flattenTree(state, MAIN_ROOT, new Set()).map((r) => r.path)).toEqual(['a.ts']);
  });
});

describe('targets and ancestors', () => {
  it('a file targets its folder, a folder itself, nothing the root', () => {
    expect(targetDirOf(null)).toBe('');
    expect(targetDirOf({ kind: 'entry', path: 'src/a.ts', entry: makeEntry('src/a.ts') })).toBe('src');
    expect(targetDirOf({ kind: 'entry', path: 'src', entry: makeEntry('src', 'dir') })).toBe('src');
    expect(targetDirOf({ kind: 'entry', path: 'top.md', entry: makeEntry('top.md') })).toBe('');
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('c.ts')).toEqual([]);
  });
});

describe('what the member may do (UI hiding only; the daemon enforces)', () => {
  it('viewers never write; read-only entries and host-only paths are not writable for guests; the host may write host-only paths', () => {
    const editor = { canWrite: true, isHost: false };
    expect(isEntryWritable(makeEntry('a.ts'), 'a.ts', { canWrite: false, isHost: false })).toBe(false);
    expect(isEntryWritable(null, '', { canWrite: false, isHost: false })).toBe(false);
    expect(isEntryWritable(makeEntry('data/x.csv', 'file', { readOnly: true }), 'data/x.csv', editor)).toBe(false);
    expect(isEntryWritable(makeEntry('.claude/settings.json'), '.claude/settings.json', editor)).toBe(false);
    expect(isEntryWritable(makeEntry('src/.vscode', 'dir'), 'src/.vscode', editor)).toBe(false);
    expect(isEntryWritable(makeEntry('.claude/settings.json'), '.claude/settings.json', { canWrite: true, isHost: true })).toBe(true);
    expect(isEntryWritable(makeEntry('src/a.ts'), 'src/a.ts', editor)).toBe(true);
    expect(isEntryWritable(null, '', editor)).toBe(true);
  });
});

describe('badges: locked by a person / being changed by an agent / recently changed by whom', () => {
  it('an agent lock names the agent', () => {
    const badges = entryBadges(makeEntry('src/app.ts'), { ...badgeCtx, lock: makeAgentLock('src/app.ts') });
    expect(badges).toEqual([
      { kind: 'agent-lock', text: 'Claude (Ian) editing', label: 'Claude (Ian) is editing this file; it cannot be edited for now' },
    ]);
  });

  it('a shared human lock names every holder, the local member as "you"', () => {
    const lock: LockInfo = {
      kind: 'human',
      file: { root: MAIN_ROOT, path: 'a.ts' },
      holders: [
        { userId: 'dev:amy', displayName: 'Amy', lastActivityAt: T0 },
        { userId: 'dev:bob', displayName: 'Bob', lastActivityAt: T0 },
      ],
      acquiredAt: T0,
    };
    const [badge] = entryBadges(makeEntry('a.ts'), { ...badgeCtx, lock });
    expect(badge).toMatchObject({ kind: 'human-lock', text: 'Editing: you, Bob' });
    expect(badge?.label).toContain('agents cannot change it for now');
  });

  it('the live lock wins over the (older) lock the listing carried; null means "no lock any more"', () => {
    const entry = makeEntry('a.ts', 'file', { lock: makeHumanLock('a.ts') });
    expect(entryBadges(entry, { ...badgeCtx, lock: undefined }).map((b) => b.kind)).toEqual(['human-lock']);
    expect(entryBadges(entry, { ...badgeCtx, lock: null })).toEqual([]);
  });

  it('recently changed: by whom and when, for RECENT_CHANGE_MS; not while an agent holds the file', () => {
    const agent = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude (Ian)' };
    const entry = makeEntry('a.ts', 'file', { mtime: T0 - 3 * 60_000, lastModifiedBy: agent });
    const [recent] = entryBadges(entry, badgeCtx);
    expect(recent).toEqual({ kind: 'recent', text: 'Claude (Ian)', label: 'Recently changed by Claude (Ian) (3 minutes ago)' });
    expect(entryBadges(makeEntry('a.ts', 'file', { mtime: T0 - RECENT_CHANGE_MS, lastModifiedBy: agent }), badgeCtx)).toEqual([]);
    expect(entryBadges(entry, { ...badgeCtx, lock: makeAgentLock('a.ts') }).map((b) => b.kind)).toEqual(['agent-lock']);
    const mine = makeEntry('b.ts', 'file', { mtime: T0, lastModifiedBy: { kind: 'user', userId: 'dev:amy', displayName: 'Amy' } });
    expect(entryBadges(mine, badgeCtx)[0]?.text).toBe('you');
    const external = makeEntry('c.ts', 'file', { mtime: T0, lastModifiedBy: { kind: 'system' } });
    expect(entryBadges(external, badgeCtx)[0]?.label).toContain('an outside program');
  });

  it('read-only entries and (for guests) host-only paths are marked', () => {
    expect(entryBadges(makeEntry('data', 'dir', { readOnly: true }), badgeCtx).map((b) => b.kind)).toEqual(['read-only']);
    expect(entryBadges(makeEntry('.mcp.json'), badgeCtx).map((b) => b.kind)).toEqual(['host-only']);
    // The daemon sends host-only paths as readOnly to guests: still "Only the host can change this file", never "shared folder".
    expect(entryBadges(makeEntry('.git', 'dir', { readOnly: true }), badgeCtx).map((b) => [b.kind, b.label])).toEqual([['host-only', 'Only the host can change this file']]);
    expect(entryBadges(makeEntry('.mcp.json'), { ...badgeCtx, isHost: true })).toEqual([]);
  });
});

describe('checkNewName: validation as you type (the daemon validates again)', () => {
  const guest = { isHost: false };
  it('accepts a normal CJK name and joins it to the folder', () => {
    expect(checkNewName('筆記.md', 'docs', [], guest)).toEqual({ ok: true, path: 'docs/筆記.md' });
    expect(checkNewName('README.md', '', [], guest)).toEqual({ ok: true, path: 'README.md' });
  });

  it('refuses empty names, slashes, dot names, control and bidi characters, backslashes', () => {
    for (const [name, message] of [
      ['  ', 'Enter a name'],
      ['a/b', 'A name cannot contain "/"'],
      ['..', 'A name cannot be "." or ".."'],
      ['a\u0007b', 'A name cannot contain control characters or invisible direction characters'],
      ['evil‮txt.exe', 'A name cannot contain control characters or invisible direction characters'],
      ['a\\b', 'A name cannot contain "\\"'],
    ] as const) {
      expect(checkNewName(name, '', [], guest)).toEqual({ ok: false, message });
    }
  });

  it('refuses a name that exists in any case (the host disk may be case-insensitive), except the entry being renamed', () => {
    expect(checkNewName('readme.MD', '', ['README.md'], guest)).toMatchObject({ ok: false, message: expect.stringContaining('already has an item with this name') });
    expect(checkNewName('Readme.md', '', ['README.md'], { isHost: false, current: 'README.md' })).toEqual({ ok: true, path: 'Readme.md' });
    expect(checkNewName('README.md', '', ['README.md'], { isHost: false, current: 'README.md' })).toMatchObject({ ok: false, message: 'The name has not changed' });
  });

  it('refuses host-only names for guests (at any depth), allows them for the host', () => {
    expect(checkNewName('.claude', 'src', [], guest)).toMatchObject({ ok: false, message: 'Only the host can create or change a file with this name' });
    expect(checkNewName('.mcp.json', '', [], guest)).toMatchObject({ ok: false });
    expect(checkNewName('.mcp.json', '', [], { isHost: true })).toEqual({ ok: true, path: '.mcp.json' });
  });
});

describe('peopleUsing: who a delete confirmation names', () => {
  const at = (path: string) => ({ root: MAIN_ROOT, path });
  const agent = (sessionId: string, name: string, status: 'running' | 'waiting-permission' | 'idle' | 'done' | 'stalled', path: string) => ({ sessionId, ownerUserId: HOST_USER, displayName: name, color: '#22c55e', status, activeFile: at(path) });

  it('names the others who have the file open and the agents at work on it, not an agent whose last file it was', () => {
    const presence = {
      ...INITIAL_PRESENCE_STATE,
      received: true,
      members: [
        { ...makeMember({ userId: 'dev:mei', displayName: 'Mei' }), connections: 1, activeFile: at('src/cart.ts') },
        { ...makeMember({ userId: 'dev:amy', displayName: 'Amy' }), connections: 1, activeFile: at('src/cart.ts') },
      ],
      agents: [
        agent('s_run', 'Claude (Ian)', 'running', 'src/cart.ts'),
        agent('s_wait', 'Claude (Mei)', 'waiting-permission', 'src/cart.ts'),
        // The presence list keeps an agent's last file while its session lives: these three work on nothing now.
        agent('s_idle', 'Claude (Leo)', 'idle', 'src/cart.ts'),
        agent('s_done', 'Claude (Amy)', 'done', 'src/cart.ts'),
        agent('s_stalled', 'Claude (Bob)', 'stalled', 'src/cart.ts'),
      ],
    };
    expect(peopleUsing(presence, INITIAL_LOCKS_STATE, MAIN_ROOT, 'src/cart.ts', 'dev:amy')).toEqual(['Mei', 'Claude (Ian)', 'Claude (Mei)']);
    // A folder: anything below it.
    expect(peopleUsing(presence, INITIAL_LOCKS_STATE, MAIN_ROOT, 'src', 'dev:amy')).toEqual(['Mei', 'Claude (Ian)', 'Claude (Mei)']);
    expect(peopleUsing(presence, INITIAL_LOCKS_STATE, MAIN_ROOT, 'docs', 'dev:amy')).toEqual([]);
  });
});
