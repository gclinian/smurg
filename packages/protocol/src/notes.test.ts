// A sticky note's name and file (DESIGN 0.8.0 D1.2): every rule, one case each, with its reason as the case's title.
// The tool gate (G13), the index and `sticky.create` ask exactly these functions.
import { describe, expect, it } from 'vitest';
import { agentText } from './agent-text.ts';
import { NOTE_FILE_SUFFIX, isNoteName, noteNameOf, noteNameProblem, noteNameSchema, notePath } from './notes.ts';
import { itemTitleSchema, topicNameSchema } from './schema/entities.ts';
import { NOTE_NAME_MAX_CHARS } from './schema/limits.ts';
import { NOTES_DIR, NOTES_HOME, checkRelPath, isHostOnlyPath } from './schema/paths.ts';

describe('the folder and the first note (D1.1)', () => {
  it('notes/ at the top, flat; the first note is Home in every language', () => {
    expect(NOTES_DIR).toBe('notes');
    expect(NOTES_HOME).toBe('Home');
    expect(NOTE_FILE_SUFFIX).toBe('.md');
    expect(notePath(NOTES_HOME)).toBe('notes/Home.md');
    expect(noteNameOf('notes/Home.md')).toBe('Home');
  });
});

describe('a note name (D1.2)', () => {
  it.each([
    ['Home', 'a plain word'],
    ['Payment form', 'U+0020 between words'],
    ['購物車', 'any script'],
    ['Q3 plan (draft)', 'parentheses, digits'],
    ['v1.2 notes', 'a dot inside'],
    ['Café', 'a precomposed letter (NFC)'],
    ['👩‍💻 dev', 'an emoji with its joiner'],
    ['x'.repeat(NOTE_NAME_MAX_CHARS), `exactly ${NOTE_NAME_MAX_CHARS} UTF-16 units`],
  ])('%j is a name: %s', (name) => {
    expect(noteNameProblem(name)).toBeNull();
    expect(isNoteName(name)).toBe(true);
    expect(noteNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ['', 'empty', 'a name has at least one character'],
    ['x'.repeat(NOTE_NAME_MAX_CHARS + 1), 'too-long', `an ${NOTE_NAME_MAX_CHARS + 1}-unit name: at most ${NOTE_NAME_MAX_CHARS} UTF-16 units`],
    ['😀'.repeat(NOTE_NAME_MAX_CHARS / 2 + 1), 'too-long', 'units, not code points: 41 emoji are 82 units'],
    ['a/b', 'markup', 'a slash is a folder: notes/ is flat'],
    ['a\\b', 'markup', 'a backslash'],
    ['[[x', 'markup', 'a bracket would split a wiki link'],
    ['a]b', 'markup', 'a closing bracket'],
    ['a|b', 'markup', 'a pipe is the label form of a wiki link, which this version does not have'],
    ['a#b', 'markup', 'a hash names a heading in a link'],
    ['a^b', 'markup', 'a caret names a block in a link'],
    ['a`b', 'markup', 'a backtick opens a code span'],
    ['a*b', 'markup', 'an asterisk is emphasis'],
    ['a_b', 'markup', 'an underscore is emphasis'],
    ['a~b', 'markup', 'a tilde is strikethrough'],
    ['a<b', 'markup', 'an angle bracket is HTML'],
    ['a>b', 'markup', 'a closing angle bracket'],
    ['a&b', 'markup', 'an ampersand starts an entity'],
    ['a@b', 'markup', 'an at sign is a mention'],
    ['a\tb', 'white-space', 'a tab: no white space but U+0020'],
    ['X Y', 'white-space', 'U+2028, the line separator, is white space and a line end'],
    ['X Y', 'white-space', 'U+2029, the paragraph separator'],
    ['a b', 'white-space', 'a no-break space looks like U+0020 and is another name'],
    ['a　b', 'white-space', 'the ideographic space'],
    ['Ho​me', 'unseen', 'a zero-width space: agentText would remove it (Ho<U+200B>me would show as Home)'],
    ['a‮b', 'unseen', 'a bidi override: the name would show in another order'],
    ['a\u0007b', 'unseen', 'a control character'],
    ['a\ud800b', 'unseen', 'a lone surrogate'],
    ['Café', 'not-nfc', 'NFD input: the name is the NFC form, never normalised into another name'],
    ['.', 'dot-name', 'the dot segment'],
    ['..', 'dot-name', 'the parent segment'],
    [' Home', 'edge', 'a leading space'],
    ['Home ', 'edge', 'a trailing space'],
    ['.Home', 'edge', 'a leading dot: a hidden file'],
    ['Home.', 'edge', 'a trailing dot: Windows drops it'],
    ['CLAUDE', 'host-only', 'notes/CLAUDE.md is a host-only name: Claude Code loads it as instructions'],
    ['claude', 'host-only', 'host-only names are compared folded'],
    ['CLAUDE.local', 'host-only', 'notes/CLAUDE.local.md is the host’s private memory'],
  ])('%j is no name (%s): %s', (name, problem) => {
    expect(noteNameProblem(name)).toBe(problem);
    expect(isNoteName(name)).toBe(false);
    expect(noteNameSchema.safeParse(name).success).toBe(false);
  });

  it('a mark run beyond the thirtieth is refused, never cut into another name', () => {
    expect(noteNameProblem(`a${'́'.repeat(31)}`)).toBe('unseen');
  });

  it('a name that is no string is refused', () => {
    expect(noteNameProblem(42)).toBe('not-string');
    expect(noteNameSchema.safeParse(null).success).toBe(false);
  });

  it('agentText gives every valid name back unchanged and not cleaned, so an agent reads exactly the name people see', () => {
    for (const name of ['Home', 'Payment form', '購物車', 'Café', '👩‍💻 dev']) expect(agentText(name)).toEqual({ text: name, cleaned: false });
  });

  it('a valid note name is a valid topic name and work item title: a build uses it as both (D5.2)', () => {
    for (const name of ['Home', 'Payment form', '購物車', 'Q3 plan (draft)', 'x'.repeat(NOTE_NAME_MAX_CHARS)]) {
      expect(topicNameSchema.safeParse(name).success).toBe(true);
      expect(itemTitleSchema.safeParse(name).success).toBe(true);
    }
  });

  it('notes/<name>.md of a valid name passes checkRelPath unchanged, is no host-only path and fits 243 bytes', () => {
    for (const name of ['Home', 'Payment form', '購物車', '中'.repeat(NOTE_NAME_MAX_CHARS)]) {
      const path = notePath(name);
      expect(checkRelPath(path)).toEqual({ ok: true, path });
      expect(isHostOnlyPath(path)).toBe(false);
      expect(new TextEncoder().encode(`${name}.md`).length).toBeLessThanOrEqual(243);
    }
  });
});

describe('a note’s file: noteNameOf and notePath (D1.2)', () => {
  it.each([
    ['notes/Home.md', 'Home'],
    ['notes/Payment form.md', 'Payment form'],
    ['notes/x.md.md', 'x.md'],
  ])('%j is the file of the note %j', (path, name) => {
    expect(noteNameOf(path)).toBe(name);
    expect(notePath(name)).toBe(path);
  });

  it.each([
    ['notes/CLAUDE.md', 'a host-only name, for every principal'],
    ['notes/claude.md', 'the same, folded'],
    ['notes/x.MD', 'the suffix is literal: a case-insensitive file system would let x.MD through'],
    ['notes/x.txt', 'not Markdown'],
    ['notes/x', 'no suffix'],
    ['notes/a/b.md', 'notes/ is flat: one segment'],
    ['notes/.md', 'an empty name'],
    ['notes/..md', 'a leading dot'],
    ['notes/Ho​me.md', 'an invisible character'],
    ['Notes/Home.md', 'the folder is literal'],
    ['notes.md', 'not in the folder'],
    ['notes/', 'the folder itself'],
    ['notes', 'the folder itself'],
    ['src/x.md', 'another folder'],
    ['a/notes/Home.md', 'only the folder at the top'],
    [`notes/${'x'.repeat(NOTE_NAME_MAX_CHARS + 1)}.md`, 'a name too long'],
    ['', 'the root'],
  ])('%j is no note’s file: %s', (path) => {
    expect(noteNameOf(path)).toBeNull();
  });

  it('notePath refuses a name that is no note’s', () => {
    expect(() => notePath('CLAUDE')).toThrow(RangeError);
    expect(() => notePath('a/b')).toThrow(RangeError);
  });
});
