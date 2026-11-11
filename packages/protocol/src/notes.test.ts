// A sticky note's name and file (DESIGN 0.8.0 D1.2): every rule, one case each, with its reason as the case's title.
// The tool gate (G13), the index and `sticky.create` ask exactly these functions. Then the one finder of wiki links
// (D1.4) and the tree grown from Home (D2.3).
import { describe, expect, it } from 'vitest';
import { agentText } from './agent-text.ts';
import {
  NOTE_FILE_SUFFIX,
  WIKI_LINK_MAX_CHARS,
  foldNoteName,
  isNoteName,
  noteNameOf,
  noteNameProblem,
  noteNameSchema,
  notePath,
  noteTree,
  wikiLinkSpans,
  wikiLinks,
  type NoteTreeNode,
} from './notes.ts';
import { itemTitleSchema, topicNameSchema } from './schema/entities.ts';
import { NOTE_LINKS_MAX, NOTE_NAME_MAX_CHARS } from './schema/limits.ts';
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

describe('names that are one note (D1.3)', () => {
  it('fold equal as a case-insensitive file system compares them', () => {
    expect(foldNoteName('Home')).toBe(foldNoteName('home'));
    expect(foldNoteName('HOME')).toBe(foldNoteName('home'));
    expect(foldNoteName('Payment form')).not.toBe(foldNoteName('Payment-form'));
  });
});

describe('wiki links: wikiLinks (D1.4)', () => {
  it('finds each [[Name]] in order, each once, the first spelling of names that fold equal', () => {
    expect(wikiLinks('See [[Checkout]] and [[Payment form]], then [[checkout]] again and [[Home]].')).toEqual(['Checkout', 'Payment form', 'Home']);
    expect(wikiLinks('[[結帳流程]]的細節')).toEqual(['結帳流程']);
    expect(wikiLinks('')).toEqual([]);
    expect(wikiLinks('no links here [not one] [[]]')).toEqual([]);
  });

  it('drops a target that is no valid name', () => {
    expect(wikiLinks('[[a/b]] [[CLAUDE]] [[ Home ]] [[x.]] [[a|label]] [[Ho​me]] [[Good]]')).toEqual(['Good']);
  });

  it('skips code spans, of one backtick or of several, also over a line end', () => {
    expect(wikiLinks('Use `[[Not a link]]` or ``a ` [[Still code]] `` but [[Yes]].')).toEqual(['Yes']);
    expect(wikiLinks('A span `over\n[[the line end]]` and [[After]].')).toEqual(['After']);
    // A blank line ends the paragraph: a backtick before it and one after it are no span.
    expect(wikiLinks('A lone ` here\n\n[[After the blank line]] `')).toEqual(['After the blank line']);
    expect(wikiLinks('A lone ` here\n[[In the span]] `')).toEqual([]);
  });

  it('a run of backticks with no closer of the same length is text, and the links around it count', () => {
    expect(wikiLinks('``` not a fence: the line has ` in it [[One]]')).toEqual(['One']);
    expect(wikiLinks('`` [[Two]] ` [[Three]] `')).toEqual(['Two']);
    expect(wikiLinks('`` [[Two]] [[Three]]')).toEqual(['Two', 'Three']);
  });

  it('skips fenced code, of backticks and of tildes, and a fence never closed goes on to the end', () => {
    const text = ['[[Before]]', '```ts', '[[In code]]', '```', '[[Between]]', '~~~~', '[[In tildes]]', '~~~', '[[Still in tildes]]', '~~~~', '[[After]]', '   ```', '[[Unclosed]]'].join('\n');
    expect(wikiLinks(text)).toEqual(['Before', 'Between', 'After']);
    // CRLF line ends close a fence too.
    expect(wikiLinks('```\r\n[[In code]]\r\n```\r\n[[After]]\r\n')).toEqual(['After']);
  });

  it('nested brackets: the outer ones are text, a bracket inside ends the try', () => {
    expect(wikiLinks('[[[Home]]]')).toEqual(['Home']);
    expect(wikiLinks('[[a[[Inner]]')).toEqual(['Inner']);
    expect(wikiLinks('[[a]b]] [[Next]]')).toEqual(['Next']);
    expect(wikiLinks('[[Split\nline]] [[Whole]]')).toEqual(['Whole']);
  });

  it(`a link is at most ${WIKI_LINK_MAX_CHARS} units: a longer one is no link`, () => {
    const longest = 'x'.repeat(NOTE_NAME_MAX_CHARS);
    expect(WIKI_LINK_MAX_CHARS).toBe(NOTE_NAME_MAX_CHARS + 4);
    expect(wikiLinks(`[[${longest}]]`)).toEqual([longest]);
    expect(wikiLinks(`[[${longest}y]] [[Short]]`)).toEqual(['Short']);
    expect(wikiLinks(`[[${'z'.repeat(5000)}]]`)).toEqual([]);
  });

  it(`keeps at most ${NOTE_LINKS_MAX} links: the thirty-third is not kept`, () => {
    const names = Array.from({ length: NOTE_LINKS_MAX + 1 }, (_, i) => `Note ${i}`);
    expect(wikiLinks(names.map((name) => `[[${name}]]`).join(' '))).toEqual(names.slice(0, NOTE_LINKS_MAX));
    // A repeat is no new link: thirty-two names said twice are thirty-two links.
    const twice = [...names.slice(0, NOTE_LINKS_MAX), ...names.slice(0, NOTE_LINKS_MAX)];
    expect(wikiLinks(twice.map((name) => `[[${name}]]`).join(''))).toHaveLength(NOTE_LINKS_MAX);
  });

  it('the known disagreements with the web renderer, only about what is code (named for S3: marked reads these the other way)', () => {
    // An indented code block: marked renders it as code; the finder reads a link there.
    expect(wikiLinks('Text\n\n    [[Indented]]\n')).toEqual(['Indented']);
    // A backtick escaped with a backslash: marked shows a backtick and the link; the finder opens a span there.
    expect(wikiLinks('\\` [[Escaped]] `')).toEqual([]);
  });
});

describe('wiki links of one rendered run: wikiLinkSpans (D1.4, D7.5)', () => {
  it('says where each link is, its brackets included, every time it is written, by the link rule of wikiLinks', () => {
    const text = 'See [[Checkout]], [[checkout]] and [[Checkout]] again; [[a/b]] [[結帳流程]].';
    const spans = wikiLinkSpans(text);
    expect(spans.map((span) => span.name)).toEqual(['Checkout', 'checkout', 'Checkout', '結帳流程']);
    expect(spans[0]).toEqual({ start: 4, end: 16, name: 'Checkout' });
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(`[[${span.name}]]`);
    expect(wikiLinkSpans('')).toEqual([]);
    expect(wikiLinkSpans('[[[Home]]] [[a[[Inner]] [[Split\nline]]').map((span) => span.name)).toEqual(['Home', 'Inner']);
    expect(wikiLinkSpans(`[[${'x'.repeat(NOTE_NAME_MAX_CHARS)}y]] [[CLAUDE]] [[ Home ]]`)).toEqual([]);
  });

  it('takes nothing of the run for code (the lexer did) and keeps every link, past the index\'s thirty-two', () => {
    expect(wikiLinkSpans('`[[A]]` ``` [[B]]').map((span) => span.name)).toEqual(['A', 'B']);
    const many = Array.from({ length: NOTE_LINKS_MAX + 8 }, (_, i) => `[[Note ${i}]]`).join(' ');
    expect(wikiLinkSpans(many)).toHaveLength(NOTE_LINKS_MAX + 8);
    // The same text, read as a whole note, has the index's links: the first thirty-two names.
    expect(wikiLinks(many)).toHaveLength(NOTE_LINKS_MAX);
  });
});

describe('the tree: noteTree (D2.3)', () => {
  const note = (name: string, ...links: string[]) => ({ name, links });
  const names = (node: NoteTreeNode | null): unknown => (node === null ? null : [node.name, node.children.map(names)]);

  it('breadth first from Home along the links, siblings in link order', () => {
    const tree = noteTree([note('Home', 'Cart', 'Payment'), note('Cart', 'Stock'), note('Payment', 'Refunds'), note('Stock'), note('Refunds')]);
    expect(names(tree.home)).toEqual(['Home', [['Cart', [['Stock', []]]], ['Payment', [['Refunds', []]]]]]);
    expect(tree.notLinked).toEqual([]);
  });

  it('two parents: the first note that reaches it, breadth first, is its parent', () => {
    const tree = noteTree([note('Home', 'A', 'B'), note('A', 'Deep'), note('B', 'Shared'), note('Deep', 'Shared'), note('Shared')]);
    expect(names(tree.home)).toEqual(['Home', [['A', [['Deep', []]]], ['B', [['Shared', []]]]]]);
  });

  it('cycles end: a note already in the tree is not reached again', () => {
    const tree = noteTree([note('Home', 'A'), note('A', 'Home', 'B'), note('B', 'A', 'Home')]);
    expect(names(tree.home)).toEqual(['Home', [['A', [['B', []]]]]]);
  });

  it('notes Home does not reach are not linked, in the order given; a link to a note not written yet reaches nothing', () => {
    const tree = noteTree([note('Orphan', 'Home'), note('Home', 'Not written yet'), note('Another')]);
    expect(names(tree.home)).toEqual(['Home', []]);
    expect(tree.notLinked).toEqual(['Orphan', 'Another']);
  });

  it('names are compared folded: a link reaches the note whose name on disk folds equal, and home is Home', () => {
    expect(names(noteTree([note('home', 'checkout'), note('Checkout')]).home)).toEqual(['home', [['Checkout', []]]]);
  });

  it('a shadowed note is never in the tree: links reach its twin, and it is not linked', () => {
    const tree = noteTree([note('Home', 'cart'), { name: 'cart', links: [], shadowed: true }, note('Cart')]);
    expect(names(tree.home)).toEqual(['Home', [['Cart', []]]]);
    expect(tree.notLinked).toEqual(['cart']);
  });

  it('without Home every note is not linked', () => {
    expect(noteTree([note('A', 'B'), note('B')])).toEqual({ home: null, notLinked: ['A', 'B'] });
    expect(noteTree([])).toEqual({ home: null, notLinked: [] });
  });
});
