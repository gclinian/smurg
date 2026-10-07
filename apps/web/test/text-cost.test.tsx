// What a text costs the page that shows it (review R4-03, third round).
//
// A message, a spec, a report, a name, a file name, a diff, a line of terminal output: each is written by one member
// or by an agent and rendered in every member's browser. So everything in src/ that looks at such a text while a
// page renders must cost in proportion to its length, whatever the text is. An expression like `/x+$/`, `/\s*$/` or
// `/^## +(.*?)(?: +#+)? *$/` is tried again from every character of a long run and costs the square of the run: a
// line of 64,000 spaces held a column for three seconds, at every mount.
//
// This file walks one list of hostile texts through every such function, measures each at one size and at twice that
// size, and fails when twice the text costs much more than twice the time. It also keeps the list of the source files
// that hold a regular expression: a new one has to be looked at here before the list is changed.
import { msg } from '@smurg/protocol/i18n';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sideBySide, splitLines } from '../src/features/activity/diff-view.ts';
import { findPathCandidates, mayAskAbout, normalizeSessionPath } from '../src/features/agents/path-links.ts';
import { parseDiff } from '../src/features/conversation/diff.ts';
import { mentionQueryAt, mentionsIn, type Person } from '../src/features/conversation/people.ts';
import { cardDomId, commandHead, commandsOfRule, commonDir, quoteSelection, showControls } from '../src/features/conversation/text.ts';
import { formatSelectionForAgent, sanitizeForAgent } from '../src/features/editor/selection.ts';
import { wrapsLines } from '../src/features/editor/view-model.ts';
import { decodeEntities } from '../src/features/markdown/entities.ts';
import { Markdown, MarkdownPieces, PlainText, findMentions, safeHref, type MarkdownPaths } from '../src/features/markdown/index.ts';
import * as lex from '../src/features/markdown/lex.ts';
import { PAUSE_MAX_MS, URGENT_PARSE_MS, forgetParses, lexMarkdown, lexMarkdownPieces, parseBudgetMs, waitsForTime } from '../src/features/markdown/lex.ts';
import { namesAnotherPlace } from '../src/features/markdown/links.ts';
import { parseStreaming } from '../src/features/markdown/Markdown.tsx';
import { stableLength } from '../src/features/markdown/stream.ts';
import { specOpenQuestions, specSections } from '../src/features/topics/model.ts';
import { hasInvisible, parseDiffLines, revealInvisible, splitDiffSections } from '../src/features/worktree/diff-model.ts';
import { renderWireText } from '../src/lib/errors.ts';
import { formatAnd, gapAfter, joinSentences } from '../src/lib/format.ts';
import { cssString } from '../src/lib/presence-css.ts';
import { trimEndOf } from '../src/lib/trim.ts';
import { tApp } from '../src/strings/app.ts';
import { initialsOf } from '../src/ui/Avatar.tsx';

afterEach(() => forgetParses());

// ---- the texts

/** One character each of the kinds an expression treats differently; a text is a long run of one of them. */
const RUNS: Readonly<Record<string, string>> = {
  space: ' ',
  tab: '\t',
  hash: '#',
  star: '*',
  underscore: '_',
  backtick: '`',
  'greater-than': '>',
  'closing parenthesis': ')',
  'closing bracket': ']',
  dot: '.',
  at: '@',
  colon: ':',
  slash: '/',
  hyphen: '-',
  letter: 'a',
  'a Chinese character': '\u5b57',
  'an emoji': '\u{1F600}',
  'a combining mark': '\u0301',
  // Not in the review's list, added here: what a line, a link, an escape and an entity are made of.
  'line break': '\n',
  'carriage return': '\r',
  backslash: '\\',
  ampersand: '&',
  'less-than': '<',
  'opening bracket': '[',
  digit: '1',
  pipe: '|',
  'a right-to-left override': '\u202e',
  // Runs of TWO characters in turn: marks of two combining classes (putting them in order costs the square of the
  // run in the browser's own `normalize`: 0.3 s for 32,000 of them), a letter and a mark, a mark and its closing.
  'two combining marks in turn': '\u0301\u0316',
  'a letter and a combining mark in turn': 'e\u0301',
  'a star and a space in turn': '* ',
  'an underscore and a letter in turn': '_a',
  'a dot and a letter in turn': '.a',
  'a bracket and its closing in turn': '[]',
};

/** What stands in front of the run: nothing and a heading for everything, and for each function what it looks for. */
const GENERAL: readonly string[] = ['', '## a'];

interface HostileText {
  readonly name: string;
  /** The text at about `chars` UTF-16 units. */
  make(chars: number): string;
}

function hostileTexts(more: readonly string[] = []): HostileText[] {
  const fronts = [...GENERAL, ...more];
  const texts: HostileText[] = [];
  for (const [name, unit] of Object.entries(RUNS)) {
    const run = (chars: number): string => unit.repeat(Math.floor(chars / unit.length));
    for (const front of fronts) {
      const label = front === '' ? `a run of ${name}` : `${JSON.stringify(front)} and a run of ${name}`;
      if (front === '') texts.push({ name: label, make: (chars) => run(chars) });
      // A run that is NOT at the end: what `x+$` is tried against from every character.
      texts.push({ name: `${label}, then a letter`, make: (chars) => `${front}${run(chars)}b` });
    }
    // The run cut into lines, and into paragraphs that are each within the size of a paragraph.
    texts.push({ name: `lines of ${name}`, make: (chars) => `${unit}\n`.repeat(Math.floor(chars / (unit.length + 1))) });
    texts.push({ name: `paragraphs of ${name} after a web address`, make: (chars) => `http://a.a${unit.repeat(Math.floor(15_000 / unit.length))}\n\n`.repeat(Math.max(1, Math.floor(chars / 15_012))) });
  }
  return texts;
}

// ---- measuring
//
// What is measured is the processor time of this test's own process, not the time on the wall: the gate runs every
// project at once, and a test that is set aside for a moment by the machine did not cost the page anything. And the
// two sizes are far apart (one and SIXTEEN times): sixteen times the text costs about sixteen times as much when the
// cost is proportional and 256 times as much when it grows with the square, so the line between the two (64 times)
// has a factor of four to either side for whatever else the machine does (a loaded machine was seen to make a
// function that builds 260,000 rows nine times dearer for four times the text).

const cpuMs = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1_000;
};

/** The cheapest of up to `rounds` runs, in milliseconds of processor time. One that is cheap enough is measured once. */
function cost(run: () => void, cheapEnough: number, rounds = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    const started = cpuMs();
    run();
    best = Math.min(best, cpuMs() - started);
    if (best <= cheapEnough) break;
  }
  return best;
}

/** Below this, sixteen times the text may cost anything: the numbers are noise. */
const NOISE_MS = 40;
const TIMES = 16;
/** Between "in proportion" (16) and "with the square" (256). */
const AT_MOST_TIMES = 64;

/**
 * Fails when `subject` costs far more than sixteen times as much for sixteen times the text. `chars` is chosen so
 * that a cost that grows with the square shows: 3 ms at 64 KiB is 48 ms at 256 KiB (and most of a second at 1 MiB).
 */
function expectProportional(subject: string, texts: readonly HostileText[], chars: number, run: (text: string) => void, atMost?: (chars: number) => number): void {
  const slow: string[] = [];
  for (const text of texts) {
    const small = text.make(chars);
    const large = text.make(chars * TIMES);
    let one = cost(() => run(small), NOISE_MS / AT_MOST_TIMES);
    let many = cost(() => run(large), Math.max(NOISE_MS, one * TIMES));
    if (many > Math.max(NOISE_MS, one * AT_MOST_TIMES)) {
      // Said twice before it is believed: a function that makes a lot of garbage is charged for its collection now and then.
      one = cost(() => run(small), 0, 5);
      many = cost(() => run(large), Math.max(NOISE_MS, one * TIMES), 5);
    }
    if (many > Math.max(NOISE_MS, one * AT_MOST_TIMES)) slow.push(`${text.name}: ${one.toFixed(2)} ms for ${small.length} characters, ${many.toFixed(0)} ms for ${large.length}`);
    else if (atMost !== undefined && many > atMost(large.length)) slow.push(`${text.name}: ${many.toFixed(0)} ms for ${large.length} characters, more than ${atMost(large.length).toFixed(0)} ms`);
  }
  expect(slow, subject).toEqual([]);
}

// ---- what the texts are walked through

const NAMES: readonly string[] = ['Ian', 'Mei', 'a', 'aa', '@', '.', '\u5b57', 'a'.repeat(64), ' '];
const PEOPLE: readonly Person[] = NAMES.map((displayName, index) => ({ userId: `u_${index}`, displayName, role: 'editor', color: '#336699', online: true }));
const FILE = { root: { kind: 'main' }, path: 'src/a.ts' } as const;

/** The conversation's path finder, as features/conversation/env.tsx hands it to the renderer for a member who is not the host. */
const paths: MarkdownPaths = {
  find: (text) =>
    findPathCandidates(text)
      .filter((candidate) => {
        const path = normalizeSessionPath(candidate.path);
        return path !== null && mayAskAbout(path, { isHost: false });
      })
      .map((candidate) => ({ start: candidate.start, end: candidate.end, text: candidate.text })),
  resolve: () => Promise.resolve(null),
};

const NOTHING_PARSED = { text: '', stableText: '', stable: [], tail: [] } as const;

interface Look {
  readonly run: (text: string) => void;
  /** What this function looks for at the start of a text, besides nothing and a heading. */
  readonly fronts?: readonly string[];
  /** The longest text the function is ever handed, where the wire bounds it below the walk's own size. */
  readonly longest?: number;
}

/** The walk's sizes: sixteen times apart, the larger one a quarter of the longest text there is. */
const LARGE_CHARS = 262_144;

/** Every function of src/ that is handed text someone else wrote, outside the lexer's budget. */
const LOOKS: Readonly<Record<string, Look>> = {
  'specSections (the spec column, at every change of the text)': { run: (text) => void specSections(text), fronts: ['## ', '```', '- '] },
  'specOpenQuestions (before "Generate plan")': { run: (text) => void specOpenQuestions(text), fronts: ['## open questions', '## open questions\n- ', '## open questions\n1. none'] },
  'the path finder of a conversation': { run: (text) => void paths.find(text), fronts: ['src/a', '../', 'a.b', '.git/'] },
  'the path finder of a terminal line': { run: (text) => void findPathCandidates(text), fronts: ['src/a', 'a.ts:1'] },
  normalizeSessionPath: { run: (text) => void normalizeSessionPath(text), fronts: ['src/a', '../'] },
  'the mention finder': { run: (text) => void findMentions(text, NAMES), fronts: ['@Ian', '@a'] },
  'mentionsIn (who a message names)': { run: (text) => void mentionsIn(text, PEOPLE), fronts: ['@Ian', '@a'] },
  'mentionQueryAt (the composer)': { run: (text) => void mentionQueryAt(text, text.length), fronts: ['@'] },
  'namesAnotherPlace (a link\u2019s words)': { run: (text) => void namesAnotherPlace(text, 'https://example.com/'), fronts: ['a@a', 'http://a.a', 'www.a', 'a.com', '1.1.1'] },
  safeHref: { run: (text) => void safeHref(text), fronts: ['https://a.a/', 'mailto:a@a'] },
  decodeEntities: { run: (text) => void decodeEntities(text), fronts: ['&#', '&#x', '&a'] },
  'stableLength (a streaming text)': { run: (text) => void stableLength(text), fronts: ['```\n', '\n\n1'] },
  'showControls (a command on a permission card)': { run: (text) => void showControls(text) },
  commandHead: { run: (text) => void commandHead(text, 3) },
  commandsOfRule: { run: (text) => void commandsOfRule(`${text}*`) },
  commonDir: { run: (text) => void commonDir([text, `${text}/b`]) },
  quoteSelection: { run: (text) => void quoteSelection({ file: FILE, startLine: 1, endLine: 2, text }) },
  cardDomId: { run: (text) => void cardDomId(text) },
  'parseDiff (a tool card)': { run: (text) => void parseDiff(text), fronts: ['@@ -1 +1 @@', '@@ ', '--- a\n+++ b\n@@ -1,1'] },
  'splitDiffSections and parseDiffLines (the review of a merge)': {
    run: (text) => void splitDiffSections(`diff --git a/a b/a\n${text}`).map((section) => parseDiffLines(section.text)),
    fronts: ['@@ -1 +1 @@', '@@ -1,1'],
  },
  'hasInvisible and revealInvisible (a diff line)': { run: (text) => void (hasInvisible(text) ? revealInvisible(text.slice(0, 65_536)) : null) },
  // A conflict's two texts are at most 64 KiB each (features/activity/diff-view.ts).
  'splitLines and sideBySide (a conflict)': { run: (text) => void [splitLines(text).length, sideBySide(text, `other\n${text}`, 1).length], longest: 65_536 },
  'sanitizeForAgent and formatSelectionForAgent': { run: (text) => void formatSelectionForAgent({ file: FILE, startLine: 1, endLine: 2, code: sanitizeForAgent(text) }) },
  'wrapsLines (a file name)': { run: (text) => void wrapsLines(text), fronts: ['a.md', '.'] },
  'initialsOf (a name)': { run: (text) => void initialsOf(text) },
  'cssString (a name beside a caret)': { run: (text) => void cssString(text) },
  'gapAfter and joinSentences': { run: (text) => void joinSentences([text, gapAfter(text), text]) },
  'formatAnd (names in a sentence)': { run: (text) => void formatAnd([text, 'Mei', text]) },
  trimEndOf: { run: (text) => void trimEndOf(text, '. \n') },
  'a name inside a sentence of the app': { run: (text) => void tApp('login.signedInAs', { name: text }) },
  'a name inside a sentence of the host': { run: (text) => void renderWireText(msg('conversation.started.free', { name: text }), '') },
};

/** The renderer itself: the lexer's budget ends a parse, and what is rendered afterwards has none. */
const MOUNTS: Readonly<Record<string, Look>> = {
  '<Markdown> with paths and mentions': {
    run: (text) => void renderToStaticMarkup(<Markdown text={text} paths={paths} mentions={NAMES} />),
    fronts: ['- ', 'http://a.a', '[a](http://a.a) ', '<!--'],
  },
  '<Markdown> of a person\u2019s message (line breaks kept)': { run: (text) => void renderToStaticMarkup(<Markdown text={text} breaks paths={paths} mentions={NAMES} />), fronts: ['http://a.a'] },
  '<PlainText> (a suggestion, a comment)': { run: (text) => void renderToStaticMarkup(<PlainText text={text} mentions={NAMES} />), fronts: ['@Ian'] },
  'a streaming text': { run: (text) => void parseStreaming(text, NOTHING_PARSED), fronts: ['```\n'] },
};

describe('what a text costs the page that shows it (review R4-03)', () => {
  it('sixteen times the text costs about sixteen times as much, in every function that looks at text someone else wrote', () => {
    for (const [subject, look] of Object.entries(LOOKS)) expectProportional(subject, hostileTexts(look.fronts), Math.min(LARGE_CHARS, look.longest ?? LARGE_CHARS) / TIMES, look.run);
  }, 600_000);

  it('the same through the renderer, and no text holds a mount longer than its budget', () => {
    // Every measurement is of a first mount on a page that has all its time: a text that ran out of time is
    // remembered, and a page whose share is spent parses nothing for the moment.
    const first = (mount: Look) => (text: string): void => {
      forgetParses();
      mount.run(text);
    };
    // And no text, at the size of a long message, takes more than its own budget, one pause, and the render of what
    // the lexer made of it.
    const atMost = (chars: number): number => parseBudgetMs(chars) + PAUSE_MAX_MS + 250;
    for (const [subject, mount] of Object.entries(MOUNTS)) expectProportional(subject, hostileTexts(mount.fronts), 8_192, first(mount), atMost);
  }, 600_000);

  it('a link whose words are thousands of accents costs what its length costs (the browser\u2019s own normalize took 75 ms per link, outside any budget)', () => {
    // Marks of two combining classes in turn: putting one run of them in order costs the square of the run.
    const words = `x${'\u0301\u0316'.repeat(7_900)}`;
    const links = (count: number): string => Array.from({ length: count }, (_, index) => `[${words}](https://example.com/${index})`).join('\n\n');
    expect(renderToStaticMarkup(<Markdown text={links(1)} />)).toContain('<a class="md-link" href="https://example.com/0"');
    // A 256 KiB message of sixteen such links: the lexer's budget and the render, not sixteen times 75 ms on top.
    const message = links(16);
    const took = cost(() => {
      forgetParses();
      renderToStaticMarkup(<Markdown text={message} />);
    }, 0);
    expect(took).toBeLessThan(parseBudgetMs(message.length) + PAUSE_MAX_MS + 250);
    // What the marks stand on is still read: a look-alike under a heap of accents is a look-alike.
    expect(namesAnotherPlace(`gi${'\u0307\u0316'.repeat(4_000)}thub.com`, 'https://evil.example/')).toBe(true);
    expect(namesAnotherPlace(`github.com${'\u0301\u0316'.repeat(4_000)}`, 'https://evil.example/')).toBe(true);
    expect(namesAnotherPlace(`caf\u00e9 ${'\u0301\u0316'.repeat(4_000)} menu`, 'https://evil.example/')).toBe(false);
  });

  it('a line of SPEC.md that is a heading and a run of spaces costs nothing to speak of (it held the column for 3.3 s)', () => {
    const line = `## a${' '.repeat(64_000)}b`;
    const started = cpuMs();
    expect(specSections(`# Spec\n\n${line}\n\ntext`).map((section) => section.heading)).toEqual([null, `a${' '.repeat(64_000)}b`]);
    expect(specOpenQuestions(`## Open questions${' '.repeat(64_000)}#${' '.repeat(64_000)}x\n- one`)).toBe(0);
    expect(cpuMs() - started).toBeLessThan(200);
    // And what they said before, they say now.
    expect(specSections('intro\n\n## One ##\na\n\n```\n## not a heading\n```\n##  Two  \nb').map((section) => section.heading)).toEqual([null, 'One', 'Two']);
    expect(specSections('## a ## b\n## c##\n## #\n##\n## ').map((section) => section.heading)).toEqual(['a ## b', 'c##', '', '']);
    expect(specOpenQuestions('## Open Questions ##\n1) Tax?\n* none\n+ N/A.\n2. Shipping?\n### Next\n- no')).toBe(2);
    expect(specOpenQuestions('#\topen questions\t\nNothing.\n\n')).toBe(0);
    expect(specOpenQuestions('####### open questions\n- a')).toBe(0);
    expect(specOpenQuestions('## Open questions\n-\n')).toBe(1);
  });
});

describe('the lexer\u2019s budget is the budget of a text and of a mount (review R4-03)', () => {
  /** A paragraph that costs the lexer far more than its length: a web address whose closing marks it takes back one at a time. */
  const paragraph = (index: number): string => `${index} http://a.a${')'.repeat(15_950)}`;

  it('a SPEC.md of many sections has the one budget of its text, not one for each section', () => {
    // 62 sections of one such paragraph each (1 MiB): each section alone stays inside a budget of its own.
    const sections = Array.from({ length: 62 }, (_, index) => `## Section ${index}\n\n${paragraph(index)}\n`);
    const whole = sections.join('\n');
    const started = cpuMs();
    const view = render(
      <MarkdownPieces text={whole} pieces={sections}>
        {(body, index) => <section key={index}>{body}</section>}
      </MarkdownPieces>,
    );
    // The budget of the one text (0.3 s for 1 MiB), one pause, and the render of 62 sections shown as written.
    expect(cpuMs() - started).toBeLessThan(parseBudgetMs(whole.length) + PAUSE_MAX_MS + 600);
    // The whole text is shown as written, every character of it, with ONE note; and it is remembered.
    expect(view.container.querySelectorAll('section')).toHaveLength(62);
    expect(view.container.querySelectorAll('.md-note')).toHaveLength(1);
    expect([...view.container.querySelectorAll('.md-plain')].map((node) => node.textContent).join('\n')).toBe(whole);
    view.unmount();
    let clock = 0;
    const again = cpuMs();
    expect(lexMarkdownPieces(sections, whole, { now: () => (clock += 1) })[61]).toMatchObject([{ type: 'plain', reason: 'time', quiet: true }]);
    expect(clock).toBe(0);
    expect(cpuMs() - again).toBeLessThan(100);
    // Somebody types in the last section: another whole text, which still holds the section the budget ran out on.
    // It is not spent again at every keystroke.
    const typed = [...sections.slice(0, 61), `${sections[61]}More.\n`];
    expect(lexMarkdownPieces(typed, typed.join('\n'), { now: () => (clock += 1) })[0]).toMatchObject([{ type: 'plain', reason: 'time' }]);
    expect(clock).toBe(0);
  });

  it('a spec of ordinary sections is formatted section by section, and a section that is too deep is shown as written by itself', () => {
    const sections = ['# Checkout\n\nThe lead.\n', '## Payments\n\n- **cards**\n- cash\n', `## Deep\n\n${'>'.repeat(200)} x\n`, '## Last\n\nDone.'];
    const view = render(
      <MarkdownPieces text={sections.join('\n')} pieces={sections} headingBase={3}>
        {(body, index) => <section key={index}>{body}</section>}
      </MarkdownPieces>,
    );
    const shown = [...view.container.querySelectorAll('section')];
    expect(shown[0]?.querySelector('h3')?.textContent).toBe('Checkout');
    expect(shown[1]?.querySelector('h4')?.textContent).toBe('Payments');
    expect(shown[1]?.querySelectorAll('li')).toHaveLength(2);
    expect(shown[2]?.querySelector('.md-plain')?.textContent).toBe(sections[2]);
    expect(shown[2]?.querySelectorAll('.md-note')).toHaveLength(1);
    expect(shown[3]?.querySelector('p')?.textContent).toBe('Done.');
  });

  it('a change in one section of a spec parses that section only, and the others are not drawn again', () => {
    const lexed = vi.spyOn(lex, 'lexMarkdownPieces');
    const sections = ['# Checkout\n\nThe lead.\n', '## Payments\n\n- cards\n', '## Shipping\n\nBy post.\n'];
    const page = (pieces: readonly string[]) => (
      <MarkdownPieces text={pieces.join('\n')} pieces={pieces} headingBase={3}>
        {(body, index) => <section key={index}>{body}</section>}
      </MarkdownPieces>
    );
    const view = render(page(sections));
    expect(lexed.mock.calls.map((call) => call[0])).toEqual([sections]);
    const shipping = view.container.querySelectorAll('section')[2]?.querySelector('p');
    // Somebody types in "Payments": a keystroke changes the whole text and one of its pieces.
    const edited = [sections[0] as string, '## Payments\n\n- cards\n- cash\n', sections[2] as string];
    view.rerender(page(edited));
    expect(lexed.mock.calls.map((call) => call[0])).toEqual([sections, [edited[1]]]);
    expect(lexed.mock.calls[1]?.[1]).toBe(edited.join('\n'));
    expect(view.container.querySelectorAll('section')[1]?.querySelectorAll('li')).toHaveLength(2);
    expect(view.container.querySelectorAll('section')[2]?.querySelector('p')).toBe(shipping);
    // Nothing changed: nothing is parsed. A section that comes back is one that was not kept: it is parsed again.
    view.rerender(page([...edited]));
    expect(lexed).toHaveBeenCalledTimes(2);
    view.rerender(page(sections));
    expect(lexed.mock.calls[2]?.[0]).toEqual([sections[1]]);
    lexed.mockRestore();
  });

  it('every step is timed from the first, the last one too, and one text of such paragraphs is ended by its budget (0.9 s per mount before)', () => {
    // 13 paragraphs, 208 KiB: fewer steps than the lexer once left untimed.
    const text = Array.from({ length: 13 }, (_, index) => paragraph(index)).join('\n\n');
    const started = cpuMs();
    const first = renderToStaticMarkup(<Markdown text={text} />);
    expect(cpuMs() - started).toBeLessThan(parseBudgetMs(text.length) + PAUSE_MAX_MS + 250);
    expect(first).toContain('md-note');
    // Remembered by what it says, not by where it stands: another mount, other options, no parse.
    const again = cpuMs();
    expect(renderToStaticMarkup(<Markdown text={text} breaks headingBase={4} />)).toContain('md-note');
    expect(cpuMs() - again).toBeLessThan(60);
    // A clock of our own: the first step already counts, and so does the step after which nothing follows.
    let slowStart = 0;
    expect(lexMarkdown('A short text with *one* mark.', { now: () => (slowStart += 1_000) })).toMatchObject([{ type: 'plain', reason: 'time' }]);
    let calls = 0;
    const lastIsSlow = lexMarkdown('Another short text.', { now: () => ((calls += 1) < 6 ? calls : 5_000_000) });
    expect(lastIsSlow).toMatchObject([{ type: 'plain', reason: 'time' }]);
  });

  it('a column of texts that each stay inside their own budget does not hold the page for all of them together', () => {
    // A clock of our own that moves a little at every look: each of these messages costs the same, a good part of
    // its own budget, and is formatted. A column of forty cost the sum, at every mount, when nothing bounded the mount.
    let clock = 0;
    const now = (): number => (clock += 0.25);
    const message = (index: number): string => `${Array.from({ length: 30 }, (_, word) => `*word ${word}*`).join(' ')}\n\nmessage ${index}`;
    const alone = clock;
    expect(lexMarkdown(message(-1), { now })[0]?.type).toBe('paragraph');
    const each = clock - alone;
    expect(each).toBeGreaterThan(10);
    expect(each).toBeLessThan(parseBudgetMs(message(-1).length));
    // What a person waits for is the first pass: the page's share, and the one text that was being parsed when it ran
    // out. The texts after that wait, and none of them is remembered as slow.
    forgetParses();
    clock = 0;
    const kinds = Array.from({ length: 40 }, (_, index) => (waitsForTime(lexMarkdown(message(index), { urgent: true, now })) ? 'waits' : 'parsed'));
    const parsed = kinds.filter((kind) => kind === 'parsed').length;
    expect(parsed).toBe(Math.ceil(URGENT_PARSE_MS / each));
    expect(kinds.slice(parsed).every((kind) => kind === 'waits')).toBe(true);
    expect(clock).toBeLessThan(URGENT_PARSE_MS + each + 40);
    // Parsed when the page has time (not `urgent`): formatted, like the first ones.
    expect(lexMarkdown(message(39), { now })[0]?.type).toBe('paragraph');

    // On the page nothing is lost by waiting: render() returns when React has nothing left to do, and by then every
    // text is formatted (the ones that waited were parsed in a transition). The share is spent by a parse that says
    // it took that long, with the real clock.
    forgetParses();
    let calls = 0;
    lexMarkdown('spend the share', { urgent: true, now: () => performance.now() + ((calls += 1) > 2 ? URGENT_PARSE_MS : 0) });
    const view = render(
      <>
        {Array.from({ length: 12 }, (_, index) => (
          <Markdown key={index} text={`**message** ${index}`} />
        ))}
      </>,
    );
    expect(view.container.querySelectorAll('.md-plain')).toHaveLength(0);
    expect([...view.container.querySelectorAll('.md-body')].map((body) => body.textContent)).toEqual(Array.from({ length: 12 }, (_, index) => `message ${index}`));
    expect(view.container.querySelectorAll('.md-body strong')).toHaveLength(12);
  });

  it('a text that waits is shown as written without a note, and formatted when the page has time', () => {
    // A clock of our own: one parse that takes the whole share, and the next one in the same second waits.
    let calls = 0;
    lexMarkdown('spend the share', { urgent: true, now: () => ((calls += 1) > 2 ? URGENT_PARSE_MS : 0) });
    expect(lexMarkdown('**bold** and more', { urgent: true, now: () => URGENT_PARSE_MS })).toMatchObject([{ type: 'plain', reason: 'later', text: '**bold** and more' }]);
    // Without `urgent` (a transition, a stream) nothing waits; and a later second has a share of its own.
    expect(lexMarkdown('**bold** and more', { now: () => URGENT_PARSE_MS })[0]?.type).toBe('paragraph');
    expect(lexMarkdown('**bold** and more', { urgent: true, now: () => URGENT_PARSE_MS + 60_000 })[0]?.type).toBe('paragraph');

    // On the page, with the real clock: the share is spent by a parse that says it took that long.
    forgetParses();
    calls = 0;
    lexMarkdown('spend the share', { urgent: true, now: () => performance.now() + ((calls += 1) > 2 ? URGENT_PARSE_MS : 0) });
    // As written and without a note for the moment (static markup has no second pass) \u2026
    expect(renderToStaticMarkup(<Markdown text="**bold** and more" />)).toBe('<div class="md-body"><p class="md-plain" data-why="later">**bold** and more</p></div>');
    // \u2026 and formatted once React has had its turn.
    const view = render(<Markdown text="**bold** and more" />);
    expect(view.container.querySelector('strong')?.textContent).toBe('bold');
    expect(view.container.querySelector('.md-plain')).toBeNull();
    // The same for a text in pieces.
    const pieces = render(
      <MarkdownPieces text={'## One\n\n## Two'} pieces={['## One\n', '## Two']} headingBase={3}>
        {(body, index) => <section key={index}>{body}</section>}
      </MarkdownPieces>,
    );
    expect([...pieces.container.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['One', 'Two']);
  });
});

// ---- the list of regular expressions

const SOURCES = import.meta.glob(['../src/**/*.ts', '../src/**/*.tsx', '!../src/**/*.test.ts', '!../src/**/*.test.tsx', '!../src/testing/**', '!../src/**/test-support.tsx', '!../src/**/testing/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** A regular expression in a line of source: a literal after something a value can follow, or `new RegExp(`. */
const EXPRESSION = /(?:^|[=(,:?!&|[{;]|\breturn|\btypeof)\s*\/(?![/*\s>])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuvy]*(?=\s*[.,;)\]}\n]|\s*$)|new RegExp\(/gm;
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * How many regular expressions each source file holds. Every one of them was looked at for this test (third round of
 * R4-03): it is anchored and tried once, or it is a class of single characters, or every repetition in it is bounded,
 * or its text is the app's own (a route, a user agent, a string of a catalogue), or the walk above measures it.
 * A NEW expression changes a number here: before changing the number, make sure the expression cannot be tried again
 * from every character of a long run of text someone else wrote (`x+$`, `\s*$`, `a*b*$`, two neighbours that match the
 * same characters), and add its function to LOOKS above when it is handed such text.
 */
const EXPRESSIONS: Readonly<Record<string, number>> = {
  'boot/capture-invite.ts': 1,
  'features/agents/path-links.ts': 3,
  'features/console/invite-form.ts': 1,
  'features/console/settings-form.ts': 4,
  'features/conversation/PermissionCard.tsx': 2,
  'features/conversation/diff.ts': 2,
  'features/conversation/people.ts': 2,
  'features/conversation/text.ts': 5,
  'features/editor/selection.ts': 3,
  'features/editor/view-model.ts': 3,
  'features/markdown/Markdown.tsx': 1,
  'features/markdown/entities.ts': 1,
  'features/markdown/links.ts': 5,
  'features/markdown/render.tsx': 2,
  'features/markdown/stream.ts': 3,
  'features/topics/Discussion.tsx': 1,
  'features/topics/NewTopicDialog.tsx': 2,
  'features/topics/model.ts': 2,
  'features/worktree/diff-model.ts': 3,
  'lib/connection/browser-deps.ts': 11,
  'lib/format.ts': 3,
  'lib/presence-css.ts': 3,
  'lib/relay/auth.ts': 1,
  'lib/router.ts': 4,
  'strings/catalog.ts': 5,
  'ui/Avatar.tsx': 3,
};

describe('the regular expressions of the app', () => {
  it('are the ones that were looked at: a new one is looked at before this list changes', () => {
    const found: Record<string, number> = {};
    for (const [path, source] of Object.entries(SOURCES)) {
      let count = 0;
      for (const line of source.split('\n')) if (!COMMENT.test(line)) count += [...line.matchAll(EXPRESSION)].length;
      if (count > 0) found[path.replace('../src/', '')] = count;
    }
    expect(found).toEqual(EXPRESSIONS);
  });
});
