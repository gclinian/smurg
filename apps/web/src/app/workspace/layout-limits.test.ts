// @vitest-environment node
// The nested limits of code mode: the file tree's separator leaves room for BOTH panes to its right.
import { describe, expect, it } from 'vitest';
import { clampSize, splitLimits } from '../../ui/split-resize.ts';
import { COLUMN_MIN_PX } from '../../ui/columns-layout.ts';
import { LEFT_MAX_PX, LEFT_MIN_PX, MIN_COLUMNS_PX, MIN_EDITOR_PX, MIN_MAIN_PX, MIN_SIDE_PX, SEPARATOR_PX, minRightOfFiles } from './layout-limits.ts';

/** The widths of file tree | editor | session column in a window, from the remembered sizes (the props of Workbench.tsx). */
function widths(windowWidth: number, remembered: { sidebar: number; side: number }, layout = { side: true }) {
  const sidebarLimits = splitLimits({ minSize: 160, maxSize: 640, minOther: minRightOfFiles(layout), containerSize: windowWidth, separatorSize: SEPARATOR_PX });
  const sidebar = clampSize(remembered.sidebar, sidebarLimits);
  const main = windowWidth - sidebar - SEPARATOR_PX;
  const sideLimits = splitLimits({ minSize: MIN_SIDE_PX, maxSize: 1100, minOther: MIN_EDITOR_PX, containerSize: main, separatorSize: SEPARATOR_PX });
  const side = clampSize(remembered.side, sideLimits);
  return { sidebar, side, editor: main - side - SEPARATOR_PX, sideLimits };
}

describe('code mode layout limits', () => {
  it('what the file tree leaves: the editor alone, or the editor and the session column', () => {
    expect(minRightOfFiles({ side: false })).toBe(MIN_MAIN_PX);
    expect(minRightOfFiles({ side: true })).toBe(MIN_MAIN_PX + 1 + MIN_SIDE_PX);
  });

  it('the session column of code mode is never narrower than a column of the sessions view', () => {
    expect(MIN_SIDE_PX).toBe(COLUMN_MIN_PX);
    expect(MIN_COLUMNS_PX).toBe(COLUMN_MIN_PX);
  });

  it('a 1024 px window with a 640 px file tree and an 1100 px session column remembered: every pane has its minimum and the separator can move', () => {
    const at1024 = widths(1024, { sidebar: 640, side: 1100 });
    expect(at1024.sidebar).toBe(462);
    expect(at1024.side).toBeGreaterThanOrEqual(MIN_SIDE_PX);
    expect(at1024.editor).toBeGreaterThanOrEqual(MIN_EDITOR_PX);
    expect(at1024.sideLimits).toEqual({ min: 320, max: 400 });
    expect(at1024.sidebar + 1 + at1024.editor + 1 + at1024.side).toBe(1024);
    // The editor's minimum alone is what would break: 383 px for both, 222 px for a 320 px column.
    const alone = splitLimits({ minSize: 160, maxSize: 640, minOther: MIN_MAIN_PX, containerSize: 1024, separatorSize: 1 });
    expect(clampSize(640, alone)).toBe(640);
    expect(1024 - 640 - 1 - 1 - MIN_EDITOR_PX).toBeLessThan(MIN_SIDE_PX);
  });

  it('holds from 1024 px up for every remembered size, and a wide window changes nothing', () => {
    for (const windowWidth of [1024, 1100, 1280, 1440, 1920]) {
      for (const sidebar of [160, 260, 640]) {
        for (const side of [320, 420, 1100]) {
          const w = widths(windowWidth, { sidebar, side });
          expect(w.side, `${windowWidth}/${sidebar}/${side}`).toBeGreaterThanOrEqual(MIN_SIDE_PX);
          expect(w.editor, `${windowWidth}/${sidebar}/${side}`).toBeGreaterThanOrEqual(MIN_EDITOR_PX);
          expect(w.sideLimits.max - w.sideLimits.min, `${windowWidth}/${sidebar}/${side}`).toBeGreaterThanOrEqual(MIN_MAIN_PX - MIN_EDITOR_PX);
        }
      }
    }
    expect(widths(1440, { sidebar: 260, side: 420 })).toMatchObject({ sidebar: 260, side: 420, editor: 758 });
  });

  it('the left column of the sessions view leaves the columns one column at its widest, in a 1024 px window', () => {
    const limits = splitLimits({ minSize: LEFT_MIN_PX, maxSize: LEFT_MAX_PX, minOther: MIN_COLUMNS_PX, containerSize: 1024, separatorSize: SEPARATOR_PX });
    expect(limits).toEqual({ min: 220, max: 420 });
    expect(1024 - limits.max - SEPARATOR_PX).toBeGreaterThanOrEqual(COLUMN_MIN_PX);
  });
});
