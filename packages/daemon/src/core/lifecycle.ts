// Small lifecycle primitives shared by every daemon module: Disposable (what `register()` returns), a stack that
// disposes in reverse order, the injectable clock and the id generator.
import { randomBytes } from 'node:crypto';

/** What a feature module's `register(router, ctx)` returns, and what every subscription returns. */
export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose(): void {
      if (done) return;
      done = true;
      fn();
    },
  };
}

/**
 * Collects disposables and disposes them in reverse order of registration. A throwing disposable does not stop the
 * others: stop() must always get as far as releasing the sleep inhibitor and closing sockets.
 */
export class DisposableStack implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  defer(fn: () => void): void {
    this.add(toDisposable(fn));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    while (this.items.length > 0) {
      const item = this.items.pop() as Disposable;
      try {
        item.dispose();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'several disposables failed');
  }
}

/**
 * Wall-clock source. Tests inject a controllable one so expiry and TTL logic is deterministic.
 *
 * There is deliberately no timer API here (contract review C15): moving a test clock fires no setTimeout. Modules use
 * clock.now() for every timestamp and every "has it expired yet" comparison, and real timers only to schedule the
 * next re-check (which then compares with clock.now()). Lock idle / TTL tests lower the host settings (at least
 * 1,000 ms, hostSettingsSchema) and wait in real time instead of advancing the clock; invite expiry, which is checked
 * only when something happens, can use the harness's advanceClock().
 */
export interface Clock {
  now(): number;
  /**
   * Milliseconds from an arbitrary origin that never step backwards (performance.now): for durations and deadlines
   * (watchdogs, TTLs, idle timeouts). A wall clock that NTP or the user steps back an hour must not freeze them
   * (review REL-04). Optional so a test clock can stay a plain `{ now }`; read it with monotonicNow(clock).
   */
  monotonic?(): number;
}

/** The clock's monotonic reading, or its wall time when it has none. */
export function monotonicNow(clock: Clock): number {
  return clock.monotonic ? clock.monotonic() : clock.now();
}

export const systemClock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };

/**
 * Real time plus an offset tests can move forward (expiry, TTLs) while every real timer (heartbeats, acks) keeps
 * working, which a frozen clock would break.
 */
export class ShiftableClock implements Clock {
  private offset = 0;

  now(): number {
    return Date.now() + this.offset;
  }

  /** advance() moves this too: a test that ages a TTL ages it for both readings. */
  monotonic(): number {
    return performance.now() + this.offset;
  }

  advance(ms: number): void {
    this.offset += ms;
  }
}

/** A clock tests can move by hand. */
export class ManualClock implements Clock {
  private value: number;

  constructor(start = 1_760_000_000_000) {
    this.value = start;
  }

  now(): number {
    return this.value;
  }

  monotonic(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }

  set(value: number): void {
    this.value = value;
  }
}

/**
 * Daemon-issued opaque ids (`[A-Za-z0-9_-]{1,64}`, see the protocol's opaqueIdSchema): a short prefix naming the
 * kind of object plus 16 random bytes in base64url. Random, not sequential: ids end up in URLs, logs and file names,
 * and must not reveal how many objects exist or let a client guess another member's ids.
 */
export function newId(prefix: string): string {
  if (!/^[a-z]{1,8}$/.test(prefix)) throw new TypeError('id prefix must be 1-8 lowercase letters');
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
