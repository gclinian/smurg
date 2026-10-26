// Valid protocol objects for tests (they pass the registry schemas the FakeConnection validates against).
import {
  MAIN_ROOT,
  agentDisplayName,
  buildInviteFragment,
  generateInviteSecret,
  x25519KeyPair,
  daemonKeyFingerprint,
  type ActivityEvent,
  type AgentModel,
  type ConflictRecord,
  type FileEntry,
  type FileRef,
  type HostState,
  type LockInfo,
  type Member,
  type MergeRequest,
  type PresenceMember,
  type Role,
  type RootRef,
  type AgentSession,
  type Suggestion,
  type TerminalSession,
  type Welcome,
  type WorktreeInfo,
} from '@smurg/protocol';

export const WORKSPACE_ID = 'ws_web_test_workspace_0001';
export const HOST_USER = 'dev:host';
export const T0 = 1_780_000_000_000;

export function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    userId: 'dev:amy',
    displayName: 'Amy',
    role: 'editor',
    color: '#3b82f6',
    online: true,
    joinedAt: T0,
    ...overrides,
  };
}

/**
 * `serverTime` is the host's clock at the admission. Default: this computer's time now, so the host's clock and the
 * test's agree (lib/use-now.ts corrects by their difference); a test on a manual scheduler passes that scheduler's time.
 */
export function makeWelcome(options: { role?: Role; userId?: string; displayName?: string; channelId?: string; name?: string; resumed?: boolean; serverTime?: number } = {}): Welcome {
  const role = options.role ?? 'editor';
  return {
    channelId: options.channelId ?? 'ch_1',
    resumed: options.resumed ?? false,
    member: makeMember({
      role,
      userId: options.userId ?? (role === 'host' ? HOST_USER : 'dev:amy'),
      displayName: options.displayName ?? (role === 'host' ? 'Ian' : 'Amy'),
    }),
    workspace: { id: WORKSPACE_ID, name: 'class-project', hostUserId: HOST_USER, hostName: 'Ian', platform: 'darwin', isGitRepo: true },
    settings: { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [], permissionMode: 'auto', merging: 'auto' },
    serverTime: options.serverTime ?? Date.now(),
  };
}

export function presenceOf(member: Member, overrides: Partial<PresenceMember> = {}): PresenceMember {
  return { ...member, connections: 1, ...overrides };
}

/** A terminal session (a PTY: what the terminal panel shows), opened by the host. */
export function makeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'sess_1',
    kind: 'terminal',
    openedBy: { userId: HOST_USER, displayName: 'Ian' },
    title: 'Claude',
    root: MAIN_ROOT,
    status: 'running',
    cols: 120,
    rows: 40,
    createdAt: T0,
    attached: 0,
    ...overrides,
  };
}

/** An agent session (a conversation, protocol 4): a free one, idle, opened by the host. */
export function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess_a1',
    kind: 'agent',
    purpose: 'free',
    openedBy: { userId: HOST_USER, displayName: 'Ian' },
    responsible: null,
    title: 'Claude',
    root: MAIN_ROOT,
    status: 'idle',
    permissionMode: 'ask-all',
    modeChoice: null,
    modeFixed: false,
    model: null,
    ruleCount: 0,
    login: 'logged-in',
    projectSettings: 'none',
    noteworthyAt: T0,
    lastSeq: 0,
    lastActivityAt: T0,
    createdAt: T0,
    ...overrides,
  };
}

/**
 * The models the host's Claude Code 2.1.288 offers, as the daemon puts them on the wire (`HostState.agent.models`):
 * Fable may bill usage credits, Haiku has no auto mode.
 */
export const HOST_MODELS: AgentModel[] = [
  { value: 'opus', name: 'Opus', description: 'Opus 5.5 · Most capable for complex work', resolved: 'claude-opus-5-5', auto: true },
  { value: 'fable', name: 'Fable', description: 'Fable 5.1 · Billed to usage credits on some plans', resolved: 'claude-fable-5-1', auto: true, billing: 'usage-credits' },
  { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5.5 · Best for everyday tasks', resolved: 'claude-sonnet-5-5', auto: true },
  { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers', resolved: 'claude-haiku-4-5-20251001', auto: false },
];

/** What every member knows of the host's side (`session.host.get`): by default the list is known, git is the folder's. */
export function makeHostState(overrides: { account?: HostState['account']; mainProjectSettings?: HostState['mainProjectSettings']; agent?: Partial<HostState['agent']>; work?: HostState['work'] } = {}): HostState {
  return {
    account: overrides.account ?? { state: 'ok', sessions: 0 },
    mainProjectSettings: overrides.mainProjectSettings ?? 'none',
    agent: { models: HOST_MODELS, modelsKnown: true, hostDefault: 'claude-opus-5-5', autoMode: 'ok', asksNothing: 'ok', ...overrides.agent },
    work: overrides.work ?? { history: 'folder' },
  };
}

export function makeEntry(path: string, kind: FileEntry['kind'] = 'file', overrides: Partial<FileEntry> = {}): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind, size: kind === 'dir' ? 0 : 12, mtime: T0, ...overrides };
}

export function fileRef(path: string, root: RootRef = MAIN_ROOT): FileRef {
  return { root, path };
}

export function makeHumanLock(path: string, holder = { userId: 'dev:amy', displayName: 'Amy' }): LockInfo {
  return { kind: 'human', file: fileRef(path), holders: [{ ...holder, lastActivityAt: T0 }], acquiredAt: T0 };
}

export function makeAgentLock(path: string, sessionId = 'sess_1'): LockInfo {
  return { kind: 'agent', file: fileRef(path), sessionId, ownerUserId: HOST_USER, agentName: agentDisplayName('Ian'), acquiredAt: T0, expiresAt: T0 + 60_000 };
}

export function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return { id: 'sug_1', sessionId: 'sess_1', author: { userId: 'dev:amy', displayName: 'Amy' }, text: 'Add the tests first', origin: 'composer', status: 'pending', createdAt: T0, ...overrides };
}

export function makeActivity(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'act_1',
    at: T0,
    actor: { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: agentDisplayName('Ian') },
    kind: 'agent.edit',
    file: fileRef('src/app.ts'),
    summary: 'Claude (Ian) edited src/app.ts',
    // A reference this build cannot render, so the feed shows `summary` (the fallback rule). A test of the rendering
    // itself passes a real one: `text: msg('activity.agentEdit', { agent, path })` from @smurg/protocol/i18n.
    text: { id: 'test.summaryOnly' },
    ...overrides,
  };
}

export function makeConflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: 'conf_1',
    file: fileRef('src/app.ts'),
    createdAt: T0,
    source: { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: agentDisplayName('Ian') },
    humans: [{ userId: 'dev:amy', displayName: 'Amy' }],
    hunks: [{ humanText: 'a', agentText: 'b', baseText: 'c', startLine: 1 }],
    agentVersionBytes: 1,
    status: 'open',
    ...overrides,
  };
}

export function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return { id: 'wt_1', ownerUserId: 'dev:amy', ownerName: 'Amy', branch: 'smurg/amy/wt_1', kept: false, createdAt: T0, sharedDirs: [], ...overrides };
}

export function makeMergeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: 'mr_1',
    worktreeId: 'wt_1',
    requestedBy: { userId: 'dev:amy', displayName: 'Amy' },
    commit: 'a'.repeat(40),
    status: 'pending',
    reviewed: false,
    createdAt: T0,
    ...overrides,
  };
}

/** A real invite fragment (`k=…&s=…`) for a fresh daemon key. */
export function makeInvite(): { fragment: string; daemonKey: Uint8Array; fingerprint: Uint8Array; secret: Uint8Array } {
  const daemonKey = x25519KeyPair().publicKey;
  const secret = generateInviteSecret();
  return { fragment: buildInviteFragment(daemonKey, secret), daemonKey, fingerprint: daemonKeyFingerprint(daemonKey), secret };
}
