// Valid protocol objects for tests (they pass the registry schemas the FakeConnection validates against).
import {
  MAIN_ROOT,
  buildInviteFragment,
  generateInviteSecret,
  x25519KeyPair,
  daemonKeyFingerprint,
  type ActivityEvent,
  type ConflictRecord,
  type FileEntry,
  type FileRef,
  type LockInfo,
  type Member,
  type MergeRequest,
  type PresenceMember,
  type Role,
  type RootRef,
  type SessionInfo,
  type Suggestion,
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

export function makeWelcome(options: { role?: Role; userId?: string; displayName?: string; channelId?: string; name?: string; resumed?: boolean } = {}): Welcome {
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
    settings: { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] },
    serverTime: T0,
  };
}

export function presenceOf(member: Member, overrides: Partial<PresenceMember> = {}): PresenceMember {
  return { ...member, connections: 1, ...overrides };
}

export function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess_1',
    kind: 'agent',
    ownerUserId: HOST_USER,
    ownerName: 'Ian',
    title: 'Claude',
    sandboxed: false,
    root: MAIN_ROOT,
    status: 'running',
    cols: 120,
    rows: 40,
    createdAt: T0,
    login: 'logged-in',
    attached: 0,
    ...overrides,
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
  return { kind: 'agent', file: fileRef(path), sessionId, ownerUserId: HOST_USER, agentName: 'Claude（Ian）', acquiredAt: T0, expiresAt: T0 + 60_000 };
}

export function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return { id: 'sug_1', sessionId: 'sess_1', author: { userId: 'dev:amy', displayName: 'Amy' }, text: '請先補上測試', status: 'pending', createdAt: T0, ...overrides };
}

export function makeActivity(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'act_1',
    at: T0,
    actor: { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude（Ian）' },
    kind: 'agent.edit',
    file: fileRef('src/app.ts'),
    summary: '修改了 src/app.ts',
    ...overrides,
  };
}

export function makeConflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: 'conf_1',
    file: fileRef('src/app.ts'),
    createdAt: T0,
    source: { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude（Ian）' },
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
