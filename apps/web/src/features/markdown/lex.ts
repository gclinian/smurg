// The one place the app hands text to `marked`'s lexer, with the bounds a text from anyone needs. The text of a
// member or an agent is rendered in every member's browser, so a text must never be able to throw out of the render
// (a crashed column takes its composer and its open cards along) or to hold the page's only thread:
//
//   - a text longer than MARKDOWN_MAX_CHARS is not parsed at all;
//   - quotes and lists inside each other, and marks inside each other, deeper than MARKDOWN_MAX_DEPTH stop the parse
//     (2,000 ">" overflowed the stack);
//   - one run of inline text (a paragraph, a cell, a heading) longer than MARKDOWN_MAX_INLINE_CHARS stops it (before
//     its first step the lexer masks every link and escape of the run, each time copying the run);
//   - the parse of ONE TEXT has a time budget that grows with the text (64 KiB of "**a " took half a minute: every
//     opening mark scans the rest of its paragraph for a closing one), and a bound on its steps, which is a bound on
//     the elements the page would have to build (64 KiB of "- a" lines are sixteen thousand list items). Every step
//     is timed, from the first. A text that is parsed in pieces (a SPEC.md cut at its headings) has the one budget of
//     the whole text: see lexMarkdownPieces;
//   - what ran out of time or steps is REMEMBERED by a hash of its characters and shown as written from then on,
//     wherever it is mounted: mounting it again costs the hash and nothing else. What is remembered is the PIECE the
//     budget ran out on (a message is one piece): in every text that holds it, that piece is shown as written and the
//     rest is formatted. A text shown in pieces that runs out a second time, without that piece, is over as a whole
//     and remembered as a whole;
//   - the PAGE has a share too: the parses that hold up what a person is doing (a column being mounted) take at most
//     URGENT_PARSE_MS and URGENT_PARSE_STEPS in any URGENT_WINDOW_MS (the steps are for texts that are parsed in no
//     time and are a hundred thousand elements to build). A text that comes after the share is spent is shown as
//     written for the moment (`later`) and whoever mounted it parses it again when the page has time (Markdown.tsx
//     hands it to idle.ts, which formats what waits a slice at a time, when the browser has nothing more urgent to
//     do). A column of four hundred messages that each stay just inside their own budget would otherwise hold the
//     page for as long as all of them together;
//   - whatever the lexer throws is caught.
//
// In each case the result is ONE token of type `plain`: the text as it was written, which render.tsx shows with a
// note. Nothing of a text is ever dropped: it is formatted, or it is shown as written.
//
// Reference definitions (`[1]: https://… "title"`) are kept as tokens too. marked takes them out of the token list,
// which hid a whole line of the source from the reader (and a suggestion is sent to the agent as it was written): here
// the definition still resolves `[text][1]`, and render.tsx prints its line.
import { Lexer, Tokenizer, type MarkedOptions, type Token, type TokensList } from 'marked';

/** A text beyond this many UTF-16 units is shown as written (a conversation's texts are far below it). */
export const MARKDOWN_MAX_CHARS = 1_048_576;
/** One paragraph, cell or heading beyond this many UTF-16 units is not a paragraph anyone wrote to be formatted. */
export const MARKDOWN_MAX_INLINE_CHARS = 16_384;
/** Quotes and lists inside each other, and marks inside each other: deeper than this is not a document. */
export const MARKDOWN_MAX_DEPTH = 32;
/** Steps of the lexer, about one per piece it finds. The largest document of this repository (370 KB) takes 15,000. */
export const MARKDOWN_MAX_STEPS = 50_000;
/** The parse of a text of `chars` units may take this long: about ten times what marked needs for ordinary text. */
export const parseBudgetMs = (chars: number): number => 40 + chars / 4_096;
/**
 * One step that stood still is one pause of the machine (a collection, a busy moment), not the text's cost: the
 * longest step of a parse is not counted, up to this long. A text cannot buy more than this with a step of its own.
 */
export const PAUSE_MAX_MS = 200;
/** The parses a person waits for take at most this long … */
export const URGENT_PARSE_MS = 200;
/** … and this many steps, what ONE text may have at most (an ordinary conversation of 400 answers has a tenth) … */
export const URGENT_PARSE_STEPS = MARKDOWN_MAX_STEPS;
/** … in any stretch of this length. */
export const URGENT_WINDOW_MS = 1_000;
/** How many pieces and texts that ran out of time or steps are remembered (a hash each). */
export const REMEMBERED_MAX = 1_024;

/**
 * Why a text is shown as written. `later`: only for the moment, because the page's share of parse time is spent or
 * the text's budget ran out on a piece before this one (the caller parses it again without `urgent`, when the page
 * has time); every other reason is final for that piece.
 */
export type PlainReason = 'size' | 'depth' | 'time' | 'error' | 'later';

/** A text that is shown as it was written instead of being formatted. */
export interface PlainToken {
  readonly type: 'plain';
  readonly raw: string;
  readonly text: string;
  readonly reason: PlainReason;
  /** One piece of a text that is shown as written as a whole: the note stands above the first piece only. */
  readonly quiet?: true;
}

export interface LexOptions {
  /** A single line break is a line break. */
  readonly breaks?: boolean;
  /**
   * The parse holds up what a person is doing (a mount): it takes from the page's share, and when that is spent the
   * result is a `later` token. Without it the caller has made sure the page can wait (its turn in idle.ts, a
   * stream's timer).
   */
  readonly urgent?: boolean;
  /** Milliseconds, for tests (default `performance.now`). */
  readonly now?: () => number;
}

class LimitReached extends Error {
  readonly reason: PlainReason;
  /** The budget of the whole text ended it (time, steps), not something in the piece that was being parsed. */
  readonly ofBudget: boolean;
  constructor(reason: PlainReason, ofBudget = false) {
    super(`markdown limit: ${reason}`);
    this.reason = reason;
    this.ofBudget = ofBudget;
  }
}

/** The steps and the time a text has used, looked at once per round of the lexer's two loops and once at the end. */
class Budget {
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly started: number;
  private steps = 0;
  private last: number;
  /** The longest single step so far. */
  private longest = 0;

  constructor(now: () => number, budgetMs: number) {
    this.now = now;
    this.budgetMs = budgetMs;
    this.started = now();
    this.last = this.started;
  }

  tick(): void {
    this.steps += 1;
    if (this.steps > MARKDOWN_MAX_STEPS) throw new LimitReached('size', true);
    this.look();
  }

  /** After the last step (a parse whose one long step is its last would otherwise never be looked at). */
  end(): void {
    this.look();
  }

  /** Everything since the budget began, pauses included: what the page was held for. */
  elapsed(): number {
    return this.last - this.started;
  }

  /** The steps so far: about what the page will have to build of it. */
  taken(): number {
    return this.steps;
  }

  private look(): void {
    const at = this.now();
    const step = at - this.last;
    this.last = at;
    if (step > this.longest) this.longest = step;
    if (at - this.started - Math.min(this.longest, PAUSE_MAX_MS) > this.budgetMs) throw new LimitReached('time', true);
  }
}

/**
 * marked's lexer, counting how deep it is: it lexes the content of a quote or a list item, and of a mark, by calling
 * itself. Each such call is a step as well (a list item with nothing in it runs no round of a loop).
 */
class BoundedLexer extends Lexer {
  private readonly budget: Budget | null;
  private blocks = 0;
  private inlines = 0;

  constructor(options: MarkedOptions, budget: Budget | null) {
    super(options);
    this.budget = budget;
  }

  override blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
  override blockTokens(src: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
  override blockTokens(src: string, tokens?: Token[] | TokensList, lastParagraphClipped?: boolean): Token[] | TokensList {
    this.budget?.tick();
    if (this.blocks >= MARKDOWN_MAX_DEPTH) throw new LimitReached('depth');
    this.blocks += 1;
    try {
      return super.blockTokens(src, tokens as Token[], lastParagraphClipped);
    } finally {
      this.blocks -= 1;
    }
  }

  override inlineTokens(src: string, tokens?: Token[]): Token[] {
    this.budget?.tick();
    if (src.length > MARKDOWN_MAX_INLINE_CHARS) throw new LimitReached('size');
    if (this.inlines >= MARKDOWN_MAX_DEPTH) throw new LimitReached('depth');
    this.inlines += 1;
    try {
      return super.inlineTokens(src, tokens);
    } finally {
      this.inlines -= 1;
    }
  }
}

/** One run of the lexer over `text`; throws LimitReached. `budget` null: nothing is counted (the warm-up). */
function run(text: string, breaks: boolean, budget: Budget | null): Token[] {
  const tokenizer = new Tokenizer();
  // An extension is asked first in every round of the block loop and of the inline loop: the place to look at the time.
  const tick = (): undefined => {
    budget?.tick();
    return undefined;
  };
  const marked: MarkedOptions = {
    gfm: true,
    breaks,
    tokenizer,
    extensions: {
      renderers: {},
      childTokens: {},
      inline: [tick],
      block: [
        tick,
        // A reference definition, kept in the token list. The lexer's own rule comes after this one and would drop
        // it; like that rule, this one leaves a definition-looking line to the paragraph it continues.
        function definition(src, tokens) {
          const before = tokens.at(-1);
          if (before !== undefined && (before.type === 'paragraph' || before.type === 'text')) return undefined;
          const token = tokenizer.def(src);
          if (token === undefined) return undefined;
          this.lexer.tokens.links[token.tag] ??= { href: token.href, title: token.title };
          return token;
        },
      ],
    },
  };
  const tokens = new BoundedLexer(marked, budget).lex(text);
  budget?.end();
  return tokens;
}

// ---- the first parse of a page
//
// The lexer's expressions are compiled the first time each is used (12 ms for forty steps on a fast machine, several
// times that on a busy one). That is the page's cost, not the cost of whichever text happens to be first: a short
// text must never be shown as written because it came first. So the first call parses a text of our own, which uses
// every kind of block and mark once, outside any budget.

const WARM_UP = [
  '# A heading',
  '',
  'A paragraph with *one*, **two**, ~~three~~, `code`, a [link](https://example.com "title"), an image ![alt](https://example.com/a.png),',
  'https://example.com/path, www.example.com, <https://example.com>, a@example.com, &amp; \\* and a [reference][1].  ',
  'Its second line.',
  '',
  'Setext',
  '------',
  '',
  '- one',
  '  - [x] two',
  '',
  '1. first',
  '',
  '> quoted',
  '',
  '```ts',
  'code',
  '```',
  '',
  '    indented',
  '',
  '| a | b |',
  '|---|:-:|',
  '| 1 | 2 |',
  '',
  '<div>html</div>',
  '',
  '<!-- a comment -->',
  '',
  '---',
  '',
  '[1]: https://example.com "title"',
  '',
].join('\n');

let warm = false;

function warmUp(): void {
  if (warm) return;
  warm = true;
  for (const breaks of [false, true]) {
    try {
      run(WARM_UP, breaks, null);
    } catch {
      // Nothing depends on it.
    }
  }
}

// ---- texts that are remembered

/** Two sums over the characters of a text and its length: what a text is remembered by. Linear, a millisecond per MiB. */
function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    a = Math.imul(a ^ unit, 0x01000193);
    b = (Math.imul(b, 33) + unit) | 0;
  }
  return `${text.length}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/** Texts by a hash of their characters, with what is known of each: the newest REMEMBERED_MAX of them. */
class Remembered<Value> {
  private readonly values = new Map<string, Value>();
  /** How many remembered texts have each length: a text of another length is not hashed to be looked up. */
  private readonly lengths = new Map<number, number>();

  get(text: string): Value | undefined {
    if (!this.lengths.has(text.length)) return undefined;
    return this.values.get(hashOf(text));
  }

  set(text: string, value: Value): void {
    const key = hashOf(text);
    if (this.values.has(key)) return;
    if (this.values.size >= REMEMBERED_MAX) {
      const oldest = this.values.keys().next().value as string;
      this.values.delete(oldest);
      const length = Number(oldest.slice(0, oldest.indexOf('.')));
      const left = (this.lengths.get(length) ?? 1) - 1;
      if (left <= 0) this.lengths.delete(length);
      else this.lengths.set(length, left);
    }
    this.values.set(key, value);
    this.lengths.set(text.length, (this.lengths.get(text.length) ?? 0) + 1);
  }

  clear(): void {
    this.values.clear();
    this.lengths.clear();
  }
}

/**
 * What is shown as written because a budget ran out, with the reason: the piece it ran out on (a message is its one
 * piece), and a text in pieces that ran out twice.
 */
const over = new Remembered<PlainReason>();
/** The texts in pieces that ran out once: what waited behind that piece is given the budget once more. */
const ranOutOnce = new Remembered<true>();

/** Whether `text` is remembered as over its budget: shown as written, as a whole. */
export function ranOut(text: string): boolean {
  return over.get(text) !== undefined;
}

// ---- the page's share

const share = { windowStart: Number.NEGATIVE_INFINITY, spent: 0, steps: 0 };

/** Whether an urgent parse may start at `at`. */
function shareLeft(at: number): boolean {
  if (at - share.windowStart >= URGENT_WINDOW_MS || at < share.windowStart) {
    share.windowStart = at;
    share.spent = 0;
    share.steps = 0;
  }
  return share.spent < URGENT_PARSE_MS && share.steps < URGENT_PARSE_STEPS;
}

/** As after a reload of the page: nothing is remembered and the page's share is whole. For tests. */
export function forgetParses(): void {
  over.clear();
  ranOutOnce.clear();
  share.windowStart = Number.NEGATIVE_INFINITY;
  share.spent = 0;
  share.steps = 0;
}

// ---- the two ways in

function plain(text: string, reason: PlainReason, quiet = false): Token[] {
  const token: PlainToken = quiet ? { type: 'plain', raw: text, text, reason, quiet: true } : { type: 'plain', raw: text, text, reason };
  return [token];
}

/** Whether `tokens` are a text that waits for the page to have time (see LexOptions.urgent). */
export function waitsForTime(tokens: readonly Token[]): boolean {
  return tokens.length > 0 && tokens.every((token) => token.type === 'plain' && (token as unknown as PlainToken).reason === 'later');
}

/**
 * The tokens of each of `pieces`, which together are the one text `whole` (a SPEC.md cut at its `##` headings so that
 * each section can be asked about; a message is its own one piece): ONE budget of time and steps for all of them,
 * the one of `whole`.
 *
 * A piece that is too deep or holds too long a paragraph is shown as written by itself. When the BUDGET runs out, the
 * piece it ran out on is shown as written and remembered: that piece, and nothing else of the text. Every text that
 * holds it shows it as written at the cost of its hash and formats the rest, and a text that no longer holds it is
 * formatted whole. (Remembering the whole text for it showed five ordinary sections as written because a sixty
 * section text they once stood in had been too long: review R4-03, fourth round.)
 *
 * The pieces behind the one it ran out on are not parsed in this call (one step cannot be interrupted, so a budget
 * that is spent is spent): they are `later`, and the caller hands them over again when the page has time, with the
 * budget once more. A text that runs out a SECOND time is over as a whole: every piece handed over is shown as
 * written (the note above the first), the text is remembered, and from then on it costs its hash. So a text costs
 * two budgets at most, whatever it holds, and every budget that is spent leaves one more piece remembered.
 *
 * A caller that knows some pieces from before hands over the others only (Markdown.tsx). Never throws.
 */
export function lexMarkdownPieces(pieces: readonly string[], whole: string, options: LexOptions = {}): Token[][] {
  const breaks = options.breaks === true;
  const all = (reason: PlainReason): Token[][] => pieces.map((piece, index) => plain(piece, reason, index > 0));
  if (whole.length > MARKDOWN_MAX_CHARS) return all('size');
  const known = over.get(whole);
  if (known !== undefined) return all(known);
  const now = options.now ?? (() => performance.now());
  if (options.urgent === true && !shareLeft(now())) return all('later');
  warmUp();
  const budget = new Budget(now, parseBudgetMs(whole.length));
  const out: Token[][] = [];
  let ended: PlainReason | null = null;
  for (const piece of pieces) {
    if (ended !== null) {
      out.push(plain(piece, 'later'));
      continue;
    }
    const before = piece === whole ? undefined : over.get(piece);
    if (before !== undefined) {
      out.push(plain(piece, before));
      continue;
    }
    try {
      out.push(run(piece, breaks, budget));
    } catch (error) {
      if (!(error instanceof LimitReached)) out.push(plain(piece, 'error'));
      else if (!error.ofBudget) out.push(plain(piece, error.reason));
      else {
        ended = error.reason;
        over.set(piece, ended);
        out.push(plain(piece, ended));
      }
    }
  }
  if (options.urgent === true) {
    share.spent += budget.elapsed();
    share.steps += budget.taken();
  }
  // The text did not run out, or it is its own one piece (remembered above).
  if (ended === null || (pieces.length === 1 && pieces[0] === whole)) return out;
  if (ranOutOnce.get(whole) === undefined) {
    ranOutOnce.set(whole, true);
    return out;
  }
  over.set(whole, ended);
  return all(ended);
}

/** The tokens of `text`, or one `plain` token when it cannot be parsed within the bounds above. Never throws. */
export function lexMarkdown(text: string, options: LexOptions = {}): Token[] {
  return lexMarkdownPieces([text], text, options)[0] as Token[];
}
