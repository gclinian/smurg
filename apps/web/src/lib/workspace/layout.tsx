// The workbench layout switches a feature may offer in its own header (review WEB-02): collapse the suggestions pane
// under the terminal, or give the agents column the whole width next to the file tree. Provided by the workbench;
// null anywhere else (a feature then hides these buttons).
import { createContext, useContext } from 'react';

export type LayoutSwitch = 'suggestions' | 'agentsWide';

export interface WorkbenchLayout {
  /** The suggestions pane is expanded (collapsed: only its header shows). */
  readonly suggestions: boolean;
  /** The agents column takes the editor's place. */
  readonly agentsWide: boolean;
  toggle(which: LayoutSwitch): void;
}

export const WorkbenchLayoutContext = createContext<WorkbenchLayout | null>(null);

export function useWorkbenchLayout(): WorkbenchLayout | null {
  return useContext(WorkbenchLayoutContext);
}
