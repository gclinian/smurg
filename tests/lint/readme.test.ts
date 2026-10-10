// The two READMEs are the repository's front door: what a visitor sees before reading anything. This lint holds
// what matters there, in both languages:
//
//   - the head, before the first heading, is the mark and the name, one sentence (the product page's own), one row
//     of links, three badges, the picture and its caption, in that order, and nothing else;
//   - the picture is the script's (readme-picture.test.ts holds the files), described by the product page's own
//     words, and the caption under it says, word for word as on that page, that it is an illustration; a click on
//     it or on the mark leads to the product page, where the same story has tabs and a pause;
//   - the three honest lines stay: a prototype; verified against a scripted stand-in, not with a real Claude
//     account; agents run on the host's computer as the host, with no sandbox, on the host's Claude account. Each
//     with its link into the host guide. They stand at the quick start, where a reader acts, and the quick start has
//     said by then who "the host" is;
//   - the two languages have the same parts in the same order and send their reader to the same places;
//   - every relative link leads to a file of the repository, and every #heading to a heading of that file;
//   - a README stays short: what a developer needs is docs/DEVELOPMENT.md, which keeps the sections other files name.
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PICTURE_DIR, PICTURES, SITE_PAGE, pictureLabel, type PictureLang } from '../../scripts/readme-picture.ts';
import { flat } from './guides.ts';
import { REPO_ROOT, read } from './tree.ts';

const README: Readonly<Record<PictureLang, string>> = { en: 'README.md', 'zh-TW': 'README.zh-TW.md' };
const LANGS: readonly PictureLang[] = ['en', 'zh-TW'];
const MARK = `${PICTURE_DIR}/smurg-mark.svg`;
const INSTALL_LINE = 'curl -fsSL https://smurg.ai/install.sh | sh';
const REPOSITORY = 'https://github.com/gclinian/smurg';
/** A front page, not a manual (the READMEs of the projects this one was modelled on run to about this). */
const MAX_LINES = 130;

/** The site's address of a language, and the folder of its guides in the repository. */
const SITE: Readonly<Record<PictureLang, string>> = { en: 'https://smurg.ai/', 'zh-TW': 'https://smurg.ai/zh-TW/' };
const GUIDES_DIR: Readonly<Record<PictureLang, string>> = { en: 'docs/', 'zh-TW': 'docs/zh-TW/' };
/** The headings of the host guide the honest lines link, per language: what was verified, before you share, the Agent access role. */
const HONEST_LINKS: Readonly<Record<PictureLang, readonly [string, string, string]>> = {
  en: ['docs/HOSTING.md#108-what-was-verified-and-what-was-not', 'docs/HOSTING.md#4-before-you-share', 'docs/HOSTING.md#51-the-agent-access-role-read-this-first'],
  'zh-TW': ['docs/zh-TW/HOSTING.md#108-驗證過什麼還沒驗證什麼', 'docs/zh-TW/HOSTING.md#4-分享前必讀', 'docs/zh-TW/HOSTING.md#51-可使用-agent角色請先讀'],
};
const HONEST_LINES: Readonly<Record<PictureLang, readonly [string, string]>> = {
  en: [
    '**Status: prototype.** Developed and tested on macOS (Apple silicon). The topics flow was verified against a scripted stand-in for the model, not with a real Claude account',
    "Agents run on the host's computer as the host, with no sandbox, on the host's Claude account",
  ],
  'zh-TW': [
    '**狀態：原型**。在 macOS（Apple Silicon）上開發和測試。主題的流程是用照劇本回應的模型替身驗證的，沒有用真正的 Claude 帳號',
    'agent 在主人的電腦上、以主人的身分執行，沒有沙盒，用的是主人的 Claude 帳號',
  ],
};
/** The words of the row of links, in the site's own words for its pages; the other language last, in its own name. */
const ROW: Readonly<Record<PictureLang, readonly (readonly [string, string])[]>> = {
  en: [['https://smurg.ai/', 'Website'], ['https://smurg.ai/docs/quick-start/', 'Quick start'], ['https://smurg.ai/docs/', 'Docs'], ['README.zh-TW.md', '繁體中文']],
  'zh-TW': [['https://smurg.ai/zh-TW/', '網站'], ['https://smurg.ai/zh-TW/docs/quick-start/', '快速上手'], ['https://smurg.ai/zh-TW/docs/', '文件'], ['README.md', 'English']],
};
/**
 * The badges: where each leads and the picture it shows. Only the workflow's own badge may say what CI says; the
 * others state a fact of the repository (its latest release) or the status this README words itself. Three, so that
 * they stay on one row in a phone's column; the license is not one of them (GitHub names it in the same box, and the
 * README's last section does). No count of stars, downloads or users: there is nothing to boast of, and nothing is
 * invented.
 */
const BADGES = (lang: PictureLang): readonly (readonly [string, string])[] => [
  [`${REPOSITORY}/actions/workflows/ci.yml`, `${REPOSITORY}/actions/workflows/ci.yml/badge.svg`],
  [`${REPOSITORY}/releases/latest`, 'https://img.shields.io/github/v/release/gclinian/smurg?label=release'],
  [HONEST_LINKS[lang][0], 'https://img.shields.io/badge/status-prototype-orange.svg'],
];
/** The switch of scripts/dev-stack.sh with which the local stack runs a scripted stand-in and needs no account. */
const STAND_IN_SWITCH = '`--stand-in-claude`';

const text = (lang: PictureLang): string => read(README[lang]);
/** The head of a README: everything before its first `## `. */
const head = (lang: PictureLang): string => text(lang).slice(0, text(lang).indexOf('\n## '));
const pictures = (lang: PictureLang): { light: string; dark: string } => {
  const of = (theme: 'light' | 'dark'): string => `${PICTURE_DIR}/${PICTURES.find((entry) => entry.lang === lang && entry.theme === theme)?.file as string}`;
  return { light: of('light'), dark: of('dark') };
};

/** A text of the product page: tags dropped, a fixed space read as a space. */
function pageText(lang: PictureLang, pattern: RegExp): string {
  const found = pattern.exec(read(SITE_PAGE[lang]))?.[1];
  if (found === undefined) throw new Error(`${SITE_PAGE[lang]} has nothing like ${String(pattern)}`);
  return found.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------------------------- reading Markdown

/** The lines of a document with those inside code fences marked. */
function lines(markdown: string): { line: string; fenced: boolean }[] {
  const out: { line: string; fenced: boolean }[] = [];
  let fence = false;
  for (const line of markdown.split('\n')) {
    const mark = /^\s*```/.test(line);
    out.push({ line, fenced: fence || mark });
    if (mark) fence = !fence;
  }
  return out;
}

/** GitHub's id of a heading (as apps/site/scripts/markdown.ts makes them for the published guides). */
function slugs(markdown: string): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const { line, fenced } of lines(markdown)) {
    const heading = fenced ? null : /^#{1,6} (.*)$/.exec(line);
    if (heading === null) continue;
    const title = (heading[1] as string).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').trim();
    const base = title.toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
    let slug = base;
    while (seen.has(slug)) {
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      slug = `${base}-${count}`;
    }
    seen.set(slug, 0);
    out.push(slug);
  }
  return out;
}

/** Where a document's links and pictures point, in order: Markdown links, and `href`, `src` and `srcset` of its HTML. */
function targets(markdown: string): string[] {
  const out: string[] = [];
  for (const { line, fenced } of lines(markdown)) {
    if (fenced) continue;
    for (const match of line.matchAll(/\]\(([^)\s]+)\)|\b(?:href|src|srcset)="([^"]+)"|<(https:\/\/[^>]+)>/g)) out.push((match[1] ?? match[2] ?? match[3]) as string);
  }
  return out;
}

/** What is wrong with the relative links of `source`: a file that is not there, a heading its file does not have. */
function brokenLinks(source: string): string[] {
  const broken: string[] = [];
  for (const target of targets(read(source))) {
    if (/^https?:\/\//.test(target)) continue;
    const [path = '', fragment] = target.split('#');
    const file = path === '' ? source : posix.normalize(posix.join(posix.dirname(source), path));
    if (file.startsWith('..') || !existsSync(join(REPO_ROOT, file))) broken.push(`${source}: ${target} (no such file)`);
    else if (fragment !== undefined && (!file.endsWith('.md') || !slugs(read(file)).includes(fragment))) broken.push(`${source}: ${target} (no such heading)`);
  }
  return broken;
}

/** A link target without what differs by language: the language's folder, its path on the site, its pictures, a #heading. */
function sameInBothLanguages(target: string): string {
  if (target === 'README.md' || target === 'README.zh-TW.md') return 'the other README';
  if (target.startsWith('https://smurg.ai/')) return target.replace('https://smurg.ai/zh-TW/', 'https://smurg.ai/');
  if (/^https?:\/\//.test(target)) return target;
  const [path = ''] = target.split('#');
  if (path === 'docs/zh-TW/CHANGELOG.md') return 'CHANGELOG.md';
  return path.replace(/^docs\/zh-TW\//, 'docs/').replace(/\.zh-TW\.svg$/, '.svg');
}

/**
 * The parts of a document, in order: headings by depth, paragraphs, list items, numbered steps, table rows, code
 * blocks with their content (what a reader copies is the same in every language; a block under a step is indented
 * with it), quotes, and the HTML it is laid out with.
 */
function skeleton(markdown: string): string[] {
  const out: string[] = [];
  let previous = '';
  let code: string[] | undefined;
  for (const { line, fenced } of lines(markdown)) {
    if (fenced) {
      if (code === undefined) code = [line.trim()];
      else if (/^\s*```\s*$/.test(line)) {
        out.push(`code ${code.join('\n')}`);
        code = undefined;
      } else code.push(line.trim());
      previous = 'code';
      continue;
    }
    const kind =
      line.trim() === '' ? '' :
      /^#{1,6} /.test(line) ? `h${(/^#+/.exec(line) as RegExpExecArray)[0].length}` :
      /^> \[!/.test(line) ? `alert ${line.slice(2)}` :
      /^> /.test(line) ? 'quote' :
      /^- /.test(line) ? 'item' :
      /^\d+\. /.test(line) ? `step ${(/^\d+/.exec(line) as RegExpExecArray)[0]}` :
      /^\|/.test(line) ? 'row' :
      /^\s*<\/?[a-z]/.test(line) ? `html ${[...line.matchAll(/<\/?([a-z0-9]+)/g)].map((match) => match[0]).join('')}` :
      /^\s+\S/.test(line) && (previous === 'item' || previous.startsWith('step')) ? 'more' :
      'text';
    // A paragraph, a quote, a list item and a step count once, however many lines the language wraps them into.
    const continued = (kind === 'text' && (previous === 'text' || previous === 'quote' || previous.startsWith('alert'))) || kind === 'more' || (kind === 'quote' && (previous === 'quote' || previous.startsWith('alert')));
    if (kind !== '' && !continued) out.push(kind);
    previous = kind === 'more' || (kind === 'text' && previous.startsWith('alert')) ? previous : kind;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ head

describe('the head of a README: what a visitor sees without reading', () => {
  it.each(LANGS)('%s: the mark and the name, the product page\'s sentence, the row of links and the badges, in that order', (lang) => {
    const top = head(lang);
    const order = [
      /^<h1 align="center">\n {2}<a href="([^"]+)"><img src="\.github\/assets\/smurg-mark\.svg" width="64" height="64" alt="smurg\.ai"><\/a>\n {2}<br>\n {2}smurg\n<\/h1>\n/,
      /\n<p align="center"><b>([^<\n]+)<\/b><\/p>\n/,
      /\n<p align="center">\n((?: {2}<a href="[^"]+">[^<]+<\/a>(?: ·)?\n){4})<\/p>\n/,
      /\n<p align="center">\n((?: {2}<a href="[^"]+"><img src="[^"]+" alt="[^"]+"><\/a>\n)+)<\/p>\n/,
      /\n<p align="center">\n {2}<a href="[^"]+">\n {4}<picture>\n/,
      /\n<p align="center"><sub>[^<]+<\/sub><\/p>\n$/,
    ];
    const found = order.map((pattern) => pattern.exec(top));
    expect(found.map((match) => match !== null)).toEqual(order.map(() => true));
    const at = found.map((match) => (match as RegExpExecArray).index);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // The mark leads to the product page of the README's language, and the link has a name (GitHub would otherwise
    // wrap the bare picture in a nameless link to its own file).
    expect((found[0] as RegExpExecArray)[1]).toBe(SITE[lang]);
    // The one sentence is the home page's h1: the README and smurg.ai say the same thing of smurg.
    expect(((found[1] as RegExpExecArray)[1] as string).replace(/&nbsp;/g, ' ')).toBe(pageText(lang, /<h1 id="hero-title"[^>]*>([\s\S]*?)<\/h1>/));
    const row = [...((found[2] as RegExpExecArray)[1] as string).matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);
    expect(row).toEqual(ROW[lang]);
    const badges = [...((found[3] as RegExpExecArray)[1] as string).matchAll(/<a href="([^"]+)"><img src="([^"]+)" alt="[^"]+"><\/a>/g)].map((match) => [match[1], match[2]]);
    expect(badges).toEqual(BADGES(lang));
    // Nothing else: six blocks, no heading of a section, no paragraph to read before the picture.
    expect(top.split(/\n\n+/).length).toBe(6);
    expect(top.split('\n').length).toBeLessThanOrEqual(34);
  });

  it.each(LANGS)('%s: the picture is the script\'s, light and dark, described by the product page\'s own words', (lang) => {
    const { light, dark } = pictures(lang);
    const label = pictureLabel(lang);
    expect(label).not.toMatch(/["<>&]/);
    // (a click on it leads to the product page, where the same story can be stepped through and paused)
    expect(head(lang)).toContain(
      `<p align="center">\n  <a href="${SITE[lang]}">\n    <picture>\n      <source media="(prefers-color-scheme: dark)" srcset="${dark}">\n      <img src="${light}" width="830" alt="${label}">\n    </picture>\n  </a>\n</p>\n`,
    );
    // An illustration says it is one, in the alt too (the words are the page's; this holds what they must say).
    expect(label).toMatch(lang === 'en' ? /^Illustration of / : /示意圖/);
    for (const path of [light, dark, MARK]) expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
    // Every picture a README shows is a file of the repository or one of the badges.
    const shown = [...text(lang).matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((match) => match[1] as string);
    expect(shown.sort()).toEqual([MARK, light, dark, ...BADGES(lang).map(([, image]) => image)].sort());
  });

  it.each(LANGS)('%s: directly under the picture, the product page\'s caption word for word: an illustration, not a screenshot', (lang) => {
    const caption = pageText(lang, /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/);
    expect(caption).toMatch(lang === 'en' ? /^An illustration of the app, not a screenshot\./ : /示意圖，不是截圖/);
    expect(head(lang)).toContain(`    </picture>\n  </a>\n</p>\n\n<p align="center"><sub>${caption}</sub></p>`);
  });

  it('the mark is the product page\'s mark, a small picture with nothing in it but shapes', () => {
    const mark = read(MARK);
    expect(mark.length).toBeLessThan(1000);
    expect(mark).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
    expect(mark).not.toMatch(/<(?:script|image|foreignObject|a|style)\b|\bon[a-z]+=|href|url\(/i);
    // The same shapes as the mark the site's pages draw in their top bar.
    const shapes = (svg: string): string[] => [...svg.matchAll(/(?<= )(?:d|x|y|cx|cy|r|rx|width|height)="[^"]+"/g)].map((match) => match[0]).sort();
    const drawn = /<svg class="mark"[^>]*>([\s\S]*?)<\/svg>/.exec(read(SITE_PAGE.en))?.[1] ?? '';
    expect(shapes(drawn).length).toBeGreaterThanOrEqual(12);
    expect(shapes(mark.slice(mark.indexOf('>') + 1))).toEqual(shapes(drawn));
  });
});

// ---------------------------------------------------------------------------------------------------------- honest

describe('the honest lines of a README', () => {
  it.each(LANGS)('%s: at the quick start, one box says prototype, what the flow was verified against, and where agents run, each with its link', (lang) => {
    const body = text(lang);
    const box = /\n> \[!WARNING\]\n((?:> .*\n)+)/.exec(body);
    expect(box).not.toBeNull();
    const said = ((box as RegExpExecArray)[1] as string).replace(/^> /gm, '');
    const plain = flat(said.replace(/\]\([^)]*\)/g, ']').replace(/[[\]]/g, ''));
    for (const line of HONEST_LINES[lang]) expect(flat(said.replace(/\]\([^)]*\)/g, ']').replace(/[[\]]/g, '')), line).toContain(flat(line));
    expect(targets(said)).toEqual(HONEST_LINKS[lang]);
    // A box a visitor reads at a glance, not a list of limits (those are in the guide the box links).
    expect(plain.length).toBeLessThanOrEqual(lang === 'en' ? 380 : 170);
    // It stands where the reader acts: after the two commands of the quick start, before anything else is promised.
    const sections = body.split(/\n(?=## )/);
    expect(sections[1]).toContain(INSTALL_LINE);
    expect(sections[1]).toContain('> [!WARNING]');
    expect((sections[1] as string).indexOf(INSTALL_LINE)).toBeLessThan((sections[1] as string).indexOf('> [!WARNING]'));
    // The box speaks of "the host": the quick start has told the reader, before it, that this is them.
    const introduced = (sections[1] as string).indexOf(lang === 'en' ? 'one for you, the host,' : '一個給你自己（分享資料夾的人，以下叫主人）');
    expect(introduced).toBeGreaterThan(0);
    expect(introduced).toBeLessThan((sections[1] as string).indexOf('> [!WARNING]'));
    // And it is the only place a README words the status: nothing further down softens it.
    expect(body.match(lang === 'en' ? /\bprototype\b(?!-)/gi : /原型/g)).toHaveLength(2);
    expect(body.match(lang === 'en' ? /Status: prototype/g : /狀態：原型/g)).toHaveLength(2);
  });

  it.each(LANGS)('%s: nothing a guide does not back: no numbers of users or stars, no other product named, no word that promises safety', (lang) => {
    const body = text(lang);
    expect(body).not.toMatch(/\bstars?\b|\busers\b|downloads|trusted by|production[- ]ready|\bsecure\b|\bsandboxed\b|isolat/i);
    expect(body).not.toMatch(/Cursor|Copilot|Codex|Devin|Windsurf|OpenHands|Aider/i);
    expect(body).not.toMatch(/使用者數|星星|最安全|隔離|proprietary|專有軟體|原始碼不公開|private repository|私人 repository|OPEN-QUESTIONS|v0\.1\.0|0\.2\.0/i);
  });
});

// ------------------------------------------------------------------------------------------------------- two languages

describe('the two READMEs are one README in two languages', () => {
  it('the same parts in the same order, with the same commands', () => {
    const english = skeleton(text('en'));
    const chinese = skeleton(text('zh-TW'));
    expect(chinese).toEqual(english);
    expect(english.filter((part) => part === 'h2')).toHaveLength(6);
    expect(english.filter((part) => part.startsWith('code '))).toEqual([`code \`\`\`sh\n${INSTALL_LINE}`, 'code ```sh\nsmurg host ~/projects/my-app']);
    // The quick start is numbered steps, the first two with their command: install, share, send the link, open yours.
    const quick = english.slice(english.indexOf('h2'), english.indexOf('alert [!WARNING]'));
    expect(quick.filter((part) => part.startsWith('step') || part.startsWith('code'))).toEqual(['step 1', `code \`\`\`sh\n${INSTALL_LINE}`, 'step 2', 'code ```sh\nsmurg host ~/projects/my-app', 'step 3', 'step 4']);
    expect(english.filter((part) => part.startsWith('step'))).toHaveLength(4);
    expect(english.filter((part) => part.startsWith('alert'))).toEqual(['alert [!WARNING]']);
  });

  it('the same links in the same order, each language to its own guides and its own pages of the site', () => {
    const english = targets(text('en'));
    const chinese = targets(text('zh-TW'));
    expect(chinese.map(sameInBothLanguages)).toEqual(english.map(sameInBothLanguages));
    expect(english.length).toBeGreaterThan(30);
    for (const lang of LANGS) {
      const other = lang === 'en' ? 'zh-TW' : 'en';
      const own = targets(text(lang));
      // The user guides, the quick start and the changelog are read in the README's own language.
      for (const guide of ['QUICKSTART.md', 'HOSTING.md', 'JOINING.md']) expect(own, `${README[lang]} -> ${guide}`).toContain(`${GUIDES_DIR[lang]}${guide}`);
      expect(own).toContain(lang === 'en' ? 'CHANGELOG.md' : 'docs/zh-TW/CHANGELOG.md');
      expect(own.filter((target) => target.startsWith(GUIDES_DIR['zh-TW'])).length > 0).toBe(lang === 'zh-TW');
      expect(own.filter((target) => target.startsWith('https://smurg.ai/')).every((target) => target.startsWith(SITE['zh-TW']) === (lang === 'zh-TW'))).toBe(true);
      expect(own.filter((target) => target === README[other])).toHaveLength(1);
      // What only exists in English is linked from both, and the Chinese README says so.
      for (const english of ['CONTRIBUTING.md', 'docs/DEVELOPMENT.md', 'SECURITY.md', 'LICENSE']) expect(own, `${README[lang]} -> ${english}`).toContain(english);
    }
    expect(text('zh-TW').match(/英文/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it.each(LANGS)('%s: every relative link leads to a file of the repository, and every #heading is a heading of it', (lang) => {
    expect(brokenLinks(README[lang])).toEqual([]);
  });

  it.each(LANGS)('%s: a front page: short, the install line early, the built-in relay and the license named', (lang) => {
    const body = text(lang);
    const all = body.split('\n');
    expect(all.length).toBeLessThanOrEqual(MAX_LINES);
    // (the command stands under the first step of the quick start, indented with it)
    expect(all.findIndex((line) => line.trim() === INSTALL_LINE)).toBeLessThan(45);
    expect(all.findIndex((line) => line.trim() === INSTALL_LINE)).toBeGreaterThan(0);
    expect(all.filter((line) => line.trim() === INSTALL_LINE)).toEqual([`   ${INSTALL_LINE}`]);
    // The local stack needs no account only with the switch that gives it a scripted stand-in: whoever reads that it
    // needs none reads the switch with it.
    const noAccount = (lang === 'en' ? /a local stack that needs no account when it is started with (\S+)/ : /把整套系統跑起來（加上 (\S+) 就不需要帳號/).exec(body);
    expect(noAccount?.[1]).toBe(STAND_IN_SWITCH);
    expect(read('scripts/dev-stack.ts')).toMatch(new RegExp(`\\n  ${STAND_IN_SWITCH.replace(/\`/g, '')} +agent sessions run a scripted stand-in for Claude Code: no account,`));
    for (const needed of ['https://app.smurg.ai', 'MIT', '[`LICENSE`](LICENSE)', `${REPOSITORY}/issues`]) expect(body, needed).toContain(needed);
  });

  it.each(LANGS)('%s: the folded command table has one line per command and points at --help instead of repeating it', (lang) => {
    const body = text(lang);
    const folded = /<details>\n<summary>[^\n]*<code>smurg<\/code>[^\n]*<\/summary>\n([\s\S]*?)\n<\/details>/.exec(body)?.[1] ?? '';
    const rows = folded.split('\n').filter((line) => line.startsWith('| `smurg '));
    expect(rows.map((row) => /^\| `smurg (\w+)/.exec(row)?.[1])).toEqual(['host', 'attach', 'status', 'login', 'update', 'uninstall', 'licenses']);
    for (const row of rows) expect(row.length, row).toBeLessThan(160);
    for (const command of ['stop', 'logout']) expect(folded).toContain(`\`smurg ${command}\``);
    expect(folded).toMatch(lang === 'en' ? /`smurg <command> --help`/ : /`smurg <指令> --help`/);
  });
});

// ------------------------------------------------------------------------------------------- what left the README

describe('what a developer needs is docs/DEVELOPMENT.md', () => {
  const DEVELOPMENT = 'docs/DEVELOPMENT.md';

  it('it keeps the sections that left the README, under the names other files call them by', () => {
    const headings = lines(read(DEVELOPMENT)).flatMap(({ line, fenced }) => (fenced ? [] : (/^#{2,3} (.*)$/.exec(line) ?? []).slice(1)));
    expect(headings).toEqual([
      'Developing from source',
      'Layout',
      'Checks and common commands',
      'Local development',
      'Keeping smurg from opening a browser',
      'The `smurg` command',
      'Packaging and releasing',
      'Third-party notices',
      "The README's picture",
      'Documents',
    ]);
    // Whoever names a section of it names one it has.
    for (const source of ['CONTRIBUTING.md', 'scripts/dev-stack.sh', 'scripts/dev-stack.ts']) {
      // (a comment's line may end between the file and the section: `#` and `//` at the start of a line are its margin)
      const named = [...read(source).matchAll(/docs\/DEVELOPMENT\.md`?,\s+(?:(?:#|\/\/)\s+)?"([^"]+)"/g)].map((match) => (match[1] as string).replace(/\s+/g, ' '));
      expect(named, source).toHaveLength(read(source).match(/docs\/DEVELOPMENT\.md`?,/g)?.length ?? 0);
      expect(named.length, source).toBeGreaterThanOrEqual(1);
      for (const name of named) expect(headings, `${source}: "${name}"`).toContain(name);
    }
    // And nobody sends a reader to a section of the README that is no longer there.
    for (const source of ['CONTRIBUTING.md', 'scripts/dev-stack.sh', 'scripts/dev-stack.ts', DEVELOPMENT]) expect(read(source), source).not.toMatch(/\(README, "|The rest is for developers/);
  });

  it('its links and those of CONTRIBUTING.md lead to files and headings of the repository', () => {
    expect([...brokenLinks(DEVELOPMENT), ...brokenLinks('CONTRIBUTING.md')]).toEqual([]);
    // Every document of the repository is in its table, the guides in both languages.
    const table = targets(read(DEVELOPMENT).slice(read(DEVELOPMENT).indexOf('\n## Documents\n')));
    for (const document of ['QUICKSTART.md', 'HOSTING.md', 'JOINING.md', 'zh-TW/QUICKSTART.md', 'zh-TW/HOSTING.md', 'zh-TW/JOINING.md', '../CHANGELOG.md', 'zh-TW/CHANGELOG.md', 'ARCHITECTURE.md', 'GLOSSARY.md', 'ACCEPTANCE.md', 'RELEASING.md', '../SPEC.md', '../apps/relay/README.md', '../apps/site/README.md', '../CONTRIBUTING.md', '../SECURITY.md']) {
      expect(table, document).toContain(document);
    }
  });
});
