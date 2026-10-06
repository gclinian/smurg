// The ONE timer behind every text that ages (lib/use-now.ts is its React face; nothing else imports this file but
// lib/format.ts, which tells it when an age in seconds is on screen).
//
// - A caller says how often it must be redrawn at least (`intervalMs`). Ticks fall on the multiples of that interval,
//   so callers of one interval are redrawn in the same instant and read the same time.
// - `formatAge` prints an age under a minute to the second. While such an age is on screen, every caller that shows
//   ages (an interval of AGE_INTERVAL_MS or less) is redrawn each second: a card that just appeared does not say
//   "waiting 0 sec" for ten seconds, and the card, the status bar and the inbox row of one wait count together.
// - `readClock()` is the time of the latest tick while that tick is less than a second old, the real time otherwise:
//   what is drawn within one second shows one time, and a redraw for any other reason (a new card, a column that
//   opens) never reads the time of some tick long ago.

/** Callers that are redrawn at least this often show ages: they follow the seconds while seconds are on screen. */
export const AGE_INTERVAL_MS = 30_000;

/** How long after the latest age in seconds was printed the clock goes on ticking each second. */
const SECONDS_LINGER_MS = 1_500;

const SECOND_MS = 1_000;

interface Subscriber {
  readonly intervalMs: number;
  readonly redraw: () => void;
  /** When the clock last redrew it (at first: when it subscribed). */
  seenAt: number;
}

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** The time the timer is set for; Infinity while none is. */
let timerAt = Number.POSITIVE_INFINITY;
let lastTickAt = Number.NEGATIVE_INFINITY;
let secondsShownAt = Number.NEGATIVE_INFINITY;

const nextMultiple = (intervalMs: number, after: number): number => (Math.floor(after / intervalMs) + 1) * intervalMs;

/** `at` lies less than `windowMs` before `now` (a computer's clock can be set back: a time in the future is not recent). */
const within = (at: number, now: number, windowMs: number): boolean => now >= at && now - at < windowMs;

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerAt = Number.POSITIVE_INFINITY;
  if (subscribers.size === 0) return;
  const now = Date.now();
  let at = Number.POSITIVE_INFINITY;
  for (const subscriber of subscribers) at = Math.min(at, nextMultiple(subscriber.intervalMs, now));
  if (within(secondsShownAt, now, SECONDS_LINGER_MS)) at = Math.min(at, nextMultiple(SECOND_MS, now));
  timerAt = at;
  timer = setTimeout(tick, at - now);
}

function tick(): void {
  timer = null;
  const now = Date.now();
  lastTickAt = now;
  const seconds = within(secondsShownAt, now, SECONDS_LINGER_MS);
  for (const subscriber of [...subscribers]) {
    if (!subscribers.has(subscriber)) continue;
    const due = Math.floor(now / subscriber.intervalMs) !== Math.floor(subscriber.seenAt / subscriber.intervalMs);
    if (!due && !(seconds && subscriber.intervalMs <= AGE_INTERVAL_MS)) continue;
    subscriber.seenAt = now;
    subscriber.redraw();
  }
  schedule();
}

/** Calls `redraw` at least every `intervalMs` (see the head of this file) until the returned function is called. */
export function subscribeClock(intervalMs: number, redraw: () => void): () => void {
  const subscriber: Subscriber = { intervalMs, redraw, seenAt: Date.now() };
  subscribers.add(subscriber);
  schedule();
  return () => {
    subscribers.delete(subscriber);
    schedule();
  };
}

/** The browser's time as everything on screen reads it. */
export function readClock(): number {
  const now = Date.now();
  return within(lastTickAt, now, SECOND_MS) ? lastTickAt : now;
}

/** `formatAge` printed an age in seconds: the clock ticks each second for as long as that goes on. */
export function secondsShown(): void {
  const now = Date.now();
  secondsShownAt = now;
  if (subscribers.size > 0 && timerAt > nextMultiple(SECOND_MS, now)) schedule();
}
