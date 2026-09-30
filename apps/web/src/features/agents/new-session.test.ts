// What the new-session dialog offers per role (SPEC §8, ARCHITECTURE §5.5), where a session may run (R9) and the
// session.create payload it builds. Pure logic: the dialog itself is tested in NewSessionDialog.test.tsx.
import { describe, expect, it } from 'vitest';
import type { Role, SessionInfo, WorkspaceInfo } from '@smurg/protocol';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { apiKeyApplies, apiKeyProblem, buildCreatePayload, newSessionOptions } from './new-session.ts';

const workspace = (isGitRepo: boolean): WorkspaceInfo => ({ ...makeWelcome().workspace, isGitRepo });
const options = (role: Role | null, extra: { git?: boolean; userId?: string; worktrees?: Parameters<typeof newSessionOptions>[0]['worktrees']; sessions?: SessionInfo[] } = {}) =>
  newSessionOptions({
    role,
    userId: role === null ? null : (extra.userId ?? 'dev:amy'),
    workspace: workspace(extra.git ?? true),
    worktrees: extra.worktrees ?? [],
    sessions: new Map((extra.sessions ?? []).map((session) => [session.id, session])),
  });

describe('new session: what each role may open (the daemon decides again)', () => {
  it('the host opens an unsandboxed host session', () => {
    expect(options('host')).toMatchObject({ canCreate: true, blockedBy: null, sandboxed: false });
  });

  it('a runner opens a sandboxed session and may bring an API key for an agent (never for a terminal)', () => {
    const runner = options('runner');
    expect(runner).toMatchObject({ canCreate: true, blockedBy: null, sandboxed: true });
    expect(apiKeyApplies(runner, 'agent')).toBe(true);
    expect(apiKeyApplies(runner, 'terminal')).toBe(false);
    expect(apiKeyApplies(options('host'), 'agent')).toBe(false);
  });

  it('an editor and a viewer cannot open sessions, and are told why', () => {
    expect(options('editor')).toMatchObject({ canCreate: false, blockedBy: 'role-editor', sandboxed: null });
    expect(options('viewer')).toMatchObject({ canCreate: false, blockedBy: 'role-viewer', sandboxed: null });
    expect(options(null)).toMatchObject({ canCreate: false, blockedBy: 'not-admitted', sandboxed: null });
  });
});

describe('new session: where it runs (R9)', () => {
  it('a folder that is not a git repository has no worktree choice (with the reason)', () => {
    const plain = options('runner', { git: false, worktrees: [makeWorktree({ kept: true })] });
    expect(plain.worktree).toEqual({ available: false, unavailableReason: 'not-git', kept: [] });
  });

  it('offers only MY kept worktrees that no running session uses, newest first', () => {
    const mine = makeWorktree({ id: 'wt_old', kept: true, createdAt: 1 });
    const newer = makeWorktree({ id: 'wt_new', kept: true, createdAt: 2, sessionId: 'sess_done' });
    const busy = makeWorktree({ id: 'wt_busy', kept: true, sessionId: 'sess_live' });
    const notKept = makeWorktree({ id: 'wt_temp', kept: false });
    const others = makeWorktree({ id: 'wt_bob', kept: true, ownerUserId: 'dev:bob', ownerName: 'Bob' });
    const sessions = [makeSession({ id: 'sess_done', status: 'exited' }), makeSession({ id: 'sess_live', status: 'running' })];
    const result = options('runner', { worktrees: [mine, newer, busy, notKept, others], sessions });
    expect(result.worktree.available).toBe(true);
    expect(result.worktree.kept.map((worktree) => worktree.id)).toEqual(['wt_new', 'wt_old']);
  });

  it('builds session.create: main, a new worktree, or a kept one; never a sandbox flag', () => {
    const runner = options('runner', { worktrees: [makeWorktree({ id: 'wt_9', kept: true })] });
    const size = { cols: 100, rows: 30 };
    const base = { kind: 'agent' as const, title: '', apiKey: '' };
    expect(buildCreatePayload(runner, { ...base, where: 'main' }, size)).toEqual({ kind: 'agent', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    expect(buildCreatePayload(runner, { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'worktree' });
    expect(buildCreatePayload(runner, { ...base, where: 'worktree:wt_9' }, size).workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_9' });
    // Not a git repository: whatever the form says, the session runs in the main workspace.
    const plain = options('runner', { git: false });
    expect(buildCreatePayload(plain, { ...base, where: 'worktree:new' }, size).workspace).toEqual({ mode: 'main' });
    for (const payload of [buildCreatePayload(runner, { ...base, where: 'main' }, size), buildCreatePayload(options('host'), { ...base, where: 'main' }, size)]) {
      expect(Object.keys(payload)).not.toContain('sandboxed');
    }
  });

  it('sends the API key only for a runner\'s agent session, trimmed; a title only when given', () => {
    const size = { cols: 80, rows: 24 };
    const withKey = { where: 'main' as const, title: '  修登入頁 ', apiKey: '  sk-ant-test-key ' };
    expect(buildCreatePayload(options('runner'), { ...withKey, kind: 'agent' }, size)).toMatchObject({ apiKey: 'sk-ant-test-key', title: '修登入頁' });
    expect(buildCreatePayload(options('runner'), { ...withKey, kind: 'terminal' }, size)).not.toHaveProperty('apiKey');
    expect(buildCreatePayload(options('host'), { ...withKey, kind: 'agent' }, size)).not.toHaveProperty('apiKey');
    expect(buildCreatePayload(options('runner'), { ...withKey, title: '   ', apiKey: '', kind: 'agent' }, size)).not.toHaveProperty('title');
  });

  it('checks the API key format before anything is sent', () => {
    expect(apiKeyProblem('')).toBeNull();
    expect(apiKeyProblem('sk-ant-api03-abc_DEF-123')).toBeNull();
    expect(apiKeyProblem('has space')).toBe('invalid');
    expect(apiKeyProblem('x'.repeat(257))).toBe('invalid');
    expect(apiKeyProblem('中文')).toBe('invalid');
  });
});
