// Static checks of the whole site as it is deployed: public/ (the hand-written pages) plus the pages the build
// generates from the repository (scripts/site.ts: /docs/…, /license/, /third-party-notices.txt). What a reviewer would
// otherwise re-check by hand after every edit of a page or of the docs. The HTML is parsed with parse5 (the WHATWG
// algorithm), so a stray tag or a broken attribute fails here.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDIRECTS, route } from '../src/routes.ts';
import { DOC_PAGES, LICENSE_PAGE, NOTICES_FILE, WEB_APP_NOTICES } from '../scripts/site.ts';
import { FIXTURE_NOTICES, PUBLIC, REPO_ROOT, parsePage, publicFiles, rawText, readPublic, sitePages, siteText, testSite, type El, type Page } from './html.ts';

const HOME_PAGES = { en: 'index.html', 'zh-TW': 'zh-TW/index.html' } as const;
const NOT_FOUND_PAGES = ['404.html', 'zh-TW/404.html', 'docs/404.html'];
const GENERATED_PAGES = ['docs/index.html', 'docs/hosting/index.html', 'docs/joining/index.html', 'docs/changelog/index.html', 'license/index.html'];
const INSTALL = 'curl -fsSL https://smurg.ai/install.sh | sh';
/** The only hosts the hand-written pages may mention: the app, the downloads and the site itself. */
const ALLOWED_HOSTS = ['app.smurg.ai', 'downloads.smurg.ai', 'smurg.ai'];
/** What the site must no longer say about smurg itself: the source is private and the license proprietary. */
const RETIRED_CLAIMS = /open[ -]?source|開放原始碼|開源|apache/i;

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
  it('is public/ plus exactly the generated pages, the 404 page for /docs/ and the notices', () => {
    const files = [...testSite().files.keys()];
    expect(files.filter((path) => !publicFiles().includes(path)).sort()).toEqual([...GENERATED_PAGES, 'docs/404.html', NOTICES_FILE.slice(1)].sort());
    expect(publicFiles().sort()).toEqual(
      ['404.html', '_headers', 'copy.js', 'favicon.svg', 'index.html', 'robots.txt', 'sitemap.xml', 'style.css', 'zh-TW/404.html', 'zh-TW/index.html'].sort(),
    );
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
      expect(size(path), `${path} itself`).toBeLessThan(80 * 1024);
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

  it('the hand-written files mention no host but app.smurg.ai, downloads.smurg.ai and smurg.ai, and only over https', () => {
    for (const path of publicFiles()) {
      // XML namespace names are identifiers, not addresses anything is loaded from.
      const text = readPublic(path).replace(/\sxmlns(?::\w+)?="[^"]*"/g, '');
      for (const [url] of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi)) {
        expect(url, `${path}: ${url}`).toMatch(/^https:\/\//);
        expect(ALLOWED_HOSTS, `${path}: ${url}`).toContain(new URL(url).hostname);
      }
    }
  });

  it('no page mentions github.com, and no file the private repository (the notices name third-party sources only)', () => {
    for (const [path, data] of testSite().files) {
      const text = data.toString('utf8');
      expect(text, path).not.toMatch(/gclinian/i);
      if (path !== NOTICES_FILE.slice(1)) expect(text, path).not.toMatch(/github\.com/i);
    }
    // The repository's docs and changelog are the sources of the generated pages: the same holds for them.
    for (const doc of DOC_PAGES) expect(readFileSync(join(REPO_ROOT, doc.source), 'utf8'), doc.source).not.toMatch(/github\.com/i);
  });

  it('every link of a generated page goes to this site, the app or an https page of another project, never GitHub', () => {
    for (const path of GENERATED_PAGES) {
      for (const link of outLinks(path)) {
        if (link.startsWith('/')) continue;
        const url = new URL(link);
        expect(url.protocol, `${path}: ${link}`).toBe('https:');
        expect(url.hostname, `${path}: ${link}`).not.toMatch(/(^|\.)github(usercontent)?\.com$/);
      }
    }
  });

  it('says nowhere that smurg is open source or under the Apache License (it is proprietary now)', () => {
    for (const path of sitePages()) {
      // The license page shows LICENSE as it is (checked against the file below).
      if (path === 'license/index.html') continue;
      expect(siteText(path), path).not.toMatch(RETIRED_CLAIMS);
    }
    expect(siteText('license/index.html')).not.toMatch(/open[ -]?source/i);
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
    expect(links.length).toBeGreaterThan(200);

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
    expect(anchors).toBeGreaterThan(30);
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
    // /docs/404.html is the Traditional Chinese one: unknown paths under /docs/ are Chinese readers' mistakes.
    expect(siteText('docs/404.html')).toBe(readPublic('zh-TW/404.html'));
    const sitemap = siteText('sitemap.xml');
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(
      ['/', '/zh-TW/', '/docs/', ...DOC_PAGES.map((doc) => doc.path), LICENSE_PAGE].map((path) => `https://smurg.ai${path}`),
    );
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
      expect(['en', 'zh-TW']).toContain(root?.attr('lang'));
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

    it('links to the other language with hreflang and lang, and never redirects by itself', () => {
      const lang = first(p, 'html')?.attr('lang');
      const other = lang === 'en' ? { href: '/zh-TW/', hreflang: 'zh-TW' } : { href: '/', hreflang: 'en' };
      const switches = p.byTag('a').filter((a) => a.attr('href') === other.href && a.attr('hreflang') === other.hreflang);
      expect(switches.length).toBeGreaterThan(0);
      for (const a of switches) expect(a.attr('lang')).toBe(other.hreflang);
    });
  });
}

describe('the two home pages', () => {
  it.each(Object.entries(HOME_PAGES))('%s: canonical, alternates, Open Graph, the install line and the copy button', (lang, path) => {
    const p = page(path);
    const url = lang === 'en' ? 'https://smurg.ai/' : 'https://smurg.ai/zh-TW/';
    const links = p.byTag('link');
    const meta = (key: string) => p.byTag('meta').find((m) => m.attr('property') === key || m.attr('name') === key)?.attr('content');
    expect(first(p, 'html')?.attr('lang')).toBe(lang);
    expect(links.filter((l) => l.attr('rel') === 'canonical').map((l) => l.attr('href'))).toEqual([url]);
    expect(links.filter((l) => l.attr('rel') === 'alternate').map((l) => [l.attr('hreflang'), l.attr('href')])).toEqual([
      ['en', 'https://smurg.ai/'],
      ['zh-TW', 'https://smurg.ai/zh-TW/'],
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

  it.each(Object.entries(HOME_PAGES))('%s: the footer links the docs, the changelog, the license, the notices and the app', (_lang, path) => {
    const footer = page(path).elements.filter((el) => el.tag === 'a' && el.parents.some((parent) => parent.tag === 'footer'));
    expect(footer.map((a) => a.attr('href'))).toEqual(['/docs/', '/docs/changelog/', LICENSE_PAGE, NOTICES_FILE, 'https://app.smurg.ai/', path === 'index.html' ? '/zh-TW/' : '/']);
  });

  it.each(Object.values(HOME_PAGES))('%s: links the docs pages from its own docs section', (path) => {
    const section = page(path).elements.find((el) => el.tag === 'section' && el.attr('id') === 'docs');
    const links = page(path).elements.filter((el) => el.tag === 'a' && el.parents.includes(section as El)).map((a) => a.attr('href'));
    expect(links).toEqual([...DOC_PAGES.filter((doc) => doc.path !== '/docs/changelog/').map((doc) => doc.path), '/docs/changelog/', LICENSE_PAGE, NOTICES_FILE]);
  });

  it('have the same sections and ids in the same order', () => {
    const en = page(HOME_PAGES.en);
    const zh = page(HOME_PAGES['zh-TW']);
    expect(en.ids()).toEqual(zh.ids());
    const sections = (p: Page) => p.byTag('section').map((s) => s.attr('id') ?? s.attr('aria-labelledby'));
    expect(sections(en)).toEqual(['hero-title', 'how', 'features', 'security', 'platforms', 'docs', 'faq']);
    expect(sections(zh)).toEqual(sections(en));
  });

  it('the English page says that the app and the guides are in Traditional Chinese for now', () => {
    const texts = page(HOME_PAGES.en).elements.map((el) => el.text());
    expect(texts).toContain('Got an invite link? Open it in Chrome; there is nothing to install. The app’s interface is currently in Traditional Chinese; English is coming.');
    expect(texts).toContain('The guides are in Traditional Chinese for now.');
  });

  it.each(Object.values(HOME_PAGES))('%s: says that nobody else can run a relay now (its source is private), never that you can', (path) => {
    const text = page(path).elements.find((el) => el.tag === 'body')?.text() ?? '';
    expect(text).not.toMatch(/run your own relay|自己架設 relay|用自己的 Cloudflare 帳號架設/);
    expect(text).toMatch(path === 'index.html' ? /can’t run (?:your|their) own/ : /無法自己架設/);
  });

  it.each(Object.values(HOME_PAGES))('%s: the workspace picture is labelled, in Traditional Chinese inside, with a valid workspace id', (path) => {
    const p = page(path);
    const mock = p.elements.find((el) => el.attr('class') === 'mock');
    expect(mock?.attr('role')).toBe('img');
    expect(mock?.children().find((c) => c.attr('class') === 'm-app')?.attr('lang')).toBe('zh-TW');
    const address = p.elements.find((el) => el.attr('class') === 'm-url')?.text() ?? '';
    // packages/protocol WORKSPACE_ID_PATTERN: 16 to 64 of [A-Za-z0-9_-].
    expect(address).toMatch(/^app\.smurg\.ai\/w\/[A-Za-z0-9_-]{16,64}$/);
  });
});

describe('the generated pages', () => {
  it.each(DOC_PAGES.map((doc) => [doc.source, doc.path] as const))('%s at %s: its own h1, a canonical URL, the docs navigation and a table of contents', (source, path) => {
    const file = `${path.slice(1)}index.html`;
    const p = page(file);
    const markdownTitle = /^# (.+)$/m.exec(readFileSync(join(REPO_ROOT, source), 'utf8'))?.[1];
    expect(first(p, 'html')?.attr('lang')).toBe('zh-TW');
    expect(first(p, 'h1')?.text()).toBe(markdownTitle?.replace(/`/g, ''));
    expect(p.byTag('link').find((l) => l.attr('rel') === 'canonical')?.attr('href')).toBe(`https://smurg.ai${path}`);
    const nav = p.elements.find((el) => el.attr('class') === 'doc-nav');
    const navLinks = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(nav as El));
    expect(navLinks.map((a) => a.attr('href'))).toEqual(['/docs/', ...DOC_PAGES.map((doc) => doc.path), LICENSE_PAGE, NOTICES_FILE]);
    expect(navLinks.filter((a) => a.attr('aria-current') === 'page').map((a) => a.attr('href'))).toEqual([path]);
    // The table of contents lists the h2s of the page, in order (a page with one section has none).
    const toc = p.elements.find((el) => el.attr('class') === 'doc-toc');
    const tocLinks = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(toc as El)).map((a) => a.attr('href'));
    const h2s = p.byTag('h2').filter((h) => h.parents.some((el) => el.tag === 'main')).map((h) => `#${h.attr('id')}`);
    expect(h2s.length).toBeGreaterThan(0);
    expect(tocLinks).toEqual(h2s.length > 1 ? h2s : []);
    expect(toc === undefined).toBe(h2s.length < 2);
  });

  it('the docs index is in Traditional Chinese with an English note, and links every docs page, the license and both notices', () => {
    const p = page('docs/index.html');
    expect(first(p, 'html')?.attr('lang')).toBe('zh-TW');
    const note = p.elements.find((el) => el.attr('class') === 'doc-note');
    expect(note?.attr('lang')).toBe('en');
    expect(note?.text()).toMatch(/^The guides are in Traditional Chinese for now\./);
    const main = first(p, 'main');
    const links = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(main as El)).map((a) => a.attr('href'));
    expect(links).toEqual(['/', ...DOC_PAGES.map((doc) => doc.path), LICENSE_PAGE, NOTICES_FILE, WEB_APP_NOTICES]);
  });

  it('the license page shows LICENSE exactly, as text', () => {
    const p = page('license/index.html');
    const pre = p.elements.find((el) => el.tag === 'pre' && el.attr('class') === 'license-text');
    expect(rawText(pre as El)).toBe(readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8').replace(/\s+$/, ''));
    expect(first(p, 'html')?.attr('lang')).toBe('en');
  });

  it('the notices are the file the build was given, byte for byte (here the tests\' fixture)', () => {
    expect(testSite().files.get(NOTICES_FILE.slice(1))?.equals(readFileSync(FIXTURE_NOTICES))).toBe(true);
  });

  it('every page of a language has the same footer', () => {
    const footers = new Map<string, string>();
    for (const path of sitePages()) {
      if (NOT_FOUND_PAGES.includes(path)) continue;
      const lang = first(page(path), 'html')?.attr('lang') as string;
      const footer = /<footer class="site-footer">[\s\S]*<\/footer>/.exec(siteText(path))?.[0];
      expect(footer, path).toBeDefined();
      if (!footers.has(lang)) footers.set(lang, footer as string);
      expect(footer, path).toBe(footers.get(lang));
    }
    expect([...footers.keys()].sort()).toEqual(['en', 'zh-TW']);
  });
});
