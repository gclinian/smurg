// The minimums of code mode's panes (Workbench.tsx) and of the sessions view (SessionsView.tsx): what a separator
// leaves the pane on its other side, however far it is dragged and however small the window is.

/** The editor next to the session column. */
export const MIN_EDITOR_PX = 160;
/** The editor next to the file tree, and the area above the drawer. */
export const MIN_MAIN_PX = 240;
/** The least the session column of code mode is ever given: a column's minimum (ui/columns-layout.ts). */
export const MIN_SIDE_PX = 320;
/** A separator's line. */
export const SEPARATOR_PX = 1;

/** The left column of the sessions view: its default, its limits, and the rail it folds to (UX §1). */
export const LEFT_DEFAULT_PX = 288;
export const LEFT_MIN_PX = 220;
export const LEFT_MAX_PX = 420;
export const LEFT_RAIL_PX = 44;
/** What the left column leaves the columns: one column's minimum. */
export const MIN_COLUMNS_PX = 320;

/**
 * What the file tree leaves to its right. That room holds the editor AND, while it is shown, the session column with
 * its separator. With the editor's minimum alone, a wide remembered file tree in a narrow window left the two of them
 * less than their minimums together: the session column was narrower than its minimum and its separator could not be
 * moved. With the sum, the session column has its minimum and its separator has MIN_MAIN_PX - MIN_EDITOR_PX to move in.
 */
export function minRightOfFiles(layout: { readonly side: boolean }): number {
  if (!layout.side) return MIN_MAIN_PX;
  return MIN_MAIN_PX + SEPARATOR_PX + MIN_SIDE_PX;
}
