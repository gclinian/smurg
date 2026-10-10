// Draws the moving picture at the top of the two READMEs: one SVG per theme and language, in .github/assets/.
//
//   node scripts/readme-picture.ts              (re)writes the four pictures
//   node scripts/readme-picture.ts --check      exits 1 when a committed picture is not what this script writes now
//                                               (tests/lint/readme-picture.test.ts holds the same, byte for byte)
//   node scripts/readme-picture.ts --measure    measures every text again and writes scripts/readme-picture/widths*.json
//                                               (headless Chrome ON macOS: SMURG_TEST_CHROME, or Google Chrome)
//   node scripts/readme-picture.ts --sheet DIR  writes into DIR every picture held at twelve moments of the loop, both
//                                               drawings, and index.html that shows them side by side: for looking at a
//                                               change without waiting for the loop (writes nothing else)
//
// Run it after the product page's picture (apps/site/public/index.html, zh-TW/index.html, style.css) changes its
// scenes, its words or its colours, and commit the pictures. After changing a word or a text size here, run
// --measure first.
//
// What the picture is. It is an illustration, and the READMEs say so under it: the story of the product page's own
// picture in the same four scenes (Decide, Plan, Build, Review), with that page's colours (read from its style.css
// when the pictures are written) and its words (the tables below and readme-picture/words.zh-TW.ts; the lint holds
// every text of a picture to the page of its language, and the page is held to the app's catalogs). Nothing is
// shown that the page does not show.
//
// Why an SVG and why like this. GitHub shows a repository's SVG through <img>: CSS animation inside the file runs
// there, script does not, and no other file is fetched. So each picture is shapes and text with keyframes in its own
// <style>: no script, no outside file, no web font, no foreignObject. A file is about 60 KB of text, the same bytes
// on every machine, and a changed word is a changed line.
//
//  - Two drawings share one file. A README column is about 830 px wide on a desktop and about 340 px on a phone, and
//    a picture that is only made smaller is unreadable there. A media query inside an SVG looks at the size the
//    picture is shown at, so the file holds a wide drawing (.W) and a simpler one at twice the size (.N), and shows
//    the one that fits. Where a viewer ignores the query, the wide drawing shows, made smaller.
//  - SVG has no layout: every position is a number here, and what follows a text needs that text's width. The widths
//    are measured, never guessed (--measure; a text without a measured width stops the script). Every text carries
//    its measured width as textLength and is placed by its left end, so a browser whose font is wider or narrower
//    fits the text into the place the drawing gave it instead of running into its neighbour. The layout is the one of
//    macOS's system font: measuring anywhere else would move everything.
//  - Every moving part runs one animation over the whole loop, so all of them share one clock; only opacity and
//    transform change. A part's class carries the state its scene ends with, so where nothing moves (no CSS
//    animation, a still copy of the file) the first scene shows, finished.
//  - The motion is declared outside any media query: a viewer that does not answer a query about the reader's
//    preferences inside an image still plays the picture. Only the rule for a reader who asked for less motion is
//    inside one.
//  - GitHub gives an animated SVG no pause control and no tabs, so the file paces itself: a scene lasts long enough
//    for what a press left behind to be read, and one scene fades into the next while the other fades out, so the
//    stage is never empty and a part of the strip is always on. With reduced motion nothing slides, grows or is
//    pressed and no pointer shows; the four finished scenes follow each other the same way.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZH_TW } from './readme-picture/words.zh-TW.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
/** Where the pictures are committed, from the repository root. */
export const PICTURE_DIR = '.github/assets';
/** The product page's stylesheet: the colours are read from its tokens. */
export const SITE_STYLE = 'apps/site/public/style.css';
const WIDTHS_FILE = 'scripts/readme-picture/widths.json';
/** The widths of the texts that hold Chinese: a file of its own, so that the other holds none (tests/lint/no-cjk.test.ts). */
const WIDTHS_FILE_ZH_TW = 'scripts/readme-picture/widths.zh-TW.json';

export type Theme = 'light' | 'dark';
export type PictureLang = 'en' | 'zh-TW';

/** The pictures, by file name. */
export const PICTURES: readonly { readonly file: string; readonly theme: Theme; readonly lang: PictureLang }[] = [
  { file: 'readme-picture-light.svg', theme: 'light', lang: 'en' },
  { file: 'readme-picture-dark.svg', theme: 'dark', lang: 'en' },
  { file: 'readme-picture-light.zh-TW.svg', theme: 'light', lang: 'zh-TW' },
  { file: 'readme-picture-dark.zh-TW.svg', theme: 'dark', lang: 'zh-TW' },
];

const VW = 830;
const VH = 480;
/**
 * Seconds a scene lasts. What happens in a scene is over about four seconds in; the rest is for reading what it left
 * (an answer, a state, a sentence): nobody can stop the picture to read it.
 */
const SCENE = 6;
const LOOP = 4 * SCENE;
/** Seconds one scene takes to fade into the next: the last of the one that goes, so the two are on the stage together. */
const CROSS = 0.4;
/** Seconds into the Build scene at which the first agent is done and its report waits for a reader. */
const REPORTED = 3.6;
/** At this width (px) or less the simpler drawing shows. */
export const NARROW = 540;

// ------------------------------------------------------------------------------------------------------------ words

/** The words of one language: the product page's picture's own. */
export interface Words {
  /** The language tag of the file's `lang`. */
  readonly lang: string;
  readonly parts: readonly [string, string, string, string];
  readonly topic: string;
  readonly connected: string;
  readonly qFrom: string;
  readonly voted: readonly [string, string, string];
  readonly q: string;
  readonly optA: string;
  readonly optB: string;
  readonly leading: string;
  readonly decides: string;
  readonly submit: string;
  readonly answered: string;
  readonly spec: string;
  readonly plan: string;
  /** The spec's one sentence, on two lines. */
  readonly specLine: readonly [string, string];
  readonly writing: string;
  readonly items: string;
  readonly names: readonly [string, string, string];
  readonly ready: string;
  readonly running: string;
  /** The plan's note, on two lines. */
  readonly note: readonly [string, string];
  readonly start: string;
  readonly started: string;
  readonly toReview: string;
  readonly worktree: string;
  readonly edited: string;
  readonly created: string;
  readonly read: string;
  readonly working: string;
  readonly waitingBadge: string;
  /** The permission request's sentence, on two lines in the wide drawing. */
  readonly perm: readonly [string, string];
  /** What joins the two lines where the sentence is on one (a space in English, nothing in Chinese). */
  readonly permJoin: string;
  readonly allow: string;
  readonly deny: string;
  readonly allowed: string;
  readonly waiting: string;
  readonly report: string;
  readonly whatDone: string;
  readonly doneText: string;
  readonly howVerified: string;
  readonly changes: string;
  readonly reviewBtn: string;
  readonly marked: string;
  readonly reviewed: string;
  readonly reviewedMerged: string;
  readonly merged: string;
}

const EN: Words = {
  lang: 'en',
  parts: ['Decide', 'Plan', 'Build', 'Review'],
  topic: 'Checkout',
  connected: 'Connected',
  qFrom: 'Question from Claude',
  voted: ['1 of 3 voted', '2 of 3 voted', 'All 3 voted'],
  q: 'Where should the cart be kept?',
  optA: 'On the server',
  optB: 'In the browser',
  leading: 'Leading',
  decides: 'Ian decides',
  submit: 'Submit answer',
  answered: 'Answered: On the server',
  spec: 'Spec',
  plan: 'Plan',
  specLine: ['The cart is kept on the server,', 'with the account.'],
  writing: 'Claude is writing the plan…',
  items: '3 work items',
  names: ['Cart API', 'Payments', 'Checkout page'],
  ready: 'Ready to start',
  running: 'Running',
  note: ['Start opens one agent session per item,', 'each in its own worktree.'],
  start: 'Start 3 items',
  started: 'Started 3 items.',
  toReview: 'Report to review',
  worktree: 'Worktree: ',
  edited: 'Edited',
  created: 'Created',
  read: 'Read',
  working: 'Claude is working',
  waitingBadge: 'Waiting for permission',
  perm: ['Claude asks for permission', 'to run a command'],
  permJoin: ' ',
  allow: 'Allow once',
  deny: 'Deny',
  allowed: 'Allowed once by Ben',
  waiting: 'Claude is waiting for permission',
  report: 'Result report: ',
  whatDone: 'What was done',
  doneText: 'The cart is stored on the server, one per account.',
  howVerified: 'How it was verified',
  changes: 'Changes',
  reviewBtn: "I've reviewed this",
  marked: 'Marked as reviewed.',
  reviewed: 'Reviewed',
  reviewedMerged: 'Reviewed · merged',
  merged: 'Merged into the main workspace.',
};

const WORDS: Readonly<Record<PictureLang, Words>> = { en: EN, 'zh-TW': ZH_TW };

/** What a person or an agent wrote in the made-up project, and what is a name: the same in both languages. */
const SAID = {
  specFile: 'SPEC.md',
  planFile: 'PLAN.md',
  url: 'app.smurg.ai',
  word: 'smurg',
  workspace: 'my-app',
  trees: ['checkout-1', 'checkout-2', 'checkout-3'],
  cartApi: 'src/cart/api.ts',
  cartTest: 'tests/cart.test.ts',
  payForm: 'src/pay/form.tsx',
  page: 'src/checkout/page.tsx',
  command: 'pnpm add stripe',
  test: 'pnpm test',
  diffs: ['+38 −6', '+52 −0'],
} as const;

type Person = 'ian' | 'amy' | 'ben';
/** The initials in a person's circle, and whether they are white (the page's .av-* rules: black unless the circle is dark). */
const PEOPLE: Readonly<Record<Person, { readonly initials: string; readonly white: boolean }>> = {
  ian: { initials: 'IA', white: true },
  amy: { initials: 'AM', white: false },
  ben: { initials: 'BE', white: false },
};
/** Who is responsible for which work item, as on the page. */
const RESPONSIBLE: readonly [Person, Person, Person] = ['amy', 'ben', 'ian'];

// Names the system fonts whose widths are close to each other and leaves out `system-ui`, which on Linux may be a much
// wider face; whatever shows, textLength keeps the layout.
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Liberation Sans','PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono','PingFang TC','Microsoft JhengHei',monospace";

// ---------------------------------------------------------------------------------------------------------- colours

/** A colour of the page with its opacity, as an SVG fill needs them. */
interface Soft {
  readonly color: string;
  readonly opacity: string;
}

interface Colours {
  readonly panel: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly text: string;
  readonly muted: string;
  readonly subtle: string;
  readonly accent: string;
  readonly accentSoft: Soft;
  readonly line: string;
  readonly surface: string;
  readonly stage: string;
  readonly raised: string;
  readonly accentSolid: string;
  readonly ok: string;
  readonly okSoft: Soft;
  readonly warn: string;
  readonly people: Readonly<Record<Person, string>>;
  readonly claude: string;
}

/** The custom properties of a `{ … }` block of the stylesheet. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out.set(match[1] as string, (match[2] as string).replace(/\s+/g, ' ').trim());
  return out;
}

/**
 * The page's colour tokens, light and dark: the first `:root` block of its stylesheet, and the one inside
 * `@media (prefers-color-scheme: dark)` over it. A token that is missing or written in another form stops the script:
 * the picture never falls back to a colour of its own.
 */
export function siteColours(css: string): Readonly<Record<Theme, Colours>> {
  const light = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1];
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
  if (light === undefined || dark === undefined) throw new Error(`${SITE_STYLE}: no :root block, or none inside @media (prefers-color-scheme: dark)`);
  const tokens: Readonly<Record<Theme, Map<string, string>>> = { light: declarations(light), dark: new Map([...declarations(light), ...declarations(dark)]) };
  const colours = (theme: Theme): Colours => {
    const raw = (name: string): string => {
      const value = tokens[theme].get(name);
      if (value === undefined) throw new Error(`${SITE_STYLE}: no --${name} (${theme})`);
      return value;
    };
    const hex = (name: string): string => {
      const value = raw(name);
      if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(`${SITE_STYLE}: --${name} (${theme}) is ${value}, not a #rrggbb colour`);
      return value;
    };
    const soft = (name: string): Soft => {
      const parts = /^rgb\((\d+) (\d+) (\d+) \/ (0?\.\d+)\)$/.exec(raw(name));
      if (parts === null) throw new Error(`${SITE_STYLE}: --${name} (${theme}) is ${raw(name)}, not rgb(r g b / a)`);
      const color = `#${[parts[1], parts[2], parts[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
      return { color, opacity: String(Number(parts[4])) };
    };
    return {
      panel: hex('panel'),
      border: hex('border'),
      borderStrong: hex('border-strong'),
      text: hex('text'),
      muted: hex('muted'),
      subtle: hex('subtle'),
      accent: hex('accent'),
      accentSoft: soft('accent-soft'),
      line: hex('line'),
      surface: hex('surface'),
      stage: hex('stage'),
      raised: hex('raised'),
      accentSolid: hex('accent-solid'),
      ok: hex('ok'),
      okSoft: soft('ok-soft'),
      warn: hex('warn'),
      people: { ian: hex('ian'), amy: hex('amy'), ben: hex('ben') },
      claude: hex('claude'),
    };
  };
  return { light: colours('light'), dark: colours('dark') };
}

// ----------------------------------------------------------------------------------------------------------- widths

/**
 * Han, Bopomofo, CJK punctuation and the full-width forms, as tests/lint/tree.ts counts them (built from code points,
 * so that this file holds none of the characters it looks for).
 */
const CJK_RANGES: readonly (readonly [number, number])[] = [[0x3000, 0x303f], [0x3100, 0x312f], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0xff00, 0xffef]];
const CJK = new RegExp(`[${CJK_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`, 'u');

const round2 = (value: number): number => Math.round(value * 100) / 100;
const num = (value: number): string => String(round2(value));

/** A text in its style: what a measured width belongs to. */
export function widthKey(text: string, size: number, weight: number, mono: boolean): string {
  return `${mono ? 'm' : 's'}${weight}/${num(size)}/${text}`;
}

function readWidths(): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of [WIDTHS_FILE, WIDTHS_FILE_ZH_TW]) {
    for (const [key, width] of Object.entries(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')) as Record<string, number>)) out.set(key, width);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------- drawing

type Attributes = Readonly<Record<string, string | number | undefined>>;

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attributes(values: Attributes): string {
  let out = '';
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    out += ` ${name}="${typeof value === 'number' ? num(value) : escapeXml(value).replace(/"/g, '&quot;')}"`;
  }
  return out;
}

/** One element on one line; an element with elements inside it has each of them on a line of its own. */
function tag(name: string, values: Attributes, body?: string | readonly string[]): string {
  if (body === undefined) return `<${name}${attributes(values)}/>`;
  if (typeof body === 'string') return `<${name}${attributes(values)}>${body}</${name}>`;
  return `<${name}${attributes(values)}>\n${body.join('\n')}\n</${name}>`;
}

interface TextStyle {
  readonly size?: number;
  readonly weight?: 500 | 600 | 700;
  /** A class that fills it: mu (muted), su (subtle), ac (accent), ok, wh (white), bk (black). */
  readonly fill?: string;
  /** Where `x` is: the text's left end (the default), its middle or its right end. */
  readonly anchor?: 'middle' | 'end';
  readonly mono?: boolean;
  /** More classes (an animation's). */
  readonly cls?: string;
}

/** Seconds of the loop and the declarations that hold from then on. */
type Stop = readonly [number, string];

export interface BuildOptions {
  readonly theme: Theme;
  readonly lang: PictureLang;
  /** The stylesheet to read the colours from (the default: the product page's, as committed). */
  readonly css?: string;
  /** Holds every animation at this second of the loop instead of playing (a frame of --sheet). */
  readonly freeze?: number;
  /** Shows this drawing whatever the width (--sheet). */
  readonly layout?: 'wide' | 'narrow';
  /** Collects the texts instead of needing their widths: every key the drawing asks for is added here. */
  readonly collect?: Set<string>;
}

let measured: Map<string, number> | undefined;

/** One picture, as the text of its file. */
export function build(options: BuildOptions): string {
  const { theme, lang, freeze, layout, collect } = options;
  const C = siteColours(options.css ?? readFileSync(join(REPO_ROOT, SITE_STYLE), 'utf8'))[theme];
  const L = WORDS[lang];
  if (collect === undefined) measured ??= readWidths();

  const textWidth = (text: string, size: number, weight = 400, mono = false): number => {
    const key = widthKey(text, size, weight, mono);
    if (collect !== undefined) {
      collect.add(key);
      return 0;
    }
    const width = measured?.get(key);
    if (width === undefined) throw new Error(`no measured width for the text ${JSON.stringify(text)} (${key}): run  node scripts/readme-picture.ts --measure  on macOS`);
    return width;
  };

  // ---- the motion: every moving part runs one animation over the whole loop. kf() names the keyframes of a part
  // and returns its classes; `rest` is what shows where nothing moves. ----
  const frames = new Map<string, { name: string; rest: string; body: string }>();
  const percent = (seconds: number): string => `${num((Math.min(Math.max(seconds, 0), LOOP) / LOOP) * 100)}%`;
  /**
   * While this is a second of the loop, a part made by kf() is back where it began from that second on. The parts of
   * the first scene need it: their scene comes in again while the last one goes, before the loop ends, and it must
   * come in as it began, not as it ended. (Every other scene comes in before anything has happened in it.)
   */
  let rewindAt: number | undefined;
  /** When the first scene's parts go back: while the third scene plays. */
  const REWIND = 2 * SCENE;
  const rewound = (stops: readonly Stop[], at: number): readonly Stop[] => {
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined || first[0] !== 0 || last[0] !== LOOP) throw new Error('a part that is rewound says where it is at the start and at the end of the loop');
    // (it goes back in the second before `at`, while its scene does not show)
    return first[1] === last[1] ? stops : [...stops.slice(0, -1), [at - 1, last[1]], [at, first[1]], [LOOP, first[1]]];
  };
  const kf = (rest: string, given: readonly Stop[]): string => {
    const stops = rewindAt === undefined ? given : rewound(given, rewindAt);
    const byDeclaration = new Map<string, string[]>();
    for (const [seconds, declaration] of stops) byDeclaration.set(declaration, [...(byDeclaration.get(declaration) ?? []), percent(seconds)]);
    const body = [...byDeclaration].map(([declaration, at]) => `${[...new Set(at)].join(',')}{${declaration}}`).join('');
    const key = `${rest}|${body}`;
    let frame = frames.get(key);
    if (frame === undefined) {
      frame = { name: `k${frames.size.toString(36)}`, rest, body };
      frames.set(key, frame);
    }
    return `a ${frame.name}`;
  };
  const OFF = 'opacity:0';
  const ON = 'opacity:1';
  const EASE = ';animation-timing-function:ease-out';
  /** Where a pointer sets out from, relative to where it presses. */
  const FROM_BELOW: readonly [number, number] = [34, 30];
  const A = {
    /** comes at t and stays */
    in: (t: number, d = 0.2): string => kf(ON, [[0, OFF], [t, OFF], [t + d, ON], [LOOP, ON]]),
    /** goes at t */
    out: (t: number, d = 0.15): string => kf(OFF, [[0, ON], [t, ON], [t + d, OFF], [LOOP, OFF]]),
    /** there from t1 to t2 */
    span: (t1: number, t2: number): string => kf(OFF, [[0, OFF], [t1, OFF], [t1 + 0.2, ON], [t2, ON], [t2 + 0.15, OFF], [LOOP, OFF]]),
    /** takes the place of what goes at t: it waits for the other to be gone */
    after: (t: number): string => A.in(t + 0.15),
    between: (t1: number, t2: number): string => A.span(t1 + 0.15, t2),
    rise: (t: number): string => kf(ON, [[0, `${OFF};transform:translateY(8px)`], [t, `${OFF};transform:translateY(8px)${EASE}`], [t + 0.35, `${ON};transform:none`], [LOOP, `${ON};transform:none`]]),
    pop: (t: number): string => `o ${kf(ON, [[0, `${OFF};transform:scale(.4)`], [t, `${OFF};transform:scale(.4)${EASE}`], [t + 0.25, `${ON};transform:scale(1.18)`], [t + 0.45, `${ON};transform:none`], [LOOP, `${ON};transform:none`]])}`,
    draw: (t: number): string => `l ${kf('', [[0, 'transform:scaleX(0)'], [t, `transform:scaleX(0)${EASE}`], [t + 0.4, 'transform:none'], [LOOP, 'transform:none']])}`,
    /** a button, pressed at t */
    press: (t: number): string => `o ${kf('', [[0, 'transform:none'], [t, 'transform:none'], [t + 0.2, 'transform:scale(.93)'], [t + 0.4, 'transform:none'], [LOOP, 'transform:none']])}`,
    /** the pointer of whoever presses: it sets out at t, presses half a second later and goes */
    cursor: (t: number, [dx, dy]: readonly [number, number]): string => {
      const away = `transform:translate(${dx}px,${dy}px)`;
      return kf(OFF, [[0, `${OFF};${away}`], [t, `${OFF};${away}${EASE}`], [t + 0.2, ON], [t + 0.5, `${ON};transform:none`], [t + 0.65, `${ON};transform:scale(.84)`], [t + 0.8, `${ON};transform:none`], [t + 1.1, `${OFF};transform:none`], [LOOP, `${OFF};transform:none`]]);
    },
    /**
     * a scene: it shows for its part of the loop. It goes during its last CROSS seconds, and the next one comes in
     * during the same seconds (the first one while the last one goes, at the end of the loop). `sc` only names it
     * (the lint finds the scenes by it and holds that one is on the stage at every moment).
     */
    scene: (i: number): string => {
      const start = i * SCENE;
      const end = start + SCENE;
      const shown = `${ON};transform:none`;
      const gone = `${OFF};transform:none`;
      const coming = `${OFF};transform:translateY(6px)${EASE}`;
      const stops: Stop[] = i === 0 ? [[0, shown], [end - CROSS, shown], [end, gone], [LOOP - CROSS, coming], [LOOP, shown]] : [[0, gone], [start - CROSS, coming], [start, shown], [end - CROSS, shown], [end, gone]];
      if (i > 0 && end < LOOP) stops.push([LOOP, gone]);
      return `sc ${kf(i === 0 ? ON : OFF, stops)} r${i}`;
    },
    /** the part of the strip that is on: it changes with the scenes, so one is on at every moment */
    part: (i: number): string => {
      const start = i * SCENE;
      const end = start + SCENE;
      const stops: Stop[] = i === 0 ? [[0, ON], [end - CROSS, ON], [end, OFF], [LOOP - CROSS, OFF], [LOOP, ON]] : [[0, OFF], [start - CROSS, OFF], [start, ON], [end - CROSS, ON], [end, OFF]];
      if (i > 0 && end < LOOP) stops.push([LOOP, OFF]);
      return `${kf(i === 0 ? ON : OFF, stops)} r${i}`;
    },
    /** the line that fills while a part's scene plays */
    fill: (i: number): string => {
      const start = i * SCENE;
      const end = start + SCENE;
      const stops: Stop[] = [[start, `${ON};transform:scaleX(0)`], [end - CROSS, `${ON};transform:none`], [end, `${OFF};transform:none`]];
      if (start > 0) stops.unshift([0, `${OFF};transform:scaleX(0)`], [start - 0.05, `${OFF};transform:scaleX(0)`]);
      if (end < LOOP) stops.push([LOOP, `${OFF};transform:none`]);
      return `l ${kf(i === 0 ? '' : OFF, stops)} r${i}`;
    },
  };

  // ---- the parts every scene is made of (the simpler drawing uses the same parts at about half the numbers, inside
  // a group that doubles them) ----
  const text = (x: number, y: number, content: string, style: TextStyle = {}): string => {
    const size = style.size ?? 14;
    const width = textWidth(content, size, style.weight ?? 400, style.mono ?? false);
    const classes = [style.mono === true ? 'mo' : '', style.weight === undefined ? '' : `w${style.weight / 100}`, style.fill ?? '', style.cls ?? ''].filter((name) => name !== '').join(' ');
    // Placed by its left end whatever the anchor: the width is known, and textLength with text-anchor is one more thing
    // a browser could do its own way.
    const left = style.anchor === 'end' ? x - width : style.anchor === 'middle' ? x - width / 2 : x;
    return tag('text', { x: left, y, 'font-size': size === 14 ? undefined : size, class: classes, textLength: Math.round(width * 10) / 10, lengthAdjust: 'spacingAndGlyphs' }, escapeXml(content));
  };
  const rect = (x: number, y: number, width: number, height: number, rx: number, cls: string): string => tag('rect', { x, y, width, height, rx: rx === 0 ? undefined : rx, class: cls });
  const line = (x1: number, y: number, x2: number): string => tag('path', { d: `M${num(x1)} ${num(y)}H${num(x2)}`, class: 'ln' });
  const group = (cls: string, body: readonly string[]): string => tag('g', { class: cls }, body);
  /** The same parts, larger about a point (a card that stands alone on the stage). */
  const grown = (factor: number, cx: number, cy: number, body: readonly string[]): string => tag('g', { transform: `translate(${num(cx * (1 - factor))} ${num(cy * (1 - factor))}) scale(${factor})` }, body);
  const avatar = (cx: number, cy: number, r: number, who: Person, cls = ''): string => {
    const size = Math.round(r * 0.87 * 2) / 2;
    return group(cls, [tag('circle', { cx, cy, r, fill: C.people[who] }), text(cx, cy + size * 0.36, PEOPLE[who].initials, { size, weight: 700, anchor: 'middle', fill: PEOPLE[who].white ? 'wh' : 'bk' })]);
  };
  /** Claude's own picture: a rounded square with a small robot. */
  const agent = (x: number, y: number, size: number): string[] => [
    tag('rect', { x, y, width: size, height: size, rx: size * 0.27, fill: C.claude }),
    tag('use', { href: '#i-agent', x: x + size * 0.2, y: y + size * 0.2, width: size * 0.6, height: size * 0.6, class: 'ia' }),
  ];
  type BadgeKind = 'n' | 'run' | 'ok' | 'ask';
  const BADGE_FILL: Readonly<Record<BadgeKind, string>> = { n: 'mu', run: 'ac', ok: 'ok', ask: '' };
  /** A state in a pill, placed by its right end. */
  const badge = (xRight: number, cy: number, label: string, kind: BadgeKind, cls: string, size = 12): string => {
    const width = textWidth(label, size) + size * 1.5;
    const height = size * 1.67;
    return group(cls, [rect(xRight - width, cy - height / 2, width, height, height / 2, `b-${kind}`), text(xRight - width / 2, cy + size * 0.35, label, { size, anchor: 'middle', fill: BADGE_FILL[kind] })]);
  };
  const button = (x: number, y: number, width: number, height: number, label: string, primary: boolean, cls: string, size = 13): string =>
    group(cls, [rect(x, y, width, height, 6, primary ? 'bp' : 'bs'), text(x + width / 2, y + height / 2 + size * 0.35, label, { size, weight: 500, anchor: 'middle', fill: primary ? 'wh' : '' })]);
  const tick = (x: number, cy: number, scale = 1): string => tag('path', { d: `M${num(x)} ${num(cy)}l${num(3 * scale)} ${num(3 * scale)} ${num(5.5 * scale)}-${num(6.5 * scale)}`, class: 'tk', 'stroke-width': num(1.8 * scale) });
  /** What a press leaves behind: a tick and a sentence, from the left. */
  const done = (x: number, cy: number, label: string, cls: string, size = 13): string => group(cls, [tick(x, cy + size * 0.08, size / 13), text(x + size * 1.15, cy + size * 0.35, label, { size, weight: 600, fill: 'ok' })]);
  const doneWidth = (label: string, size = 13): number => size * 1.15 + textWidth(label, size, 600);
  /**
   * A pointer that comes from `from` and presses at (x, y). Its whole way must be inside `box` (the drawing, in the
   * numbers of the place it is drawn in): a pointer that sets out beyond the edge shows cut in half.
   */
  const pointer = (x: number, y: number, t: number, box: readonly [number, number, number, number], scale = 1.25, from: readonly [number, number] = FROM_BELOW): string => {
    const size = 16 * scale;
    // (Where the texts are only being collected nothing has its place yet.)
    for (const [px, py] of collect === undefined ? ([[x, y], [x + from[0], y + from[1]]] as const) : []) {
      if (px < box[0] || py < box[1] || px + size > box[2] || py + size > box[3]) throw new Error(`a pointer at ${num(px)},${num(py)} (pressing at second ${t}) leaves the drawing ${box.map(num).join(' ')}`);
    }
    return tag('g', { transform: `translate(${num(x)} ${num(y)})` }, [tag('use', { href: '#i-cursor', width: size, height: size, class: `cu ${A.cursor(t, from)}` })]);
  };
  const dots = (x: number, cy: number, r = 2): string[] => [0, 1, 2].map((i) => tag('circle', { cx: x + r + i * r * 3.5, cy, r, class: `d d${i}` }));
  /** A command, as a terminal shows it. */
  const term = (x: number, cy: number, command: string, size = 12.5): string[] => [
    rect(x, cy - size * 0.8, textWidth(command, size, 400, true) + size * 1.1, size * 1.6, 4, 'rs'),
    text(x + size * 0.55, cy + size * 0.33, command, { size, mono: true }),
  ];
  /** a document's mark */
  const docMark = (x: number, cy: number, size = 10): string => rect(x + 0.75, cy - size / 2 + 0.75, size - 1.5, size - 1.5, 2, 'dm');

  /** The thread through the scenes: the three work items in the top bar, from plan to merge (seconds of the loop). */
  const chips = (xRight: number, cy: number, unit: number): string => {
    const width = 38 * unit;
    const height = 22 * unit;
    const out: string[] = [];
    [3, 2, 1].forEach((no, i) => {
      const x = xRight - width - i * (width + 5 * unit);
      const dx = x + 27 * unit;
      const r = 4.5 * unit;
      out.push(rect(x, cy - height / 2, width, height, height / 2, 'ch'));
      out.push(text(x + 9 * unit, cy + 4.2 * unit, String(no), { size: round2(12 * unit), fill: 'mu' }));
      out.push(tag('circle', { cx: dx, cy, r: r - 0.75 * unit, class: 'c0', 'stroke-width': num(1.5 * unit) }));
      // started (Plan); the second asks and is allowed, the first is done (Build); reviewed, then merged (Review)
      out.push(tag('circle', { cx: dx, cy, r, class: `c1 ${A.in(SCENE + 3.7)}` }));
      if (no === 2) out.push(rect(dx - r, cy - r, 2 * r, 2 * r, 2 * unit, `c2 ${A.span(2 * SCENE + 0.3, 2 * SCENE + 2.7)}`));
      if (no === 1) {
        out.push(tag('circle', { cx: dx, cy, r, class: `c3 ${A.in(2 * SCENE + REPORTED)}` }));
        out.push(group(A.in(3 * SCENE + 1.9), [tag('circle', { cx: dx, cy, r: r + 1.5 * unit, class: 'c4' }), tick(dx - 4.25 * unit, cy + 0.25 * unit, unit)]));
        out.push(rect(x, cy - height / 2, width, height, height / 2, `chm ${A.in(3 * SCENE + 2.9)}`));
      }
    });
    // They come when the plan has its items, and go with the last scene. At rest the chips say how the story ends, so
    // with reduced motion they show with the last scene only.
    return group(`${kf(OFF, [[0, OFF], [SCENE + 2.2, OFF], [SCENE + 2.4, ON], [LOOP - CROSS, ON], [LOOP, OFF]])} r3`, out);
  };

  // =========================================== the wide drawing ===========================================
  const WIN = { y: 48, chrome: 30, top: 38 };
  /** Where the stage starts, and how high it is. */
  const ST = WIN.y + WIN.chrome + WIN.top;
  const SH = VH - ST;
  const WIDE_BOX = [0, 0, VW, VH] as const;
  /** The drawing's box as a part sees it inside grown(factor, cx, cy, …). */
  const grownBox = (factor: number, cx: number, cy: number): readonly [number, number, number, number] => [cx - cx / factor, cy - cy / factor, cx + (VW - cx) / factor, cy + (VH - cy) / factor];
  const wide: string[] = [];

  // the strip of the four parts
  {
    const widths = L.parts.map((part) => Math.round(textWidth(part, 15, 500) + 46));
    const total = widths.reduce((sum, width) => sum + width, 0) + 3 * 2 + 6;
    let x = Math.round((VW - total) / 2);
    wide.push(rect(x + 0.5, 0.5, total - 1, 39, 12, 'pn'));
    x += 3;
    L.parts.forEach((part, i) => {
      const width = widths[i] as number;
      wide.push(rect(x + 0.5, 3.5, width - 1, 33, 9, `tb ${A.part(i)}`));
      const numberWidth = textWidth(String(i + 1), 12, 400, true);
      const tx = x + (width - numberWidth - 7 - textWidth(part, 15, 500)) / 2;
      wide.push(text(tx, 24.5, String(i + 1), { size: 12, mono: true, fill: 'su' }), text(tx + numberWidth + 7, 25, part, { size: 15, weight: 500 }));
      wide.push(rect(x + 11, 31.5, width - 22, 2, 1, `fl ${A.fill(i)}`));
      x += width + 2;
    });
  }

  // the window: a browser's bar, the app's top bar, the stage
  {
    const y = WIN.y;
    wide.push(rect(0.5, y + 0.5, VW - 1, VH - y - 1, 12, 'win'));
    wide.push(tag('path', { d: `M1 ${y + WIN.chrome}V${y + 12.5}a11.5 11.5 0 0 1 11.5-11.5H${VW - 12.5}a11.5 11.5 0 0 1 11.5 11.5V${y + WIN.chrome}z`, class: 'rs' }));
    wide.push(tag('path', { d: `M1 ${ST}H${VW - 1}V${VH - 12.5}a11.5 11.5 0 0 1-11.5 11.5H12.5a11.5 11.5 0 0 1-11.5-11.5z`, class: 'stg' }));
    wide.push(line(1, y + WIN.chrome + 0.5, VW - 1), line(1, ST - 0.5, VW - 1));
    for (const cx of [17, 32, 47]) wide.push(tag('circle', { cx, cy: y + 15.5, r: 4.5, class: 'lt' }));
    wide.push(rect(VW / 2 - 66, y + 6.5, 132, 18, 9, 'sf'), text(VW / 2, y + 19.5, SAID.url, { size: 12, anchor: 'middle', fill: 'mu' }));
    // the top bar
    const by = y + WIN.chrome + 24;
    let bx = 14;
    wide.push(text(bx, by, SAID.word, { weight: 700 }));
    bx += textWidth(SAID.word, 14, 700) + 10;
    wide.push(tag('path', { d: `M${num(bx + 0.5)} ${by - 15}v20`, class: 'ln' }));
    bx += 11;
    wide.push(text(bx, by, SAID.workspace, { weight: 600 }));
    bx += textWidth(SAID.workspace, 14, 600) + 9;
    wide.push(tag('path', { d: `M${num(bx)} ${by - 8.5}l3.5 3.5-3.5 3.5`, class: 'sep' }));
    bx += 3.5 + 9;
    wide.push(text(bx, by, L.topic, { fill: 'mu' }));
    const px = bx + textWidth(L.topic, 14) + 10;
    const pw = textWidth(L.connected, 12, 600) + 27;
    wide.push(rect(px, by - 15, pw, 20, 10, 'b-ok'), tag('circle', { cx: px + 11, cy: by - 5, r: 3, class: 'okf' }), text(px + 19, by - 0.8, L.connected, { size: 12, weight: 600, fill: 'ok' }));
    const cy = y + WIN.chrome + 19;
    (['ben', 'amy', 'ian'] as const).forEach((who, i) => wide.push(avatar(VW - 25 - i * 25, cy, 11, who)));
    wide.push(chips(VW - 25 - 50 - 11 - 12, cy, 1));
  }

  // ---- 1 Decide: the question card ----
  {
    const t0 = 0;
    rewindAt = REWIND;
    const w = 600;
    const h = 256;
    const x0 = (VW - w) / 2;
    const y0 = Math.round(ST + (SH - h) / 2);
    const ix = x0 + 16;
    const ir = x0 + w - 16;
    const out = [rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 9, 'cd')];
    out.push(...agent(ix, y0 + 16, 24), text(ix + 33, y0 + 33.5, L.qFrom, { size: 15, weight: 600 }));
    out.push(text(ir, y0 + 33, L.voted[0], { size: 13, fill: 'su', anchor: 'end', cls: A.between(t0 + 0.7, t0 + 1.5) }));
    out.push(text(ir, y0 + 33, L.voted[1], { size: 13, fill: 'su', anchor: 'end', cls: A.between(t0 + 1.5, t0 + 2.3) }));
    out.push(text(ir, y0 + 33, L.voted[2], { size: 13, fill: 'su', anchor: 'end', cls: A.after(t0 + 2.3) }));
    out.push(text(ix, y0 + 71, L.q, { size: 20, weight: 600 }));
    const option = (y: number, label: string, on?: string): string[] => [rect(ix + 0.5, y + 0.5, ir - ix - 1, 43, 8, 'bx'), ...(on === undefined ? [] : [on]), text(ix + 14, y + 27.5, label, { size: 15 })];
    out.push(...option(y0 + 88, L.optA, rect(ix + 0.25, y0 + 88.25, ir - ix - 0.5, 43.5, 8, `hl ${A.in(t0 + 0.7)}`)));
    out.push(text(ix + 14 + textWidth(L.optA, 15) + 12, y0 + 115, L.leading, { size: 12.5, weight: 600, fill: 'ac', cls: A.in(t0 + 0.7) }));
    out.push(avatar(ir - 10 - 13.5 - 30, y0 + 110, 13.5, 'ian', A.pop(t0 + 0.7)), avatar(ir - 10 - 13.5, y0 + 110, 13.5, 'amy', A.pop(t0 + 1.5)));
    out.push(...option(y0 + 140, L.optB), avatar(ir - 10 - 13.5, y0 + 162, 13.5, 'ben', A.pop(t0 + 2.3)));
    out.push(line(ix, y0 + 198.5, ir), text(ix, y0 + 229.5, L.decides, { size: 13, fill: 'su' }));
    const bw = Math.round(textWidth(L.submit, 13, 500) + 28);
    out.push(group(A.out(t0 + 3.7), [button(ir - bw, y0 + 210, bw, 30, L.submit, true, A.press(t0 + 3.4))]));
    out.push(done(ir - doneWidth(L.answered), y0 + 225, L.answered, A.after(t0 + 3.7)));
    out.push(pointer(ir - 14, y0 + 226, t0 + 2.9, grownBox(1.16, VW / 2, ST + SH / 2)));
    rewindAt = undefined;
    wide.push(group(A.scene(0), [grown(1.16, VW / 2, ST + SH / 2, out)]));
  }

  // ---- 2 Plan: the spec and the plan, two files ----
  {
    const t0 = SCENE;
    const h = 246;
    const y0 = Math.round(ST + (SH - h) / 2);
    const out: string[] = [];
    // the spec
    {
      const x0 = 20;
      const w = 306;
      const ix = x0 + 14;
      const iw = w - 28;
      out.push(rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 9, 'cd'), docMark(ix, y0 + 25), text(ix + 18, y0 + 30, L.spec, { weight: 600 }));
      out.push(text(ix + 18 + textWidth(L.spec, 14, 600) + 8, y0 + 29.5, SAID.specFile, { size: 12.5, mono: true }));
      const bar = (y: number, share: number, t: number, tall = false): string => rect(ix, y, iw * share, tall ? 11 : 8, 4, `${tall ? 'bh' : 'rs'} ${A.draw(t0 + t)}`);
      out.push(bar(y0 + 48, 0.44, 0.2, true), bar(y0 + 70, 0.9, 0.3), bar(y0 + 86, 0.7, 0.4));
      out.push(group(A.rise(t0 + 0.6), [rect(ix, y0 + 104, iw, 52, 4, 'sl'), rect(ix, y0 + 104, 2, 52, 0, 'sb'), text(ix + 12, y0 + 125, L.specLine[0]), text(ix + 12, y0 + 145, L.specLine[1])]));
      out.push(bar(y0 + 168, 0.9, 0.8), bar(y0 + 184, 0.6, 0.9), bar(y0 + 200, 0.76, 1.0), bar(y0 + 216, 0.38, 1.1));
    }
    // the plan
    {
      const x0 = 340;
      const w = 470;
      const ix = x0 + 14;
      const ir = x0 + w - 14;
      out.push(rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 9, 'cd'), docMark(ix, y0 + 25), text(ix + 18, y0 + 30, L.plan, { weight: 600 }));
      out.push(text(ix + 18 + textWidth(L.plan, 14, 600) + 8, y0 + 29.5, SAID.planFile, { size: 12.5, mono: true }));
      out.push(text(ir, y0 + 29.5, L.writing, { size: 12.5, fill: 'su', anchor: 'end', cls: A.out(t0 + 2.2) }), text(ir, y0 + 29.5, L.items, { size: 12.5, fill: 'su', anchor: 'end', cls: A.after(t0 + 2.2) }));
      L.names.forEach((name, i) => {
        const y = y0 + 46 + i * 44;
        const cy = y + 19;
        out.push(
          group(A.rise(t0 + 1.2 + i * 0.5), [
            rect(ix + 0.5, y + 0.5, ir - ix - 1, 37, 7, 'bx'),
            text(ix + 12, cy + 5, String(i + 1), { weight: 600, fill: 'su' }),
            text(ix + 30, cy + 5, name, { weight: 500 }),
            avatar(ix + 30 + textWidth(name, 14, 500) + 9 + 11, cy, 11, RESPONSIBLE[i] as Person),
            badge(ir - 10, cy, L.ready, 'n', A.between(t0 + 2.35, t0 + 3.7)),
            badge(ir - 10, cy, L.running, 'run', A.after(t0 + 3.7)),
          ]),
        );
      });
      out.push(line(ix, y0 + 184.5, ir), text(ix, y0 + 207, L.note[0], { size: 12.5, fill: 'su' }), text(ix, y0 + 224, L.note[1], { size: 12.5, fill: 'su' }));
      const bw = Math.round(textWidth(L.start, 13, 500) + 28);
      out.push(group(A.between(t0 + 2.35, t0 + 3.7), [button(ir - bw, y0 + 199, bw, 30, L.start, true, A.press(t0 + 3.4))]));
      out.push(done(ir - doneWidth(L.started), y0 + 214, L.started, A.after(t0 + 3.7)));
      // (this button is at the window's right edge: the pointer comes from a little less far)
      out.push(pointer(ir - 14, y0 + 215, t0 + 2.9, WIDE_BOX, 1.25, [24, 30]));
    }
    wide.push(group(A.scene(1), out));
  }

  // ---- 3 Build: one agent per work item ----
  {
    const t0 = 2 * SCENE;
    const w = 254;
    const h = 300;
    const y0 = Math.round(ST + (SH - h) / 2);
    const out: string[] = [];
    /**
     * A column: its card, the item's name and who is responsible. Returns where its inside starts and ends, and where
     * the name and the person end.
     */
    const head = (i: number): readonly [number, number, number] => {
      const x0 = 20 + i * 268;
      const ix = x0 + 12;
      const title = `${i + 1} · ${L.names[i] as string}`;
      const named = ix + textWidth(title, 14, 600) + 9 + 22;
      out.push(rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 9, 'cd'), text(ix, y0 + 27, title, { weight: 600 }), avatar(named - 11, y0 + 22, 11, RESPONSIBLE[i] as Person));
      return [ix, x0 + w - 12, named];
    };
    const where = (ix: number, y: number, i: number): string[] => {
      const label = L.worktree + (SAID.trees[i] as string);
      return [rect(ix + 0.5, y + 0.5, textWidth(label, 12) + 17, 21, 11, 'bx'), text(ix + 8.5, y + 15.2, label, { size: 12, fill: 'mu' })];
    };
    const tool = (ix: number, y: number, verb: string, file: string, t: number): string => group(A.rise(t0 + t), [text(ix, y, verb, { size: 13, fill: 'mu' }), text(ix + textWidth(verb, 13) + 7, y, file, { size: 12.5, mono: true })]);
    const status = (ix: number, label: string, cls: string, withDots = true): string => {
      const body = [...(withDots ? dots(ix, y0 + h - 18.5) : []), text(ix + (withDots ? 26 : 0), y0 + h - 14, label, { size: 12.5, fill: 'su' })];
      return cls === '' ? body.join('\n') : group(cls, body);
    };
    // 1: the agent finishes, and its report waits for a reader
    {
      const [ix, ir] = head(0);
      out.push(badge(ir, y0 + 22, L.running, 'run', A.out(t0 + REPORTED)), badge(ir, y0 + 22, L.toReview, 'ok', A.after(t0 + REPORTED)));
      out.push(...where(ix, y0 + 40, 0), tool(ix, y0 + 86, L.edited, SAID.cartApi, 0.3), tool(ix, y0 + 110, L.created, SAID.cartTest, 1.6));
      out.push(line(ix, y0 + h - 37.5, ir), status(ix, L.working, A.out(t0 + REPORTED)));
    }
    // 2: the agent asks before a command, and a person allows it once
    {
      const [ix, ir, named] = head(1);
      // The state stands on the name's line, as in the other two columns, wherever it fits there. A long one (the
      // English "Waiting for permission") does not: it stands on a line of its own while it shows, and what is under
      // it moves down for that time. (The page keeps one place for the three states, as wide as the widest, so there
      // "Running" stands under the name too; a column that looks unlike its neighbours for the whole scene reads as a
      // mistake in a picture nobody can stop.)
      const drop = named + 8 + textWidth(L.waitingBadge, 12) + 18 > ir ? 26 : 0;
      const lower = `transform:translateY(${drop}px)`;
      const room = drop === 0 ? '' : kf('', [[0, 'transform:none'], [t0 + 0.3, `transform:none${EASE}`], [t0 + 0.5, lower], [t0 + 2.7, `${lower}${EASE}`], [t0 + 2.9, 'transform:none'], [LOOP, 'transform:none']]);
      out.push(badge(ir, y0 + 22, L.running, 'run', A.out(t0 + 0.3)), badge(ir, y0 + 22 + drop, L.waitingBadge, 'ask', A.between(t0 + 0.3, t0 + 2.7)), badge(ir, y0 + 22, L.running, 'run', A.after(t0 + 2.7)));
      const py = y0 + 100;
      const allowWidth = Math.round(textWidth(L.allow, 13, 500) + 26);
      const denyWidth = Math.round(textWidth(L.deny, 13, 500) + 26);
      out.push(
        group(room, [
          ...where(ix, y0 + 40, 1),
          tool(ix, y0 + 86, L.read, SAID.payForm, 0.2),
          group(A.rise(t0 + 0.3), [
            rect(ix + 0.5, py + 0.5, ir - ix - 1, 113, 7, 'pm'),
            rect(ix + 11, py + 12.5, 8, 8, 2, 'wf'),
            text(ix + 26, py + 21.5, L.perm[0], { size: 13.5, weight: 600 }),
            text(ix + 11, py + 39.5, L.perm[1], { size: 13.5, weight: 600 }),
            ...term(ix + 11, py + 58, SAID.command),
            group(A.out(t0 + 2.7), [button(ix + 11, py + 76, allowWidth, 26, L.allow, true, A.press(t0 + 2.4)), button(ix + 11 + allowWidth + 6, py + 76, denyWidth, 26, L.deny, false, '')]),
            done(ix + 11, py + 89, L.allowed, A.after(t0 + 2.7)),
            // (the pointer presses while everything here is `drop` lower than it is drawn)
            pointer(ix + 11 + allowWidth - 14, py + 91, t0 + 1.9, [0, -drop, VW, VH - drop]),
          ]),
        ]),
      );
      out.push(line(ix, y0 + h - 37.5, ir), status(ix, L.working, A.out(t0 + 0.3)), status(ix, L.waiting, A.between(t0 + 0.3, t0 + 2.7), false), status(ix, L.working, A.after(t0 + 2.7)));
    }
    // 3: the agent works on
    {
      const [ix, ir] = head(2);
      out.push(badge(ir, y0 + 22, L.running, 'run', ''));
      out.push(...where(ix, y0 + 40, 2), tool(ix, y0 + 86, L.read, SAID.page, 0.7), tool(ix, y0 + 110, L.edited, SAID.page, 2.2));
      out.push(line(ix, y0 + h - 37.5, ir), status(ix, L.working, ''));
    }
    wide.push(group(A.scene(2), out));
  }

  // ---- 4 Review: the result report, and the merge ----
  {
    const t0 = 3 * SCENE;
    const w = 660;
    const h = 218;
    const x0 = (VW - w) / 2;
    const y0 = Math.round(ST + (SH - h) / 2);
    const ix = x0 + 16;
    const ir = x0 + w - 16;
    const rx = ix + 380;
    const title = `${L.report}1 · ${L.names[0]}`;
    const out = [rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, 9, 'cd'), tag('circle', { cx: ix + 5, cy: y0 + 28, r: 5, class: 'okf' }), text(ix + 19, y0 + 33.5, title, { size: 15, weight: 600 })];
    out.push(badge(ir, y0 + 28, L.toReview, 'ok', A.out(t0 + 1.9)), badge(ir, y0 + 28, L.reviewed, 'ok', A.between(t0 + 1.9, t0 + 2.9)), badge(ir, y0 + 28, L.reviewedMerged, 'ok', A.after(t0 + 2.9)));
    out.push(text(ix, y0 + 64, L.whatDone, { size: 12, weight: 600, fill: 'su' }), text(ix, y0 + 86, L.doneText, { cls: A.rise(t0 + 0.3) }));
    out.push(text(ix, y0 + 113, L.howVerified, { size: 12, weight: 600, fill: 'su' }), group(A.rise(t0 + 0.5), [tick(ix + 1, y0 + 131.5), ...term(ix + 17, y0 + 130.5, SAID.test)]));
    out.push(text(rx, y0 + 64, L.changes, { size: 12, weight: 600, fill: 'su' }));
    ([[SAID.cartApi, 0.7], [SAID.cartTest, 0.9]] as const).forEach(([file, t], i) => {
      out.push(group(A.rise(t0 + t), [text(rx, y0 + 86 + i * 24, file, { size: 12.5, mono: true }), text(ir, y0 + 86 + i * 24, SAID.diffs[i] as string, { size: 12, mono: true, fill: 'ok', anchor: 'end' })]));
    });
    out.push(line(ix, y0 + 158.5, ir));
    const bw = Math.round(textWidth(L.reviewBtn, 13, 500) + 28);
    out.push(group(A.out(t0 + 1.9), [button(ix, y0 + 171, bw, 30, L.reviewBtn, true, A.press(t0 + 1.6))]), done(ix, y0 + 186, L.marked, A.after(t0 + 1.9)));
    out.push(pointer(ix + bw - 14, y0 + 187, t0 + 1.1, grownBox(1.16, VW / 2, ST + SH / 2)));
    const mx = ix + Math.max(bw, doneWidth(L.marked)) + 22;
    out.push(group(A.rise(t0 + 2.9), [avatar(mx + 11, y0 + 186, 11, 'ian'), tag('use', { href: '#i-merge', x: mx + 29, y: y0 + 178.5, width: 15, height: 15, class: 'im' }), text(mx + 50, y0 + 190.5, L.merged, { size: 13, weight: 600, fill: 'ok' })]));
    wide.push(group(A.scene(3), [grown(1.16, VW / 2, ST + SH / 2, out)]));
  }

  // ============ the simpler drawing, for a phone: drawn at half size inside a group that doubles it ============
  const NW = VW / 2;
  const NH = VH / 2;
  const NARROW_BOX = [0, 0, NW, NH] as const;
  /** A pointer of the simpler drawing that presses near the right or the lower edge comes from the left. */
  const FROM_LEFT: readonly [number, number] = [-34, 4];
  const narrow: string[] = [];
  const N = { strip: 28, win: 33, top: 24 };
  const NST = N.win + N.top;
  {
    narrow.push(rect(0.5, 0.5, NW - 1, N.strip - 1, 9, 'pn'));
    const w = (NW - 6 - 3) / 4;
    L.parts.forEach((part, i) => {
      const x = 3 + i * (w + 1);
      narrow.push(rect(x + 0.5, 3.5, w - 1, N.strip - 7, 6.5, `tb ${A.part(i)}`), text(x + w / 2, 18.4, part, { size: 12.5, weight: 500, anchor: 'middle' }), rect(x + 16, 22.5, w - 32, 1.5, 0.75, `fl ${A.fill(i)}`));
    });
    narrow.push(rect(0.5, N.win + 0.5, NW - 1, NH - N.win - 1, 8, 'win'));
    narrow.push(tag('path', { d: `M1 ${NST}H${NW - 1}V${NH - 8.5}a7.5 7.5 0 0 1-7.5 7.5H8.5a7.5 7.5 0 0 1-7.5-7.5z`, class: 'stg' }), line(1, NST - 0.5, NW - 1));
    narrow.push(text(10, N.win + 16.4, L.topic, { size: 12.5, weight: 600 }));
    (['ben', 'amy', 'ian'] as const).forEach((who, i) => narrow.push(avatar(NW - 17 - i * 18.5, N.win + 12, 8, who)));
    narrow.push(chips(NW - 17 - 37 - 8 - 8, N.win + 12, 0.72));
  }
  // the stage's cards
  const CX = 8;
  const CY = NST + 7;
  const CW = NW - 16;
  const CH = NH - CY - 7;
  const NIX = CX + 10;
  const NIR = CX + CW - 10;
  /** Where a card's last row starts: a button, or what its press left. */
  const FOOT = CY + CH - 33;

  // 1 Decide
  {
    const t0 = 0;
    rewindAt = REWIND;
    const out = [rect(CX + 0.5, CY + 0.5, CW - 1, CH - 1, 7, 'cd')];
    out.push(...agent(NIX, CY + 8, 18), text(NIX + 24, CY + 21.4, L.qFrom, { size: 12.5, weight: 600 }));
    L.voted.forEach((voted, i) => out.push(text(NIR, CY + 21, voted, { size: 11, fill: 'su', anchor: 'end', cls: i < 2 ? A.between(t0 + 0.7 + i * 0.8, t0 + 1.5 + i * 0.8) : A.after(t0 + 2.3) })));
    out.push(text(NIX, CY + 45.5, L.q, { size: 15.5, weight: 600 }));
    const option = (y: number, label: string, on?: string): string[] => [rect(NIX + 0.5, y + 0.5, NIR - NIX - 1, 29, 6, 'bx'), ...(on === undefined ? [] : [on]), text(NIX + 10, y + 19.5, label, { size: 13 })];
    out.push(...option(CY + 54, L.optA, rect(NIX + 0.25, CY + 54.25, NIR - NIX - 0.5, 29.5, 6, `hl ${A.in(t0 + 0.7)}`)));
    out.push(text(NIX + 10 + textWidth(L.optA, 13) + 9, CY + 73.2, L.leading, { size: 11, weight: 600, fill: 'ac', cls: A.in(t0 + 0.7) }));
    out.push(avatar(NIR - 7 - 10 - 22.5, CY + 69, 10, 'ian', A.pop(t0 + 0.7)), avatar(NIR - 7 - 10, CY + 69, 10, 'amy', A.pop(t0 + 1.5)));
    out.push(...option(CY + 88, L.optB), avatar(NIR - 7 - 10, CY + 103, 10, 'ben', A.pop(t0 + 2.3)));
    out.push(line(NIX, FOOT - 8.5, NIR), text(NIX, FOOT + 15.8, L.decides, { size: 11, fill: 'su' }));
    const bw = Math.round(textWidth(L.submit, 12, 500) + 24);
    out.push(group(A.out(t0 + 3.7), [button(NIR - bw, FOOT, bw, 24, L.submit, true, A.press(t0 + 3.4), 12)]));
    out.push(done(NIR - doneWidth(L.answered, 12), FOOT + 12, L.answered, A.after(t0 + 3.7), 12));
    out.push(pointer(NIR - 13, FOOT + 12.5, t0 + 2.9, NARROW_BOX, 1.1, FROM_LEFT));
    rewindAt = undefined;
    narrow.push(group(A.scene(0), out));
  }

  // 2 Plan: one card, which names both files
  {
    const t0 = SCENE;
    const out = [rect(CX + 0.5, CY + 0.5, CW - 1, CH - 1, 7, 'cd')];
    let hx = NIX;
    for (const [name, file] of [[L.spec, SAID.specFile], [L.plan, SAID.planFile]] as const) {
      out.push(docMark(hx, CY + 16.5, 9), text(hx + 15, CY + 21.4, name, { size: 12.5, weight: 600 }));
      hx += 15 + textWidth(name, 12.5, 600) + 6;
      out.push(text(hx, CY + 21.1, file, { size: 11, mono: true }));
      hx += textWidth(file, 11, 400, true) + 14;
    }
    out.push(text(NIR, CY + 21.1, L.writing, { size: 11, fill: 'su', anchor: 'end', cls: A.out(t0 + 2.2) }), text(NIR, CY + 21.1, L.items, { size: 11, fill: 'su', anchor: 'end', cls: A.after(t0 + 2.2) }));
    L.names.forEach((name, i) => {
      const y = CY + 31 + i * 32;
      const cy = y + 14;
      out.push(
        group(A.rise(t0 + 1.2 + i * 0.5), [
          rect(NIX + 0.5, y + 0.5, NIR - NIX - 1, 27, 6, 'bx'),
          text(NIX + 9, cy + 4.5, String(i + 1), { size: 12.5, weight: 600, fill: 'su' }),
          text(NIX + 24, cy + 4.5, name, { size: 12.5, weight: 500 }),
          avatar(NIX + 24 + textWidth(name, 12.5, 500) + 7 + 8.5, cy, 8.5, RESPONSIBLE[i] as Person),
          badge(NIR - 7, cy, L.ready, 'n', A.between(t0 + 2.35, t0 + 3.7), 10.5),
          badge(NIR - 7, cy, L.running, 'run', A.after(t0 + 3.7), 10.5),
        ]),
      );
    });
    out.push(line(NIX, FOOT - 8.5, NIR));
    const bw = Math.round(textWidth(L.start, 12, 500) + 24);
    out.push(group(A.between(t0 + 2.35, t0 + 3.7), [button(NIR - bw, FOOT, bw, 24, L.start, true, A.press(t0 + 3.4), 12)]));
    out.push(done(NIR - doneWidth(L.started, 12), FOOT + 12, L.started, A.after(t0 + 3.7), 12));
    out.push(pointer(NIR - 13, FOOT + 12.5, t0 + 2.9, NARROW_BOX, 1.1, FROM_LEFT));
    narrow.push(group(A.scene(1), out));
  }

  // 3 Build: the agents under each other; the one that asks has the room its request needs
  {
    const t0 = 2 * SCENE;
    const gap = 5;
    const small = 40;
    const tall = CH - 2 * small - 2 * gap;
    const out: string[] = [];
    const row = (i: number, y: number, height: number): void => {
      const title = `${i + 1} · ${L.names[i] as string}`;
      out.push(rect(CX + 0.5, y + 0.5, CW - 1, height - 1, 7, 'cd'), text(NIX, y + 17, title, { size: 12.5, weight: 600 }), avatar(NIX + textWidth(title, 12.5, 600) + 7 + 8.5, y + 12.5, 8.5, RESPONSIBLE[i] as Person));
    };
    const tool = (y: number, verb: string, file: string, cls: string): string => group(cls, [text(NIX, y + 32, verb, { size: 11.5, fill: 'mu' }), text(NIX + textWidth(verb, 11.5) + 6, y + 32, file, { size: 11, mono: true })]);
    {
      const y = CY;
      row(0, y, small);
      out.push(badge(NIR, y + 12.5, L.running, 'run', A.out(t0 + REPORTED), 10.5), badge(NIR, y + 12.5, L.toReview, 'ok', A.after(t0 + REPORTED), 10.5));
      out.push(tool(y, L.edited, SAID.cartApi, A.span(t0 + 0.3, t0 + 1.6)), tool(y, L.created, SAID.cartTest, A.after(t0 + 1.6)), group(A.out(t0 + REPORTED), dots(NIR - 16, y + 28.5, 1.8)));
    }
    {
      const y = CY + small + gap;
      row(1, y, tall);
      out.push(rect(CX + 0.5, y + 0.5, CW - 1, tall - 1, 7, `pm ${A.span(t0 + 0.3, t0 + 2.7)}`));
      out.push(badge(NIR, y + 12.5, L.running, 'run', A.out(t0 + 0.3), 10.5), badge(NIR, y + 12.5, L.waitingBadge, 'ask', A.between(t0 + 0.3, t0 + 2.7), 10.5), badge(NIR, y + 12.5, L.running, 'run', A.after(t0 + 2.7), 10.5));
      out.push(tool(y, L.read, SAID.payForm, A.out(t0 + 0.3)));
      const allowWidth = Math.round(textWidth(L.allow, 11.5, 500) + 20);
      const denyWidth = Math.round(textWidth(L.deny, 11.5, 500) + 20);
      const allowX = NIR - denyWidth - 5 - allowWidth;
      out.push(
        group(A.after(t0 + 0.3), [
          rect(NIX, y + 28.5, 7, 7, 2, 'wf'),
          text(NIX + 12, y + 36, L.perm.join(L.permJoin), { size: 11.5, weight: 600 }),
          ...term(NIX, y + 57.5, SAID.command, 11),
          group(A.out(t0 + 2.7), [button(allowX, y + 47, allowWidth, 21, L.allow, true, A.press(t0 + 2.4), 11.5), button(NIR - denyWidth, y + 47, denyWidth, 21, L.deny, false, '', 11.5)]),
          done(NIR - doneWidth(L.allowed, 11.5), y + 57.5, L.allowed, A.after(t0 + 2.7), 11.5),
          pointer(allowX + allowWidth - 12, y + 58.5, t0 + 1.9, NARROW_BOX, 1.1),
        ]),
      );
    }
    {
      const y = CY + small + gap + tall + gap;
      row(2, y, small);
      out.push(badge(NIR, y + 12.5, L.running, 'run', '', 10.5), tool(y, L.read, SAID.page, A.span(t0 + 0.7, t0 + 2.2)), tool(y, L.edited, SAID.page, A.after(t0 + 2.2)), ...dots(NIR - 16, y + 28.5, 1.8));
    }
    narrow.push(group(A.scene(2), out));
  }

  // 4 Review: a short report
  {
    const t0 = 3 * SCENE;
    const title = `${L.report}1 · ${L.names[0]}`;
    const out = [rect(CX + 0.5, CY + 0.5, CW - 1, CH - 1, 7, 'cd'), tag('circle', { cx: NIX + 4.5, cy: CY + 16.5, r: 4.5, class: 'okf' }), text(NIX + 15, CY + 21.4, title, { size: 12.5, weight: 600 })];
    out.push(badge(NIR, CY + 16.5, L.toReview, 'ok', A.out(t0 + 1.9), 10.5), badge(NIR, CY + 16.5, L.reviewed, 'ok', A.between(t0 + 1.9, t0 + 2.9), 10.5), badge(NIR, CY + 16.5, L.reviewedMerged, 'ok', A.after(t0 + 2.9), 10.5));
    out.push(text(NIX, CY + 41, L.whatDone, { size: 10.5, weight: 600, fill: 'su' }), text(NIX, CY + 57.5, L.doneText, { size: 12.5, cls: A.rise(t0 + 0.3) }));
    out.push(text(NIX, CY + 76, L.howVerified, { size: 10.5, weight: 600, fill: 'su' }), group(A.rise(t0 + 0.5), [tick(NIX + 1, CY + 92, 0.9), ...term(NIX + 15, CY + 91, SAID.test, 11)]));
    out.push(line(NIX, CY + 105.5, NIR));
    const bw = Math.round(textWidth(L.reviewBtn, 12, 500) + 24);
    out.push(group(A.out(t0 + 1.9), [button(NIX, CY + 112, bw, 24, L.reviewBtn, true, A.press(t0 + 1.6), 12)]), done(NIX, CY + 124, L.marked, A.after(t0 + 1.9), 12));
    out.push(pointer(NIX + bw - 13, CY + 124.5, t0 + 1.1, NARROW_BOX, 1.1));
    out.push(group(A.rise(t0 + 2.9), [avatar(NIX + 8.5, CY + 151, 8.5, 'ian'), tag('use', { href: '#i-merge', x: NIX + 22, y: CY + 144.5, width: 13, height: 13, class: 'im' }), text(NIX + 40, CY + 155.2, L.merged, { size: 12, weight: 600, fill: 'ok' })]));
    narrow.push(group(A.scene(3), out));
  }

  // ---- the stylesheet: one rule a line ----
  const soft = (value: Soft): string => `fill:${value.color};fill-opacity:${value.opacity}`;
  /**
   * With reduced motion: the scene and the strip's part number i show for their part of the loop, and go during its
   * last CROSS seconds while the next come (the first while the last go, at the end of the loop).
   */
  const fade = (i: number): string => {
    const share = (seconds: number): string => `${num((seconds / LOOP) * 100)}%`;
    const start = i * SCENE;
    const end = start + SCENE;
    if (i === 0) return `0%,${share(end - CROSS)},100%{opacity:1}${share(end)},${share(LOOP - CROSS)}{opacity:0}`;
    return `0%,${share(start - CROSS)},${end === LOOP ? '100%' : `${share(end)},100%`}{opacity:0}${share(start)},${share(end - CROSS)}{opacity:1}`;
  };
  const css = [
    `svg{font:400 14px ${SANS}}`,
    `text{fill:${C.text}}`,
    `.mo{font-family:${MONO}}`,
    `.w5{font-weight:500}`,
    `.w6{font-weight:600}`,
    `.w7{font-weight:700}`,
    `.mu{fill:${C.muted}}`,
    `.su{fill:${C.subtle}}`,
    `.ac{fill:${C.accent}}`,
    `.ok{fill:${C.ok}}`,
    `.wh{fill:#fff}`,
    `.bk{fill:#000}`,
    `.win{fill:${C.surface};stroke:${C.borderStrong}}`,
    `.stg{fill:${C.stage}}`,
    `.rs{fill:${C.raised}}`,
    `.sf{fill:${C.surface}}`,
    `.lt{fill:${C.borderStrong}}`,
    `.ln{stroke:${C.border};fill:none}`,
    `.sep{stroke:${C.subtle};fill:none;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}`,
    `.pn{fill:${C.panel};stroke:${C.border}}`,
    `.tb{fill:${C.surface};stroke:${C.borderStrong}}`,
    `.fl{fill:${C.accent}}`,
    `.cd{fill:${C.surface};stroke:${C.border}}`,
    `.bx{fill:none;stroke:${C.border}}`,
    `.hl{${soft(C.accentSoft)};stroke:${C.accentSolid};stroke-width:1.5}`,
    `.bp{fill:${C.accentSolid}}`,
    `.bs{fill:${C.surface};stroke:${C.borderStrong}}`,
    `.bh{fill:${C.border}}`,
    `.b-n{fill:${C.raised}}`,
    `.b-run{${soft(C.accentSoft)}}`,
    `.b-ok{${soft(C.okSoft)}}`,
    `.b-ask{fill:none;stroke:${C.warn}}`,
    `.okf{fill:${C.ok}}`,
    `.wf{fill:${C.warn}}`,
    `.pm{fill:none;stroke:${C.warn}}`,
    `.sl{${soft(C.accentSoft)}}`,
    `.sb{fill:${C.accentSolid}}`,
    `.tk{fill:none;stroke:${C.ok};stroke-linecap:round;stroke-linejoin:round}`,
    `.dm{fill:none;stroke:${C.subtle};stroke-width:1.5}`,
    `.ia{fill:none;stroke:#fff}`,
    `.im{fill:none;stroke:${C.ok}}`,
    `.ia,.im{stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}`,
    `.cu{fill:${C.text};stroke:${C.surface};stroke-width:1.2;stroke-linejoin:round}`,
    `.ch{fill:none;stroke:${C.border}}`,
    `.chm{${soft(C.okSoft)};stroke:${C.ok}}`,
    `.c0{fill:${C.surface};stroke:${C.line}}`,
    `.c1{fill:${C.accentSolid}}`,
    `.c2{fill:${C.warn}}`,
    `.c3{fill:${C.ok}}`,
    `.c4{fill:${C.surface}}`,
    `.d{fill:${C.accent};opacity:.55}`,
    // where one drawing shows, the other is not there
    `.N{display:none}`,
    `@media (max-width:${NARROW}px){`,
    `.W{display:none}`,
    `.N{display:inline}`,
    `}`,
    // what shows where nothing moves: each part in the state its scene ends with
    `.o{transform-box:fill-box;transform-origin:50% 50%}`,
    `.l{transform-box:fill-box;transform-origin:0 50%}`,
    ...[...frames.values()].filter((frame) => frame.rest !== '').map((frame) => `.${frame.name}{${frame.rest}}`),
    // the motion: inside no media query, so that it plays wherever CSS animation does
    `.a{animation:${LOOP}s linear infinite}`,
    ...[...frames.values()].map((frame) => `.${frame.name}{animation-name:${frame.name}}`),
    `.d{animation:d 1.25s ease-in-out infinite}`,
    `.d1{animation-delay:.2s}`,
    `.d2{animation-delay:.4s}`,
    `@keyframes d{0%,60%,100%{opacity:.3}30%{opacity:1}}`,
    ...[...frames.values()].map((frame) => `@keyframes ${frame.name}{${frame.body}}`),
    ...(freeze === undefined ? [] : [`.a,.d{animation-delay:${num(-freeze)}s!important;animation-play-state:paused!important}`]),
    // a reader who asked for less motion: every part stays as its scene ends, and the four finished scenes follow each
    // other, one fading into the next
    `@media (prefers-reduced-motion:reduce){`,
    `.a,.d{animation:none}`,
    `.r0,.r1,.r2,.r3{animation:${LOOP}s linear infinite}`,
    ...[0, 1, 2, 3].flatMap((i) => [`.r${i}{animation-name:r${i}}`, `@keyframes r${i}{${fade(i)}}`]),
    ...(freeze === undefined ? [] : [`.r0,.r1,.r2,.r3{animation-delay:${num(-freeze)}s!important;animation-play-state:paused!important}`]),
    `}`,
    ...(layout === 'wide' ? [`.W{display:inline!important}`, `.N{display:none!important}`] : layout === 'narrow' ? [`.W{display:none!important}`, `.N{display:inline!important}`] : []),
  ];

  const defs = tag('defs', {}, [
    '<symbol id="i-agent" viewBox="0 0 16 16"><rect x="2.75" y="5.25" width="10.5" height="8" rx="2"/><path d="M8 2.25v3M6 9.25v.01M10 9.25v.01M6.25 11.5h3.5"/></symbol>',
    '<symbol id="i-cursor" viewBox="0 0 16 16"><path d="M3 1.5v11.4l3.1-2.7 1.9 4.4 2.1-.9-1.9-4.4 4.1-.3z"/></symbol>',
    '<symbol id="i-merge" viewBox="0 0 16 16"><circle cx="4.5" cy="3.75" r="1.75"/><circle cx="4.5" cy="12.25" r="1.75"/><circle cx="11.5" cy="8" r="1.75"/><path d="M4.5 5.5v5M4.5 5.5c0 2.5 2.4 2.5 5.25 2.5"/></symbol>',
  ]);

  return `${tag('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${VW} ${VH}`, width: VW, height: VH, role: 'img', lang: L.lang, 'aria-label': pictureLabel(lang) }, [
    tag('style', {}, css),
    defs,
    tag('g', { class: 'W' }, wide),
    tag('g', { class: 'N' }, [tag('g', { transform: 'scale(2)' }, narrow)]),
  ])}\n`;
}

/** The product page of a language: its picture's description is the README picture's too. */
export const SITE_PAGE: Readonly<Record<PictureLang, string>> = { en: 'apps/site/public/index.html', 'zh-TW': 'apps/site/public/zh-TW/index.html' };

/**
 * What the picture shows, in words: the product page's own description of its picture (the `aria-label` of its
 * window), read from the page so that the two cannot differ. The READMEs' `alt` is the same sentence.
 */
export function pictureLabel(lang: PictureLang): string {
  const html = readFileSync(join(REPO_ROOT, SITE_PAGE[lang]), 'utf8');
  const label = /<div class="win"[^>]*\saria-label="([^"]+)"/.exec(html)?.[1];
  if (label === undefined) throw new Error(`${SITE_PAGE[lang]}: no <div class="win" … aria-label="…">`);
  return label.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// -------------------------------------------------------------------------------------------------------- measuring

const CHROME_PATHS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];

function chrome(): string {
  const named = process.env['SMURG_TEST_CHROME'];
  if (named !== undefined && named !== '') {
    if (!isAbsolute(named) || !existsSync(named)) throw new Error(`SMURG_TEST_CHROME=${named} is not an absolute path to a browser`);
    return named;
  }
  const found = CHROME_PATHS.find((path) => existsSync(path));
  if (found === undefined) throw new Error('no Chrome: install Google Chrome, or name a Chrome or Chromium with SMURG_TEST_CHROME');
  return found;
}

/**
 * Measures every text the pictures draw, in the fonts they name, and writes the two widths files. Chrome gets a fresh
 * profile in a temporary folder and no network (every host name fails to resolve): it measures with the machine's own
 * fonts, which is why this runs on macOS only (the layout is the one of its system font).
 */
function measure(): void {
  if (process.platform !== 'darwin') throw new Error('the texts are measured in the system font of macOS: run --measure on a Mac');
  const keys = new Set<string>();
  for (const lang of ['en', 'zh-TW'] as const) build({ theme: 'light', lang, collect: keys });
  const texts = [...keys].sort().map((key) => {
    const parts = /^([ms])(\d+)\/([\d.]+)\/([\s\S]*)$/.exec(key);
    if (parts === null) throw new Error(`not a width key: ${key}`);
    return `<text y="20" data-k="${escapeXml(key).replace(/"/g, '&quot;')}" style="font:${parts[2]} ${parts[3]}px ${parts[1] === 'm' ? MONO : SANS}">${escapeXml(parts[4] as string)}</text>`;
  });
  const page = `<!doctype html><meta charset="utf-8"><svg xmlns="http://www.w3.org/2000/svg" width="900" height="40">${texts.join('')}</svg><pre id="widths"></pre><script>document.getElementById('widths').textContent = JSON.stringify([...document.querySelectorAll('text[data-k]')].map((t) => [t.dataset.k, t.getComputedTextLength()]));</script>\n`;
  const work = mkdtempSync(join(tmpdir(), 'smurg-readme-picture-'));
  try {
    const file = join(work, 'measure.html');
    writeFileSync(file, page);
    const result = spawnSync(
      chrome(),
      ['--headless', `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-update', '--disable-background-networking', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND', '--dump-dom', pathToFileURL(file).href],
      // On macOS Chrome keeps its temporary files where MAC_CHROMIUM_TMPDIR says, not TMPDIR.
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MAC_CHROMIUM_TMPDIR: work } },
    );
    const dumped = /<pre id="widths">([^<]*)<\/pre>/.exec(result.stdout ?? '')?.[1];
    if (result.status !== 0 || dumped === undefined || dumped === '') throw new Error(`Chrome did not measure the texts (${result.error?.message ?? `exit ${result.status ?? result.signal}`}): ${(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
    const found = JSON.parse(dumped.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) as [string, number][];
    const plain: Record<string, number> = {};
    const chinese: Record<string, number> = {};
    for (const [key, width] of found) {
      if (!(width > 0)) throw new Error(`Chrome measured no width for ${key}`);
      (CJK.test(key) ? chinese : plain)[key] = round2(width);
    }
    if (found.length !== keys.size) throw new Error(`Chrome measured ${found.length} of ${keys.size} texts`);
    writeFileSync(join(REPO_ROOT, WIDTHS_FILE), `${JSON.stringify(plain, null, 1)}\n`);
    writeFileSync(join(REPO_ROOT, WIDTHS_FILE_ZH_TW), `${JSON.stringify(chinese, null, 1)}\n`);
    console.log(`readme picture: measured ${found.length} texts (${WIDTHS_FILE}: ${Object.keys(plain).length}, ${WIDTHS_FILE_ZH_TW}: ${Object.keys(chinese).length})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The moments a sheet holds a picture at: every scene before, during and after what happens in it. */
const SHEET_SECONDS = [0.6, 1.8, 2.6, 4.4, SCENE + 1.6, SCENE + 2.6, SCENE + 4.4, 2 * SCENE + 1, 2 * SCENE + 2.4, 2 * SCENE + 4.6, 3 * SCENE + 1.3, 3 * SCENE + 4.2].map(round2);

/**
 * Writes every picture held at SHEET_SECONDS, the wide drawing and the one for a phone, and a page that lays the
 * frames out, each through <img> as GitHub shows the file. A frame is the committed picture with its clock stopped.
 */
function sheet(dir: string): void {
  mkdirSync(join(dir, 'frames'), { recursive: true });
  const sections: string[] = [];
  for (const picture of PICTURES) {
    for (const layout of ['wide', 'narrow'] as const) {
      const width = layout === 'wide' ? 540 : 343;
      const frames = SHEET_SECONDS.map((seconds) => {
        const file = `frames/${picture.file.replace(/\.svg$/, '')}-${layout}-${seconds}.svg`;
        writeFileSync(join(dir, file), build({ ...picture, freeze: seconds, layout }));
        return `<figure><img src="${file}" width="${width}" alt=""><figcaption>${seconds} s</figcaption></figure>`;
      });
      sections.push(`<section class="${picture.theme}"><h2>${picture.file}: the ${layout === 'wide' ? 'wide drawing' : 'drawing for a phone'}, ${width} px</h2><div style="grid-template-columns:repeat(${layout === 'wide' ? 3 : 4},${width}px)">${frames.join('')}</div></section>`);
    }
  }
  const style = 'body{margin:0;font:14px system-ui,sans-serif}section{padding:16px 16px 24px}.light{background:#fff;color:#1f2328}.dark{background:#0d1117;color:#f0f6fc}h2{font-size:14px;margin:0 0 12px}div{display:grid;gap:14px 16px}figure{margin:0}img{display:block}figcaption{font:600 12px ui-monospace,monospace;margin-top:4px}';
  writeFileSync(join(dir, 'index.html'), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>The README's picture, held at ${SHEET_SECONDS.length} moments</title>\n<style>${style}</style>\n</head>\n<body>\n${sections.join('\n')}\n</body>\n</html>\n`);
  console.log(`readme picture: ${join(dir, 'index.html')} (${PICTURES.length * 2 * SHEET_SECONDS.length} frames)`);
}

function main(argv: readonly string[]): number {
  try {
    const sheetAt = argv.indexOf('--sheet');
    const sheetDir = sheetAt === -1 ? undefined : argv[sheetAt + 1];
    const unknown = argv.filter((arg, index) => arg !== '--check' && arg !== '--measure' && arg !== '--sheet' && !(sheetAt !== -1 && index === sheetAt + 1));
    if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(' ')} (the options are --check, --measure and --sheet DIR)`);
    if (sheetAt !== -1) {
      if (sheetDir === undefined || sheetDir.startsWith('--')) throw new Error('--sheet needs a folder to write into');
      if (argv.length !== 2) throw new Error('--sheet goes alone: it writes the sheet and no picture');
      sheet(isAbsolute(sheetDir) ? sheetDir : join(process.cwd(), sheetDir));
      return 0;
    }
    if (argv.includes('--measure')) measure();
    measured = undefined;
    const stale: string[] = [];
    for (const picture of PICTURES) {
      const path = join(REPO_ROOT, PICTURE_DIR, picture.file);
      const svg = build(picture);
      if (argv.includes('--check')) {
        if (!existsSync(path) || readFileSync(path, 'utf8') !== svg) stale.push(`${PICTURE_DIR}/${picture.file}`);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, svg);
      console.log(`readme picture: ${PICTURE_DIR}/${picture.file} (${Buffer.byteLength(svg)} bytes)`);
    }
    if (stale.length > 0) throw new Error(`not what this script writes now: ${stale.join(', ')}. Run  node scripts/readme-picture.ts  and commit the pictures.`);
    return 0;
  } catch (error) {
    console.error(`readme picture: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
