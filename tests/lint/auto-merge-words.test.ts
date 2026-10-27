// Automatic merging (0.7.0, DESIGN D5, D20, D21): smurg merges a work item when its RESULT REPORT says complete, at
// least one check passed and none failed. The checks are what the agent reports: smurg runs none of them, and a model
// that writes "complete" over unfinished work is merged all the same (DESIGN §3 point 4). So no text people read may
// say that smurg verifies or tests the work, and none may say that the work itself is complete and verified: every
// sentence that tells people what smurg merges says it is the report's claim ("what its report says is complete and
// verified", 「報告寫著完成且驗證過的」). Read here, in both languages: the catalogs (the wire's, the web app's, the
// CLI's), the guides, the quick start, the two short pages, the glossary, the READMEs, the product pages, the site's
// own words, and the changelogs' sections from 0.7.0 on. docs/GLOSSARY.md names the forbidden phrases to forbid them
// (so the first rule does not read it), and its row that defines "complete and verified" is the one place the bare
// term stands.
import { describe, expect, it } from 'vitest';
import { flat } from './guides.ts';
import { read, repoFiles } from './tree.ts';

/** "smurg verifies", "smurg tests", "smurg runs the checks", and the like. */
const VERIFIES_EN = /\bsmurg\s+(?:(?:also|itself|then|always|first)\s+)?(?:verifies|tests|re-?runs\s+(?:the\s+|its\s+|each\s+|every\s+|all\s+)?(?:checks?|tests?)|runs\s+(?:the\s+|its\s+|each\s+|every\s+|all\s+(?:the\s+)?)?(?:checks?|tests?))\b/i;
/**
 * 「smurg 驗證」「smurg 測試」「smurg 執行檢查」, and the like. (Not what smurg's developers verified smurg with: 「這個 smurg
 * 驗證過的版本」, 「尚未經過 smurg 驗證」 are about the Claude Code versions smurg was verified with.)
 */
const VERIFIES_ZH = /(?<!經過\s*)smurg\s*(?:會|也會|自己)?(?:驗證(?!過的(?:最低)?版本|過的還新)|測試|執行(?:這些|每一項|所有的?)?(?:檢查|驗證|測試))/;
/** The work said to be complete and verified (allowed only in a sentence that says it is what a report says). */
const BARE_EN = /\b(?:is|are)\s+complete\s+and\s+verified\b|\bcomplete\s+and\s+verified,\s+(?:is|are)\s+merged\b/i;
const BARE_ZH = /完成且驗證過/;
const REPORT_EN = /\breports?\b|\breport's\b/i;
const REPORT_ZH = /報告/;

/** The changelogs' sections of 0.7.0 and later, and an [Unreleased] section. */
function changelogFrom070(path: string): string {
  const out: string[] = [];
  let keep = false;
  for (const line of read(path).split('\n')) {
    const heading = /^## \[(Unreleased|(\d+)\.(\d+)\.(\d+))\]/.exec(line);
    if (heading !== null) keep = heading[1] === 'Unreleased' || Number(heading[2]) > 0 || Number(heading[3]) >= 7;
    else if (/^## /.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.join('\n');
}

const GLOSSARY = 'docs/GLOSSARY.md';
/** The glossary's row that defines the term: the one place it stands without "report" around it. */
const DEFINITION_ROW = /^\| What a report must say for smurg to merge it \|.*$/m;

interface Source {
  readonly path: string;
  /** The units a sentence cannot cross: a catalog's string literals, a document's table cells and paragraphs. */
  readonly units: readonly string[];
}

/** The string literals of a catalog source: a sentence never runs from one message into the next. */
function literals(source: string): string[] {
  return [...source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((match) => (match[1] ?? match[2] ?? match[3] ?? '').replaceAll("\\'", "'"));
}

/** A document's paragraphs, list items and table cells (a cell is never part of its neighbour's sentence). */
function blocks(source: string): string[] {
  return source
    .replace(/<[^>]+>/g, (tag) => {
      // keep what a picture and a page say in their attributes (an aria-label, an alt text, a description)
      const said = [...tag.matchAll(/\b(?:aria-label|alt|content|title)="([^"]*)"/g)].map((match) => match[1]);
      return said.length === 0 ? '\n\n' : `\n\n${said.join('\n\n')}\n\n`;
    })
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)|\|/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
}

function sources(): Source[] {
  const files = repoFiles();
  const catalogs = files.filter(
    (path) =>
      /^packages\/protocol\/src\/i18n\/messages\/[a-z]+\.ts$/.test(path) ||
      /^apps\/web\/src\/(?:strings\/[a-z]+|features\/[a-z]+\/strings)(?:\.zh-TW)?\.ts$/.test(path) ||
      /^packages\/cli\/src\/i18n\/(?:en|zh-TW)\.ts$/.test(path) ||
      path === 'apps/site/scripts/site.ts',
  );
  const documents = [
    'README.md',
    'README.zh-TW.md',
    ...['QUICKSTART', 'HOW-IT-WORKS', 'HOSTING', 'JOINING', 'SECURITY-MODEL'].flatMap((name) => [`docs/${name}.md`, `docs/zh-TW/${name}.md`]),
    GLOSSARY,
    'apps/site/public/index.html',
    'apps/site/public/zh-TW/index.html',
  ];
  return [
    ...catalogs.map((path) => ({ path, units: literals(read(path)) })),
    ...documents.map((path) => ({ path, units: blocks(path === GLOSSARY ? read(path).replace(DEFINITION_ROW, '') : read(path)) })),
    ...['CHANGELOG.md', 'docs/zh-TW/CHANGELOG.md'].map((path) => ({ path: `${path} (0.7.0 and later)`, units: blocks(changelogFrom070(path)) })),
  ];
}

/** The sentences of a unit, read as one line (a sentence that a document wraps is one sentence). */
function sentences(unit: string): string[] {
  return flat(unit)
    .split(/(?<=[.!?])\s+(?=[A-Z"(「])|(?<=[。！？])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function bareClaims(sentence: string): boolean {
  return (BARE_EN.test(sentence) && !REPORT_EN.test(sentence)) || (BARE_ZH.test(sentence) && !REPORT_ZH.test(sentence));
}

describe('no text says that smurg verifies the work, or that the work itself is complete and verified (DESIGN 0.7.0 D20)', () => {
  it('the lint reads the catalogs and the documents it names, and its patterns find what they are for', () => {
    const read = sources();
    expect(read.filter(({ path }) => path.includes('/i18n/messages/')).length).toBeGreaterThanOrEqual(10);
    expect(read.filter(({ path }) => /strings(?:\.zh-TW)?\.ts$/.test(path)).length).toBeGreaterThanOrEqual(20);
    expect(read.filter(({ path }) => !path.includes('CHANGELOG')).every(({ units }) => units.length > 0)).toBe(true);
    for (const claim of ['smurg verifies each item before it merges it', 'smurg tests the change', 'smurg runs the checks', 'smurg also runs every test']) expect(claim).toMatch(VERIFIES_EN);
    for (const claim of ['smurg 驗證每一個項目', 'smurg 會測試這次變更', 'smurg 執行檢查']) expect(claim).toMatch(VERIFIES_ZH);
    // What the texts do say is not caught: smurg runs none of the checks; this smurg was verified with a version.
    for (const fine of ['smurg runs none of them', "smurg's developers verified it", 'this smurg was verified with Claude Code 2.1.288', 'smurg checks the report format']) expect(fine).not.toMatch(VERIFIES_EN);
    for (const fine of ['smurg 不會執行它們', '這個 smurg 有沒有驗證過這個版本', '版本比這個 smurg 驗證過的還新時', '低於 smurg 驗證過的最低版本', '尚未經過 smurg 驗證', 'smurg 會檢查報告的格式']) expect(fine).not.toMatch(VERIFIES_ZH);
    for (const claim of ['The work is complete and verified, so smurg merges it.', 'Items that are complete and verified merge by themselves.', '每個完成且驗證過的工作項目都會自己合併。']) {
      expect(sentences(claim).some(bareClaims), claim).toBe(true);
    }
    for (const fine of [
      'smurg merges what its report says is complete and verified.',
      'smurg merges it when its report says it is complete and verified; anything else waits for a person.',
      '報告寫著完成且驗證過的，由 smurg 合併。',
      'A report that is not complete and verified is a decision.',
    ]) {
      expect(sentences(fine).some(bareClaims), fine).toBe(false);
    }
  });

  it('no catalog text, guide, page or changelog of 0.7.0 says that smurg verifies or tests the work', () => {
    const found = sources()
      .filter(({ path }) => path !== GLOSSARY)
      .flatMap(({ path, units }) =>
        units.flatMap((unit) => {
          const one = flat(unit);
          return [VERIFIES_EN, VERIFIES_ZH].flatMap((pattern) => {
            const at = new RegExp(pattern.source, `${pattern.flags}g`);
            return [...one.matchAll(at)].map((match) => `${path}: …${one.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60)}…`);
          });
        }),
      );
    expect(found).toEqual([]);
  });

  it('every sentence that says "complete and verified" of what smurg merges says it is what the report says', () => {
    const found = sources().flatMap(({ path, units }) => units.flatMap((unit) => sentences(unit).filter(bareClaims).map((sentence) => `${path}: ${sentence}`)));
    expect(found).toEqual([]);
    // The term is used, in both languages: a lint that read nothing would pass.
    const all = sources().flatMap(({ units }) => units.flatMap(sentences));
    expect(all.filter((sentence) => /complete and verified/i.test(sentence)).length).toBeGreaterThanOrEqual(10);
    expect(all.filter((sentence) => BARE_ZH.test(sentence)).length).toBeGreaterThanOrEqual(10);
  });

  it('the glossary defines the term once, as what the report says', () => {
    const row = DEFINITION_ROW.exec(read(GLOSSARY))?.[0] ?? '';
    expect(row).toContain('complete and verified: the report says complete, at least one check passed, none failed');
    expect(row).toContain('完成且驗證過：報告寫著完成、至少一項驗證通過、沒有驗證失敗');
  });
});
