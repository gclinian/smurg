// The smurg.ai site as files: public/ (the hand-written pages) plus the pages generated from the repository at build
// time. scripts/build.ts writes them into dist/, the static-assets directory of wrangler.jsonc.
//
//   /docs/                     the docs index (zh-TW, with an English note)
//   /docs/hosting/             docs/HOSTING.md
//   /docs/joining/             docs/JOINING.md
//   /docs/changelog/           CHANGELOG.md
//   /docs/404.html             the Traditional Chinese 404 page, for unknown paths under /docs/
//   /license/                  LICENSE
//   /third-party-notices.txt   the executable's complete third-party notices (see readNotices)
//
// Internal documents (ARCHITECTURE, RELEASING, ACCEPTANCE, OPEN-QUESTIONS, research, SPEC, READMEs) are not
// published: a link to one becomes its plain text, and so does a link that is not https. The source is private, so a
// page that mentions github.com at all is refused (the notices may: they name third-party projects' sources).
// generateSite() fails, listing every problem, rather than produce a site with a broken link, a heading id the docs
// cannot reach, a mention of github.com in a page, a placeholder copyright holder or no third-party notices.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { REDIRECTS } from '../src/routes.ts';
import { escapeHtml, renderMarkdown, unescapeHtml, type Heading, type LinkDecision, type LinkRecord } from './markdown.ts';

export const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = resolve(SITE_ROOT, '..', '..');
export const PUBLIC_DIR = join(SITE_ROOT, 'public');
/** wrangler.jsonc `assets.directory`. */
export const DIST_DIR = join(SITE_ROOT, 'dist');
export const ORIGIN = 'https://smurg.ai';

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
/** Environment: `1` accepts the placeholders below (tests, local previews; never a deploy). */
export const PLACEHOLDER_ENV = 'SMURG_SITE_ALLOW_PLACEHOLDER';
/** LICENSE's copyright holder until the owner names one. */
export const PLACEHOLDER = '<COPYRIGHT HOLDER>';

export const DOCS_INDEX = '/docs/';
export const LICENSE_PAGE = '/license/';
export const NOTICES_FILE = '/third-party-notices.txt';
/** The web app's own notices (the license task: apps/web/public/third-party-notices.txt, served by the relay). */
export const WEB_APP_NOTICES = 'https://app.smurg.ai/third-party-notices.txt';

export interface DocPage {
  /** The Markdown file, relative to the repository. */
  readonly source: string;
  /** Where it is served. */
  readonly path: string;
  readonly label: string;
  /** One line for the docs index. */
  readonly summary: string;
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    source: 'docs/HOSTING.md',
    path: '/docs/hosting/',
    label: '主人指南',
    summary: '在自己的電腦上用 smurg host 分享資料夾：安裝、登入、分享前必讀、組員的權限設定、防止睡眠與疑難排解。',
  },
  {
    source: 'docs/JOINING.md',
    path: '/docs/joining/',
    label: '組員指南',
    summary: '用邀請連結加入別人分享的工作區：角色、一起編輯、看 agent 與提出建議、自己的 agent、worktree 與離開。',
  },
  {
    source: 'CHANGELOG.md',
    path: '/docs/changelog/',
    label: '變更紀錄',
    summary: '每個版本的變更與已知限制。',
  },
];

/** Files outside docs/ that a link may point at, and their URLs. */
const OTHER_TARGETS: ReadonlyMap<string, string> = new Map([
  ['LICENSE', LICENSE_PAGE],
  [COMMITTED_NOTICES, NOTICES_FILE],
]);

/** Ids the page template uses; a heading in the docs may not take one. */
const TEMPLATE_IDS = ['main'];

export interface SiteOptions {
  /** Where docs/, CHANGELOG.md and LICENSE are read (default: this repository). */
  readonly repoRoot?: string;
  /** The hand-written files (default: public/). */
  readonly publicDir?: string;
  /** A notices file (default: the output of NOTICES_COMMAND in this repository, see readNotices). */
  readonly notices?: string;
  /** Accept a LICENSE that still contains PLACEHOLDER and notices that still contain NOTICES_PLACEHOLDER. */
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

const MARK =
  '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect class="mark-bg" width="32" height="32" rx="8"/><path class="mark-ln" d="M11 16 22 9.5M11 16l11 6.5"/><rect class="mark-fg" x="6.5" y="11.5" width="9" height="9" rx="2.25"/><circle class="mark-fg" cx="22.5" cy="9.5" r="3.25"/><circle class="mark-fg" cx="22.5" cy="22.5" r="3.25"/></svg>';

type Lang = 'en' | 'zh-TW';

/** The words of the page chrome. public/index.html and public/zh-TW/index.html have the same footer, by hand. */
export const CHROME = {
  'zh-TW': {
    home: '/zh-TW/',
    homeLabel: 'smurg 首頁',
    skip: '跳到主要內容',
    mainNav: '主要',
    footerNav: '頁尾',
    docs: '文件',
    changelog: '變更紀錄',
    license: '授權條款',
    notices: '第三方授權聲明',
    webApp: '網頁版',
    footer: 'smurg 的執行檔在原型階段可以免費下載和使用。',
    other: { href: '/', lang: 'en', label: 'English' },
    locale: 'zh_TW',
  },
  en: {
    home: '/',
    homeLabel: 'smurg, home',
    skip: 'Skip to content',
    mainNav: 'Main',
    footerNav: 'Footer',
    docs: 'Docs',
    changelog: 'Changelog',
    license: 'License',
    notices: 'Third-party notices',
    webApp: 'Web app',
    footer: 'The smurg executables are free to download and use during the prototype.',
    other: { href: '/zh-TW/', lang: 'zh-TW', label: '繁體中文' },
    locale: 'en_US',
  },
} as const;

function footer(lang: Lang): string {
  const t = CHROME[lang];
  return `<footer class="site-footer">
  <div class="wrap footer-row">
    <p>${t.footer}</p>
    <nav aria-label="${t.footerNav}">
      <ul>
        <li><a href="${DOCS_INDEX}">${t.docs}</a></li>
        <li><a href="/docs/changelog/">${t.changelog}</a></li>
        <li><a href="${LICENSE_PAGE}">${t.license}</a></li>
        <li><a href="${NOTICES_FILE}">${t.notices}</a></li>
        <li><a href="https://app.smurg.ai/">${t.webApp}</a></li>
        <li><a href="${t.other.href}" hreflang="${t.other.lang}" lang="${t.other.lang}">${t.other.label}</a></li>
      </ul>
    </nav>
  </div>
</footer>`;
}

interface PageInput {
  readonly lang: Lang;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly main: string;
}

function page({ lang, path, title, description, main }: PageInput): string {
  const t = CHROME[lang];
  const current = (href: string): string => (href === path ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}${path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="smurg">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${ORIGIN}${path}">
<meta property="og:locale" content="${t.locale}">
<meta name="twitter:card" content="summary">
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>

<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="${t.home}" aria-label="${t.homeLabel}">
      ${MARK}
      <span>smurg</span>
    </a>
    <nav class="site-nav" aria-label="${t.mainNav}">
      <ul>
        <li><a href="${DOCS_INDEX}"${current(DOCS_INDEX)}>${t.docs}</a></li>
        <li><a href="https://app.smurg.ai/">${t.webApp}</a></li>
        <li class="lang"><a href="${t.other.href}" hreflang="${t.other.lang}" lang="${t.other.lang}">${t.other.label}</a></li>
      </ul>
    </nav>
  </div>
</header>

${main}

${footer(lang)}
</body>
</html>
`;
}

/** The docs navigation (zh-TW), with the current page marked. */
function docNav(path: string): string {
  const items: [string, string][] = [
    [DOCS_INDEX, '文件總覽'],
    ...DOC_PAGES.map((doc): [string, string] => [doc.path, doc.label]),
    [LICENSE_PAGE, '授權條款'],
    [NOTICES_FILE, '第三方授權聲明'],
  ];
  const li = items.map(([href, label]) => `<li><a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a></li>`);
  return `<nav class="doc-nav" aria-label="文件">\n<ul>\n${li.join('\n')}\n</ul>\n</nav>`;
}

/** The page's own table of contents: its second-level headings (on wide screens, beside the text). */
function toc(headings: readonly Heading[]): string {
  const sections = headings.filter((h) => h.depth === 2);
  if (sections.length < 2) return '';
  const li = sections.map((h) => `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`);
  return `\n<nav class="doc-toc" aria-label="本頁目錄">\n<ul>\n${li.join('\n')}\n</ul>\n</nav>`;
}

function docLayout(path: string, headings: readonly Heading[], body: string): string {
  return `<div class="wrap doc-layout">
<aside class="doc-side">
${docNav(path)}${toc(headings)}
</aside>
<main id="main" class="doc">
${body}</main>
</div>`;
}

/** The text of the first paragraph, for the description meta tag. */
function firstParagraph(html: string): string {
  const inner = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
  const text = unescapeHtml(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length <= 150 ? text : `${chars.slice(0, 149).join('')}…`;
}

function docsIndex(): string {
  const cards = DOC_PAGES.map(
    (doc) => `<li>\n<h2><a href="${doc.path}">${escapeHtml(doc.label)}</a></h2>\n<p>${escapeHtml(doc.summary)}</p>\n</li>`,
  ).join('\n');
  const body = `<h1>smurg 文件</h1>
<p class="doc-lede">安裝 smurg、分享資料夾、加入別人分享的工作區，以及每個版本的變更。</p>
<p class="doc-note" lang="en">The guides are in Traditional Chinese for now. The <a href="/" hreflang="en" lang="en">English home page</a> covers what smurg does, how to install it and what its security model protects.</p>
<ul class="doc-cards">
${cards}
</ul>
<h2 id="license">授權</h2>
<p>smurg 的執行檔在原型階段可以免費下載和使用，條款見<a href="${LICENSE_PAGE}">授權條款</a>（英文）。執行檔裡來自其他專案的元件，依它們各自的授權條款提供，列在<a href="${NOTICES_FILE}">第三方授權聲明</a>；網頁版用到的元件列在<a href="${WEB_APP_NOTICES}">網頁版的第三方授權聲明</a>。</p>
`;
  return page({
    lang: 'zh-TW',
    path: DOCS_INDEX,
    title: 'smurg 文件：安裝、分享資料夾、加入工作區',
    description: 'smurg 的使用說明（繁體中文）：主人指南、組員指南、變更紀錄、授權條款。',
    main: docLayout(DOCS_INDEX, [], body),
  });
}

function licensePage(text: string): string {
  const main = `<div class="wrap">
<main id="main" class="doc doc-single">
<h1>License</h1>
<p class="doc-lede">The terms under which you may download and use the smurg executables and use the web app. The components in them that come from other projects keep their own licenses: see the <a href="${NOTICES_FILE}">third-party notices</a> of the executables and those of the <a href="${WEB_APP_NOTICES}">web app</a>.</p>
<p class="doc-note" lang="zh-TW">授權條款目前只有英文版。</p>
<pre class="license-text">${escapeHtml(text.replace(/\s+$/, ''))}</pre>
</main>
</div>`;
  return page({ lang: 'en', path: LICENSE_PAGE, title: 'License · smurg', description: 'The license terms of the smurg executables and the smurg web app.', main });
}

// ---- links ----

function isGitHub(host: string): boolean {
  return host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
}

/** The link decisions for one Markdown file of the repository (see the header of this file). */
function linkResolver(source: string, targets: ReadonlyMap<string, string>): (href: string) => LinkDecision {
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
      if (isGitHub(url.hostname)) return { plain: 'GitHub (the source is private)' };
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
    const url = targets.get(target);
    if (url !== undefined) return { href: `${url}${fragment}` };
    return { plain: `${target} is not published` };
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

function checkSite(files: ReadonlyMap<string, Buffer>, reported: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const facts = new Map<string, PageFacts>();
  for (const [file, data] of files) if (file.endsWith('.html')) facts.set(file, pageFacts(data.toString('utf8')));

  for (const [file, data] of files) {
    if (reported.has(file)) continue;
    const text = data.toString('utf8');
    // The repository is private: nothing on the site may point at it.
    if (/github\.com\/gclinian|gclinian\/smurg/i.test(text)) problems.push(`${file} mentions the private repository`);
    if (file.endsWith('.html')) {
      const line = text.split('\n').findIndex((l) => /github\.com/i.test(l));
      if (line >= 0) problems.push(`${file}:${line + 1} mentions github.com: ${text.split('\n')[line]?.trim().slice(0, 120)}`);
    }
  }

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
  /** Generated pages whose github.com mentions were already reported at their Markdown line. */
  const reported = new Set<string>();
  /** A source that could not be read. */
  let missing = false;
  const files = new Map<string, Buffer>();
  const add = (path: string, data: string | Buffer): void => {
    if (files.has(path)) problems.push(`${path} is both in public/ and generated by the build`);
    files.set(path, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  };

  for (const path of listFiles(publicDir)) add(path, readFileSync(join(publicDir, path)));

  const targets = new Map<string, string>([...DOC_PAGES.map((doc): [string, string] => [doc.source, doc.path]), ...OTHER_TARGETS]);

  for (const doc of DOC_PAGES) {
    const markdown = readUtf8(join(repoRoot, doc.source), doc.source, problems);
    if (markdown === undefined) {
      missing = true;
      continue;
    }
    // Said here with the line in the Markdown (checkSite would only name the generated page).
    markdown.split('\n').forEach((line, i) => {
      if (!/github\.com/i.test(line)) return;
      problems.push(`${doc.source}:${i + 1} mentions github.com (the source is private): ${line.trim().slice(0, 120)}`);
      reported.add(`${doc.path.slice(1)}index.html`);
    });
    const rendered = renderMarkdown(markdown, { resolveLink: linkResolver(doc.source, targets), reservedIds: TEMPLATE_IDS, tableLabel: '表格' });
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
    const title = `${rendered.headings.find((h) => h.depth === 1)?.text ?? doc.label} · smurg`;
    const html = page({
      lang: 'zh-TW',
      path: doc.path,
      title,
      description: firstParagraph(rendered.html) || doc.summary,
      main: docLayout(doc.path, rendered.headings, rendered.html),
    });
    add(`${doc.path.slice(1)}index.html`, html);
  }
  add(`${DOCS_INDEX.slice(1)}index.html`, docsIndex());
  // Unknown paths under /docs/ get the Traditional Chinese 404 page (not_found_handling: the nearest 404.html).
  if (files.has('zh-TW/404.html')) add(`${DOCS_INDEX.slice(1)}404.html`, files.get('zh-TW/404.html') as Buffer);

  const license = readUtf8(join(repoRoot, 'LICENSE'), 'LICENSE', problems);
  if (license === undefined) missing = true;
  if (license !== undefined) {
    if (license.includes(PLACEHOLDER) && options.allowPlaceholder !== true) {
      problems.push(
        `LICENSE still names the copyright holder "${PLACEHOLDER}": the owner names the holder before the site is deployed (${PLACEHOLDER_ENV}=1 builds anyway, for local previews and tests only)`,
      );
    }
    add(`${LICENSE_PAGE.slice(1)}index.html`, licensePage(license));
  }

  const notices = readNotices(options, problems);
  if (notices === undefined) missing = true;
  if (notices !== undefined) add(NOTICES_FILE.slice(1), notices);

  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // With a source missing, every link to its page would be reported too: those come after the sources are there.
  if (!missing) problems.push(...checkSite(sorted, reported));
  if (problems.length > 0) throw new SiteError(problems);
  return { files: sorted, rewritten, plain, rawHtml };
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
