// Test support for the console: a workspace on a FakeConnection whose snapshot requests (admin.*, sessions,
// suggestions, worktrees, the host state, the inbox, the Claude Code project settings, the host's own rules) are
// answered from a mutable fixture, and HostConsolePage rendered in it. Action requests (setRole, kick, terminate,
// create/revoke invite, settings.set, claudeConfig.decide, hostRules.seen, transcript.redact, …) stay pending for the
// test to answer.
import { act, render } from '@testing-library/react';
import type {
  AuditEntry,
  ClaudeConfigFile,
  ConsoleSection,
  HostSettings,
  HostState,
  InboxItem,
  InviteInfo,
  Member,
  MemberWithDevices,
  MergeRequest,
  Role,
  SessionInfo,
  Suggestion,
  WorktreeInfo,
} from '@smurg/protocol';
import type { ReactElement } from 'react';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { HOST_USER, T0, makeAgentSession, makeMember, makeMergeRequest, makeSession, makeSuggestion, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import type { ClaudeConfigRoot } from './claude-config.ts';
import type { HostRule } from './host-rules.ts';
import { HostConsolePage } from './index.tsx';
import { GIB } from './settings-form.ts';

export const DAY = 24 * 3_600_000;

export const HOST: MemberWithDevices = {
  ...makeMember({ userId: HOST_USER, displayName: 'Ian', role: 'host', color: '#f97316' }),
  devices: [{ deviceId: 'dev_host_cli', name: 'MacBook', kind: 'cli', addedAt: T0, lastSeenAt: T0, revoked: false }],
};
export const AMY: MemberWithDevices = {
  ...makeMember({ userId: 'dev:amy', displayName: 'Amy', role: 'agent' }),
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
  diskReserveBytes: 5 * GIB,
  diskReservePercent: 5,
  maxLiveAgents: 8,
  escalateAfterMs: 600_000,
  agentMcp: false,
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

/** A SHA-256 as the wire carries it: 64 hex characters, here one character repeated. */
export const hash = (character: string): string => character.repeat(64);

/** One project-level Claude Code file with what it does; by default a settings file nobody decided about. */
export function makeConfigFile(overrides: Partial<ClaudeConfigFile> = {}): ClaudeConfigFile {
  return {
    path: '.claude/settings.json',
    hash: hash('a'),
    decision: null,
    changed: false,
    text: '{\n  "hooks": { "PostToolUse": [{ "hooks": [{ "type": "command", "command": "./scripts/lint.sh --fix" }] }] }\n}',
    runs: ['./scripts/lint.sh --fix'],
    permissions: [],
    env: [],
    otherKeys: [],
    scripts: [{ path: 'scripts/lint.sh', hash: hash('b') }],
    needsAck: [],
    ...overrides,
  };
}

export const OK_HOST_STATE: HostState = { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' };

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
  /** session.host.get: the account state and the main folder's project-settings state. */
  host: HostState;
  /** inbox.list: the host's own items (the console reads the attention ones). */
  inbox: InboxItem[];
  /** admin.claudeConfig.get: every root with its files. */
  claudeConfig: ClaudeConfigRoot[];
  /** admin.hostRules.get. */
  hostRules: { rules: HostRule[]; seen: boolean };
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
      makeSession({ id: 'sess_amy', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, title: 'login page', root: { kind: 'worktree', worktreeId: 'wt_1' }, attached: 2, createdAt: T0 + 1 }),
      makeSession({ id: 'sess_old', kind: 'terminal', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, title: 'old shell', status: 'exited', exitCode: 0, createdAt: T0 - 1 }),
    ],
    suggestions: [],
    worktrees: [makeWorktree({ sessionId: 'sess_amy' })],
    requests: [makeMergeRequest()],
    host: OK_HOST_STATE,
    inbox: [],
    claudeConfig: [{ root: { kind: 'main' }, state: 'none', files: [] }],
    hostRules: { rules: [], seen: true },
  };
}

/** The sessions of a topic "Checkout" beside the terminals: its discussion, a work item Amy started, and a free session. */
export const DISCUSSION = makeAgentSession({
  id: 'sess_disc',
  purpose: 'discussion',
  topicId: 'topic_1',
  topicName: 'Checkout',
  title: undefined,
  modeFixed: true,
  status: 'waiting-answer',
  responsible: { userId: HOST_USER, displayName: 'Ian' },
  createdAt: T0 + 2,
});
export const ITEM = makeAgentSession({
  id: 'sess_item',
  purpose: 'item',
  topicId: 'topic_1',
  topicName: 'Checkout',
  itemId: 'payment-form',
  item: { number: 2, title: 'Payment form' },
  attempt: 2,
  title: undefined,
  status: 'stalled',
  openedBy: { userId: 'dev:amy', displayName: 'Amy' },
  responsible: { userId: 'dev:amy', displayName: 'Amy' },
  permissionMode: 'ask-commands',
  createdAt: T0 + 3,
});
export const FREE = makeAgentSession({ id: 'sess_free', title: 'try the parser', status: 'running', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, createdAt: T0 + 4 });

/** The default fixture with the topic's sessions and one pending suggestion for the discussion. */
export function topicFixture(): ConsoleFixture {
  const fixture = defaultFixture();
  fixture.sessions = [...fixture.sessions, DISCUSSION, ITEM, FREE];
  fixture.suggestions = [
    makeSuggestion({ id: 'sug_pending', sessionId: 'sess_disc', topicId: 'topic_1', author: { userId: 'dev:bob', displayName: 'Bob' }, text: 'Add tests for the form validation first' }),
    makeSuggestion({ id: 'sug_free', sessionId: 'sess_free', author: { userId: 'dev:bob', displayName: 'Bob' }, text: 'Use the streaming parser' }),
    makeSuggestion({ id: 'sug_done', sessionId: 'sess_disc', text: 'A suggestion handled before', status: 'accepted', resolvedAt: T0 + 5 }),
  ];
  return fixture;
}

export const AUDIT_PAGE = 200;

/** A connection that answers every snapshot request of the console from `fixture` (read at request time). */
export function consoleConnection(fixture: ConsoleFixture): FakeConnection {
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
  conn.handle('session.list', () => ({ sessions: fixture.sessions, hasMore: false }));
  conn.handle('suggest.list', () => ({ suggestions: fixture.suggestions, hasMore: false }));
  conn.handle('worktree.list', () => ({ worktrees: fixture.worktrees }));
  conn.handle('worktree.merge.list', () => ({ requests: fixture.requests }));
  conn.handle('session.host.get', () => fixture.host);
  conn.handle('inbox.list', () => ({ items: fixture.inbox, hasMore: false }));
  conn.handle('topic.list', () => ({ topics: [], hasMore: false }));
  conn.handle('admin.claudeConfig.get', () => ({ roots: fixture.claudeConfig, hasMore: false }));
  conn.handle('admin.hostRules.get', () => fixture.hostRules);
  return conn;
}

/** `ui` in a workspace whose connection answers from `fixture`; the member is the host unless `role` says otherwise. */
export function renderWithConsoleData(ui: ReactElement, options: { role?: Role; fixture?: ConsoleFixture } = {}) {
  const fixture = options.fixture ?? defaultFixture();
  const conn = consoleConnection(fixture);
  const context = createTestWorkspace({ conn, admit: false });
  conn.admit(makeWelcome({ role: options.role ?? 'host' }));
  const result = render(<WorkspaceTestProviders context={context}>{ui}</WorkspaceTestProviders>);
  return { ...result, ...context, conn, fixture };
}

export function renderConsole(options: { role?: Role; fixture?: ConsoleFixture; section?: ConsoleSection } = {}) {
  return renderWithConsoleData(<HostConsolePage {...(options.section === undefined ? {} : { section: options.section })} />, options);
}

/** Lets pending promise callbacks and the state updates they cause run. */
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Whether `needle` occurs anywhere inside `value` (objects, arrays, Maps, Sets, strings). */
export function containsString(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) return [...value.entries()].some(([key, item]) => containsString(key, needle, seen) || containsString(item, needle, seen));
  if (value instanceof Set || Array.isArray(value)) return [...value].some((item) => containsString(item, needle, seen));
  return Object.values(value).some((item) => containsString(item, needle, seen));
}
