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
import { CHROME, DOC_PAGES, HTML_LANG, LANGS, NOTICES_FILE, ORIGIN, SOCIAL_CARD, SOCIAL_CARD_SIZE, WEB_APP_NOTICES, docsIndex, homePage, licensePage, otherLang, pagePairs, socialCardMeta, type Lang } from '../scripts/site.ts';
import { FIXTURE_NOTICES, PUBLIC, REPO_ROOT, parsePage, publicFiles, rawText, readPublic, sitePages, siteText, testSite, type El, type Page } from './html.ts';

const HOME_PAGES = { en: 'index.html', 'zh-TW': 'zh-TW/index.html' } as const;
const NOT_FOUND_PAGES = ['404.html', 'zh-TW/404.html'];
/** The preview pictures (og:image): files of public/ that no page loads, read by link previews. */
const SOCIAL_CARDS = LANGS.map((lang) => SOCIAL_CARD[lang].path.slice(1));
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
    expect(GENERATED_PAGES).toHaveLength(12);
    expect(files.filter((path) => !publicFiles().includes(path)).sort()).toEqual([...GENERATED_PAGES, NOTICES_FILE.slice(1), 'sitemap.xml'].sort());
    expect(publicFiles().sort()).toEqual(['404.html', '_headers', 'copy.js', 'demo.js', 'favicon.svg', 'index.html', 'og.png', 'robots.txt', 'style.css', 'zh-TW/404.html', 'zh-TW/index.html', 'zh-TW/og.png'].sort());
    // No 404 page of its own under /docs/: the nearest 404.html is the English one there, the Chinese one under /zh-TW/.
    expect(files).not.toContain('docs/404.html');
    // Generated files are never written into public/ (they live in the gitignored dist/).
    for (const path of GENERATED_PAGES) expect(publicFiles(), path).not.toContain(path);
  });

  it('public/ stays under 160 KB in total (the preview pictures aside), and every page with everything it loads under 176 KB', () => {
    // The preview pictures are not loaded by any page: they have their own bound (the next test).
    const total = publicFiles()
      .filter((path) => !SOCIAL_CARDS.includes(path))
      .reduce((sum, path) => sum + statSync(join(PUBLIC, path)).size, 0);
    expect(total).toBeLessThan(160 * 1024);
    const size = (path: string): number => testSite().files.get(path)?.length ?? Number.NaN;
    for (const path of sitePages()) {
      const loaded = page(path)
        .elements.filter((el) => (el.tag === 'link' && ['stylesheet', 'icon'].includes(el.attr('rel') ?? '')) || el.tag === 'script')
        .map((el) => (el.attr('href') ?? el.attr('src') ?? '').slice(1));
      const bytes = size(path) + loaded.reduce((sum, file) => sum + size(file), 0);
      // The host guide is the longest page (0.5.0: about 98 KB in English; 0.5.1: about 119 KB, since its §9 says
      // what an update carries over, what every refusal of a workspace's state means and how to go back to a folder
      // that was moved away; 0.5.2: about 133 KB, since §8 has one row per reason git stops Start and §10.2 says
      // what happens when the folder becomes a repository while it is shared). The page's bound follows the guide;
      // with the stylesheet (37 KB since the home page's picture moves), the script and the icon it stays under the
      // bound below (150 KB until 0.5.1, 164 KB until 0.5.2).
      expect(size(path), `${path} itself`).toBeLessThan(140 * 1024);
      expect(bytes, `${path} with ${loaded.join(', ')}`).toBeLessThan(176 * 1024);
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
    for (const path of publicFiles().filter((file) => !SOCIAL_CARDS.includes(file))) {
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
    // Files that are not pages are loaded by the pages (style.css, copy.js, favicon.svg) or read by crawlers and link
    // previews (a page names its preview picture in a <meta>, which is no link).
    expect(unreachable.sort()).toEqual([...SOCIAL_CARDS, 'robots.txt', 'sitemap.xml'].sort());
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
    expect(p.byTag('script').map((s) => [s.attr('src'), s.attr('defer')])).toEqual([
      ['/copy.js', ''],
      ['/demo.js', ''],
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
      // label, the title and the descriptions.
      const unseen = p.elements.flatMap((el) => [el.attr('aria-label'), el.tag === 'meta' ? el.attr('content') : undefined, el.tag === 'title' ? el.text() : undefined]).filter((value): value is string => value !== undefined);
      expect(unseen.length, path).toBeGreaterThan(15);
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
    expect(labels.length).toBeGreaterThan(lang === 'en' ? 400 : 150);
    expect(descriptions.length).toBeGreaterThan(100);
    for (const all of [text, titles, labels, descriptions]) {
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
