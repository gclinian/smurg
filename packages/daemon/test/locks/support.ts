// Shared helpers of the locks tests: a scheduler driven by a ManualClock (deterministic idle / TTL), a recording
// audit log, and a LockManager wired to both.
import { MAIN_ROOT, type AuditEntry, type FileRef, type RootRef } from '@smurg/protocol';
import { TypedEventBus } from '../../src/core/bus.ts';
import type { AuditInput, DaemonEvents, Principal } from '../../src/core/interfaces.ts';
import { ManualClock } from '../../src/core/lifecycle.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { LockManagerImpl, type LockLimits, type LockSettings } from '../../src/locks/lock-manager.ts';
import type { Timers } from '../../src/locks/timers.ts';

export const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
export const worktree = (worktreeId: string): RootRef => ({ kind: 'worktree', worktreeId });

/** Timers that fire only when the test moves the clock (in deadline order). */
export class FakeTimers implements Timers {
  private readonly clock: ManualClock;
  private tasks: { at: number; fn: () => void; cancelled: boolean }[] = [];

  constructor(clock: ManualClock) {
    this.clock = clock;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const task = { at: this.clock.now() + Math.max(0, ms), fn, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  get pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  /** Moves the clock by `ms`, running every timer that becomes due, in order, at its own time. */
  advance(ms: number): void {
    const end = this.clock.now() + ms;
    for (;;) {
      this.tasks = this.tasks.filter((task) => !task.cancelled);
      const due = this.tasks.filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((task) => task !== due);
      if (due.at > this.clock.now()) this.clock.set(due.at);
      due.fn();
    }
    this.clock.set(end);
  }
}

export class RecordingAudit {
  readonly entries: AuditInput[] = [];

  record(input: AuditInput): AuditEntry {
    this.entries.push(input);
    return { id: `au_${this.entries.length}`, at: this.entries.length, actor: input.actor, action: input.action, outcome: input.outcome };
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}

export function hostPrincipal(): Principal {
  return { kind: 'user', actor: { kind: 'user', userId: 'dev:host', displayName: 'Host' }, userId: 'dev:host', role: 'host' };
}

export function editorPrincipal(): Principal {
  return { kind: 'user', actor: { kind: 'user', userId: 'dev:amy', displayName: 'Amy' }, userId: 'dev:amy', role: 'editor' };
}

export interface LockHarness {
  readonly clock: ManualClock;
  readonly timers: FakeTimers;
  readonly audit: RecordingAudit;
  readonly settings: { humanLockIdleMs: number; agentLockTimeoutMs: number };
  readonly changes: DaemonEvents['lock.changed'][];
  readonly locks: LockManagerImpl;
}

export function lockHarness(
  options: {
    readonly settings?: Partial<LockSettings>;
    readonly canonicalize?: (ref: FileRef) => Promise<FileRef | null>;
    readonly limits?: Partial<LockLimits>;
  } = {},
): LockHarness {
  const clock = new ManualClock();
  const timers = new FakeTimers(clock);
  const audit = new RecordingAudit();
  const settings = { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, ...options.settings };
  const bus = new TypedEventBus(silentLogger);
  const changes: DaemonEvents['lock.changed'][] = [];
  bus.on('lock.changed', (event) => changes.push(event));
  const locks = new LockManagerImpl({
    clock,
    bus,
    audit,
    log: silentLogger,
    settings: () => settings,
    timers,
    ...(options.canonicalize ? { canonicalize: options.canonicalize } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { clock, timers, audit, settings, changes, locks };
}

export const AMY = { userId: 'dev:amy', displayName: 'Amy' } as const;
export const BOB = { userId: 'dev:bob', displayName: 'Bob' } as const;

/** What the hooks module passes for a PreToolUse of Ian's (or Cleo's) agent session in the main workspace. */
export function ianAgent(file: FileRef, sessionId = 'ses_ian', sessionRoot: RootRef = MAIN_ROOT) {
  return { file, sessionId, ownerUserId: 'dev:ian', agentName: 'Claude（Ian）', sessionRoot } as const;
}

export function cleoAgent(file: FileRef, sessionId = 'ses_cleo', sessionRoot: RootRef = MAIN_ROOT) {
  return { file, sessionId, ownerUserId: 'dev:cleo', agentName: 'Claude（Cleo）', sessionRoot } as const;
}

/** Lets pending promise callbacks run. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
