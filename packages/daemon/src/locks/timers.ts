// The one timer seam of the locks module. The daemon's Clock has no timer API on purpose (core/lifecycle.ts, contract
// review C15): every "has it expired" decision compares clock.now(), and a real timer only schedules the next
// re-check. Unit tests inject a scheduler driven by a ManualClock so idle and TTL logic runs deterministically.

/** Schedules `fn` after `ms`; the returned function cancels it. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): () => void;
}

/** Real timers, unref'd: a pending lock expiry never keeps the process alive on its own. */
export const realTimers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};
