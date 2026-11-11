// What the sticky notes show, as pure functions (DESIGN 0.8.0 D7.4, D7.5): the rows of the list of notes, the notes
// above a note in the tree, a note's file, and the finder of wiki links the renderer is given. Tested without
// rendering (sticky.test.tsx).
import { MAIN_ROOT, NOTES_HOME, foldNoteName, notePath, wikiLinkSpans, type FileRef, type NoteInfo, type NoteTreeNode } from '@smurg/protocol';
import type { WikiLinkMatch } from '../markdown/index.ts';

/** The key of a note in the store and in the list: its folded name (Home and home are one note, D1.3). */
export const noteKey = (name: string): string => foldNoteName(name);

/** The key of Home. */
export const HOME_KEY = noteKey(NOTES_HOME);

/** The file of the sticky note `name` (on disk spelling): `notes/<name>.md` of the main workspace. */
export function noteFile(name: string): FileRef {
  return { root: MAIN_ROOT, path: notePath(name) };
}

/**
 * The wiki links of one plain run of a rendered note (the renderer calls it on each run marked produced): the link
 * rule of the daemon's index (wikiLinkSpans of @smurg/protocol), every link where it is.
 */
export function findWikiLinks(text: string): readonly WikiLinkMatch[] {
  return wikiLinkSpans(text);
}

/** One row of the list of notes, with its rows below (absent: the note reaches no other). */
export interface NoteRow {
  /** The key of the row in its tree: the folded name, or `shadowed:<name>` for a fold twin. */
  readonly id: string;
  readonly name: string;
  /** How deep in the tree (0: Home, or a row that is not linked). */
  readonly depth: number;
  readonly children?: readonly NoteRow[];
  readonly unreadable: boolean;
  /** The fold twin of this note's name (D1.3): the note that is read in its place. */
  readonly twinOf?: string;
}

/** The rows of the tree grown from Home: its children in link order, and no row at all without Home. */
export function homeRows(home: NoteTreeNode | null, notes: ReadonlyMap<string, NoteInfo>): NoteRow[] {
  if (home === null) return [];
  const row = (node: NoteTreeNode, depth: number): NoteRow => ({
    id: noteKey(node.name),
    name: node.name,
    depth,
    unreadable: notes.get(noteKey(node.name))?.unreadable === true,
    ...(node.children.length > 0 ? { children: node.children.map((child) => row(child, depth + 1)) } : {}),
  });
  return [row(home, 0)];
}

/** The rows of the notes Home does not reach, in the order given (the store sorts them by name). */
export function notLinkedRows(notLinked: readonly NoteInfo[], notes: ReadonlyMap<string, NoteInfo>): NoteRow[] {
  return notLinked.map((note) => {
    if (note.shadowed !== true) return { id: noteKey(note.name), name: note.name, depth: 0, unreadable: note.unreadable === true };
    const twin = notes.get(noteKey(note.name));
    return { id: `shadowed:${note.name}`, name: note.name, depth: 0, unreadable: false, ...(twin === undefined ? {} : { twinOf: twin.name }) };
  });
}

/** The keys of the notes above `name` in the tree grown from Home, from Home down (empty: Home itself, or not in it). */
export function ancestorsOf(home: NoteTreeNode | null, name: string): string[] {
  if (home === null) return [];
  const target = noteKey(name);
  const path: string[] = [];
  const walk = (node: NoteTreeNode): boolean => {
    if (noteKey(node.name) === target) return true;
    path.push(noteKey(node.name));
    for (const child of node.children) if (walk(child)) return true;
    path.pop();
    return false;
  };
  return walk(home) ? path : [];
}
