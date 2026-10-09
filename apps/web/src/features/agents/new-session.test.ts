// What the new-session dialog offers per role (ARCHITECTURE §3, §5.5), where a session may run (R9) and the
// session.create payload it builds. Pure logic: the dialog itself is tested in NewSessionDialog.test.tsx.
import { describe, expect, it } from 'vitest';
import { SmurgError, worktreeRoot, type MessageRef, type Role, type SessionInfo, type WorkspaceInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { buildCreatePayload, effectiveWhere, isWorktreeRefusal, newSessionOptions, opensInWorktree, refusalNamesRepository, worktreeUnavailableNote } from './new-session.ts';


const workspace = (isGitRepo: boolean): WorkspaceInfo => ({ ...makeWelcome().workspace, isGitRepo });
const options = (
  role: Role | null,
  extra: { git?: boolean; userId?: string; worktrees?: Parameters<typeof newSessionOptions>[0]['worktrees']; sessions?: SessionInfo[]; records?: boolean } = {},
) =>
  newSessionOptions({
    role,
    userId: role === null ? null : (extra.userId ?? 'dev:amy'),
    workspace: workspace(extra.git ?? true),
    worktrees: extra.worktrees ?? [],
    sessions: new Map((extra.sessions ?? []).map((session) => [session.id, session])),
    ...(extra.records === undefined ? {} : { records: extra.records }),
  });

describe('new session: what each role may open (the daemon decides again)', () => {
  it('the host and members with agent access open sessions (they run as the host either way)', () => {
    expect(options('host')).toMatchObject({ canCreate: true, blockedBy: null });
    expect(options('agent')).toMatchObject({ canCreate: true, blockedBy: null });
  });

  it('an editor and a viewer cannot open sessions, and are told why', () => {
    expect(options('editor')).toMatchObject({ canCreate: false, blockedBy: 'role-editor' });
    expect(options('viewer')).toMatchObject({ canCreate: false, blockedBy: 'role-viewer' });
    expect(options(null)).toMatchObject({ canCreate: false, blockedBy: 'not-admitted' });
  });

  it('the options carry nothing about a sandbox or a login of the member', () => {
    expect(Object.keys(options('agent')).sort()).toEqual(['blockedBy', 'canCreate', 'worktree']);
  });
});

describe('new session: where it runs (R9)', () => {
  it('a folder that is not a git repository (as far as the page knows): no kept worktree, the reason as a note, a new worktree still offered', () => {
    const plain = options('agent', { git: false });
    expect(plain.worktree).toEqual({ available: false, unavailableReason: 'not-git', kept: [] });
    // The reason in the host's own words (the Start dialog's blocker, a worktree refusal), with what the host can do.
    expect(worktreeUnavailableNote('not-git')).toBe(
      'The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.',
    );
    expect(options('agent').worktree.unavailableReason).toBeNull();
  });

  // 0.5.2 (the last fixes): the note says "run git init". Where a worktree or an open merge request exists that is
  // never right: the folder is a repository the page has not heard of yet, or its `.git` went (the host says "put it
  // back"). The page then says nothing of its own, and the host answers.
  it('never the "run git init" note while a worktree or an open merge request exists; a kept worktree stays hidden until the page knows the folder is a repository', () => {
    const withWorktree = options('agent', { git: false, worktrees: [makeWorktree({ kept: true })] });
    expect(withWorktree.worktree).toEqual({ available: false, unavailableReason: null, kept: [] });
    // An open merge request alone (its worktree removed): what the page's store of worktrees says (`records`).
    expect(options('agent', { git: false, records: true }).worktree).toEqual({ available: false, unavailableReason: null, kept: [] });
    expect(options('agent', { git: false, records: false }).worktree.unavailableReason).toBe('not-git');
    expect(options('agent', { git: true, records: true }).worktree).toMatchObject({ available: true, unavailableReason: null });
  });

  // 0.5.2 (the closing fixes): only a reason that names what a REPOSITORY lacks says the folder is one. Before, every
  // reason but the two "no repository" ones did, so a folder that was none was taken for a repository when the host
  // said "git was not found" (the host names git first, whatever the folder is).
  it("what the host's answer says about the folder: a session in a worktree, or a refusal that names what a repository lacks, means it is a git repository; nothing else does", () => {
    expect(opensInWorktree(makeSession({ root: worktreeRoot('wt_new') }))).toBe(true);
    expect(opensInWorktree(makeSession())).toBe(false);

    const refused = (text: MessageRef): SmurgError => new SmurgError('conflict', text, { reason: 'x' });
    // The folder is a repository, something else is missing: a first commit, an ordinary `.git`, the worktrees folder.
    const repository = [msg('worktree.unavailable.noCommit'), msg('worktree.unavailable.gitDirNotDirectory'), msg('worktree.unavailable.worktreesDirUnusable')];
    for (const text of repository) expect(refusalNamesRepository(refused(text)), text.id).toBe(true);
    // Reasons that say nothing about the folder: git itself (named first, whatever the folder is), a look that
    // failed, a host that is still starting.
    const silent = [
      msg('worktree.unavailable.gitTooOld', { version: '2.39.5', minVersion: '2.42.0' }),
      msg('worktree.unavailable.gitNotFound', { minVersion: '2.42.0' }),
      msg('worktree.unavailable.gitCannotRun'),
      msg('worktree.unavailable.checkFailed'),
      msg('worktree.unavailable.starting'),
    ];
    for (const text of silent) expect(refusalNamesRepository(refused(text)), text.id).toBe(false);
    // The two that say the folder is none: nothing at `.git`, and a `.git` that went.
    const none = [msg('worktree.unavailable.notAGitRepo'), msg('worktree.unavailable.gitDirGone')];
    for (const text of none) expect(refusalNamesRepository(refused(text)), text.id).toBe(false);
    // Anything else says nothing about the folder: another refusal, an error without a reference, no error at all.
    expect(refusalNamesRepository(refused(msg('session.limit')))).toBe(false);
    expect(refusalNamesRepository(refused(msg('worktree.limit')))).toBe(false);
    expect(refusalNamesRepository(new SmurgError('internal', 'not now'))).toBe(false);
    expect(refusalNamesRepository(new Error('worktree.unavailable.noCommit'))).toBe(false);
    expect(refusalNamesRepository(undefined)).toBe(false);

    // Every one of the host's worktree reasons stands alone in the dialog (the page's own note is not shown beside
    // it); another refusal does not hide the note.
    for (const text of [...repository, ...silent, ...none]) expect(isWorktreeRefusal(refused(text)), text.id).toBe(true);
    expect(isWorktreeRefusal(refused(msg('session.limit')))).toBe(false);
    expect(isWorktreeRefusal(refused(msg('worktree.limit')))).toBe(false);
    expect(isWorktreeRefusal(new SmurgError('internal', 'not now'))).toBe(false);
    expect(isWorktreeRefusal(new Error('worktree.unavailable.noCommit'))).toBe(false);
    expect(isWorktreeRefusal(undefined)).toBe(false);
  });

  it('offers only MY kept worktrees that no running session uses, newest first', () => {
    const mine = makeWorktree({ id: 'wt_old', kept: true, createdAt: 1 });
    const newer = makeWorktree({ id: 'wt_new', kept: true, createdAt: 2, sessionId: 'sess_done' });
    const busy = makeWorktree({ id: 'wt_busy', kept: true, sessionId: 'sess_live' });
    const notKept = makeWorktree({ id: 'wt_temp', kept: false });
    const others = makeWorktree({ id: 'wt_bob', kept: true, ownerUserId: 'dev:bob', ownerName: 'Bob' });
    const sessions = [makeSession({ id: 'sess_done', status: 'exited' }), makeSession({ id: 'sess_live', status: 'running' })];
    const result = options('agent', { worktrees: [mine, newer, busy, notKept, others], sessions });
    expect(result.worktree.available).toBe(true);
    expect(result.worktree.kept.map((worktree) => worktree.id)).toEqual(['wt_new', 'wt_old']);
  });

  it('a choice that is gone falls back to the main workspace', () => {
    const agent = options('agent', { worktrees: [makeWorktree({ id: 'wt_9', kept: true })] });
    expect(effectiveWhere(agent, 'main')).toBe('main');
    expect(effectiveWhere(agent, 'worktree:new')).toBe('worktree:new');
    expect(effectiveWhere(agent, 'worktree:wt_9')).toBe('worktree:wt_9');
    expect(effectiveWhere(agent, 'worktree:wt_gone')).toBe('main');
    // The page may not know yet that the folder became a repository (a workspace without a topic): the host decides.
    expect(effectiveWhere(options('agent', { git: false }), 'worktree:new')).toBe('worktree:new');
    expect(effectiveWhere(options('agent', { git: false, worktrees: [makeWorktree({ id: 'wt_9', kept: true })] }), 'worktree:wt_9')).toBe('main');
  });

  it('builds session.create: main, a new worktree, or a kept one — the same for the host and members with agent access', () => {
    const size = { cols: 100, rows: 30 };
    const base = { kind: 'agent' as const, title: '' };
    for (const role of ['host', 'agent'] as const) {
      const opts = options(role, { worktrees: [makeWorktree({ id: 'wt_9', kept: true })] });
      // An agent session is a conversation: no terminal size. A terminal carries the viewer's best guess.
      expect(buildCreatePayload(opts, { ...base, where: 'main' }, size)).toEqual({ kind: 'agent', workspace: { mode: 'main' } });
      expect(buildCreatePayload(opts, { kind: 'terminal', title: '', where: 'main' }, size)).toEqual({ kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
      expect(buildCreatePayload(opts, { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'worktree' });
      expect(buildCreatePayload(opts, { ...base, where: 'worktree:wt_9' }, size).workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_9' });
    }
    // Not a git repository as far as the page knows: a new worktree is still asked for (the host looks again and
    // refuses with the reason); a kept worktree is not offered, so the session runs in the main workspace.
    expect(buildCreatePayload(options('agent', { git: false }), { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'worktree' });
    expect(buildCreatePayload(options('agent', { git: false, worktrees: [makeWorktree({ id: 'wt_9', kept: true })] }), { ...base, where: 'worktree:wt_9' }, size).workspace).toEqual({ mode: 'main' });
  });

  it('sends a title only when given (trimmed), and never an API key', () => {
    const size = { cols: 80, rows: 24 };
    expect(buildCreatePayload(options('agent'), { kind: 'agent', where: 'main', title: '  fix the login page ' }, size)).toEqual({
      kind: 'agent',
      workspace: { mode: 'main' },
      title: 'fix the login page',
    });
    expect(buildCreatePayload(options('agent'), { kind: 'terminal', where: 'main', title: ' build ' }, size)).toEqual({
      kind: 'terminal',
      workspace: { mode: 'main' },
      cols: 80,
      rows: 24,
      title: 'build',
    });
    const blank = buildCreatePayload(options('agent'), { kind: 'terminal', where: 'main', title: '   ' }, size);
    expect(blank).not.toHaveProperty('title');
    expect(blank).not.toHaveProperty('apiKey');
  });
});
