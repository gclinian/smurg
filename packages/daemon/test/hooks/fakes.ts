// TEST ONLY: stand-ins for the services the hook server consults, while their modules are being built by other
// engineers. FakeLockManager follows the LockManager contract of core/interfaces.ts closely enough to prove the hook
// behaviour (human locks deny agents, agents exclude each other, a session's previous lock is released when it asks
// again, a per-session cap, TTL, lock.changed on the bus, waitForRelease) — it is not the product's lock manager.
import { buildAgentSession } from '../../src/core/fakes/build.ts';
import { fileRefKey, rootRefEquals, type FileRef, type LockInfo, type MemberNotification, type SessionInfo } from '@smurg/protocol';
import type { DaemonContext, FeatureModule } from '../../src/core/context.ts';
import { LOCK_CAP_REASON, OUTSIDE_ROOT_REASON, agentHeldReason, humanHeldReason } from '../../src/hooks/deny-text.ts';
import type { ActivityFeed, AgentLockResult, EventBus, HumanTouchResult, LockManager, Principal, SessionManager, UserId } from '../../src/core/interfaces.ts';
import { toDisposable, type Clock } from '../../src/core/lifecycle.ts';

type HumanLock = Extract<LockInfo, { kind: 'human' }>;
type AgentLock = Extract<LockInfo, { kind: 'agent' }>;

export interface LockCall {
  readonly op: string;
  readonly sessionId?: string;
  readonly file?: string;
  readonly reason?: string;
}

export class FakeLockManager implements LockManager {
  readonly calls: LockCall[] = [];
  readonly awaitingApproval = new Set<string>();
  private readonly human = new Map<string, HumanLock>();
  private readonly agent = new Map<string, AgentLock>();
  private readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly capPerSession: number;

  constructor(options: { readonly bus: EventBus; readonly clock: Clock; readonly ttlMs?: number; readonly capPerSession?: number }) {
    this.bus = options.bus;
    this.clock = options.clock;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.capPerSession = options.capPerSession ?? 1;
  }

  /** Test setup: `names` are typing in `file`. */
  holdHuman(file: FileRef, ...names: string[]): void {
    const now = this.clock.now();
    const previous = this.get(file);
    const lock: HumanLock = { kind: 'human', file, holders: names.map((name) => ({ userId: `dev:${name.toLowerCase()}`, displayName: name, lastActivityAt: now })), acquiredAt: now };
    this.human.set(fileRefKey(file), lock);
    this.bus.emit('lock.changed', { file, lock, previous, reason: 'acquired' });
  }

  private live(key: string): AgentLock | null {
    const lock = this.agent.get(key);
    if (!lock) return null;
    if (lock.expiresAt <= this.clock.now()) {
      this.agent.delete(key);
      this.bus.emit('lock.changed', { file: lock.file, lock: this.human.get(key) ?? null, previous: lock, reason: 'expired' });
      return null;
    }
    return lock;
  }

  get(file: FileRef): LockInfo | null {
    const key = fileRefKey(file);
    return this.live(key) ?? this.human.get(key) ?? null;
  }

  list(): LockInfo[] {
    const out: LockInfo[] = [];
    for (const key of [...this.agent.keys()]) {
      const lock = this.live(key);
      if (lock) out.push(lock);
    }
    for (const [key, lock] of this.human) if (!this.agent.has(key)) out.push(lock);
    return out;
  }

  agentLocksOf(sessionId: string): AgentLock[] {
    return this.list().filter((lock): lock is AgentLock => lock.kind === 'agent' && lock.sessionId === sessionId);
  }

  touchHuman(file: FileRef, holder: { readonly userId: UserId; readonly displayName: string }): HumanTouchResult {
    const agent = this.live(fileRefKey(file));
    if (agent) return { ok: false, lock: agent };
    const now = this.clock.now();
    const current = this.human.get(fileRefKey(file));
    const holders = [...(current?.holders ?? []).filter((h) => h.userId !== holder.userId), { ...holder, lastActivityAt: now }];
    const lock: HumanLock = { kind: 'human', file, holders, acquiredAt: current?.acquiredAt ?? now };
    this.human.set(fileRefKey(file), lock);
    return { ok: true, lock, acquired: current === undefined };
  }

  leaveHuman(file: FileRef, userId: UserId): void {
    const key = fileRefKey(file);
    const current = this.human.get(key);
    if (!current) return;
    const holders = current.holders.filter((h) => h.userId !== userId);
    if (holders.length === 0) {
      this.human.delete(key);
      this.bus.emit('lock.changed', { file, lock: this.get(file), previous: current, reason: 'released' });
    } else this.human.set(key, { ...current, holders });
  }

  leaveAllHuman(userId: UserId): void {
    for (const lock of [...this.human.values()]) this.leaveHuman(lock.file, userId);
  }

  requestAgent(input: { readonly file: FileRef; readonly sessionId: string; readonly ownerUserId: UserId; readonly agentName: string; readonly sessionRoot: FileRef['root'] }): AgentLockResult {
    const key = fileRefKey(input.file);
    this.calls.push({ op: 'requestAgent', sessionId: input.sessionId, file: key });
    if (!rootRefEquals(input.file.root, input.sessionRoot)) return { granted: false, holder: null, reason: OUTSIDE_ROOT_REASON };
    const human = this.human.get(key);
    if (human) {
      return { granted: false, holder: human, reason: humanHeldReason(human.holders.map((h) => h.displayName)) };
    }
    const other = this.live(key);
    if (other && other.sessionId !== input.sessionId) {
      return { granted: false, holder: other, reason: agentHeldReason(other.agentName) };
    }
    // A session's previous lock is released when it asks again (contract).
    for (const lock of this.agentLocksOf(input.sessionId)) if (fileRefKey(lock.file) !== key) this.drop(lock, 'released');
    if (this.agentLocksOf(input.sessionId).filter((lock) => fileRefKey(lock.file) !== key).length >= this.capPerSession) {
      return { granted: false, holder: null, reason: LOCK_CAP_REASON };
    }
    const now = this.clock.now();
    const lock: AgentLock = { kind: 'agent', file: input.file, sessionId: input.sessionId, ownerUserId: input.ownerUserId, agentName: input.agentName, acquiredAt: other?.acquiredAt ?? now, expiresAt: now + this.ttlMs };
    this.agent.set(key, lock);
    this.bus.emit('lock.changed', { file: input.file, lock, previous: other ?? human ?? null, reason: other ? 'touched' : 'acquired' });
    return { granted: true, lock };
  }

  private drop(lock: AgentLock, reason: 'released' | 'forced' | 'session-ended'): void {
    const key = fileRefKey(lock.file);
    if (this.agent.get(key) !== lock) return;
    this.agent.delete(key);
    this.awaitingApproval.delete(`${lock.sessionId}|${key}`);
    this.bus.emit('lock.changed', { file: lock.file, lock: this.human.get(key) ?? null, previous: lock, reason });
  }

  markAwaitingApproval(sessionId: string, file: FileRef): void {
    this.calls.push({ op: 'markAwaitingApproval', sessionId, file: fileRefKey(file) });
    this.awaitingApproval.add(`${sessionId}|${fileRefKey(file)}`);
  }

  releaseAgent(sessionId: string, file?: FileRef): void {
    this.calls.push({ op: 'releaseAgent', sessionId, ...(file ? { file: fileRefKey(file) } : {}) });
    for (const lock of this.agentLocksOf(sessionId)) if (file === undefined || fileRefKey(lock.file) === fileRefKey(file)) this.drop(lock, 'released');
  }

  releaseAllForSession(sessionId: string, reason: 'prompt' | 'stop' | 'session-ended' | 'kicked'): void {
    this.calls.push({ op: 'releaseAllForSession', sessionId, reason });
    for (const lock of this.agentLocksOf(sessionId)) this.drop(lock, reason === 'session-ended' ? 'session-ended' : 'released');
  }

  forceRelease(file: FileRef, _by: Principal): LockInfo | null {
    const lock = this.get(file);
    if (lock?.kind === 'agent') this.drop(lock, 'forced');
    if (lock?.kind === 'human') this.human.delete(fileRefKey(file));
    return lock;
  }

  /** Test helper: a human stops typing. */
  releaseHuman(file: FileRef): void {
    const key = fileRefKey(file);
    const current = this.human.get(key);
    if (!current) return;
    this.human.delete(key);
    this.bus.emit('lock.changed', { file, lock: this.live(key), previous: current, reason: 'idle' });
  }

  whoIsEditing(file: FileRef): ReturnType<LockManager['whoIsEditing']> {
    const key = fileRefKey(file);
    return { humans: this.human.get(key)?.holders ?? [], agent: this.live(key) };
  }

  waitForRelease(file: FileRef, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<LockInfo | null> {
    if (this.get(file) === null) return Promise.resolve(null);
    const key = fileRefKey(file);
    return new Promise((resolve) => {
      const done = (value: LockInfo | null): void => {
        clearTimeout(timer);
        subscription.dispose();
        options.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => done(this.get(file));
      const subscription = this.bus.on('lock.changed', (event) => {
        if (fileRefKey(event.file) === key && event.lock === null) done(null);
      });
      const timer = setTimeout(() => done(this.get(file)), options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export class FakeActivity implements ActivityFeed {
  readonly notified: { readonly userId: UserId; readonly notification: Omit<MemberNotification, 'id' | 'at'> }[] = [];

  record(): never {
    throw new Error('FakeActivity.record is not used by the hook tests');
  }

  list(): never {
    throw new Error('FakeActivity.list is not used by the hook tests');
  }

  notify(userId: UserId, notification: Omit<MemberNotification, 'id' | 'at'>): void {
    this.notified.push({ userId, notification });
  }
}

export interface FakeServices {
  readonly module: FeatureModule;
  readonly locks: FakeLockManager;
  readonly activity: FakeActivity | null;
  /** What list_sessions reports (tests push into it). */
  readonly sessions: SessionInfo[];
}

/**
 * A module that fills the `locks` slot (and optionally `sessions` / `activity`) with fakes. Put it before hooksModule
 * in `modules`. `locks` is available after createTestDaemon resolved.
 */
export function fakeServices(options: { readonly activity?: boolean; readonly sessions?: boolean; readonly capPerSession?: number; readonly ttlMs?: number } = {}): FakeServices {
  let locks: FakeLockManager | null = null;
  const activity = options.activity ? new FakeActivity() : null;
  const sessions: SessionInfo[] = [];
  const sessionManager = { list: () => [...sessions], get: (id: string) => sessions.find((s) => s.id === id) ?? null } as unknown as SessionManager;
  const module: FeatureModule = {
    name: 'fake-services',
    create: (ctx: DaemonContext) => {
      locks = new FakeLockManager({ bus: ctx.bus, clock: ctx.clock, ...(options.capPerSession ? { capPerSession: options.capPerSession } : {}), ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) });
      return { locks, ...(activity ? { activity } : {}), ...(options.sessions ? { sessions: sessionManager } : {}) };
    },
    register: () => toDisposable(() => {}),
  };
  return {
    module,
    get locks(): FakeLockManager {
      if (locks === null) throw new Error('the fake services were not created yet');
      return locks;
    },
    activity,
    sessions,
  };
}

/** A SessionInfo for list_sessions. */
export function sessionInfo(id: string, owner: { readonly userId: string; readonly name: string }, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { ...buildAgentSession({ id, openedBy: { userId: owner.userId, displayName: owner.name }, status: 'running', createdAt: 1_760_000_000_000 }), ...extra } as SessionInfo;
}
