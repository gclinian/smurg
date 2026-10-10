// Static checks of the whole site as it is deployed: public/ (the hand-written pages) plus the pages the build
// generates from the repository (scripts/site.ts: /docs/… and /license/ in both languages, /third-party-notices.txt,
// /sitemap.xml and /llms.txt). What a reviewer would
// otherwise re-check by hand after every edit of a page or of the docs. The HTML is parsed with parse5 (the WHATWG
// algorithm), so a stray tag or a broken attribute fails here.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDIRECTS, REPOSITORY, route } from '../src/routes.ts';
import { Slugger } from '../scripts/markdown.ts';
import { squareIcon } from '../scripts/icons.ts';
import {
  CHROME,
  DOC_PAGES,
  FAVICON_SIZES,
  HTML_LANG,
  ICON_LINKS,
  LANGS,
  LLMS_FACTS,
  LLMS_FILE,
  LLMS_SUMMARY,
  NOTICES_FILE,
  ORIGIN,
  SOCIAL_CARD,
  SOCIAL_CARD_SIZE,
  TOUCH_ICON_SIZE,
  WEB_APP_NOTICES,
  docsIndex,
  fileDates,
  homePage,
  homeStructuredData,
  licensePage,
  otherLang,
  pagePairs,
  pageSources,
  socialCardMeta,
  type Lang,
} from '../scripts/site.ts';
import { FIXTURE_NOTICES, PUBLIC, REPO_ROOT, decodePng, parsePage, publicFiles, rawText, readPublic, sitePages, siteText, testSite, type El, type Page } from './html.ts';

const HOME_PAGES = { en: 'index.html', 'zh-TW': 'zh-TW/index.html' } as const;
const NOT_FOUND_PAGES = ['404.html', 'zh-TW/404.html'];
/** The preview pictures (og:image): files of public/ that no page loads, read by link previews. */
const SOCIAL_CARDS = LANGS.map((lang) => SOCIAL_CARD[lang].path.slice(1));
/** The icons that are not the SVG itself (scripts/icons.ts draws them from it): pictures, like the preview pictures. */
const DRAWN_ICONS = ['favicon.ico', 'apple-touch-icon.png'];
/** A page's structured data: `<script type="application/ld+json">`, a data block that no browser runs. */
const DATA_BLOCK = 'application/ld+json';
/** The vocabulary the structured data is written in, named by its address as the format asks; nothing is loaded from it. */
const DATA_CONTEXT = 'https://schema.org';
const fileOf = (path: string): string => `${path.slice(1)}index.html`;
/** The generated pages: the docs index, the four documents and the license page, in each language. */
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
/**
 * A document of the docs by its English source, whatever its place in DOC_PAGES: the quick start is the first of
 * them (a test holds that), and the tests of the two guides read each guide by its name, not by a position.
 */
function docOf(source: string): (typeof DOC_PAGES)[number] {
  const doc = DOC_PAGES.find((candidate) => candidate.en.source === source);
  if (doc === undefined) throw new Error(`${source} is not a page of the docs`);
  return doc;
}
const QUICK_START = docOf('docs/QUICKSTART.md');
const HOST_GUIDE = docOf('docs/HOSTING.md');
const TEAM_GUIDE = docOf('docs/JOINING.md');
/** The language of a page, from its `<html lang>`. */
const langOf = (p: Page): Lang => (first(p, 'html')?.attr('lang') === HTML_LANG.en ? 'en' : 'zh-TW');

const pages = new Map<string, Page>(sitePages().map((path) => [path, parsePage(siteText(path))]));
const page = (path: string): Page => {
  const p = pages.get(path);
  if (p === undefined) throw new Error(`no page ${path}`);
  return p;
};
const first = (p: Page, tag: string): El | undefined => p.byTag(tag)[0];
/** A page's `<meta>` content by its name or property. */
const metaOf = (p: Page, key: string): string | undefined => p.byTag('meta').find((m) => m.attr('property') === key || m.attr('name') === key)?.attr('content');
/** The structured data of a page, parsed: one entry per data block. */
const dataBlocks = (p: Page): unknown[] => p.byTag('script').filter((s) => s.attr('type') === DATA_BLOCK).map((s) => JSON.parse(rawText(s)) as unknown);
/** Every string a value holds, however deep (the words and addresses of a page's structured data). */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}
/**
 * The room a text takes in a search result, in Latin characters: a full-width character (Chinese and its
 * punctuation) is as wide as two.
 */
const widthOf = (text: string): number => [...text].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1), 0);

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
  it('is public/ plus exactly the generated pages (both languages), the notices, the sitemap and llms.txt', () => {
    const files = [...testSite().files.keys()];
    expect(GENERATED_PAGES).toHaveLength(12);
    expect(files.filter((path) => !publicFiles().includes(path)).sort()).toEqual([...GENERATED_PAGES, NOTICES_FILE.slice(1), 'sitemap.xml', LLMS_FILE.slice(1)].sort());
    expect(publicFiles().sort()).toEqual(
      ['404.html', '_headers', '_redirects', 'apple-touch-icon.png', 'copy.js', 'demo.js', 'favicon.ico', 'favicon.svg', 'index.html', 'og.png', 'robots.txt', 'style.css', 'zh-TW/404.html', 'zh-TW/index.html', 'zh-TW/og.png'].sort(),
    );
    // No 404 page of its own under /docs/: the nearest 404.html is the English one there, the Chinese one under /zh-TW/.
    expect(files).not.toContain('docs/404.html');
    // Generated files are never written into public/ (they live in the gitignored dist/).
    for (const path of GENERATED_PAGES) expect(publicFiles(), path).not.toContain(path);
  });

  it('public/ stays under 160 KB in total (the preview pictures aside), and every page with everything it loads under 176 KB and the two drawn icons', () => {
    // The preview pictures are not loaded by any page: they have their own bound (the next test).
    const total = publicFiles()
      .filter((path) => !SOCIAL_CARDS.includes(path))
      .reduce((sum, path) => sum + statSync(join(PUBLIC, path)).size, 0);
    expect(total).toBeLessThan(160 * 1024);
    const size = (path: string): number => testSite().files.get(path)?.length ?? Number.NaN;
    // The two icons that are not the SVG: small, and bounded by themselves, so the pages' bound below is what it was.
    expect(size('favicon.ico')).toBeLessThan(3 * 1024);
    expect(size('apple-touch-icon.png')).toBeLessThan(4 * 1024);
    for (const path of sitePages()) {
      // Everything the page names to be loaded: the stylesheet, its scripts (a data block has no file) and every
      // icon. A browser takes one of the three icons, and the touch icon only when the page goes on a home screen;
      // all three are counted, as if one visitor took them all.
      const loaded = page(path)
        .elements.filter((el) => (el.tag === 'link' && ['stylesheet', 'icon', 'apple-touch-icon'].includes(el.attr('rel') ?? '')) || (el.tag === 'script' && el.attr('src') !== undefined))
        .map((el) => (el.attr('href') ?? el.attr('src') ?? '').slice(1));
      expect(loaded.filter((file) => DRAWN_ICONS.includes(file)).sort(), path).toEqual([...DRAWN_ICONS].sort());
      const bytes = size(path) + loaded.reduce((sum, file) => sum + size(file), 0);
      // The host guide is the longest page (0.5.0: about 98 KB in English; 0.5.1: about 119 KB, since its §9 says
      // what an update carries over, what every refusal of a workspace's state means and how to go back to a folder
      // that was moved away; 0.5.2: about 133 KB, since §8 has one row per reason git stops Start and §10.2 says
      // what happens when the folder becomes a repository while it is shared). The page's bound follows the guide;
      // with the stylesheet (37 KB since the home page's picture moves), the script and the SVG icon it stays under
      // the bound below (150 KB until 0.5.1, 164 KB until 0.5.2). The bound rose once more by exactly what the two
      // drawn icons weigh, when the pages began to name them: the page, its title, description and structured data
      // included, has the 176 KB it had.
      expect(size(path), `${path} itself`).toBeLessThan(140 * 1024);
      const icons = DRAWN_ICONS.reduce((sum, file) => sum + size(file), 0);
      expect(bytes - icons, `${path} with ${loaded.join(', ')}, the drawn icons aside`).toBeLessThan(176 * 1024);
    }
    // The notices are text, not a page: generous, but bounded.
    expect(size(NOTICES_FILE.slice(1))).toBeLessThan(2 * 1024 * 1024);
  });

  it('the preview pictures are PNGs of 1200 × 630 under 300 KB each (WhatsApp shows no picture above that)', () => {
    expect(SOCIAL_CARD_SIZE).toEqual({ width: 1200, height: 630 });
    for (const path of SOCIAL_CARDS) {
      const png = testSite().files.get(path);
      expect(png, path).toBeDefined();
      expect(png?.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${path} is a PNG`).toBe(true);
      expect([png?.readUInt32BE(16), png?.readUInt32BE(20)], path).toEqual([SOCIAL_CARD_SIZE.width, SOCIAL_CARD_SIZE.height]);
      expect(png?.length, path).toBeLessThan(300 * 1024);
    }
  });

  it('each language’s preview picture says its home page’s h1 (scripts/social-card.ts draws it from SOCIAL_CARD)', () => {
    const squeeze = (text: string): string => text.replace(/\s+/g, '');
    for (const lang of LANGS) {
      const h1 = first(page(HOME_PAGES[lang]), 'h1')?.text() ?? '';
      expect(squeeze(SOCIAL_CARD[lang].lines.join(' ')), lang).toBe(squeeze(h1));
      // The picture's alt text is "smurg" and the h1, as a sentence of the language.
      expect(squeeze(SOCIAL_CARD[lang].alt), lang).toBe(squeeze(lang === 'en' ? `smurg: ${h1.charAt(0).toLowerCase()}${h1.slice(1)}` : `smurg：${h1}`));
    }
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
    for (const path of publicFiles().filter((file) => !SOCIAL_CARDS.includes(file) && !DRAWN_ICONS.includes(file))) {
      // XML namespace names are identifiers, not addresses anything is loaded from; so is the name of the vocabulary
      // of a page's structured data, in exactly this place and spelling. Every other address in a data block is held
      // to the four hosts like the rest of the file.
      const text = readPublic(path).replace(/\sxmlns(?::\w+)?="[^"]*"/g, '').replaceAll(`"@context":"${DATA_CONTEXT}"`, '');
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
    // Header and footer of every page that has them, the docs index, the guides.
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
    // The host guides link the relay's README (the home pages' own list of repository files left with their
    // open-source section: the header and the footer link the repository itself).
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
    // Files that are not pages are loaded by the pages (style.css, copy.js, the icons) or read by crawlers, link
    // previews and assistants at an address they know (a page names its preview picture in a <meta>, which is no
    // link; llms.txt is asked for by its name).
    expect(unreachable.sort()).toEqual([...SOCIAL_CARDS, 'robots.txt', 'sitemap.xml', LLMS_FILE.slice(1)].sort());
  });

  it.each(['copy.js', 'demo.js'])('%s does no networking and writes no HTML (Trusted Types would refuse it anyway)', (file) => {
    const script = readPublic(file).replace(/\/\/.*$/gm, '');
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
    // No inline style either (the CSP's style-src has no 'unsafe-inline'): classes and attributes only.
    expect(script).not.toMatch(/\.style\b|cssText|setProperty|createElement/);
    // And no motion of a script's own: what moves is the stylesheet's (the next test but one reads all of it).
    expect(script).not.toMatch(/\.animate\(|KeyframeEffect|new Animation\b|playbackRate/);
  });

  it('demo.js leaves Pause to the stylesheet: it never names the button, and of the popover it only reads whether it is open', () => {
    // The loop never ends, so it must be pausable (WCAG 2.2.2). The whole mechanism is markup and stylesheet (the
    // button opens a popover, the motion stands while it is open: the tests below hold both), with or without the
    // script. So the script cannot take it away: it has no word for the button, opens and closes no popover, removes
    // no attribute but the strip's own aria-current, and sets no class but the one for "off the screen".
    const script = readPublic('demo.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(script).not.toMatch(/\.pause\b|popovertarget|[a-z]Popover\b|is-paused|\bdisabled = true|\.remove\(\)|\.hidden\b/);
    expect([...script.matchAll(/removeAttribute\('([^']+)'\)/g)].map((match) => match[1])).toEqual(['aria-current']);
    expect([...script.matchAll(/classList\.\w+\('([^']+)'/g)].map((match) => match[1])).toEqual(['is-away']);
    // What it reads: the popover's state, to show a chosen part finished while the picture is paused.
    expect(script).toMatch(/getElementById\('story-paused'\)/);
    expect(script).toMatch(/matches\(':popover-open'\)/);
  });

  it('style.css loads nothing (no @import, no url(), no web fonts)', () => {
    const css = readPublic('style.css');
    expect(css).not.toMatch(/@import|url\(|@font-face/);
  });

  it('style.css moves nothing unless motion is welcome, the picture only where its Pause button works without the script, and only by opacity and transform', () => {
    const css = readPublic('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
    /** The blocks of every at-rule whose start `prelude` matches (up to its `{`; braces balanced), and the text without them. */
    const cut = (text: string, prelude: RegExp): { blocks: string[]; rest: string } => {
      const blocks: string[] = [];
      let rest = '';
      let from = 0;
      for (const match of text.matchAll(prelude)) {
        // (a match inside a block that was already cut out belongs to that block)
        if (match.index < from) continue;
        let depth = 1;
        let end = match.index + match[0].length;
        for (; depth > 0 && end < text.length; end++) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0;
        expect(depth, String(prelude)).toBe(0);
        blocks.push(text.slice(match.index + match[0].length, end - 1));
        rest += text.slice(from, match.index);
        from = end;
      }
      return { blocks, rest: rest + text.slice(from) };
    };
    // Every animation, keyframe and transition sits inside "prefers-reduced-motion: no-preference": with reduced
    // motion nothing moves, and the picture stands as its four finished scenes.
    const welcome = cut(css, /@media \(prefers-reduced-motion: no-preference\) \{/g);
    expect(welcome.rest).not.toMatch(/animation|transition|@keyframes/);
    // Two blocks: the picture's loop, and the colour changes of links and buttons.
    expect(welcome.blocks).toHaveLength(2);
    const [loop, colours] = welcome.blocks as [string, string];
    expect(colours).not.toMatch(/animation|@keyframes/);
    expect(colours).toMatch(/transition:\s+color 120ms ease,\s+background-color 120ms ease;/);
    // The loop plays for 20 seconds without an end, so it must be pausable (WCAG 2.2.2) by a real button even when
    // the script did not load: the button opens a popover and the stylesheet stops every animation while it is open.
    // Hence the loop exists only where popovers do; anywhere else the still picture shows.
    const guarded = cut(loop, /@supports selector\(:popover-open\) \{/g);
    expect(guarded.blocks).toHaveLength(1);
    expect(guarded.rest.trim()).toBe('');
    const motion = guarded.blocks[0] as string;
    // Paused (the popover is open) or off the screen (demo.js), everything stands: every element of the story and
    // both of its pseudo-elements (the strip's line, the cards' rule). One rule, six selectors, nothing else in it.
    const state = motion.indexOf('animation-play-state: paused;');
    const open = motion.lastIndexOf('{', state);
    const standing = motion.slice(motion.lastIndexOf('}', open) + 1, open);
    expect(motion.slice(open + 1, motion.indexOf('}', state)).trim()).toBe('animation-play-state: paused;');
    expect(standing.split(',').map((selector) => selector.trim())).toEqual([
      '.story.is-away *',
      '.story.is-away *::before',
      '.story.is-away *::after',
      '.story-state:popover-open ~ * *',
      '.story-state:popover-open ~ * *::before',
      '.story-state:popover-open ~ * *::after',
    ]);
    // Nothing sets the play state anywhere else, and the button shows its other word while the popover is open.
    expect(css.match(/animation-play-state/g)).toHaveLength(1);
    expect(motion).toMatch(/\.story-state:popover-open ~ \.demo \.when-playing \{\s*display: none;\s*\}/);
    expect(motion).toMatch(/\.story-state:popover-open ~ \.demo \.when-paused \{\s*display: block;\s*\}/);
    // Keyframes change opacity and transform only: nothing that lays the page out again, nothing that flashes.
    const frames = cut(motion, /@keyframes [\w-]+ \{/g);
    expect(frames.blocks.length).toBeGreaterThan(12);
    expect([...new Set(frames.blocks.flatMap((block) => [...block.matchAll(/([a-z-]+):/g)].map((match) => match[1])))].sort()).toEqual(['opacity', 'transform']);
    // Everything runs on the loop's own clock (--loop), but the three dots of an agent at work: a pulse every 1.4 s,
    // far from a flash.
    const shorthands = [...motion.matchAll(/animation: ([^;]+);/g)].map((match) => match[1] as string);
    expect(shorthands.length).toBeGreaterThan(2);
    for (const shorthand of shorthands) expect(shorthand.startsWith('var(--loop) ') || shorthand === 'dot 1.4s ease-in-out infinite', shorthand).toBe(true);
    // No way round the shorthands: of the longhands only a name, the one linear timing (the strip's line) and the
    // two delays of the dots (a third and two thirds of their pulse apart: 0.2 s, 0.4 s) are written; no duration,
    // no count, no direction. And no transition inside the picture's block: its parts move by the keyframes alone.
    const rules = frames.rest;
    const longhands = [...rules.matchAll(/(animation-[a-z-]+): ([^;]+);/g)].map((match) => `${match[1]}: ${match[2]}`).filter((line) => !/^animation-(?:name: [\w-]+|play-state: paused)$/.test(line));
    expect(longhands.sort()).toEqual(['animation-delay: 0.2s', 'animation-delay: 0.4s', 'animation-timing-function: linear']);
    expect(motion).not.toMatch(/transition/);
    // Every name that is given has its keyframes, and every keyframes a name.
    const named = new Set([...rules.matchAll(/animation-name: ([\w-]+);/g)].map((match) => match[1]));
    const defined = new Set([...motion.matchAll(/@keyframes ([\w-]+) \{/g)].map((match) => match[1]));
    expect([...named, 'dot'].sort()).toEqual([...defined].sort());
  });

  it('keeps the 404 pages out of search results, and the sitemap and robots.txt consistent', () => {
    for (const path of NOT_FOUND_PAGES) {
      expect(page(path).byTag('meta').some((m) => m.attr('name') === 'robots' && m.attr('content') === 'noindex'), path).toBe(true);
    }
    const sitemap = siteText('sitemap.xml');
    // Every page that exists in both languages, English first, each with the same three alternates.
    const expected = pagePairs().flatMap((paths) => LANGS.map((lang) => `https://smurg.ai${paths[lang]}`));
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(expected);
    expect(expected).toHaveLength(14);
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
    // robots.txt lets every crawler read every page (a page that must not be found says so itself: noindex).
    expect(siteText('robots.txt').split('\n').filter((line) => line !== '' && !line.startsWith('#'))).toEqual(['User-agent: *', 'Allow: /', 'Sitemap: https://smurg.ai/sitemap.xml']);
  });

  it('the sitemap says when a page’s source last changed, by git, and nothing where git cannot say', () => {
    // The date of the last commit that touched the page's one source file (pageSources), when this is a complete
    // checkout and the file is committed as it is; no <lastmod> at all otherwise (a wrong date is worse than none:
    // test/generate.test.ts holds fileDates to that on repositories of its own). The docs index has no single
    // source, so it never has a date.
    const sources = pageSources();
    const { dates } = fileDates(REPO_ROOT, [...new Set(sources.values())]);
    const entries = siteText('sitemap.xml').split('<url>').slice(1);
    expect(entries).toHaveLength(14);
    expect([...sources.keys()].sort()).toEqual(pagePairs().flatMap((paths) => LANGS.map((lang) => paths[lang])).filter((path) => !LANGS.some((lang) => docsIndex(lang) === path)).sort());
    for (const entry of entries) {
      const path = (/<loc>https:\/\/smurg\.ai([^<]+)<\/loc>/.exec(entry)?.[1] ?? '') as string;
      const source = sources.get(path);
      const date = /<lastmod>([^<]*)<\/lastmod>/.exec(entry)?.[1];
      expect(date, path).toBe(source === undefined ? undefined : dates.get(source));
      // A date is a full ISO 8601 moment with its time zone, right after the address. (It is the committing
      // machine's clock that wrote it: it is not compared with the clock of the machine that runs this test.)
      if (date === undefined) continue;
      expect(date, path).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/);
      expect(entry, path).toContain(`<loc>https://smurg.ai${path}</loc>\n    <lastmod>${date}</lastmod>\n`);
    }
    for (const lang of LANGS) expect(sources.has(docsIndex(lang)), lang).toBe(false);
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

    it('has a language, one title, the charset, a viewport, the shared stylesheet and the three icons', () => {
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
      // The icons, as every page names them (ICON_LINKS; the hand-written pages carry the same three lines): the
      // .ico with its sizes written out, so that a browser that can show the SVG takes the SVG, and the touch icon.
      expect(html).toContain(`${ICON_LINKS}\n`);
      expect(links.filter((l) => /icon/.test(l.attr('rel') ?? '')).map((l) => [l.attr('rel'), l.attr('href'), l.attr('sizes'), l.attr('type')])).toEqual([
        ['icon', '/favicon.ico', '16x16 32x32 48x48', undefined],
        ['icon', '/favicon.svg', undefined, 'image/svg+xml'],
        ['apple-touch-icon', '/apple-touch-icon.png', undefined, undefined],
      ]);
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
        if (el.tag === 'script' && el.attr('type') === DATA_BLOCK) {
          // The one script element without a file: the page's structured data. With this type and nothing else on
          // it, it is data that no browser runs (so the CSP has nothing to refuse), and its text is JSON in which
          // no "<" stands as itself: nothing inside can end the element early.
          expect(el.node.attrs.map((a) => a.name)).toEqual(['type']);
          expect(() => JSON.parse(rawText(el)) as unknown, 'the data block is JSON').not.toThrow();
          expect(rawText(el)).not.toContain('<');
          expect(el.parents.at(-1)?.tag).toBe('head');
        } else if (el.tag === 'script') {
          expect(el.attr('src'), 'no inline script').toMatch(/^\/[^/]/);
          expect(el.text()).toBe('');
          expect(el.attr('type')).toBeUndefined();
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

    it('names its language’s preview picture, a file of the site (but for the 404 pages)', () => {
      const meta = (key: string) => p.byTag('meta').filter((m) => m.attr('property') === key || m.attr('name') === key).map((m) => m.attr('content'));
      if (NOT_FOUND_PAGES.includes(path)) {
        expect(meta('og:image')).toEqual([]);
        return;
      }
      const lang = langOf(p);
      // The generated pages and the hand-written ones carry the same lines, in the same order.
      expect(html).toContain(`${socialCardMeta(lang)}\n`);
      const card = SOCIAL_CARD[lang];
      expect(meta('og:image')).toEqual([`${ORIGIN}${card.path}`]);
      expect(meta('twitter:image')).toEqual([`${ORIGIN}${card.path}`]);
      expect(meta('twitter:card')).toEqual(['summary_large_image']);
      expect(meta('og:image:alt')).toEqual([card.alt]);
      expect(servedPage(card.path), card.path).toBe(card.path.slice(1));
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
  const classes = (el: El): string[] => (el.attr('class') ?? '').split(/\s+/).filter(Boolean);
  const withClass = (p: Page, name: string): El[] => p.elements.filter((el) => classes(el).includes(name));
  const inside = (p: Page, parent: El | undefined): El[] => p.elements.filter((el) => el.parents.includes(parent as El));
  const bodyText = (path: string): string => first(page(path), 'body')?.text() ?? '';
  const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
  /** What each page calls the four parts of the picture, in the strip's order. */
  const PARTS = { en: ['Decide', 'Plan', 'Build', 'Review'], 'zh-TW': ['決定', '計畫', '實作', '檢視'] } as const;
  const INVITE_NOTE = { en: 'Got an invite link? Open it in Chrome; there is nothing to install.', 'zh-TW': '收到邀請連結了嗎？用 Chrome 打開就好，不需要安裝任何東西。' } as const;

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
    expect(meta('twitter:card')).toBe('summary_large_image');
    // The install line, exactly, once, in a named group; the copy button stays hidden until copy.js finds a clipboard.
    const commands = p.elements.filter((el) => el.attr('id') === 'install-cmd');
    expect(commands.map((el) => [el.tag, el.text()])).toEqual([['code', INSTALL]]);
    expect(commands[0]?.parents.at(-1)?.attr('role')).toBe('group');
    expect(commands[0]?.parents.at(-1)?.attr('aria-label')).toMatch(/macOS.*Linux/);
    // On a narrow screen the command breaks in one place only, after "-fsSL": the rest is one piece.
    expect(commands[0]?.children().map((el) => [el.tag, el.text()])).toEqual([['span', 'https://smurg.ai/install.sh | sh']]);
    const copy = p.byTag('button').find((b) => b.attr('data-copy') === 'install-cmd');
    expect(copy?.attr('hidden')).toBe('');
    // What the button did is said in a status line (empty and out of sight until then). When the clipboard says no,
    // copy.js shows its hint there, and the stylesheet puts it in the place of the note that follows it: the button
    // keeps its word, so nothing on the page changes its size.
    const status = p.elements.find((el) => el.attr('id') === 'copy-status');
    expect([status?.tag, status?.attr('role'), status?.attr('class'), status?.text()]).toEqual(['p', 'status', 'visually-hidden', '']);
    const row = status?.parents.at(-1)?.children() ?? [];
    expect(row.map((el) => `${el.tag}.${classes(el).join('.')}`)).toEqual(['div.command', 'p.visually-hidden', 'p.install-note', 'p.install-start']);
    expect(copy?.attr('data-fail')?.length).toBeGreaterThan(10);
    const copyScript = readPublic('copy.js');
    expect(copyScript).toContain("say(button.getAttribute('data-fail') ?? '', true);");
    expect(copyScript).toContain('if (!hint || !status) button.textContent = text;');
    expect(copyScript).toContain("status.className = hint ? 'copy-hint' : 'visually-hidden';");
    expect(readPublic('style.css')).toMatch(/\.copy-hint \+ p \{\s*visibility: hidden;\s*\}/);
    // The page's two scripts, both deferred: the copy button and the picture's (the page makes sense without either).
    // Before them, the one script element that is no script: the page's structured data (a data block).
    expect(p.byTag('script').map((s) => [s.attr('type'), s.attr('src'), s.attr('defer')])).toEqual([
      [DATA_BLOCK, undefined, undefined],
      [undefined, '/copy.js', ''],
      [undefined, '/demo.js', ''],
    ]);
    // Under the install line: what a teammate with an invite link does, one sentence, and under it ONE link, to the
    // quick start of the page's language, by the name the docs give it (two words; no sentence comes with it).
    expect(withClass(p, 'install-note').map((el) => el.text())).toEqual([INVITE_NOTE[lang as Lang]]);
    const start = withClass(p, 'install-start');
    expect(start.map((el) => el.text())).toEqual([QUICK_START[lang as Lang].label]);
    expect(start[0]?.children().map((el) => [el.tag, el.attr('href'), el.attr('class'), el.text()])).toEqual([['a', QUICK_START[lang as Lang].path, undefined, QUICK_START[lang as Lang].label]]);
    expect(['Quick start', '快速上手']).toContain(QUICK_START[lang as Lang].label);
    // The hint of the Copy button takes the place of the note alone: the link is not the paragraph after the status line.
    expect(row.findIndex((el) => classes(el).includes('install-start'))).toBe(row.findIndex((el) => el.attr('id') === 'copy-status') + 2);
  });

  it.each(Object.entries(HOME_PAGES))('%s: the header links the docs, GitHub and the other language; the footer the docs, the changelog, the license, the notices, GitHub, the app and the other language', (lang, path) => {
    const l = lang as Lang;
    const links = (tag: string) => page(path).elements.filter((el) => el.tag === 'a' && el.parents.some((parent) => parent.tag === tag)).map((a) => a.attr('href'));
    expect(links('header')).toEqual([homePage(l), docsIndex(l), REPOSITORY, homePage(otherLang(l))]);
    expect(links('footer')).toEqual([docsIndex(l), `${docsIndex(l)}changelog/`, licensePage(l), NOTICES_FILE, REPOSITORY, 'https://app.smurg.ai/', homePage(otherLang(l))]);
  });

  it('have the same sections, ids, links and markup in the same order: only the words differ', () => {
    const en = page(HOME_PAGES.en);
    const zh = page(HOME_PAGES['zh-TW']);
    expect(en.ids()).toEqual(zh.ids());
    const sections = (p: Page) => p.byTag('section').map((s) => s.attr('id') ?? s.attr('aria-labelledby'));
    // The hero (the sentence, the install line, the picture and its four cards): nothing else.
    expect(sections(en)).toEqual(['hero-title']);
    expect(sections(zh)).toEqual(sections(en));
    // The same links in the same order, each to its own language's page.
    const hrefs = (p: Page) => p.byTag('a').map((a) => (a.attr('href') ?? '').replace(/^\/zh-TW\//, '/'));
    expect(hrefs(zh)).toEqual(hrefs(en));
    // The same elements with the same classes inside <main>, one for one: the picture's timeline is its classes
    // (.in1 to .in3, .tNN, .a-…), so the two pages play the same loop. Only <wbr> (where a Chinese line may break)
    // is the Chinese page's own.
    const shape = (p: Page) => inside(p, first(p, 'main')).filter((el) => el.tag !== 'wbr').map((el) => `${el.tag}.${classes(el).join('.')}`);
    expect(shape(zh)).toEqual(shape(en));
    expect(shape(en).length).toBeGreaterThan(250);
  });

  it.each(Object.entries(HOME_PAGES))('%s: one sentence, one line under it and four cards: no more words than that', (lang, path) => {
    const p = page(path);
    const main = first(p, 'main');
    const headings = inside(p, main).filter((el) => /^h[1-6]$/.test(el.tag));
    // The h1 and the four cards (h2): no other heading, no third level.
    expect(headings.map((h) => h.tag)).toEqual(['h1', 'h2', 'h2', 'h2', 'h2']);
    expect(withClass(p, 'lede')).toHaveLength(1);
    const cards = inside(p, withClass(p, 'cards')[0]).filter((el) => el.tag === 'li');
    expect(cards).toHaveLength(4);
    for (const card of cards) expect(card.children().map((c) => c.tag)).toEqual(['h2', 'p']);
    if (lang === 'en') {
      expect(words(first(p, 'h1')?.text() ?? '')).toBeLessThanOrEqual(9);
      expect(words(withClass(p, 'lede')[0]?.text() ?? '')).toBeLessThanOrEqual(14);
      for (const card of cards) {
        const [title, sentence] = card.children().map((c) => c.text()) as [string, string];
        expect(words(title), title).toBeLessThanOrEqual(6);
        expect(words(sentence), sentence).toBeLessThanOrEqual(18);
        // one sentence: one full stop, at its end
        expect(sentence.replace(/\b(?:SPEC|PLAN)\.md\b/g, '').match(/\./g), sentence).toHaveLength(1);
      }
    } else {
      // Chinese has no spaces to count: by characters, about what the English bounds come to.
      expect([...(first(p, 'h1')?.text() ?? '')].length).toBeLessThanOrEqual(30);
      expect([...(withClass(p, 'lede')[0]?.text() ?? '')].length).toBeLessThanOrEqual(32);
      for (const card of cards) {
        const [title, sentence] = card.children().map((c) => c.text()) as [string, string];
        expect([...title].length, title).toBeLessThanOrEqual(16);
        expect([...sentence].length, sentence).toBeLessThanOrEqual(70);
        expect(sentence.match(/。/g), sentence).toHaveLength(1);
      }
    }
    // The whole page stays a short read (the picture's labels included; the old page had about 1,400 English words,
    // and about 400 while it still ended with three facts for hosts).
    if (lang === 'en') expect(words(main?.text() ?? '')).toBeLessThan(450);
  });

  it.each(Object.entries(HOME_PAGES))('%s: ends with the four cards: no section for hosts under them, one link in the page (the quick start), and the guides one link away', (lang, path) => {
    // Until 2026-10-09 the page ended with a section "Before you share": three facts for hosts and a link to the
    // host guide. The owner's decision: the page is one sentence and a picture, and what a host must know before
    // sharing is the guides' to say, whole (the test of the guides, below, holds their sentences).
    const p = page(path);
    const l = lang as Lang;
    const main = first(p, 'main');
    // <main> is the hero alone, and the hero ends with the story (the strip, the window, the four cards).
    expect(main?.children().map((el) => `${el.tag}.${classes(el).join('.')}`)).toEqual(['section.hero.wrap']);
    expect(main?.children()[0]?.children().map((el) => `${el.tag}.${classes(el).join('.')}`)).toEqual(['h1.', 'p.lede', 'div.install', 'div.story']);
    expect(withClass(p, 'story')[0]?.children().map((el) => `${el.tag}.${classes(el).join('.')}`)).toEqual(['p.visually-hidden.story-state', 'figure.demo', 'ul.cards']);
    // No list in <main> but the cards: nothing was put in the section's place. And one link in all of <main>, since
    // 2026-10-10 (the owner asked for a quick start): to the quick start, under the install line, nowhere else.
    expect(inside(p, main).filter((el) => ['ul', 'ol', 'dl'].includes(el.tag)).map((el) => classes(el).join('.'))).toEqual(['cards']);
    const links = inside(p, main).filter((el) => el.tag === 'a');
    expect(links.map((a) => [a.attr('href'), a.parents.at(-1)?.attr('class'), a.parents.at(-2)?.attr('class')])).toEqual([[QUICK_START[l].path, 'install-start', 'install']]);
    for (const gone of ['share', 'share-row', 'more']) expect(withClass(p, gone), gone).toEqual([]);
    expect(p.ids()).not.toContain('share-title');
    // The stylesheet kept nothing of it either.
    expect(readPublic('style.css')).not.toMatch(/\.share\b|\.more\b/);
    // The way to the guides: Docs, in the header and in the footer.
    for (const tag of ['header', 'footer']) expect(p.elements.filter((el) => el.tag === 'a' && el.parents.some((parent) => parent.tag === tag)).map((a) => a.attr('href')), tag).toContain(docsIndex(l));
  });

  it('show no version number, and no statement about the app’s language being Chinese only', () => {
    for (const path of Object.values(HOME_PAGES)) {
      const p = page(path);
      // The page's words, and what stands for words where nobody sees them: the picture's story and every other
      // label, the title, the descriptions and every string of the structured data.
      const unseen = [
        ...p.elements.flatMap((el) => [el.attr('aria-label'), el.tag === 'meta' ? el.attr('content') : undefined, el.tag === 'title' ? el.text() : undefined]).filter((value): value is string => value !== undefined),
        ...stringsIn(dataBlocks(p)),
      ];
      expect(unseen.length, path).toBeGreaterThan(40);
      for (const text of [bodyText(path), ...unseen]) {
        // No version at all, smurg's or Claude Code's: what a version needs and what changed in it is the guides' job.
        expect(text, path).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
        expect(text, path).not.toMatch(/Traditional Chinese for now|English is coming/);
      }
    }
  });

  it('show every word they hold: nothing in <main> is hidden but the Copy button and its status line, and no rule takes the hero’s words, its link or the cards off the page', () => {
    // The tests above read the pages' text, so a sentence that is in the markup but not on the screen would pass
    // them. In <main> only the Copy button carries `hidden` (copy.js shows it), and only three things are kept for
    // screen readers alone: the status line, the popover's sentence and the second word of the Pause button.
    for (const path of Object.values(HOME_PAGES)) {
      const p = page(path);
      const main = inside(p, first(p, 'main'));
      expect(main.filter((el) => el.attr('hidden') !== undefined).map((el) => `${el.tag}.${classes(el).join('.')}`), path).toEqual(['button.copy']);
      // aria-hidden: the drawings (svg), and the inside of the picture, whose story its label tells.
      expect(main.filter((el) => el.attr('aria-hidden') !== undefined && el.tag !== 'svg').map((el) => `${el.tag}.${classes(el).join('.')}`), path).toEqual(['div.m-app']);
      expect(main.filter((el) => classes(el).includes('visually-hidden')).map((el) => `${el.tag}#${el.attr('id') ?? ''}.${el.parents.at(-1)?.attr('class') ?? ''}`), path).toEqual([
        'p#copy-status.install',
        'p#story-paused.story',
        'span#.when-playing',
        'span#.when-paused',
        'svg#.win',
      ]);
      // Nothing inside the cards but text and the two file names (and <wbr>, where a Chinese line may break).
      expect(withClass(p, 'cards'), path).toHaveLength(1);
      expect([...new Set(inside(p, withClass(p, 'cards')[0]).map((el) => el.tag))].filter((tag) => tag !== 'wbr').sort(), `${path} .cards`).toEqual(['code', 'h2', 'li', 'p']);
    }
    // And the stylesheet has no rule that hides, empties or shrinks away the hero's words or the cards: every rule
    // whose selector names one of them is read.
    const css = readPublic('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const kept = /\.(?:cards|lede|hero|install-note|install-start)\b|\.install p\b/;
    let read = 0;
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      // (a ::before or ::after holds no words: a dash, a number, the rule of the card that is playing)
      const selector = (selectors as string).split(',').filter((part) => kept.test(part) && !part.includes('::')).join(',').trim();
      if (selector === '') continue;
      read++;
      expect(body, selector).not.toMatch(/display:\s*none|visibility|opacity|clip|(?:^|[\s;])(?:max-)?(?:height|width):\s*0(?![.\d])|font-size:\s*0(?![.\d])|text-indent|position:\s*(?:absolute|fixed)|transform|overflow|color:\s*transparent|content-visibility/);
    }
    expect(read).toBeGreaterThan(15);
  });

  it.each(Object.entries(HOME_PAGES))('%s: says that smurg is open source (MIT) in its footer and links the repository, and nothing that denies a relay of one’s own', (lang, path) => {
    const p = page(path);
    const text = bodyText(path);
    expect(first(p, 'footer')?.text()).toContain(CHROME[lang as Lang].footer);
    expect(p.elements.filter((el) => el.tag === 'a' && el.parents.some((parent) => parent.tag === 'header')).map((a) => a.attr('href'))).toContain(REPOSITORY);
    expect(text).not.toMatch(/can’t run (?:your|their) own|only relay for now|無法自己架設|沒有其他 relay/);
  });

  it.each(Object.entries(HOME_PAGES))('%s: the third card says that every work item has its own git worktree and that its agent asks before commands', (lang, path) => {
    // What the page still says about what an agent may do, in the card of the scene that shows it (the permission
    // request). Whose Claude account does the work and what the flow was tested with left the page with its three
    // facts: the guides say both (the test of the guides, below).
    const p = page(path);
    const card = inside(p, withClass(p, 'cards')[0]).filter((el) => el.tag === 'li')[2]?.text() ?? '';
    expect(card).toContain('git worktree');
    expect(card).toContain(lang === 'en' ? 'its agent asks before commands' : 'agent 執行指令前會先問');
  });

  it.each(Object.entries(HOME_PAGES))('%s: claims no sandbox anywhere: the word is not on the page, in its title, labels or descriptions, and nothing describes one', (lang, path) => {
    const p = page(path);
    const text = bodyText(path);
    const titles = p.byTag('title').map((t) => t.text()).join('\n');
    const labels = p.elements.map((el) => el.attr('aria-label') ?? '').join('\n');
    const descriptions = p.byTag('meta').map((m) => m.attr('content') ?? '').join('\n');
    // (what the structured data says to a search engine counts like what the page says to a reader)
    const data = stringsIn(dataBlocks(p)).join('\n');
    expect(labels.length).toBeGreaterThan(lang === 'en' ? 400 : 150);
    expect(descriptions.length).toBeGreaterThan(100);
    expect(data.length).toBeGreaterThan(300);
    for (const all of [text, titles, labels, descriptions, data]) {
      expect(all).not.toMatch(/Seatbelt|bubblewrap|AppArmor|socat|ripgrep|allow-listed|白名單|guest sandbox|客人沙盒|in a sandbox|sandboxed|在沙盒裡執行|--allow-main-workspace-guests|\brunners?\b|可執行 agent|API key|can use agents/i);
      // There is no sandbox (ARCHITECTURE §11 D-15), and the page no longer says so itself: the one sentence that
      // did ("with no sandbox") left with the three facts, and the guides say it (the test of the guides, below).
      // So the word does not occur at all: any mention here would be a claim, or half of the guides' warning.
      expect(all).not.toMatch(/sandbox|沙盒|沙箱/i);
      // Nor another word for the same promise.
      expect(all).not.toMatch(/\bisolat|\bconfine|\bjail|container|隔離|容器/i);
    }
  });

  it.each(Object.entries(HOME_PAGES))('%s: the picture is an illustration with its story in words, labelled in the page’s own language with the app’s words', (lang, path) => {
    const p = page(path);
    const l = lang as Lang;
    const [picture, ...others] = p.elements.filter((el) => el.attr('role') === 'img' && el.tag !== 'svg');
    expect(others).toEqual([]);
    expect(classes(picture as El)).toEqual(['win']);
    // The picture's labels are most of the page's words, and they are made up (a cart, a checkout page): a search
    // result must not quote them as what smurg is. `data-nosnippet` on the picture says so to a search engine, and
    // on nothing else: the sentence, the line under it and the cards are what a result may quote.
    expect(p.elements.filter((el) => el.attr('data-nosnippet') !== undefined)).toEqual([picture]);
    expect(picture?.attr('data-nosnippet')).toBe('');
    // The story in words, for who cannot see the picture: every part by its name, in order, and who does what.
    const story = picture?.attr('aria-label') ?? '';
    expect(story.length).toBeGreaterThan(l === 'en' ? 400 : 150);
    expect(story).toMatch(l === 'en' ? /^Illustration of / : /示意圖/);
    const told = PARTS[l].map((part) => story.indexOf(`${part}${l === 'en' ? ':' : '：'}`));
    expect(told.every((at, index) => at > (told[index - 1] ?? 0)), `${told}`).toBe(true);
    for (const name of ['Claude', 'Ian', 'Amy', 'Ben']) expect(story, name).toContain(name);
    // And in a few words under it, for who can.
    const caption = first(p, 'figcaption')?.text() ?? '';
    expect(caption).toMatch(l === 'en' ? /^An illustration of the app, not a screenshot\./ : /示意圖，不是截圖/);
    // … and that what it shows is invented: no real team's topic, no real people.
    expect(caption).toMatch(l === 'en' ? /The topic and the people are made up\.$/ : /主題和人物是虛構的。$/);
    expect(words(caption)).toBeLessThan(20);

    const app = picture?.children().find((c) => classes(c).includes('m-app'));
    // The picture is its label: what is drawn inside is kept from screen readers (about 150 labels of four scenes,
    // most of them not on the screen at any one moment), whether or not a browser prunes the children of an image.
    expect(app?.attr('aria-hidden')).toBe('true');
    // The labels are in the page's language: no `lang` of its own.
    expect(app?.attr('lang')).toBeUndefined();
    const cjk = /[　-〿一-鿿＀-￯]/;
    const leaves = inside(p, app).filter((el) => el.children().length === 0);
    const labels = leaves.map((el) => el.text());
    if (l === 'en') for (const label of labels) expect(label, label).not.toMatch(cjk);
    else expect(labels.filter((label) => cjk.test(label)).length).toBeGreaterThan(40);
    // The app's own words (the catalogs; tests/lint/docs-quotes.test.ts holds every label to them): the question
    // card, the plan, a permission request, the result report and the merge.
    const expected =
      l === 'en'
        ? ['Connected', 'Question from Claude', 'Leading', 'Ian decides', 'Submit answer', 'Ready to start', 'Running', 'Waiting for permission', 'Claude asks for permission to run a command', 'Allow once', 'Deny', 'Report to review', 'What was done', 'How it was verified', 'Changes', "I've reviewed this", 'Marked as reviewed.', 'Reviewed', 'Reviewed · merged']
        : ['已連線', 'Claude 的選擇題', '領先', '由 Ian 決定', '送出答案', '可以開始', '執行中', '等待許可', 'Claude 請求許可執行指令', '允許一次', '拒絕', '報告待看', '做了什麼', '怎麼驗證的', '變更', '我已看過', '已標成看過。', '已看過', '已看過 · 已合併'];
    for (const label of expected) expect(labels, label).toContain(label);
    expect(app?.text()).toContain(l === 'en' ? 'Merged into the main workspace.' : '已合併到主工作區。');
    // In a conversation the agent is `Claude` in both languages (docs/GLOSSARY.md), never with full-width parentheses.
    expect(app?.text()).not.toMatch(/Claude（/);
    // What a person or an agent wrote (not a label of the app) is marked, so the quote lint can tell the two apart;
    // a number is an `i.m-count`, a command a `pre.m-term`, and the address is the app's.
    const said = inside(p, app).filter((el) => classes(el).includes('m-said'));
    expect(said.length).toBeGreaterThan(20);
    for (const el of said) expect(el.children(), el.text()).toEqual([]);
    for (const pre of inside(p, app).filter((el) => el.tag === 'pre')) expect(classes(pre)).toEqual(['m-term']);
    for (const leaf of leaves.filter((el) => /^[+−\d\s]+$/.test(el.text()) && el.text() !== '' && el.tag !== 'b')) expect(classes(leaf), leaf.text()).toContain('m-count');
    expect(withClass(p, 'm-url').map((el) => el.text())).toEqual(['app.smurg.ai']);
    // Nothing in the picture can be operated or followed: it is a picture.
    expect(inside(p, picture).filter((el) => ['a', 'button', 'summary', 'details', 'select', 'textarea'].includes(el.tag) || el.attr('tabindex') !== undefined)).toEqual([]);
  });

  it.each(Object.entries(HOME_PAGES))('%s: four scenes, a strip of four parts that names them, and a real Pause button that works without the script', (lang, path) => {
    const p = page(path);
    const l = lang as Lang;
    const scenes = withClass(p, 'scene');
    // Each scene carries the name of its part (what the still picture writes over it), the strip the same four names.
    expect(scenes.map((scene) => scene.attr('data-part'))).toEqual([...PARTS[l]]);
    const strip = withClass(p, 'tabs')[0];
    expect(strip?.attr('role')).toBe('group');
    expect(strip?.attr('aria-label')?.length).toBeGreaterThan(3);
    // The strip stands outside the picture (a picture has nothing to press), in the same figure.
    expect(strip?.parents.some((el) => el.attr('role') === 'img')).toBe(false);
    expect(strip?.parents.at(-1)?.tag).toBe('figure');
    const tabs = withClass(p, 'tab');
    expect(tabs.map((tab) => tab.children().at(-1)?.text())).toEqual([...PARTS[l]]);
    for (const tab of tabs) {
      expect(tab.tag).toBe('button');
      // Labels until demo.js makes them work; it also says which one is on (aria-current), so none is marked here.
      expect(tab.attr('disabled')).toBe('');
      expect(tab.attr('aria-current')).toBeUndefined();
    }
    // The place in the loop of a scene, of its part of the strip and of its card: the same class on all three.
    const place = (el: El): string[] => classes(el).filter((name) => /^in\d$/.test(name));
    const cards = inside(p, withClass(p, 'cards')[0]).filter((el) => el.tag === 'li');
    for (const group of [scenes, tabs, cards]) expect(group.map(place)).toEqual([[], ['in1'], ['in2'], ['in3']]);
    // Pause: a button with its word on it, which opens a popover the stylesheet reads (so it works with no script).
    const [pause, ...more] = withClass(p, 'pause');
    expect(more).toEqual([]);
    expect(pause?.tag).toBe('button');
    expect(pause?.parents).toContain(strip);
    const state = p.elements.find((el) => el.attr('id') === pause?.attr('popovertarget'));
    expect(state?.attr('popover')).toBe('manual');
    expect(state?.text().length).toBeGreaterThan(3);
    // Both of its words are in the page (the stylesheet shows one): "Pause" while it plays, "Play" while it stands.
    expect(pause?.children().filter((c) => c.tag === 'span').map((c) => [classes(c).join(' '), c.text()])).toEqual(
      l === 'en'
        ? [
            ['when-playing', 'Pause the picture'],
            ['when-paused', 'Play the picture'],
          ]
        : [
            ['when-playing', '暫停示意圖'],
            ['when-paused', '播放示意圖'],
          ],
    );
  });

  it('the picture’s moments have rules, and the script counts the loop as the stylesheet does', () => {
    const css = readPublic('style.css');
    const script = readPublic('demo.js');
    for (const path of Object.values(HOME_PAGES)) {
      const used = new Set(page(path).elements.flatMap(classes).filter((name) => /^(?:t\d\d|in\d|a-[a-z]+)$/.test(name)));
      expect(used.size).toBeGreaterThan(20);
      for (const name of used) {
        if (/^t\d\d$/.test(name)) expect(css, name).toContain(`.${name} { --at: ${Number(name.slice(1)) / 10}s; }`);
        else expect(css, name).toMatch(new RegExp(`\\.${name}[ ,{]`));
      }
      // No moment at or after the scene's end, where the scene fades.
      for (const name of used) if (/^t\d\d$/.test(name)) expect(Number(name.slice(1)) / 10, name).toBeLessThan(4.6);
    }
    const seconds = (name: string): number => Number(new RegExp(`--${name}: (\\d+)s;`).exec(css)?.[1]);
    expect(seconds('scene')).toBe(5);
    // Four scenes, each --scene long, are the loop; demo.js moves the same clock, in milliseconds.
    expect(seconds('loop')).toBe(4 * seconds('scene'));
    expect(script).toContain(`const SCENE = ${seconds('scene') * 1000};`);
    expect(script).toContain('const LOOP = 4 * SCENE;');
    const finished = Number(/const FINISHED = (\d+);/.exec(script)?.[1]);
    // "Finished": after the last moment of any scene, before the scene fades (24% of the loop into it).
    expect(finished).toBeGreaterThan(4300);
    expect(finished).toBeLessThanOrEqual(0.24 * seconds('loop') * 1000);
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
      // (runs of Chinese between Latin words, marks and line ends; the quick start is short on purpose)
      expect((readFileSync(join(REPO_ROOT, doc['zh-TW'].source), 'utf8').match(cjk) ?? []).length, doc['zh-TW'].source).toBeGreaterThan(doc === QUICK_START ? 100 : 200);
    }
    expect(CHROME['zh-TW'].name).toBe('繁體中文');
    expect(CHROME.en.name).toBe('English');
  });

  it.each(LANGS)('%s: the docs index links every docs page of its language, the license, the repository, both notices, and how to contribute and to report a vulnerability', (lang) => {
    const p = page(fileOf(docsIndex(lang)));
    expect(first(p, 'html')?.attr('lang')).toBe(HTML_LANG[lang]);
    expect(first(p, 'h1')?.text()).toBe(CHROME[lang].indexHeading);
    // No note about another language any more: each language has its own guides.
    expect(p.elements.find((el) => el.attr('class') === 'doc-note')).toBeUndefined();
    const main = first(p, 'main');
    const links = p.elements.filter((el) => el.tag === 'a' && el.parents.includes(main as El)).map((a) => a.attr('href'));
    expect(links).toEqual([...DOC_PAGES.map((doc) => doc[lang].path), licensePage(lang), REPOSITORY, NOTICES_FILE, WEB_APP_NOTICES, `${REPOSITORY}/blob/main/CONTRIBUTING.md`, `${REPOSITORY}/blob/main/SECURITY.md`]);
    expect(main?.text()).toContain(lang === 'en' ? 'open source under the MIT License' : '以 MIT 授權條款釋出');
  });

  it('the quick start is the first of the docs and stays quick: numbered steps that count on through its sections, one box of what a host must know with a link to the host guide, and every other link into the two guides', () => {
    expect(DOC_PAGES[0]).toBe(QUICK_START);
    expect(LANGS.map((lang) => [QUICK_START[lang].path, QUICK_START[lang].label])).toEqual([
      ['/docs/quick-start/', 'Quick start'],
      ['/zh-TW/docs/quick-start/', '快速上手'],
    ]);
    const shape: Record<string, unknown> = {};
    for (const lang of LANGS) {
      const p = page(fileOf(QUICK_START[lang].path));
      const main = first(p, 'main');
      const inMain = p.elements.filter((el) => el.parents.includes(main as El));
      const text = (el: El | undefined): string => (el?.text() ?? '').replace(/\s+/g, lang === 'en' ? ' ' : '');
      // The steps: ordered lists whose numbers go on where the list before stopped, 8 to 12 steps in all, and each
      // starts with what to do, in bold.
      const lists = inMain.filter((el) => el.tag === 'ol');
      const counts = lists.map((ol) => ol.children().filter((li) => li.tag === 'li').length);
      expect(lists.map((ol) => Number(ol.attr('start') ?? '1')), lang).toEqual(counts.map((_, i) => 1 + counts.slice(0, i).reduce((sum, n) => sum + n, 0)));
      const steps = lists.flatMap((ol) => ol.children().filter((li) => li.tag === 'li'));
      expect(steps.length, lang).toBeGreaterThanOrEqual(8);
      expect(steps.length, lang).toBeLessThanOrEqual(12);
      for (const step of steps) expect(inMain.find((el) => el.parents.includes(step))?.tag, text(step).slice(0, 40)).toMatch(/^(?:strong|p)$/);
      for (const step of steps) expect(inMain.filter((el) => el.tag === 'strong' && el.parents.includes(step)).length, text(step).slice(0, 40)).toBe(1);
      // The two commands a host types, each once, in its own block; the install line is the home page's.
      const blocks = inMain.filter((el) => el.tag === 'pre').map((pre) => rawText(pre).trim());
      expect(blocks.slice(0, 2), lang).toEqual([INSTALL, 'smurg host ~/projects/my-app']);
      expect(blocks, lang).toHaveLength(3);
      // ONE box, before the step that sends the teammates' link, and named for it: agents run as the host with no
      // sandbox, on the host's Claude account; which kind of Claude account a group needs (the host guide's §4 and
      // the dialog that starts a topic say the same); whom to give Agent access; and the way to the host guide's §4
      // (the same facts the guides say in whole sentences, see the next test: here they are a pointer, not the
      // explanation). That every member sees the folder's files is said in the step that sends the link.
      const boxes = inMain.filter((el) => el.tag === 'blockquote');
      expect(boxes, lang).toHaveLength(1);
      const box = text(boxes[0]);
      expect(box.startsWith(lang === 'en' ? 'Before you send the link.' : '把連結傳給組員之前：'), lang).toBe(true);
      const facts = lang === 'en'
        ? ['they run on your computer as you, with no sandbox, on your Claude account, even when they work for a teammate', 'A personal Pro or Max subscription is for your own use: a group needs an API key or a Team or Enterprise plan', 'Give Agent access only to people you fully trust']
        : ['以你的身分在你的電腦上執行，沒有沙盒，用的是你的Claude帳號，替組員工作時也一樣', '個人的Claude訂閱（Pro或Max）只供你自己使用：多人使用請改用API金鑰，或Team、Enterprise方案', '只把「可使用agent」給你完全信任的人'];
      for (const fact of facts) expect(box, fact).toContain(fact);
      expect(text(steps[3]), lang).toContain(lang === 'en' ? 'they see and edit the files in the folder' : '看得到也可以編輯資料夾裡的檔案');
      const boxLinks = inMain.filter((el) => el.tag === 'a' && el.parents.includes(boxes[0] as El)).map((a) => a.attr('href'));
      expect(boxLinks, lang).toEqual([`${HOST_GUIDE[lang].path}#${lang === 'en' ? '4-before-you-share' : '4-分享前必讀'}`]);
      const order = inMain.filter((el) => el.tag === 'ol' || el.tag === 'blockquote').map((el) => el.tag);
      expect(order.indexOf('blockquote'), lang).toBe(1);
      // The word is only ever "no sandbox": the quick start describes none.
      expect(text(main).match(/sandbox|沙盒|沙箱/gi), lang).toHaveLength(1);
      // Every link of the text goes into the two guides of its language, at a heading, but for the first one: this
      // guide in the other language.
      const links = inMain.filter((el) => el.tag === 'a').map((a) => a.attr('href') ?? '');
      expect(links[0], lang).toBe(QUICK_START[otherLang(lang)].path);
      for (const href of links.slice(1)) expect(href.startsWith(`${HOST_GUIDE[lang].path}#`) || href.startsWith(`${TEAM_GUIDE[lang].path}#`), `${lang}: ${href}`).toBe(true);
      expect(links.some((href) => href.startsWith(`${TEAM_GUIDE[lang].path}#`)), lang).toBe(true);
      // What was verified is said where the reader is sent on (the guides' §10.8 has the whole of it).
      expect(text(main), lang).toContain(lang === 'en' ? 'verified against a scripted stand-in for the model, not with a real Claude account' : '是用照劇本回應的模型替身驗證的，沒有用真正的Claude帳號');
      // No version number, of smurg or of anything it needs: the host guide's §1 has them.
      expect(text(main), lang).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
      // Quick: about two screens of a laptop. In words (English) and in characters (Chinese has no spaces to count).
      if (lang === 'en') expect(text(main).split(' ').length, 'words').toBeLessThan(750);
      else expect([...text(main)].length, 'characters').toBeLessThan(1900);
      shape[lang] = [inMain.filter((el) => /^h[1-6]$|^ol$|^ul$|^blockquote$|^pre$/.test(el.tag)).map((el) => el.tag), counts, links.length];
    }
    // The same guide in both languages: the same headings, lists, blocks and box in the same order, as many steps and links.
    expect(shape['zh-TW']).toEqual(shape.en);
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
    const text = (lang: Lang, doc: (typeof DOC_PAGES)[number]): string => siteText(fileOf(doc[lang].path));
    for (const lang of LANGS) {
      for (const html of [text(lang, QUICK_START), text(lang, HOST_GUIDE), text(lang, TEAM_GUIDE)]) {
        expect(html).not.toMatch(/客人沙盒|guest sandbox|bubblewrap|AppArmor|Seatbelt|--allow-main-workspace-guests|--no-main-workspace-guests|--no-guest-subscription-login|可執行 agent|can run agents|can use agents|runner|用 Claude 訂閱登入|匯入個人設定/i);
        // Nothing that was true only while the source was private or of versions that are gone.
        expect(html).not.toMatch(RETIRED_CLAIMS);
        expect(html).not.toMatch(/0\.[123]\.0/);
      }
    }
    const hosting = text('en', HOST_GUIDE);
    expect(hosting).toContain('id="4-before-you-share"');
    expect(hosting).toContain('id="5-agent-access-and-agents-shell-commands"');
    for (const phrase of ['run any command on your computer', 'read your home folder', 'use your Claude account', 'Give this role only to people you fully', 'the usage and the cost are yours', '--role agent', 'you can run your own relay']) {
      expect(hosting, phrase).toContain(phrase);
    }
    expect(text('en', TEAM_GUIDE)).toContain('as the host');
    // The sections the `smurg` command's help links by their heading (packages/cli/src/i18n: usage.host, usage.status,
    // usage.uninstall, usage.attach), and the ones 0.5.0 added.
    for (const id of ['7-status-and-stopping', '9-updating-and-removing', '10-topics-from-the-hosts-side']) expect(hosting, id).toContain(`id="${id}"`);
    // The parts of §9 the one-line notices of `smurg host` send their reader to (0.5.1: GUIDE_KEPT and GUIDE_GOING_BACK
    // in packages/cli/src/i18n; packages/cli/test/guide-anchors.test.ts holds the catalogs to the Markdown headings,
    // this holds the built page to the same ids). Rewording one of these headings breaks a printed address.
    for (const id of ['92-after-an-update-what-your-workspace-keeps', '94-if-you-moved-the-state-folder-away-because-smurg-050-told-you-to']) expect(hosting, id).toContain(`id="${id}"`);
    for (const id of ['10-joining-from-a-terminal-cli-optional', '6-topics-from-discussion-to-reviewed-result']) expect(text('en', TEAM_GUIDE), id).toContain(`id="${id}"`);
    // What 0.5.0 must say to a host: the Claude Code floor, git for work items, whose account, the host's own rules,
    // and that the flow was verified against a scripted stand-in.
    for (const phrase of ['2.1.288 or later', 'git 2.42 or later', 'Your own allow rules apply', 'a Team or Enterprise plan', 'scripted stand-in for the model', 'No real Claude account was used']) {
      expect(hosting, phrase).toContain(phrase);
    }
    const zh = text('zh-TW', HOST_GUIDE);
    expect(zh).toContain('id="5-可使用-agent角色與-agent-的-shell-指令"');
    for (const phrase of ['在你的電腦上執行任何指令', '讀取你的家目錄', '使用你的 Claude 帳號', '只把這個角色給你完全信任的人', '用量和費用都算在你身上', '--role agent', '你可以自己架設 relay']) {
      expect(zh, phrase).toContain(phrase);
    }
    for (const id of ['7-狀態與停止', '9-更新與移除', '92-更新之後工作區保留了什麼', '94-如果你照-smurg-050-的指示把狀態資料夾移走了']) expect(zh, id).toContain(`id="${id}"`);
    expect(text('zh-TW', TEAM_GUIDE)).toContain('id="10-用終端機cli加入選用"');
    for (const phrase of ['2.1.288 以上', '你自己的允許規則也有效', 'Team 或 Enterprise 方案', '照劇本回應的', '沒有使用任何真正的 Claude 帳號']) {
      expect(zh, phrase).toContain(phrase);
    }
    expect(text('zh-TW', TEAM_GUIDE)).toContain('以主人的身分');
    // The relay's README is linked on GitHub from both host guides.
    for (const html of [hosting, zh]) expect(html).toContain(`<a href="${RELAY_README}">`);

    // Until 2026-10-09 the home pages ended with three facts for hosts ("Before you share"), and tests held their
    // key phrases there. The pages are one sentence and a picture now (the owner's decision), so each of those facts
    // is held here, where the guides say it, as the guides' own whole sentences: read as a reader reads the built
    // page (its text, not its markup; English with single spaces, Chinese without any).
    const said = (lang: Lang, doc: (typeof DOC_PAGES)[number]): string => (first(page(fileOf(doc[lang].path)), 'main')?.text() ?? '').replace(/\s+/g, lang === 'en' ? ' ' : '');
    // (which guide says it: 0 the host guide, 1 the guide for teammates)
    const GUIDE = [HOST_GUIDE, TEAM_GUIDE] as const;
    const SENTENCES: Readonly<Record<Lang, readonly (readonly [0 | 1, string, readonly string[]])[]>> = {
      en: [
        // 1. Agents run on the host's computer as the host, with no sandbox (host guide §4 and §5.1; the teammates' guide's introduction and §2).
        [0, 'no sandbox', ['No agent session is sandboxed.', 'These sessions run on your computer as you, exactly like the ones you start in your own terminal:', 'No sandbox: your operating-system account, your home folder']],
        [1, 'as the host, no sandbox', ["In smurg every agent runs on the host's computer, as the host, with the host's Claude account", "the agents you start and the terminals you open run on the host's computer as the host, with no sandbox"]],
        // … so Agent access only for people the host fully trusts: the role lets someone run any command on the host's computer.
        [0, 'whom to give Agent access', ['Give Agent access only to people you fully trust (§5.1): this role lets someone make an agent run any command on your computer, read your home folder and use your Claude account.', 'Give this role only to people you fully trust, for example someone you would hand your logged-in computer to.']],
        [1, 'whom a host gives it', ['That is why a host gives this role only to people they fully trust.']],
        // 2. Whose Claude account does the work, what Anthropic's terms say of a personal subscription, and the plans meant for a group (host guide §4).
        [0, 'whose Claude account', ['Whose Claude account works for the group: every agent uses the account claude is logged in to on this computer, also when it works for a teammate; the usage and the cost are yours.', 'A personal Claude subscription (Pro or Max) is for your own use.', "Anthropic's terms do not allow making a personal account available to other people; for a group, log Claude Code in with an API key, a Team or Enterprise plan, or a cloud provider."]],
        // 3. What the flow was tested with: a scripted stand-in for the model, and no real Claude account (host guide §10.8; teammates' guide §6).
        [0, 'what was verified', ["was verified by smurg's developers against a scripted stand-in for the model.", 'No real Claude account was used for testing.']],
        [1, 'what was tested', ['the flow of this version was tested with a scripted stand-in for the model, not with a real Claude account']],
      ],
      'zh-TW': [
        [0, 'no sandbox', ['所有 agent session 都不在沙盒裡。', '這些 session 以你的身分在你的電腦上執行，和你自己在終端機裡開的沒有差別：', '沒有沙盒：用你的作業系統帳號、你的家目錄']],
        [1, 'as the host, no sandbox', ['每個 agent 都在主人的電腦上、以主人的身分、用主人的 Claude 帳號執行', '你開始的 agent 和你開的終端機，在主人的電腦上以主人的身分執行，沒有沙盒']],
        [0, 'whom to give Agent access', ['只把「可使用 agent」給你完全信任的人（§5.1）：這個角色可以讓 agent 在你的電腦上執行任何指令、讀你的家目錄、用你的 Claude 帳號。', '只把這個角色給你完全信任的人，例如你願意把自己已經登入的電腦交給他使用的人。']],
        [1, 'whom a host gives it', ['所以主人只會把這個角色給完全信任的人。']],
        [0, 'whose Claude account', ['整個團隊用的是誰的 Claude 帳號：每個 agent 都用這台電腦上 claude 目前登入的帳號，替組員工作時也一樣；用量和費用都算在你身上。', '個人的 Claude 訂閱（Pro 或 Max）只供你自己使用。', 'Anthropic 的條款不允許把個人帳號提供給其他人使用；多人使用時，請讓 Claude Code 改用 API 金鑰、Team 或 Enterprise 方案，或雲端供應商登入。']],
        [0, 'what was verified', ['是 smurg 的開發者用一個照劇本回應的模型替身驗證的。', '測試時也沒有使用任何真正的 Claude 帳號。']],
        [1, 'what was tested', ['這個版本的流程是用照劇本回應的模型替身測試的，沒有用真正的 Claude 帳號']],
      ],
    };
    for (const lang of LANGS) {
      // The same facts in the same order in both languages, from the same guide each.
      expect(SENTENCES[lang].map(([index, what, sentences]) => [index, what, sentences.length])).toEqual(SENTENCES.en.map(([index, what, sentences]) => [index, what, sentences.length]));
      for (const [index, what, sentences] of SENTENCES[lang]) {
        const guide = said(lang, GUIDE[index]);
        for (const sentence of sentences) expect(guide, `${lang}, ${GUIDE[index][lang].source}, ${what}`).toContain(sentence.replace(/\s+/g, lang === 'en' ? ' ' : ''));
      }
    }
    // The word "prototype" itself is in no guide: the repository's README says it, in its status line, with what
    // the flow was verified against (both languages).
    const readme = (file: string, lang: Lang): string => readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\n> /g, '\n').replace(/\s+/g, lang === 'en' ? ' ' : '');
    expect(readme('README.md', 'en')).toContain('**Status: prototype.** Developed and tested on macOS (Apple silicon). The topics flow was verified against a scripted stand-in for the model, not with a real Claude account');
    expect(readme('README.zh-TW.md', 'zh-TW')).toContain('**狀態：原型**。在 macOS（Apple Silicon）上開發和測試。主題的流程是用照劇本回應的模型替身驗證的，沒有用真正的 Claude 帳號'.replace(/\s+/g, ''));
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

describe('being found: what a search engine, a link preview or an assistant is told', () => {
  /** The pages a search engine may show: every page but the two 404 pages. */
  const INDEXABLE = sitePages().filter((path) => !NOT_FOUND_PAGES.includes(path));
  const titleOf = (p: Page): string => p.byTag('title')[0]?.text() ?? '';
  const canonicalOf = (p: Page): string => p.byTag('link').find((l) => l.attr('rel') === 'canonical')?.attr('href') ?? '';
  const isHome = (path: string): boolean => (Object.values(HOME_PAGES) as string[]).includes(path);
  const docAt = (path: string): (typeof DOC_PAGES)[number] | undefined => DOC_PAGES.find((doc) => LANGS.some((lang) => fileOf(doc[lang].path) === path));

  it('every page has a title and a description of its own, written to be shown whole and in the page’s language', () => {
    expect(INDEXABLE).toHaveLength(14);
    const titles = INDEXABLE.map((path) => titleOf(page(path)));
    const descriptions = INDEXABLE.map((path) => metaOf(page(path), 'description') ?? '');
    expect(new Set(titles).size).toBe(14);
    expect(new Set(descriptions).size).toBe(14);
    for (const path of INDEXABLE) {
      const p = page(path);
      const lang = langOf(p);
      const title = titleOf(p);
      const description = metaOf(p, 'description') ?? '';
      // What a result shows as its first line: about 60 Latin characters, and the name is in it. A home page and
      // the docs index start with the name; every other page ends with it, after what the page is.
      expect(widthOf(title), title).toBeLessThanOrEqual(60);
      expect(title.startsWith('smurg') || title.endsWith(' · smurg'), title).toBe(true);
      // What a result shows under it: a snippet has room for about 920 px of 14 px text. In characters that is a
      // rule of thumb, because letters differ in width: about 146 Latin characters, or 66 Chinese ones (a
      // full-width character counts as two). Every description here was measured in Chrome and is under 920 px
      // (README.md, "Being found", says how). A much shorter one is replaced by words the search engine picks from
      // the page. So a description is a sentence or two of 120 to 146 characters, in Chinese 100 to 133 of width:
      // written, with its full stop, never the start of the page cut off.
      if (lang === 'en') {
        expect(description.length, description).toBeGreaterThanOrEqual(120);
        expect(description.length, description).toBeLessThanOrEqual(146);
      } else {
        expect(widthOf(description), description).toBeGreaterThanOrEqual(100);
        expect(widthOf(description), description).toBeLessThanOrEqual(133);
      }
      expect(description, path).toMatch(lang === 'en' ? /[.?]$/ : /。$/);
      expect(description, path).not.toMatch(/…|\.\.\./);
      expect(description, path).toBe(description.trim().replace(/\s+/g, ' '));
      // In the page's language, and not the sentence of a guide that names its translation.
      const cjk = /[　-〿一-鿿＀-￯]/;
      for (const text of [title, description]) {
        if (lang === 'en') expect(text, path).not.toMatch(cjk);
        expect(text, path).not.toMatch(/English|Chinese|繁體中文|英文版|中文版/);
      }
      if (lang === 'zh-TW') expect(description, path).toMatch(cjk);
      // Words that would bring the wrong searcher: Anthropic's own plan and feature ("Claude Code for teams",
      // "agent teams"), a server one deploys ("self-hosted": the host is a personal computer), sharing one account.
      for (const text of [title, description]) expect(text, path).not.toMatch(/Claude Code for teams|agent teams?|self-hosted|agent 團隊|共用|自架/i);
      // A link preview says the same title; its description is the same but on the home pages, whose previews
      // have their own, longer one. To a preview a document is an article; a home page, an index and the license
      // are pages of the site.
      expect(metaOf(p, 'og:title'), path).toBe(title);
      if (!isHome(path)) expect(metaOf(p, 'og:description'), path).toBe(description);
      expect(metaOf(p, 'og:type'), path).toBe(docAt(path) === undefined ? 'website' : 'article');
    }
    // The home pages' preview and Twitter texts are written by hand: the title is the page's, the descriptions say
    // what the page's does at more length, and each ends as a sentence.
    for (const [lang, path] of Object.entries(HOME_PAGES)) {
      const p = page(path);
      expect(metaOf(p, 'twitter:title'), path).toBe(titleOf(p));
      for (const key of ['og:description', 'twitter:description']) expect(metaOf(p, key), `${path} ${key}`).toMatch(lang === 'en' ? /^Share a project folder from your own computer\..*\.$/ : /^從自己的電腦分享專案資料夾。.*。$/);
    }
  });

  it('a document’s title starts as its name in the docs does, and a title that says Claude Code stands on a page that does', () => {
    for (const lang of LANGS) {
      for (const doc of DOC_PAGES) {
        const p = page(fileOf(doc[lang].path));
        // "Quick start: …", "Host guide: …": the name the docs index, the navigation and the page's own heading use.
        expect(titleOf(p), doc[lang].path).toBe(`${doc[lang].title} · smurg`);
        expect(doc[lang].title.startsWith(`${doc[lang].label}${lang === 'en' ? ': ' : '：'}`), doc[lang].title).toBe(true);
        expect(first(p, 'h1')?.text().startsWith(doc[lang].label), doc[lang].path).toBe(true);
        expect(metaOf(p, 'description'), doc[lang].path).toBe(doc[lang].description);
      }
      for (const path of INDEXABLE.filter((file) => langOf(page(file)) === lang)) {
        const p = page(path);
        if (titleOf(p).includes('Claude Code')) expect(first(p, 'main')?.text(), path).toContain('Claude Code');
      }
      // The words people search for are in the titles of the pages a searcher should land on: the two home pages
      // and the three guides.
      for (const path of [HOME_PAGES[lang], ...[QUICK_START, HOST_GUIDE, TEAM_GUIDE].map((doc) => fileOf(doc[lang].path))]) expect(titleOf(page(path)), path).toContain('Claude Code');
    }
    // What a description promises is what its guide says (the guides' own sentences are held by the tests above).
    const said = (lang: Lang, doc: (typeof DOC_PAGES)[number]): string => (first(page(fileOf(doc[lang].path)), 'main')?.text() ?? '').replace(/\s+/g, lang === 'en' ? ' ' : '');
    expect(HOST_GUIDE.en.description).toContain('as you, with no sandbox');
    expect(said('en', HOST_GUIDE)).toContain('These sessions run on your computer as you');
    expect(HOST_GUIDE['zh-TW'].description).toContain('沒有沙盒');
    expect(TEAM_GUIDE.en.description).toContain('nothing to install, no Claude account');
    expect(said('en', TEAM_GUIDE)).toContain('you do not need a Claude account or an API key');
    expect(said('en', QUICK_START)).toContain('nothing to install, no Claude account');
    expect(TEAM_GUIDE['zh-TW'].description).toContain('不必安裝，也不需要 Claude 帳號');
    expect(said('zh-TW', TEAM_GUIDE)).toContain('不需要Claude帳號');
  });

  it('the structured data of a page is that page’s: its address, its title or heading, its description and its language, and nothing the page does not say', () => {
    interface Node {
      readonly [key: string]: unknown;
    }
    const sitemap = siteText('sitemap.xml');
    let blocks = 0;
    for (const path of sitePages()) {
      const p = page(path);
      const data = dataBlocks(p) as { '@context'?: unknown; '@graph'?: Node[] }[];
      const doc = docAt(path);
      const index = LANGS.some((lang) => fileOf(docsIndex(lang)) === path);
      // The home pages, the docs index and the documents have one block; the license pages and the 404 pages none
      // (a license text and an error have nothing more to say to a search engine).
      if (!isHome(path) && doc === undefined && !index) {
        expect(data, path).toEqual([]);
        continue;
      }
      blocks++;
      expect(data, path).toHaveLength(1);
      expect(data[0]?.['@context'], path).toBe(DATA_CONTEXT);
      expect(Object.keys(data[0] ?? {}), path).toEqual(['@context', '@graph']);
      const graph = data[0]?.['@graph'] ?? [];
      const lang = langOf(p);
      const url = canonicalOf(p);
      const title = titleOf(p);
      const description = metaOf(p, 'description');
      expect(url, path).toBe(`${ORIGIN}/${path.replace(/index\.html$/, '')}`);

      // The page itself, by its canonical address.
      const self = graph.find((node) => node['@id'] === `${url}#page`);
      expect(self?.['url'], path).toBe(url);
      expect(self?.['description'], path).toBe(description);
      expect(self?.['inLanguage'], path).toBe(HTML_LANG[lang]);
      // The site it is a page of. A search engine reads each page's block by itself: a home page defines the site
      // (below) and refers to it by its id; a docs page says the site's type, address and name where it refers to
      // it. So every id a block refers to and does not describe is one the same block defines.
      const site = { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'smurg' };
      expect(self?.['isPartOf'], path).toEqual(isHome(path) ? { '@id': site['@id'] } : site);
      const references = (value: unknown): unknown[] => {
        if (Array.isArray(value)) return value.flatMap(references);
        if (typeof value !== 'object' || value === null) return [];
        return Object.keys(value).join() === '@id' ? [(value as Node)['@id']] : Object.values(value).flatMap(references);
      };
      for (const id of references(graph)) expect(graph.map((node) => node['@id']), `${path}: ${String(id)}`).toContain(id);
      // A guide is an article whose headline is its heading; every other page has the name its title gives it.
      const type = isHome(path) ? 'WebPage' : index ? 'CollectionPage' : doc?.[lang].schema;
      expect(self?.['@type'], path).toBe(type);
      if (type === 'TechArticle') expect([self?.['headline'], self?.['name']], path).toEqual([first(p, 'h1')?.text(), undefined]);
      else expect([self?.['name'], self?.['headline']], path).toEqual([title, undefined]);
      expect(DOC_PAGES.map((each) => each.en.schema)).toEqual(['TechArticle', 'TechArticle', 'TechArticle', 'WebPage']);
      for (const each of DOC_PAGES) expect(each['zh-TW'].schema).toBe(each.en.schema);
      // When it last changed: the same moment the sitemap gives, or none in both (a home page's block is written
      // by hand and carries no date).
      const entry = sitemap.split('<url>').find((each) => each.includes(`<loc>${url}</loc>`)) ?? '';
      expect(self?.['dateModified'], path).toBe(isHome(path) ? undefined : /<lastmod>([^<]*)<\/lastmod>/.exec(entry)?.[1]);
      // No fact that is not on the page: no author, no publisher, no day of publication, no rating.
      expect(Object.keys(self ?? {}).filter((key) => !['@type', '@id', 'url', 'name', 'headline', 'description', 'inLanguage', 'dateModified', 'isPartOf'].includes(key)), path).toEqual([]);
      // And no software node anywhere: the search result that type is for asks for a rating or a review, smurg has
      // none and none is made up, and Search Console reports a node without one as not valid. So the blocks hold
      // no price, no offer, no rating and no review.
      expect(JSON.stringify(data), path).not.toMatch(/SoftwareApplication|"offers"|"price"|aggregateRating|"review"/);

      if (isHome(path)) {
        // The site and the page. The site's name is what a search result may show over the address, the same on
        // both home pages. Its second name is its address, as the preview pictures write it, and the repository is
        // the same thing elsewhere: a search engine that takes "smurg" for a misspelling of another word learns
        // from the three that it is a name.
        expect(graph.map((node) => node['@type']), path).toEqual(['WebSite', 'WebPage']);
        expect(graph[0], path).toEqual({ ...site, alternateName: 'smurg.ai', sameAs: REPOSITORY, inLanguage: ['en', 'zh-Hant-TW'] });
        // Written by hand in the page, as the build would write it for the page's title and description: when
        // this fails after a title or a description changed, the expected line is the one to paste.
        const line = p.byTag('script').find((s) => s.attr('type') === DATA_BLOCK);
        expect(`<script type="${DATA_BLOCK}">${rawText(line as El)}</script>`, path).toBe(homeStructuredData(lang, title, description ?? ''));
      } else {
        // Where the page is in the site: the home page, the docs (but for the docs index itself), the page. Each
        // step is a page of the same language by its canonical address and by the name its link has; the last
        // step is the page, by its name in the docs navigation, and has no address.
        expect(graph.map((node) => node['@type']), path).toEqual([type, 'BreadcrumbList']);
        const steps = (graph[1]?.['itemListElement'] ?? []) as Node[];
        const expected: Node[] = [{ '@type': 'ListItem', position: 1, name: 'smurg', item: `${ORIGIN}${homePage(lang)}` }];
        if (!index) expected.push({ '@type': 'ListItem', position: 2, name: CHROME[lang].docs, item: `${ORIGIN}${docsIndex(lang)}` });
        expected.push({ '@type': 'ListItem', position: expected.length + 1, name: index ? CHROME[lang].docs : doc?.[lang].label });
        expect(steps, path).toEqual(expected);
        expect(p.elements.find((el) => el.attr('class') === 'doc-nav' && el.tag === 'nav'), path).toBeDefined();
        expect(p.byTag('a').filter((a) => a.attr('aria-current') === 'page' && a.parents.some((el) => el.attr('class') === 'doc-nav')).map((a) => a.text()), path).toEqual([index ? CHROME[lang].docsOverview : doc?.[lang].label]);
      }

      // Every address in the block is the vocabulary's name, a page or a file of this site, or the repository; and
      // no string is a version number (the generated pages show none in their titles and descriptions either).
      for (const text of stringsIn(data)) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
          const address = new URL(text);
          if (text === DATA_CONTEXT || text === REPOSITORY) continue;
          expect(address.origin, `${path}: ${text}`).toBe(ORIGIN);
          expect(servedPage(address.pathname), `${path}: ${text}`).toBeDefined();
        }
        expect(text, path).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
        expect(text, path).not.toMatch(/rating|review count|stars?\b/i);
      }
    }
    // 2 home pages, 2 docs indexes, 8 documents.
    expect(blocks).toBe(12);
  });

  it('the drawn icons are the mark of favicon.svg: an .ico of 16, 32 and 48 px with its rounded corners, and a touch icon of 180 px on a full square', () => {
    const svg = readPublic('favicon.svg');
    // The colour of the mark's background, as the SVG writes it.
    const hex = /<rect width="32" height="32" rx="8" fill="#([0-9a-f]{6})"\/>/.exec(svg)?.[1] ?? '';
    const colour = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    expect(colour.every((channel) => Number.isInteger(channel))).toBe(true);
    const site = testSite().files;

    // favicon.ico: an icon file with one PNG per size, each the mark with transparent corners.
    const ico = site.get('favicon.ico') as Buffer;
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, FAVICON_SIZES.length]);
    expect([...FAVICON_SIZES]).toEqual([16, 32, 48]);
    let end = 6 + 16 * FAVICON_SIZES.length;
    FAVICON_SIZES.forEach((size, index) => {
      const entry = ico.subarray(6 + 16 * index, 22 + 16 * index);
      expect([entry.readUInt8(0), entry.readUInt8(1), entry.readUInt16LE(4), entry.readUInt16LE(6)], `${size}`).toEqual([size, size, 1, 32]);
      // The pictures follow each other with nothing between or after them.
      expect(entry.readUInt32LE(12), `${size}`).toBe(end);
      end += entry.readUInt32LE(8);
      const picture = decodePng(ico.subarray(entry.readUInt32LE(12), end));
      expect([picture.width, picture.height], `${size}`).toEqual([size, size]);
      for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]] as const) expect(picture.pixel(x, y)[3], `${size}: corner ${x},${y}`).toBe(0);
      // The top edge's middle is the background; the middle of the mark's square (11, 16 of 32) is white.
      expect(picture.pixel(size / 2, 1), `${size}`).toEqual([...colour, 255]);
      expect(picture.pixel(Math.round((11 / 32) * size), size / 2), `${size}`).toEqual([255, 255, 255, 255]);
    });
    expect(end).toBe(ico.length);

    // The touch icon: the same mark on a square without rounded corners, opaque everywhere (a phone rounds the
    // corners itself and shows black where a picture is transparent).
    expect(squareIcon(svg)).toBe(svg.replace(' rx="8" fill=', ' fill='));
    expect(squareIcon(svg)).not.toBe(svg);
    const touch = decodePng(site.get('apple-touch-icon.png') as Buffer);
    expect([touch.width, touch.height, TOUCH_ICON_SIZE]).toEqual([180, 180, 180]);
    for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179], [90, 1]] as const) expect(touch.pixel(x, y), `${x},${y}`).toEqual([...colour, 255]);
    expect(touch.pixel(Math.round((11 / 32) * 180), 90)).toEqual([255, 255, 255, 255]);
    for (let y = 0; y < 180; y += 7) for (let x = 0; x < 180; x += 7) expect(touch.pixel(x, y)[3]).toBe(255);
  });

  it('_headers lets other sites show the pictures and the icons, keeps the notices and llms.txt out of search results, and _redirects sends /zh-tw to /zh-TW', () => {
    const headers = readPublic('_headers');
    /** The header lines under a path's own rule. */
    const rule = (path: string): string[] => (new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n((?:[ \\t]+.+\\n)+)`, 'm').exec(headers)?.[1] ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const path of [...SOCIAL_CARDS, ...DRAWN_ICONS, 'favicon.svg']) {
      expect(rule(`/${path}`), path).toEqual(['! Cross-Origin-Resource-Policy', 'Cross-Origin-Resource-Policy: cross-origin', 'Cache-Control: public, max-age=86400']);
    }
    // Only pictures: no page, script or stylesheet is given to other origins.
    expect([...headers.matchAll(/^(\/\S+)\n(?:[ \t]+.+\n)*?[ \t]+Cross-Origin-Resource-Policy: cross-origin/gm)].map((match) => match[1]).sort()).toEqual([...SOCIAL_CARDS, ...DRAWN_ICONS, 'favicon.svg'].map((path) => `/${path}`).sort());
    // The two texts that ask not to be listed: the notices, and llms.txt, which assistants ask for by its name (a
    // page that must not be found says so in its own <meta>: the 404s). No page is under such a rule.
    for (const path of [NOTICES_FILE, LLMS_FILE]) expect(rule(path), path).toEqual(['Cache-Control: public, max-age=3600', 'X-Robots-Tag: noindex']);
    expect([...headers.matchAll(/^(\/\S+)\n(?:[ \t]+.+\n)*?[ \t]+X-Robots-Tag: /gm)].map((match) => match[1]).sort()).toEqual([LLMS_FILE, NOTICES_FILE].sort());
    expect(headers.match(/X-Robots-Tag/g)).toHaveLength(2);
    // _redirects: the lower-case spelling of the Chinese pages' prefix, with and without more of a path, for good.
    const redirects = readPublic('_redirects').split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    expect(redirects).toEqual(['/zh-tw /zh-TW/ 301', '/zh-tw/* /zh-TW/:splat 301']);
    // Neither is a path of the site or one of the Worker's.
    expect(servedPage('/zh-tw/')).toBeUndefined();
    expect(REDIRECTS.has('/zh-tw')).toBe(false);
  });

  it('/llms.txt says what smurg is in the guides’ words, then lists every document with its address and its line of the docs index, and the Chinese pages', () => {
    const text = siteText(LLMS_FILE.slice(1));
    const lines = text.split('\n');
    // The convention of llmstxt.org: a title, a quoted summary, then sections of links.
    expect(lines.slice(0, 4)).toEqual(['# smurg', '', `> ${LLMS_SUMMARY}`, '']);
    expect(lines.filter((line) => line.startsWith('#'))).toEqual(['# smurg', '## Docs', '## Docs in Traditional Chinese (繁體中文)', '## Optional']);
    // What it is, in three lines: the summary and two lines of what an assistant must not get wrong.
    expect(LLMS_FACTS).toHaveLength(2);
    expect(lines.slice(4, 8)).toEqual([LLMS_FACTS[0], '', LLMS_FACTS[1], '']);
    const section = (heading: string): string[] => {
      const from = lines.indexOf(heading);
      const rest = lines.slice(from + 1);
      const to = rest.findIndex((line) => line.startsWith('#'));
      return rest.slice(0, to === -1 ? rest.length : to).filter((line) => line !== '');
    };
    // Every document, in the order of the docs index, with its line there.
    expect(section('## Docs')).toEqual(DOC_PAGES.map((doc) => `- [${doc.en.label}](${ORIGIN}${doc.en.path}): ${doc.en.summary}`));
    const cards = page(fileOf(docsIndex('en'))).elements.filter((el) => el.tag === 'li' && el.parents.at(-1)?.attr('class') === 'doc-cards');
    expect(cards.map((card) => card.children().map((child) => child.text()))).toEqual(DOC_PAGES.map((doc) => [doc.en.label, doc.en.summary]));
    // The Chinese pages, each by its own name, with the English name of what it is.
    expect(section('## Docs in Traditional Chinese (繁體中文)')).toEqual(DOC_PAGES.map((doc) => `- [${doc['zh-TW'].label}](${ORIGIN}${doc['zh-TW'].path}): ${doc.en.label}`));
    expect(section('## Optional')).toEqual([`- [Source code](${REPOSITORY}): the repository on GitHub`, `- [License](${ORIGIN}/license/): the MIT License, in full`]);
    // Every address is a page of the site or the repository.
    const addresses = [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] as string);
    expect(addresses).toHaveLength(2 * DOC_PAGES.length + 2);
    for (const address of addresses) expect(address === REPOSITORY || (address.startsWith(`${ORIGIN}/`) && servedPage(address.slice(ORIGIN.length)) !== undefined), address).toBe(true);
    // English, but for the Chinese pages' names; no version number; and nothing the site may not say.
    const cjk = /[　-〿一-鿿＀-￯]/;
    for (const line of lines) if (cjk.test(line)) expect(line.replace(/^- \[[^\]]+\]/, '').replace('(繁體中文)', ''), line).not.toMatch(cjk);
    expect(text).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
    expect(text).not.toMatch(RETIRED_CLAIMS);
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);

    // The three lines say what the guides say. Read as a reader reads the built pages, each phrase where it is said:
    const said = (doc: (typeof DOC_PAGES)[number]): string => (first(page(fileOf(doc.en.path)), 'main')?.text() ?? '').replace(/\s+/g, ' ');
    const told = [LLMS_SUMMARY, ...LLMS_FACTS].join(' ').replace(/’/g, "'");
    // … who shares and who joins, and what they do together (the quick start's first lines and step 4);
    expect(told).toContain('a host shares a project folder from their own computer, and teammates join in a browser');
    expect(said(QUICK_START)).toContain('you share a project folder from your own computer, a teammate joins in a browser');
    expect(told).toContain("vote on its questions and review what the agents build");
    expect(said(QUICK_START)).toContain("vote on the agent's questions and review results");
    // … what each side needs (the quick start's two points);
    expect(told).toContain('The host needs macOS or Linux with Claude Code; teammates install nothing and join in Chrome.');
    expect(said(QUICK_START)).toContain('need macOS or Linux, Claude Code installed and logged in');
    expect(said(QUICK_START)).toContain('Teammates install nothing.');
    // … what the relay cannot see (the teammates' guide's introduction);
    expect(told).toContain("end-to-end encrypted: the relay in between cannot see files, conversations or commands");
    expect(said(TEAM_GUIDE)).toContain('end-to-end encrypted: the server in between (the relay) cannot see file contents, conversations, terminal output or commands');
    // … how agents run (the quick start's box), and what the flow was verified with (the README's status line,
    //     which the test of the guides, above, holds too).
    expect(told).toContain("they run as the host, with no sandbox, on the host's Claude account");
    expect(said(QUICK_START)).toContain('they run on your computer as you, with no sandbox, on your Claude account');
    expect(told).toContain('smurg is a prototype; its topics flow was verified against a scripted stand-in for the model, not with a real Claude account.');
    expect(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8').replace(/\n> /g, '\n').replace(/\s+/g, ' ')).toContain('**Status: prototype.**');
    expect(said(QUICK_START)).toContain('verified against a scripted stand-in for the model, not with a real Claude account');
    expect(told).toContain('Open source (MIT).');
  });
});
