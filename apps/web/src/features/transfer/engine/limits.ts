// Limits shared by every transfer of one transfer connection (transfer.md §1.3 "pipeline several files, ≤ 16 MiB in
// flight overall"): a byte budget for chunks read but not yet acknowledged, and a counting semaphore for files whose
// begin/chunks/commit run at the same time. Both serve waiters in FIFO order and honour an AbortSignal.
import { abortReason } from './link.ts';

interface Waiter {
  readonly amount: number;
  readonly grant: () => void;
  readonly fail: (error: unknown) => void;
}

/** Hands out `capacity` units; `acquire(n)` resolves with a release function once n units are free. */
export class Budget {
  readonly capacity: number;
  private used = 0;
  private peak = 0;
  private readonly waiters: Waiter[] = [];

  constructor(capacity: number) {
    if (!(Number.isSafeInteger(capacity) && capacity > 0)) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
  }

  get inUse(): number {
    return this.used;
  }

  /** Highest `inUse` seen (tests and the measurement page). */
  get peakInUse(): number {
    return this.peak;
  }

  /**
   * Waits for `amount` units. A request larger than the capacity is granted when nothing else is in use, so an
   * oversized chunk can never deadlock the queue.
   */
  acquire(amount: number, signal?: AbortSignal): Promise<() => void> {
    if (!(Number.isSafeInteger(amount) && amount >= 0)) return Promise.reject(new RangeError('invalid amount'));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.waiters.length === 0 && this.fits(amount)) return Promise.resolve(this.take(amount));
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortReason(signal));
        this.pump();
      };
      const waiter: Waiter = {
        amount,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.take(amount));
        },
        fail: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private fits(amount: number): boolean {
    return this.used + amount <= this.capacity || this.used === 0;
  }

  private take(amount: number): () => void {
    this.used += amount;
    this.peak = Math.max(this.peak, this.used);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= amount;
      this.pump();
    };
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0] as Waiter;
      if (!this.fits(next.amount)) return;
      this.waiters.shift();
      next.grant();
    }
  }
}

/** At most `size` holders at once (files in progress, downloads in progress). */
export class Semaphore extends Budget {
  constructor(size: number) {
    super(size);
  }

  enter(signal?: AbortSignal): Promise<() => void> {
    return this.acquire(1, signal);
  }
}
