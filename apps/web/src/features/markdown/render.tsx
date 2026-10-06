// marked's tokens → React elements (DESIGN §5.5). The rules, each with a test:
//   - no HTML string is ever injected: raw HTML in the text is shown as the text it is;
//   - a link leads to http, https or mailto only (links.ts), opens in a new tab with rel="noopener noreferrer" and
//     shows its address on hover and on keyboard focus; anything else is shown as its text;
//   - an image is NEVER loaded (a remote image in agent text would make every viewer's browser contact a third
//     party): it is a link with its alt text;
//   - a code block is plain monospace text;
//   - a path that the caller's adapter resolves is a button that opens the file (paths.ts);
//   - a member named with "@" is marked when the caller says who can be named.
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';
import { decodeEntities } from './entities.ts';
import { safeHref } from './links.ts';
import type { MarkdownPaths, PathMatch, PathTarget } from './paths.ts';
import { t } from './strings.ts';

export interface RenderContext {
  /** The heading level a `#` gets (2–6); deeper headings follow and stop at 6. */
  readonly headingBase: number;
  readonly paths: MarkdownPaths | undefined;
  /** Display names that are marked when written as `@name`. */
  readonly mentions: readonly string[] | undefined;
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

/** A run of plain text with its paths and mentions marked. */
function textRun(text: string, context: RenderContext, key: string): ReactNode {
  if (text === '') return null;
  type Mark = { start: number; end: number; node: (index: number) => ReactNode };
  const marks: Mark[] = [];
  if (context.mentions !== undefined) {
    for (const mention of findMentions(text, context.mentions)) {
      marks.push({ ...mention, node: (index) => <span key={`${key}.${index}`} className="md-mention">{text.slice(mention.start, mention.end)}</span> });
    }
  }
  const paths = context.paths;
  if (paths !== undefined) {
    for (const match of paths.find(text)) {
      if (marks.some((mark) => match.start < mark.end && mark.start < match.end)) continue;
      marks.push({ start: match.start, end: match.end, node: (index) => <PathLink key={`${key}.${index}.${match.text}`} match={match} paths={paths} /> });
    }
  }
  if (marks.length === 0) return text;
  marks.sort((a, b) => a.start - b.start);
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
            <InlineText text={decodeEntities((one as Tokens.Codespan).text)} context={{ ...context, mentions: undefined }} id={key} />
          </code>,
        );
        break;
      case 'br':
        out.push(<br key={key} />);
        break;
      case 'link': {
        const link = one as Tokens.Link;
        const href = safeHref(decodeEntities(link.href));
        // Inside a link nothing else is clickable: no path buttons, no nested links.
        const children = renderInline(link.tokens, { ...context, paths: undefined }, `${key}.`);
        if (href === null) out.push(<span key={key}>{children}</span>);
        else out.push(<ExternalLink key={key} href={href}>{children}</ExternalLink>);
        break;
      }
      case 'image': {
        const image = one as Tokens.Image;
        const alt = decodeEntities(image.text).trim();
        const label = alt === '' ? t('image.noAlt') : t('image.link', { alt });
        const href = safeHref(decodeEntities(image.href));
        if (href === null) out.push(<span key={key} className="md-image">{label}</span>);
        else out.push(<ExternalLink key={key} href={href} image>{label}</ExternalLink>);
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
    case 'def':
      return null;
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
      const lang = (code.lang ?? '').trim().split(/\s+/)[0] ?? '';
      return (
        <pre key={key} className="md-pre" aria-label={lang === '' ? t('code.label') : t('code.labelLang', { lang })} tabIndex={0}>
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
          {(one as Tokens.HTML).raw.replace(/\n+$/, '')}
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
  return a.headingBase === b.headingBase && a.paths === b.paths && a.mentions === b.mentions;
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
