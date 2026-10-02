// @vitest-environment node
// The nested limits of the workbench: the file tree's separator leaves room for BOTH panes to its right.
import { describe, expect, it } from 'vitest';
import { clampSize, splitLimits } from '../../ui/split-resize.ts';
import { MIN_AGENTS_PX, MIN_EDITOR_PX, MIN_MAIN_PX, SEPARATOR_PX, minRightOfFiles } from './layout-limits.ts';

/** The widths of file tree | editor | agents in a window, from the remembered sizes (the props of Workbench.tsx). */
function widths(windowWidth: number, remembered: { sidebar: number; agents: number }, layout = { right: true, agentsWide: false }) {
  const sidebarLimits = splitLimits({ minSize: 160, maxSize: 640, minOther: minRightOfFiles(layout), containerSize: windowWidth, separatorSize: SEPARATOR_PX });
  const sidebar = clampSize(remembered.sidebar, sidebarLimits);
  const main = windowWidth - sidebar - SEPARATOR_PX;
  const agentsLimits = splitLimits({ minSize: MIN_AGENTS_PX, maxSize: 1100, minOther: MIN_EDITOR_PX, containerSize: main, separatorSize: SEPARATOR_PX });
  const agents = clampSize(remembered.agents, agentsLimits);
  return { sidebar, agents, editor: main - agents - SEPARATOR_PX, agentsLimits };
}

describe('workbench layout limits', () => {
  it('what the file tree leaves: the editor alone, the editor and the agents column, or the agents column alone', () => {
    expect(minRightOfFiles({ right: false, agentsWide: false })).toBe(MIN_MAIN_PX);
    expect(minRightOfFiles({ right: false, agentsWide: true })).toBe(MIN_MAIN_PX);
    expect(minRightOfFiles({ right: true, agentsWide: false })).toBe(MIN_MAIN_PX + 1 + MIN_AGENTS_PX);
    expect(minRightOfFiles({ right: true, agentsWide: true })).toBe(MIN_AGENTS_PX);
  });

  it('a 1024 px window with a 640 px file tree and an 1100 px agents column remembered: every pane has its minimum and the agents separator can move', () => {
    const at1024 = widths(1024, { sidebar: 640, agents: 1100 });
    expect(at1024.sidebar).toBe(522);
    expect(at1024.agents).toBeGreaterThanOrEqual(MIN_AGENTS_PX);
    expect(at1024.editor).toBeGreaterThanOrEqual(MIN_EDITOR_PX);
    expect(at1024.agentsLimits).toEqual({ min: 260, max: 340 });
    expect(at1024.sidebar + 1 + at1024.editor + 1 + at1024.agents).toBe(1024);
    // The old limit (the editor's minimum alone) is what broke: 383 px for both, 222 px for a 260 px column.
    const old = splitLimits({ minSize: 160, maxSize: 640, minOther: MIN_MAIN_PX, containerSize: 1024, separatorSize: 1 });
    expect(clampSize(640, old)).toBe(640);
    expect(1024 - 640 - 1 - 1 - MIN_EDITOR_PX).toBeLessThan(MIN_AGENTS_PX);
  });

  it('holds from 1024 px up for every remembered size, and a wide window changes nothing', () => {
    for (const windowWidth of [1024, 1100, 1280, 1440, 1920]) {
      for (const sidebar of [160, 260, 640]) {
        for (const agents of [260, 420, 1100]) {
          const w = widths(windowWidth, { sidebar, agents });
          expect(w.agents, `${windowWidth}/${sidebar}/${agents}`).toBeGreaterThanOrEqual(MIN_AGENTS_PX);
          expect(w.editor, `${windowWidth}/${sidebar}/${agents}`).toBeGreaterThanOrEqual(MIN_EDITOR_PX);
          expect(w.agentsLimits.max - w.agentsLimits.min, `${windowWidth}/${sidebar}/${agents}`).toBeGreaterThanOrEqual(MIN_MAIN_PX - MIN_EDITOR_PX);
        }
      }
    }
    expect(widths(1440, { sidebar: 260, agents: 420 })).toMatchObject({ sidebar: 260, agents: 420, editor: 758 });
  });
});
