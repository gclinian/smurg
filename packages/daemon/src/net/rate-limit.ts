// Handshake budget (ARCHITECTURE §4.2 "Deadlines and limits"; noise.md gotcha 3): a plain-XX HELLO is 32 arbitrary
// bytes, so anyone who can reach the daemon through the relay can make it spend DH work and park a handshake.
// A token bucket bounds the rate, a counter bounds the handshakes in flight.
import type { Clock } from '../core/lifecycle.ts';

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: Clock;
  private tokens: number;
  private last: number;

  constructor(options: { readonly perMinute: number; readonly burst?: number; readonly clock: Clock }) {
    this.capacity = Math.max(1, options.burst ?? options.perMinute);
    this.refillPerMs = options.perMinute / 60_000;
    this.clock = options.clock;
    this.tokens = this.capacity;
    this.last = options.clock.now();
  }

  take(): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Jittered exponential backoff for relay reconnects (relay.md gotcha 9). */
export function backoffDelay(attempt: number, options: { readonly baseMs: number; readonly maxMs: number; readonly jitter: number }, random: () => number = Math.random): number {
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, Math.min(attempt, 20)));
  const spread = exp * options.jitter;
  return Math.max(0, Math.round(exp - spread + random() * 2 * spread));
}
