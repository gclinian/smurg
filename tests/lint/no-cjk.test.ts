// English is the language of the source tree (DESIGN A.1 rule 7, A.11): no file outside a zh-TW catalog or a zh-TW
// document contains CJK. "CJK" is Han, Bopomofo, CJK punctuation and the full-width forms; whole lines count, comments
// included. The places that hold zh-TW are listed here, each with the rule its Chinese lines must follow, so that a
// Chinese sentence anywhere else (a comment quoting an old label, a string that skipped the catalog, a test title)
// fails with its file and line.
import { describe, expect, it } from 'vitest';
import { CJK, isTestFile, read, repoFiles } from './tree.ts';

/** Each language is named in its own language everywhere (docs/GLOSSARY.md): the one Chinese string English text may hold. */
const LANGUAGE_NAME = '繁體中文';

/** Whole files in zh-TW (or holding the original zh-TW wording by design). */
const ZH_TW_FILES: readonly RegExp[] = [
  /\.zh-TW\.ts$/, // the web app's zh-TW tables
  /^packages\/cli\/src\/i18n\/zh-TW\.ts$/,
  /^docs\/zh-TW\//,
  /^README\.zh-TW\.md$/,
  /^apps\/site\/public\/zh-TW\//,
  /^SPEC\.md$/, // the original requirements (one English line on top says so)
  /^docs\/GLOSSARY\.md$/, // the two columns of the binding terms
  /^docs\/research\//, // historical research reports: they quote the UI of their time
  /^docs\/design\//, // the design of a release as it was written, with its mock: it quotes the zh-TW wording it decides
];

type LineRule = (line: string, index: number, lines: readonly string[]) => boolean;

/** The start line of the `'zh-TW': {` block that encloses line `index`, by indentation; -1 when there is none. */
function inZhTwBlock(lines: readonly string[], index: number): boolean {
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  let indent = indentOf(lines[index] as string);
  for (let i = index; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    if (indentOf(line) < indent || i === index) {
      if (/^\s*(?:'zh-TW'|"zh-TW"|zhTW)\s*[:=]/.test(line) || /^\s*'zh-TW':/.test(line)) return true;
      if (i !== index) indent = indentOf(line);
    }
  }
  return false;
}

/** Files that hold both languages: a Chinese line must be in the zh-TW half. */
const MIXED_FILES: readonly { file: RegExp; rule: LineRule; says: string }[] = [
  {
    file: /^packages\/protocol\/src\/i18n\/messages\/[a-z]+\.ts$/,
    rule: (line, index, lines) => /'zh-TW':/.test(line) || inZhTwBlock(lines, index),
    says: "inside a 'zh-TW': form",
  },
  {
    file: /^apps\/relay\/src\/lib\/strings\.ts$/,
    rule: (line, index, lines) => inZhTwBlock(lines, index) || (/LANGUAGE_NAMES/.test(line) && line.includes(LANGUAGE_NAME)),
    says: "inside the 'zh-TW': { … } table",
  },
  {
    file: /^apps\/site\/scripts\/site\.ts$/,
    rule: (line, index, lines) => /'zh-TW':/.test(line) || inZhTwBlock(lines, index),
    says: "inside a 'zh-TW' entry of the site's tables",
  },
  {
    // An English page of the site names the other language in that language, in an element that says so.
    file: /^apps\/site\/public\/(?!zh-TW\/).*\.html$/,
    rule: (line) => !CJK.test(line.replace(/<a\b[^>]*\blang="zh-Hant-TW"[^>]*>[^<]*<\/a>/g, '')),
    says: 'the text of a link marked lang="zh-Hant-TW"',
  },
  {
    file: /^scripts\/install\.sh$/,
    // msg 'english %s' '中文 %s' args… (and failf): the Chinese is the second argument, on the same line.
    rule: (line) => {
      const call = /(?:^|[\s;|&(])(?:msg|failf) '((?:[^']|'\\'')*)' '/.exec(line);
      return call !== null && !CJK.test(line.slice(0, call.index)) && !CJK.test(call[1] as string);
    },
    says: 'the second argument of msg / failf, after an English first argument',
  },
];

function titleLine(line: string): boolean {
  return /^\s*(?:describe|it|test)(?:\.[A-Za-z]+)*(?:\([^)]*\))?\s*\(\s*['"`]/.test(line) || /^\s*(?:describe|it|test)\.each\b/.test(line);
}

interface Hit {
  readonly at: string;
  readonly why: string;
}

function scan(): { hits: Hit[]; files: number; zhFiles: number } {
  const hits: Hit[] = [];
  let files = 0;
  let zhFiles = 0;
  for (const path of repoFiles()) {
    if (ZH_TW_FILES.some((pattern) => pattern.test(path))) {
      zhFiles += 1;
      continue;
    }
    files += 1;
    const text = read(path);
    if (!CJK.test(text)) continue;
    const lines = text.split('\n');
    const mixed = MIXED_FILES.find((entry) => entry.file.test(path));
    const test = isTestFile(path);
    lines.forEach((line, index) => {
      if (!CJK.test(line)) return;
      const at = `${path}:${index + 1}: ${line.trim().slice(0, 120)}`;
      if (mixed !== undefined) {
        if (!mixed.rule(line, index, lines)) hits.push({ at, why: `Chinese text must be ${mixed.says}` });
        return;
      }
      if (test) {
        if (titleLine(line)) hits.push({ at, why: 'test titles are English (the data of a test may be Chinese)' });
        return;
      }
      if (!CJK.test(line.replaceAll(LANGUAGE_NAME, ''))) return;
      hits.push({ at, why: 'no CJK outside the zh-TW catalogs and documents' });
    });
  }
  return { hits, files, zhFiles };
}

describe('no CJK outside the zh-TW catalogs and documents (DESIGN A.11)', () => {
  const result = scan();

  it('reads the tree', () => {
    expect(result.files).toBeGreaterThan(500);
    expect(result.zhFiles).toBeGreaterThan(15);
    // The places the rules name exist (a renamed file would silently lose its rule).
    for (const entry of MIXED_FILES) expect(repoFiles().some((path) => entry.file.test(path)), String(entry.file)).toBe(true);
  });

  it('source, scripts, workflows, English documents and test titles hold no Chinese text', () => {
    expect(result.hits.map((hit) => `${hit.at}\n    -> ${hit.why}`)).toEqual([]);
  });

  it('the rules themselves: what counts as CJK and where a mixed file may hold it', () => {
    expect(CJK.test('主人')).toBe(true);
    expect(CJK.test('（')).toBe(true);
    expect(CJK.test('、')).toBe(true);
    expect(CJK.test('ㄅ')).toBe(true);
    expect(CJK.test('Agent access — “quoted” … § → ✓')).toBe(false);
    const install = MIXED_FILES.find((entry) => entry.file.test('scripts/install.sh'))?.rule as LineRule;
    expect(install("  msg 'Installed %s' '已安裝 %s' \"$v\"", 0, [])).toBe(true);
    expect(install("  FAIL_CODE=2 failf 'unknown option: %s' '不認識的選項：%s' \"$1\"", 0, [])).toBe(true);
    expect(install("  echo '已安裝'", 0, [])).toBe(false);
    expect(install("  msg '已安裝 %s' '已安裝 %s'", 0, [])).toBe(false);
    expect(install("  [ -d \"$dir\" ] || failf 'cannot create %s' '無法建立 %s' \"$dir\"", 0, [])).toBe(true);
    expect(titleLine("  it('主人離線', () => {")).toBe(true);
    expect(titleLine("    expect(text).toBe('主人離線');")).toBe(false);
  });
});
