// The smurg.ai site as files: public/ (the hand-written pages) plus the pages generated from the repository at build
// time. scripts/build.ts writes them into dist/, the static-assets directory of wrangler.jsonc.
//
//   English                    Traditional Chinese             source
//   /docs/                     /zh-TW/docs/                    the docs index (CHROME below)
//   /docs/quick-start/         /zh-TW/docs/quick-start/        docs/QUICKSTART.md   docs/zh-TW/QUICKSTART.md
//   /docs/hosting/             /zh-TW/docs/hosting/            docs/HOSTING.md      docs/zh-TW/HOSTING.md
//   /docs/joining/             /zh-TW/docs/joining/            docs/JOINING.md      docs/zh-TW/JOINING.md
//   /docs/changelog/           /zh-TW/docs/changelog/          CHANGELOG.md         docs/zh-TW/CHANGELOG.md
//   /license/                  /zh-TW/license/                 LICENSE (the zh-TW page introduces the English text)
//   /third-party-notices.txt                                   the executable's complete notices (see readNotices)
//   /sitemap.xml                                               every page above and the two home pages, with alternates
//                                                              and, where git knows it, the day its source last changed
//   /llms.txt                                                  what smurg is and where its documents are, as text for
//                                                              the assistants people ask (see llmsTxt)
//
// What a search result shows of a page is written here too: its `<title>`, its description and its structured data
// (DOC_PAGES, CHROME, structured data below); README.md, "Being found", says what each is for.
//
// Every page names its counterpart in the other language (`<link rel="alternate" hreflang>` and the language link).
// A link between two published files stays inside the site; a link to any other file of the repository (ARCHITECTURE,
// the relay's README, SPEC, …) goes to that file on GitHub; a link that is not https becomes its plain text.
// generateSite() fails, listing every problem, rather than produce a site with a broken link, a link to a repository
// file that does not exist, a heading id the docs cannot reach or no third-party notices.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { REDIRECTS, REPOSITORY } from '../src/routes.ts';
import { escapeHtml, renderMarkdown, type Heading, type LinkDecision, type LinkRecord } from './markdown.ts';

export const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = resolve(SITE_ROOT, '..', '..');
export const PUBLIC_DIR = join(SITE_ROOT, 'public');
/** wrangler.jsonc `assets.directory`. */
export const DIST_DIR = join(SITE_ROOT, 'dist');
export const ORIGIN = 'https://smurg.ai';
/** Where a link to a repository file that is not published on the site goes. */
export const REPOSITORY_FILES = `${REPOSITORY}/blob/main/`;
export const REPOSITORY_DIRS = `${REPOSITORY}/tree/main/`;

/** The executable's committed third-party notices, relative to the repository; its Node.js section is a placeholder. */
export const COMMITTED_NOTICES = 'packages/cli/THIRD-PARTY-NOTICES.txt';
/** Writes the executable's complete notices (the committed file with the Node.js LICENSE filled in) to stdout. */
export const NOTICES_COMMAND = ['scripts/third-party-notices.ts', '--executable'] as const;
/** The text of the committed file's unfilled Node.js section: notices that still contain it are not complete. */
export const NOTICES_PLACEHOLDER = 'In the copy of this file that is built';
/** The first line of the Node.js LICENSE, which the complete notices carry after `node@X.Y.Z (the Node.js runtime)`. */
export const NODE_LICENSE_START = 'Node.js is licensed for use as follows:';
/** Environment: a notices file to publish instead (the release's own THIRD-PARTY-NOTICES.txt; the tests' fixture). */
export const NOTICES_ENV = 'SMURG_SITE_THIRD_PARTY_NOTICES';
/** Environment: read docs/, CHANGELOG.md and LICENSE from this directory instead of the repository (tests only). */
export const SOURCE_ROOT_ENV = 'SMURG_SITE_SOURCE_ROOT';
/** Environment: `1` accepts notices that are not the release's (tests, local previews; never a deploy). */
export const PLACEHOLDER_ENV = 'SMURG_SITE_ALLOW_PLACEHOLDER';

export const NOTICES_FILE = '/third-party-notices.txt';
export const SITEMAP_FILE = '/sitemap.xml';
/** What smurg is and where its documents are, as plain text for the assistants people ask instead of searching. */
export const LLMS_FILE = '/llms.txt';
/** The web app's own notices (apps/web/public/third-party-notices.txt, served by the relay). */
export const WEB_APP_NOTICES = 'https://app.smurg.ai/third-party-notices.txt';

// ---- languages ----

export type Lang = 'en' | 'zh-TW';
/** English first: it is the default (`x-default`) of every pair of pages. */
export const LANGS: readonly Lang[] = ['en', 'zh-TW'];
/** The `lang` of a page and the `hreflang` of a link to it. */
export const HTML_LANG: Readonly<Record<Lang, string>> = { en: 'en', 'zh-TW': 'zh-Hant-TW' };
/** The path prefix of a language's pages. */
export const LANG_PREFIX: Readonly<Record<Lang, string>> = { en: '', 'zh-TW': '/zh-TW' };

export const otherLang = (lang: Lang): Lang => (lang === 'en' ? 'zh-TW' : 'en');
export const homePage = (lang: Lang): string => `${LANG_PREFIX[lang]}/`;
export const docsIndex = (lang: Lang): string => `${LANG_PREFIX[lang]}/docs/`;
export const licensePage = (lang: Lang): string => `${LANG_PREFIX[lang]}/license/`;
const changelogPage = (lang: Lang): string => `${LANG_PREFIX[lang]}/docs/changelog/`;

export interface SocialCard {
  /** Where the PNG is served (a file of public/). */
  readonly path: string;
  /** The home page's h1, one entry per line of the picture (test/site.test.ts holds the words equal). */
  readonly lines: readonly string[];
  /** The small labels at the foot of the picture. */
  readonly chips: readonly string[];
  /** `og:image:alt`: what the picture says. */
  readonly alt: string;
}

/** The size of a preview picture: what LinkedIn, Slack, iMessage and LINE show whole (1.91 : 1). */
export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 } as const;

/**
 * The picture a link to a page of the site shows in LinkedIn, Slack, iMessage, LINE, WhatsApp, … (Open Graph
 * `og:image`, `twitter:image`): one PNG per language, drawn by scripts/social-card.ts from these words. Every page
 * of a language names its language's picture; the 404 pages name none.
 */
export const SOCIAL_CARD: Readonly<Record<Lang, SocialCard>> = {
  en: {
    path: '/og.png',
    lines: ['A real-time workspace for', 'your team and Claude Code.'],
    chips: ['Open source · MIT', 'macOS and Linux', 'End-to-end encrypted'],
    alt: 'smurg: a real-time workspace for your team and Claude Code.',
  },
  'zh-TW': {
    path: '/zh-TW/og.png',
    lines: ['給團隊和 Claude Code', '用的即時協作工作區。'],
    chips: ['開放原始碼 · MIT', 'macOS 與 Linux', '端對端加密'],
    alt: 'smurg：給團隊和 Claude Code 用的即時協作工作區。',
  },
};

/** The `<meta>` lines that name a language's preview picture (the two home pages carry the same lines by hand). */
export function socialCardMeta(lang: Lang): string {
  const card = SOCIAL_CARD[lang];
  const url = `${ORIGIN}${card.path}`;
  return [
    `<meta property="og:image" content="${url}">`,
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${SOCIAL_CARD_SIZE.width}">`,
    `<meta property="og:image:height" content="${SOCIAL_CARD_SIZE.height}">`,
    `<meta property="og:image:alt" content="${escapeHtml(card.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${url}">`,
    `<meta name="twitter:image:alt" content="${escapeHtml(card.alt)}">`,
  ].join('\n');
}

export interface DocSource {
  /** The Markdown file, relative to the repository. */
  readonly source: string;
  /** Where it is served. */
  readonly path: string;
  readonly label: string;
  /** One line for the docs index. */
  readonly summary: string;
  /**
   * The page's `<title>`, before " · smurg": the first line of a search result. It starts as the document's own
   * heading does (the h1 stays the Markdown's) and goes on with the words people search for; with " · smurg" it
   * fits a result's line (test/site.test.ts bounds it).
   */
  readonly title: string;
  /**
   * The description meta tag: what a search result shows under the title. Written, one or two sentences that a
   * result shows whole (about 920 px of its 14 px text: 120 to 146 Latin characters, or 50 to 66 Chinese ones; the
   * test bounds it, README.md "Being found" says how to measure one), never the start of the page cut off. Only what
   * the document itself says.
   */
  readonly description: string;
  /** What the page is in its structured data (schema.org): a guide is a TechArticle, the changelog a plain WebPage. */
  readonly schema: 'TechArticle' | 'WebPage';
}

/** A document of the docs, in both languages. */
export type DocPage = Readonly<Record<Lang, DocSource>>;

/** In the order of the docs index and the docs navigation: the quick start first, then the two guides it links. */
export const DOC_PAGES: readonly DocPage[] = [
  {
    en: {
      source: 'docs/QUICKSTART.md',
      path: '/docs/quick-start/',
      label: 'Quick start',
      summary: 'The shortest way from nothing to a first topic: install smurg, share a folder, invite a teammate, and go from an agent’s first question to a result you reviewed and merged.',
      title: 'Quick start: work with Claude Code as a team',
      description: 'Install smurg, share a project folder from your computer, invite a teammate, and go from Claude’s first question to a reviewed, merged result.',
      schema: 'TechArticle',
    },
    'zh-TW': {
      source: 'docs/zh-TW/QUICKSTART.md',
      path: '/zh-TW/docs/quick-start/',
      label: '快速上手',
      summary: '從什麼都沒有到第一個主題，最短的走法：安裝 smurg、分享資料夾、邀請組員，從 agent 的第一個選擇題走到你看過、合併的成果。',
      title: '快速上手：團隊一起用 Claude Code 的第一個主題',
      description: '安裝 smurg、從自己的電腦分享專案資料夾、邀請組員用瀏覽器加入，再從 Claude 的第一個選擇題走到你看過、合併的成果。',
      schema: 'TechArticle',
    },
  },
  {
    en: {
      source: 'docs/HOSTING.md',
      path: '/docs/hosting/',
      label: 'Host guide',
      summary: 'Share a folder from your own computer with smurg host: installing, logging in, what to read before you share, the Agent access role, what agents may do and how your own Claude Code settings count, troubleshooting, and what a topic asks of the host.',
      title: 'Host guide: share a folder and Claude Code agents',
      description: 'For the host: install, invite teammates, and know before you share what Claude Code agents may do on your computer, as you, with no sandbox.',
      schema: 'TechArticle',
    },
    'zh-TW': {
      source: 'docs/zh-TW/HOSTING.md',
      path: '/zh-TW/docs/hosting/',
      label: '主人指南',
      summary: '在自己的電腦上用 smurg host 分享資料夾：安裝、登入、分享前必讀、「可使用 agent」角色、agent 能做什麼與你自己的 Claude Code 設定、疑難排解，以及主題裡主人要做的事。',
      title: '主人指南：分享資料夾，讓團隊一起用 Claude Code',
      description: '給分享資料夾的主人：安裝、邀請組員、分享前必讀。agent 就是 Claude Code，沒有沙盒：以你的身分、用你的 Claude 帳號在你的電腦上執行。',
      schema: 'TechArticle',
    },
  },
  {
    en: {
      source: 'docs/JOINING.md',
      path: '/docs/joining/',
      label: 'Guide for teammates',
      summary: 'Join a workspace someone shared with an invite link: roles, the inbox and the columns, talking to agents, votes and suggestions, a topic from discussion to reviewed result, editing together, worktrees and leaving.',
      title: 'Guide for teammates: join a Claude Code workspace',
      description: 'Got an invite link? Join in Chrome, nothing to install, no Claude account: vote on the agent’s questions, edit the spec, review what agents build.',
      schema: 'TechArticle',
    },
    'zh-TW': {
      source: 'docs/zh-TW/JOINING.md',
      path: '/zh-TW/docs/joining/',
      label: '組員指南',
      summary: '用邀請連結加入別人分享的工作區：角色、收件夾與欄、和 agent 對話、投票與建議、主題從討論到看過結果、一起編輯、worktree 與離開。',
      title: '組員指南：用瀏覽器加入團隊的 Claude Code 工作區',
      description: '收到邀請連結了嗎？用 Chrome 打開就能加入，不必安裝，也不需要 Claude 帳號：對 agent 的選擇題投票、編輯 spec、檢視 agent 做出來的成果。',
      schema: 'TechArticle',
    },
  },
  {
    en: {
      source: 'CHANGELOG.md',
      path: '/docs/changelog/',
      label: 'Changelog',
      summary: 'What changed in each version, and the known limits.',
      title: 'Changelog: what changed in each version',
      description: 'Release notes for smurg, the real-time workspace for a team and Claude Code: what changed in each version, and its known limits.',
      schema: 'WebPage',
    },
    'zh-TW': {
      source: 'docs/zh-TW/CHANGELOG.md',
      path: '/zh-TW/docs/changelog/',
      label: '變更紀錄',
      summary: '每個版本的變更與已知限制。',
      title: '變更紀錄：每個版本改了什麼',
      description: 'smurg 是給團隊和 Claude Code 用的即時協作工作區。這份變更紀錄也是每個版本的發佈說明：每個版本改了什麼，以及已知的限制。',
      schema: 'WebPage',
    },
  },
];

/** The pages of the site that exist in both languages: the path of each, per language (the home pages first). */
export function pagePairs(): Readonly<Record<Lang, string>>[] {
  const pair = (path: (lang: Lang) => string): Record<Lang, string> => ({ en: path('en'), 'zh-TW': path('zh-TW') });
  return [pair(homePage), pair(docsIndex), ...DOC_PAGES.map((doc) => pair((lang) => doc[lang].path)), pair(licensePage)];
}

/** Ids the page template uses; a heading in the docs may not take one. */
const TEMPLATE_IDS = ['main'];

export interface SiteOptions {
  /** Where docs/, CHANGELOG.md and LICENSE are read (default: this repository). */
  readonly repoRoot?: string;
  /** The hand-written files (default: public/). */
  readonly publicDir?: string;
  /** A notices file (default: the output of NOTICES_COMMAND in this repository, see readNotices). */
  readonly notices?: string;
  /** Accept no named notices file, or notices that still contain NOTICES_PLACEHOLDER (previews and tests). */
  readonly allowPlaceholder?: boolean;
}

/** The options a build takes from its environment (scripts/build.ts, wrangler's custom build). */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): SiteOptions {
  const notices = env[NOTICES_ENV];
  const sources = env[SOURCE_ROOT_ENV];
  return {
    ...(notices !== undefined && notices !== '' ? { notices: resolve(notices) } : {}),
    ...(sources !== undefined && sources !== '' ? { repoRoot: resolve(sources) } : {}),
    allowPlaceholder: env[PLACEHOLDER_ENV] === '1',
  };
}

export interface Site {
  /** Every file of the site, by its path in the assets directory (forward slashes, no leading slash), sorted. */
  readonly files: ReadonlyMap<string, Buffer>;
  /** What the build changed in the docs' links and text, one line each, for the person building. */
  readonly rewritten: readonly string[];
  readonly plain: readonly string[];
  readonly rawHtml: readonly string[];
  /** Which pages have a date (the sitemap's `<lastmod>`, `dateModified`), and why the others have none. */
  readonly dates: PageDates;
}

export interface PageDates {
  /** The pages whose source git could date, by their paths. */
  readonly dated: readonly string[];
  /** How many pages the sitemap lists. */
  readonly of: number;
  /** The pages without a date, one line per reason: the pages, then why. For the person building. */
  readonly missing: readonly string[];
}

export class SiteError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the smurg.ai build failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'SiteError';
    this.problems = problems;
  }
}

// ---- templates ----

export const MARK =
  '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect class="mark-bg" width="32" height="32" rx="8"/><path class="mark-ln" d="M11 16 22 9.5M11 16l11 6.5"/><rect class="mark-fg" x="6.5" y="11.5" width="9" height="9" rx="2.25"/><circle class="mark-fg" cx="22.5" cy="9.5" r="3.25"/><circle class="mark-fg" cx="22.5" cy="22.5" r="3.25"/></svg>';

/**
 * Every word the build itself writes, per language (the site's catalog; the guides are Markdown files). The two home
 * pages in public/ have the same header links and footer, by hand: a test compares them.
 */
export const CHROME = {
  en: {
    homeLabel: 'smurg, home',
    skip: 'Skip to content',
    mainNav: 'Main',
    footerNav: 'Footer',
    docs: 'Docs',
    changelog: 'Changelog',
    license: 'License',
    notices: 'Third-party notices',
    webApp: 'Web app',
    github: 'GitHub',
    footer: 'smurg is open source under the MIT License.',
    /** The name of this language in the language link of the OTHER language's pages (always in its own language). */
    name: 'English',
    locale: 'en_US',
    docsNav: 'Docs',
    docsOverview: 'Overview',
    toc: 'On this page',
    tableLabel: (section: string | undefined): string => (section === undefined ? 'Table' : `Table: ${section}`),
    indexTitle: 'smurg docs: install, share a folder, join a workspace',
    indexDescription: 'Docs for smurg, the open-source workspace for a team and Claude Code: quick start, host guide, guide for teammates and changelog.',
    indexHeading: 'smurg docs',
    indexLede: 'Install smurg, share a folder, join a workspace someone shared, and see what changed in each version.',
    licenseHeading: 'License and source code',
    licenseSection: (lang: Lang): string =>
      `smurg is open source under the <a href="${licensePage(lang)}">MIT License</a>; the source code is on <a href="${REPOSITORY}">GitHub</a>. The components in the executables that come from other projects keep their own licenses, listed in the <a href="${NOTICES_FILE}">third-party notices</a>; those of the web app are in the <a href="${WEB_APP_NOTICES}">web app’s third-party notices</a>. To send a fix, read <a href="${REPOSITORY_FILES}CONTRIBUTING.md">CONTRIBUTING</a>; to report a vulnerability, <a href="${REPOSITORY_FILES}SECURITY.md">SECURITY</a>.`,
    licenseTitle: 'MIT License · smurg',
    licenseDescription: 'smurg is open source under the MIT License: the full text, for the executables, the web app and the source code, and links to third-party notices.',
    licensePageHeading: 'License',
    licenseLede: (): string =>
      `smurg is open source under the MIT License: the text below covers the executables, the web app and the <a href="${REPOSITORY}">source code</a>. The components in them that come from other projects keep their own licenses: see the <a href="${NOTICES_FILE}">third-party notices</a> of the executables and those of the <a href="${WEB_APP_NOTICES}">web app</a>.`,
    licenseNote: '',
  },
  'zh-TW': {
    homeLabel: 'smurg 首頁',
    skip: '跳到主要內容',
    mainNav: '主要',
    footerNav: '頁尾',
    docs: '文件',
    changelog: '變更紀錄',
    license: '授權條款',
    notices: '第三方授權聲明',
    webApp: '網頁版',
    github: 'GitHub',
    footer: 'smurg 是開放原始碼軟體，以 MIT 授權條款釋出。',
    name: '繁體中文',
    locale: 'zh_TW',
    docsNav: '文件',
    docsOverview: '文件總覽',
    toc: '本頁目錄',
    tableLabel: (section: string | undefined): string => (section === undefined ? '表格' : `表格：${section}`),
    indexTitle: 'smurg 文件：安裝、分享資料夾、加入工作區',
    // 「開源」 here, once: the word people type when they search; every page a reader sees says 「開放原始碼」.
    indexDescription: 'smurg 的使用說明：快速上手、主人指南、組員指南與變更紀錄。smurg 是給團隊和 Claude Code 用的即時協作工作區，端對端加密，開源。',
    indexHeading: 'smurg 文件',
    indexLede: '安裝 smurg、分享資料夾、加入別人分享的工作區，以及每個版本的變更。',
    licenseHeading: '授權與原始碼',
    licenseSection: (lang: Lang): string =>
      `smurg 是開放原始碼軟體，以 <a href="${licensePage(lang)}">MIT 授權條款</a>釋出；原始碼在 <a href="${REPOSITORY}">GitHub</a>。執行檔裡來自其他專案的元件，依它們各自的授權條款提供，列在<a href="${NOTICES_FILE}">第三方授權聲明</a>；網頁版用到的元件列在<a href="${WEB_APP_NOTICES}">網頁版的第三方授權聲明</a>。想送出修正，請讀 <a href="${REPOSITORY_FILES}CONTRIBUTING.md">CONTRIBUTING</a>（英文）；要回報安全性問題，請讀 <a href="${REPOSITORY_FILES}SECURITY.md">SECURITY</a>（英文）。`,
    licenseTitle: 'MIT 授權條款 · smurg',
    licenseDescription: 'smurg 是開放原始碼軟體，以 MIT 授權條款釋出：這一頁是條款全文，適用於執行檔、網頁版和原始碼，並連到第三方授權聲明。',
    licensePageHeading: '授權條款',
    licenseLede: (): string =>
      `smurg 是開放原始碼軟體，以 MIT 授權條款釋出：下面的條款適用於執行檔、網頁版和<a href="${REPOSITORY}">原始碼</a>。其中來自其他專案的元件，依它們各自的授權條款提供：見執行檔的<a href="${NOTICES_FILE}">第三方授權聲明</a>與<a href="${WEB_APP_NOTICES}">網頁版的第三方授權聲明</a>。`,
    licenseNote: '授權條款以英文原文為準，下面是原文。',
  },
} as const;

function footer(lang: Lang, alternate: string): string {
  const t = CHROME[lang];
  const other = otherLang(lang);
  return `<footer class="site-footer">
  <div class="wrap footer-row">
    <p>${t.footer}</p>
    <nav aria-label="${t.footerNav}">
      <ul>
        <li><a href="${docsIndex(lang)}">${t.docs}</a></li>
        <li><a href="${changelogPage(lang)}">${t.changelog}</a></li>
        <li><a href="${licensePage(lang)}">${t.license}</a></li>
        <li><a href="${NOTICES_FILE}">${t.notices}</a></li>
        <li><a href="${REPOSITORY}">${t.github}</a></li>
        <li><a href="https://app.smurg.ai/">${t.webApp}</a></li>
        <li><a href="${alternate}" hreflang="${HTML_LANG[other]}" lang="${HTML_LANG[other]}">${CHROME[other].name}</a></li>
      </ul>
    </nav>
  </div>
</footer>`;
}

interface PageInput {
  readonly lang: Lang;
  /** The path of this page in each language. */
  readonly paths: Readonly<Record<Lang, string>>;
  readonly title: string;
  readonly description: string;
  /** What a link preview takes the page for (Open Graph `og:type`): a document is an article, an index or the license a page of the site. */
  readonly kind: 'article' | 'website';
  /** The page's structured data (a line of `<head>`, see below), or '' for a page that has none. */
  readonly data: string;
  readonly main: string;
}

/** `<link rel="alternate">` for both languages and the default (English), as every page of a pair carries them. */
export function alternateLinks(paths: Readonly<Record<Lang, string>>): string {
  return [
    ...LANGS.map((lang) => `<link rel="alternate" hreflang="${HTML_LANG[lang]}" href="${ORIGIN}${paths[lang]}">`),
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${paths.en}">`,
  ].join('\n');
}

/** The sizes inside favicon.ico: a browser's tab (16, 32) and the size a search result's icon is a multiple of (48). */
export const FAVICON_SIZES = [16, 32, 48] as const;
/** The side of apple-touch-icon.png: what a phone puts on its home screen. */
export const TOUCH_ICON_SIZE = 180;

/**
 * The icons every page names (the four hand-written pages carry the same lines; a test compares). The two that are
 * not the SVG are drawn from it by scripts/icons.ts:
 * - /favicon.ico is what a browser, a crawler or a link preview asks for when it has read no page, and the icon of
 *   browsers that show no SVG one. Its sizes are written out, so a browser that can show the SVG prefers it.
 * - /favicon.svg is the drawing itself, sharp at any size.
 * - /apple-touch-icon.png is the icon of a page somebody put on a phone's home screen.
 */
export const ICON_LINKS = [
  `<link rel="icon" href="/favicon.ico" sizes="${FAVICON_SIZES.map((size) => `${size}x${size}`).join(' ')}">`,
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
].join('\n');

// ---- structured data ----
//
// What a page is, said to search engines in schema.org's words: one JSON-LD data block in `<head>`. It is data, not
// a script (nothing runs), so the CSP's `script-src 'self'` lets it through and _headers needs no hash for it. It
// says only what the page itself says: the page's own address, title or heading, description and language, and the
// site it is a page of. No rating, no review, no version number, no author: nothing a reader could not check on the
// page.
//
// There is no SoftwareApplication node, on purpose: the search result that type exists for asks for a rating or a
// review, smurg has none and none is ever made up, and Search Console reports a node without one as not valid for
// as long as it stands. The site's name and the breadcrumbs are what a result takes from these blocks.

type Thing = Readonly<Record<string, unknown>>;

/**
 * The site, as every block names it. A search engine reads each page's block by itself, so a docs page says the
 * site's type, address and name where it refers to it; a home page says the rest as well (homeStructuredData).
 */
const WEBSITE = { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'smurg' } as const;

/** The data block as one line. No `<` stands in it as itself, so nothing inside can end the element early. */
function dataBlock(graph: readonly Thing[]): string {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
  return `<script type="application/ld+json">${json.replace(/</g, '\\u003c')}</script>`;
}

/**
 * A home page's structured data: the site (its name is what a search result may show above the address) and the
 * page. The two home pages are written by hand and carry this line as it is returned for their own `<title>` and
 * description: after changing either, run the tests, and paste the line the failing test of test/site.test.ts
 * prints.
 */
export function homeStructuredData(lang: Lang, title: string, description: string): string {
  const url = `${ORIGIN}${homePage(lang)}`;
  return dataBlock([
    // Three things say that "smurg" is a name, to a search engine that takes it for a misspelling of another word:
    // the name itself, the site's address as its second name, and the repository as the same thing elsewhere.
    { ...WEBSITE, alternateName: new URL(ORIGIN).hostname, sameAs: REPOSITORY, inLanguage: LANGS.map((l) => HTML_LANG[l]) },
    // (the site is the node above: the page refers to it by its id)
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: title, description, inLanguage: HTML_LANG[lang], isPartOf: { '@id': WEBSITE['@id'] } },
  ]);
}

interface PageData {
  readonly lang: Lang;
  readonly path: string;
  /** A guide is an article with a headline (its h1); the changelog and the docs index are pages with a name (their title). */
  readonly type: 'TechArticle' | 'WebPage' | 'CollectionPage';
  readonly name: string;
  readonly description: string;
  /** When the page's source last changed (see fileDates), if git knows. */
  readonly modified: string | undefined;
  /** The page's name at the end of its breadcrumb. */
  readonly crumb: string;
}

/** A docs page's structured data: the page, and where it is in the site (home, the docs, the page). */
function pageStructuredData({ lang, path, type, name, description, modified, crumb }: PageData): string {
  const url = `${ORIGIN}${path}`;
  // The way to the page; the page itself comes last and, being where the reader is, has no address.
  const trail: (readonly [string, string])[] = [['smurg', homePage(lang)]];
  if (path !== docsIndex(lang)) trail.push([CHROME[lang].docs, docsIndex(lang)]);
  return dataBlock([
    {
      '@type': type,
      '@id': `${url}#page`,
      url,
      [type === 'TechArticle' ? 'headline' : 'name']: name,
      description,
      inLanguage: HTML_LANG[lang],
      // (left out by JSON.stringify when git has no date)
      dateModified: modified,
      isPartOf: WEBSITE,
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        ...trail.map(([label, href], index) => ({ '@type': 'ListItem', position: index + 1, name: label, item: `${ORIGIN}${href}` })),
        { '@type': 'ListItem', position: trail.length + 1, name: crumb },
      ],
    },
  ]);
}

function page({ lang, paths, title, description, kind, data, main }: PageInput): string {
  const t = CHROME[lang];
  const other = otherLang(lang);
  const path = paths[lang];
  const current = (href: string): string => (href === path ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}${path}">
${alternateLinks(paths)}
${ICON_LINKS}
<link rel="stylesheet" href="/style.css">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="${kind}">
<meta property="og:site_name" content="smurg">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${ORIGIN}${path}">
<meta property="og:locale" content="${t.locale}">
<meta property="og:locale:alternate" content="${CHROME[other].locale}">
${socialCardMeta(lang)}${data === '' ? '' : `\n${data}`}
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>

<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="${homePage(lang)}" aria-label="${t.homeLabel}">
      ${MARK}
      <span>smurg</span>
    </a>
    <nav class="site-nav" aria-label="${t.mainNav}">
      <ul>
        <li><a href="${docsIndex(lang)}"${current(docsIndex(lang))}>${t.docs}</a></li>
        <li><a href="${REPOSITORY}">${t.github}</a></li>
        <li><a href="https://app.smurg.ai/">${t.webApp}</a></li>
        <li class="lang"><a href="${paths[other]}" hreflang="${HTML_LANG[other]}" lang="${HTML_LANG[other]}">${CHROME[other].name}</a></li>
      </ul>
    </nav>
  </div>
</header>

${main}

${footer(lang, paths[other])}
</body>
</html>
`;
}

/** The docs navigation, with the current page marked. */
function docNav(lang: Lang, path: string): string {
  const t = CHROME[lang];
  const items: [string, string][] = [
    [docsIndex(lang), t.docsOverview],
    ...DOC_PAGES.map((doc): [string, string] => [doc[lang].path, doc[lang].label]),
    [licensePage(lang), t.license],
    [NOTICES_FILE, t.notices],
  ];
  const li = items.map(([href, label]) => `<li><a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a></li>`);
  return `<nav class="doc-nav" aria-label="${t.docsNav}">\n<ul>\n${li.join('\n')}\n</ul>\n</nav>`;
}

/** The page's own table of contents: its second-level headings (on wide screens, beside the text). */
function toc(lang: Lang, headings: readonly Heading[]): string {
  const sections = headings.filter((h) => h.depth === 2);
  if (sections.length < 2) return '';
  const li = sections.map((h) => `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`);
  return `\n<nav class="doc-toc" aria-label="${CHROME[lang].toc}">\n<ul>\n${li.join('\n')}\n</ul>\n</nav>`;
}

function docLayout(lang: Lang, path: string, headings: readonly Heading[], body: string): string {
  return `<div class="wrap doc-layout">
<aside class="doc-side">
${docNav(lang, path)}${toc(lang, headings)}
</aside>
<main id="main" class="doc">
${body}</main>
</div>`;
}

function docsIndexPage(lang: Lang): string {
  const t = CHROME[lang];
  const cards = DOC_PAGES.map(
    (doc) => `<li>\n<h2><a href="${doc[lang].path}">${escapeHtml(doc[lang].label)}</a></h2>\n<p>${escapeHtml(doc[lang].summary)}</p>\n</li>`,
  ).join('\n');
  const body = `<h1>${t.indexHeading}</h1>
<p class="doc-lede">${t.indexLede}</p>
<ul class="doc-cards">
${cards}
</ul>
<h2 id="license">${t.licenseHeading}</h2>
<p>${t.licenseSection(lang)}</p>
`;
  return page({
    lang,
    paths: { en: docsIndex('en'), 'zh-TW': docsIndex('zh-TW') },
    title: t.indexTitle,
    description: t.indexDescription,
    kind: 'website',
    // (no date: the page is put together from the tables of this file, not from one source that git could date)
    data: pageStructuredData({ lang, path: docsIndex(lang), type: 'CollectionPage', name: t.indexTitle, description: t.indexDescription, modified: undefined, crumb: t.docs }),
    main: docLayout(lang, docsIndex(lang), [], body),
  });
}

function licensePageHtml(lang: Lang, text: string): string {
  const t = CHROME[lang];
  const note = t.licenseNote === '' ? '' : `\n<p class="doc-note">${t.licenseNote}</p>`;
  // The license text is English on both pages.
  const textLang = lang === 'en' ? '' : ` lang="${HTML_LANG.en}"`;
  const main = `<div class="wrap">
<main id="main" class="doc doc-single">
<h1>${t.licensePageHeading}</h1>
<p class="doc-lede">${t.licenseLede()}</p>${note}
<pre class="license-text"${textLang}>${escapeHtml(text.replace(/\s+$/, ''))}</pre>
</main>
</div>`;
  // No structured data: the page is the license text, and its address and title say all a search result needs.
  return page({ lang, paths: { en: licensePage('en'), 'zh-TW': licensePage('zh-TW') }, title: t.licenseTitle, description: t.licenseDescription, kind: 'website', data: '', main });
}

/**
 * The one file of the repository each page is made from, by the page's path: a home page's own HTML, a document's
 * Markdown, LICENSE for the license pages. The docs index has none (it is put together from the tables of this
 * file). The day a page last changed is the day its file did (fileDates).
 */
export function pageSources(): ReadonlyMap<string, string> {
  const publicDir = relative(REPO_ROOT, PUBLIC_DIR).split(sep).join('/');
  const sources = new Map<string, string>();
  for (const lang of LANGS) {
    sources.set(homePage(lang), `${publicDir}${homePage(lang)}index.html`);
    for (const doc of DOC_PAGES) sources.set(doc[lang].path, doc[lang].source);
    sources.set(licensePage(lang), 'LICENSE');
  }
  return sources;
}

/** Why git gives a file no date. Each reads on from "its source" in what the build prints (PageDates). */
export const NO_DATE = {
  noCheckout: 'is not in a git checkout that this build can read (the top of one, with git installed)',
  shallow: 'is in a shallow clone, where git knows one commit and would name it for every file',
  uncommitted: 'has changes that are not committed',
  unknown: 'is in no commit',
} as const;

export interface FileDates {
  /** When each file last changed, for the files git can date. */
  readonly dates: ReadonlyMap<string, string>;
  /** Why each other file has no date (one of NO_DATE). */
  readonly missing: ReadonlyMap<string, string>;
}

/**
 * When each of `files` (paths relative to `root`) last changed, as git knows it: the date of the last commit that
 * touched the file, in ISO 8601 with its time zone. A file has NO date, rather than a wrong one, when
 * - `root` is not the top of a git checkout (a copy of the tree without .git, the tests' fixture repositories), or
 *   git is not installed;
 * - the checkout is shallow: git would name the one commit it has for every file;
 * - the file is not committed as it is (changed, staged or new): the last commit is not when this text was written.
 * A search engine trusts a sitemap's dates only while they are right, so a date is given only when it is known, and
 * the build says which pages have none and why (PageDates). A deploy is built from the release's commit in a
 * complete checkout, where every file has one. git is only read (`--no-optional-locks`: `git status` does not even
 * refresh the index).
 */
export function fileDates(root: string, files: readonly string[]): FileDates {
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    } catch {
      return undefined;
    }
  };
  const dates = new Map<string, string>();
  const none = (why: string): FileDates => ({ dates, missing: new Map(files.map((file) => [file, why])) });
  const [top, shallow] = (git('rev-parse', '--show-toplevel', '--is-shallow-repository') ?? '').trim().split('\n');
  if (top === undefined || top === '') return none(NO_DATE.noCheckout);
  if (shallow !== 'false') return none(NO_DATE.shallow);
  try {
    if (realpathSync(top) !== realpathSync(root)) return none(NO_DATE.noCheckout);
  } catch {
    return none(NO_DATE.noCheckout);
  }
  const status = git('status', '--porcelain', '-z', '--', ...files);
  if (status === undefined) return none(NO_DATE.noCheckout);
  // Each entry is two status letters, a space and the path.
  const uncommitted = new Set(status.split('\0').map((entry) => entry.slice(3)));
  const missing = new Map<string, string>();
  for (const file of files) {
    if (uncommitted.has(file)) {
      missing.set(file, NO_DATE.uncommitted);
      continue;
    }
    const date = (git('log', '-1', '--format=%cI', '--', file) ?? '').trim();
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(date)) dates.set(file, date);
    else missing.set(file, NO_DATE.unknown);
  }
  return { dates, missing };
}

/**
 * sitemap.xml: every page that exists in both languages, each with its alternates and, when git knows it, the day
 * its source last changed (`modified`, by the page's path).
 */
function sitemap(modified: ReadonlyMap<string, string>): string {
  const urls = pagePairs().flatMap((paths) =>
    LANGS.map((lang) => {
      const date = modified.get(paths[lang]);
      return `  <url>\n    <loc>${ORIGIN}${paths[lang]}</loc>\n${[
        ...(date === undefined ? [] : [`    <lastmod>${date}</lastmod>`]),
        ...LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${HTML_LANG[l]}" href="${ORIGIN}${paths[l]}"/>`),
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${paths.en}"/>`,
      ].join('\n')}\n  </url>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * What /llms.txt says smurg is: the summary (the quoted line) and two lines of what an assistant should not get
 * wrong when somebody asks it about smurg. Each is what the guides say: the quick start's first lines and its box,
 * the two guides' introductions, and the README's status line.
 */
export const LLMS_SUMMARY =
  'smurg is a real-time workspace for a team and Claude Code: a host shares a project folder from their own computer, and teammates join in a browser to discuss a feature with a Claude Code agent, vote on its questions and review what the agents build.';
export const LLMS_FACTS = [
  'Open source (MIT). The host needs macOS or Linux with Claude Code; teammates install nothing and join in Chrome. The connection between a browser and the host’s computer is end-to-end encrypted: the relay in between cannot see files, conversations or commands.',
  'The agents are Claude Code sessions on the host’s computer: they run as the host, with no sandbox, on the host’s Claude account. smurg is a prototype; its topics flow was verified against a scripted stand-in for the model, not with a real Claude account.',
] as const;

/**
 * /llms.txt (the convention of llmstxt.org): Markdown as plain text for the assistants people ask instead of
 * searching. What smurg is, then every document with its address and its line of the docs index, in English; the
 * Traditional Chinese pages are listed after them, each by its own name.
 */
function llmsTxt(): string {
  const url = (path: string): string => `${ORIGIN}${path}`;
  return [
    '# smurg',
    '',
    `> ${LLMS_SUMMARY}`,
    '',
    ...LLMS_FACTS.flatMap((fact) => [fact, '']),
    '## Docs',
    '',
    ...DOC_PAGES.map((doc) => `- [${doc.en.label}](${url(doc.en.path)}): ${doc.en.summary}`),
    '',
    `## Docs in Traditional Chinese (${CHROME['zh-TW'].name})`,
    '',
    ...DOC_PAGES.map((doc) => `- [${doc['zh-TW'].label}](${url(doc['zh-TW'].path)}): ${doc.en.label}`),
    '',
    '## Optional',
    '',
    `- [Source code](${REPOSITORY}): the repository on GitHub`,
    `- [${CHROME.en.license}](${url(licensePage('en'))}): the MIT License, in full`,
    '',
  ].join('\n');
}

// ---- links ----

/**
 * The link decisions for one Markdown file of the repository (see the header of this file). `targets` maps every
 * published Markdown file, of both languages, to its URL: a guide links its own language's files, so its links stay
 * in its language. LICENSE goes to the license page of the linking file's language.
 */
function linkResolver(source: string, lang: Lang, targets: ReadonlyMap<string, string>, repoRoot: string, problems: string[]): (href: string) => LinkDecision {
  return (href) => {
    if (href.startsWith('#')) return { href };
    if (href.startsWith('//')) return { plain: 'a protocol-relative link' };
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return { plain: 'not a valid URL' };
      }
      if (url.protocol !== 'https:') return { plain: `a ${url.protocol} link (only https links are kept)` };
      return { href };
    }
    // A path relative to the Markdown file, in the repository.
    const [beforeHash = '', ...hash] = href.split('#');
    const fragment = hash.length > 0 ? `#${hash.join('#')}` : '';
    const pathPart = beforeHash.split('?')[0] ?? '';
    if (pathPart === '') return { href: fragment === '' ? href : fragment };
    let decoded: string;
    try {
      decoded = decodeURI(pathPart);
    } catch {
      return { plain: 'not a valid path' };
    }
    const target = posix.normalize(posix.join(posix.dirname(source), decoded)).replace(/\/$/, '');
    if (target.startsWith('../') || target === '..') return { plain: 'a path outside the repository' };
    if (target === 'LICENSE') return { href: `${licensePage(lang)}${fragment}` };
    const url = targets.get(target);
    if (url !== undefined) return { href: `${url}${fragment}` };
    // Not a page of the site: the file itself, in the source repository.
    const file = join(repoRoot, ...target.split('/'));
    if (!existsSync(file)) {
      problems.push(`${source}: the link (${href}) points at ${target}, which does not exist in the repository`);
      return { plain: `${target} does not exist` };
    }
    const base = statSync(file).isDirectory() ? REPOSITORY_DIRS : REPOSITORY_FILES;
    return { href: `${base}${encodeURI(target)}${fragment}` };
  };
}

function describeLink(source: string, link: LinkRecord): string {
  const where = `${source}:${link.line}`;
  const what = `[${link.text}](${link.href})`;
  return 'plain' in link.decision ? `${where} ${what} -> plain text (${link.decision.plain})` : `${where} ${what} -> ${link.decision.href}`;
}

// ---- checks of the finished site ----

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

interface PageFacts {
  readonly ids: Set<string>;
  /** href and src values, with the element they are on. */
  readonly links: { readonly tag: string; readonly attr: string; readonly value: string; readonly rel?: string }[];
}

function pageFacts(html: string): PageFacts {
  const ids = new Set<string>();
  const links: PageFacts['links'][number][] = [];
  const walk = (node: Node): void => {
    if ('tagName' in node) {
      const el = node as Element;
      const attr = (name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
      const id = attr('id');
      if (id !== undefined) ids.add(id);
      for (const name of ['href', 'src']) {
        const value = attr(name);
        const rel = attr('rel');
        if (value !== undefined) links.push({ tag: el.tagName, attr: name, value, ...(rel !== undefined ? { rel } : {}) });
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) walk(child);
    if ('content' in node && node.nodeName === 'template') walk((node as DefaultTreeAdapterTypes.Template).content);
  };
  walk(parse(html));
  return { ids, links };
}

/** The file a same-site path is served from (html_handling "auto-trailing-slash"), or undefined. */
export function servedFile(files: ReadonlyMap<string, unknown>, path: string): string | undefined {
  if (!path.startsWith('/')) return undefined;
  const file = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
  if (file.split('/').some((segment) => segment.startsWith('_') || segment.startsWith('.'))) return undefined;
  return files.has(file) ? file : undefined;
}

function checkSite(files: ReadonlyMap<string, Buffer>): string[] {
  const problems: string[] = [];
  const facts = new Map<string, PageFacts>();
  for (const [file, data] of files) if (file.endsWith('.html')) facts.set(file, pageFacts(data.toString('utf8')));

  for (const [file, page] of facts) {
    for (const { tag, attr, value, rel } of page.links) {
      const where = `${file}: <${tag} ${attr}="${value}">`;
      if (value.startsWith('#')) {
        if (value.length > 1 && !page.ids.has(decodeURIComponent(value.slice(1)))) problems.push(`${where}: no element has this id`);
        continue;
      }
      let url: URL;
      try {
        url = new URL(value, `${ORIGIN}/${file}`);
      } catch {
        problems.push(`${where}: not a valid URL`);
        continue;
      }
      if (url.protocol !== 'https:') problems.push(`${where}: not https`);
      if (url.hostname !== new URL(ORIGIN).hostname) continue;
      if (rel === 'canonical' || rel === 'alternate') {
        if (servedFile(files, url.pathname) === undefined) problems.push(`${where}: no such page`);
        continue;
      }
      if (REDIRECTS.has(url.pathname) && url.hash === '') continue;
      const target = servedFile(files, url.pathname);
      if (target === undefined) {
        problems.push(`${where}: no file is served at ${url.pathname}`);
        continue;
      }
      if (url.hash.length > 1) {
        const ids = facts.get(target)?.ids;
        if (ids === undefined || !ids.has(decodeURIComponent(url.hash.slice(1)))) problems.push(`${where}: ${target} has no element with this id`);
      }
    }
  }
  return problems;
}

// ---- the site ----

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path).split(sep).join('/')];
    })
    .sort();
}

function readUtf8(path: string, what: string, problems: string[]): string | undefined {
  if (!existsSync(path)) {
    problems.push(`${what}: ${path} does not exist`);
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    problems.push(`${what}: ${path} is not UTF-8 text`);
    return undefined;
  }
}

/**
 * The executable's complete third-party notices: the file `options.notices` names, which for a deploy is the release's
 * own THIRD-PARTY-NOTICES.txt (byte for byte the one published at downloads.smurg.ai/v<X.Y.Z>/: the executables embed
 * the LICENSE of the release workflow's Node.js, not of the Node.js running this build). A deploy build refuses to run
 * without it, and refuses a file without a filled-in Node.js section. Only previews and tests (`allowPlaceholder`) may
 * leave it out: then it is what `node scripts/third-party-notices.ts --executable` prints (the committed
 * packages/cli/THIRD-PARTY-NOTICES.txt with the LICENSE of the running Node.js filled in).
 */
function readNotices(options: SiteOptions, problems: string[]): Buffer | undefined {
  let data: Buffer;
  let what: string;
  if (options.notices === undefined && options.allowPlaceholder !== true) {
    // The executables embed the Node.js LICENSE of the Node.js they are copies of (the release workflow's), not of the
    // one running this build: a deploy names the release's own file (docs/RELEASING.md §4.1).
    problems.push(
      [
        `third-party notices: a deploy publishes the release's own THIRD-PARTY-NOTICES.txt, so name it: ${NOTICES_ENV}=<file>, for example`,
        `  curl -fsSLo /tmp/smurg-notices.txt https://downloads.smurg.ai/v<X.Y.Z>/THIRD-PARTY-NOTICES.txt`,
        `  (or, before it is published: gh release download v<X.Y.Z> --repo gclinian/smurg --pattern THIRD-PARTY-NOTICES.txt --dir /tmp/smurg-v<X.Y.Z>)`,
        `Before any release exists: node scripts/third-party-notices.ts --executable --out /tmp/smurg-notices.txt (the Node.js ${process.versions.node} of this machine; replace it at the release).`,
        `Without it the build would publish the LICENSE of the Node.js running it, which is not the executables' (${PLACEHOLDER_ENV}=1 does that, for local previews and tests only).`,
      ].join('\n'),
    );
    return undefined;
  }
  if (options.notices !== undefined) {
    const path = resolve(options.notices);
    what = `third-party notices (${path})`;
    if (!existsSync(path)) {
      problems.push(`${what}: the file does not exist`);
      return undefined;
    }
    data = readFileSync(path);
  } else {
    const [script, ...args] = NOTICES_COMMAND;
    what = `third-party notices (node ${NOTICES_COMMAND.join(' ')})`;
    try {
      data = execFileSync(process.execPath, [join(REPO_ROOT, script), ...args], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8').trim();
      problems.push(`${what} failed: ${stderr || (error as Error).message} (${NOTICES_ENV}=<file> publishes a notices file instead)`);
      return undefined;
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    problems.push(`${what}: not UTF-8 text`);
    return undefined;
  }
  if (text.trim() === '') problems.push(`${what}: empty`);
  else if (text.includes(NOTICES_PLACEHOLDER) && options.allowPlaceholder !== true) {
    problems.push(
      `${what}: the Node.js section is still the committed placeholder ("${NOTICES_PLACEHOLDER} …"); publish the complete notices (${PLACEHOLDER_ENV}=1 builds anyway, for local previews and tests only)`,
    );
  } else if (options.allowPlaceholder !== true && (!/^node@\d+\.\d+\.\d+ \(the Node\.js runtime\)$/m.test(text) || !text.includes(NODE_LICENSE_START))) {
    problems.push(`${what}: no Node.js section ("node@X.Y.Z (the Node.js runtime)" and the Node.js LICENSE): not the executables' notices (the release's THIRD-PARTY-NOTICES.txt has it)`);
  }
  return data;
}

export function generateSite(options: SiteOptions = {}): Site {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const problems: string[] = [];
  const rewritten: string[] = [];
  const plain: string[] = [];
  const rawHtml: string[] = [];
  /** A source that could not be read. */
  let missing = false;
  const files = new Map<string, Buffer>();
  const add = (path: string, data: string | Buffer): void => {
    if (files.has(path)) problems.push(`${path} is both in public/ and generated by the build`);
    files.set(path, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  };

  for (const path of listFiles(publicDir)) add(path, readFileSync(join(publicDir, path)));

  // When each page's source last changed, by the page's path (fileDates: no date where git cannot say), and for
  // the person building, why a page has none. The documents and LICENSE are files of `repoRoot`; the home pages are
  // files of this checkout's public/.
  const modified = new Map<string, string>();
  const undated = new Map<string, string>();
  const dateOf = (root: string, pages: readonly (readonly [string, string])[]): void => {
    const { dates, missing } = fileDates(root, [...new Set(pages.map(([, file]) => file))]);
    for (const [path, file] of pages) {
      const date = dates.get(file);
      if (date !== undefined) modified.set(path, date);
      else undated.set(path, `its source ${missing.get(file) ?? NO_DATE.unknown}`);
    }
  };
  const isHome = (path: string): boolean => LANGS.some((lang) => homePage(lang) === path);
  const sources = [...pageSources()];
  dateOf(repoRoot, sources.filter(([path]) => !isHome(path)));
  if (publicDir === PUBLIC_DIR) dateOf(REPO_ROOT, sources.filter(([path]) => isHome(path)));
  const listed = pagePairs().flatMap((paths) => LANGS.map((lang) => paths[lang]));
  for (const path of listed) {
    if (modified.has(path) || undated.has(path)) continue;
    undated.set(path, LANGS.some((lang) => docsIndex(lang) === path) ? 'no single source file (the docs index never has a date)' : 'built from a folder that is not this checkout’s public/');
  }
  // One line per reason, in the sitemap's order of pages.
  const reasons = new Map<string, string[]>();
  for (const path of listed) {
    const why = undated.get(path);
    if (why !== undefined) reasons.set(why, [...(reasons.get(why) ?? []), path]);
  }
  const dates: PageDates = { dated: listed.filter((path) => modified.has(path)), of: listed.length, missing: [...reasons].map(([why, paths]) => `${paths.join(', ')}: ${why}`) };

  // Every published Markdown file, of both languages, and the notices.
  const targets = new Map<string, string>([
    ...DOC_PAGES.flatMap((doc) => LANGS.map((lang): [string, string] => [doc[lang].source, doc[lang].path])),
    [COMMITTED_NOTICES, NOTICES_FILE],
  ]);

  for (const lang of LANGS) {
    for (const pair of DOC_PAGES) {
      const doc = pair[lang];
      const markdown = readUtf8(join(repoRoot, doc.source), doc.source, problems);
      if (markdown === undefined) {
        missing = true;
        continue;
      }
      const rendered = renderMarkdown(markdown, {
        resolveLink: linkResolver(doc.source, lang, targets, repoRoot, problems),
        reservedIds: TEMPLATE_IDS,
        tableLabel: CHROME[lang].tableLabel,
      });
      problems.push(...rendered.problems.map((p) => `${doc.source}: ${p}`));
      rawHtml.push(...rendered.rawHtml.map((r) => `${doc.source}:${r}`));
      for (const link of rendered.links) {
        if ('plain' in link.decision) plain.push(describeLink(doc.source, link));
        else if (link.decision.href !== link.href) rewritten.push(describeLink(doc.source, link));
      }
      // One h1, first; no heading skips a level (a screen reader's outline of the page).
      const levels = rendered.headings.map((h) => h.depth);
      if (levels.filter((l) => l === 1).length !== 1 || levels[0] !== 1) problems.push(`${doc.source}: needs exactly one level-1 heading (#), before any other heading`);
      levels.forEach((level, i) => {
        if (i > 0 && level - (levels[i - 1] as number) > 1) problems.push(`${doc.source}: "${rendered.headings[i]?.text}" skips a heading level`);
      });
      // The title and the description are written for a search result (DOC_PAGES); the heading is the document's own.
      const heading = rendered.headings.find((h) => h.depth === 1)?.text ?? doc.label;
      const title = `${doc.title} · smurg`;
      const html = page({
        lang,
        paths: { en: pair.en.path, 'zh-TW': pair['zh-TW'].path },
        title,
        description: doc.description,
        kind: 'article',
        data: pageStructuredData({
          lang,
          path: doc.path,
          type: doc.schema,
          name: doc.schema === 'TechArticle' ? heading : title,
          description: doc.description,
          modified: modified.get(doc.path),
          crumb: doc.label,
        }),
        main: docLayout(lang, doc.path, rendered.headings, rendered.html),
      });
      add(`${doc.path.slice(1)}index.html`, html);
    }
    add(`${docsIndex(lang).slice(1)}index.html`, docsIndexPage(lang));
  }

  const license = readUtf8(join(repoRoot, 'LICENSE'), 'LICENSE', problems);
  if (license === undefined) missing = true;
  else for (const lang of LANGS) add(`${licensePage(lang).slice(1)}index.html`, licensePageHtml(lang, license));

  const notices = readNotices(options, problems);
  if (notices === undefined) missing = true;
  if (notices !== undefined) add(NOTICES_FILE.slice(1), notices);

  add(SITEMAP_FILE.slice(1), sitemap(modified));
  add(LLMS_FILE.slice(1), llmsTxt());

  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // With a source missing, every link to its page would be reported too: those come after the sources are there.
  if (!missing) problems.push(...checkSite(sorted));
  if (problems.length > 0) throw new SiteError(problems);
  return { files: sorted, rewritten, plain, rawHtml, dates };
}

// ---- writing ----

/**
 * Makes `outDir` hold exactly `files`: writes the files whose content differs (each through a temporary file and a
 * rename, so a reader never sees half a file), removes the ones that are no longer part of the site, and leaves the
 * rest untouched. Two builds of the same sources at the same time (the tests start several) therefore never get in
 * each other's way. The temporary files live in .wrangler/tmp next to outDir (gitignored, never uploaded).
 */
export function writeSite(outDir: string, files: ReadonlyMap<string, Buffer>): { written: number; removed: number } {
  const out = resolve(outDir);
  const outside = (from: string, to: string): boolean => {
    const rel = relative(from, to);
    return rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel;
  };
  // It deletes what does not belong to the site: never point it at the repository, the site's sources or public/.
  for (const forbidden of [REPO_ROOT, SITE_ROOT, PUBLIC_DIR, dirname(REPO_ROOT)]) {
    if (!outside(out, resolve(forbidden))) throw new Error(`refusing to write the site into ${out}: it is or contains ${forbidden}`);
  }
  if (!outside(PUBLIC_DIR, out)) throw new Error(`refusing to write the site into ${out}: it is inside ${PUBLIC_DIR}`);
  const tmpDir = join(dirname(out), '.wrangler', 'tmp', 'site-build');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(out, { recursive: true });
  let written = 0;
  let counter = 0;
  for (const [path, data] of files) {
    const target = join(out, ...path.split('/'));
    if (existsSync(target) && statSync(target).isDirectory()) rmSync(target, { recursive: true, force: true });
    if (existsSync(target) && readFileSync(target).equals(data)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(tmpDir, `${process.pid}-${Date.now()}-${counter++}`);
    writeFileSync(tmp, data);
    renameSync(tmp, target);
    written++;
  }
  let removed = 0;
  for (const path of listFiles(out)) {
    if (files.has(path)) continue;
    rmSync(join(out, ...path.split('/')), { force: true });
    removed++;
  }
  // Empty directories left behind, deepest first.
  const dirs = (dir: string): string[] =>
    readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isDirectory())
      .flatMap((path) => [...dirs(path), path]);
  for (const dir of dirs(out)) if (readdirSync(dir).length === 0) rmdirSync(dir);
  return { written, removed };
}
