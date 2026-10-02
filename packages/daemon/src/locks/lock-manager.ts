// File locks (SPEC R8, D14; ARCHITECTURE §5.4, §7.5). One lock per FILE (not per spelling, see keys.ts):
//  - human lock: taken by DocService.touchHuman on a person's first edit, SHARED by every person editing the file,
//    refreshed by each edit; a holder drops out after humanLockIdleMs without an edit (a live setting), when they
//    close the file or leave, or with "Let the agent go first"; the lock ends with its last holder. While it exists every agent
//    is refused with the holders' names.
//  - agent lock: requested by the PreToolUse hook, exclusive, TTL agentLockTimeoutMs. Refused while a human lock or
//    another session's agent lock is held. Released by PostToolUse / PostToolUseFailure, and because a permission
//    prompt the owner rejects fires no Post event (claude-hooks.md verification), also by the session's next
//    PreToolUse, UserPromptSubmit, Stop, SessionEnd, its exit, a kick, the TTL, or the host's force release.
// Hook events are claims (an agent can read its own session token): locks are granted only inside the session's own
// root, and a session gets a bounded number of grants per minute. Every change is committed in memory, then
// announced as `lock.changed` on the bus (the module turns that into `lock.state` broadcasts).
//
// Time: every decision compares clock.now(); one real timer (injectable) schedules the next re-check, so a lock whose
// deadline passed is also released lazily by the next call that looks at it.
import { SmurgError, fileRefKey, rootRefEquals, type Actor, type FileRef, type LockInfo, type RootRef } from '@smurg/protocol';
import type { AgentLockResult, AuditLog, EventBus, HumanTouchResult, LockChangeReason, LockManager, Principal, UserId } from '../core/interfaces.ts';
import { monotonicNow, type Clock } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { SYSTEM_ACTOR, principalCan } from '../core/permissions.ts';
import { lockKeyOf } from './keys.ts';
import { INVALID_TARGET_REASON, LOCK_CAP_REASON, OUTSIDE_ROOT_REASON, agentHeldReason, humanHeldReason } from '../hooks/deny-text.ts';
import { safeDisplayName } from './text.ts';
import { realTimers, type Timers } from './timers.ts';

type HumanLockInfo = Extract<LockInfo, { kind: 'human' }>;
type AgentLockInfo = Extract<LockInfo, { kind: 'agent' }>;

interface Holder {
  readonly userId: UserId;
  displayName: string;
  lastActivityAt: number;
  /** When this holder's activity was last announced (touches are announced at most every touchPublishIntervalMs). */
  publishedAt: number;
}

interface HumanEntry {
  readonly kind: 'human';
  key: string;
  /** The spelling that created the lock (LockInfo.file). */
  readonly file: FileRef;
  readonly holders: Map<UserId, Holder>;
  acquiredAt: number;
}

interface AgentEntry {
  readonly kind: 'agent';
  key: string;
  readonly file: FileRef;
  readonly sessionId: string;
  readonly ownerUserId: UserId;
  readonly agentName: string;
  acquiredAt: number;
  expiresAt: number;
  /** PermissionRequest fired: the owner's approval prompt is on screen (informational). */
  awaitingApproval: boolean;
}

type Entry = HumanEntry | AgentEntry;

export interface LockSettings {
  readonly humanLockIdleMs: number;
  readonly agentLockTimeoutMs: number;
}

export interface LockLimits {
  /** Agent lock grants one session may receive per minute (forged PreToolUse floods). */
  readonly agentGrantsPerSessionPerMinute: number;
  /** A holder's continued typing is announced (lock.changed 'touched') at most this often. */
  readonly touchPublishIntervalMs: number;
  /** Longest wait of waitForRelease (the MCP wait_for_lock tool). */
  readonly waitForLockMaxMs: number;
  /** Concurrent waitForRelease calls; beyond it a wait answers at once with the current lock. */
  readonly maxWaiters: number;
  /** Learned spellings kept (LRU). */
  readonly aliasCacheMax: number;
  /** A learned spelling is resolved again when it is used after this long (a symlink can be re-pointed). */
  readonly aliasRefreshMs: number;
}

export const DEFAULT_LOCK_LIMITS: LockLimits = Object.freeze({
  agentGrantsPerSessionPerMinute: 60,
  touchPublishIntervalMs: 2_000,
  waitForLockMaxMs: 120_000,
  maxWaiters: 256,
  aliasCacheMax: 10_000,
  aliasRefreshMs: 2_000,
});

const GRANT_WINDOW_MS = 60_000;
/** A re-check fires this long after the deadline it waits for (timers may fire a little early). */
const TIMER_SLACK_MS = 5;
/** Canonicalisations in flight at the same time. */
const MAX_LEARNING = 256;

export interface LockManagerDeps {
  readonly clock: Clock;
  readonly bus: Pick<EventBus, 'emit'>;
  readonly audit: Pick<AuditLog, 'record'>;
  readonly log: Logger;
  /** Live lock settings (the host's settings), read at every decision. */
  readonly settings: () => LockSettings;
  /** Canonical FileRef of a spelling (keys.ts canonicalFileRef); without it only the folded key is used. */
  readonly canonicalize?: (ref: FileRef) => Promise<FileRef | null>;
  readonly timers?: Timers;
  readonly limits?: Partial<LockLimits>;
}

interface Alias {
  readonly key: string;
  readonly root: RootRef;
  readonly at: number;
}

interface Waiter {
  readonly file: FileRef;
  finish(value: LockInfo | null): void;
}

type AgentReleaseReason = 'released' | 'expired' | 'session-ended' | 'member-removed' | 'superseded' | 'prompt' | 'stop';

function userActor(holder: { readonly userId: UserId; readonly displayName: string }): Actor {
  return { kind: 'user', userId: holder.userId, displayName: holder.displayName };
}

function agentActorOf(entry: AgentEntry): Actor {
  return { kind: 'agent', sessionId: entry.sessionId, ownerUserId: entry.ownerUserId, displayName: entry.agentName };
}

function userFallbackName(userId: UserId): string {
  const name = userId.slice(userId.indexOf(':') + 1);
  return name.length > 0 ? name : 'member';
}

export class LockManagerImpl implements LockManager {
  private readonly clock: Clock;
  private readonly bus: Pick<EventBus, 'emit'>;
  private readonly audit: Pick<AuditLog, 'record'>;
  private readonly log: Logger;
  private readonly settings: () => LockSettings;
  private readonly canonicalize: ((ref: FileRef) => Promise<FileRef | null>) | null;
  private readonly timers: Timers;
  private readonly limits: LockLimits;
  private readonly entries = new Map<string, Entry>();
  /** Agent lock keys per session. */
  private readonly bySession = new Map<string, Set<string>>();
  /** Grant times per session in the current minute (the per-session cap). */
  private readonly grants = new Map<string, number[]>();
  /** Folded spelling key → canonical key (learned asynchronously). */
  private readonly aliases = new Map<string, Alias>();
  /** Folded spelling key → its resolution in flight. */
  private readonly learning = new Map<string, Promise<void>>();
  private readonly waiters = new Set<Waiter>();
  private timerAt: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  private readonly epochBase: number;
  private readonly monoBase: number;

  constructor(deps: LockManagerDeps) {
    this.clock = deps.clock;
    this.bus = deps.bus;
    this.audit = deps.audit;
    this.log = deps.log;
    this.settings = deps.settings;
    this.canonicalize = deps.canonicalize ?? null;
    this.timers = deps.timers ?? realTimers;
    this.limits = { ...DEFAULT_LOCK_LIMITS, ...deps.limits };
    this.epochBase = deps.clock.now();
    this.monoBase = monotonicNow(deps.clock);
  }

  /**
   * Lock time: the wall time at construction plus the MONOTONIC time since. Idle timeouts and TTLs are
   * durations; a wall clock that NTP or the person steps back an hour must not keep a lock alive for that hour (nor
   * a step forward expire every lock at once). Reported timestamps stay epoch milliseconds, off by at most the steps.
   * A clock without monotonic() (tests) reads as its own wall time.
   */
  private now(): number {
    // Whole milliseconds: lock timestamps go out as epochMs (an integer on the wire).
    return Math.floor(this.epochBase + (monotonicNow(this.clock) - this.monoBase));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------------------------

  get(file: FileRef): LockInfo | null {
    const entry = this.live(this.keyFor(file), this.now());
    // Only a spelling that finds nothing while locks exist can be an unknown alias of a locked file. Callers such as
    // the file tree ask for thousands of entries; they must not cost a realpath each when nothing is locked.
    if (!entry && this.entries.size > 0) void this.learn(file);
    return entry ? this.info(entry) : null;
  }

  list(): LockInfo[] {
    this.sweep(this.now());
    return [...this.entries.values()].sort((a, b) => a.acquiredAt - b.acquiredAt).map((entry) => this.info(entry));
  }

  /**
   * Resolves `file` to the file it names now (symlinks, on-disk case) before a decision that must not act on a stale
   * spelling (lock.release, lock.forceRelease). Sync methods learn in the background instead.
   */
  async resolveSpelling(file: FileRef): Promise<void> {
    await this.learn(file, true);
  }

  whoIsEditing(file: FileRef): ReturnType<LockManager['whoIsEditing']> {
    const entry = this.live(this.keyFor(file), this.now());
    if (!entry && this.entries.size > 0) void this.learn(file);
    if (!entry) return { humans: [], agent: null };
    if (entry.kind === 'agent') return { humans: [], agent: this.agentInfo(entry) };
    return { humans: this.humanInfo(entry).holders, agent: null };
  }

  waitForRelease(file: FileRef, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<LockInfo | null> {
    const current = this.get(file);
    if (current === null) return Promise.resolve(null);
    if (this.stopped || options.signal?.aborted === true || this.waiters.size >= this.limits.maxWaiters) return Promise.resolve(current);
    const timeout = Number.isFinite(options.timeoutMs) ? Math.min(Math.max(0, options.timeoutMs), this.limits.waitForLockMaxMs) : 0;
    return new Promise<LockInfo | null>((resolve) => {
      let cancel: (() => void) | null = null;
      const onAbort = (): void => waiter.finish(this.peek(file));
      const waiter: Waiter = {
        file,
        finish: (value) => {
          if (!this.waiters.delete(waiter)) return;
          cancel?.();
          options.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
      };
      this.waiters.add(waiter);
      cancel = this.timers.setTimeout(() => waiter.finish(this.get(file)), timeout);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Human locks
  // ---------------------------------------------------------------------------------------------------------------

  touchHuman(file: FileRef, holder: { readonly userId: UserId; readonly displayName: string }): HumanTouchResult {
    const now = this.now();
    void this.learn(file);
    const key = this.keyFor(file);
    const entry = this.live(key, now);
    if (entry?.kind === 'agent') return { ok: false, lock: this.agentInfo(entry) };
    const displayName = safeDisplayName(holder.displayName, userFallbackName(holder.userId));
    if (!entry) {
      const created: HumanEntry = {
        kind: 'human',
        key,
        file: { root: file.root, path: file.path },
        holders: new Map([[holder.userId, { userId: holder.userId, displayName, lastActivityAt: now, publishedAt: now }]]),
        acquiredAt: now,
      };
      this.entries.set(key, created);
      this.recordAudit(userActor({ userId: holder.userId, displayName }), 'lock.acquire', created.file, { kind: 'human' });
      this.schedule();
      const lock = this.humanInfo(created);
      this.emit(created.file, lock, null, 'acquired');
      return { ok: true, lock, acquired: true };
    }
    const existing = entry.holders.get(holder.userId);
    if (!existing) {
      const previous = this.humanInfo(entry);
      entry.holders.set(holder.userId, { userId: holder.userId, displayName, lastActivityAt: now, publishedAt: now });
      this.schedule();
      const lock = this.humanInfo(entry);
      this.emit(entry.file, lock, previous, 'holder-joined');
      return { ok: true, lock, acquired: false };
    }
    const previous = this.humanInfo(entry);
    existing.lastActivityAt = Math.max(existing.lastActivityAt, now);
    existing.displayName = displayName;
    if (now - existing.publishedAt >= this.limits.touchPublishIntervalMs) {
      existing.publishedAt = now;
      const lock = this.humanInfo(entry);
      this.emit(entry.file, lock, previous, 'touched');
      return { ok: true, lock, acquired: false };
    }
    return { ok: true, lock: this.humanInfo(entry), acquired: false };
  }

  leaveHuman(file: FileRef, userId: UserId, reason: 'closed' | 'yield' | 'disconnected'): void {
    const entry = this.live(this.keyFor(file), this.now());
    if (!entry || entry.kind !== 'human') return;
    this.dropHolder(entry, userId, reason);
  }

  leaveAllHuman(userId: UserId): void {
    const now = this.now();
    for (const key of [...this.entries.keys()]) {
      const entry = this.live(key, now);
      if (entry?.kind === 'human' && entry.holders.has(userId)) this.dropHolder(entry, userId, 'member-removed');
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Agent locks
  // ---------------------------------------------------------------------------------------------------------------

  requestAgent(input: {
    readonly file: FileRef;
    readonly sessionId: string;
    readonly ownerUserId: UserId;
    readonly agentName: string;
    readonly sessionRoot: RootRef;
  }): AgentLockResult {
    const now = this.now();
    const { file, sessionId } = input;
    void this.learn(file);
    const key = this.keyFor(file);
    // The previous edit of this session is over (or its permission prompt was rejected, which fires no Post event).
    for (const held of [...(this.bySession.get(sessionId) ?? [])]) {
      if (held !== key) this.releaseAgentEntry(held, 'superseded');
    }
    if (file.path === '') return { granted: false, holder: null, reason: INVALID_TARGET_REASON };
    const alias = this.aliases.get(lockKeyOf(file));
    if (!rootRefEquals(file.root, input.sessionRoot) || (alias !== undefined && !rootRefEquals(alias.root, input.sessionRoot))) {
      return { granted: false, holder: null, reason: OUTSIDE_ROOT_REASON };
    }
    const entry = this.live(key, now);
    if (entry?.kind === 'human') {
      const lock = this.humanInfo(entry);
      return { granted: false, holder: lock, reason: humanHeldReason(lock.holders.map((h) => h.displayName)) };
    }
    if (entry?.kind === 'agent' && entry.sessionId !== sessionId) {
      return { granted: false, holder: this.agentInfo(entry), reason: agentHeldReason(entry.agentName) };
    }
    if (!this.takeGrant(sessionId, now)) return { granted: false, holder: null, reason: LOCK_CAP_REASON };
    const ttl = this.settings().agentLockTimeoutMs;
    if (entry?.kind === 'agent') {
      // The same session edits the same file again: a fresh TTL for the new tool call.
      const previous = this.agentInfo(entry);
      entry.acquiredAt = now;
      entry.expiresAt = now + ttl;
      entry.awaitingApproval = false;
      this.schedule();
      const lock = this.agentInfo(entry);
      this.emit(entry.file, lock, previous, 'touched');
      return { granted: true, lock };
    }
    const created: AgentEntry = {
      kind: 'agent',
      key,
      file: { root: file.root, path: file.path },
      sessionId,
      ownerUserId: input.ownerUserId,
      agentName: safeDisplayName(input.agentName, 'Claude'),
      acquiredAt: now,
      expiresAt: now + ttl,
      awaitingApproval: false,
    };
    this.entries.set(key, created);
    this.addSessionKey(sessionId, key);
    this.recordAudit(agentActorOf(created), 'lock.acquire', created.file, { kind: 'agent', sessionId });
    this.schedule();
    const lock = this.agentInfo(created);
    this.emit(created.file, lock, null, 'acquired');
    return { granted: true, lock };
  }

  markAwaitingApproval(sessionId: string, file: FileRef): void {
    const entry = this.entries.get(this.keyFor(file));
    if (entry?.kind === 'agent' && entry.sessionId === sessionId) entry.awaitingApproval = true;
  }

  releaseAgent(sessionId: string, file?: FileRef): void {
    if (file !== undefined) {
      const key = this.keyFor(file);
      const entry = this.entries.get(key);
      if (entry?.kind === 'agent' && entry.sessionId === sessionId) this.releaseAgentEntry(key, 'released');
      return;
    }
    for (const key of [...(this.bySession.get(sessionId) ?? [])]) this.releaseAgentEntry(key, 'released');
  }

  releaseAllForSession(sessionId: string, reason: 'prompt' | 'stop' | 'session-ended' | 'kicked'): void {
    const mapped: AgentReleaseReason = reason === 'kicked' ? 'member-removed' : reason;
    for (const key of [...(this.bySession.get(sessionId) ?? [])]) this.releaseAgentEntry(key, mapped);
    if (reason === 'session-ended' || reason === 'kicked') this.grants.delete(sessionId);
  }

  /** Kick / leave: the member's human holds and the agent locks of every session they own. */
  releaseAllForUser(userId: UserId): void {
    this.leaveAllHuman(userId);
    for (const [key, entry] of [...this.entries]) {
      if (entry.kind === 'agent' && entry.ownerUserId === userId) this.releaseAgentEntry(key, 'member-removed');
    }
  }

  forceRelease(file: FileRef, by: Principal): LockInfo | null {
    if (!principalCan(by, 'lock.force-release')) throw new SmurgError('forbidden', undefined, { reason: 'not-host' });
    const key = this.keyFor(file);
    const entry = this.live(key, this.now());
    if (!entry) return null;
    const previous = this.info(entry);
    this.removeEntry(entry);
    this.recordAudit(by.actor, 'lock.force-release', entry.file, {
      kind: entry.kind,
      ...(entry.kind === 'agent'
        ? { sessionId: entry.sessionId, holder: entry.agentName, ownerUserId: entry.ownerUserId }
        : { holders: [...entry.holders.values()].map((h) => h.displayName) }),
    });
    this.schedule();
    this.emit(entry.file, null, previous, 'forced');
    return previous;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------------

  /** settings.changed: the idle time and the TTL apply to held locks at once. */
  settingsChanged(): void {
    if (this.stopped) return;
    const now = this.now();
    const ttl = this.settings().agentLockTimeoutMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.kind !== 'agent' || entry.expiresAt === entry.acquiredAt + ttl) continue;
      const previous = this.agentInfo(entry);
      entry.expiresAt = entry.acquiredAt + ttl;
      if (entry.expiresAt > now) this.emit(entry.file, this.agentInfo(entry), previous, 'touched');
    }
    this.sweep(now);
  }

  /** Daemon stop: no timers, every pending wait answers with the lock as it is now. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerAt = null;
    for (const waiter of [...this.waiters]) waiter.finish(this.peek(waiter.file));
    this.learning.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------------------------

  private keyFor(file: FileRef): string {
    const folded = lockKeyOf(file);
    return this.aliases.get(folded)?.key ?? folded;
  }

  /** The entry under `key` after applying expiry and idle rules at `now` (which may release it). */
  private live(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.kind === 'agent') {
      if (entry.expiresAt > now) return entry;
      this.releaseAgentEntry(key, 'expired');
      return undefined;
    }
    const idle = this.settings().humanLockIdleMs;
    const expired = [...entry.holders.values()].filter((h) => now - h.lastActivityAt >= idle);
    if (expired.length === 0) return entry;
    const previous = this.humanInfo(entry);
    for (const holder of expired) entry.holders.delete(holder.userId);
    if (entry.holders.size === 0) {
      this.entries.delete(key);
      this.recordAudit(SYSTEM_ACTOR, 'lock.release', entry.file, { kind: 'human', reason: 'idle', idleMs: idle });
      this.schedule();
      this.emit(entry.file, null, previous, 'idle');
      return undefined;
    }
    this.schedule();
    this.emit(entry.file, this.humanInfo(entry), previous, 'idle');
    return entry;
  }

  /** Like get() without side effects (no release, no learning): for waiters. */
  private peek(file: FileRef): LockInfo | null {
    const entry = this.entries.get(this.keyFor(file));
    if (!entry) return null;
    const now = this.now();
    if (entry.kind === 'agent') return entry.expiresAt > now ? this.agentInfo(entry) : null;
    const idle = this.settings().humanLockIdleMs;
    return [...entry.holders.values()].some((h) => now - h.lastActivityAt < idle) ? this.humanInfo(entry) : null;
  }

  private sweep(now: number): void {
    for (const key of [...this.entries.keys()]) this.live(key, now);
    this.schedule();
  }

  private dropHolder(entry: HumanEntry, userId: UserId, reason: 'yield' | 'closed' | 'disconnected' | 'member-removed'): void {
    const holder = entry.holders.get(userId);
    if (!holder) return;
    const previous = this.humanInfo(entry);
    entry.holders.delete(userId);
    const ended = entry.holders.size === 0;
    if (ended) this.entries.delete(entry.key);
    // An explicit "Let the agent go first" is always on record; otherwise only the end of the lock.
    if (reason === 'yield' || ended) {
      this.recordAudit(userActor(holder), 'lock.release', entry.file, { kind: 'human', reason, remaining: entry.holders.size });
    }
    this.schedule();
    const changeReason: LockChangeReason = reason === 'member-removed' ? 'member-removed' : ended ? 'released' : 'holder-left';
    this.emit(entry.file, ended ? null : this.humanInfo(entry), previous, changeReason);
  }

  private releaseAgentEntry(key: string, reason: AgentReleaseReason): void {
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== 'agent') return;
    const previous = this.agentInfo(entry);
    this.removeEntry(entry);
    const actor = reason === 'expired' ? SYSTEM_ACTOR : agentActorOf(entry);
    this.recordAudit(actor, 'lock.release', entry.file, { kind: 'agent', reason, sessionId: entry.sessionId });
    this.schedule();
    const changeReason: LockChangeReason =
      reason === 'expired' ? 'expired' : reason === 'session-ended' ? 'session-ended' : reason === 'member-removed' ? 'member-removed' : 'released';
    this.emit(entry.file, null, previous, changeReason);
  }

  private removeEntry(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.kind === 'agent') this.removeSessionKey(entry.sessionId, entry.key);
  }

  private addSessionKey(sessionId: string, key: string): void {
    let keys = this.bySession.get(sessionId);
    if (!keys) {
      keys = new Set();
      this.bySession.set(sessionId, keys);
    }
    keys.add(key);
  }

  private removeSessionKey(sessionId: string, key: string): void {
    const keys = this.bySession.get(sessionId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.bySession.delete(sessionId);
  }

  /** The per-session cap: false once the session had agentGrantsPerSessionPerMinute grants in the last minute. */
  private takeGrant(sessionId: string, now: number): boolean {
    const recent = (this.grants.get(sessionId) ?? []).filter((at) => now - at < GRANT_WINDOW_MS);
    if (recent.length >= this.limits.agentGrantsPerSessionPerMinute) {
      this.grants.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    this.grants.set(sessionId, recent);
    return true;
  }

  private humanInfo(entry: HumanEntry): HumanLockInfo {
    return {
      kind: 'human',
      file: entry.file,
      holders: [...entry.holders.values()].map((h) => ({ userId: h.userId, displayName: h.displayName, lastActivityAt: h.lastActivityAt })),
      acquiredAt: entry.acquiredAt,
    };
  }

  private agentInfo(entry: AgentEntry): AgentLockInfo {
    return {
      kind: 'agent',
      file: entry.file,
      sessionId: entry.sessionId,
      ownerUserId: entry.ownerUserId,
      agentName: entry.agentName,
      acquiredAt: entry.acquiredAt,
      expiresAt: entry.expiresAt,
    };
  }

  private info(entry: Entry): LockInfo {
    return entry.kind === 'agent' ? this.agentInfo(entry) : this.humanInfo(entry);
  }

  private emit(file: FileRef, lock: LockInfo | null, previous: LockInfo | null, reason: LockChangeReason): void {
    this.bus.emit('lock.changed', { file, lock, previous, reason });
    if (this.waiters.size === 0) return;
    for (const waiter of [...this.waiters]) if (this.peek(waiter.file) === null) waiter.finish(null);
  }

  private recordAudit(actor: Actor, action: 'lock.acquire' | 'lock.release' | 'lock.force-release', file: FileRef, detail: Readonly<Record<string, unknown>>): void {
    try {
      this.audit.record({ actor, action, outcome: 'ok', target: fileRefKey(file), detail });
    } catch (err) {
      this.log.error('lock audit failed', { action, error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** One real timer for the earliest deadline (agent expiry, holder idle); the callback re-checks with clock.now(). */
  private schedule(): void {
    if (this.stopped) return;
    let next = Number.POSITIVE_INFINITY;
    const idle = this.settings().humanLockIdleMs;
    for (const entry of this.entries.values()) {
      if (entry.kind === 'agent') next = Math.min(next, entry.expiresAt);
      else for (const holder of entry.holders.values()) next = Math.min(next, holder.lastActivityAt + idle);
    }
    if (next === Number.POSITIVE_INFINITY) {
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.timerAt = null;
      return;
    }
    if (this.timerAt !== null && this.timerAt <= next) return;
    this.cancelTimer?.();
    this.timerAt = next;
    this.cancelTimer = this.timers.setTimeout(() => {
      this.timerAt = null;
      this.cancelTimer = null;
      if (!this.stopped) this.sweep(this.now());
    }, next - this.now() + TIMER_SLACK_MS);
  }

  // ---- spellings -------------------------------------------------------------------------------------------------

  /**
   * Learns (asynchronously) which file a spelling names. A lock taken under a symlink spelling before its target was
   * known is moved to the target's key as soon as it is, so both spellings share it from then on.
   */
  private learn(file: FileRef, force = false): Promise<void> {
    if (this.canonicalize === null || this.stopped) return Promise.resolve();
    const folded = lockKeyOf(file);
    const inFlight = this.learning.get(folded);
    if (inFlight !== undefined) return inFlight;
    const known = this.aliases.get(folded);
    if (!force && known !== undefined && this.now() - known.at < this.limits.aliasRefreshMs) return Promise.resolve();
    if (this.learning.size >= MAX_LEARNING) return Promise.resolve();
    const learning = this.canonicalize({ root: file.root, path: file.path })
      .then(
        (canonical) => {
          if (this.stopped) return;
          const key = canonical ? lockKeyOf(canonical) : folded;
          this.aliases.delete(folded);
          this.aliases.set(folded, { key, root: canonical ? canonical.root : file.root, at: this.now() });
          while (this.aliases.size > this.limits.aliasCacheMax) {
            const oldest = this.aliases.keys().next().value;
            if (oldest === undefined) break;
            this.aliases.delete(oldest);
          }
          if (key !== folded) this.rekey(folded, key);
        },
        (err: unknown) => {
          this.log.debug('lock key resolution failed', { error: err instanceof Error ? err.name : 'unknown' });
        },
      )
      .finally(() => {
        if (this.learning.get(folded) === learning) this.learning.delete(folded);
      });
    this.learning.set(folded, learning);
    return learning;
  }

  /** Moves the lock taken under spelling key `from` to the file's key `to`, merging with a lock already there. */
  private rekey(from: string, to: string): void {
    const moving = this.entries.get(from);
    if (!moving) return;
    const target = this.entries.get(to);
    this.entries.delete(from);
    const place = (entry: Entry): void => {
      if (entry.kind === 'agent') this.removeSessionKey(entry.sessionId, from);
      entry.key = to;
      this.entries.set(to, entry);
      if (entry.kind === 'agent') this.addSessionKey(entry.sessionId, to);
    };
    if (!target) {
      place(moving);
      return;
    }
    if (moving.kind === 'human' && target.kind === 'human') {
      const previousMoving = this.humanInfo(moving);
      const previousTarget = this.humanInfo(target);
      for (const holder of moving.holders.values()) {
        const existing = target.holders.get(holder.userId);
        if (!existing) target.holders.set(holder.userId, holder);
        else existing.lastActivityAt = Math.max(existing.lastActivityAt, holder.lastActivityAt);
      }
      target.acquiredAt = Math.min(target.acquiredAt, moving.acquiredAt);
      const merged = this.humanInfo(target);
      this.emit(moving.file, merged, previousMoving, 'holder-joined');
      this.emit(target.file, merged, previousTarget, 'holder-joined');
      return;
    }
    // Two locks on one file (taken under two spellings before they were known to be the same): the earlier one stays.
    const keepMoving = moving.acquiredAt < target.acquiredAt;
    const keep = keepMoving ? moving : target;
    const drop = keepMoving ? target : moving;
    if (keepMoving) {
      this.removeEntry(target);
      place(moving);
    } else if (drop.kind === 'agent') {
      this.removeSessionKey(drop.sessionId, from);
    }
    this.recordAudit(SYSTEM_ACTOR, 'lock.release', drop.file, { kind: drop.kind, reason: 'same-file' });
    this.schedule();
    this.emit(drop.file, this.info(keep), this.info(drop), drop.kind === 'human' ? 'holder-left' : 'released');
  }
}
