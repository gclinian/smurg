// The separator of SplitPane under pointer events (jsdom has no layout: the boxes are given here; the real mouse in a
// real browser is apps/web/e2e/smoke/splitter.smoke.test.ts). The owner's bug: 「滑鼠碰到線右邊線會自己動」 — a drag that
// never saw its release kept resizing on every later hover. Nothing may move without the primary button down.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPane, type SplitPaneProps } from './SplitPane.tsx';

/** The container's box along the axis. */
const START = 100;
const TOTAL = 1000;

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs the animation frames requested so far. */
function frame(): void {
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });
}

function rect(horizontal: boolean, from: number, size: number): DOMRect {
  const box = horizontal ? { x: from, y: 0, width: size, height: 600 } : { x: 0, y: from, width: 600, height: size };
  return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box } as DOMRect;
}

/** Gives the split the boxes a browser would: the separator sits where the fixed pane's inline size puts it. */
function layOut(horizontal = true): { container: HTMLElement; separator: HTMLElement; fixedPane: HTMLElement } {
  const container = document.querySelector('.ui-split') as HTMLElement;
  const separator = container.querySelector(':scope > .ui-split__separator') as HTMLElement;
  const fixedPane = container.querySelector(':scope > .ui-split__pane--fixed') as HTMLElement;
  const fixedFirst = container.firstElementChild === fixedPane;
  container.getBoundingClientRect = () => rect(horizontal, START, TOTAL);
  separator.getBoundingClientRect = () => {
    const size = parseFloat(horizontal ? fixedPane.style.width : fixedPane.style.height);
    return rect(horizontal, fixedFirst ? START + size : START + TOTAL - size - 1, 1);
  };
  return { container, separator, fixedPane };
}

function mount(props: Partial<SplitPaneProps> = {}) {
  const all: SplitPaneProps = { orientation: 'horizontal', fixed: 'end', defaultSize: 420, minSize: 260, maxSize: 1100, label: 'agent', start: <p>editor</p>, end: <p>terminal</p>, ...props };
  const view = render(<SplitPane {...all} />);
  return { ...view, ...layOut(all.orientation === 'horizontal'), rerender: (next: Partial<SplitPaneProps>) => view.rerender(<SplitPane {...all} {...next} />) };
}

const sizeOf = (): number => Number(screen.getByRole('separator').getAttribute('aria-valuenow'));
/** Where the separator's line is, for a pane fixed at the end. */
const lineOf = (size: number): number => START + TOTAL - size - 1;
const mouse = (clientX: number, buttons: number, more: Record<string, unknown> = {}) => ({ pointerId: 1, clientX, clientY: 300, buttons, ...more });

function press(separator: HTMLElement, clientX: number): void {
  fireEvent.pointerDown(separator, mouse(clientX, 1, { button: 0 }));
}

describe('SplitPane: the separator under a pointer', () => {
  it('a hover without a button never resizes: over the line from either side, and anywhere else', () => {
    const { separator } = mount();
    const line = lineOf(420);
    for (const x of [line + 20, line + 3, line + 1, line, line - 1, line - 3, line - 20, line, line + 20]) {
      fireEvent.pointerMove(separator, mouse(x, 0));
      fireEvent.pointerMove(window, mouse(x, 0));
    }
    frame();
    expect(sizeOf()).toBe(420);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('a press alone moves nothing, and the line then follows the pointer pixel for pixel from where it was grabbed (either side of the line)', () => {
    for (const grabbedAt of [-3, 0, 3]) {
      const { separator, unmount } = mount();
      const from = lineOf(420) + grabbedAt;
      press(separator, from);
      frame();
      expect(sizeOf()).toBe(420);
      fireEvent.pointerMove(window, mouse(from - 1, 1));
      frame();
      expect(sizeOf()).toBe(421);
      fireEvent.pointerMove(window, mouse(from - 100, 1));
      frame();
      expect(sizeOf()).toBe(520);
      fireEvent.pointerMove(window, mouse(from + 60, 1));
      frame();
      expect(sizeOf()).toBe(360);
      fireEvent.pointerUp(window, mouse(from + 60, 0));
      unmount();
    }
  });

  it('a pane fixed at the start follows the same way, and a stacked split follows clientY', () => {
    const first = mount({ fixed: 'start', defaultSize: 260, minSize: 160, maxSize: 640 });
    press(first.separator, START + 260 + 2);
    fireEvent.pointerMove(window, mouse(START + 260 + 2 + 50, 1));
    frame();
    expect(sizeOf()).toBe(310);
    fireEvent.pointerUp(window, mouse(START + 260 + 2 + 50, 0));
    first.unmount();

    const stacked = mount({ orientation: 'vertical', fixed: 'end', defaultSize: 200, minSize: 96, maxSize: 900 });
    const line = lineOf(200);
    fireEvent.pointerDown(stacked.separator, { pointerId: 1, button: 0, buttons: 1, clientX: 50, clientY: line - 2 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 999, clientY: line - 2 - 40 });
    frame();
    expect(sizeOf()).toBe(240);
    expect(stacked.fixedPane.style.height).toBe('240px');
    expect(stacked.separator.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('moves are applied once per frame, the last one wins', () => {
    const { separator } = mount();
    const line = lineOf(420);
    press(separator, line);
    for (const dx of [5, 10, 15, 20, 30]) fireEvent.pointerMove(window, mouse(line - dx, 1));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(sizeOf()).toBe(420);
    frame();
    expect(sizeOf()).toBe(450);
  });

  it('reads the layout at the press and when the window is resized, never per move', () => {
    const { separator, container } = mount();
    const read = vi.fn(() => rect(true, START, TOTAL));
    container.getBoundingClientRect = read;
    const line = lineOf(420);
    press(separator, line);
    expect(read).toHaveBeenCalledTimes(1);
    for (const dx of [10, 20, 30]) {
      fireEvent.pointerMove(window, mouse(line - dx, 1));
      frame();
    }
    expect(sizeOf()).toBe(450);
    expect(read).toHaveBeenCalledTimes(1);
    // The window lost 200 px on the right: the same pointer now leaves the pane 200 px less.
    container.getBoundingClientRect = () => rect(true, START, TOTAL - 200);
    fireEvent(window, new Event('resize'));
    fireEvent.pointerMove(window, mouse(line - 100, 1));
    frame();
    expect(sizeOf()).toBe(320);
  });

  it('the release stops the line where the button went up, at once; the size is remembered; nothing follows the pointer afterwards', () => {
    const { separator, container } = mount({ storageKey: 'right' });
    const line = lineOf(420);
    press(separator, line);
    expect(container.hasAttribute('data-dragging')).toBe(true);
    expect(separator.hasAttribute('data-dragging')).toBe(true);
    expect(document.documentElement.getAttribute('data-ui-resizing')).toBe('col');
    fireEvent.pointerMove(window, mouse(line - 40, 1));
    // The release arrives before the frame of the last move: its own position counts.
    fireEvent.pointerUp(window, mouse(line - 70, 0));
    expect(sizeOf()).toBe(490);
    expect(window.localStorage.getItem('smurg.pane.right')).toBe('490');
    expect(container.hasAttribute('data-dragging')).toBe(false);
    expect(document.documentElement.hasAttribute('data-ui-resizing')).toBe(false);
    for (const x of [line - 200, line, line + 200]) {
      fireEvent.pointerMove(window, mouse(x, 0));
      fireEvent.pointerMove(separator, mouse(x, 1));
      fireEvent.pointerMove(window, mouse(x, 1));
    }
    frame();
    expect(sizeOf()).toBe(490);
  });

  it('a drag whose release never arrives ends with the first move that has no primary button, and moves nothing (the line that fled from the pointer)', () => {
    const { separator, container } = mount({ storageKey: 'right' });
    const line = lineOf(420);
    press(separator, line);
    fireEvent.pointerMove(window, mouse(line - 30, 1));
    frame();
    expect(sizeOf()).toBe(450);
    // No pointerup: the right button went down, the left one up (Chrome drops the capture), the pointer keeps moving.
    fireEvent.pointerMove(window, mouse(line - 60, 2));
    frame();
    expect(sizeOf()).toBe(450);
    expect(container.hasAttribute('data-dragging')).toBe(false);
    expect(window.localStorage.getItem('smurg.pane.right')).toBe('450');
    // Hovering over the line from the right, one pixel at a time, no button: it stays.
    const now = lineOf(450);
    for (let x = now + 20; x >= now - 80; x--) {
      fireEvent.pointerMove(separator, mouse(x, 0));
      fireEvent.pointerMove(window, mouse(x, 0));
    }
    frame();
    expect(sizeOf()).toBe(450);
  });

  it('a lost pointer capture, a cancelled pointer and a window that loses the focus each end the drag', () => {
    const endings: ((separator: HTMLElement) => void)[] = [
      (separator) => fireEvent.lostPointerCapture(separator, { pointerId: 1 }),
      () => fireEvent.pointerCancel(window, mouse(0, 0)),
      () => fireEvent.blur(window),
    ];
    for (const end of endings) {
      const { separator, container, unmount } = mount();
      const line = lineOf(420);
      press(separator, line);
      fireEvent.pointerMove(window, mouse(line - 25, 1));
      frame();
      end(separator);
      expect(container.hasAttribute('data-dragging')).toBe(false);
      expect(document.documentElement.hasAttribute('data-ui-resizing')).toBe(false);
      // Even a move that claims the button is down: nobody listens any more.
      fireEvent.pointerMove(window, mouse(line - 300, 1));
      frame();
      expect(sizeOf()).toBe(445);
      unmount();
    }
  });

  it('a move still waiting for its frame is not lost when the drag ends', () => {
    const { separator } = mount();
    const line = lineOf(420);
    press(separator, line);
    fireEvent.pointerMove(window, mouse(line - 25, 1));
    fireEvent.lostPointerCapture(separator, { pointerId: 1 });
    expect(sizeOf()).toBe(445);
  });

  it('Escape ends the drag and puts the size back; the key reaches nothing else', () => {
    const { separator } = mount({ storageKey: 'right' });
    const onKey = vi.fn();
    document.body.addEventListener('keydown', onKey);
    const line = lineOf(420);
    press(separator, line);
    fireEvent.pointerMove(window, mouse(line - 90, 1));
    frame();
    expect(sizeOf()).toBe(510);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(sizeOf()).toBe(420);
    expect(onKey).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('smurg.pane.right')).toBe('420');
    fireEvent.pointerMove(window, mouse(line - 200, 1));
    frame();
    expect(sizeOf()).toBe(420);
    // Outside a drag Escape is not the separator's.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onKey).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('keydown', onKey);
  });

  it('only the primary button starts a drag; another pointer does not move it; the context menu stays closed during it', () => {
    const { separator } = mount();
    const line = lineOf(420);
    fireEvent.pointerDown(separator, mouse(line, 2, { button: 2 }));
    fireEvent.pointerMove(window, mouse(line - 50, 2));
    frame();
    expect(sizeOf()).toBe(420);
    expect(fireEvent.contextMenu(separator)).toBe(true);

    press(separator, line);
    fireEvent.pointerMove(window, mouse(line - 50, 1, { pointerId: 9 }));
    frame();
    expect(sizeOf()).toBe(420);
    fireEvent.pointerUp(window, mouse(line - 50, 0, { pointerId: 9 }));
    // Prevented while the button is down: a native menu would swallow the release.
    expect(fireEvent.contextMenu(separator)).toBe(false);
    fireEvent.pointerMove(window, mouse(line - 50, 1));
    frame();
    expect(sizeOf()).toBe(470);
    fireEvent.pointerUp(window, mouse(line - 50, 0));
    expect(fireEvent.contextMenu(separator)).toBe(true);
  });

  it('the press does not take the focus or start a selection (preventDefault), and a second press ends a drag that is still open', () => {
    const { separator } = mount();
    const line = lineOf(420);
    expect(fireEvent.pointerDown(separator, mouse(line, 1, { button: 0 }))).toBe(false);
    fireEvent.pointerMove(window, mouse(line - 10, 1));
    // No release seen; the next press grabs the line where it now is.
    press(separator, lineOf(430) + 2);
    expect(sizeOf()).toBe(430);
    fireEvent.pointerMove(window, mouse(lineOf(430) + 2 - 5, 1));
    frame();
    expect(sizeOf()).toBe(435);
  });

  it('the limits: minSize, maxSize, and the other pane keeps minOtherSize of the container', () => {
    const { separator } = mount({ minOtherSize: 300 });
    const line = lineOf(420);
    press(separator, line);
    fireEvent.pointerMove(window, mouse(-5000, 1));
    frame();
    // 1000 px container − 1 px line − 300 px for the editor.
    expect(sizeOf()).toBe(699);
    fireEvent.pointerMove(window, mouse(5000, 1));
    frame();
    expect(sizeOf()).toBe(260);
    fireEvent.pointerUp(window, mouse(5000, 0));
    fireEvent.keyDown(separator, { key: 'End' });
    expect(sizeOf()).toBe(699);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(sizeOf()).toBe(260);
    expect((document.querySelector('.ui-split') as HTMLElement).style.getPropertyValue('--ui-split-min-other')).toBe('300px');
  });

  it('a double click comes back to the default size and remembers it', () => {
    const { separator } = mount({ storageKey: 'right' });
    const line = lineOf(420);
    press(separator, line);
    fireEvent.pointerUp(window, mouse(line - 150, 0));
    expect(sizeOf()).toBe(570);
    fireEvent.doubleClick(separator);
    expect(sizeOf()).toBe(420);
    expect(window.localStorage.getItem('smurg.pane.right')).toBe('420');
  });

  it('remembers the size per browser: read at mount (clamped), written by the keyboard too; a corrupt value is ignored', () => {
    window.localStorage.setItem('smurg.pane.right', '512');
    const first = mount({ storageKey: 'right' });
    expect(sizeOf()).toBe(512);
    expect(first.fixedPane.style.width).toBe('512px');
    fireEvent.keyDown(first.separator, { key: 'ArrowLeft' });
    expect(sizeOf()).toBe(528);
    expect(window.localStorage.getItem('smurg.pane.right')).toBe('528');
    first.unmount();

    window.localStorage.setItem('smurg.pane.right', '99999');
    const big = mount({ storageKey: 'right' });
    expect(sizeOf()).toBe(1100);
    big.unmount();

    window.localStorage.setItem('smurg.pane.right', '{"not":"a number"');
    mount({ storageKey: 'right' });
    expect(sizeOf()).toBe(420);
  });

  it('a pane collapsed or maximised under a pressed button ends the drag: the separator that comes back does not follow a hover', () => {
    for (const away of [{ collapsed: true }, { maximized: true }]) {
      const view = mount();
      const line = lineOf(420);
      press(view.separator, line);
      fireEvent.pointerMove(window, mouse(line - 30, 1));
      frame();
      expect(sizeOf()).toBe(450);
      view.rerender(away);
      expect(screen.queryByRole('separator')).toBeNull();
      expect(document.documentElement.hasAttribute('data-ui-resizing')).toBe(false);
      // The release goes to whatever is under the pointer now.
      fireEvent.pointerUp(document.body, mouse(line - 30, 0));
      view.rerender({ collapsed: false, maximized: false });
      const { separator } = layOut();
      for (let x = lineOf(450) + 10; x >= lineOf(450) - 40; x--) {
        fireEvent.pointerMove(separator, mouse(x, 0));
        fireEvent.pointerMove(window, mouse(x, 0));
      }
      frame();
      expect(sizeOf()).toBe(450);
      view.unmount();
    }
  });

  it('unmounting during a drag leaves nothing behind', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { separator, unmount } = mount();
    press(separator, lineOf(420));
    fireEvent.pointerMove(window, mouse(lineOf(420) - 10, 1));
    unmount();
    expect(document.documentElement.hasAttribute('data-ui-resizing')).toBe(false);
    expect(frames.size).toBe(0);
    expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel', 'blur', 'keydown', 'contextmenu']));
  });
});
