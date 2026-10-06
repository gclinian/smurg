// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { KEY_BIG_STEP, KEY_STEP, clampSize, dragMove, grabOffset, primaryPressed, sizeFromKey, sizeFromPointer, sizeFromSeparator, splitLimits, storedSize, type SplitGeometry } from './split-resize.ts';

/** A pane fixed to the right edge of a 1440 px window (code mode's session column): a 1179 px container right of the file tree, a 1 px separator. */
const geometry: SplitGeometry = { containerStart: 261, containerSize: 1179, separatorSize: 1 };
const base = { minSize: 260, maxSize: 1100, minOther: 160, separatorSize: 1 };

describe('splitLimits', () => {
  it('is [minSize, maxSize] while the container is not laid out', () => {
    expect(splitLimits({ ...base, containerSize: null })).toEqual({ min: 260, max: 1100 });
    expect(splitLimits({ ...base, containerSize: 0 })).toEqual({ min: 260, max: 1100 });
  });

  it('leaves the other pane its minimum: the maximum is bounded by the container', () => {
    expect(splitLimits({ ...base, containerSize: 1179 })).toEqual({ min: 260, max: 1018 });
    expect(splitLimits({ ...base, containerSize: 4000 })).toEqual({ min: 260, max: 1100 });
    expect(splitLimits({ ...base, containerSize: 700.6 })).toEqual({ min: 260, max: 539 });
  });

  it('keeps minSize when the container is too small for both minimums (max never below min)', () => {
    expect(splitLimits({ ...base, containerSize: 300 })).toEqual({ min: 260, max: 260 });
  });
});

describe('clampSize', () => {
  const limits = { min: 100, max: 400 };
  it('rounds to whole pixels inside the limits', () => {
    expect(clampSize(250.4, limits)).toBe(250);
    expect(clampSize(250.5, limits)).toBe(251);
    expect(clampSize(-20, limits)).toBe(100);
    expect(clampSize(9999, limits)).toBe(400);
  });
  it('falls back to the minimum for anything that is not a finite number', () => {
    expect(clampSize(Number.NaN, limits)).toBe(100);
    expect(clampSize(Number.POSITIVE_INFINITY, limits)).toBe(100);
  });
});

describe('storedSize', () => {
  it('accepts finite numbers only', () => {
    expect(storedSize(321)).toBe(321);
    expect(storedSize('321')).toBeNull();
    expect(storedSize(Number.NaN)).toBeNull();
    expect(storedSize(null)).toBeNull();
    expect(storedSize(undefined)).toBeNull();
    expect(storedSize({ size: 1 })).toBeNull();
  });
});

describe('sizeFromPointer: the separator stays under the pointer where it was grabbed', () => {
  // A 420 px pane fixed at the END: the separator's leading edge is at 261 + 1179 - 420 - 1 = 1019.
  const separatorAtEnd = 1019;
  // A 260 px pane fixed at the START of a container that begins at 0: the separator is at 260.
  const atStart: SplitGeometry = { containerStart: 0, containerSize: 1440, separatorSize: 1 };

  it('a press alone changes nothing, wherever in the grab area it lands (no jump to the pointer)', () => {
    for (const pressAt of [separatorAtEnd - 3, separatorAtEnd, separatorAtEnd + 0.5, separatorAtEnd + 3]) {
      const grab = grabOffset(pressAt, separatorAtEnd);
      expect(sizeFromPointer(pressAt, grab, geometry, 'end')).toBe(420);
    }
    for (const pressAt of [257, 260, 263]) {
      expect(sizeFromPointer(pressAt, grabOffset(pressAt, 260), atStart, 'start')).toBe(260);
    }
  });

  it('a pane fixed at the end grows as the pointer moves towards the start, pixel for pixel', () => {
    const grab = grabOffset(separatorAtEnd + 3, separatorAtEnd);
    expect(sizeFromPointer(separatorAtEnd + 3 - 100, grab, geometry, 'end')).toBe(520);
    expect(sizeFromPointer(separatorAtEnd + 3 + 60, grab, geometry, 'end')).toBe(360);
  });

  it('a pane fixed at the start grows as the pointer moves towards the end, pixel for pixel', () => {
    const grab = grabOffset(257, 260);
    expect(sizeFromPointer(357, grab, atStart, 'start')).toBe(360);
    expect(sizeFromPointer(157, grab, atStart, 'start')).toBe(160);
  });

  it('is measured inside the container: a container that starts elsewhere gives the same size for the same offset', () => {
    const moved: SplitGeometry = { containerStart: 500, containerSize: 1179, separatorSize: 1 };
    expect(sizeFromPointer(500 + 300, 0, moved, 'start')).toBe(300);
    expect(sizeFromPointer(500 + 1179 - 421, 0, moved, 'end')).toBe(420);
  });

  it('sizeFromSeparator reads the size on screen back from where the separator is', () => {
    expect(sizeFromSeparator(separatorAtEnd, geometry, 'end')).toBe(420);
    expect(sizeFromSeparator(260, atStart, 'start')).toBe(260);
  });

  it('a pointer far outside the container is brought back by the limits', () => {
    const limits = splitLimits({ ...base, containerSize: geometry.containerSize });
    expect(clampSize(sizeFromPointer(-5000, 0, geometry, 'end'), limits)).toBe(1018);
    expect(clampSize(sizeFromPointer(5000, 0, geometry, 'end'), limits)).toBe(260);
  });
});

describe('sizeFromKey', () => {
  const limits = { min: 100, max: 400 };
  const at = (key: string, options: Partial<Parameters<typeof sizeFromKey>[1]> = {}) =>
    sizeFromKey(key, { orientation: 'horizontal', fixed: 'start', shiftKey: false, size: 200, limits, ...options });

  it('arrows move the separator the way they point', () => {
    expect(at('ArrowRight')).toBe(200 + KEY_STEP);
    expect(at('ArrowLeft')).toBe(200 - KEY_STEP);
    // A pane fixed at the end is on the far side of the separator: right shrinks it.
    expect(at('ArrowRight', { fixed: 'end' })).toBe(200 - KEY_STEP);
    expect(at('ArrowLeft', { fixed: 'end' })).toBe(200 + KEY_STEP);
    expect(at('ArrowDown', { orientation: 'vertical' })).toBe(200 + KEY_STEP);
    expect(at('ArrowUp', { orientation: 'vertical', fixed: 'end' })).toBe(200 + KEY_STEP);
  });

  it('Shift takes a bigger step; Home and End jump to the limits; steps stop at the limits', () => {
    expect(at('ArrowLeft', { shiftKey: true })).toBe(200 - KEY_BIG_STEP);
    expect(at('Home')).toBe(100);
    expect(at('End')).toBe(400);
    expect(at('ArrowRight', { size: 395 })).toBe(400);
    expect(at('ArrowLeft', { size: 104, shiftKey: true })).toBe(100);
  });

  it('the other axis and every other key are not the separator\'s', () => {
    expect(at('ArrowUp')).toBeNull();
    expect(at('ArrowDown')).toBeNull();
    expect(at('ArrowLeft', { orientation: 'vertical' })).toBeNull();
    expect(at('Enter')).toBeNull();
    expect(at('a')).toBeNull();
  });
});

describe('dragMove: nothing moves without the primary button', () => {
  it('reads the primary button from `buttons`', () => {
    expect(primaryPressed(1)).toBe(true);
    expect(primaryPressed(3)).toBe(true);
    expect(primaryPressed(0)).toBe(false);
    expect(primaryPressed(2)).toBe(false);
    expect(primaryPressed(4)).toBe(false);
  });

  it('follows the dragging pointer while its primary button is down', () => {
    expect(dragMove(1, { pointerId: 1, buttons: 1 })).toBe('move');
    expect(dragMove(1, { pointerId: 1, buttons: 3 })).toBe('move');
  });

  it('ends the drag on a move without the primary button: the release was never delivered', () => {
    expect(dragMove(1, { pointerId: 1, buttons: 0 })).toBe('end');
    // Left released while the right button is still down (Chrome then drops the pointer capture).
    expect(dragMove(1, { pointerId: 1, buttons: 2 })).toBe('end');
  });

  it('ignores another pointer', () => {
    expect(dragMove(1, { pointerId: 7, buttons: 1 })).toBe('ignore');
    expect(dragMove(1, { pointerId: 7, buttons: 0 })).toBe('ignore');
  });
});
