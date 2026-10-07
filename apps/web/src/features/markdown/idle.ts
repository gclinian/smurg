// Formatting that was put off, done in slices of the time the browser has nothing more urgent to do.
//
// A text that came after the page's share of parse time was spent (lex.ts `later`) is shown as written, and whoever
// mounted it asks here for its turn. What waits is formatted one text after the other: what is ON SCREEN first, the
// newest first, then the rest, the newest first (a conversation is read from its end). A slice formats texts until
// SLICE_MS have passed, at least one, and then lets go of the thread: the browser draws, answers a click, and runs
// the next slice when nothing more urgent waits.
//
// NOT a React transition. React lets go of the thread only while a transition is younger than five seconds; then its
// lane has expired and everything that is left is rendered in one piece: a column of 400 messages that each took
// 69 ms to format showed its first frame after 0.4 s and then stood still for 22 s (review R4-03, fourth round).
// Here every slice is a task of its own, however long the queue has waited.
//
// A slice is a task of the browser's lowest priority (`scheduler.postTask`, "background": after input, drawing and
// every ordinary task), and a timer where a browser has no such tasks. NOT `requestIdleCallback`: measured in
// Chrome 155, a page whose pointer rests on a button whose menu was just closed is given no idle period at all, and
// the callback only ran when its timeout came (one text every half second for as long as the pointer stayed), while
// background tasks ran one after the other.
//
// ONE text is never cut: a step of the lexer cannot be interrupted, so the longest task is one slice or one text,
// whichever is longer, and a text is bounded by its own budget (lex.ts).

/** A slice formats texts for this long, then lets go of the thread. */
export const SLICE_MS = 30;

/** What the queue needs of the page; tests hand in their own. */
export interface IdleDeps {
  /** Milliseconds. */
  now(): number;
  /** Calls `run` once, when the page has nothing more urgent to do; the handle takes the request back. */
  request(run: () => void): unknown;
  cancel(handle: unknown): void;
  /**
   * Watches elements and says when one comes on screen or leaves it. Absent where the page cannot know: every text
   * counts as on screen there.
   */
  observe?(onChange: (element: Element, onScreen: boolean) => void): { watch(element: Element): void; forget(element: Element): void };
}

export interface IdleQueue {
  /**
   * Asks for a turn: `run` is called once, in a slice, unless the function this returns is called first
   * (the text left the page, or changed). `element` is what shows the text, for "on screen"; null when the caller
   * cannot name one element (a text shown in pieces): it counts as on screen.
   */
  add(element: Element | null, run: () => void): () => void;
  /** How many texts wait. */
  readonly size: number;
}

interface Waiting {
  readonly element: Element | null;
  readonly run: () => void;
  /** The slice during which it asked (0: before the first). */
  readonly round: number;
  onScreen: boolean;
}

export function createIdleQueue(deps: IdleDeps): IdleQueue {
  /** In the order they asked: the newest last. */
  const waiting: Waiting[] = [];
  const byElement = new Map<Element, Waiting>();
  let handle: unknown = null;
  const screen = deps.observe?.((element, onScreen) => {
    const entry = byElement.get(element);
    if (entry !== undefined) entry.onScreen = onScreen;
  });

  const leave = (entry: Waiting): boolean => {
    const at = waiting.lastIndexOf(entry);
    if (at === -1) return false;
    waiting.splice(at, 1);
    if (entry.element !== null && byElement.get(entry.element) === entry) {
      byElement.delete(entry.element);
      screen?.forget(entry.element);
    }
    return true;
  };

  /** The slices so far. */
  let round = 0;

  /**
   * The next text of this slice: the newest of those on screen, else the newest. Not one that asked during this
   * slice: a text that asks again in its own turn (its budget ran out on one piece) waits for the next one.
   */
  const next = (): Waiting | undefined => {
    let newest: Waiting | undefined;
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const entry = waiting[index] as Waiting;
      if (entry.round === round) continue;
      if (entry.onScreen) return entry;
      newest ??= entry;
    }
    return newest;
  };

  const slice = (): void => {
    handle = null;
    round += 1;
    const started = deps.now();
    try {
      for (let entry = next(); entry !== undefined; entry = next()) {
        leave(entry);
        entry.run();
        if (deps.now() - started >= SLICE_MS) break;
      }
    } finally {
      // Also when a text threw: the others still get their turn.
      if (waiting.length > 0 && handle === null) handle = deps.request(slice);
    }
  };

  return {
    add(element, run) {
      const entry: Waiting = { element, run, round, onScreen: element === null || screen === undefined };
      waiting.push(entry);
      if (element !== null) {
        byElement.set(element, entry);
        screen?.watch(element);
      }
      if (handle === null) handle = deps.request(slice);
      return () => {
        if (!leave(entry) || waiting.length > 0 || handle === null) return;
        deps.cancel(handle);
        handle = null;
      };
    },
    get size() {
      return waiting.length;
    },
  };
}

// ---- the page's own queue

/** The part of the browser's task scheduler that is used here (Chrome, Edge, Firefox; not every browser has it). */
interface TaskScheduler {
  postTask(run: () => void, options: { readonly priority: 'background'; readonly signal: AbortSignal }): Promise<unknown>;
}

type Asked = { readonly stop: AbortController } | { readonly timer: ReturnType<typeof setTimeout> };

const browser: IdleDeps = {
  now: () => performance.now(),
  request: (run): Asked => {
    const tasks = (globalThis as { scheduler?: TaskScheduler }).scheduler;
    if (tasks === undefined) return { timer: setTimeout(run, 0) };
    const stop = new AbortController();
    tasks.postTask(run, { priority: 'background', signal: stop.signal }).catch((error: unknown) => {
      // A task that was taken back ends this way too, and that is nothing. What a slice threw is the page's to hear.
      if (!stop.signal.aborted)
        queueMicrotask(() => {
          throw error;
        });
    });
    return { stop };
  },
  cancel: (handle) => {
    const asked = handle as Asked;
    if ('stop' in asked) asked.stop.abort();
    else clearTimeout(asked.timer);
  },
  // One observer of what is on screen for every text that waits.
  ...(typeof IntersectionObserver === 'undefined'
    ? {}
    : {
        observe: (onChange) => {
          const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) onChange(entry.target, entry.isIntersecting);
          });
          return { watch: (element) => observer.observe(element), forget: (element) => observer.unobserve(element) };
        },
      }),
};

let queue: IdleQueue | null = null;

/** Asks the page's queue for a turn (see IdleQueue.add). */
export function formatWhenIdle(element: Element | null, run: () => void): () => void {
  queue ??= createIdleQueue(browser);
  return queue.add(element, run);
}
