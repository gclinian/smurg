// TEST ONLY. What every fake needs of the daemon: the bus it emits the events of ARCHITECTURE §7.3 on, the clock, and
// (optionally) the hub and the member directory. A real DaemonContext fits (`createTestDaemon(...).ctx`).
//
// createFakeEnv() gives a bus and a clock for tests of the FAKES ALONE (and of pure logic over them). It is NOT a
// DaemonContext and no module is built on it: a module reads `ctx.members`, `ctx.hub`, `ctx.audit`, `ctx.settings`,
// `ctx.rates`, `ctx.state`, … and a half-made context only moves the mistakes to runtime. To build and test a module,
// compose a test daemon: `createTestDaemon({ modules: [fakesModule({ except: [...], handlers: true }), yourModule] })`.
import type { Role } from '@smurg/protocol';
import { TypedEventBus } from '../bus.ts';
import type { EventBus, Hub, MemberDirectory, Principal, RootRegistry, UserId } from '../interfaces.ts';
import { ManualClock, type Clock } from '../lifecycle.ts';
import { silentLogger } from '../logger.ts';

export interface FakeEnv {
  readonly bus: EventBus;
  readonly clock: Clock;
  /** With a hub, card updates and events really travel to watching channels. */
  readonly hub?: Pick<Hub, 'sendToChannels' | 'sendToUser' | 'broadcast'>;
  readonly members?: Pick<MemberDirectory, 'userRef' | 'hostUserId' | 'routing'>;
  /** With the registry (a real daemon), the fake worktree manager makes real directories and registers them. */
  readonly roots?: RootRegistry;
}

/** A bus and a manual clock for tests of the fakes themselves (never a module's context: see above). */
export function createFakeEnv(options: { readonly now?: number } = {}): FakeEnv & { readonly clock: ManualClock } {
  return { bus: new TypedEventBus(silentLogger), clock: new ManualClock(options.now ?? 1_727_000_000_000) };
}

/** A member's principal for tests: `fakePrincipal('dev:mei', 'agent', 'Mei')`. */
export function fakePrincipal(userId: UserId, role: Role, displayName?: string): Principal {
  return Object.freeze({ kind: 'user', actor: { kind: 'user' as const, userId, displayName: displayName ?? userId.slice(userId.indexOf(':') + 1) }, userId, role });
}

let counter = 0;
/** Deterministic ids for fakes: `q_1`, `q_2`, … (one counter per process; tests never depend on the number). */
export function fakeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

/** Everything a fake was asked to do, in order: `calls.filter((call) => call.method === 'send')`. */
export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class CallLog {
  readonly calls: FakeCall[] = [];

  record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  of(method: string): readonly unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => [...call.args]);
  }

  clear(): void {
    this.calls.length = 0;
  }
}
