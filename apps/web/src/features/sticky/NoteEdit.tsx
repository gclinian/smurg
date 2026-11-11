// "Edit" of the open sticky note (DESIGN 0.8.0 D7.5): the shared editor of that one note, on the very document the
// Read view shows, so people typing in it, Claude writing it and code mode's tab of the same file are one replica,
// one lock and one autosave (features/editor/standalone.tsx). Without "Send to agent": Claude for the sticky notes is
// beside the note, and "Ask Claude about this sticky note" puts its link into Claude's box. Mounted the first time
// Edit is chosen, then kept (hidden) like a tab, so the caret and the undo stay. Monaco comes with the editor's own
// chunk, which only the notes view's lazy chunk asks for.
import { StandaloneDocument, type HeldDocument } from '../editor/standalone.tsx';
import './sticky.css';

export interface NoteEditProps {
  readonly held: HeldDocument;
  /** Edit is the view chosen. */
  readonly active: boolean;
}

export function NoteEdit({ held, active }: NoteEditProps) {
  return (
    <div className="sticky-card__editor" hidden={!active}>
      <StandaloneDocument held={held} active={active} sendToAgent={false} />
    </div>
  );
}
