// Reconnect delays: exponential with jitter, so a relay deploy that drops every socket at once does not bring all
// clients back in the same millisecond (relay.md gotcha 9).

export interface BackoffOptions {
  /** Delay ceiling of the first retry. */
  readonly baseMs?: number;
  /** Largest ceiling. */
  readonly maxMs?: number;
  readonly factor?: number;
  /** Fraction of the ceiling that is randomised: the delay is in [ceiling × (1 − jitter), ceiling]. */
  readonly jitter?: number;
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = Object.freeze({ baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0.5 });

export function resolveBackoff(options: BackoffOptions = {}): Required<BackoffOptions> {
  const merged = { ...DEFAULT_BACKOFF, ...options };
  const finite = (n: number): boolean => Number.isFinite(n) && n >= 0;
  if (!finite(merged.baseMs) || !finite(merged.maxMs) || merged.maxMs < merged.baseMs) throw new RangeError('invalid backoff delays');
  if (!(Number.isFinite(merged.factor) && merged.factor >= 1)) throw new RangeError('backoff factor must be >= 1');
  if (!(merged.jitter >= 0 && merged.jitter <= 1)) throw new RangeError('backoff jitter must be in [0, 1]');
  return Object.freeze(merged);
}

/** Delay before retry number `attempt` (1 = first retry). `random` returns [0, 1). */
export function backoffDelay(attempt: number, options: Required<BackoffOptions>, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(options.maxMs, options.baseMs * options.factor ** (n - 1));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling * (1 - options.jitter * r));
}
