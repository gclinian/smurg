// Static checks of the whole site as it is deployed: public/ (the hand-written pages) plus the pages the build
// generates from the repository (scripts/site.ts: /docs/… and /license/ in both languages, /third-party-notices.txt,
// /sitemap.xml). What a reviewer would
// otherwise re-check by hand after every edit of a page or of the docs. The HTML is parsed with parse5 (the WHATWG
// algorithm), so a stray tag or a broken attribute fails here.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDIRECTS, REPOSITORY, route } from '../src/routes.ts';
import { Slugger } from '../scripts/markdown.ts';
import { CHROME, DOC_PAGES, HTML_LANG, LANGS, NOTICES_FILE, WEB_APP_NOTICES, docsIndex, homePage, licensePage, otherLang, pagePairs, type Lang } from '../scripts/site.ts';
import { FIXTURE_NOTICES, PUBLIC, REPO_ROOT, parsePage, publicFiles, rawText, readPublic, sitePages, siteText, testSite, type El, type Page } from './html.ts';

const HOME_PAGES = { en: 'index.html', 'zh-TW': 'zh-TW/index.html' } as const;
const NOT_FOUND_PAGES = ['404.html', 'zh-TW/404.html'];
const fileOf = (path: string): string => `${path.slice(1)}index.html`;
/** The generated pages: the docs index, the three documents and the license page, in each language. */
const GENERATED_PAGES = pagePairs()
  .slice(1)
  .flatMap((paths) => LANGS.map((lang) => fileOf(paths[lang])));
const INSTALL = 'curl -fsSL https://smurg.ai/install.sh | sh';
/** The relay's README, at its self-hosting section. */
const RELAY_README = `${REPOSITORY}/blob/main/apps/relay/README.md#self-hosting-on-workersdev`;
/** The only hosts the hand-written pages may mention: the app, the downloads, the site itself and the repository. */
const ALLOWED_HOSTS = ['app.smurg.ai', 'downloads.smurg.ai', 'smurg.ai', 'github.com'];
/** What the site must no longer say about smurg: it is MIT-licensed open source, and anyone can run a relay. */
const RETIRED_CLAIMS = /proprietary|All rights reserved|source (?:code )?(?:is|isn’t|is not) (?:private|public yet)|not public|isn’t public|free during the prototype|v0\.1\.0 prototype|currently in Traditional Chinese|專有軟體|原始碼不公開|原始碼沒有公開|原型期間免費|無法自己架設/i;
/** The language of a page, from its `<html lang>`. */
const langOf = (p: Page): Lang => (first(p, 'html')?.attr('lang') === HTML_LANG.en ? 'en' : 'zh-TW');

const pages = new Map<string, Page>(sitePages().map((path) => [path, parsePage(siteText(path))]));
const page = (path: string): Page => {
  const p = pages.get(path);
  if (p === undefined) throw new Error(`no page ${path}`);
  return p;
};
const first = (p: Page, tag: string): El | undefined => p.byTag(tag)[0];

/** The page a same-site path is served from (auto-trailing-slash), or undefined. Independent of the build's own. */
function servedPage(path: string): string | undefined {
  const files = testSite().files;
  const clean = path.replace(/[?#].*$/, '');
  const file = clean.endsWith('/') ? `${clean.slice(1)}index.html` : clean.slice(1);
  if (file.split('/').some((segment) => segment.startsWith('_'))) return undefined;
  return files.has(file) ? file : undefined;
}

/** Where a same-site path is answered: a file of the site or a Worker redirect. */
function resolves(path: string): boolean {
  const clean = path.replace(/[?#].*$/, '');
  return servedPage(clean) !== undefined || REDIRECTS.has(clean) || route(new Request(`https://smurg.ai${clean}`)) !== null;
}

/** Every href and src of a page, except references inside the page itself. */
function outLinks(path: string): string[] {
  return page(path).elements.flatMap((el) =>
    ['href', 'src'].map((name) => el.attr(name)).filter((value): value is string => value !== undefined && !value.startsWith('#')),
  );
}

describe('the built site', () => {
  it('is public/ plus exactly the generated pages (both languages), the notices and the sitemap', () => {
    const files = [...testSite().files.keys()];
    expect(GENERATED_PAGES).toHaveLength(10);
    expect(files.filter((path) => !publicFiles().includes(path)).sort()).toEqual([...GENERATED_PAGES, NOTICES_FILE.slice(1), 'sitemap.xml'].sort());
    expect(publicFiles().sort()).toEqual(['404.html', '_headers', 'copy.js', 'favicon.svg', 'index.html', 'robots.txt', 'style.css', 'zh-TW/404.html', 'zh-TW/index.html'].sort());
    // No 404 page of its own under /docs/: the nearest 404.html is the English one there, the Chinese one under /zh-TW/.
    expect(files).not.toContain('docs/404.html');
    // Generated files are never written into public/ (they live in the gitignored dist/).
    for (const path of GENERATED_PAGES) expect(publicFiles(), path).not.toContain(path);
  });

  it('public/ stays under 160 KB in total, and every page with everything it loads under 150 KB', () => {
    const total = publicFiles().reduce((sum, path) => sum + statSync(join(PUBLIC, path)).size, 0);
    expect(total).toBeLessThan(160 * 1024);
    const size = (path: string): number => testSite().files.get(path)?.length ?? Number.NaN;
    for (const path of sitePages()) {
      const loaded = page(path)
        .elements.filter((el) => (el.tag === 'link' && ['stylesheet', 'icon'].includes(el.attr('rel') ?? '')) || el.tag === 'script')
        .map((el) => (el.attr('href') ?? el.attr('src') ?? '').slice(1));
      const bytes = size(path) + loaded.reduce((sum, file) => sum + size(file), 0);
      // The host guide is the longest page (0.5.0: about 95 KB in English); with the stylesheet it stays under the 150 KB below.
      expect(size(path), `${path} itself`).toBeLessThan(104 * 1024);
      expect(bytes, `${path} with ${loaded.join(', ')}`).toBeLessThan(150 * 1024);
    }
    // The notices are text, not a page: generous, but bounded.
    expect(size(NOTICES_FILE.slice(1))).toBeLessThan(2 * 1024 * 1024);
  });

  it('_headers sends a strict CSP and the other security headers for every path', () => {
    const headers = readPublic('_headers');
    const block = /^\/\*\n((?:[ \t]+.+\n)+)/m.exec(headers)?.[1] ?? '';
    const csp = /Content-Security-Policy: (.+)/.exec(block)?.[1] ?? '';
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(csp).toContain(directive);
    }
    // No inline code, no other origin, no wildcard: everything comes from this site's own files.
    expect(csp).not.toMatch(/unsafe-|https?:|\*|data:/);
    for (const header of ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'Permissions-Policy: ', 'Strict-Transport-Security: ']) {
      expect(block).toContain(header);
    }
  });

  it('the hand-written files mention no host but app.smurg.ai, downloads.smurg.ai, smurg.ai and github.com, and only over https', () => {
    for (const path of publicFiles()) {
      // XML namespace names are identifiers, not addresses anything is loaded from.
      const text = readPublic(path).replace(/\sxmlns(?::\w+)?="[^"]*"/g, '');
      for (const [url] of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi)) {
        expect(url, `${path}: ${url}`).toMatch(/^https:\/\//);
        expect(ALLOWED_HOSTS, `${path}: ${url}`).toContain(new URL(url).hostname);
      }
    }
  });

  it('links GitHub only as the smurg repository (the notices name third-party sources too)', () => {
    let links = 0;
    for (const path of sitePages()) {
      for (const link of outLinks(path)) {
        if (link.startsWith('/')) continue;
        const url = new URL(link);
        expect(url.protocol, `${path}: ${link}`).toBe('https:');
        if (!/(^|\.)github(usercontent)?\.com$/.test(url.hostname)) continue;
        expect(link === REPOSITORY || link.startsWith(`${REPOSITORY}/blob/main/`) || link.startsWith(`${REPOSITORY}/tree/main/`), `${path}: ${link}`).toBe(true);
        links++;
      }
    }
    // Header and footer of every page that has them, the open-source sections, the FAQ, the docs.
    expect(links).toBeGreaterThan(30);
  });

  it('every repository file a page links on GitHub exists in this checkout', () => {
    const linked = new Map<string, Set<string>>();
    for (const path of sitePages()) {
      for (const link of outLinks(path)) {
        const match = /^https:\/\/github\.com\/gclinian\/smurg\/(?:blob|tree)\/main\/([^#?]+)(?:#(.*))?$/.exec(link);
        if (!match) continue;
        const file = decodeURI(match[1] as string);
        linked.set(file, (linked.get(file) ?? new Set()).add(match[2] ?? ''));
      }
    }
    expect([...linked.keys()].sort()).toEqual(['CONTRIBUTING.md', 'SECURITY.md', 'apps/relay/README.md']);
    for (const [path, fragments] of linked) {
      expect(statSync(join(REPO_ROOT, path), { throwIfNoEntry: false }) !== undefined, path).toBe(true);
      // A #fragment is a heading of that file, by GitHub's own rule for heading ids.
      const slugger = new Slugger();
      const ids = [...readFileSync(join(REPO_ROOT, path), 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) => slugger.slug((m[1] as string).replace(/`/g, '')));
      for (const fragment of fragments) if (fragment !== '') expect(ids, `${path}#${fragment}`).toContain(fragment);
    }
  });

  it('says that smurg is open source under the MIT License, and nothing of what was true before (proprietary, private source, one relay)', () => {
    for (const path of sitePages()) {
      // The changelog's released sections are history: 0.1.0 to 0.3.0 were proprietary, and they say so.
      if (!path.endsWith('docs/changelog/index.html')) expect(siteText(path), path).not.toMatch(RETIRED_CLAIMS);
      if (NOT_FOUND_PAGES.includes(path)) continue;
      const footer = /<footer class="site-footer">[\s\S]*<\/footer>/.exec(siteText(path))?.[0] ?? '';
      expect(footer, path).toContain(`<p>${CHROME[langOf(page(path))].footer}</p>`);
      expect(footer, path).toContain(`<a href="${REPOSITORY}">GitHub</a>`);
    }
    expect(CHROME.en.footer).toBe('smurg is open source under the MIT License.');
  });

  it('every same-site link and reference resolves: to a file of the site or a Worker redirect, and its #fragment to an element there', () => {
    const links: [string, string][] = [];
    for (const path of sitePages()) {
      for (const el of page(path).elements) {
        for (const name of ['href', 'src']) {
          const value = el.attr(name);
          if (value === undefined) continue;
          links.push([path, value]);
        }
      }
    }
    links.push(['robots.txt', /Sitemap: (\S+)/.exec(siteText('robots.txt'))?.[1] ?? '']);
    for (const [, loc] of siteText('sitemap.xml').matchAll(/(?:<loc>|href=")(https:\/\/[^<"]+)/g)) links.push(['sitemap.xml', loc as string]);
    expect(links.length).toBeGreaterThan(400);

    let anchors = 0;
    for (const [from, link] of links) {
      const url = new URL(link, `https://smurg.ai/${from}`);
      if (url.hostname !== 'smurg.ai') continue;
      expect(resolves(url.pathname), `${from}: ${link}`).toBe(true);
      if (url.hash.length <= 1) continue;
      const target = link.startsWith('#') ? from : servedPage(url.pathname);
      expect(target, `${from}: ${link}`).toBeDefined();
      expect(page(target as string).ids(), `${from}: ${link}`).toContain(decodeURIComponent(url.hash.slice(1)));
      anchors++;
    }
    // The docs' own tables of contents and the generated ones (JOINING.md has one, every docs page gets one).
    expect(anchors).toBeGreaterThan(60);
  });

  it('reaches every page from the two home pages by following its links', () => {
    const seen = new Set<string>();
    const queue = Object.values(HOME_PAGES) as string[];
    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      if (!path.endsWith('.html')) continue;
      for (const link of outLinks(path)) {
        const url = new URL(link, `https://smurg.ai/${path}`);
        if (url.hostname !== 'smurg.ai') continue;
        const target = servedPage(url.pathname);
        if (target !== undefined && !seen.has(target)) queue.push(target);
      }
    }
    const unreachable = [...testSite().files.keys()].filter((path) => !seen.has(path) && !path.startsWith('_') && !NOT_FOUND_PAGES.includes(path));
    // Files that are not pages are loaded by the pages (style.css, copy.js, favicon.svg) or read by crawlers.
    expect(unreachable.sort()).toEqual(['robots.txt', 'sitemap.xml']);
  });

  it('copy.js does no networking and writes no HTML (Trusted Types would refuse it anyway)', () => {
    const script = readPublic('copy.js').replace(/\/\/.*$/gm, '');
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
  });

  it('style.css loads nothing (no @import, no url(), no web fonts)', () => {
    const css = readPublic('style.css');
    expect(css).not.toMatch(/@import|url\(|@font-face/);
  });

  it('keeps the 404 pages out of search results, and the sitemap and robots.txt consistent', () => {
    for (const path of NOT_FOUND_PAGES) {
      expect(page(path).byTag('meta').some((m) => m.attr('name') === 'robots' && m.attr('content') === 'noindex'), path).toBe(true);
    }
    const sitemap = siteText('sitemap.xml');
    // Every page that exists in both languages, English first, each with the same three alternates.
    const expected = pagePairs().flatMap((paths) => LANGS.map((lang) => `https://smurg.ai${paths[lang]}`));
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(expected);
    expect(expected).toHaveLength(12);
    const entries = sitemap.split('<url>').slice(1);
    pagePairs().forEach((paths, i) => {
      for (const entry of [entries[2 * i], entries[2 * i + 1]]) {
        expect([...(entry ?? '').matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]])).toEqual([
          ['en', `https://smurg.ai${paths.en}`],
          ['zh-Hant-TW', `https://smurg.ai${paths['zh-TW']}`],
          ['x-default', `https://smurg.ai${paths.en}`],
        ]);
      }
    });
    expect(siteText('robots.txt')).toContain('Sitemap: https://smurg.ai/sitemap.xml');
  });
});

for (const path of sitePages()) {
  describe(path, () => {
    const p = page(path);
    const html = siteText(path);
    const ids = p.ids();

    it('parses without a single HTML parse error', () => {
      expect(p.errors).toEqual([]);
      expect(html).toMatch(/^<!doctype html>\n/);
    });

    it('has a language, one title, the charset, a viewport, the shared stylesheet and the icon', () => {
      const root = first(p, 'html');
      expect(['en', 'zh-Hant-TW']).toContain(root?.attr('lang'));
      // Under /zh-TW/ the page is Traditional Chinese, everywhere else English.
      expect(root?.attr('lang')).toBe(path.startsWith('zh-TW/') ? 'zh-Hant-TW' : 'en');
      const titles = p.byTag('title').filter((t) => t.parents.at(-1)?.tag === 'head');
      expect(titles).toHaveLength(1);
      expect(titles[0]?.text().length).toBeGreaterThan(10);
      const metas = p.byTag('meta');
      expect(metas.some((m) => m.attr('charset') === 'utf-8')).toBe(true);
      expect(metas.some((m) => m.attr('name') === 'viewport' && m.attr('content') === 'width=device-width, initial-scale=1')).toBe(true);
      const links = p.byTag('link');
      expect(links.some((l) => l.attr('rel') === 'stylesheet' && l.attr('href') === '/style.css')).toBe(true);
      expect(links.some((l) => l.attr('rel') === 'icon' && l.attr('href') === '/favicon.svg' && l.attr('type') === 'image/svg+xml')).toBe(true);
    });

    it('has the landmarks: a skip link first, one banner header, one main#main, one h1', () => {
      const body = first(p, 'body');
      const focusable = p.elements.filter((el) => el.parents.includes(body as El) && (el.tag === 'a' || el.tag === 'button'));
      expect(focusable[0]?.attr('href')).toBe('#main');
      expect(focusable[0]?.attr('class')).toBe('skip');
      const headers = p.byTag('header');
      expect(headers).toHaveLength(1);
      expect(headers[0]?.parents.at(-1)?.tag).toBe('body');
      const mains = p.byTag('main');
      expect(mains).toHaveLength(1);
      expect(mains[0]?.attr('id')).toBe('main');
      expect(p.byTag('h1')).toHaveLength(1);
      for (const nav of p.byTag('nav')) expect(nav.attr('aria-label'), 'every nav is named').toBeTruthy();
    });

    it('loads nothing from another origin and has no inline script, style or event handler (the CSP forbids them)', () => {
      for (const el of p.elements) {
        for (const { name } of el.node.attrs) {
          expect(name, `<${el.tag} ${name}>`).not.toMatch(/^on/);
          expect(name, `<${el.tag} ${name}>`).not.toBe('style');
        }
        if (el.tag === 'script') {
          expect(el.attr('src'), 'no inline script').toMatch(/^\/[^/]/);
          expect(el.text()).toBe('');
        }
        if (el.tag === 'link' && !['canonical', 'alternate'].includes(el.attr('rel') ?? '')) expect(el.attr('href'), el.attr('rel')).toMatch(/^\/[^/]/);
        expect(['style', 'img', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'base', 'form', 'input'], `<${el.tag}>`).not.toContain(el.tag);
        const href = el.attr('href') ?? el.attr('src') ?? '';
        expect(href, `<${el.tag}>`).not.toMatch(/^\s*(javascript|data|vbscript):/i);
      }
      expect(html).not.toMatch(/http-equiv/i);
    });

    it('has unique ids, and every reference (#links, ARIA, data-copy, <use>) points at one', () => {
      expect(new Set(ids).size).toBe(ids.length);
      for (const el of p.elements) {
        const refs = [
          ...['aria-labelledby', 'aria-describedby', 'aria-controls', 'for'].flatMap((name) => (el.attr(name) ?? '').split(/\s+/).filter(Boolean)),
          ...[el.attr('data-copy')].filter((v): v is string => v !== undefined),
          ...[el.attr('href')].filter((v): v is string => v !== undefined && v.startsWith('#') && v.length > 1).map((v) => decodeURIComponent(v.slice(1))),
        ];
        for (const ref of refs) expect(ids, `<${el.tag}> -> ${ref}`).toContain(ref);
      }
    });

    it('every link has an href, every button a type, every section a name, every SVG a name or aria-hidden', () => {
      for (const a of p.byTag('a')) expect(a.attr('href'), a.text()).toBeTruthy();
      for (const button of p.byTag('button')) expect(button.attr('type')).toBe('button');
      for (const section of p.byTag('section')) {
        const label = section.attr('aria-labelledby');
        expect(label, `section#${section.attr('id')}`).toBeTruthy();
        expect(p.elements.find((el) => el.attr('id') === label)?.tag).toMatch(/^h[1-3]$/);
      }
      for (const svg of p.byTag('svg')) {
        const insidePicture = svg.parents.some((el) => el.attr('role') === 'img');
        const named = svg.attr('role') === 'img' && (svg.children().some((c) => c.tag === 'title') || svg.attr('aria-label') !== undefined);
        expect(insidePicture || named || svg.attr('aria-hidden') === 'true', `svg.${svg.attr('class')}`).toBe(true);
      }
      for (const picture of p.elements.filter((el) => el.attr('role') === 'img' && el.tag !== 'svg')) {
        expect(picture.attr('aria-label')?.length, picture.attr('class')).toBeGreaterThan(40);
      }
      // A focusable scroll box (a wide table) is a named region.
      for (const box of p.elements.filter((el) => el.attr('tabindex') !== undefined)) {
        expect(box.attr('tabindex')).toBe('0');
        expect(box.attr('role')).toBe('region');
        expect(box.attr('aria-label')?.length).toBeGreaterThan(2);
      }
    });

    it('headings never skip a level', () => {
      const levels = p.elements.filter((el) => /^h[1-6]$/.test(el.tag)).map((el) => Number(el.tag.slice(1)));
      expect(levels[0]).toBe(1);
      for (let i = 1; i < levels.length; i++) expect((levels[i] as number) - (levels[i - 1] as number), `heading ${i}`).toBeLessThanOrEqual(1);
    });

    it('links to the same page in the other language with hreflang and lang, names both as alternates, and never redirects by itself', () => {
      const lang = langOf(p);
      const other = otherLang(lang);
      const pair = pagePairs().find((paths) => fileOf(paths[lang]) === path);
      // A 404 page has no counterpart: it links the other language's home page.
      expect(pair === undefined).toBe(NOT_FOUND_PAGES.includes(path));
      const href = pair === undefined ? homePage(other) : pair[other];
      const switches = p.byTag('a').filter((a) => a.attr('hreflang') !== undefined);
      expect(switches.length).toBeGreaterThan(0);
      for (const a of switches) {
        expect(a.attr('href')).toBe(href);
        expect(a.attr('hreflang')).toBe(HTML_LANG[other]);
        expect(a.attr('lang')).toBe(HTML_LANG[other]);
      }
      // The language link of the header carries the other language's own name.
      expect(switches.some((a) => a.parents.some((el) => el.tag === 'header') && a.text() === CHROME[other].name)).toBe(true);
      const alternates = p.byTag('link').filter((l) => l.attr('rel') === 'alternate').map((l) => [l.attr('hreflang'), l.attr('href')]);
      expect(alternates).toEqual(
        pair === undefined
          ? []
          : [
              ['en', `https://smurg.ai${pair.en}`],
              ['zh-Hant-TW', `https://smurg.ai${pair['zh-TW']}`],
              ['x-default', `https://smurg.ai${pair.en}`],
            ],
      );
      if (pair !== undefined) expect(p.byTag('link').find((l) => l.attr('rel') === 'canonical')?.attr('href')).toBe(`https://smurg.ai${pair[lang]}`);
      expect(html).not.toMatch(/http-equiv|location\.(?:href|replace|assign)/i);
    });

    it('links only pages of its own language (but for the language link and the notices)', () => {
      const lang = langOf(p);
      for (const a of p.byTag('a')) {
        const href = a.attr('href') ?? '';
        if (!href.startsWith('/') || a.attr('hreflang') !== undefined || href === NOTICES_FILE) continue;
        // The guides name their own translation in the first paragraph (a link without hreflang, from Markdown).
        if (a.parents.some((el) => el.tag === 'main') && pagePairs().some((paths) => paths[otherLang(lang)] === href && fileOf(paths[lang]) === path)) continue;
        expect(href.startsWith('/zh-TW/'), `${path}: ${href}`).toBe(lang === 'zh-TW');
      }
    });
  });
}

describe('the two home pages', () => {
  it.each(Object.entries(HOME_PAGES))('%s: canonical, alternates, Open Graph, the install line and the copy button', (lang, path) => {
    const p = page(path);
    const url = lang === 'en' ? 'https://smurg.ai/' : 'https://smurg.ai/zh-TW/';
    const links = p.byTag('link');
    const meta = (key: string) => p.byTag('meta').find((m) => m.attr('property') === key || m.attr('name') === key)?.attr('content');
    expect(first(p, 'html')?.attr('lang')).toBe(HTML_LANG[lang as Lang]);
    expect(links.filter((l) => l.attr('rel') === 'canonical').map((l) => l.attr('href'))).toEqual([url]);
    expect(links.filter((l) => l.attr('rel') === 'alternate').map((l) => [l.attr('hreflang'), l.attr('href')])).toEqual([
      ['en', 'https://smurg.ai/'],
      ['zh-Hant-TW', 'https://smurg.ai/zh-TW/'],
      ['x-default', 'https://smurg.ai/'],
    ]);
    expect(meta('og:url')).toBe(url);
    expect(meta('og:title')?.length).toBeGreaterThan(10);
    expect(meta('description')?.length).toBeGreaterThan(50);
    expect(meta('twitter:card')).toBe('summary');
    // The install line, exactly, once; the copy button stays hidden until copy.js finds a clipboard.
    const commands = p.elements.filter((el) => el.attr('id') === 'install-cmd');
    expect(commands.map((el) => [el.tag, el.text()])).toEqual([['code', INSTALL]]);
    const copy = p.byTag('button').find((b) => b.attr('data-copy') === 'install-cmd');
    expect(copy?.attr('hidden')).toBe('');
    expect(p.byTag('script').map((s) => s.attr('src'))).toEqual(['/copy.js']);
    // The install note says where the executable comes from and that it is checked.
    const note = p.elements.find((el) => el.attr('class') === 'install-note')?.text() ?? '';
    expect(note).toContain('downloads.smurg.ai');
    expect(note).toMatch(/SHA-?256/i);
    expect(note).toContain('SHA256SUMS');
  });

  it.each(Object.entries(HOME_PAGES))('%s: the footer links the docs, the changelog, the license, the notices, GitHub, the app and the other language', (lang, path) => {
    const l = lang as Lang;
    const footer = page(path).elements.filter((el) => el.tag === 'a' && el.parents.some((parent) => parent.tag === 'footer'));
    expect(footer.map((a) => a.attr('href'))).toEqual([docsIndex(l), `${docsIndex(l)}changelog/`, licensePage(l), NOTICES_FILE, REPOSITORY, 'https://app.smurg.ai/', homePage(otherLang(l))]);
  });

  it.each(Object.entries(HOME_PAGES))('%s: links its own language’s docs pages from its docs section', (lang, path) => {
    const l = lang as Lang;
    const section = page(path).elements.find((el) => el.tag === 'section' && el.attr('id') === 'docs');
    const links = page(path).elements.filter((el) => el.tag === 'a' && el.parents.includes(section as El)).map((a) => a.attr('href'));
    expect(links).toEqual([...DOC_PAGES.map((doc) => doc[l].path), licensePage(l), NOTICES_FILE]);
  });

  it('have the same sections and ids in the same order', () => {
    const en = page(HOME_PAGES.en);
    const zh = page(HOME_PAGES['zh-TW']);
    expect(en.ids()).toEqual(zh.ids());
    const sections = (p: Page) => p.byTag('section').map((s) => s.attr('id') ?? s.attr('aria-labelledby'));
    expect(sections(en)).toEqual(['hero-title', 'how', 'features', 'security', 'platforms', 'docs', 'open-source', 'faq']);
    expect(sections(zh)).toEqual(sections(en));
    // The same links in the same order, each to its own language's page.
    const hrefs = (p: Page) => p.byTag('a').map((a) => (a.attr('href') ?? '').replace(/^\/zh-TW\//, '/'));
    expect(hrefs(zh)).toEqual(hrefs(en));
  });

  it('show no version number and no statement about the app’s language being Chinese only', () => {
    for (const path of Object.values(HOME_PAGES)) {
      const text = page(path).elements.find((el) => el.tag === 'body')?.text() ?? '';
      // (2.1.288 is the Claude Code version the host needs, not smurg's.)
      expect(text, path).toContain('2.1.288');
      expect(text.replaceAll('2.1.288', ''), path).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
      expect(text, path).not.toMatch(/Traditional Chinese for now|English is coming/);
    }
    const texts = page(HOME_PAGES.en).elements.map((el) => el.text());
    expect(texts).toContain('Got an invite link? Open it in Chrome; there is nothing to install.');
    // Both pages say which languages smurg speaks.
    expect(page(HOME_PAGES.en).elements.find((el) => el.tag === 'body')?.text()).toContain('English and Traditional Chinese');
    expect(page(HOME_PAGES['zh-TW']).elements.find((el) => el.tag === 'body')?.text()).toContain('英文與繁體中文');
  });

  it.each(Object.entries(HOME_PAGES))('%s: has an “Open source (MIT)” section that links the repository, the relay’s README, CONTRIBUTING and SECURITY', (lang, path) => {
    const p = page(path);
    const section = p.elements.find((el) => el.tag === 'section' && el.attr('id') === 'open-source');
    expect(p.elements.find((el) => el.attr('id') === 'open-source-title')?.text()).toBe(lang === 'en' ? 'Open source (MIT)' : '開放原始碼（MIT）');
    const links = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(section as El)).map((a) => a.attr('href'));
    expect(links).toEqual([REPOSITORY, RELAY_README, `${REPOSITORY}/blob/main/CONTRIBUTING.md`, `${REPOSITORY}/blob/main/SECURITY.md`]);
    expect(section?.text()).toMatch(lang === 'en' ? /open source under the MIT License/ : /開放原始碼軟體，以 MIT 授權條款釋出/);
    // The header links GitHub too.
    expect(p.elements.filter((el) => el.tag === 'a' && el.parents.some((parent) => parent.tag === 'header')).map((a) => a.attr('href'))).toContain(REPOSITORY);
  });

  it.each(Object.entries(HOME_PAGES))('%s: says that the source is public and that you can run your own relay, with a link to the relay’s README', (lang, path) => {
    const p = page(path);
    const text = p.elements.find((el) => el.tag === 'body')?.text() ?? '';
    expect(text).toMatch(lang === 'en' ? /run your own relay/ : /自己架設 relay/);
    expect(text).not.toMatch(/can’t run (?:your|their) own|only relay for now|無法自己架設|沒有其他 relay/);
    const faq = p.elements.find((el) => el.tag === 'section' && el.attr('id') === 'faq');
    const questions = p.byTag('h3').filter((h) => h.parents.includes(faq as El)).map((h) => h.text());
    const answer = (question: string): El | undefined => p.byTag('h3').find((h) => h.text() === question)?.parents.at(-1);
    const [source, relay] = lang === 'en' ? ['Can I see the source code?', 'Can I run my own relay?'] : ['看得到原始碼嗎？', '可以自己架設 relay 嗎？'];
    expect(questions).toEqual(expect.arrayContaining([source, relay]));
    expect(answer(source as string)?.text()).toMatch(lang === 'en' ? /^Can I see the source code\? Yes\. smurg is open source under the MIT License/ : /^看得到原始碼嗎？ 看得到。/);
    expect(answer(relay as string)?.text()).toMatch(lang === 'en' ? /^Can I run my own relay\? Yes\./ : /^可以自己架設 relay 嗎？ 可以。/);
    const hrefs = (el: El | undefined) => p.elements.filter((a) => a.tag === 'a' && a.parents.includes(el as El)).map((a) => a.attr('href'));
    expect(hrefs(answer(source as string))).toEqual([licensePage(lang as Lang), REPOSITORY, NOTICES_FILE, WEB_APP_NOTICES]);
    expect(hrefs(answer(relay as string))).toEqual([RELAY_README]);
  });

  it.each(Object.entries(HOME_PAGES))('%s: says what was verified, whose Claude account does the work, and what agents may do by themselves', (lang, path) => {
    const text = page(path).elements.find((el) => el.tag === 'body')?.text() ?? '';
    if (lang === 'en') {
      // The flow was verified against a scripted stand-in, not a real model (OWNER-DECISIONS: no real-account testing).
      expect(text).toContain('tested with a scripted stand-in for the model, not with a real Claude account');
      expect(text).toContain('Has this been tested with real Claude?');
      // Whose account, and the terms (OWNER-DECISIONS Q6); the host's own rules apply (Q7).
      expect(text).toContain('Anthropic’s terms don’t allow making a personal subscription available to other people');
      expect(text).toContain('your own Claude Code settings already allow');
      expect(text).toContain('asks before commands');
      expect(text).toMatch(/git repository/);
    } else {
      expect(text).toContain('用照劇本回應的模型替身測試的，沒有用真正的 Claude 帳號');
      expect(text).toContain('這套流程用真正的 Claude 測試過嗎？');
      expect(text).toContain('Anthropic 的條款不允許把個人訂閱提供給其他人使用');
      expect(text).toContain('你自己的 Claude Code 設定已經允許的');
      expect(text).toContain('執行指令前會先問');
      expect(text).toContain('git 儲存庫');
    }
  });

  it.each(Object.values(HOME_PAGES))('%s: claims no sandbox for teammates, and says what the Agent access role means and that it runs as the host', (path) => {
    const text = page(path).elements.find((el) => el.tag === 'body')?.text() ?? '';
    const titles = page(path).byTag('title').map((t) => t.text()).join('\n');
    for (const all of [text, titles]) {
      expect(all).not.toMatch(/Seatbelt|bubblewrap|AppArmor|socat|ripgrep|allow-listed|白名單|guest sandbox|客人沙盒|in a sandbox|在沙盒裡執行|--allow-main-workspace-guests|\brunners?\b|可執行 agent|API key|can use agents/i);
    }
    if (path === HOME_PAGES.en) {
      // The role names of docs/GLOSSARY.md.
      expect(text).toContain('Agent access role');
      expect(text).toContain('as Viewer, Editor or with Agent access');
      expect(text).toMatch(/runs? (?:on the host’s computer )?as the host/);
      expect(text).toContain('run any command on your computer, read your home folder and use your Claude account');
      expect(text).toContain('fully trust');
    } else {
      expect(text).toContain('「可使用 agent」');
      expect(text).toContain('以主人的身分');
      expect(text).toContain('執行任何指令、讀你的家目錄、用你的 Claude 帳號');
      expect(text).toContain('完全信任');
    }
  });

  it.each(Object.entries(HOME_PAGES))('%s: the workspace picture is labelled in the page’s own language, with a valid workspace id and the agent names the app shows', (lang, path) => {
    const p = page(path);
    const mock = p.elements.find((el) => el.attr('class') === 'mock');
    expect(mock?.attr('role')).toBe('img');
    const app = mock?.children().find((c) => c.attr('class') === 'm-app');
    // The labels are in the page's language: no `lang` of its own any more.
    expect(app?.attr('lang')).toBeUndefined();
    const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
    const labels = p.elements.filter((el) => el.parents.includes(app as El) && el.children().length === 0).map((el) => el.text());
    if (lang === 'en') for (const label of labels) expect(label, label).not.toMatch(cjk);
    else expect(labels.filter((label) => cjk.test(label)).length).toBeGreaterThan(15);
    // The picture is the sessions view: the mode switch, the inbox and the session list on the left, then the columns.
    const texts = p.elements.filter((el) => el.parents.includes(app as El) && el.children().length === 0).map((el) => el.text());
    for (const label of lang === 'en' ? ['Sessions', 'Code mode', 'Agents are waiting', 'For you to look at', 'Question from Claude', 'Submit answer', 'Who is responsible', "I've reviewed this"] : ['手寫 code 模式', 'agent 在等你', '等你看的', 'Claude 的選擇題', '送出答案', '誰負責', '我已看過']) {
      expect(texts, label).toContain(label);
    }
    // In a conversation the agent is `Claude` in both languages (docs/GLOSSARY.md), never with full-width parentheses.
    expect(texts).toContain('Claude');
    expect(app?.text()).not.toMatch(/Claude（/);
    // What a person or an agent wrote (not a label of the app) is marked, so the quote lint can tell the two apart;
    // a command is a `pre.m-term`.
    const said = p.elements.filter((el) => el.parents.includes(app as El) && (el.attr('class') ?? '').split(' ').includes('m-said'));
    expect(said.length).toBeGreaterThan(15);
    for (const el of said) expect(el.children(), el.text()).toEqual([]);
    const address = p.elements.find((el) => el.attr('class') === 'm-url')?.text() ?? '';
    // packages/protocol WORKSPACE_ID_PATTERN: 16 to 64 of [A-Za-z0-9_-].
    expect(address).toMatch(/^app\.smurg\.ai\/w\/[A-Za-z0-9_-]{16,64}$/);
  });
});

describe('the generated pages', () => {
  const docs = LANGS.flatMap((lang) => DOC_PAGES.map((doc) => [lang, doc[lang].source, doc[lang].path] as const));

  it.each(docs)('%s: %s at %s: its own h1, a canonical URL, the docs navigation of its language and a table of contents', (lang, source, path) => {
    const file = fileOf(path);
    const p = page(file);
    const markdownTitle = /^# (.+)$/m.exec(readFileSync(join(REPO_ROOT, source), 'utf8'))?.[1];
    expect(first(p, 'html')?.attr('lang')).toBe(HTML_LANG[lang]);
    expect(first(p, 'h1')?.text()).toBe(markdownTitle?.replace(/`/g, ''));
    expect(p.byTag('link').find((l) => l.attr('rel') === 'canonical')?.attr('href')).toBe(`https://smurg.ai${path}`);
    const nav = p.elements.find((el) => el.attr('class') === 'doc-nav');
    expect(nav?.attr('aria-label')).toBe(CHROME[lang].docsNav);
    const navLinks = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(nav as El));
    expect(navLinks.map((a) => a.attr('href'))).toEqual([docsIndex(lang), ...DOC_PAGES.map((doc) => doc[lang].path), licensePage(lang), NOTICES_FILE]);
    expect(navLinks.map((a) => a.text())).toEqual([CHROME[lang].docsOverview, ...DOC_PAGES.map((doc) => doc[lang].label), CHROME[lang].license, CHROME[lang].notices]);
    expect(navLinks.filter((a) => a.attr('aria-current') === 'page').map((a) => a.attr('href'))).toEqual([path]);
    // The table of contents lists the h2s of the page, in order (a page with one section has none).
    const toc = p.elements.find((el) => el.attr('class') === 'doc-toc');
    const tocLinks = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(toc as El)).map((a) => a.attr('href'));
    const h2s = p.byTag('h2').filter((h) => h.parents.some((el) => el.tag === 'main')).map((h) => `#${h.attr('id')}`);
    expect(h2s.length).toBeGreaterThan(0);
    expect(tocLinks).toEqual(h2s.length > 1 ? h2s : []);
    expect(toc === undefined).toBe(h2s.length < 2);
    if (toc !== undefined) expect(toc.attr('aria-label')).toBe(CHROME[lang].toc);
    // A table's scroll box is named in the page's language.
    for (const box of p.elements.filter((el) => el.attr('class') === 'table-wrap')) expect(box.attr('aria-label')).toMatch(lang === 'en' ? /^Table: / : /^表格：/);
  });

  it('the English guides hold no Chinese but the name of the other language, and the Chinese guides are Chinese', () => {
    const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g;
    for (const doc of DOC_PAGES) {
      const english = readFileSync(join(REPO_ROOT, doc.en.source), 'utf8');
      expect([...new Set(english.match(cjk) ?? [])], doc.en.source).toEqual([CHROME['zh-TW'].name]);
      expect((readFileSync(join(REPO_ROOT, doc['zh-TW'].source), 'utf8').match(cjk) ?? []).length, doc['zh-TW'].source).toBeGreaterThan(200);
    }
    expect(CHROME['zh-TW'].name).toBe('繁體中文');
    expect(CHROME.en.name).toBe('English');
  });

  it.each(LANGS)('%s: the docs index links every docs page of its language, the license, the repository and both notices', (lang) => {
    const p = page(fileOf(docsIndex(lang)));
    expect(first(p, 'html')?.attr('lang')).toBe(HTML_LANG[lang]);
    expect(first(p, 'h1')?.text()).toBe(CHROME[lang].indexHeading);
    // No note about another language any more: each language has its own guides.
    expect(p.elements.find((el) => el.attr('class') === 'doc-note')).toBeUndefined();
    const main = first(p, 'main');
    const links = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(main as El)).map((a) => a.attr('href'));
    expect(links).toEqual([...DOC_PAGES.map((doc) => doc[lang].path), licensePage(lang), REPOSITORY, NOTICES_FILE, WEB_APP_NOTICES]);
    expect(main?.text()).toContain(lang === 'en' ? 'open source under the MIT License' : '以 MIT 授權條款釋出');
  });

  it.each(LANGS)('%s: the license page shows LICENSE (MIT) exactly, as English text', (lang) => {
    const license = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8');
    const p = page(fileOf(licensePage(lang)));
    const pre = p.elements.find((el) => el.tag === 'pre' && el.attr('class') === 'license-text');
    expect(rawText(pre as El)).toBe(license.replace(/\s+$/, ''));
    expect(first(p, 'html')?.attr('lang')).toBe(HTML_LANG[lang]);
    // The Chinese page introduces the English text in Chinese and marks the text as English.
    expect(pre?.attr('lang')).toBe(lang === 'en' ? undefined : 'en');
    expect(p.elements.find((el) => el.attr('class') === 'doc-note')?.text()).toBe(lang === 'en' ? undefined : CHROME['zh-TW'].licenseNote);
    expect(p.elements.find((el) => el.attr('class') === 'doc-lede')?.text()).toMatch(lang === 'en' ? /^smurg is open source under the MIT License/ : /^smurg 是開放原始碼軟體，以 MIT 授權條款釋出/);
    // The repository's LICENSE is the MIT License (the open-source work package's file).
    expect(license.split('\n')[0]).toBe('MIT License');
    expect(license).toContain('Permission is hereby granted, free of charge');
  });

  it('the guides explain the Agent access role and its risk in both languages, and offer no guest sandbox, guest Claude login or removed option', () => {
    const text = (lang: Lang, index: number): string => siteText(fileOf((DOC_PAGES[index] as (typeof DOC_PAGES)[number])[lang].path));
    for (const lang of LANGS) {
      for (const html of [text(lang, 0), text(lang, 1)]) {
        expect(html).not.toMatch(/客人沙盒|guest sandbox|bubblewrap|AppArmor|Seatbelt|--allow-main-workspace-guests|--no-main-workspace-guests|--no-guest-subscription-login|可執行 agent|can run agents|can use agents|runner|用 Claude 訂閱登入|匯入個人設定/i);
        // Nothing that was true only while the source was private or of versions that are gone.
        expect(html).not.toMatch(RETIRED_CLAIMS);
        expect(html).not.toMatch(/0\.[123]\.0/);
      }
    }
    const hosting = text('en', 0);
    expect(hosting).toContain('id="4-before-you-share"');
    expect(hosting).toContain('id="5-agent-access-and-agents-shell-commands"');
    for (const phrase of ['run any command on your computer', 'read your home folder', 'use your Claude account', 'Give this role only to people you fully', 'the usage and the cost are yours', '--role agent', 'you can run your own relay']) {
      expect(hosting, phrase).toContain(phrase);
    }
    expect(text('en', 1)).toContain('as the host');
    // The sections the `smurg` command's help links by their heading (packages/cli/src/i18n: usage.host, usage.status,
    // usage.uninstall, usage.attach), and the ones 0.5.0 added.
    for (const id of ['7-status-and-stopping', '9-updating-and-removing', '10-topics-from-the-hosts-side']) expect(hosting, id).toContain(`id="${id}"`);
    for (const id of ['10-joining-from-a-terminal-cli-optional', '6-topics-from-discussion-to-reviewed-result']) expect(text('en', 1), id).toContain(`id="${id}"`);
    // What 0.5.0 must say to a host: the Claude Code floor, git for work items, whose account, the host's own rules,
    // and that the flow was verified against a scripted stand-in.
    for (const phrase of ['2.1.288 or later', 'git 2.42 or later', 'Your own allow rules apply', 'a Team or Enterprise plan', 'scripted stand-in for the model', 'No real Claude account was used']) {
      expect(hosting, phrase).toContain(phrase);
    }
    const zh = text('zh-TW', 0);
    expect(zh).toContain('id="5-可使用-agent角色與-agent-的-shell-指令"');
    for (const phrase of ['在你的電腦上執行任何指令', '讀取你的家目錄', '使用你的 Claude 帳號', '只把這個角色給你完全信任的人', '用量和費用都算在你身上', '--role agent', '你可以自己架設 relay']) {
      expect(zh, phrase).toContain(phrase);
    }
    for (const id of ['7-狀態與停止', '9-更新與移除']) expect(zh, id).toContain(`id="${id}"`);
    expect(text('zh-TW', 1)).toContain('id="10-用終端機cli加入選用"');
    for (const phrase of ['2.1.288 以上', '你自己的允許規則也有效', 'Team 或 Enterprise 方案', '照劇本回應的', '沒有使用任何真正的 Claude 帳號']) {
      expect(zh, phrase).toContain(phrase);
    }
    expect(text('zh-TW', 1)).toContain('以主人的身分');
    // The relay's README is linked on GitHub from both host guides.
    for (const html of [hosting, zh]) expect(html).toContain(`<a href="${RELAY_README}">`);
  });

  it('the notices are the file the build was given, byte for byte (here the tests\' fixture)', () => {
    expect(testSite().files.get(NOTICES_FILE.slice(1))?.equals(readFileSync(FIXTURE_NOTICES))).toBe(true);
  });

  it('every page of a language has the same footer, but for the address of its own counterpart', () => {
    const footers = new Map<string, string>();
    for (const path of sitePages()) {
      if (NOT_FOUND_PAGES.includes(path)) continue;
      const lang = first(page(path), 'html')?.attr('lang') as string;
      const footer = /<footer class="site-footer">[\s\S]*<\/footer>/.exec(siteText(path))?.[0]?.replace(/<a href="[^"]*" hreflang=/, '<a href="…" hreflang=');
      expect(footer, path).toBeDefined();
      if (!footers.has(lang)) footers.set(lang, footer as string);
      expect(footer, path).toBe(footers.get(lang));
    }
    expect([...footers.keys()].sort()).toEqual(['en', 'zh-Hant-TW']);
  });
});
