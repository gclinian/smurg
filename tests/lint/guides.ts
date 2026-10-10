// Shared by the lints that read the guides (docs-quotes.test.ts, guide-update.test.ts): where the two guides and the
// quick start are, a text as one line, one numbered section of a guide, and the rows of its tables.
import type { Locale } from './catalogs.ts';
import { read } from './tree.ts';

export type Guide = 'QUICKSTART' | 'HOSTING' | 'JOINING';
export const GUIDES: Readonly<Record<Guide, Readonly<Record<Locale, string>>>> = {
  QUICKSTART: { en: 'docs/QUICKSTART.md', 'zh-TW': 'docs/zh-TW/QUICKSTART.md' },
  HOSTING: { en: 'docs/HOSTING.md', 'zh-TW': 'docs/zh-TW/HOSTING.md' },
  JOINING: { en: 'docs/JOINING.md', 'zh-TW': 'docs/zh-TW/JOINING.md' },
};

/** One line of text: Markdown emphasis and code marks dropped, whitespace collapsed (zh-TW: none between Han characters). */
export function flat(text: string): string {
  const joined = text
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const han = '[\\u2E80-\\u9FFF\\uFF00-\\uFFEF\\u3000-\\u303F]'.replace(/\\u([0-9A-F]{4})/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
  return joined.replace(new RegExp(`(${han}) (?=${han})`, 'g'), '$1');
}

/**
 * The Markdown of one numbered section of a document (`8`, `9.4`, `4.5`): from its heading (`## 8. …`, `### 9.4 …`)
 * to the next heading of the same depth or above. Lines inside code fences are never headings. Throws when the
 * document has no such section: a lint about a section that was renumbered must fail, not pass on nothing.
 */
export function section(path: string, number: string): string {
  const lines = read(path).split('\n');
  const out: string[] = [];
  let depth = 0;
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,6}) (.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] as string).length;
      if (depth > 0 && level <= depth) break;
      if (depth === 0 && new RegExp(`^${number.replaceAll('.', '\\.')}(?:\\.(?!\\d)|\\s)`).test(heading[2] as string)) {
        depth = level;
        out.push(line);
        continue;
      }
    }
    if (depth > 0) out.push(line);
  }
  if (depth === 0) throw new Error(`${path} has no section ${number}`);
  return out.join('\n');
}

/** The rows of every table in `markdown`, each as its cells (the header row and the rule under it are left out). */
export function tableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  let inTable = false;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|\s*$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    // The first line of a table is its header; the second is the rule.
    if (!inTable) {
      inTable = true;
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}
