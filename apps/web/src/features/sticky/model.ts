// What the sticky notes show, as pure functions (DESIGN 0.8.0 D7.4, D7.5): the rows of the list of notes, the notes
// above a note in the tree, a note's file, the finder of wiki links the renderer is given, and the line "Add a sticky
// note" puts at the end of the open note. Tested without rendering (sticky.test.tsx). Also the one signal between the
// open note and the list: a row to unfold (the note a new sticky note was just linked from).
import { MAIN_ROOT, NOTES_HOME, foldNoteName, notePath, wikiLinkSpans, type FileRef, type NoteInfo, type NoteTreeNode } from '@smurg/protocol';
import { createStore, type WritableStore } from '../../lib/store.ts';
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

/**
 * What "Add a sticky note" appends to the open note's text (D7.5): the list item `- [[Name]]` on a line of its own,
 * after a line break when the text does not end with one.
 */
export function linkLineAfter(text: string, name: string): string {
  return `${text === '' || text.endsWith('\n') ? '' : '\n'}- [[${name}]]\n`;
}

/** A row of the list asked to unfold from outside the list; a new object for every request. */
export interface UnfoldRequest {
  readonly key: string;
}

const unfolds = new WeakMap<object, WritableStore<UnfoldRequest | null>>();

/**
 * The rows to unfold, one signal per workspace's stores (the list and the open note are two panes of one view): the
 * open note asks for its own row when it just linked a new sticky note, so that the new row shows under it.
 */
export function unfoldRequestsOf(owner: object): WritableStore<UnfoldRequest | null> {
  let store = unfolds.get(owner);
  if (store === undefined) {
    store = createStore<UnfoldRequest | null>(null);
    unfolds.set(owner, store);
  }
  return store;
}
