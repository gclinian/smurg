// Per-member token buckets (ARCHITECTURE §5.9 "Rates"). Counts cap what is stored; rates cap what a member can make
// everyone else's browser and the relay carry. The Router takes one token for a message type whose registry entry
// names a bucket; handlers take `mention` tokens (one per kept mention) and the MCP answers take `agent-notify`.
// A refusal is `rate_limited` and falls under the audit budget like every refusal.
import { AGENT_NOTIFY_PER_MINUTE, RATE_LIMITS_PER_MINUTE, SmurgError } from '@smurg/protocol';
import type { RateBucketName, RateLimiter } from './interfaces.ts';
import type { Clock } from './lifecycle.ts';

const MINUTE_MS = 60_000;
/** Buckets nobody touched for this long are dropped (a full bucket holds no information). */
const IDLE_PRUNE_MS = 10 * MINUTE_MS;
const PRUNE_AT = 4_096;

export const RATE_BUCKET_SIZES: Readonly<Record<RateBucketName, number>> = Object.freeze({
  ...RATE_LIMITS_PER_MINUTE,
  'agent-notify': AGENT_NOTIFY_PER_MINUTE,
});

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBucketLimiter implements RateLimiter {
  private readonly clock: Clock;
  private readonly sizes: Readonly<Record<RateBucketName, number>>;
  private readonly buckets = new Map<string, Bucket>();

  constructor(clock: Clock, sizes: Partial<Record<RateBucketName, number>> = {}) {
    this.clock = clock;
    this.sizes = Object.freeze({ ...RATE_BUCKET_SIZES, ...sizes });
  }

  take(bucket: RateBucketName, key: string, count = 1): boolean {
    const size = this.sizes[bucket];
    if (size === undefined || !Number.isFinite(count) || count <= 0) return false;
    const now = this.clock.now();
    const id = `${bucket}\u0000${key}`;
    let state = this.buckets.get(id);
    if (state === undefined) {
      if (this.buckets.size >= PRUNE_AT) this.prune(now);
      state = { tokens: size, at: now };
      this.buckets.set(id, state);
    } else {
      // Continuous refill: `size` tokens per minute, never above `size`.
      state.tokens = Math.min(size, state.tokens + ((now - state.at) * size) / MINUTE_MS);
      state.at = now;
    }
    if (state.tokens < count) return false;
    state.tokens -= count;
    return true;
  }

  require(bucket: RateBucketName, key: string, count = 1): void {
    if (!this.take(bucket, key, count)) throw new SmurgError('rate_limited', undefined, { reason: 'rate-limited', bucket });
  }

  private prune(now: number): void {
    for (const [id, state] of this.buckets) if (now - state.at >= IDLE_PRUNE_MS) this.buckets.delete(id);
  }
}
