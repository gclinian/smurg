// The moving picture at the top of the two READMEs (.github/assets/readme-picture-*.svg) is a drawing of the product
// page's picture, made by scripts/readme-picture.ts. A second drawing drifts from the first without a word unless
// something holds it, so this lint does:
//
//   - the committed files are what the script writes now, byte for byte: a changed scene, word or colour of the
//     product page fails here until the pictures are drawn again;
//   - every text of a picture is a text of the product page's picture in the same language (which
//     docs-quotes.test.ts holds to the app's catalogs), and its description is that page's own;
//   - a file is what GitHub will show through <img>: small, well-formed, with no script, no outside file and
//     nothing that links anywhere. It plays wherever CSS animation does (the motion is inside no media query), it
//     stops moving things about when the reader asked for less motion, and its stage is never empty: nobody can
//     pause a picture in a README, so one scene fades into the next.
import { describe, expect, it } from 'vitest';
import { NARROW, PICTURE_DIR, PICTURES, SITE_PAGE, SITE_STYLE, build, pictureLabel, siteColours, widthKey, type PictureLang } from '../../scripts/readme-picture.ts';
import { flat } from './guides.ts';
import { CJK, read, repoFiles } from './tree.ts';

/** A README picture is text: this is far above what the four weigh, and far below what a recording would. */
const MAX_BYTES = 64_000;

const picture = (file: string): string => read(`${PICTURE_DIR}/${file}`);

/** The text of an element's content: character references undone. */
function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The texts a picture draws, in order. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => unescape(match[1] as string));
}

/**
 * What is wrong with `xml` as XML, or nothing: every tag closed in order, one root, attributes quoted, no bare `<` or
 * `&`. (No parser is at hand in this folder, and the files are simple enough to be read strictly by rule.)
 */
function malformed(xml: string): string | undefined {
  const open: string[] = [];
  let roots = 0;
  let at = 0;
  for (const match of xml.matchAll(/<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const between = xml.slice(at, match.index);
    if (/[<>]/.test(between) || /&(?!(?:lt|gt|amp|quot|#39);)/.test(between)) return `stray markup before offset ${match.index}: ${between.trim().slice(0, 40)}`;
    if (open.length === 0 && between.trim() !== '') return `text outside the root before offset ${match.index}`;
    at = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match as unknown as [string, string, string, string, string];
    if (/&(?!(?:lt|gt|amp|quot|#39);)/.test(attributes)) return `a bare & in an attribute of <${name}>`;
    if (closing === '/') {
      if (open.pop() !== name) return `</${name}> closes nothing`;
    } else if (selfClosing !== '/') {
      if (open.length === 0) roots += 1;
      open.push(name);
    } else if (open.length === 0) roots += 1;
  }
  if (open.length > 0) return `<${open.at(-1) as string}> is never closed`;
  if (xml.slice(at).trim() !== '') return 'something follows the root';
  return roots === 1 ? undefined : `${roots} roots`;
}

/** The text of the product page's picture: the strip of its parts and the window, tags dropped. */
function pagePicture(lang: PictureLang): string {
  const figure = /<figure class="demo"[^>]*>([\s\S]*?)<figcaption\b/.exec(read(SITE_PAGE[lang]))?.[1];
  if (figure === undefined) throw new Error(`${SITE_PAGE[lang]} has no <figure class="demo"> with a <figcaption>`);
  return flat(unescape(figure.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')));
}

describe('the README picture is what scripts/readme-picture.ts writes', () => {
  it('the four pictures exist, one per theme and language, and nothing else of the kind is committed', () => {
    const committed = repoFiles().filter((path) => path.startsWith(`${PICTURE_DIR}/readme-picture`));
    expect(committed.sort()).toEqual(PICTURES.map((entry) => `${PICTURE_DIR}/${entry.file}`).sort());
    expect(PICTURES.map((entry) => `${entry.lang} ${entry.theme}`).sort()).toEqual(['en dark', 'en light', 'zh-TW dark', 'zh-TW light']);
    // A picture with Chinese words says so in its name (no-cjk.test.ts lets exactly those hold Chinese).
    for (const entry of PICTURES) expect(entry.file.endsWith('.zh-TW.svg'), entry.file).toBe(entry.lang === 'zh-TW');
  });

  it.each(PICTURES)('$file is byte for byte what the script writes from the product page today (else: node scripts/readme-picture.ts)', (entry) => {
    expect(picture(entry.file) === build(entry), `${entry.file} is stale: run  node scripts/readme-picture.ts  and commit the pictures`).toBe(true);
  });

  it('the colours are the product page\'s tokens, and a stylesheet without one stops the script instead of drawing in a colour of its own', () => {
    const css = read(SITE_STYLE);
    const colours = siteColours(css);
    expect(colours.light.surface).toBe('#ffffff');
    expect(colours.light.accent).not.toBe(colours.dark.accent);
    for (const theme of ['light', 'dark'] as const) {
      const svg = picture(PICTURES.find((entry) => entry.theme === theme && entry.lang === 'en')?.file as string);
      // Every colour the file names is one of the page's, white or black.
      const allowed = new Set(['#fff', '#000', ...Object.values(colours[theme]).flatMap((value) => (typeof value === 'string' ? [value] : 'color' in value ? [value.color] : Object.values(value)))]);
      const named = new Set([...svg.matchAll(/#[0-9a-f]{3,8}\b/g)].map((match) => match[0]));
      expect([...named].filter((colour) => !allowed.has(colour))).toEqual([]);
      expect(named.size).toBeGreaterThan(12);
    }
    expect(() => siteColours(css.replace('--warn:', '--warning:'))).toThrow(/no --warn/);
    expect(() => siteColours(css.replace(/--accent-soft: rgb\([^)]*\)/, '--accent-soft: #1d4ed8'))).toThrow(/not rgb\(r g b \/ a\)/);
    expect(() => build({ theme: 'light', lang: 'en', css: css.replace('--claude:', '--agent:') })).toThrow(/no --claude/);
  });

  it('every text has a measured width, and the widths files hold exactly the texts the pictures draw', () => {
    const asked = new Set<string>();
    for (const lang of ['en', 'zh-TW'] as const) build({ theme: 'light', lang, collect: asked });
    const plain = Object.keys(JSON.parse(read('scripts/readme-picture/widths.json')) as Record<string, number>);
    const chinese = Object.keys(JSON.parse(read('scripts/readme-picture/widths.zh-TW.json')) as Record<string, number>);
    expect([...plain, ...chinese].sort()).toEqual([...asked].sort());
    // A text that holds Chinese is measured into the zh-TW file, and only such a text.
    expect(plain.filter((key) => CJK.test(key))).toEqual([]);
    expect(chinese.filter((key) => !CJK.test(key))).toEqual([]);
    expect(asked.has(widthKey('Decide', 15, 500, false))).toBe(true);
    for (const entry of PICTURES) {
      const svg = picture(entry.file);
      const drawn = svg.match(/<text\b[^>]*>/g) ?? [];
      expect(drawn.length).toBeGreaterThan(150);
      // Placed by its left end and fitted to its measured width: no browser has to agree on anchors or on a font.
      for (const tag of drawn) expect(tag, entry.file).toMatch(/ textLength="[\d.]+" lengthAdjust="spacingAndGlyphs"/);
      expect(svg).not.toContain('text-anchor');
    }
  });
});

describe('the README picture says what the product page\'s picture says', () => {
  it.each(PICTURES)('$file: every text is a text of the page\'s picture in its language', (entry) => {
    const page = pagePicture(entry.lang);
    const drawn = [...new Set(texts(picture(entry.file)))];
    expect(drawn.filter((text) => !page.includes(flat(text)))).toEqual([]);
    expect(drawn.length).toBeGreaterThan(55);
    // The four parts of the story, in the page's order.
    const parts = [...read(SITE_PAGE[entry.lang]).matchAll(/<span class="tab-n">\d<\/span><span>([^<]+)<\/span>/g)].map((match) => match[1] as string);
    expect(parts).toHaveLength(4);
    expect(drawn.filter((text) => parts.includes(text))).toEqual(parts);
  });

  it.each(PICTURES)('$file: its description is the page\'s own description of its picture, and its language is named', (entry) => {
    const svg = picture(entry.file);
    const label = /^<svg [^>]*aria-label="([^"]+)"/.exec(svg)?.[1];
    expect(unescape(label ?? '')).toBe(pictureLabel(entry.lang));
    expect(pictureLabel(entry.lang).length).toBeGreaterThan(100);
    expect(svg).toMatch(entry.lang === 'en' ? /^<svg [^>]* lang="en" / : /^<svg [^>]* lang="zh-Hant-TW" /);
    expect(CJK.test(svg)).toBe(entry.lang === 'zh-TW');
  });

  it('the pictures show nothing the page does not: no command runs without having been asked for', () => {
    for (const entry of PICTURES) {
      const drawn = texts(picture(entry.file));
      // The one command an agent runs is the one a person allowed; the report names the tests, it does not run them on screen.
      expect(drawn.filter((text) => text === 'pnpm add stripe').length, entry.file).toBeGreaterThanOrEqual(2);
      expect(drawn.some((text) => /^(?:Ran|執行)$/.test(text)), entry.file).toBe(false);
    }
  });
});

describe('a README picture is a file GitHub can show through <img>', () => {
  it.each(PICTURES)('$file is small, well-formed, one element or rule a line, and holds no script, no outside file and no link', (entry) => {
    const svg = picture(entry.file);
    expect(Buffer.byteLength(svg)).toBeLessThan(MAX_BYTES);
    expect(malformed(svg)).toBeUndefined();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 830 480" width="830" height="480" role="img" /);
    // A changed word is a changed line, not a changed file.
    const lines = svg.split('\n');
    expect(lines.length).toBeGreaterThan(800);
    expect(Math.max(...lines.slice(1).map((line) => line.length))).toBeLessThan(700);
    expect(svg).not.toMatch(/<(?:script|image|foreignObject|a|iframe|object|embed|audio|video|animate|set)\b/i);
    expect(svg).not.toMatch(/\bon[a-z]+\s*=|javascript:|@import|@font-face|url\(|xlink:|<!|<\?/i);
    // Nothing points outside the file: the one address is the namespace, and every reference is to a symbol of the file.
    expect((svg.match(/https?:\/\/[^\s"')]+/g) ?? []).filter((address) => address !== 'http://www.w3.org/2000/svg')).toEqual([]);
    const references = [...svg.matchAll(/\bhref="([^"]*)"/g)].map((match) => match[1] as string);
    expect(references.length).toBeGreaterThan(5);
    for (const reference of references) expect(svg, reference).toContain(`<symbol id="${reference.replace(/^#/, '')}"`);
    expect(references.every((reference) => reference.startsWith('#'))).toBe(true);
  });

  it.each(PICTURES)('$file plays wherever CSS animation does, moves nothing about for a reader who asked for less, and holds a drawing for a phone', (entry) => {
    const svg = picture(entry.file);
    const style = /<style>\n([\s\S]*?)\n<\/style>/.exec(svg)?.[1] ?? '';
    const moving = style.indexOf('\n.a{animation:');
    const reduced = style.indexOf('\n@media (prefers-reduced-motion:reduce){\n');
    expect(moving).toBeGreaterThan(0);
    expect(reduced).toBeGreaterThan(moving);
    // The file asks two things of its viewer: how wide it is shown, and whether the reader wants less motion. The
    // motion itself is inside neither: a viewer that answers no such question inside an image still plays it.
    expect(style.match(/@media [^{]*/g)).toEqual([`@media (max-width:${NARROW}px)`, '@media (prefers-reduced-motion:reduce)']);
    expect(style.slice(style.indexOf('@media (max-width:'), moving)).toMatch(/^@media \(max-width:\d+px\)\{\n\.W\{display:none\}\n\.N\{display:inline\}\n\}\n/);
    // Before the motion nothing is animated: a viewer that plays nothing shows the first scene, finished.
    expect(style.slice(0, moving)).not.toMatch(/animation|@keyframes/);
    // With reduced motion everything that moves is stopped first; then only opacity changes, and only for the four
    // scenes and their parts of the strip.
    const calm = style.slice(reduced);
    expect(calm).toMatch(/^\n@media \(prefers-reduced-motion:reduce\)\{\n\.a,\.d\{animation:none\}\n\.r0,\.r1,\.r2,\.r3\{animation:\d+s linear infinite\}\n/);
    expect(calm).not.toMatch(/transform/);
    expect(calm.match(/@keyframes r\d/g)).toEqual(['@keyframes r0', '@keyframes r1', '@keyframes r2', '@keyframes r3']);
    expect(calm).not.toMatch(/\.a\{|\.k[0-9a-z]+\{/);
    // The two drawings: the wide one, and the one for a column of a phone's width.
    expect(style).toContain(`@media (max-width:${NARROW}px){\n.W{display:none}\n.N{display:inline}\n}`);
    expect(svg).toMatch(/<g class="W">[\s\S]+<g class="N">\n<g transform="scale\(2\)">/);
  });

  it.each(PICTURES)('$file never shows an empty stage: at every moment of the loop a scene is there, and a part of the strip is on', (entry) => {
    const svg = picture(entry.file);
    const style = /<style>\n([\s\S]*?)\n<\/style>/.exec(svg)?.[1] ?? '';
    // Nobody can stop the picture, so a scene lasts long enough to read what it leaves.
    expect(Number(/\n\.a\{animation:(\d+)s linear infinite\}\n/.exec(style)?.[1])).toBeGreaterThanOrEqual(24);
    /** How much the part with the keyframes `name` shows (0 to 1) at a share of the loop (0 to 100): evenly between two stops. */
    const shows = (name: string, share: number): number => {
      const body = new RegExp(`\\n@keyframes ${name}\\{(.*)\\}\\n`).exec(style)?.[1] ?? '';
      const stops = [...body.matchAll(/([\d.,%]+)\{([^}]*)\}/g)]
        .flatMap((rule) => (rule[1] as string).split(',').map((at) => [Number(at.replace('%', '')), Number(/opacity:([\d.]+)/.exec(rule[2] as string)?.[1])] as const))
        .sort((a, b) => a[0] - b[0]);
      expect(stops.length, name).toBeGreaterThanOrEqual(4);
      expect([stops[0]?.[0], stops.at(-1)?.[0]], name).toEqual([0, 100]);
      const next = Math.max(stops.findIndex(([at]) => at >= share), 1);
      const [from, to] = [stops[next - 1], stops[next]] as [readonly [number, number], readonly [number, number]];
      return to[0] === from[0] ? to[1] : from[1] + ((to[1] - from[1]) * (share - from[0])) / (to[0] - from[0]);
    };
    // The four scenes (both drawings play them by the same keyframes) and the four lit parts of the strip.
    const scenes = new Map([...svg.matchAll(/<g class="sc a (k[0-9a-z]+) r(\d)">/g)].map((match) => [match[2] as string, match[1] as string]));
    const parts = new Map([...svg.matchAll(/<rect [^>]*class="tb a (k[0-9a-z]+) r(\d)"/g)].map((match) => [match[2] as string, match[1] as string]));
    expect(svg.match(/<g class="sc a /g)).toHaveLength(8);
    expect([...scenes.keys()].sort()).toEqual(['0', '1', '2', '3']);
    expect([...parts.keys()].sort()).toEqual(['0', '1', '2', '3']);
    for (let share = 0; share <= 100; share += 0.125) {
      // (where one goes and the next comes, the two together are there as much as one alone)
      expect([...scenes.values()].reduce((sum, name) => sum + shows(name, share), 0), `the scenes at ${share}% of the loop`).toBeGreaterThan(0.99);
      expect([...parts.values()].reduce((sum, name) => sum + shows(name, share), 0), `the strip at ${share}% of the loop`).toBeGreaterThan(0.99);
    }
  });
});
