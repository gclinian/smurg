// The Markdown renderer of the app (DESIGN §5.5): agent text and people's messages in a conversation, the spec's
// Read view, a report's sections. The tokens come from `marked`'s lexer; the elements are built here (render.tsx).
//
//   <Markdown text={block.text} paths={paths} />                         // parsed once per text
//   <StreamingMarkdown read={() => store.streamText(id, blockId)} subscribe={(cb) => store.onStream(…)} />
//
//   <PlainText text={suggestion.text} mentions={names} />                // every character, nothing interpreted
//
// A streaming text is parsed again at most every STREAM_PARSE_MS, and only after its stable cut (stream.ts); what
// arrives between two parses is appended to a text node of our own, so React state does not change per delta.
//
// The lexer runs inside bounds (lex.ts): a text that is too long, too deep or too slow to parse is shown as it was
// written, and nothing a text holds can throw out of a render. A mount takes from the page's share of parse time; a
// text that comes after the share is spent is shown as written for the moment and formatted when the page is idle,
// one slice of texts at a time (idle.ts, usePieces below).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { Token } from 'marked';
import { cx } from '../../ui/cx.ts';
import { formatWhenIdle } from './idle.ts';
import { lexMarkdown, lexMarkdownPieces, ranOut, waitsForTime } from './lex.ts';
import type { MarkdownPaths, PathTarget } from './paths.ts';
import { MdBlock, markMentions, type RenderContext } from './render.tsx';
import { stableLength } from './stream.ts';
import './markdown.css';

/** A streaming block is parsed again at most this often. */
export const STREAM_PARSE_MS = 200;
/**
 * How many different paths of ONE text are looked up. A text is on every reader's screen, and every lookup is a
 * request of that reader to the host: a text that lists a hundred names must not become a hundred requests in the
 * name of whoever happens to read it. The paths after these stay text.
 */
export const MAX_PATH_LOOKUPS = 32;

export interface MarkdownOptions {
  /** File paths in the text become buttons that open the file. */
  readonly paths?: MarkdownPaths | undefined;
  /** Display names that are marked when written as `@name`. */
  readonly mentions?: readonly string[] | undefined;
  /** The level of a `#` heading: 3 inside a column (its title is the h2), 4 inside a card (default 3). */
  readonly headingBase?: number;
  /** A single line break is a line break (what a person typed with Shift+Enter); default: Markdown's soft break. */
  readonly breaks?: boolean;
  readonly className?: string;
}

export interface MarkdownProps extends MarkdownOptions {
  readonly text: string;
}

export function parseMarkdown(text: string, breaks = false): Token[] {
  return lexMarkdown(text, { breaks });
}

/** The caller's adapter for one text: the first MAX_PATH_LOOKUPS different paths are asked about, each once. */
function lookupsOfOneText(paths: MarkdownPaths): MarkdownPaths {
  const asked = new Map<string, Promise<PathTarget | null>>();
  return {
    find: (text) => paths.find(text),
    resolve(match) {
      let answer = asked.get(match.text);
      if (answer === undefined) {
        if (asked.size >= MAX_PATH_LOOKUPS) return Promise.resolve(null);
        answer = paths.resolve(match);
        asked.set(match.text, answer);
      }
      return answer;
    },
  };
}

function useRenderContext(options: MarkdownOptions): RenderContext {
  const { headingBase = 3, paths, mentions } = options;
  const limited = useMemo(() => (paths === undefined ? undefined : lookupsOfOneText(paths)), [paths]);
  return useMemo(() => ({ headingBase, paths: limited, mentions }), [headingBase, limited, mentions]);
}

export interface PlainTextProps {
  readonly text: string;
  /** Display names that are marked when written as `@name`. */
  readonly mentions?: readonly string[] | undefined;
  readonly className?: string;
}

/**
 * A text exactly as it was written: every character and every line break, nothing interpreted, nothing left out.
 * For text a person is asked to pass on to an agent (a suggestion): what is on the card IS what is sent.
 */
export function PlainText({ text, mentions, className }: PlainTextProps) {
  return <div className={cx('md-plain', className)}>{mentions === undefined ? text : markMentions(text, mentions)}</div>;
}

/** Whether `tokens` are a piece shown as written: for the moment, for a budget, or for what the piece itself is. */
const shownAsWritten = (tokens: readonly Token[]): boolean => tokens.length === 1 && (tokens[0] as Token).type === 'plain';

/**
 * The tokens of the pieces of one text (lexMarkdownPieces: one budget, one memory). Parsed while rendering, as part of
 * the mount. Pieces that wait (the page's share of parse time is spent, or the text's budget ran out on a piece
 * before them) are shown as written and ask the page's idle queue for a turn (idle.ts): in its turn this component
 * renders once more, synchronously and by itself, and parses what waits outside the page's share. `shown` is the
 * element the text is drawn in (for "on screen first"), null for a text in pieces.
 *
 * A piece that was FORMATTED at the last render keeps its tokens: it is not parsed again, and its blocks are not
 * drawn again (render.tsx MdBlock goes by the token). A keystroke in a long SPEC.md changes the whole text and ONE
 * of its sections. A piece shown as written is asked about again whenever the text changes: whether it is formatted
 * can depend on the text it stands in (lex.ts). A text that is over its budget as a whole keeps nothing.
 */
function usePieces(pieces: readonly string[], whole: string, breaks: boolean, shown: RefObject<Element | null> | null): readonly (readonly Token[])[] {
  /** The turn the idle queue gave this component: the text it parses outside the page's share. A new object each turn. */
  const [turn, setTurn] = useState<{ readonly whole: string } | null>(null);
  /** The pieces of the last render that were formatted, with what they were parsed into. */
  const kept = useRef<{ readonly breaks: boolean; readonly tokens: ReadonlyMap<string, readonly Token[]> } | null>(null);
  const tokens = useMemo(() => {
    const before = kept.current !== null && kept.current.breaks === breaks ? kept.current.tokens : null;
    const fresh = [...new Set(pieces.filter((piece) => before?.has(piece) !== true))];
    const lexed = fresh.length === 0 ? [] : lexMarkdownPieces(fresh, whole, { breaks, urgent: turn?.whole !== whole });
    const now = new Map<string, readonly Token[]>(fresh.map((piece, index) => [piece, lexed[index] as Token[]]));
    // Over its budget as a whole, since this parse or an earlier one: every piece is shown as written, the kept ones too.
    const all = ranOut(whole) ? lexMarkdownPieces(pieces, whole, { breaks }) : pieces.map((piece) => before?.get(piece) ?? (now.get(piece) as readonly Token[]));
    kept.current = { breaks, tokens: new Map(pieces.flatMap((piece, index) => (shownAsWritten(all[index] as readonly Token[]) ? [] : [[piece, all[index] as readonly Token[]] as const]))) };
    return all;
  }, [pieces, whole, breaks, turn]);
  const waits = tokens.some((piece) => waitsForTime(piece));
  useEffect(() => {
    if (!waits) return undefined;
    // `turn` is a dependency: a text whose budget ran out in its turn has pieces that wait again, and asks again.
    return formatWhenIdle(shown?.current ?? null, () => flushSync(() => setTurn({ whole })));
  }, [waits, whole, turn, shown]);
  return tokens;
}

function Blocks({ tokens, context, className, ref }: { tokens: readonly Token[]; context: RenderContext; className: string | undefined; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className={cx('md-body', className)}>
      {tokens.map((token, index) => (
        <MdBlock key={index} token={token} context={context} />
      ))}
    </div>
  );
}

export function Markdown(props: MarkdownProps) {
  const { text, breaks = false, className } = props;
  const context = useRenderContext(props);
  const pieces = useMemo(() => [text], [text]);
  const shown = useRef<HTMLDivElement>(null);
  const tokens = usePieces(pieces, text, breaks, shown);
  return <Blocks ref={shown} tokens={tokens[0] ?? []} context={context} className={className} />;
}

export interface MarkdownPiecesProps extends MarkdownOptions {
  /** The whole text. */
  readonly text: string;
  /** The same text cut into pieces, in order (the caller's cut: a SPEC.md at its `##` headings). */
  readonly pieces: readonly string[];
  /** What stands around the rendered piece `index` (its key included). */
  readonly children: (body: ReactNode, index: number) => ReactNode;
}

/**
 * One text shown in pieces, each with something of the caller's around it. It is still ONE text to the bounds of
 * lex.ts: the pieces share the text's time budget and its memory, however many they are.
 */
export function MarkdownPieces(props: MarkdownPiecesProps) {
  const { text, pieces, breaks = false, className, children } = props;
  const context = useRenderContext(props);
  const tokens = usePieces(pieces, text, breaks, null);
  return <>{tokens.map((piece, index) => children(<Blocks tokens={piece} context={context} className={className} />, index))}</>;
}

export interface StreamingMarkdownProps extends MarkdownOptions {
  /** The whole text of the block right now. */
  read(): string;
  /** Calls back whenever the text changed; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Timers, for tests. */
  readonly timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
}

interface Parsed {
  readonly text: string;
  readonly stableText: string;
  readonly stable: readonly Token[];
  readonly tail: readonly Token[];
}

const EMPTY: Parsed = { text: '', stableText: '', stable: [], tail: [] };

/** Parses `text`, reusing the tokens of the stable part of `previous` when `text` continues it. */
export function parseStreaming(text: string, previous: Parsed, breaks = false): Parsed {
  if (text === previous.text) return previous;
  const base = text.startsWith(previous.stableText) ? previous : EMPTY;
  const cut = stableLength(text, base.stableText.length);
  const stable = cut > base.stableText.length ? [...base.stable, ...parseMarkdown(text.slice(base.stableText.length, cut), breaks)] : base.stable;
  return { text, stableText: text.slice(0, cut), stable, tail: parseMarkdown(text.slice(cut), breaks) };
}

const realTimers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: (): number => performance.now(),
};

/** The source of a fenced code block whose closing fence was written. */
const CLOSED_FENCE = /\n {0,3}(?:`{3,}|~{3,})[ \t]*\n*$/;

/** Elements the pending text is appended inside (the last one of the rendered blocks, as deep as it goes). */
const DESCEND = new Set(['UL', 'OL', 'LI', 'BLOCKQUOTE', 'P', 'PRE', 'DIV', 'H2', 'H3', 'H4', 'H5', 'H6']);

function lastTextContainer(root: HTMLElement): HTMLElement {
  let node: HTMLElement = root;
  for (;;) {
    const last = node.lastElementChild;
    if (!(last instanceof HTMLElement)) return node;
    if (last.tagName === 'CODE' && node.tagName === 'PRE') return last;
    if (!DESCEND.has(last.tagName)) return node;
    node = last;
  }
}

export function StreamingMarkdown(props: StreamingMarkdownProps) {
  const { read, subscribe, breaks = false, className, timers = realTimers } = props;
  const context = useRenderContext(props);
  const [parsed, setParsed] = useState<Parsed>(() => parseStreaming(read(), EMPTY, breaks));
  const rootRef = useRef<HTMLDivElement>(null);
  /** Text that arrived since the last parse, shown at once in a text node React does not own. */
  const pendingRef = useRef<Text | null>(null);
  const latest = useRef({ read, breaks, parsed });
  latest.current = { read, breaks, parsed };

  /** Puts what the blocks do not show yet at the end of the last block (or takes the node out when there is none). */
  const showPending = (): void => {
    const pending = pendingRef.current;
    const root = rootRef.current;
    if (!pending || !root) return;
    const shown = latest.current.parsed.text;
    const text = latest.current.read();
    const rest = text.startsWith(shown) ? text.slice(shown.length) : '';
    if (rest === '') {
      pending.remove();
      pending.data = '';
      return;
    }
    let container = lastTextContainer(root);
    let data = rest;
    if (container.tagName === 'CODE') {
      const parsedNow = latest.current.parsed;
      const last = parsedNow.tail.at(-1) ?? parsedNow.stable.at(-1);
      // A fence that was closed takes no more text: what follows it is shown after the block until the next parse.
      if (last !== undefined && CLOSED_FENCE.test(last.raw)) container = root;
      // The lexer drops the line break that ends the last line of an open code block: the next line needs it back.
      else if (shown.endsWith('\n')) data = `\n${rest}`;
    }
    pending.data = data;
    if (pending.parentNode !== container || pending.nextSibling !== null) container.append(pending);
  };
  const showPendingRef = useRef(showPending);
  showPendingRef.current = showPending;

  useEffect(() => {
    const pending = document.createTextNode('');
    pendingRef.current = pending;
    let lastParse = timers.now();
    let timer: unknown = null;
    const parseNow = (): void => {
      timer = null;
      lastParse = timers.now();
      // Our node leaves the tree BEFORE React commits the new blocks: React never meets a child it did not make.
      pending.remove();
      pending.data = '';
      setParsed((previous) => parseStreaming(latest.current.read(), previous, latest.current.breaks));
    };
    const onText = (): void => {
      const wait = lastParse + STREAM_PARSE_MS - timers.now();
      if (wait <= 0 && timer === null) {
        parseNow();
        return;
      }
      showPendingRef.current();
      timer ??= timers.setTimeout(parseNow, Math.max(0, wait));
    };
    const off = subscribe(onText);
    // What arrived between the first render and this effect.
    if (latest.current.read() !== latest.current.parsed.text) onText();
    return () => {
      off();
      if (timer !== null) timers.clearTimeout(timer);
      pending.remove();
      pendingRef.current = null;
    };
  }, [subscribe, timers]);

  // After React committed new blocks: text that arrived while the commit was on its way goes behind them again.
  useLayoutEffect(() => {
    showPendingRef.current();
  }, [parsed]);

  return (
    <div ref={rootRef} className={cx('md-body', 'md-body--streaming', className)}>
      {parsed.stable.map((token, index) => (
        <MdBlock key={index} token={token} context={context} />
      ))}
      {parsed.tail.map((token, index) => (
        <MdBlock key={`t${index}`} token={token} context={context} />
      ))}
    </div>
  );
}
