// The sticky notes (/w/:workspaceId/notes[/:name]; DESIGN 0.8.0 D7.2):
//
//   ┌ all sticky notes ─┬ the open sticky note ─────────────┬ Claude for the sticky notes ┐
//   │ Home              │  ┌─────────────────────────────┐  │                             │
//   │   Checkout        │  │ Home                        │  │                             │
//   │   Payment form    │  │ ...                         │  │                             │
//   │ Not linked        │  └─────────────────────────────┘  │                             │
//   └───────────────────┴───────────────────────────────────┴─────────────────────────────┘
//
// The list and Claude's pane are resizable (their widths under smurg.pane.notes-tree and smurg.pane.notes-chat; no
// field of smurg.layout, no layout toggles). The open note is in the address; the unfolded rows live in memory only.
// Landmarks: `complementary` "All sticky notes", `main` "Open sticky note". F6 / Shift+F6 move between the list and
// the note. Claude's pane is empty until the conversation comes to it (BUILD-PLAN S4).
//
// This module is a lazy chunk (WorkspaceShell loads it when the sticky notes are first shown): the feature, its
// renderer and the shared documents it holds come with it, never with the sessions view.
import { useRef, type KeyboardEvent } from 'react';
import { tWorkbench } from '../../strings/workbench.ts';
import { SplitPane } from '../../ui/index.ts';
import { NoteTree, OpenNote } from '../../features/sticky/index.tsx';
import { MIN_NOTE_PX, MIN_RIGHT_OF_NOTES_TREE, MIN_SIDE_PX, NOTES_CHAT_DEFAULT_PX, NOTES_CHAT_MAX_PX, NOTES_TREE_DEFAULT_PX, NOTES_TREE_MAX_PX, NOTES_TREE_MIN_PX } from './layout-limits.ts';

export interface NotesViewProps {
  /** The sticky notes are the mode on screen. */
  shown: boolean;
  /** The note in the address; undefined: Home. */
  note?: string;
}

/** Where F6 lands, in order: the list (its first row with the tab stop, or its button), then the open note's name. */
function regionStops(root: HTMLElement): HTMLElement[] {
  const list = root.querySelector<HTMLElement>('.app-notes__tree [role="treeitem"][tabindex="0"]') ?? root.querySelector<HTMLElement>('.app-notes__tree button');
  return [list, ...root.querySelectorAll<HTMLElement>('[data-region-focus]')].filter((element): element is HTMLElement => element !== null && element.closest('[hidden]') === null);
}

export default function NotesView({ note }: NotesViewProps) {
  const root = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || !root.current) return;
    const stops = regionStops(root.current);
    if (stops.length === 0) return;
    event.preventDefault();
    const active = document.activeElement;
    // The region the focus is in: the last stop at or before the focused element in document order.
    let current = -1;
    stops.forEach((stop, index) => {
      if (active !== null && (stop === active || (stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)) current = index;
    });
    const next = event.shiftKey ? (current <= 0 ? stops.length - 1 : current - 1) : (current + 1) % stops.length;
    stops[next]?.focus();
  };

  return (
    <div ref={root} className="app-notes" onKeyDown={onKeyDown}>
      <a className="ui-skip-link" href="#notes-main">
        {tWorkbench('skip.note')}
      </a>
      <div className="app-notes__body">
        <SplitPane
          orientation="horizontal"
          fixed="start"
          defaultSize={NOTES_TREE_DEFAULT_PX}
          minSize={NOTES_TREE_MIN_PX}
          maxSize={NOTES_TREE_MAX_PX}
          minOtherSize={MIN_RIGHT_OF_NOTES_TREE}
          storageKey="notes-tree"
          label={tWorkbench('region.notesTree')}
          start={
            <aside className="app-notes__tree" aria-label={tWorkbench('region.notesTree')}>
              <NoteTree open={note} />
            </aside>
          }
          end={
            <SplitPane
              orientation="horizontal"
              fixed="end"
              defaultSize={NOTES_CHAT_DEFAULT_PX}
              minSize={MIN_SIDE_PX}
              maxSize={NOTES_CHAT_MAX_PX}
              minOtherSize={MIN_NOTE_PX}
              storageKey="notes-chat"
              label={tWorkbench('region.notesChat')}
              start={
                <main id="notes-main" className="app-notes__main" aria-label={tWorkbench('region.note')} tabIndex={-1}>
                  <OpenNote note={note} />
                </main>
              }
              end={<div className="app-notes__chat" />}
            />
          }
        />
      </div>
    </div>
  );
}
