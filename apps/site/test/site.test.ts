// Static checks of public/: what a reviewer would otherwise re-check by hand after every edit of the hand-written
// pages. The HTML is parsed with parse5 (the WHATWG algorithm), so a stray tag or a broken attribute fails here.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDIRECTS, route } from '../src/routes.ts';
import { PUBLIC, REPO_ROOT, parsePage, publicFiles, readPublic, type El, type Page } from './html.ts';

const PAGES = ['index.html', 'zh-TW/index.html', '404.html', 'zh-TW/404.html'] as const;
const HOME_PAGES = { en: 'index.html', 'zh-TW': 'zh-TW/index.html' } as const;
const INSTALL = 'curl -fsSL https://smurg.ai/install.sh | sh';
const REPOSITORY = 'https://github.com/gclinian/smurg';
/** The only hosts the site may mention (links, metadata): the repository, the app and the site itself. */
const ALLOWED_HOSTS = ['github.com', 'app.smurg.ai', 'smurg.ai'];

const pages = new Map<string, Page>(PAGES.map((path) => [path, parsePage(readPublic(path))]));
const page = (path: string): Page => pages.get(path) as Page;
const first = (p: Page, tag: string): El | undefined => p.byTag(tag)[0];

/** Where a same-site path is answered: a file in public/ (with the trailing-slash rule) or a Worker redirect. */
function resolves(path: string): boolean {
  const clean = path.replace(/[?#].*$/, '');
  if (clean.endsWith('/')) return existsSync(join(PUBLIC, clean, 'index.html'));
  if (existsSync(join(PUBLIC, clean)) && statSync(join(PUBLIC, clean)).isFile()) return !clean.split('/').pop()?.startsWith('_');
  return REDIRECTS.has(clean) || route(new Request(`https://smurg.ai${clean}`)) !== null;
}

describe('public/', () => {
  it('holds only the expected files (no build output, no images that are not SVG)', () => {
    expect(publicFiles().sort()).toEqual(
      ['404.html', '_headers', 'copy.js', 'favicon.svg', 'index.html', 'robots.txt', 'sitemap.xml', 'style.css', 'zh-TW/404.html', 'zh-TW/index.html'].sort(),
    );
  });

  it('stays under 150 KB in total, so any page with everything it loads is smaller still', () => {
    const total = publicFiles().reduce((sum, path) => sum + statSync(join(PUBLIC, path)).size, 0);
    expect(total).toBeLessThan(150 * 1024);
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

  it('mentions no host but github.com, app.smurg.ai and smurg.ai, and only over https', () => {
    for (const path of publicFiles()) {
      // XML namespace names are identifiers, not addresses anything is loaded from.
      const text = readPublic(path).replace(/\sxmlns(?::\w+)?="[^"]*"/g, '');
      for (const [url] of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi)) {
        expect(url, `${path}: ${url}`).toMatch(/^https:\/\//);
        expect(ALLOWED_HOSTS, `${path}: ${url}`).toContain(new URL(url).hostname);
        if (new URL(url).hostname === 'github.com') expect(url, path).toMatch(new RegExp(`^${REPOSITORY}(?:/|$)`));
      }
    }
  });

  it('every same-site link resolves to a file or a Worker redirect, and every repository link to a file in the repo', () => {
    const links: [string, string][] = [];
    for (const path of PAGES) {
      for (const el of page(path).elements) {
        for (const name of ['href', 'src']) {
          const value = el.attr(name);
          if (value === undefined || value.startsWith('#') || (el.tag === 'use' && name === 'href')) continue;
          links.push([path, value]);
        }
      }
    }
    links.push(['robots.txt', /Sitemap: (\S+)/.exec(readPublic('robots.txt'))?.[1] ?? '']);
    for (const [, loc] of readPublic('sitemap.xml').matchAll(/(?:<loc>|href=")(https:\/\/[^<"]+)/g)) links.push(['sitemap.xml', loc as string]);
    expect(links.length).toBeGreaterThan(40);

    for (const [from, link] of links) {
      if (link.startsWith('/') && !link.startsWith('//')) {
        expect(resolves(link), `${from}: ${link}`).toBe(true);
        continue;
      }
      const url = new URL(link);
      if (url.hostname === 'smurg.ai') expect(resolves(url.pathname), `${from}: ${link}`).toBe(true);
      // github.com/gclinian/smurg/blob|tree/main/<path>: that path exists in this repository.
      const inRepo = /^\/gclinian\/smurg\/(?:blob|tree)\/main\/(.+)$/.exec(url.pathname)?.[1];
      if (url.hostname === 'github.com' && inRepo !== undefined) expect(existsSync(join(REPO_ROOT, inRepo)), `${from}: ${link}`).toBe(true);
    }
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
    for (const path of ['404.html', 'zh-TW/404.html']) {
      expect(page(path).byTag('meta').some((m) => m.attr('name') === 'robots' && m.attr('content') === 'noindex'), path).toBe(true);
    }
    const sitemap = readPublic('sitemap.xml');
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(['https://smurg.ai/', 'https://smurg.ai/zh-TW/']);
    expect(readPublic('robots.txt')).toContain('Sitemap: https://smurg.ai/sitemap.xml');
  });
});

for (const path of PAGES) {
  describe(path, () => {
    const p = page(path);
    const html = readPublic(path);
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

    it('loads nothing from another origin and has no inline script, style or event handler', () => {
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
        expect(['style', 'img', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'base', 'form'], `<${el.tag}>`).not.toContain(el.tag);
      }
      expect(html).not.toMatch(/http-equiv/i);
    });

    it('has unique ids, and every reference (#links, ARIA, data-copy, <use>) points at one', () => {
      expect(new Set(ids).size).toBe(ids.length);
      for (const el of p.elements) {
        const refs = [
          ...['aria-labelledby', 'aria-describedby', 'aria-controls', 'for'].flatMap((name) => (el.attr(name) ?? '').split(/\s+/).filter(Boolean)),
          ...[el.attr('data-copy')].filter((v): v is string => v !== undefined),
          ...[el.attr('href')].filter((v): v is string => v !== undefined && v.startsWith('#') && v.length > 1).map((v) => v.slice(1)),
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
    // The footer (contentinfo) and the app.
    expect(p.byTag('footer')).toHaveLength(1);
    expect(p.byTag('a').some((a) => a.attr('href') === 'https://app.smurg.ai/')).toBe(true);
    expect(p.byTag('a').some((a) => a.attr('href') === REPOSITORY)).toBe(true);
  });

  it('have the same sections and ids in the same order', () => {
    const en = page(HOME_PAGES.en);
    const zh = page(HOME_PAGES['zh-TW']);
    expect(en.ids()).toEqual(zh.ids());
    const sections = (p: Page) => p.byTag('section').map((s) => s.attr('id') ?? s.attr('aria-labelledby'));
    expect(sections(en)).toEqual(['hero-title', 'how', 'features', 'security', 'platforms', 'source', 'faq']);
    expect(sections(zh)).toEqual(sections(en));
  });

  it('the English page says that the app is in Traditional Chinese for now', () => {
    expect(page(HOME_PAGES.en).elements.some((el) => el.text().includes('The app’s interface is currently in Traditional Chinese; English is coming.'))).toBe(true);
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
