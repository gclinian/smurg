// A smoothed transfer rate for the speed and the time left: exponentially weighted over samples at least `minIntervalMs`
// apart, so a burst of four acknowledgements in one millisecond does not read as gigabytes per second.

export class RateMeter {
  private readonly now: () => number;
  private readonly halfLifeMs: number;
  private readonly minIntervalMs: number;
  private lastAt: number | null = null;
  private lastBytes = 0;
  private rate = 0;

  constructor(options: { now?: () => number; halfLifeMs?: number; minIntervalMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.halfLifeMs = options.halfLifeMs ?? 3_000;
    this.minIntervalMs = options.minIntervalMs ?? 250;
  }

  /** Bytes per second, 0 before two samples. */
  get bytesPerSecond(): number {
    return this.rate;
  }

  /** Records the cumulative byte count. A count that goes down (a restart) resets the meter. */
  sample(totalBytes: number): void {
    const at = this.now();
    const restarted = totalBytes < this.lastBytes;
    if (this.lastAt === null || restarted) {
      this.lastAt = at;
      this.lastBytes = totalBytes;
      if (restarted) this.rate = 0;
      return;
    }
    const elapsed = at - this.lastAt;
    if (elapsed < this.minIntervalMs) return;
    const instant = ((totalBytes - this.lastBytes) * 1000) / elapsed;
    const weight = 1 - Math.pow(0.5, elapsed / this.halfLifeMs);
    this.rate = this.rate === 0 ? instant : this.rate + (instant - this.rate) * weight;
    this.lastAt = at;
    this.lastBytes = totalBytes;
  }

  /** Forget the history (paused, offline): the next samples start fresh. */
  reset(): void {
    this.lastAt = null;
    this.rate = 0;
  }
}

/** Remaining time in ms, or null when unknown (no rate yet, unknown total). */
export function remainingMs(totalBytes: number | null, doneBytes: number, bytesPerSecond: number): number | null {
  if (totalBytes === null || bytesPerSecond <= 0) return null;
  return Math.max(0, ((totalBytes - doneBytes) * 1000) / bytesPerSecond);
}
