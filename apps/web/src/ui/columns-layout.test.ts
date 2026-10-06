// @vitest-environment node
// The arithmetic of the column strip: how wide each column is, what a separator does, what is on screen (UX §2, §9).
import { describe, expect, it } from 'vitest';
import { COLUMN_MIN_PX, columnsThatFit, layoutStrip, resizeStrip, viewStrip, weightsFromWidths } from './columns-layout.ts';

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

describe('column strip layout', () => {
  it('the table of UX §9: how many whole columns of 320 px fit beside the left column', () => {
    // window − left column − its separator
    expect(columnsThatFit({ available: 1440 - 288 - 1 })).toBe(3);
    expect(columnsThatFit({ available: 1440 - 44 - 1 })).toBe(4);
    expect(columnsThatFit({ available: 1024 - 248 - 1 })).toBe(2);
    expect(columnsThatFit({ available: 1024 - 44 - 1 })).toBe(3);
    // One column is always shown, however small the window.
    expect(columnsThatFit({ available: 200 })).toBe(1);
    expect(columnsThatFit({ available: 0 })).toBe(1);
    expect(columnsThatFit({ available: Number.NaN })).toBe(1);
    expect(columnsThatFit({ available: 641 })).toBe(2);
    expect(columnsThatFit({ available: 640 })).toBe(1);
  });

  it('columns that fit share the strip exactly, in whole pixels, in proportion to their weights', () => {
    const equal = layoutStrip([1, 1, 1], { available: 1151 });
    expect(equal).toMatchObject({ fits: 3, overflow: false });
    expect(equal.widths).toEqual([383, 383, 383]);
    expect(sum(equal.widths) + 2).toBe(1151);

    const odd = layoutStrip([1, 1, 1], { available: 1152 });
    expect(sum(odd.widths) + 2).toBe(1152);
    expect(Math.max(...odd.widths) - Math.min(...odd.widths)).toBeLessThanOrEqual(1);

    const weighted = layoutStrip([2, 1], { available: 1201 });
    expect(weighted.widths).toEqual([800, 400]);
    expect(layoutStrip([1], { available: 900 }).widths).toEqual([900]);
    expect(layoutStrip([], { available: 900 })).toMatchObject({ widths: [], overflow: false });
  });

  it('no column goes below the minimum: a small weight gets 320 px and the others share the rest', () => {
    const { widths } = layoutStrip([0.2, 1, 1], { available: 1151 });
    expect(widths[0]).toBe(COLUMN_MIN_PX);
    expect(widths[1]).toBeGreaterThanOrEqual(COLUMN_MIN_PX);
    expect(sum(widths) + 2).toBe(1151);
    // Two small weights of three.
    const two = layoutStrip([0.2, 0.2, 5], { available: 1151 });
    expect(two.widths).toEqual([320, 320, 509]);
    // Broken weights count as 1.
    expect(layoutStrip([Number.NaN, -3], { available: 801 }).widths).toEqual([400, 400]);
  });

  it('more columns than fit: whole columns, and the strip scrolls', () => {
    // 1440 px window, left column shown: 3 fit, 4 are open.
    const layout = layoutStrip([1, 1, 1, 1], { available: 1151 });
    expect(layout).toMatchObject({ fits: 3, overflow: true });
    expect(layout.widths).toEqual([383, 383, 383, 383]);
    // Three of them fill the view exactly: nothing is cut.
    expect(383 * 3 + 2).toBe(1151);
    // A wider column pushes the rest along; none goes below the minimum.
    expect(layoutStrip([1.5, 1, 0.5, 1], { available: 1151 }).widths).toEqual([575, 383, 320, 383]);
    // A window that fits one column only.
    expect(layoutStrip([1, 1], { available: 500 })).toMatchObject({ fits: 1, overflow: true, widths: [500, 500] });
  });

  it('a separator trades width between its two neighbours and stops at their minimums', () => {
    const widths = [400, 400, 351];
    expect(resizeStrip(widths, 0, 50, { overflow: false })).toEqual([450, 350, 351]);
    expect(resizeStrip(widths, 0, -50, { overflow: false })).toEqual([350, 450, 351]);
    expect(resizeStrip(widths, 0, 500, { overflow: false })).toEqual([480, 320, 351]);
    expect(resizeStrip(widths, 0, -500, { overflow: false })).toEqual([320, 480, 351]);
    expect(resizeStrip(widths, 1, 100, { overflow: false })).toEqual([400, 431, 320]);
    // The sum never changes; a separator that does not exist changes nothing.
    expect(sum(resizeStrip(widths, 1, 17.4, { overflow: false }))).toBe(sum(widths));
    expect(resizeStrip(widths, 2, 50, { overflow: false })).toEqual(widths);
    expect(resizeStrip(widths, 9, 50, { overflow: false })).toEqual(widths);
    expect(resizeStrip(widths, 0, Number.NaN, { overflow: false })).toEqual(widths);
  });

  it('while the strip overflows a separator changes the column before it and the rest move along', () => {
    const widths = [383, 383, 383, 383];
    expect(resizeStrip(widths, 1, 60, { overflow: true })).toEqual([383, 443, 383, 383]);
    expect(resizeStrip(widths, 1, -200, { overflow: true })).toEqual([383, 320, 383, 383]);
    expect(resizeStrip(widths, 3, 40, { overflow: true })).toEqual([383, 383, 383, 423]);
    expect(resizeStrip(widths, 0, 5_000, { overflow: true, max: 1150 })).toEqual([1150, 383, 383, 383]);
  });

  it('weights are the inverse of the layout in both regimes', () => {
    for (const available of [1151, 1395, 775, 979]) {
      for (const weights of [[1, 1], [1.3, 0.7, 1], [1, 1, 1, 1], [2, 0.5, 1, 1.4]]) {
        const layout = layoutStrip(weights, { available });
        const again = layoutStrip(weightsFromWidths(layout.widths, layout), { available });
        expect(again.widths, `${available} ${weights.join(',')}`).toEqual(layout.widths);
      }
    }
    // After a drag the new widths come back from the weights that were stored.
    const layout = layoutStrip([1, 1, 1], { available: 1151 });
    const dragged = resizeStrip(layout.widths, 0, 37, { overflow: false });
    expect(layoutStrip(weightsFromWidths(dragged, layout), { available: 1151 }).widths).toEqual(dragged);
    const overflow = layoutStrip([1, 1, 1, 1], { available: 1151 });
    const pulled = resizeStrip(overflow.widths, 2, 55, { overflow: true });
    expect(layoutStrip(weightsFromWidths(pulled, overflow), { available: 1151 }).widths).toEqual(pulled);
  });

  it('widths come back exactly from their weights, pixel for pixel, for every split of a strip', () => {
    // Every position of one separator between two columns of a 1151 px strip, and of the first of three.
    for (let first = 320; first <= 1150 - 320; first += 1) {
      const two = { unit: 1150 / 2 };
      expect(layoutStrip(weightsFromWidths([first, 1150 - first], two), { available: 1151 }).widths).toEqual([first, 1150 - first]);
    }
    for (let first = 320; first <= 1149 - 320 - 383; first += 1) {
      const widths = [first, 1149 - 383 - first, 383];
      expect(layoutStrip(weightsFromWidths(widths, { unit: 1149 / 3 }), { available: 1151 }).widths).toEqual(widths);
    }
  });

  it('says what is on screen: how many columns are out of view on each side', () => {
    const widths = [383, 383, 383, 383];
    // At the start: three whole columns, one more on the right.
    expect(viewStrip(widths, 0, 1151)).toMatchObject({ before: 0, after: 1, visible: [true, true, true, false], offsets: [0, 384, 768, 1152] });
    // Scrolled by one column.
    expect(viewStrip(widths, 384, 1151)).toMatchObject({ before: 1, after: 0, visible: [false, true, true, true] });
    // Half-way: a column counts when at least half of it shows.
    expect(viewStrip(widths, 190, 1151).visible).toEqual([true, true, true, false]);
    expect(viewStrip(widths, 193, 1151).visible).toEqual([false, true, true, true]);
    // 1024 px: two fit, two more.
    expect(viewStrip([387, 387, 387, 387], 0, 775)).toMatchObject({ before: 0, after: 2 });
    expect(viewStrip([], 0, 800)).toMatchObject({ before: 0, after: 0, visible: [] });
    // Everything fits.
    expect(viewStrip([400, 400], 0, 801)).toMatchObject({ before: 0, after: 0, visible: [true, true] });
  });
});
