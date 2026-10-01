// What the new-session dialog offers per role (ARCHITECTURE §3, §5.5), where a session may run (R9) and the
// session.create payload it builds. Pure logic: the dialog itself is tested in NewSessionDialog.test.tsx.
import { describe, expect, it } from 'vitest';
import type { Role, SessionInfo, WorkspaceInfo } from '@smurg/protocol';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { buildCreatePayload, effectiveWhere, newSessionOptions } from './new-session.ts';

const workspace = (isGitRepo: boolean): WorkspaceInfo => ({ ...makeWelcome().workspace, isGitRepo });
const options = (
  role: Role | null,
  extra: { git?: boolean; userId?: string; worktrees?: Parameters<typeof newSessionOptions>[0]['worktrees']; sessions?: SessionInfo[] } = {},
) =>
  newSessionOptions({
    role,
    userId: role === null ? null : (extra.userId ?? 'dev:amy'),
    workspace: workspace(extra.git ?? true),
    worktrees: extra.worktrees ?? [],
    sessions: new Map((extra.sessions ?? []).map((session) => [session.id, session])),
  });

describe('new session: what each role may open (the daemon decides again)', () => {
  it('the host and 「可使用 agent」 open sessions (they run as the host either way)', () => {
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
  it('a folder that is not a git repository has no worktree choice (with the reason)', () => {
    const plain = options('agent', { git: false, worktrees: [makeWorktree({ kept: true })] });
    expect(plain.worktree).toEqual({ available: false, unavailableReason: 'not-git', kept: [] });
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
    expect(effectiveWhere(options('agent', { git: false }), 'worktree:new')).toBe('main');
  });

  it('builds session.create: main, a new worktree, or a kept one — the same for the host and 可使用 agent', () => {
    const size = { cols: 100, rows: 30 };
    const base = { kind: 'agent' as const, title: '' };
    for (const role of ['host', 'agent'] as const) {
      const opts = options(role, { worktrees: [makeWorktree({ id: 'wt_9', kept: true })] });
      expect(buildCreatePayload(opts, { ...base, where: 'main' }, size)).toEqual({ kind: 'agent', workspace: { mode: 'main' }, cols: 100, rows: 30 });
      expect(buildCreatePayload(opts, { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'worktree' });
      expect(buildCreatePayload(opts, { ...base, where: 'worktree:wt_9' }, size).workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_9' });
    }
    // Not a git repository: whatever the form says, the session runs in the main workspace.
    expect(buildCreatePayload(options('agent', { git: false }), { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'main' });
  });

  it('sends a title only when given (trimmed), and never an API key', () => {
    const size = { cols: 80, rows: 24 };
    expect(buildCreatePayload(options('agent'), { kind: 'agent', where: 'main', title: '  修登入頁 ' }, size)).toEqual({
      kind: 'agent',
      workspace: { mode: 'main' },
      cols: 80,
      rows: 24,
      title: '修登入頁',
    });
    const blank = buildCreatePayload(options('agent'), { kind: 'terminal', where: 'main', title: '   ' }, size);
    expect(blank).not.toHaveProperty('title');
    expect(blank).not.toHaveProperty('apiKey');
  });
});
