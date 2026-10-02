// Markdown -> HTML for the docs pages of smurg.ai (scripts/site.ts), with marked (GFM: tables, fenced code).
//
// What is different from marked's defaults, and why:
// - Raw HTML is never passed through: block HTML, inline tags and the text after them become escaped text (the docs
//   are plain Markdown; the site's CSP and Trusted Types forbid inline code anyway). Each occurrence is reported.
// - Headings get GitHub's ids (github-slugger's algorithm), so the docs' own `#…` links keep working.
// - Every link goes through a resolver: kept (possibly rewritten) or turned into its plain text. Each one is reported.
// - Bare URLs become links only up to the first non-ASCII character: GFM would otherwise run a URL on into the
//   Chinese text that follows it (a URL directly followed by a full-width parenthesis in the zh-TW guides).
// - Images are refused (reported as problems): the CSP allows only this site's own files, and the docs have none.
// - Table alignment is a class, not the obsolete `align` attribute.
// - A soft line break between two CJK characters is dropped: the docs wrap Chinese sentences at 120 columns, and a
//   browser would show each of those breaks as a space in the middle of a sentence.
import { Marked, type Tokens } from 'marked';

export interface Heading {
  readonly depth: number;
  readonly id: string;
  /** The heading's plain text. */
  readonly text: string;
}

/** What to do with a link: keep it (with this href) or replace it by its text (for this reason). */
export type LinkDecision = { readonly href: string } | { readonly plain: string };

export interface LinkRecord {
  /** 1-based line of the link in the Markdown source (0 when it cannot be found, e.g. a reference-style link). */
  readonly line: number;
  /** The destination as written. */
  readonly href: string;
  /** The link's plain text. */
  readonly text: string;
  readonly decision: LinkDecision;
}

export interface Rendered {
  readonly html: string;
  readonly headings: readonly Heading[];
  readonly links: readonly LinkRecord[];
  /** Raw HTML found in the source, shown as text: `line: snippet`. */
  readonly rawHtml: readonly string[];
  /** Things the page cannot have (images, empty heading ids); the build fails on any. */
  readonly problems: readonly string[];
}

/**
 * GitHub's heading id: lower case, every character that is not a letter, mark, decimal or letter number, connector
 * punctuation, a hyphen or a space removed, spaces turned into hyphens (github-slugger, which follows github.com).
 */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Unique ids in document order, the way GitHub numbers repeated headings: `x`, `x-1`, `x-2`. */
export class Slugger {
  readonly #seen = new Map<string, number>();

  slug(text: string): string {
    const base = githubSlug(text);
    let result = base;
    while (this.#seen.has(result)) {
      const count = (this.#seen.get(base) ?? 0) + 1;
      this.#seen.set(base, count);
      result = `${base}-${count}`;
    }
    this.#seen.set(result, 0);
    return result;
  }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Undoes marked's escaping of text (the five characters it escapes). */
export function unescapeHtml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Han, kana, Hangul and the CJK punctuation and full-width forms the docs use.
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff00-\\uffef';
const INLINE_CLOSE = '(?:</(?:a|code|del|em|strong)>)*';
const INLINE_OPEN = '(?:<(?:a|code|del|em|strong)\\b[^>]*>)*';
// A line break between two CJK characters, with inline tags on either side of it.
const CJK_SOFT_BREAK = new RegExp(`([${CJK}]${INLINE_CLOSE})\\n(${INLINE_OPEN}[${CJK}])`, 'gu');

/** Drops the soft line breaks between two CJK characters, outside <pre> blocks. */
export function joinCjkLines(html: string): string {
  return html
    .split(/(<pre\b[\s\S]*?<\/pre>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(CJK_SOFT_BREAK, '$1$2')))
    .join('');
}

// A bare URL: ASCII only, no spaces; trailing sentence punctuation is not part of it (as in GFM).
const BARE_URL = /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d+)?(?:[/?#][!#$%&'()*+,\-./0-9:;=?@A-Z\[\]_a-z~]*)?/;
const TRAILING_PUNCTUATION = /[?!.,:;*_'"~]+$/;
// An autolink in angle brackets: <scheme:…> (CommonMark).
const ANGLE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)>/;

function trimUrl(url: string): string {
  let result = url;
  for (;;) {
    const before = result;
    result = result.replace(TRAILING_PUNCTUATION, '');
    // A closing parenthesis belongs to the URL only when it closes one opened inside it.
    if (result.endsWith(')') && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) result = result.slice(0, -1);
    if (result === before) return result;
  }
}

/** The 1-based line of each occurrence of a snippet, in order (the n-th call for a snippet finds its n-th occurrence). */
function lineFinder(source: string): (raw: string) => number {
  const next = new Map<string, number>();
  return (raw) => {
    const index = source.indexOf(raw, next.get(raw) ?? 0);
    if (index < 0) return 0;
    next.set(raw, index + raw.length);
    return source.slice(0, index).split('\n').length;
  };
}

function linkToken(raw: string, href: string): Tokens.Link {
  const text = escapeHtml(href);
  return { type: 'link', raw, href, title: null, text, tokens: [{ type: 'text', raw: href, text }] };
}

export interface RenderOptions {
  /** Decides every link (see LinkDecision). */
  readonly resolveLink: (href: string) => LinkDecision;
  /** Ids the page template already uses: a heading may not take one. */
  readonly reservedIds?: Iterable<string>;
  /** The accessible name of a table's scroll box, from the section it is in (e.g. "Table: 8. Troubleshooting"). */
  readonly tableLabel: (section: string | undefined) => string;
}

export function renderMarkdown(markdown: string, options: RenderOptions): Rendered {
  const reserved = new Set(options.reservedIds ?? []);
  const slugger = new Slugger();
  const headings: Heading[] = [];
  const links: LinkRecord[] = [];
  const rawHtml: string[] = [];
  const problems: string[] = [];
  const lineOf = lineFinder(markdown);
  const marked = new Marked({ gfm: true, breaks: false, pedantic: false, async: false });

  marked.use({
    tokenizer: {
      // Raw HTML (block and inline) is not a token: the text falls through to paragraphs and inline text, which
      // marked escapes. Returning undefined (not false) skips marked's own tokenizer. A block of HTML ends up in a
      // paragraph, so the inline tokenizer reports it.
      html() {
        return undefined;
      },
      tag(src: string) {
        const match = this.rules.inline.tag.exec(src);
        if (match) rawHtml.push(`${lineOf(match[0])}: ${match[0].slice(0, 80)}`);
        return undefined;
      },
      url(src: string) {
        const match = BARE_URL.exec(src);
        if (!match) return undefined;
        const url = trimUrl(match[0]);
        return linkToken(url, url);
      },
      autolink(src: string) {
        const match = ANGLE_AUTOLINK.exec(src);
        if (!match) return undefined;
        return linkToken(match[0], match[1] as string);
      },
    },
    renderer: {
      heading({ tokens, depth }: Tokens.Heading): string {
        const inner = this.parser.parseInline(tokens);
        const text = unescapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer)).replace(/\s+/g, ' ').trim();
        const id = slugger.slug(text);
        if (id === '' || /^-+\d*$/.test(id)) problems.push(`heading "${text}" has no usable id (GitHub would give it "${id}")`);
        if (reserved.has(id)) problems.push(`heading "${text}" would take the id "${id}", which the page template uses`);
        headings.push({ depth, id, text });
        return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
      },
      link(token: Tokens.Link): string {
        const inner = this.parser.parseInline(token.tokens);
        const text = unescapeHtml(this.parser.parseInline(token.tokens, this.parser.textRenderer)).replace(/\s+/g, ' ').trim();
        const decision = options.resolveLink(token.href);
        links.push({ line: lineOf(token.raw), href: token.href, text, decision });
        if ('plain' in decision) return inner;
        const title = token.title ? ` title="${escapeHtml(unescapeHtml(token.title))}"` : '';
        return `<a href="${escapeHtml(decision.href)}"${title}>${inner}</a>`;
      },
      image(token: Tokens.Image): string {
        problems.push(`line ${lineOf(token.raw)}: an image (${token.href}); the site has no images from the docs`);
        return escapeHtml(unescapeHtml(token.text));
      },
      html(token: Tokens.HTML | Tokens.Tag): string {
        // Unreachable with the tokenizers above; escaped all the same.
        return escapeHtml(token.text);
      },
      table(token: Tokens.Table): string {
        const cell = (c: Tokens.TableCell): string => {
          const tag = c.header ? 'th' : 'td';
          const align = c.align ? ` class="ta-${c.align}"` : '';
          return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        };
        const head = `<tr>${token.header.map(cell).join('')}</tr>`;
        const body = token.rows.map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('\n');
        // A wide table scrolls inside its own box: a named region, focusable so that it scrolls from the keyboard too.
        const label = escapeHtml(options.tableLabel(headings.at(-1)?.text));
        return `<div class="table-wrap" tabindex="0" role="region" aria-label="${label}">\n<table>\n<thead>\n${head}\n</thead>\n${body === '' ? '' : `<tbody>\n${body}\n</tbody>\n`}</table>\n</div>\n`;
      },
    },
  });

  const html = joinCjkLines(marked.parse(markdown, { async: false }) as string);
  return { html, headings, links, rawHtml, problems };
}
