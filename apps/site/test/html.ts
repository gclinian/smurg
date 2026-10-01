// A small view of an HTML page for the tests: parse5 (the WHATWG parsing algorithm browsers use) reports every parse
// error the HTML standard defines, and the tree is flattened into a list of elements with their ancestors.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PUBLIC = join(SITE_ROOT, 'public');
export const REPO_ROOT = join(SITE_ROOT, '..', '..');

/** Every file in public/, as a path relative to it with forward slashes. */
export function publicFiles(dir = PUBLIC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? publicFiles(path) : [relative(PUBLIC, path).split('\\').join('/')];
  });
}

export const readPublic = (path: string): string => readFileSync(join(PUBLIC, path), 'utf8');

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
