// Helpers for the site tests. A page is parsed with parse5 (the WHATWG parsing algorithm browsers use), which reports
// every parse error the HTML standard defines, and the tree is flattened into a list of elements with their ancestors.
// testSite() is the whole site as the tests' builds produce it (public/ plus the generated pages), in memory.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { generateSite, optionsFromEnv, type Site } from '../scripts/site.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PUBLIC = join(SITE_ROOT, 'public');
export const DIST = join(SITE_ROOT, 'dist');
export const REPO_ROOT = join(SITE_ROOT, '..', '..');
export const FIXTURE_NOTICES = join(SITE_ROOT, 'test', 'fixtures', 'third-party-notices.txt');

/** Every file in a directory (public/ by default), as a path relative to it with forward slashes. */
export function publicFiles(dir = PUBLIC, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? publicFiles(path, base) : [relative(base, path).split('\\').join('/')];
  });
}

export const readPublic = (path: string): string => readFileSync(join(PUBLIC, path), 'utf8');

let cached: Site | undefined;

/**
 * The site in memory, built with the environment vitest.config.ts gives every test (the same as wrangler's custom
 * build gets in test/serve.test.ts and test/build.test.ts, so it is byte for byte what they write to dist/).
 */
export function testSite(): Site {
  cached ??= generateSite(optionsFromEnv());
  return cached;
}

/** A file of the test site, as text. */
export function siteText(path: string): string {
  const data = testSite().files.get(path);
  if (data === undefined) throw new Error(`no ${path} in the site`);
  return data.toString('utf8');
}

/** The HTML pages of the test site. */
export function sitePages(): string[] {
  return [...testSite().files.keys()].filter((path) => path.endsWith('.html'));
}

export interface El {
  readonly tag: string;
  readonly parents: readonly El[];
  readonly node: Element;
  attr(name: string): string | undefined;
  /** The text content, whitespace collapsed. */
  text(): string;
  children(): El[];
}

export interface Page {
  readonly errors: string[];
  readonly elements: El[];
  byTag(tag: string): El[];
  ids(): string[];
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function textOf(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (!('childNodes' in node)) return '';
  return node.childNodes.map(textOf).join('');
}

/** The raw text content (whitespace kept), e.g. of a <pre>. */
export function rawText(el: El): string {
  return textOf(el.node);
}

export function parsePage(html: string): Page {
  const errors: string[] = [];
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => errors.push(`${error.code} at ${error.startLine}:${error.startCol}`),
  });
  const elements: El[] = [];
  const byNode = new Map<Element, El>();
  const walk = (node: Node, parents: El[]): void => {
    let next = parents;
    if (isElement(node)) {
      const el: El = {
        tag: node.tagName,
        parents,
        node,
        attr: (name) => node.attrs.find((a) => a.name === name)?.value,
        text: () => textOf(node).replace(/\s+/g, ' ').trim(),
        children: () => node.childNodes.filter(isElement).map((child) => byNode.get(child) as El),
      };
      elements.push(el);
      byNode.set(node, el);
      next = [...parents, el];
    }
    if ('childNodes' in node) for (const child of node.childNodes) walk(child, next);
    if (node.nodeName === 'template') walk((node as DefaultTreeAdapterTypes.Template).content, next);
  };
  walk(document, []);
  return {
    errors,
    elements,
    byTag: (tag) => elements.filter((el) => el.tag === tag),
    ids: () => elements.map((el) => el.attr('id')).filter((id): id is string => id !== undefined),
  };
}
