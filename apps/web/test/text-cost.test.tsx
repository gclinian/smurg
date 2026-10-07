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
import { afterEach, describe, expect, it } from 'vitest';
import { sideBySide, splitLines } from '../src/features/activity/diff-view.ts';
import { findPathCandidates, mayAskAbout, normalizeSessionPath } from '../src/features/agents/path-links.ts';
import { parseDiff } from '../src/features/conversation/diff.ts';
import { mentionQueryAt, mentionsIn, type Person } from '../src/features/conversation/people.ts';
import { cardDomId, commandHead, commandsOfRule, commonDir, quoteSelection, showControls } from '../src/features/conversation/text.ts';
import { formatSelectionForAgent, sanitizeForAgent } from '../src/features/editor/selection.ts';
import { wrapsLines } from '../src/features/editor/view-model.ts';
import { decodeEntities } from '../src/features/markdown/entities.ts';
import { Markdown, MarkdownPieces, PlainText, findMentions, safeHref, type MarkdownPaths } from '../src/features/markdown/index.ts';
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
  'a Chinese character': '字',
  'an emoji': '\u{1F600}',
  'a combining mark': '́',
  // Not in the review's list, added here: what a line, a link, an escape and an entity are made of.
  'line break': '\n',
  'carriage return': '\r',
  backslash: '\\',
  ampersand: '&',
  'less-than': '<',
  'opening bracket': '[',
  digit: '1',
  pipe: '|',
  'a right-to-left override': '‮',
};

/** What stands in front of the run. */
const FRONTS: readonly string[] = ['', '## a', '## open questions', '- ', 'a@a', 'http://a.a', 'src/a', '@@ -1 +1 @@', '[a](http://a.a) '];

interface HostileText {
  readonly name: string;
  /** The text at about `chars` UTF-16 units. */
  make(chars: number): string;
}

function hostileTexts(fronts: readonly string[]): HostileText[] {
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

/** The quickest of up to three runs: one pause of a busy machine is not the text's cost. Quick ones are measured once. */
function cost(run: () => void, quickEnough: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
    if (best <= quickEnough) break;
  }
  return best;
}

/** Below this, twice the text may cost anything: the numbers are noise. A function that costs the square is far above it at these sizes. */
const NOISE_MS = 30;

/**
 * Fails when `subject` costs much more than twice as long for twice the text. `chars` is chosen so that a cost that
 * grows with the square shows: 2 ms at 64 KiB is 8 ms at 128 KiB and 32 ms at 256 KiB (and half a second at 1 MiB).
 */
function expectProportional(subject: string, texts: readonly HostileText[], chars: number, run: (text: string) => void): void {
  const slow: string[] = [];
  for (const text of texts) {
    const small = text.make(chars);
    const large = text.make(chars * 2);
    const one = cost(() => run(small), NOISE_MS / 3);
    const two = cost(() => run(large), Math.max(NOISE_MS, one * 3));
    if (two > Math.max(NOISE_MS, one * 3.5)) slow.push(`${text.name}: ${one.toFixed(0)} ms for ${small.length} characters, ${two.toFixed(0)} ms for ${large.length}`);
  }
  expect(slow, subject).toEqual([]);
}

// ---- what the texts are walked through

const NAMES: readonly string[] = ['Ian', 'Mei', 'a', 'aa', '@', '.', '字', 'a'.repeat(64), ' '];
const PEOPLE: readonly Person[] = NAMES.map((displayName, index) => ({ userId: `u_${index}`, displayName, role: 'editor', color: '#336699', online: true }));
const FILE = { root: { kind: 'workspace' }, path: 'src/a.ts' } as const;

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

/** Every function of src/ that is handed text someone else wrote, outside the lexer's budget. */
const LOOKS: Readonly<Record<string, (text: string) => void>> = {
  'specSections (the spec column, at every change of the text)': (text) => void specSections(text),
  'specOpenQuestions (before "Generate plan")': (text) => void specOpenQuestions(text),
  'the path finder of a conversation': (text) => void paths.find(text),
  'the path finder of a terminal line': (text) => void findPathCandidates(text),
  'normalizeSessionPath': (text) => void normalizeSessionPath(text),
  'the mention finder': (text) => void findMentions(text, NAMES),
  'mentionsIn (who a message names)': (text) => void mentionsIn(text, PEOPLE),
  'mentionQueryAt (the composer)': (text) => void mentionQueryAt(text, text.length),
  'namesAnotherPlace (a link’s words)': (text) => void namesAnotherPlace(text, 'https://example.com/'),
  'safeHref': (text) => void safeHref(text),
  'decodeEntities': (text) => void decodeEntities(text),
  'stableLength (a streaming text)': (text) => void stableLength(text),
  'showControls (a command on a permission card)': (text) => void showControls(text),
  'commandHead': (text) => void commandHead(text, 3),
  'commandsOfRule': (text) => void commandsOfRule(text),
  'commonDir': (text) => void commonDir([text, `${text}/b`]),
  'quoteSelection': (text) => void quoteSelection({ file: FILE, startLine: 1, endLine: 2, text }),
  'cardDomId': (text) => void cardDomId(text),
  'parseDiff (a tool card)': (text) => void parseDiff(text),
  'splitDiffSections and parseDiffLines (the review of a merge)': (text) => void splitDiffSections(`diff --git a/a b/a\n${text}`).map((section) => parseDiffLines(section.text)),
  'hasInvisible and revealInvisible (a diff line)': (text) => void (hasInvisible(text) ? revealInvisible(text.slice(0, 65_536)) : null),
  'splitLines and sideBySide (a conflict)': (text) => void sideBySide(text, splitLines(text).reverse().join('\n'), 1),
  'sanitizeForAgent and formatSelectionForAgent': (text) => void formatSelectionForAgent({ file: FILE, startLine: 1, endLine: 2, code: sanitizeForAgent(text) }),
  'wrapsLines (a file name)': (text) => void wrapsLines(text),
  'initialsOf (a name)': (text) => void initialsOf(text),
  'cssString (a name beside a caret)': (text) => void cssString(text),
  'gapAfter and joinSentences': (text) => void joinSentences([text, gapAfter(text), text]),
  'formatAnd (names in a sentence)': (text) => void formatAnd([text, 'Mei', text]),
  'trimEndOf': (text) => void trimEndOf(text, '. \n'),
  'a name inside a sentence of the app': (text) => void tApp('login.signedInAs', { name: text }),
  'a name inside a sentence of the host': (text) => void renderWireText(msg('conversation.started.free', { name: text }), ''),
};

/** The renderer itself: the lexer's budget ends a parse, and what is rendered afterwards has none. */
const MOUNTS: Readonly<Record<string, (text: string) => void>> = {
  '<Markdown> with paths and mentions': (text) => void renderToStaticMarkup(<Markdown text={text} paths={paths} mentions={NAMES} />),
  '<Markdown> of a person’s message (line breaks kept)': (text) => void renderToStaticMarkup(<Markdown text={text} breaks paths={paths} mentions={NAMES} />),
  '<PlainText> (a suggestion, a comment)': (text) => void renderToStaticMarkup(<PlainText text={text} mentions={NAMES} />),
  'a streaming text': (text) => void parseStreaming(text, NOTHING_PARSED),
};

describe('what a text costs the page that shows it (review R4-03)', () => {
  const texts = hostileTexts(FRONTS);

  it('twice the text costs about twice the time, in every function that looks at text someone else wrote', () => {
    for (const [subject, look] of Object.entries(LOOKS)) expectProportional(subject, texts, 131_072, look);
  }, 600_000);

  it('the same through the renderer, and no text holds a mount longer than its budget', () => {
    const mounted = hostileTexts(['', '## a', '- ', 'http://a.a', '[a](http://a.a) ']);
    let unique = 0;
    for (const [subject, mount] of Object.entries(MOUNTS)) {
      // A text that ran out of time is remembered: every measurement is of a text that was never seen.
      expectProportional(subject, mounted, 65_536, (text) => mount(`${text}\n\n${(unique += 1)}`));
    }
    // The absolute bound, for the worst of them at the size of a long message: its own budget, one pause, and the
    // render of what the lexer made of it.
    const slow: string[] = [];
    for (const text of mounted) {
      const source = text.make(131_072);
      const took = cost(() => (MOUNTS['<Markdown> with paths and mentions'] as (text: string) => void)(`${source}\n\n${(unique += 1)}`), 250);
      if (took > parseBudgetMs(source.length) + PAUSE_MAX_MS + 250) slow.push(`${text.name}: ${took.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 600_000);

  it('a line of SPEC.md that is a heading and a run of spaces costs nothing to speak of (it held the column for 3.3 s)', () => {
    const line = `## a${' '.repeat(64_000)}b`;
    const started = performance.now();
    expect(specSections(`# Spec\n\n${line}\n\ntext`).map((section) => section.heading)).toEqual([null, `a${' '.repeat(64_000)}b`]);
    expect(specOpenQuestions(`## Open questions${' '.repeat(64_000)}#${' '.repeat(64_000)}x\n- one`)).toBe(0);
    expect(performance.now() - started).toBeLessThan(200);
    // And what they said before, they say now.
    expect(specSections('intro\n\n## One ##\na\n\n```\n## not a heading\n```\n##  Two  \nb').map((section) => section.heading)).toEqual([null, 'One', 'Two']);
    expect(specSections('## a ## b\n## c##\n## #\n##\n## ').map((section) => section.heading)).toEqual(['a ## b', 'c##', '', '']);
    expect(specOpenQuestions('## Open Questions ##\n1) Tax?\n* none\n+ N/A.\n2. Shipping?\n### Next\n- no')).toBe(2);
    expect(specOpenQuestions('#\topen questions\t\nNothing.\n\n')).toBe(0);
    expect(specOpenQuestions('####### open questions\n- a')).toBe(0);
    expect(specOpenQuestions('## Open questions\n-\n')).toBe(1);
  });
});

describe('the lexer’s budget is the budget of a text and of a mount (review R4-03)', () => {
  /** A paragraph that costs the lexer far more than its length: a web address whose closing marks it takes back one at a time. */
  const paragraph = (index: number): string => `${index} http://a.a${')'.repeat(15_950)}`;

  it('a SPEC.md of many sections has the one budget of its text, not one for each section', () => {
    // 62 sections of one such paragraph each (1 MiB): each section alone stays inside a budget of its own.
    const sections = Array.from({ length: 62 }, (_, index) => `## Section ${index}\n\n${paragraph(index)}\n`);
    const whole = sections.join('\n');
    const started = performance.now();
    const view = render(
      <MarkdownPieces text={whole} pieces={sections}>
        {(body, index) => <section key={index}>{body}</section>}
      </MarkdownPieces>,
    );
    const first = performance.now() - started;
    expect(first).toBeLessThan(parseBudgetMs(whole.length) + PAUSE_MAX_MS + 600);
    // The whole text is shown as written, every character of it, with ONE note; and it is remembered.
    expect(view.container.querySelectorAll('section')).toHaveLength(62);
    expect(view.container.querySelectorAll('.md-note')).toHaveLength(1);
    expect([...view.container.querySelectorAll('.md-plain')].map((node) => node.textContent).join('\n')).toBe(whole);
    view.unmount();
    let clock = 0;
    const again = performance.now();
    expect(lexMarkdownPieces(sections, whole, { now: () => (clock += 1) })[61]).toMatchObject([{ type: 'plain', reason: 'time', quiet: true }]);
    expect(clock).toBe(0);
    expect(performance.now() - again).toBeLessThan(100);
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

  it('every step is timed from the first, the last one too, and one text of such paragraphs is ended by its budget (0.9 s per mount before)', () => {
    // 13 paragraphs, 208 KiB: fewer steps than the lexer once left untimed.
    const text = Array.from({ length: 13 }, (_, index) => paragraph(index)).join('\n\n');
    const started = performance.now();
    const first = renderToStaticMarkup(<Markdown text={text} />);
    expect(performance.now() - started).toBeLessThan(parseBudgetMs(text.length) + PAUSE_MAX_MS + 250);
    expect(first).toContain('md-note');
    // Remembered by what it says, not by where it stands: another mount, other options, no parse.
    const again = performance.now();
    expect(renderToStaticMarkup(<Markdown text={text} breaks headingBase={4} />)).toContain('md-note');
    expect(performance.now() - again).toBeLessThan(60);
    // A clock of our own: the first step already counts, and so does the step after which nothing follows.
    let slowStart = 0;
    expect(lexMarkdown('A short text with *one* mark.', { now: () => (slowStart += 1_000) })).toMatchObject([{ type: 'plain', reason: 'time' }]);
    let calls = 0;
    const lastIsSlow = lexMarkdown('Another short text.', { now: () => ((calls += 1) < 6 ? calls : 5_000_000) });
    expect(lastIsSlow).toMatchObject([{ type: 'plain', reason: 'time' }]);
  });

  it('a column of texts that each stay inside their own budget does not hold the page for all of them together', () => {
    // Messages that each take a good part of their own budget and are formatted: a column of them cost their sum, at
    // every mount, when nothing bounded the mount. Enough of them for four times the page's share.
    const message = (index: number): string => `${'**a '.repeat(400)}\n\nmessage ${index}`;
    const one = Math.max(1, cost(() => void lexMarkdown(message(-1)), 0));
    expect(lexMarkdown(message(-2))[0]?.type).toBe('paragraph');
    const count = Math.ceil((URGENT_PARSE_MS * 4) / one);
    // What a person waits for is the first pass: the page's share and the one text that was being parsed when it
    // ran out. The texts after that wait.
    forgetParses();
    let waiting = 0;
    const started = performance.now();
    for (let index = 0; index < count; index += 1) if (waitsForTime(lexMarkdown(message(index), { urgent: true }))) waiting += 1;
    expect(performance.now() - started).toBeLessThan(URGENT_PARSE_MS + parseBudgetMs(message(0).length) + PAUSE_MAX_MS + 100);
    expect(waiting).toBeGreaterThan(count / 4);
    expect(waiting).toBeLessThan(count);
    // On the page nothing is lost by waiting: render() returns when React has nothing left to do, and by then every
    // text is formatted (the ones that waited were parsed in a transition).
    forgetParses();
    const view = render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Markdown key={index} text={message(index)} />
        ))}
      </>,
    );
    expect(view.container.querySelectorAll('.md-plain')).toHaveLength(0);
    expect(view.container.querySelectorAll('.md-body')).toHaveLength(count);
    expect(view.container.querySelectorAll('.md-body > p:last-child')[count - 1]?.textContent).toBe(`message ${count - 1}`);
  }, 120_000);

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
    // As written and without a note for the moment (static markup has no second pass) …
    expect(renderToStaticMarkup(<Markdown text="**bold** and more" />)).toBe('<div class="md-body"><p class="md-plain" data-why="later">**bold** and more</p></div>');
    // … and formatted once React has had its turn.
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
  'features/markdown/links.ts': 2,
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
