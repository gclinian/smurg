// The column strip under jsdom (no layout engine: the strip's width is given here; the real mouse in a real browser
// is apps/web/e2e/smoke/columns.smoke.test.ts).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Columns, type ColumnsItem, type ColumnsProps } from './Columns.tsx';

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let stripWidth = 0;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  stripWidth = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  // The strip's inner width, as a layout engine would report it (0: not laid out).
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('ui-columns') ? stripWidth : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function frame(): void {
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });
}

const items = (count: number, weights: readonly number[] = []): ColumnsItem[] =>
  ['Cart API', 'Plan', 'Report', 'Spec'].slice(0, count).map((label, index) => ({ id: `c${index + 1}`, weight: weights[index] ?? 1, label, node: <p>{`body of ${label}`}</p> }));

function mount(props: Partial<ColumnsProps> & { width?: number } = {}) {
  const { width = 0, ...rest } = props;
  stripWidth = width;
  const onWeights = vi.fn<(weights: number[]) => void>();
  const onEqualize = vi.fn();
  const onCapacity = vi.fn<(columns: number) => void>();
  const onVisible = vi.fn<(ids: readonly string[]) => void>();
  const all: ColumnsProps = {
    columns: items(3),
    onWeights,
    onEqualize,
    onCapacity,
    onVisible,
    separatorLabel: (column) => `Resize ${column}`,
    moreLabel: (count) => `${count} more`,
    empty: <p>nothing open</p>,
    ...rest,
  };
  const view = render(<Columns {...all} />);
  return { ...view, onWeights, onEqualize, onCapacity, onVisible, rerender: (next: Partial<ColumnsProps>) => view.rerender(<Columns {...all} {...next} />) };
}

const slotWidths = (): string[] => [...document.querySelectorAll<HTMLElement>('.ui-columns__slot')].map((slot) => slot.style.width);
const mouse = (clientX: number, buttons: number, more: Record<string, unknown> = {}) => ({ pointerId: 1, clientX, clientY: 300, buttons, ...more });
const last = <T,>(mock: { mock: { calls: T[][] } }): T => mock.mock.calls.at(-1)?.[0] as T;

describe('Columns: without a layout (a test, a strip that is not laid out yet)', () => {
  it('shows every column with its weight, a named separator between two, and counts all of them as on screen', () => {
    const { onVisible, onCapacity } = mount({ columns: items(3, [2, 1, 1]) });
    expect(screen.getByText('body of Cart API')).toBeTruthy();
    expect(screen.getAllByRole('separator').map((separator) => separator.getAttribute('aria-label'))).toEqual(['Resize Cart API', 'Resize Plan']);
    const slots = [...document.querySelectorAll<HTMLElement>('.ui-columns__slot')];
    expect(slots.map((slot) => slot.style.flexGrow)).toEqual(['2', '1', '1']);
    expect(slots.every((slot) => slot.style.minWidth === '320px')).toBe(true);
    expect(last(onVisible)).toEqual(['c1', 'c2', 'c3']);
    // Nothing was measured: no capacity is claimed.
    expect(onCapacity).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('the keys still trade width between the two neighbours, and a double click asks for equal widths', () => {
    const { onWeights, onEqualize } = mount({ columns: items(2) });
    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(last(onWeights)).toEqual([1.1, 0.9]);
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
    expect(last(onWeights)).toEqual([0.6, 1.4]);
    fireEvent.keyDown(separator, { key: 'a' });
    expect(onWeights).toHaveBeenCalledTimes(2);
    fireEvent.doubleClick(separator);
    expect(onEqualize).toHaveBeenCalledOnce();
  });

  it('with no column it shows what it was given instead', () => {
    mount({ columns: [] });
    expect(screen.getByText('nothing open')).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
  });
});

describe('Columns: measured', () => {
  it('columns that fit share the strip exactly, tell how many fit, and report their widths on the separators', () => {
    const { onCapacity, onVisible } = mount({ width: 1151 });
    // A slot is its column and, except for the last, the 1 px separator behind it.
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    expect(last(onCapacity)).toBe(3);
    expect(last(onVisible)).toEqual(['c1', 'c2', 'c3']);
    expect(screen.getAllByRole('separator').map((separator) => separator.getAttribute('aria-valuenow'))).toEqual(['383', '383']);
    expect(document.querySelector('.ui-columns')?.hasAttribute('data-overflow')).toBe(false);
  });

  it('a fourth column that does not fit is reached sideways: whole columns, and an edge button that says how many more', () => {
    const { onVisible, onCapacity } = mount({ width: 1151, columns: items(4) });
    expect(slotWidths()).toEqual(['384px', '384px', '384px', '383px']);
    expect(last(onCapacity)).toBe(3);
    expect(document.querySelector('.ui-columns')?.hasAttribute('data-overflow')).toBe(true);
    expect(last(onVisible)).toEqual(['c1', 'c2', 'c3']);
    const more = screen.getByRole('button', { name: '1 more' });
    expect(more.className).toContain('ui-columns__more--right');
    expect(screen.queryByRole('button', { name: /more/, hidden: false })).toBe(more);

    // The button scrolls by one column; the strip then says what is out of view on the other side.
    const strip = document.querySelector('.ui-columns') as HTMLElement;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      strip.scrollLeft = options.left ?? 0;
      fireEvent.scroll(strip);
    });
    strip.scrollTo = scrollTo as unknown as typeof strip.scrollTo;
    fireEvent.click(more);
    expect(scrollTo).toHaveBeenCalledWith({ left: 384, behavior: 'auto' });
    expect(last(onVisible)).toEqual(['c2', 'c3', 'c4']);
    const back = screen.getByRole('button', { name: '1 more' });
    expect(back.className).toContain('ui-columns__more--left');
    fireEvent.click(back);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'auto' });
  });

  it('arrow keys move a separator by 16 px (64 px with Shift), Home and End go to the limits', () => {
    const { onWeights } = mount({ width: 1151 });
    const [first] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement];
    const widthsFrom = (weights: number[]): number[] => weights.map((weight) => Math.round(weight * (1149 / 3)));
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(widthsFrom(last(onWeights))).toEqual([399, 367, 383]);
    fireEvent.keyDown(first, { key: 'ArrowLeft', shiftKey: true });
    expect(widthsFrom(last(onWeights))).toEqual([320, 446, 383]);
    fireEvent.keyDown(first, { key: 'End' });
    expect(widthsFrom(last(onWeights))).toEqual([446, 320, 383]);
    fireEvent.keyDown(first, { key: 'Home' });
    expect(widthsFrom(last(onWeights))).toEqual([320, 446, 383]);
    // With a modifier the key is not the separator's.
    fireEvent.keyDown(first, { key: 'ArrowRight', ctrlKey: true });
    expect(onWeights).toHaveBeenCalledTimes(4);
  });

  it('a drag follows the pointer while the primary button is down and tells the new weights once, at the end', () => {
    const { onWeights } = mount({ width: 1151 });
    const [first] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement];
    fireEvent.pointerDown(first, mouse(500, 1, { button: 0 }));
    frame();
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    fireEvent.pointerMove(window, mouse(540, 1));
    frame();
    expect(slotWidths()).toEqual(['424px', '344px', '383px']);
    expect(document.querySelector('.ui-columns')?.hasAttribute('data-dragging')).toBe(true);
    expect(document.documentElement.getAttribute('data-ui-resizing')).toBe('col');
    // Never below a column's minimum.
    fireEvent.pointerMove(window, mouse(900, 1));
    frame();
    expect(slotWidths()).toEqual(['447px', '321px', '383px']);
    expect(onWeights).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, mouse(520, 0));
    expect(onWeights).toHaveBeenCalledOnce();
    expect(last(onWeights).map((weight) => Math.round(weight * 383))).toEqual([403, 363, 383]);
    expect(document.documentElement.hasAttribute('data-ui-resizing')).toBe(false);
    expect(document.querySelector('.ui-columns')?.hasAttribute('data-dragging')).toBe(false);
  });

  it('nothing moves without the primary button: a hover, another pointer, a release the browser never delivered', () => {
    const { onWeights } = mount({ width: 1151 });
    const [first] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement];
    fireEvent.pointerMove(window, mouse(700, 0));
    frame();
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    // The secondary button does not start a drag.
    fireEvent.pointerDown(first, mouse(500, 2, { button: 2 }));
    fireEvent.pointerMove(window, mouse(600, 2));
    frame();
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);

    fireEvent.pointerDown(first, mouse(500, 1, { button: 0 }));
    fireEvent.pointerMove(window, mouse(530, 1, { pointerId: 7 }));
    frame();
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    fireEvent.pointerMove(window, mouse(530, 1));
    frame();
    expect(slotWidths()).toEqual(['414px', '354px', '383px']);
    // A move without the button: the release was lost. The drag is over where it was, and later moves do nothing.
    fireEvent.pointerMove(window, mouse(600, 0));
    expect(onWeights).toHaveBeenCalledOnce();
    fireEvent.pointerMove(window, mouse(650, 1));
    frame();
    expect(onWeights).toHaveBeenCalledOnce();
  });

  it('Escape during a drag puts the widths back and tells nothing', () => {
    const { onWeights } = mount({ width: 1151 });
    const [first] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement];
    fireEvent.pointerDown(first, mouse(500, 1, { button: 0 }));
    fireEvent.pointerMove(window, mouse(560, 1));
    frame();
    expect(slotWidths()).toEqual(['444px', '324px', '383px']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    expect(onWeights).not.toHaveBeenCalled();
    // A press and release without a move changes nothing either.
    fireEvent.pointerDown(first, mouse(500, 1, { button: 0 }));
    fireEvent.pointerUp(window, mouse(500, 0));
    expect(onWeights).not.toHaveBeenCalled();
  });

  it('while the strip overflows a separator changes the column before it only', () => {
    const { onWeights } = mount({ width: 1151, columns: items(4) });
    const [, second] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement, HTMLElement];
    fireEvent.pointerDown(second, mouse(800, 1, { button: 0 }));
    fireEvent.pointerMove(window, mouse(860, 1));
    frame();
    expect(slotWidths()).toEqual(['384px', '444px', '384px', '383px']);
    fireEvent.pointerUp(window, mouse(860, 0));
    expect(last(onWeights).map((weight) => Math.round(weight * 383))).toEqual([383, 443, 383, 383]);
  });

  it('a column that is asked for is brought into view; one that is in view is left alone', () => {
    const view = mount({ width: 1151, columns: items(4) });
    const strip = document.querySelector('.ui-columns') as HTMLElement;
    const scrollTo = vi.fn();
    strip.scrollTo = scrollTo as unknown as typeof strip.scrollTo;
    view.rerender({ columns: items(4), reveal: { id: 'c2', token: 1 } });
    expect(scrollTo).not.toHaveBeenCalled();
    view.rerender({ columns: items(4), reveal: { id: 'c4', token: 2 } });
    expect(scrollTo).toHaveBeenCalledWith({ left: 1152, behavior: 'auto' });
  });

  it('when the columns fit again (the window grew, a column was closed) nothing is "out of view" any more', () => {
    const view = mount({ width: 1151, columns: items(4) });
    const strip = document.querySelector('.ui-columns') as HTMLElement;
    // Scrolled to the last column.
    strip.scrollLeft = 384;
    fireEvent.scroll(strip);
    expect(screen.getByRole('button', { name: '1 more' }).className).toContain('ui-columns__more--left');
    // The left column folds to its rail: all four fit. The browser resets the scroll position without an event.
    stripWidth = 1395;
    strip.scrollLeft = 0;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(slotWidths()).toEqual(['349px', '349px', '349px', '348px']);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    expect(last(view.onVisible)).toEqual(['c1', 'c2', 'c3', 'c4']);
    // And a closed column: three fit a 1151 px strip, even if the element still reports its old scroll position.
    stripWidth = 1151;
    strip.scrollLeft = 384;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    view.rerender({ columns: items(3) });
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    expect(last(view.onVisible)).toEqual(['c1', 'c2', 'c3']);
  });

  it('a strip that is hidden for a while (the other mode is shown) keeps its layout', () => {
    const { onCapacity } = mount({ width: 1151 });
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    const calls = onCapacity.mock.calls.length;
    // display: none reports no width.
    stripWidth = 0;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(slotWidths()).toEqual(['384px', '384px', '383px']);
    expect(onCapacity.mock.calls.length).toBe(calls);
    // Shown again, in a window that changed meanwhile.
    stripWidth = 1300;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(slotWidths()).toEqual(['434px', '434px', '432px']);
  });

  it('follows the window: a narrower strip fits fewer columns', () => {
    const { onCapacity } = mount({ width: 1151 });
    expect(last(onCapacity)).toBe(3);
    stripWidth = 775;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(last(onCapacity)).toBe(2);
    expect(slotWidths()).toEqual(['388px', '388px', '387px']);
    expect(screen.getByRole('button', { name: '1 more' })).toBeTruthy();
  });
});
