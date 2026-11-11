// marked's tokens → React elements (DESIGN §5.5). The rules, each with a test:
//   - no HTML string is ever injected: raw HTML in the text is shown as the text it is;
//   - a link leads to http, https or mailto only (links.ts), opens in a new tab with rel="noopener noreferrer" and
//     shows its address on hover and on keyboard focus; anything else is shown as it was written;
//   - an image is NEVER loaded (a remote image in agent text would make every viewer's browser contact a third
//     party): it is a link with its alt text;
//   - a code block is plain monospace text;
//   - a path that the caller's adapter resolves is a button that opens the file (paths.ts);
//   - a member named with "@" is marked when the caller says who can be named;
//   - a wiki link `[[Name]]` (when the caller gives `wikiLinks`: a sticky note, DESIGN 0.8.0 D7.5) is an in-app link
//     to that note's page, shown as the name (its brackets are its markup, as a link's are); never inside a code span
//     or a link's words; a link to a note that is not written yet looks different AND says so in words;
//   - NOTHING OF THE TEXT IS HIDDEN. What Markdown keeps out of sight is put on the page: a reference definition is
//     printed as its line, a destination that is not a link stays in the text with its brackets, a title follows its
//     link, the whole line after a code fence stands above the code, a link without text shows its address, and a
//     link or an image whose words name another place than it leads to shows where it leads. (The destination of an
//     ordinary link is the one thing behind a hover or the keyboard focus, as §5.5 has it.) A text that cannot be
//     formatted within the lexer's bounds (lex.ts) is shown as it was written, with a note;
//   - the lexer has a time budget and a render has none, so whatever looks at a piece of text here costs in proportion
//     to its length: single passes, no expression that is tried again from every character of a long run.
import { Fragment, memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';
import { gapAfter } from '../../lib/format.ts';
import { trimEndOf } from '../../lib/trim.ts';
import { decodeEntities } from './entities.ts';
import type { PlainToken } from './lex.ts';
import { namesAnotherPlace, safeHref } from './links.ts';
import type { MarkdownPaths, PathMatch, PathTarget } from './paths.ts';
import { t } from './strings.ts';

/** A wiki link of one run of text: `[start, end)` in UTF-16 units of that run (the brackets included), and the name. */
export interface WikiLinkMatch {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/** The caller's sticky notes (DESIGN 0.8.0 D7.5): which `[[Name]]` are links, and where each one leads. */
export interface MarkdownWikiLinks {
  /** The wiki links of a run of plain text, in order and not overlapping. Synchronous and cheap: it runs while rendering. */
  find(text: string): readonly WikiLinkMatch[];
  /** Whether that sticky note is written (one that is not is drawn apart, and says so in words). */
  exists(name: string): boolean;
  /** The in-app address of that sticky note's page. */
  href(name: string): string;
  /** A plain click (no modifier key): go there without loading the page again. Any other click is the link's. */
  open(name: string): void;
}

export interface RenderContext {
  /** The heading level a `#` gets (2–6); deeper headings follow and stop at 6. */
  readonly headingBase: number;
  readonly paths: MarkdownPaths | undefined;
  /** Display names that are marked when written as `@name`. */
  readonly mentions: readonly string[] | undefined;
  /** `[[Name]]` links to sticky notes; undefined: they are text. */
  readonly wikiLinks: MarkdownWikiLinks | undefined;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mentionPatterns = new WeakMap<readonly string[], RegExp | null>();

function mentionPattern(names: readonly string[]): RegExp | null {
  let pattern = mentionPatterns.get(names);
  if (pattern === undefined) {
    const usable = [...new Set(names.filter((name) => name.trim() !== ''))].sort((a, b) => b.length - a.length);
    pattern = usable.length === 0 ? null : new RegExp(`@(?:${usable.map(escapeRegExp).join('|')})`, 'gu');
    mentionPatterns.set(names, pattern);
  }
  return pattern;
}

/** The ranges of `text` that name a member with "@", in order. */
export function findMentions(text: string, names: readonly string[]): { start: number; end: number }[] {
  const pattern = mentionPattern(names);
  if (pattern === null || !text.includes('@')) return [];
  const found: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) found.push({ start: match.index, end: match.index + match[0].length });
  return found;
}

// ---- path links

/** Elements waiting to be looked up when they come on screen (one observer for the page). */
let observer: IntersectionObserver | null = null;
const waiting = new WeakMap<Element, () => void>();

function whenOnScreen(node: Element, run: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    run();
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const callback = waiting.get(entry.target);
      waiting.delete(entry.target);
      observer?.unobserve(entry.target);
      callback?.();
    }
  });
  waiting.set(node, run);
  observer.observe(node);
  return () => {
    waiting.delete(node);
    observer?.unobserve(node);
  };
}

function PathLink({ match, paths }: { match: PathMatch; paths: MarkdownPaths }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<PathTarget | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    // Only what is on screen is asked about: a long conversation holds hundreds of paths.
    const stop = whenOnScreen(node, () => {
      paths.resolve(match).then(
        (found) => {
          if (!cancelled) setTarget(found);
        },
        () => {},
      );
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [paths, match]);
  if (target === null) return <span ref={ref}>{match.text}</span>;
  return (
    <button type="button" className="md-path" title={t('path.open', { path: target.label })} onClick={() => target.open()}>
      {match.text}
    </button>
  );
}

/** A link to a sticky note's page. A note that is not written yet: another look, and words for whoever cannot see it. */
function WikiLink({ name, links }: { name: string; links: MarkdownWikiLinks }) {
  const exists = links.exists(name);
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    links.open(name);
  };
  return (
    <a className={exists ? 'md-wiki' : 'md-wiki md-wiki--missing'} href={links.href(name)} title={t('wiki.open', { name })} onClick={onClick}>
      {name}
      {exists ? null : <span className="ui-visually-hidden">{`${gapAfter(name)}${t('wiki.missing')}`}</span>}
    </a>
  );
}

/** `text` with the members it names marked, and nothing else changed. */
export function markMentions(text: string, names: readonly string[]): ReactNode {
  const mentions = findMentions(text, names);
  if (mentions.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const mention of mentions) {
    if (mention.start > at) out.push(text.slice(at, mention.start));
    out.push(
      <span key={mention.start} className="md-mention">
        {text.slice(mention.start, mention.end)}
      </span>,
    );
    at = mention.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

type Mark = { readonly start: number; readonly end: number; readonly node: (index: number) => ReactNode };

/**
 * `taken` and those of `more` that touch none of them, in the order of the text. Both lists are in that order and
 * neither overlaps itself: one walk finds what touches what (a look at every mark for every other would cost the
 * product of the two in a text made of both).
 */
function withMarks(taken: readonly Mark[], more: readonly Mark[]): Mark[] {
  const out: Mark[] = [];
  let next = 0;
  for (const mark of more) {
    while (next < taken.length && (taken[next] as Mark).end <= mark.start) out.push(taken[next++] as Mark);
    if (next < taken.length && (taken[next] as Mark).start < mark.end) continue;
    out.push(mark);
  }
  while (next < taken.length) out.push(taken[next++] as Mark);
  return out;
}

/** A run of plain text with its wiki links, then its mentions, then its paths marked (a later kind never inside an earlier one). */
function textRun(text: string, context: RenderContext, key: string): ReactNode {
  if (text === '') return null;
  let marks: Mark[] = [];
  const wikiLinks = context.wikiLinks;
  if (wikiLinks !== undefined) {
    marks = wikiLinks.find(text).map((link) => ({ start: link.start, end: link.end, node: (index) => <WikiLink key={`${key}.${index}.w`} name={link.name} links={wikiLinks} /> }));
  }
  if (context.mentions !== undefined) {
    const mentions = findMentions(text, context.mentions).map((mention) => ({ ...mention, node: (index: number) => <span key={`${key}.${index}`} className="md-mention">{text.slice(mention.start, mention.end)}</span> }));
    marks = withMarks(marks, mentions);
  }
  const paths = context.paths;
  if (paths !== undefined) {
    marks = withMarks(
      marks,
      paths.find(text).map((match) => ({ start: match.start, end: match.end, node: (index: number) => <PathLink key={`${key}.${index}.${match.text}`} match={match} paths={paths} /> })),
    );
  }
  if (marks.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach((mark, index) => {
    if (mark.start < at) return;
    if (mark.start > at) out.push(text.slice(at, mark.start));
    out.push(mark.node(index));
    at = mark.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// ---- inline

function ExternalLink({ href, children, image }: { href: string; children: ReactNode; image?: boolean }) {
  return (
    <a
      className={image ? 'md-link md-link--image' : 'md-link'}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // The address, for a pointer (the native tooltip) and for the keyboard (markdown.css shows data-address).
      title={image ? `${href}\n${t('image.notLoaded')}` : t('link.newTab', { address: href })}
      data-address={href}
    >
      {children}
    </a>
  );
}

/** What a reader sees of a link's inline tokens, as one string. */
function shownText(tokens: readonly Token[] | undefined): string {
  let out = '';
  for (const token of tokens ?? []) {
    const one = token as Tokens.Generic;
    if (one.type === 'br') out += '\n';
    else if (Array.isArray(one.tokens) && one.tokens.length > 0) out += shownText(one.tokens);
    else if (typeof one.text === 'string') out += decodeEntities(one.text);
    else if (typeof one.raw === 'string') out += one.raw;
  }
  return out;
}

const holdsImage = (tokens: readonly Token[] | undefined): boolean =>
  (tokens ?? []).some((token) => token.type === 'image' || holdsImage((token as Tokens.Generic).tokens));

/** The title of a link or an image, after it: Markdown would keep it for a tooltip, where no reader looks for text. */
function titleAfter(title: string | null | undefined, key: string): ReactNode {
  if (typeof title !== 'string' || title === '') return null;
  return <span key={`${key}.title`} className="md-link__title">{` "${decodeEntities(title)}"`}</span>;
}

function renderInline(tokens: readonly Token[] | undefined, context: RenderContext, prefix: string): ReactNode[] {
  if (tokens === undefined) return [];
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const key = `${prefix}${index}`;
    const one = token as Tokens.Generic;
    switch (one.type) {
      case 'text': {
        const text = one as Tokens.Text;
        if (text.tokens !== undefined && text.tokens.length > 0) out.push(...renderInline(text.tokens, context, `${key}.`));
        else out.push(<InlineText key={key} text={decodeEntities(text.text)} context={context} id={key} />);
        break;
      }
      case 'escape':
        out.push(decodeEntities((one as Tokens.Escape).text));
        break;
      case 'strong':
        out.push(<strong key={key}>{renderInline((one as Tokens.Strong).tokens, context, `${key}.`)}</strong>);
        break;
      case 'em':
        out.push(<em key={key}>{renderInline((one as Tokens.Em).tokens, context, `${key}.`)}</em>);
        break;
      case 'del':
        out.push(<del key={key}>{renderInline((one as Tokens.Del).tokens, context, `${key}.`)}</del>);
        break;
      case 'codespan':
        out.push(
          <code key={key} className="md-code">
            <InlineText text={decodeEntities((one as Tokens.Codespan).text)} context={{ ...context, mentions: undefined, wikiLinks: undefined }} id={key} />
          </code>,
        );
        break;
      case 'br':
        out.push(<br key={key} />);
        break;
      case 'link': {
        const link = one as Tokens.Link;
        const href = safeHref(decodeEntities(link.href));
        if (href === null || holdsImage(link.tokens)) {
          // Not a link here: what was written stays, the destination included (`[ok](<any words at all>)`). An image
          // inside a link has two destinations and room for one: that is shown as written too.
          out.push(<InlineText key={key} text={link.raw} context={context} id={key} />);
          break;
        }
        // Inside a link nothing else is clickable: no path buttons, no nested links, no wiki links.
        const children = renderInline(link.tokens, { ...context, paths: undefined, wikiLinks: undefined }, `${key}.`);
        const shown = shownText(link.tokens);
        if (shown.trim() === '') {
          out.push(<ExternalLink key={key} href={href}>{href}</ExternalLink>);
        } else if (namesAnotherPlace(shown, href)) {
          // The text names one place and the link leads to another: the text is text, the destination is the link.
          out.push(
            <span key={key}>
              {children} (<ExternalLink href={href}>{href}</ExternalLink>)
            </span>,
          );
        } else {
          out.push(<ExternalLink key={key} href={href}>{children}</ExternalLink>);
        }
        out.push(titleAfter(link.title, key));
        break;
      }
      case 'image': {
        const image = one as Tokens.Image;
        const href = safeHref(decodeEntities(image.href));
        if (href === null) {
          out.push(<InlineText key={key} text={image.raw} context={context} id={key} />);
          break;
        }
        const alt = decodeEntities(image.text).trim();
        if (alt !== '' && namesAnotherPlace(alt, href)) {
          // As for a link: words that name one place on a link to another are text, and the destination is the link.
          out.push(
            <span key={key}>
              {t('image.link', { alt })} (<ExternalLink href={href} image>{href}</ExternalLink>)
            </span>,
          );
        } else {
          out.push(<ExternalLink key={key} href={href} image>{alt === '' ? t('image.noAlt') : t('image.link', { alt })}</ExternalLink>);
        }
        out.push(titleAfter(image.title, key));
        break;
      }
      case 'html':
        // Raw HTML is text here, whatever it says.
        out.push((one as Tokens.Tag).raw);
        break;
      default:
        // A token of an extension this build does not have: its source, as text.
        if (typeof one.raw === 'string') out.push(one.raw);
    }
  });
  return out;
}

function InlineText({ text, context, id }: { text: string; context: RenderContext; id: string }) {
  return <>{textRun(text, context, id)}</>;
}

// ---- blocks

const ALIGN: Readonly<Record<string, 'left' | 'right' | 'center'>> = { left: 'left', right: 'right', center: 'center' };

function headingTag(depth: number, base: number): 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const level = Math.min(6, Math.max(2, base + depth - 1));
  return `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}

function renderListItem(item: Tokens.ListItem, context: RenderContext, key: string): ReactNode {
  const body = renderBlocks(item.tokens, context, `${key}.`, true);
  if (!item.task) return <li key={key}>{body}</li>;
  return (
    <li key={key} className="md-task">
      <input type="checkbox" checked={item.checked === true} disabled readOnly aria-label={item.checked === true ? t('task.done') : t('task.open')} />
      <div>{body}</div>
    </li>
  );
}

function renderBlock(token: Token, context: RenderContext, key: string, tight: boolean): ReactNode {
  const one = token as Tokens.Generic;
  switch (one.type) {
    case 'space':
      return null;
    case 'def':
      // A reference definition, printed as the line it is (lex.ts keeps it in the token list).
      return (
        <p key={key} className="md-raw">
          {trimEndOf(one.raw, '\n')}
        </p>
      );
    case 'plain': {
      const plain = token as unknown as PlainToken;
      // No note while the text only waits for the page to have time, and one note for a text shown in pieces.
      return (
        <Fragment key={key}>
          {plain.reason === 'later' || plain.quiet === true ? null : (
            <p className="md-note" data-why={plain.reason}>
              {t('plain.note')}
            </p>
          )}
          <p className="md-plain" {...(plain.reason === 'later' ? { 'data-why': 'later' } : {})}>
            {plain.text}
          </p>
        </Fragment>
      );
    }
    case 'hr':
      return <hr key={key} />;
    case 'heading': {
      const heading = one as Tokens.Heading;
      const Tag = headingTag(heading.depth, context.headingBase);
      return (
        <Tag key={key} className={`md-h md-h--${Math.min(heading.depth, 4)}`}>
          {renderInline(heading.tokens, context, `${key}.`)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={key}>{renderInline((one as Tokens.Paragraph).tokens, context, `${key}.`)}</p>;
    case 'text': {
      // The text of a tight list item: inline content without a paragraph around it.
      const text = one as Tokens.Text;
      const inline = text.tokens !== undefined ? renderInline(text.tokens, context, `${key}.`) : textRun(decodeEntities(text.text), context, key);
      return tight ? <span key={key}>{inline}</span> : <p key={key}>{inline}</p>;
    }
    case 'code': {
      const code = one as Tokens.Code;
      // Everything written after the fence: the language, and whatever else stands on that line.
      const info = (code.lang ?? '').trim();
      return (
        <pre key={key} className="md-pre" aria-label={info === '' ? t('code.label') : t('code.labelLang', { lang: info })} tabIndex={0}>
          {info === '' ? null : (
            <span className="md-pre__info" aria-hidden="true">
              {info}
            </span>
          )}
          <code>{code.text}</code>
        </pre>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks((one as Tokens.Blockquote).tokens, context, `${key}.`, false)}</blockquote>;
    case 'list': {
      const list = one as Tokens.List;
      const items = list.items.map((item, index) => renderListItem(item, context, `${key}.${index}`));
      if (!list.ordered) return <ul key={key}>{items}</ul>;
      return (
        <ol key={key} {...(typeof list.start === 'number' && list.start !== 1 ? { start: list.start } : {})}>
          {items}
        </ol>
      );
    }
    case 'table': {
      const table = one as Tokens.Table;
      const cell = (content: Tokens.TableCell, index: number, row: string, header: boolean): ReactNode => {
        const align = content.align === null ? undefined : ALIGN[content.align];
        const Cell = header ? 'th' : 'td';
        return (
          <Cell key={`${row}.${index}`} {...(header ? { scope: 'col' } : {})} {...(align === undefined ? {} : { style: { textAlign: align } })}>
            {renderInline(content.tokens, context, `${row}.${index}.`)}
          </Cell>
        );
      };
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>{table.header.map((content, index) => cell(content, index, `${key}.h`, true))}</tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}.${rowIndex}`}>{row.map((content, index) => cell(content, index, `${key}.${rowIndex}`, false))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      // A block of raw HTML: shown as the text that was written, never as markup.
      return (
        <p key={key} className="md-raw">
          {trimEndOf((one as Tokens.HTML).raw, '\n')}
        </p>
      );
    default:
      if (Array.isArray(one.tokens)) return <p key={key}>{renderInline(one.tokens, context, `${key}.`)}</p>;
      return typeof one.raw === 'string' && one.raw.trim() !== '' ? <p key={key}>{one.raw}</p> : null;
  }
}

export function renderBlocks(tokens: readonly Token[], context: RenderContext, prefix = '', tight = false): ReactNode[] {
  return tokens.map((token, index) => renderBlock(token, context, `${prefix}${index}`, tight));
}

function sameContext(a: RenderContext, b: RenderContext): boolean {
  // A new wikiLinks is a new set of written notes: a link that now leads to one is drawn again.
  return a.headingBase === b.headingBase && a.paths === b.paths && a.mentions === b.mentions && a.wikiLinks === b.wikiLinks;
}

/**
 * One top-level block. Memoised on the token's identity: a finished block is rendered once, and of a streaming text
 * only the blocks after the stable cut render again (stream.ts).
 */
export const MdBlock = memo(
  function MdBlock({ token, context }: { token: Token; context: RenderContext }) {
    return <>{renderBlock(token, context, 'b', false)}</>;
  },
  (previous, next) => previous.token === next.token && sameContext(previous.context, next.context),
);
