// Test support for the console: a workspace on a FakeConnection whose snapshot requests (admin.*, sessions,
// suggestions, worktrees) are answered from a mutable fixture, and HostConsolePage rendered in it. Action requests
// (setRole, kick, terminate, create/revoke invite, settings.set, …) stay pending for the test to answer.
import { render } from '@testing-library/react';
import type { AuditEntry, HostSettings, InviteInfo, Member, MemberWithDevices, MergeRequest, Role, SessionInfo, Suggestion, WorktreeInfo } from '@smurg/protocol';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { HOST_USER, T0, makeMember, makeMergeRequest, makeSession, makeSuggestion, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { HostConsolePage } from './index.tsx';
import { GIB } from './settings-form.ts';

export const DAY = 24 * 3_600_000;

export const HOST: MemberWithDevices = {
  ...makeMember({ userId: HOST_USER, displayName: 'Ian', role: 'host', color: '#f97316' }),
  devices: [{ deviceId: 'dev_host_cli', name: 'MacBook', kind: 'cli', addedAt: T0, lastSeenAt: T0, revoked: false }],
};
export const AMY: MemberWithDevices = {
  ...makeMember({ userId: 'dev:amy', displayName: 'Amy', role: 'runner' }),
  devices: [
    { deviceId: 'dev_amy_web', name: 'Chrome', kind: 'web', addedAt: T0, lastSeenAt: T0, revoked: false },
    { deviceId: 'dev_amy_cli', name: 'amy-laptop', kind: 'cli', addedAt: T0, lastSeenAt: T0, revoked: false },
  ],
};
export const BOB: MemberWithDevices = {
  ...makeMember({ userId: 'dev:bob', displayName: 'Bob', role: 'viewer', online: false, color: '#22c55e' }),
  devices: [{ deviceId: 'dev_bob_web', name: 'Firefox', kind: 'web', addedAt: T0, lastSeenAt: T0, revoked: true }],
};

/** The plain Member of a MemberWithDevices (presence.state and admin.member.setRole carry no devices). */
export function asMember({ devices: _devices, ...member }: MemberWithDevices): Member {
  return member;
}

export const SETTINGS: HostSettings = {
  humanLockIdleMs: 30_000,
  agentLockTimeoutMs: 60_000,
  uploadChunkSize: 4 * 1024 * 1024,
  sharedDirs: ['data'],
  allowedDomains: ['pypi.org'],
  diskReserveBytes: 5 * GIB,
  diskReservePercent: 5,
};

export function makeAudit(index: number, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `aud_${index}`,
    at: T0 + index * 1_000,
    actor: { kind: 'user', userId: 'dev:amy', displayName: 'Amy' },
    action: 'file.write',
    target: `src/file-${index}.ts`,
    outcome: 'ok',
    ...overrides,
  };
}

export interface ConsoleFixture {
  members: MemberWithDevices[];
  invites: InviteInfo[];
  settings: HostSettings;
  /** Every entry on the "host's disk", any order: admin.audit.query pages through them newest first. */
  audit: AuditEntry[];
  sessions: SessionInfo[];
  suggestions: Suggestion[];
  worktrees: WorktreeInfo[];
  requests: MergeRequest[];
}

export function defaultFixture(): ConsoleFixture {
  const now = Date.now();
  return {
    members: [HOST, AMY, BOB],
    invites: [
      { id: 'inv_active', role: 'editor', createdAt: now - DAY, expiresAt: now + 6 * DAY, maxUses: 5, uses: 2, revoked: false },
      { id: 'inv_revoked', role: 'viewer', createdAt: now - 2 * DAY, expiresAt: now + 5 * DAY, uses: 0, revoked: true },
    ],
    settings: SETTINGS,
    audit: [makeAudit(1, { action: 'auth.connect', target: 'dev_amy_web' }), makeAudit(2), makeAudit(3, { action: 'authz.denied', outcome: 'denied', target: 'file.write', actor: { kind: 'user', userId: 'dev:bob', displayName: 'Bob' }, detail: { reason: 'forbidden-role' } })],
    sessions: [
      makeSession({ id: 'sess_host', title: 'Claude', createdAt: T0 }),
      makeSession({ id: 'sess_amy', ownerUserId: 'dev:amy', ownerName: 'Amy', title: '登入頁', sandboxed: true, root: { kind: 'worktree', worktreeId: 'wt_1' }, attached: 2, createdAt: T0 + 1 }),
      makeSession({ id: 'sess_old', kind: 'terminal', ownerUserId: 'dev:amy', ownerName: 'Amy', title: '終端機', sandboxed: true, status: 'exited', exitCode: 0, createdAt: T0 - 1 }),
    ],
    suggestions: [
      makeSuggestion({ id: 'sug_pending', sessionId: 'sess_amy', author: { userId: HOST_USER, displayName: 'Ian' }, text: '先補上表單驗證的測試' }),
      makeSuggestion({ id: 'sug_done', sessionId: 'sess_host', text: '已經處理過的建議', status: 'accepted', resolvedAt: T0 + 5 }),
    ],
    worktrees: [makeWorktree({ sessionId: 'sess_amy' })],
    requests: [makeMergeRequest()],
  };
}

export const AUDIT_PAGE = 200;

export function renderConsole(options: { role?: Role; fixture?: ConsoleFixture } = {}) {
  const fixture = options.fixture ?? defaultFixture();
  const conn = new FakeConnection();
  conn.handle('admin.member.list', () => ({ members: fixture.members }));
  conn.handle('admin.invite.list', () => ({ invites: fixture.invites }));
  conn.handle('admin.settings.get', () => ({ settings: fixture.settings }));
  conn.handle('admin.audit.query', ({ limit, before }) => ({
    entries: [...fixture.audit]
      .sort((a, b) => b.at - a.at)
      .filter((entry) => before === undefined || entry.at < before)
      .slice(0, limit ?? AUDIT_PAGE),
  }));
  conn.handle('session.list', () => ({ sessions: fixture.sessions }));
  conn.handle('suggest.list', () => ({ suggestions: fixture.suggestions }));
  conn.handle('worktree.list', () => ({ worktrees: fixture.worktrees }));
  conn.handle('worktree.merge.list', () => ({ requests: fixture.requests }));
  const context = createTestWorkspace({ conn, admit: false });
  conn.admit(makeWelcome({ role: options.role ?? 'host' }));
  const result = render(
    <WorkspaceTestProviders context={context}>
      <HostConsolePage />
    </WorkspaceTestProviders>,
  );
  return { ...result, ...context, conn, fixture };
}

/** Whether `needle` occurs anywhere inside `value` (objects, arrays, Maps, Sets, strings). */
export function containsString(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) return [...value.entries()].some(([key, item]) => containsString(key, needle, seen) || containsString(item, needle, seen));
  if (value instanceof Set || Array.isArray(value)) return [...value].some((item) => containsString(item, needle, seen));
  return Object.values(value).some((item) => containsString(item, needle, seen));
}
