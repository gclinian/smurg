// The minimums of the workbench's panes (Workbench.tsx): what a separator leaves the pane on its other side, however
// far it is dragged and however small the window is. (The maximise button of the agents panel is the way to give a
// terminal the editor's room.)

/** The editor next to the agents column. */
export const MIN_EDITOR_PX = 160;
/** The editor next to the file tree, and the area above the drawer. */
export const MIN_MAIN_PX = 240;
/** The terminal above the suggestions. */
export const MIN_TERMINAL_PX = 120;
/** The least the agents column is ever given (the `minSize` of its own separator). */
export const MIN_AGENTS_PX = 260;
/** A separator's line. */
export const SEPARATOR_PX = 1;

/**
 * What the file tree leaves to its right. That room holds the editor AND, while it is shown, the agents column with
 * its separator. With the editor's minimum alone, a wide remembered file tree in a narrow window left the two of them
 * less than their minimums together: the agents column was narrower than MIN_AGENTS_PX and its separator could not be
 * moved. With the sum, the agents column has its minimum and its separator has MIN_MAIN_PX - MIN_EDITOR_PX to move in.
 */
export function minRightOfFiles(layout: { readonly right: boolean; readonly agentsWide: boolean }): number {
  if (!layout.right) return MIN_MAIN_PX;
  // The agents column has taken the editor's place: it is alone there.
  if (layout.agentsWide) return MIN_AGENTS_PX;
  return MIN_MAIN_PX + SEPARATOR_PX + MIN_AGENTS_PX;
}
