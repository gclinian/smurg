// What the new-session dialog offers per role (SPEC §8, ARCHITECTURE §5.5), where a session may run (R9) and the
// session.create payload it builds. Pure logic: the dialog itself is tested in NewSessionDialog.test.tsx.
import { describe, expect, it } from 'vitest';
import type { Role, SessionInfo, WorkspaceInfo } from '@smurg/protocol';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import {
  apiKeyApplies,
  apiKeyProblem,
  buildCreatePayload,
  defaultWhere,
  effectiveWhere,
  guestSessionsOff,
  keptOutOfMain,
  newSessionOptions,
} from './new-session.ts';

const workspace = (isGitRepo: boolean): WorkspaceInfo => ({ ...makeWelcome().workspace, isGitRepo });
const options = (
  role: Role | null,
  extra: { git?: boolean; userId?: string; worktrees?: Parameters<typeof newSessionOptions>[0]['worktrees']; sessions?: SessionInfo[]; guestMainWorkspace?: boolean } = {},
) =>
  newSessionOptions({
    role,
    userId: role === null ? null : (extra.userId ?? 'dev:amy'),
    workspace: workspace(extra.git ?? true),
    worktrees: extra.worktrees ?? [],
    sessions: new Map((extra.sessions ?? []).map((session) => [session.id, session])),
    ...(extra.guestMainWorkspace !== undefined ? { guestMainWorkspace: extra.guestMainWorkspace } : {}),
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

describe('new session: a host that keeps guests out of the main workspace (PublicSettings.guestMainWorkspace, ARCHITECTURE §11 D-14)', () => {
  const size = { cols: 100, rows: 30 };
  const base = { kind: 'agent' as const, title: '', apiKey: '' };

  it('undefined (an older daemon) and true leave everything as it was: the main workspace is offered and preselected', () => {
    for (const guestMainWorkspace of [undefined, true]) {
      const runner = options('runner', guestMainWorkspace === undefined ? {} : { guestMainWorkspace });
      expect(runner).toMatchObject({ canCreate: true, blockedBy: null, sandboxed: true, main: { available: true, unavailableReason: null } });
      expect(defaultWhere(runner)).toBe('main');
      expect(buildCreatePayload(runner, { ...base, where: 'main' }, size).workspace).toEqual({ mode: 'main' });
      const plain = options('runner', { git: false, ...(guestMainWorkspace === undefined ? {} : { guestMainWorkspace }) });
      expect(plain).toMatchObject({ canCreate: true, main: { available: true } });
    }
  });

  it('false, git share: a guest gets worktrees only — main unavailable with the reason, a new worktree preselected, never a main-mode request', () => {
    const runner = options('runner', { guestMainWorkspace: false, worktrees: [makeWorktree({ id: 'wt_9', kept: true })] });
    expect(runner).toMatchObject({ canCreate: true, blockedBy: null, sandboxed: true, main: { available: false, unavailableReason: 'host-off' } });
    expect(runner.worktree).toMatchObject({ available: true, unavailableReason: null });
    expect(defaultWhere(runner)).toBe('worktree:new');
    // A form still at its initial 「共享主工作區」 (or anything forged) becomes the guest's own new worktree.
    expect(effectiveWhere(runner, 'main')).toBe('worktree:new');
    expect(effectiveWhere(runner, 'worktree:wt_9')).toBe('worktree:wt_9');
    expect(effectiveWhere(runner, 'worktree:wt_gone')).toBe('worktree:new');
    expect(buildCreatePayload(runner, { ...base, where: 'main' }, size).workspace).toEqual({ mode: 'worktree' });
    expect(buildCreatePayload(runner, { ...base, kind: 'terminal', where: 'main' }, size).workspace).toEqual({ mode: 'worktree' });
    expect(buildCreatePayload(runner, { ...base, where: 'worktree:wt_9' }, size).workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_9' });
    // The API key still applies to the guest's agent (it is their own login, wherever the session runs).
    expect(apiKeyApplies(runner, 'agent')).toBe(true);
  });

  it('false, a share that is not git: a guest cannot open a session at all, and is told why (guest-sessions-off)', () => {
    const plain = options('runner', { git: false, guestMainWorkspace: false });
    expect(plain).toMatchObject({ canCreate: false, blockedBy: 'guest-sessions-off', sandboxed: null, main: { available: false, unavailableReason: 'host-off' } });
    expect(plain.worktree).toMatchObject({ available: false, unavailableReason: 'not-git' });
    expect(guestSessionsOff('runner', workspace(false), false)).toBe(true);
    expect(guestSessionsOff('runner', workspace(true), false)).toBe(false);
    expect(guestSessionsOff('runner', workspace(false), undefined)).toBe(false);
    expect(guestSessionsOff('runner', null, false)).toBe(true);
  });

  it("the host's own (unsandboxed) sessions are never affected, git or not", () => {
    for (const git of [true, false]) {
      const host = options('host', { git, guestMainWorkspace: false });
      expect(host).toMatchObject({ canCreate: true, blockedBy: null, sandboxed: false, main: { available: true, unavailableReason: null } });
      expect(defaultWhere(host)).toBe('main');
      expect(buildCreatePayload(host, { ...base, where: 'main' }, size).workspace).toEqual({ mode: 'main' });
    }
    expect(keptOutOfMain('host', false)).toBe(false);
  });

  it('editors and viewers keep their own reason (they open no session either way)', () => {
    expect(options('editor', { guestMainWorkspace: false })).toMatchObject({ canCreate: false, blockedBy: 'role-editor' });
    expect(options('viewer', { git: false, guestMainWorkspace: false })).toMatchObject({ canCreate: false, blockedBy: 'role-viewer' });
    expect(keptOutOfMain('editor', false)).toBe(false);
    expect(keptOutOfMain('viewer', false)).toBe(false);
    expect(keptOutOfMain(null, false)).toBe(false);
    expect(keptOutOfMain('runner', false)).toBe(true);
    expect(keptOutOfMain('runner', true)).toBe(false);
  });
});
