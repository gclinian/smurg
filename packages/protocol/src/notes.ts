// Sticky notes (DESIGN 0.8.0 D1): a note is the Markdown file `notes/<Name>.md` at the top of the main workspace, and
// its name is the file's name without `.md`. ONE predicate says what a note's name is (`noteNameProblem`,
// `isNoteName`, `noteNameSchema`) and ONE says whether a root-relative path is a note's file (`noteNameOf`): the tool
// gate (row G13), the daemon's index and `sticky.create` ask these and nothing else. `notePath` is the inverse.
// Two names are one note when they fold equal (`foldNoteName`, D1.3). ONE finder reads the links of a note's text
// (`wikiLinks`, D1.4), and ONE function grows the tree from Home along them (`noteTree`, D2.3).
//
// Pure: browser, Worker and Node safe. What a check costs is bounded by NOTE_NAME_MAX_CHARS, asked first; what the
// finder costs is in proportion to the text (each place where a link may start is looked at for at most
// WIKI_LINK_MAX_CHARS units, each run of backticks once).
import { z } from 'zod';
import { agentText } from './agent-text.ts';
import { topicNameSchema } from './schema/entities.ts';
import { NOTE_LINKS_MAX, NOTE_NAME_MAX_CHARS } from './schema/limits.ts';
import { NOTES_DIR, NOTES_HOME, checkRelPath, foldPathName, isHostOnlyPath } from './schema/paths.ts';

/** The literal suffix of a note's file: `notes/x.MD` is no note (a case-insensitive compare would let it through). */
export const NOTE_FILE_SUFFIX = '.md';
const NOTE_PATH_PREFIX = `${NOTES_DIR}/`;
/** The longest path `noteNameOf` reads: `notes/` + the longest name + `.md`. */
const NOTE_PATH_MAX_CHARS = NOTE_PATH_PREFIX.length + NOTE_NAME_MAX_CHARS + NOTE_FILE_SUFFIX.length;

/**
 * Characters a note's name never holds (D1.2): `/ \ [ ] | # ^`, which a path or a wiki link reads, and
 * `` ` * _ ~ < > & @ ``, which Markdown reads, so that a link `[[Name]]` is never split by the renderer. A class of
 * single characters, tried once per character.
 */
const MARKUP = /[/\\[\]|#^`*_~<>&@]/;
/** White space other than U+0020: tab, the line ends, U+2028, U+2029, the no-break and the wide spaces. One class. */
const OTHER_SPACE = /[^\S ]/u;

/** Why a string is no note name, one reason per rule of D1.2 (the first that fails). */
export type NoteNameProblem =
  | 'not-string'
  | 'empty'
  | 'too-long'
  | 'markup'
  | 'white-space'
  | 'unseen'
  | 'not-nfc'
  | 'dot-name'
  | 'edge'
  | 'path'
  | 'host-only'
  | 'topic-name';

/**
 * Why `name` is no valid sticky note name, or null when it is one (DESIGN 0.8.0 D1.2): a string of 1 to
 * NOTE_NAME_MAX_CHARS UTF-16 units; none of `/ \ [ ] | # ^` and of `` ` * _ ~ < > & @ ``; no white space but U+0020;
 * `agentText(name)` gives the name back unchanged and not cleaned (no control, bidi, invisible character or lone
 * surrogate, and the name is in NFC); not `.` or `..`; no leading or trailing space or dot; `notes/<name>.md` passes
 * `checkRelPath` unchanged and is no host-only path, for every principal (so `CLAUDE` is no name); and the name is a
 * valid topic name (a build uses it as the topic's name and as its work item's title, D5.2).
 */
export function noteNameProblem(name: unknown): NoteNameProblem | null {
  if (typeof name !== 'string') return 'not-string';
  if (name.length === 0) return 'empty';
  // Before anything else looks at the text: every later rule then costs at most this many characters.
  if (name.length > NOTE_NAME_MAX_CHARS) return 'too-long';
  if (MARKUP.test(name)) return 'markup';
  if (OTHER_SPACE.test(name)) return 'white-space';
  const seen = agentText(name);
  if (seen.cleaned) return 'unseen';
  // Nothing was removed, no line end is left and no line can look like a header (brackets are markup): what is left
  // to change is the composition.
  if (seen.text !== name) return 'not-nfc';
  if (name === '.' || name === '..') return 'dot-name';
  if (name.startsWith(' ') || name.endsWith(' ') || name.startsWith('.') || name.endsWith('.')) return 'edge';
  const path = `${NOTE_PATH_PREFIX}${name}${NOTE_FILE_SUFFIX}`;
  const checked = checkRelPath(path);
  if (!checked.ok || checked.path !== path) return 'path';
  if (isHostOnlyPath(path)) return 'host-only';
  if (!topicNameSchema.safeParse(name).success) return 'topic-name';
  return null;
}

/** Whether `name` is a valid sticky note name (noteNameProblem). */
export function isNoteName(name: unknown): name is string {
  return noteNameProblem(name) === null;
}

/** A sticky note's name on the wire and in the address (DESIGN 0.8.0 D1.2): refused, never cleaned or cut. */
export const noteNameSchema = z.string().superRefine((name, ctx) => {
  const problem = noteNameProblem(name);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: `invalid sticky note name: ${problem}` });
});

/**
 * The note whose file `path` is, or null (DESIGN 0.8.0 D1.2): `path` (relative to the main workspace's root, as
 * checkRelPath gives it) is `notes/` + one segment + the literal suffix `.md`, and that segment without `.md` is a
 * valid note name. `notes/CLAUDE.md`, `notes/x.MD`, `notes/a/b.md`, `notes/.md` and `Notes/x.md` are no note's file.
 * Names are compared as they are written here; whether another note's name folds equal is the caller's question
 * (the gate's, the index's).
 */
export function noteNameOf(path: string): string | null {
  if (typeof path !== 'string' || path.length > NOTE_PATH_MAX_CHARS) return null;
  if (!path.startsWith(NOTE_PATH_PREFIX) || !path.endsWith(NOTE_FILE_SUFFIX)) return null;
  const name = path.slice(NOTE_PATH_PREFIX.length, path.length - NOTE_FILE_SUFFIX.length);
  return isNoteName(name) ? name : null;
}

/** The file of the note `name`: `notes/<name>.md`, the inverse of noteNameOf. Throws for a name that is no note's. */
export function notePath(name: string): string {
  const problem = noteNameProblem(name);
  if (problem !== null) throw new RangeError(`not a sticky note name (${problem})`);
  return `${NOTE_PATH_PREFIX}${name}${NOTE_FILE_SUFFIX}`;
}

/**
 * The key under which two sticky note names are one note (DESIGN 0.8.0 D1.3): the name as a case-insensitive file
 * system compares it (`foldPathName`, which `foldRelPath` applies to each segment of a path). `Home` and `home` are
 * one note; the index maps this key to the name on disk.
 */
export function foldNoteName(name: string): string {
  return foldPathName(name);
}

// ---------------------------------------------------------------------------------------------------------------
// Wiki links (D1.4)
// ---------------------------------------------------------------------------------------------------------------

/** The longest wiki link the finder reads: `[[`, a name of at most NOTE_NAME_MAX_CHARS units, `]]`. */
export const WIKI_LINK_MAX_CHARS = NOTE_NAME_MAX_CHARS + 4;

const BACKTICK = 0x60;
const TILDE = 0x7e;
const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;
const OPEN = 0x5b;
const CLOSE = 0x5d;

interface Fence {
  readonly char: number;
  readonly length: number;
}

/** Whether text[from, to) holds only spaces, tabs and a carriage return. */
function blank(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c !== SPACE && c !== TAB && c !== CR) return false;
  }
  return true;
}

/** Where a line's text starts after at most three spaces, or -1 when it is indented further (no fence there). */
function fenceIndent(text: string, from: number, to: number): number {
  let i = from;
  while (i < to && i - from < 3 && text.charCodeAt(i) === SPACE) i++;
  return i < to && text.charCodeAt(i) === SPACE ? -1 : i;
}

/** The length of the run of `char` that starts at `from` (and ends before `to`). */
function runLength(text: string, from: number, to: number, char: number): number {
  let i = from;
  while (i < to && text.charCodeAt(i) === char) i++;
  return i - from;
}

/**
 * The fence a line opens, or null (CommonMark: at most three spaces, then three or more backticks or tildes; the rest
 * of a backtick fence's line holds no backtick).
 */
function fenceOpened(text: string, from: number, to: number): Fence | null {
  const start = fenceIndent(text, from, to);
  if (start < 0 || start >= to) return null;
  const char = text.charCodeAt(start);
  if (char !== BACKTICK && char !== TILDE) return null;
  const length = runLength(text, start, to, char);
  if (length < 3) return null;
  if (char === BACKTICK) {
    for (let i = start + length; i < to; i++) if (text.charCodeAt(i) === BACKTICK) return null;
  }
  return { char, length };
}

/** Whether a line closes the fence: at most three spaces, a run of its character at least as long, then nothing. */
function fenceClosed(text: string, from: number, to: number, fence: Fence): boolean {
  const start = fenceIndent(text, from, to);
  if (start < 0) return false;
  const length = runLength(text, start, to, fence.char);
  return length >= fence.length && blank(text, start + length, to);
}

/**
 * Calls `visit(from, to)` for each part of the paragraph `text[from, to)` outside its code spans (CommonMark: a run of
 * N backticks opens a span that the next run of exactly N backticks closes; a run with no such closer is text), until
 * it answers false. Each run is looked at once: for each length, a pointer into the runs of that length only moves on.
 */
function outsideCodeSpans(text: string, from: number, to: number, visit: (from: number, to: number) => boolean): boolean {
  const starts: number[] = [];
  const lengths: number[] = [];
  for (let i = from; i < to; ) {
    if (text.charCodeAt(i) !== BACKTICK) {
      i++;
      continue;
    }
    const length = runLength(text, i, to, BACKTICK);
    starts.push(i);
    lengths.push(length);
    i += length;
  }
  if (starts.length === 0) return visit(from, to);
  const byLength = new Map<number, { readonly runs: number[]; next: number }>();
  lengths.forEach((length, run) => {
    const same = byLength.get(length);
    if (same === undefined) byLength.set(length, { runs: [run], next: 0 });
    else same.runs.push(run);
  });
  let plainFrom = from;
  for (let run = 0; run < starts.length; run++) {
    const same = byLength.get(lengths[run] as number) as { readonly runs: number[]; next: number };
    while (same.next < same.runs.length && (same.runs[same.next] as number) <= run) same.next++;
    if (same.next >= same.runs.length) continue; // no closer: these backticks are text
    const closer = same.runs[same.next] as number;
    same.next++;
    if (!visit(plainFrom, starts[run] as number)) return false;
    plainFrom = (starts[closer] as number) + (lengths[closer] as number);
    run = closer;
  }
  return visit(plainFrom, to);
}

/**
 * Calls `visit(from, to)` for each part of `text` that is neither fenced code nor a code span, in order, until it
 * answers false. Lines end at LF; a paragraph (where a code span may go on over a line end) ends at a blank line or at
 * a fence. A fence that is never closed goes on to the end of the text.
 */
function outsideCode(text: string, visit: (from: number, to: number) => boolean): void {
  let fence: Fence | null = null;
  let paragraph = -1;
  let paragraphEnd = -1;
  const flush = (): boolean => {
    if (paragraph < 0) return true;
    const from = paragraph;
    paragraph = -1;
    return outsideCodeSpans(text, from, paragraphEnd, visit);
  };
  for (let line = 0; line <= text.length; ) {
    let end = line;
    while (end < text.length && text.charCodeAt(end) !== LF) end++;
    if (fence !== null) {
      if (fenceClosed(text, line, end, fence)) fence = null;
    } else {
      const opened = fenceOpened(text, line, end);
      if (opened !== null) {
        if (!flush()) return;
        fence = opened;
      } else if (blank(text, line, end)) {
        if (!flush()) return;
      } else {
        if (paragraph < 0) paragraph = line;
        paragraphEnd = end;
      }
    }
    line = end + 1;
  }
  flush();
}

/**
 * The sticky notes a note's text links to (DESIGN 0.8.0 D1.4): each `[[Name]]` outside fenced code and code spans
 * whose Name is a valid note name, in order, each once (names that fold equal are one link: the first spelling is
 * kept), at most NOTE_LINKS_MAX. A link is at most WIKI_LINK_MAX_CHARS units and holds no bracket and no line end; a
 * target that is no valid name is dropped; in `[[[Name]]]` the outer brackets are text. One pass, no regular
 * expression.
 *
 * The web renderer runs it on each plain run of text that marked produced. The two agree wherever a whole `[[Name]]`
 * is one plain run; they disagree only about what counts as code (an indented code block, a backtick escaped with a
 * backslash: marked reads code or text there, this finder the other), which notes.test.ts names.
 */
export function wikiLinks(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  outsideCode(text, (from, to) => {
    for (let i = from; i + 1 < to; i++) {
      if (text.charCodeAt(i) !== OPEN || text.charCodeAt(i + 1) !== OPEN) continue;
      const last = Math.min(to, i + WIKI_LINK_MAX_CHARS) - 1;
      let close = -1;
      for (let j = i + 2; j < last; j++) {
        const c = text.charCodeAt(j);
        // A link holds no bracket and no line end: the next `[` is tried again on its own.
        if (c === OPEN || c === LF) break;
        if (c === CLOSE) {
          if (text.charCodeAt(j + 1) === CLOSE) close = j;
          break;
        }
      }
      if (close < 0) continue;
      const name = text.slice(i + 2, close);
      if (isNoteName(name)) {
        const key = foldNoteName(name);
        if (!seen.has(key)) {
          seen.add(key);
          names.push(name);
          if (names.length >= NOTE_LINKS_MAX) return false;
        }
      }
      i = close + 1;
    }
    return true;
  });
  return names;
}

// ---------------------------------------------------------------------------------------------------------------
// The tree (D2.3)
// ---------------------------------------------------------------------------------------------------------------

/** One sticky note of the tree, with the notes it reached first, in the order it links to them. */
export interface NoteTreeNode {
  readonly name: string;
  readonly children: readonly NoteTreeNode[];
}

/** The tree grown from Home, and the names of the notes it does not reach, in the order they were given. */
export interface NoteTree {
  readonly home: NoteTreeNode | null;
  readonly notLinked: readonly string[];
}

/** What the tree reads of a note (a NoteInfo of the index). */
export interface NoteTreeInput {
  readonly name: string;
  readonly links: readonly string[];
  readonly shadowed?: boolean;
}

/**
 * The tree of the sticky notes (DESIGN 0.8.0 D2.3), derived, never stored: breadth first from Home along the links; a
 * note's parent is the first note that reaches it; siblings in link order; names compared folded (`foldNoteName`), so
 * a link reaches the note whose name on disk folds equal to it. A link to a note that does not exist reaches nothing.
 * A note listed `shadowed` (the fold twin of another) is never in the tree: links reach the other one. Every note Home
 * does not reach, a shadowed one included, is "not linked" (the web sorts those rows itself); without Home, all are.
 */
export function noteTree(notes: readonly NoteTreeInput[]): NoteTree {
  const byKey = new Map<string, NoteTreeInput>();
  for (const note of notes) {
    if (note.shadowed === true) continue;
    const key = foldNoteName(note.name);
    if (!byKey.has(key)) byKey.set(key, note);
  }
  const homeNote = byKey.get(foldNoteName(NOTES_HOME));
  if (homeNote === undefined) return { home: null, notLinked: notes.map((note) => note.name) };
  interface Node {
    readonly note: NoteTreeInput;
    readonly children: Node[];
  }
  const placed = new Set<NoteTreeInput>([homeNote]);
  const home: Node = { note: homeNote, children: [] };
  const queue: Node[] = [home];
  for (let at = 0; at < queue.length; at++) {
    const node = queue[at] as Node;
    for (const link of node.note.links) {
      const target = byKey.get(foldNoteName(link));
      if (target === undefined || placed.has(target)) continue;
      placed.add(target);
      const child: Node = { note: target, children: [] };
      node.children.push(child);
      queue.push(child);
    }
  }
  const strip = (node: Node): NoteTreeNode => ({ name: node.note.name, children: node.children.map(strip) });
  return { home: strip(home), notLinked: notes.filter((note) => !placed.has(note)).map((note) => note.name) };
}
