import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, backoffDelay, resolveBackoff } from './backoff.ts';

describe('backoffDelay', () => {
  const options = resolveBackoff();

  it('grows exponentially up to the cap', () => {
    const ceilings = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffDelay(n, options, () => 0));
    expect(ceilings).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('jitters within [ceiling × (1 − jitter), ceiling]', () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const delay = backoffDelay(3, options, () => r);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
    expect(backoffDelay(3, options, () => 0.5)).toBe(1_500);
  });

  it('clamps nonsense inputs', () => {
    expect(backoffDelay(0, options, () => 0)).toBe(500);
    expect(backoffDelay(2, options, () => 7)).toBe(500);
    expect(backoffDelay(2, options, () => -1)).toBe(1_000);
  });

  it('validates options', () => {
    expect(resolveBackoff({})).toEqual(DEFAULT_BACKOFF);
    expect(() => resolveBackoff({ baseMs: 10, maxMs: 5 })).toThrow(RangeError);
    expect(() => resolveBackoff({ factor: 0.5 })).toThrow(RangeError);
    expect(() => resolveBackoff({ jitter: 2 })).toThrow(RangeError);
    expect(resolveBackoff({ jitter: 0 }).jitter).toBe(0);
  });
});
