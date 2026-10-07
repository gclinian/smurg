// The queue of texts whose formatting was put off (idle.ts), with a clock, an idle moment and a screen of the test's own.
import { describe, expect, it } from 'vitest';
import { SLICE_MS, createIdleQueue, type IdleDeps } from './idle.ts';

function page(options: { screen?: boolean } = {}) {
  const state = { clock: 0 };
  /** The idle moments the queue asked for and has not been given yet. */
  const asked: (() => void)[] = [];
  const watched = new Set<Element>();
  let tell: ((element: Element, onScreen: boolean) => void) | null = null;
  const deps: IdleDeps = {
    now: () => state.clock,
    request: (run) => {
      asked.push(run);
      return run;
    },
    cancel: (handle) => {
      const at = asked.indexOf(handle as () => void);
      if (at !== -1) asked.splice(at, 1);
    },
    ...(options.screen === false
      ? {}
      : {
          observe: (onChange) => {
            tell = onChange;
            return { watch: (element) => void watched.add(element), forget: (element) => void watched.delete(element) };
          },
        }),
  };
  const queue = createIdleQueue(deps);
  const done: string[] = [];
  return {
    queue,
    done,
    asked,
    watched,
    state,
    /** A text that takes `ms` to format. */
    text(name: string, ms: number, element: Element | null = document.createElement('div')) {
      const cancel = queue.add(element, () => {
        state.clock += ms;
        done.push(name);
      });
      return { element, cancel };
    },
    onScreen(element: Element | null, onScreen = true): void {
      if (element !== null) tell?.(element, onScreen);
    },
    /** The browser has nothing else to do: one idle moment. */
    idle(): boolean {
      const run = asked.shift();
      run?.();
      return run !== undefined;
    },
  };
}

describe('formatting that was put off is done a slice at a time, when the page has nothing more urgent to do (review R4-03, fourth round)', () => {
  it('formats one slice at a time and lets go of the thread between two: never everything that waits in one piece', () => {
    const view = page();
    for (let index = 0; index < 100; index += 1) view.text(`t${index}`, 10);
    // Adding asks for ONE idle moment, and nothing is formatted before it comes.
    expect(view.asked).toHaveLength(1);
    expect(view.done).toEqual([]);
    expect(view.queue.size).toBe(100);
    let slices = 0;
    while (view.idle()) {
      slices += 1;
      // A slice ends with the text that reaches SLICE_MS, and asks for the next idle moment while texts wait.
      expect(view.done).toHaveLength(Math.min(100, slices * (SLICE_MS / 10)));
      expect(view.asked).toHaveLength(view.done.length < 100 ? 1 : 0);
    }
    expect(slices).toBe(Math.ceil(100 / (SLICE_MS / 10)));
    expect(new Set(view.done).size).toBe(100);
    expect(view.queue.size).toBe(0);
  });

  it('a text that costs more than a slice is a slice by itself: one text is never cut, and never joined by another', () => {
    const view = page();
    for (let index = 0; index < 5; index += 1) view.text(`t${index}`, 70);
    view.text('cheap', 1);
    const sizes: number[] = [];
    let before = 0;
    while (view.idle()) {
      sizes.push(view.done.length - before);
      before = view.done.length;
    }
    // Newest first: the cheap one and the dear one after it share the first slice, then one dear text a slice.
    expect(sizes).toEqual([2, 1, 1, 1, 1]);
  });

  it('what is on screen comes first, the newest first; then the rest, the newest first', () => {
    const view = page();
    const texts = Array.from({ length: 8 }, (_, index) => view.text(`t${index}`, SLICE_MS));
    // A column scrolled to its end shows the last rows; the reader then scrolls up to the second.
    view.onScreen((texts[6] as { element: Element }).element);
    view.onScreen((texts[5] as { element: Element }).element);
    view.idle();
    expect(view.done).toEqual(['t6']);
    view.onScreen((texts[1] as { element: Element }).element);
    view.onScreen((texts[5] as { element: Element }).element, false);
    view.idle();
    expect(view.done).toEqual(['t6', 't1']);
    while (view.idle());
    expect(view.done).toEqual(['t6', 't1', 't7', 't5', 't4', 't3', 't2', 't0']);
    // What was formatted is not watched any longer.
    expect(view.watched.size).toBe(0);
  });

  it('a text nobody can place counts as on screen, and so does every text where the page cannot know what is', () => {
    const view = page();
    view.text('first', SLICE_MS);
    view.text('a spec in pieces', SLICE_MS, null);
    view.text('last', SLICE_MS);
    while (view.idle());
    expect(view.done).toEqual(['a spec in pieces', 'last', 'first']);
    const blind = page({ screen: false });
    for (const name of ['a', 'b', 'c']) blind.text(name, SLICE_MS);
    while (blind.idle());
    expect(blind.done).toEqual(['c', 'b', 'a']);
  });

  it('a text that left before its turn is not formatted, and the last one to leave takes the request back', () => {
    const view = page();
    const first = view.text('first', 5);
    const second = view.text('second', 5);
    second.cancel();
    expect(view.watched.has(second.element as Element)).toBe(false);
    expect(view.asked).toHaveLength(1);
    first.cancel();
    first.cancel();
    expect(view.asked).toHaveLength(0);
    expect(view.queue.size).toBe(0);
    // One that comes afterwards is formatted as always, and leaving after the turn changes nothing.
    const third = view.text('third', 5);
    expect(view.idle()).toBe(true);
    third.cancel();
    expect(view.done).toEqual(['third']);
    expect(view.asked).toHaveLength(0);
  });

  it('a text that asks again during its own turn waits for the next slice, and one that throws does not keep the others waiting', () => {
    const view = page();
    let turns = 0;
    const again = (): void => {
      turns += 1;
      view.state.clock += 1;
      if (turns < 3) view.queue.add(null, again);
    };
    view.queue.add(null, again);
    view.text('another', 1);
    view.idle();
    // One turn a slice for the text that asks again, however short its turn was; the other is not kept waiting.
    expect(turns).toBe(1);
    expect(view.done).toEqual(['another']);
    expect(view.asked).toHaveLength(1);
    while (view.idle());
    expect(turns).toBe(3);

    view.text('after', 1);
    view.queue.add(null, () => {
      throw new Error('this text cannot be drawn');
    });
    expect(() => view.idle()).toThrow('this text cannot be drawn');
    expect(view.asked).toHaveLength(1);
    view.idle();
    expect(view.done).toEqual(['another', 'after']);
  });
});
