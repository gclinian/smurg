// The two languages of every published document say the same things in the same order: docs/QUICKSTART.md and
// docs/zh-TW/QUICKSTART.md, docs/HOSTING.md and docs/zh-TW/HOSTING.md, docs/JOINING.md and docs/zh-TW/JOINING.md,
// CHANGELOG.md and docs/zh-TW/CHANGELOG.md. A
// translation cannot be compared sentence by sentence, but its skeleton can: the headings and their section numbers
// (every "§5.1" in the CLI, the web app and the other guide holds in both languages), the code blocks, the commands a
// reader copies, the tables and where the links go.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_PAGES } from '../scripts/site.ts';
import { REPO_ROOT } from './html.ts';

interface Skeleton {
  /** `depth number` of every heading, e.g. `2 5.`, `3 5.1`; a heading without a number has only its depth. */
  readonly headings: string[];
  /** The text of the level-2 headings (the changelogs' are the same in both languages). */
  readonly h2: string[];
  /** The info string of every code fence, in order (`sh`, `text`, ``). */
  readonly fences: string[];
  /** The `sh` blocks without their comments: what a reader copies. */
  readonly commands: string[];
  /** Table rows per table, in order. */
  readonly tables: number[];
  /** Top-level list items and numbered steps. */
  readonly items: number;
  /** Where the Markdown links go, in order. */
  readonly links: string[];
  /** Every URL written in the text or in a link, sorted. */
  readonly urls: string[];
}

/** A link target without what differs by language: the language's folder, the language's path prefix, the #heading. */
function normalizeTarget(source: string, href: string): string {
  if (href.startsWith('#')) return '#';
  if (/^https:\/\//.test(href)) return normalizeUrl(href);
  const [path = ''] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(source), path));
  if (target === 'docs/zh-TW/CHANGELOG.md') return 'CHANGELOG.md';
  return target.replace(/^docs\/zh-TW\//, 'docs/');
}

function normalizeUrl(href: string): string {
  const url = new URL(href);
  // Another project's page has its own addresses per language (keepachangelog.com/zh-TW/…): the host is what counts.
  if (!url.hostname.endsWith('smurg.ai')) return url.hostname;
  return `${url.hostname}${url.pathname.replace(/^\/zh-TW\//, '/')}`;
}

function skeleton(source: string): Skeleton {
  const lines = readFileSync(join(REPO_ROOT, source), 'utf8').split('\n');
  const headings: string[] = [];
  const h2: string[] = [];
  const fences: string[] = [];
  const commands: string[] = [];
  const tables: number[] = [];
  const links: string[] = [];
  const urls: string[] = [];
  let items = 0;
  let fence: { info: string; body: string[] } | undefined;
  let table = 0;
  const endTable = (): void => {
    if (table > 0) tables.push(table);
    table = 0;
  };
  for (const line of lines) {
    const fenceMatch = /^\s*```(.*)$/.exec(line);
    if (fenceMatch) {
      if (fence === undefined) {
        fence = { info: (fenceMatch[1] ?? '').trim(), body: [] };
        fences.push(fence.info);
      } else {
        // A comment starts at " #" or at the start of the line; the command before it is what is compared.
        if (fence.info === 'sh') commands.push(fence.body.map((l) => l.replace(/(^|\s+)#.*$/, '').trimEnd()).filter((l) => l !== '').join('\n'));
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      fence.body.push(line);
      continue;
    }
    if (line.startsWith('|')) table++;
    else endTable();
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      const depth = (heading[1] as string).length;
      const text = heading[2] as string;
      const number = /^(\d+(?:\.\d+)*)\.?(?=\D|$)/.exec(text)?.[1];
      headings.push(number === undefined ? `${depth}` : `${depth} ${number}`);
      if (depth === 2) h2.push(text);
    }
    if (/^(?:- |\d+\. )/.test(line)) items++;
    for (const match of line.matchAll(/\]\(([^()\s]+(?:\([^()]*\))?[^()\s]*)\)/g)) links.push(normalizeTarget(source, match[1] as string));
    // Outside inline code: `https://downloads.smurg.ai/v<version>/` has a placeholder that is translated.
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(/https:\/\/[A-Za-z0-9\-._~/%?=&#]+/g)) urls.push(normalizeUrl(match[0].replace(/[.,;:]+$/, '')));
  }
  endTable();
  return { headings, h2, fences, commands, tables, items, links, urls: urls.sort() };
}

describe('the guides and the changelog in both languages', () => {
  const pairs = DOC_PAGES.map((doc) => [doc.en.source, doc['zh-TW'].source] as const);

  it('are the eight files the site publishes', () => {
    expect(pairs).toEqual([
      ['docs/QUICKSTART.md', 'docs/zh-TW/QUICKSTART.md'],
      ['docs/HOSTING.md', 'docs/zh-TW/HOSTING.md'],
      ['docs/JOINING.md', 'docs/zh-TW/JOINING.md'],
      ['CHANGELOG.md', 'docs/zh-TW/CHANGELOG.md'],
    ]);
  });

  it.each(pairs)('%s and %s have the same headings, with the same section numbers in the same order', (english, chinese) => {
    const en = skeleton(english);
    const zh = skeleton(chinese);
    expect(zh.headings).toEqual(en.headings);
    expect(en.headings[0]).toBe('1');
    // (the quick start has its title and four sections: it is short on purpose)
    expect(en.headings.length).toBeGreaterThan(english === 'docs/QUICKSTART.md' ? 3 : 4);
    // The numbered sections count up from 1 without a gap (the changelog's sections are versions, not numbers).
    const numbers = en.headings.filter((h) => h.startsWith('2 ') && /^2 \d+$/.test(h)).map((h) => Number(h.slice(2)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it.each(pairs)('%s and %s have the same code blocks, and the same commands in them', (english, chinese) => {
    const en = skeleton(english);
    const zh = skeleton(chinese);
    expect(zh.fences).toEqual(en.fences);
    expect(zh.commands).toEqual(en.commands);
    for (const command of en.commands) expect(command, 'an sh block holds commands, not only comments').not.toBe('');
  });

  it.each(pairs)('%s and %s have the same tables, as many list items, and links to the same places', (english, chinese) => {
    const en = skeleton(english);
    const zh = skeleton(chinese);
    expect(zh.tables).toEqual(en.tables);
    expect(zh.items).toBe(en.items);
    expect(zh.links).toEqual(en.links);
    expect(zh.urls).toEqual(en.urls);
  });

  it('the changelogs have identical version headings: `## [X.Y.Z] - YYYY-MM-DD`, newest first, under an optional [Unreleased]', () => {
    const en = skeleton('CHANGELOG.md').h2;
    expect(skeleton('docs/zh-TW/CHANGELOG.md').h2).toEqual(en);
    const released = en.filter((heading) => heading !== '[Unreleased]');
    expect(en.indexOf('[Unreleased]')).toBeLessThanOrEqual(0);
    for (const heading of released) expect(heading).toMatch(/^\[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/);
    const versions = released.map((heading) => (/^\[(\d+)\.(\d+)\.(\d+)\]/.exec(heading) ?? []).slice(1).map(Number));
    const sorted = [...versions].sort((a, b) => (b[0] as number) - (a[0] as number) || (b[1] as number) - (a[1] as number) || (b[2] as number) - (a[2] as number));
    expect(versions).toEqual(sorted);
    expect(released.length).toBeGreaterThanOrEqual(3);
  });

  it('each guide names its translation in its first paragraph, and the guides of a language link each other', () => {
    const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
    expect(read('docs/QUICKSTART.md')).toContain('[繁體中文](zh-TW/QUICKSTART.md)');
    expect(read('docs/zh-TW/QUICKSTART.md')).toContain('[English](../QUICKSTART.md)');
    expect(read('docs/HOSTING.md')).toContain('[繁體中文](zh-TW/HOSTING.md)');
    expect(read('docs/JOINING.md')).toContain('[繁體中文](zh-TW/JOINING.md)');
    expect(read('CHANGELOG.md')).toContain('[繁體中文](docs/zh-TW/CHANGELOG.md)');
    expect(read('docs/zh-TW/HOSTING.md')).toContain('[English](../HOSTING.md)');
    expect(read('docs/zh-TW/JOINING.md')).toContain('[English](../JOINING.md)');
    expect(read('docs/zh-TW/CHANGELOG.md')).toContain('[English](../../CHANGELOG.md)');
    expect(read('docs/HOSTING.md')).toContain('](JOINING.md)');
    expect(read('docs/zh-TW/HOSTING.md')).toContain('](JOINING.md)');
    // The quick start links both guides of its language, and each guide sends a new reader to it, near its top.
    for (const quick of ['docs/QUICKSTART.md', 'docs/zh-TW/QUICKSTART.md']) for (const guide of ['HOSTING.md', 'JOINING.md']) expect(read(quick), `${quick} -> ${guide}`).toContain(`](${guide}#`);
    for (const guide of ['docs/HOSTING.md', 'docs/JOINING.md', 'docs/zh-TW/HOSTING.md', 'docs/zh-TW/JOINING.md']) {
      const top = read(guide).split('\n').slice(0, 10).join('\n');
      expect(top.match(/\]\(QUICKSTART\.md\)/g), guide).toHaveLength(1);
      expect(read(guide).match(/QUICKSTART\.md/g), guide).toHaveLength(1);
    }
  });
});

describe('the two READMEs', () => {
  const english = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const chinese = readFileSync(join(REPO_ROOT, 'README.zh-TW.md'), 'utf8');

  it('link each other on the first line', () => {
    expect(english.split('\n')[0]).toBe('English | [繁體中文](README.zh-TW.md)');
    expect(chinese.split('\n')[0]).toBe('[English](README.md) | 繁體中文');
  });

  it('the Chinese one is the user part: its commands are the English ones, and it sends developers to the English README', () => {
    const en = skeleton('README.md').commands;
    const zh = skeleton('README.zh-TW.md').commands;
    expect(zh).toEqual(en.slice(0, zh.length));
    expect(zh).toEqual(['curl -fsSL https://smurg.ai/install.sh | sh', 'smurg login\nsmurg host ~/projects/my-app']);
    expect(chinese).toContain('[README.md](README.md)');
    // Each links its own language's guides first.
    expect(chinese).toContain('](docs/zh-TW/HOSTING.md)');
    expect(chinese).toContain('](docs/zh-TW/JOINING.md)');
    expect(english).toContain('[`docs/HOSTING.md`](docs/HOSTING.md)');
    expect(english).toContain('[`docs/JOINING.md`](docs/JOINING.md)');
  });

  it('both name the built-in relay and the install line, say MIT, and nothing of the time the source was private', () => {
    for (const [name, text] of [['README.md', english], ['README.zh-TW.md', chinese]] as const) {
      expect(text, name).toContain('https://app.smurg.ai');
      expect(text, name).toContain('curl -fsSL https://smurg.ai/install.sh | sh');
      expect(text, name).toContain('MIT');
      expect(text, name).toContain('[`LICENSE`](LICENSE)');
      expect(text, name).not.toMatch(/proprietary|專有軟體|原始碼不公開|private repository|私人 repository|OPEN-QUESTIONS|v0\.1\.0|0\.2\.0/i);
    }
    expect(english).toContain('https://github.com/gclinian/smurg');
  });

  it('the English command table has one line per command and points at --help instead of repeating it', () => {
    const table = english.slice(english.indexOf('## The `smurg` command'), english.indexOf('## Packaging and releasing'));
    expect(table).toContain('`smurg <command> --help`');
    const rows = table.split('\n').filter((line) => line.startsWith('| `smurg '));
    expect(rows.map((row) => /^\| `smurg (\w+)/.exec(row)?.[1])).toEqual(['host', 'attach', 'status', 'login', 'update', 'uninstall', 'licenses']);
    for (const row of rows) expect(row.length, row).toBeLessThan(160);
    for (const command of ['stop', 'logout']) expect(table).toContain(`\`smurg ${command}\``);
  });
});
