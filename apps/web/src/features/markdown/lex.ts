// The one place the app hands text to `marked`'s lexer, with the bounds a text from anyone needs. The text of a
// member or an agent is rendered in every member's browser, so a text must never be able to throw out of the render
// (a crashed column takes its composer and its open cards along) or to hold the page's only thread:
//
//   - a text longer than MARKDOWN_MAX_CHARS is not parsed at all;
//   - quotes and lists inside each other, and marks inside each other, deeper than MARKDOWN_MAX_DEPTH stop the parse
//     (2,000 ">" overflowed the stack);
//   - one run of inline text (a paragraph, a cell, a heading) longer than MARKDOWN_MAX_INLINE_CHARS stops it (before
//     its first step the lexer masks every link and escape of the run, each time copying the run);
//   - the parse has a time budget that grows with the text (64 KiB of "**a " took half a minute: every opening mark
//     scans the rest of its paragraph for a closing one), and a bound on its steps, which is a bound on the elements
//     the page would have to build (64 KiB of "- a" lines are sixteen thousand list items);
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
 * The first steps of a parse are not timed. The very first parse of a page compiles the lexer's expressions (12 ms for
 * forty steps on a fast machine, several times that on a busy one), and a short text must never be shown as written
 * because the machine was slow for a moment. Sixty-four steps cannot be made to cost much: see MARKDOWN_MAX_INLINE_CHARS.
 */
export const UNTIMED_STEPS = 64;
/** How many texts that ran out of time are remembered, so that mounting one again costs nothing. */
const REMEMBERED_MAX = 32;

export type PlainReason = 'size' | 'depth' | 'time' | 'error';

/** A text that is shown as it was written instead of being formatted. */
export interface PlainToken {
  readonly type: 'plain';
  readonly raw: string;
  readonly text: string;
  readonly reason: PlainReason;
}

export interface LexOptions {
  /** A single line break is a line break. */
  readonly breaks?: boolean;
  /** Milliseconds, for tests (default `performance.now`). */
  readonly now?: () => number;
}

class LimitReached extends Error {
  readonly reason: PlainReason;
  constructor(reason: PlainReason) {
    super(`markdown limit: ${reason}`);
    this.reason = reason;
  }
}

/** The steps and the time a parse has used, looked at once per round of the lexer's two loops. */
class Budget {
  private readonly now: () => number;
  private readonly budgetMs: number;
  private started: number;
  private steps = 0;
  private last: number;
  /** The longest single step so far: one pause of the machine (a collection, a suspended tab) is not the text's cost. */
  private longest = 0;

  constructor(now: () => number, budgetMs: number) {
    this.now = now;
    this.budgetMs = budgetMs;
    this.started = now();
    this.last = this.started;
  }

  tick(): void {
    this.steps += 1;
    if (this.steps > MARKDOWN_MAX_STEPS) throw new LimitReached('size');
    const at = this.now();
    if (this.steps <= UNTIMED_STEPS) {
      this.started = at;
      this.last = at;
      return;
    }
    const step = at - this.last;
    this.last = at;
    if (step > this.longest) this.longest = step;
    if (at - this.started - this.longest > this.budgetMs) throw new LimitReached('time');
  }
}

/**
 * marked's lexer, counting how deep it is: it lexes the content of a quote or a list item, and of a mark, by calling
 * itself. Each such call is a step as well (a list item with nothing in it runs no round of a loop).
 */
class BoundedLexer extends Lexer {
  private readonly budget: Budget;
  private blocks = 0;
  private inlines = 0;

  constructor(options: MarkedOptions, budget: Budget) {
    super(options);
    this.budget = budget;
  }

  override blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
  override blockTokens(src: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
  override blockTokens(src: string, tokens?: Token[] | TokensList, lastParagraphClipped?: boolean): Token[] | TokensList {
    this.budget.tick();
    if (this.blocks >= MARKDOWN_MAX_DEPTH) throw new LimitReached('depth');
    this.blocks += 1;
    try {
      return super.blockTokens(src, tokens as Token[], lastParagraphClipped);
    } finally {
      this.blocks -= 1;
    }
  }

  override inlineTokens(src: string, tokens?: Token[]): Token[] {
    this.budget.tick();
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

/** Texts whose parse ran out of time (the newest REMEMBERED_MAX of each line-break rule). */
const tooSlow = { soft: new Set<string>(), hard: new Set<string>() };

function plain(text: string, reason: PlainReason): Token[] {
  const token: PlainToken = { type: 'plain', raw: text, text, reason };
  return [token];
}

/** The tokens of `text`, or one `plain` token when it cannot be parsed within the bounds above. Never throws. */
export function lexMarkdown(text: string, options: LexOptions = {}): Token[] {
  const breaks = options.breaks === true;
  if (text.length > MARKDOWN_MAX_CHARS) return plain(text, 'size');
  const slow = breaks ? tooSlow.hard : tooSlow.soft;
  if (slow.has(text)) return plain(text, 'time');
  const budget = new Budget(options.now ?? (() => performance.now()), parseBudgetMs(text.length));
  const tokenizer = new Tokenizer();
  // An extension is asked first in every round of the block loop and of the inline loop: the place to look at the time.
  const tick = (): undefined => {
    budget.tick();
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
  try {
    return new BoundedLexer(marked, budget).lex(text);
  } catch (error) {
    if (!(error instanceof LimitReached)) return plain(text, 'error');
    if (error.reason === 'time') {
      if (slow.size >= REMEMBERED_MAX) slow.delete(slow.values().next().value as string);
      slow.add(text);
    }
    return plain(text, error.reason);
  }
}
