// Every document a user reads exists in English and in zh-TW, and the two say the same things in the same order
// (DESIGN B.2, B.5). The detailed comparison of the published guides (code blocks, commands, tables, link targets)
// is apps/site/test/docs-parity.test.ts, next to the build that publishes them; this lint is the repository-wide
// part: the pairs exist, their numbered sections match, and the two changelogs carry the same sections with as many
// entries each, the unreleased section included (an entry added to one language only fails here, before a release).
import { describe, expect, it } from 'vitest';
import { CJK, read, repoFiles } from './tree.ts';

/** English document -> its zh-TW counterpart. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['README.md', 'README.zh-TW.md'],
  ['CHANGELOG.md', 'docs/zh-TW/CHANGELOG.md'],
  ['docs/HOSTING.md', 'docs/zh-TW/HOSTING.md'],
  ['docs/JOINING.md', 'docs/zh-TW/JOINING.md'],
  ['apps/site/public/index.html', 'apps/site/public/zh-TW/index.html'],
  ['apps/site/public/404.html', 'apps/site/public/zh-TW/404.html'],
];

/** Markdown lines outside code fences. */
function prose(path: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of read(path).split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence) out.push(line);
  }
  return out;
}

/** `depth number` of every numbered heading (`## 5. …` -> `2 5`, `### 5.1 …` -> `3 5.1`). */
function numberedHeadings(path: string): string[] {
  const out: string[] = [];
  for (const line of prose(path)) {
    const heading = /^(#{2,3}) (\d+(?:\.\d+)*)(?:\.(?!\d)|\s)/.exec(line);
    if (heading !== null) out.push(`${(heading[1] as string).length} ${heading[2] as string}`);
  }
  return out;
}

interface ChangelogSection {
  /** The text of the `## ` heading: `[Unreleased]`, `[0.3.0] - 2026-10-02`. */
  readonly heading: string;
  /** Top-level entries before the first `###`, then per `###` subsection, in order. */
  readonly entries: number[];
  readonly paragraphs: number;
}

function changelogSections(path: string): ChangelogSection[] {
  const sections: { heading: string; entries: number[]; paragraphs: number }[] = [];
  let blank = true;
  for (const line of prose(path)) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2 !== null) {
      sections.push({ heading: (h2[1] as string).trim(), entries: [0], paragraphs: 0 });
      blank = true;
      continue;
    }
    const current = sections.at(-1);
    if (current === undefined) continue;
    if (/^### /.test(line)) current.entries.push(0);
    else if (/^- /.test(line)) current.entries[current.entries.length - 1] = (current.entries.at(-1) as number) + 1;
    else if (line.trim() !== '' && blank && !/^\s/.test(line)) current.paragraphs += 1;
    blank = line.trim() === '';
  }
  return sections;
}

describe('every user document has its zh-TW counterpart', () => {
  it.each(PAIRS)('%s and %s both exist; the English one is English and the Chinese one Chinese', (english, chinese) => {
    const files = new Set(repoFiles());
    expect(files.has(english), english).toBe(true);
    expect(files.has(chinese), chinese).toBe(true);
    const englishLines = read(english).split('\n').filter((line) => CJK.test(line.replaceAll('繁體中文', '').replace(/<a\b[^>]*\blang="zh-Hant-TW"[^>]*>[^<]*<\/a>/g, '')));
    expect(englishLines).toEqual([]);
    expect(read(chinese)).toMatch(CJK);
  });

  it('no zh-TW document is left without an English one', () => {
    const paired = new Set(PAIRS.map(([, chinese]) => chinese));
    const chineseDocuments = repoFiles().filter((path) => /^docs\/zh-TW\/|^README\.zh-TW\.md$|^apps\/site\/public\/zh-TW\/.*\.html$/.test(path));
    expect(chineseDocuments.filter((path) => !paired.has(path))).toEqual([]);
    expect(chineseDocuments.length).toBe(PAIRS.length);
  });

  it.each([
    ['docs/HOSTING.md', 'docs/zh-TW/HOSTING.md'],
    ['docs/JOINING.md', 'docs/zh-TW/JOINING.md'],
  ])('%s and %s have the same numbered sections, so a "§5.1" holds in both', (english, chinese) => {
    const numbers = numberedHeadings(english);
    expect(numberedHeadings(chinese)).toEqual(numbers);
    expect(numbers.length).toBeGreaterThan(8);
    const top = numbers.filter((heading) => heading.startsWith('2 ')).map((heading) => Number(heading.slice(2)));
    expect(top).toEqual(top.map((_, index) => index + 1));
  });
});

describe('the two changelogs carry the same sections', () => {
  const english = changelogSections('CHANGELOG.md');
  const chinese = changelogSections('docs/zh-TW/CHANGELOG.md');

  it('the same `## ` headings in the same order: [Unreleased] first when present, then the versions', () => {
    expect(chinese.map((section) => section.heading)).toEqual(english.map((section) => section.heading));
    expect(english.length).toBeGreaterThanOrEqual(3);
    for (const [index, section] of english.entries()) {
      if (section.heading === '[Unreleased]') expect(index).toBe(0);
      else expect(section.heading).toMatch(/^\[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/);
    }
  });

  it('every section, [Unreleased] included, has the same subsections with as many entries each in both languages', () => {
    for (const [index, section] of english.entries()) {
      const other = chinese[index] as ChangelogSection;
      expect({ heading: other.heading, entries: other.entries, paragraphs: other.paragraphs }, section.heading).toEqual({
        heading: section.heading,
        entries: section.entries,
        paragraphs: section.paragraphs,
      });
    }
  });

  it('an [Unreleased] section is never an empty heading in one language and content in the other', () => {
    const unreleased = [english, chinese].map((sections) => sections.find((section) => section.heading === '[Unreleased]'));
    expect(unreleased[0] === undefined).toBe(unreleased[1] === undefined);
    if (unreleased[0] !== undefined && unreleased[1] !== undefined) {
      const total = (section: ChangelogSection): number => section.entries.reduce((sum, count) => sum + count, 0) + section.paragraphs;
      expect(total(unreleased[1]) > 0).toBe(total(unreleased[0]) > 0);
    }
  });
});
