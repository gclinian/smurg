// Sticky notes (DESIGN 0.8.0 D1): a note is the Markdown file `notes/<Name>.md` at the top of the main workspace, and
// its name is the file's name without `.md`. ONE predicate says what a note's name is (`noteNameProblem`,
// `isNoteName`, `noteNameSchema`) and ONE says whether a root-relative path is a note's file (`noteNameOf`): the tool
// gate (row G13), the daemon's index and `sticky.create` ask these and nothing else. `notePath` is the inverse.
//
// Pure: browser, Worker and Node safe. What a check costs is bounded by NOTE_NAME_MAX_CHARS, asked first.
import { z } from 'zod';
import { agentText } from './agent-text.ts';
import { topicNameSchema } from './schema/entities.ts';
import { NOTE_NAME_MAX_CHARS } from './schema/limits.ts';
import { NOTES_DIR, checkRelPath, isHostOnlyPath } from './schema/paths.ts';

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
