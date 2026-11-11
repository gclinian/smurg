// The sticky notes (DESIGN 0.8.0 D7): the parts the notes view of the shell (app/workspace/NotesView.tsx) composes.
// The list of notes on the left, the open note in the middle (or the page that stands in for it). The notes are the
// files `notes/<Name>.md` of the main workspace; the index the daemon keeps of them is `stores.sticky`.
export { NoteTree, type NoteTreeProps } from './NoteTree.tsx';
export { OpenNote, type OpenNoteProps } from './NoteRead.tsx';
