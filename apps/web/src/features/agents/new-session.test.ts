// What the new-session dialog offers per role (ARCHITECTURE §3, §5.5), where a session may run (R9) and the
// session.create payload it builds. Pure logic: the dialog itself is tested in NewSessionDialog.test.tsx.
//
// 0.6.0 on purpose (DESIGN D14, D18): whether worktrees are offered follows how work items run (`HostState.work`),
// not whether the folder has a `.git`: a folder without one gets smurg's own history, so the "run git init" note of
// 0.5.2 is gone; without the git program none is offered, and before the host's smurg looked for git a teammate is
// not offered one.
import { describe, expect, it } from 'vitest';
import { SmurgError, worktreeRoot, type MessageRef, type Role, type SessionInfo, type WorkState } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { makeSession, makeWorktree } from '../../testing/fixtures.ts';
import { buildCreatePayload, effectiveWhere, isWorktreeRefusal, newSessionOptions, opensInWorktree, refusalNamesRepository, worktreeUnavailableNote } from './new-session.ts';

const GIT_TOO_OLD = msg('worktree.unavailable.gitTooOld', { version: '2.39.5', minVersion: '2.42.0' });
const DIRECT: WorkState = { history: 'direct', reason: { text: GIT_TOO_OLD, fallback: renderEnglish(GIT_TOO_OLD) } };

const options = (
  role: Role | null,
  extra: { work?: WorkState | null; userId?: string; worktrees?: Parameters<typeof newSessionOptions>[0]['worktrees']; sessions?: SessionInfo[] } = {},
) =>
  newSessionOptions({
    role,
    userId: role === null ? null : (extra.userId ?? 'dev:amy'),
    work: extra.work === undefined ? { history: 'folder' } : extra.work,
    worktrees: extra.worktrees ?? [],
    sessions: new Map((extra.sessions ?? []).map((session) => [session.id, session])),
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
  it('the folder\'s own git and smurg\'s own history: worktrees are offered, with no note', () => {
    for (const history of ['folder', 'smurg'] as const) {
      for (const role of ['host', 'agent'] as const) {
        expect(options(role, { work: { history } }).worktree, `${history} ${role}`).toEqual({ available: true, unavailable: null, kept: [] });
      }
    }
    // Before the host's first answer the page knows nothing: offered (the host's answer settles it).
    expect(options('agent', { work: null }).worktree).toMatchObject({ available: true, unavailable: null });
  });

  it("without the git program none is offered, a kept one neither, and the note is the host's own sentence", () => {
    const direct = options('agent', { work: DIRECT, worktrees: [makeWorktree({ kept: true })] });
    expect(direct.worktree).toEqual({ available: false, unavailable: DIRECT.reason, kept: [] });
    expect(worktreeUnavailableNote(direct.worktree.unavailable ?? DIRECT.reason!)).toBe(renderEnglish(GIT_TOO_OLD));
    expect(options('host', { work: DIRECT }).worktree.available).toBe(false);
  });

  it('before the host\'s smurg looked for git: the host is offered a worktree, a teammate is not and is told when', () => {
    expect(options('host', { work: { history: 'unchecked' } }).worktree).toEqual({ available: true, unavailable: null, kept: [] });
    const teammate = options('agent', { work: { history: 'unchecked' }, worktrees: [makeWorktree({ kept: true })] });
    expect(teammate.worktree.available).toBe(false);
    expect(teammate.worktree.unavailable?.text).toEqual(msg('worktree.unavailable.unchecked'));
    expect(worktreeUnavailableNote(teammate.worktree.unavailable!)).toBe(
      "smurg has not checked git on the host's computer yet. Once the host has opened a topic's Start dialog or created a worktree, you can create one.",
    );
    // A kept worktree of one's own is a record of a repository git ran in: it can be continued.
    expect(teammate.worktree.kept).toHaveLength(1);
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
    // Not offered (no git program; a teammate before the host's smurg looked for git): the main workspace.
    expect(effectiveWhere(options('agent', { work: DIRECT }), 'worktree:new')).toBe('main');
    expect(effectiveWhere(options('agent', { work: DIRECT, worktrees: [makeWorktree({ id: 'wt_9', kept: true })] }), 'worktree:wt_9')).toBe('main');
    expect(effectiveWhere(options('agent', { work: { history: 'unchecked' } }), 'worktree:new')).toBe('main');
    expect(effectiveWhere(options('host', { work: { history: 'unchecked' } }), 'worktree:new')).toBe('worktree:new');
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
    // A folder without `.git` (smurg's own history): a new worktree is asked for. Without git: the main workspace.
    expect(buildCreatePayload(options('agent', { work: { history: 'smurg' } }), { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'worktree' });
    expect(buildCreatePayload(options('agent', { work: DIRECT }), { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'main' });
  });

  it('an agent session carries its model and its own mode only when chosen (protocol 5); a terminal never', () => {
    const size = { cols: 100, rows: 30 };
    const opts = options('agent');
    expect(buildCreatePayload(opts, { kind: 'agent', where: 'main', title: '', model: null, permissionMode: null }, size)).toEqual({ kind: 'agent', workspace: { mode: 'main' } });
    expect(buildCreatePayload(opts, { kind: 'agent', where: 'main', title: '', model: 'sonnet', permissionMode: 'ask-commands' }, size)).toEqual({
      kind: 'agent',
      workspace: { mode: 'main' },
      model: 'sonnet',
      permissionMode: 'ask-commands',
    });
    expect(buildCreatePayload(opts, { kind: 'terminal', where: 'main', title: '', model: 'sonnet', permissionMode: 'auto' }, size)).toEqual({ kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
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
