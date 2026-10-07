// TEST ONLY: what a text costs the process that reads it. The daemon has one thread: a function that looks at a text
// a member or an agent wrote (a message, a suggestion, a name, a path, SPEC.md, PLAN.md, a report, a shell command,
// the output of a tool) holds everybody for as long as it takes. So each of them must cost in proportion to the
// text, whatever the text is. `normalize` puts a run of combining marks in order by comparing them with each other
// (the square of the run); an expression such as `/x+$/`, `/[ \t]*:/` behind a lazy group, or `(a|a)*` is tried again
// from every character of a run (the square, the cube, or worse).
//
// The `text-cost.test.ts` of each package walks ONE list of hostile texts through every such function of the
// package with the helpers here: a text at one size and at sixteen times that size, measured in processor time of
// the test's own process. Sixteen times the text costs about sixteen times as much when the cost is proportional
// and 256 times as much when it grows with the square: the line between the two (64 times) has a factor of four to
// either side for whatever else the machine does.
//
// No imports (the web app's tests load this entry too): a test hands in the sources it read.

/** One character each of the kinds an expression treats differently: a hostile text is a long run of one of them. */
const SINGLES: Readonly<Record<string, string>> = {
  space: ' ',
  tab: '\t',
  hash: '#',
  star: '*',
  hyphen: '-',
  pipe: '|',
  backtick: '`',
  'greater-than': '>',
  'closing parenthesis': ')',
  dot: '.',
  slash: '/',
  letter: 'a',
  'a combining mark': '\u0301',
  'a half-width voiced sound mark': '\uff9e',
};

/** More of them, each alone: what a line, a field, a quotation, a command and an escape sequence are made of. */
const MORE_SINGLES: Readonly<Record<string, string>> = {
  'line break': '\n',
  'carriage return': '\r',
  colon: ':',
  comma: ',',
  semicolon: ';',
  equals: '=',
  ampersand: '&',
  'less-than': '<',
  'opening parenthesis': '(',
  'opening bracket': '[',
  'closing bracket': ']',
  'opening brace': '{',
  'closing brace': '}',
  dollar: '$',
  backslash: '\\',
  'double quote': '"',
  'single quote': "'",
  underscore: '_',
  'exclamation mark': '!',
  'question mark': '?',
  at: '@',
  tilde: '~',
  digit: '1',
  escape: '\u001b',
  'a Chinese character': '\u5b57',
  'an emoji': '\u{1F600}',
  'a zero-width space': '\u200b',
  'a zero-width joiner': '\u200d',
  'a right-to-left override': '\u202e',
  'a lone surrogate': '\ud800',
};

/** Runs of several characters in turn that no pair of SINGLES gives. */
const MORE_TURNS: Readonly<Record<string, string>> = {
  'marks of two combining classes in turn': '\u0301\u0316',
  'a mark, a zero-width space and a mark of another class in turn': '\u0301\u200b\u0316\u200b',
  'a mark, a joiner and a mark of another class in turn': '\u0301\u200d\u0316\u200d',
  'a colon and a space in turn': ': ',
  'a comma and a space in turn': ', ',
  'a quote and a space in turn': '" ',
  'a dollar and an opening parenthesis in turn': '$(',
  'a bracket and its closing in turn': '[]',
  'a backslash and a backtick in turn': '\\`',
  'an escape and an opening bracket in turn': '\u001b[',
  'an escape, a bracket and an exclamation mark in turn': '\u001b[!',
  'a letter, a dot and a hyphen in turn': 'a.-',
};

export interface HostileText {
  readonly name: string;
  /** The text at about `chars` UTF-16 units. */
  make(chars: number): string;
}

type Unit = readonly [name: string, unit: string];

/** Every run: one character of SINGLES, two of them in turn, one of MORE_SINGLES, and MORE_TURNS. */
function units(): Unit[] {
  const out: Unit[] = Object.entries(SINGLES).map(([name, unit]) => [`a run of ${name}`, unit]);
  const singles = Object.entries(SINGLES);
  for (let a = 0; a < singles.length; a += 1) {
    for (let b = a + 1; b < singles.length; b += 1) {
      const [nameA, unitA] = singles[a] as [string, string];
      const [nameB, unitB] = singles[b] as [string, string];
      out.push([`${nameA} and ${nameB} in turn`, unitA + unitB]);
    }
  }
  for (const [name, unit] of Object.entries(MORE_SINGLES)) out.push([`a run of ${name}`, unit]);
  for (const [name, unit] of Object.entries(MORE_TURNS)) out.push([name, unit]);
  return out;
}

/** The runs that are also put behind a front: every run of one character, the turns of a blank with another, MORE_TURNS. */
function unitsBehindAFront(): Unit[] {
  const out: Unit[] = [];
  for (const [name, unit] of Object.entries(SINGLES)) {
    out.push([`a run of ${name}`, unit]);
    if (unit !== ' ') out.push([`space and ${name} in turn`, ` ${unit}`]);
  }
  for (const [name, unit] of Object.entries(MORE_SINGLES)) out.push([`a run of ${name}`, unit]);
  for (const [name, unit] of Object.entries(MORE_TURNS)) out.push([name, unit]);
  return out;
}

/**
 * The hostile texts: every run alone, the run with a letter behind it (what `x+$` is tried against from every
 * character) and the run cut into lines; and behind each of `fronts` (what the function under test looks for at the
 * start of a text or a line) the runs of unitsBehindAFront with a letter behind them, and as lines that each start
 * with the front.
 */
export function hostileTexts(fronts: readonly string[] = []): HostileText[] {
  const texts: HostileText[] = [];
  const repeat = (unit: string, chars: number): string => unit.repeat(Math.max(1, Math.floor(chars / unit.length)));
  for (const [name, unit] of units()) {
    texts.push({ name, make: (chars) => repeat(unit, chars) });
    texts.push({ name: `${name}, then a letter`, make: (chars) => `${repeat(unit, chars)}b` });
    texts.push({ name: `lines of ${name}`, make: (chars) => repeat(`${unit}\n`, chars) });
  }
  for (const front of fronts) {
    for (const [name, unit] of unitsBehindAFront()) {
      texts.push({ name: `${JSON.stringify(front)}, then ${name}, then a letter`, make: (chars) => `${front}${repeat(unit, chars)}b` });
      texts.push({ name: `lines of ${JSON.stringify(front)} and ${name}`, make: (chars) => repeat(`${front}${unit.repeat(8)}\n`, chars) });
    }
  }
  return texts;
}

/** Processor time this process has used, in milliseconds (not the time on the wall: the gate runs every project at once). */
export function cpuMs(): number {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1_000;
}

/** The cheapest of up to `rounds` runs, in milliseconds of processor time. One that is cheap enough is measured once. */
export function costOf(run: () => void, cheapEnough: number, rounds = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < rounds; round += 1) {
    const started = cpuMs();
    run();
    best = Math.min(best, cpuMs() - started);
    if (best <= cheapEnough) break;
  }
  return best;
}

/** A fixed piece of work of the kinds the measured functions do: strings built, searched and cut, a map filled. */
function referenceWork(): number {
  const seen = new Map<string, number>();
  let total = 0;
  for (let index = 0; index < 600_000; index += 1) {
    const text = `item-${index % 977} of ${index}`;
    const at = text.indexOf(' of ');
    total += Number(text.slice(at + 4)) + text.slice(5, at).length;
    seen.set(text.slice(0, 8), index);
    total += text.split(' ').length;
  }
  return total + seen.size;
}
/** What `referenceWork` took, in processor time, on the machine the absolute bounds were measured on (Apple M3, node 22). */
const REFERENCE_WORK_MS = 140;
let slowness: number | undefined;

/**
 * How many times slower than that machine this one is; never less than 1. An ABSOLUTE bound of a cost test ("this
 * text may take its budget and so much more", "this line is read within so many milliseconds") is multiplied by it:
 * a continuous-integration runner is several times slower, and a bound only the fast machine keeps says nothing
 * about the function. A bound on how the cost GROWS (sixteen times the text, at most sixty-four times the cost)
 * needs none. Measured once in a process: the cheapest of four runs.
 */
export function machineSlowness(): number {
  if (slowness === undefined) {
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 4; round += 1) {
      const started = cpuMs();
      referenceWork();
      best = Math.min(best, cpuMs() - started);
    }
    slowness = Math.max(1, best / REFERENCE_WORK_MS);
  }
  return slowness;
}

/** Below this, sixteen times the text may cost anything: the numbers are noise. */
export const NOISE_MS = 40;
export const TIMES = 16;
/** Between "in proportion" (16) and "with the square" (256). */
export const AT_MOST_TIMES = 64;
/** The larger of the two sizes a text is measured at, unless the function is never handed that much. */
export const LARGE_CHARS = 65_536;

/** A single run that takes this long is not noise: it is reported as it is, without a second measurement. */
const BEYOND_DOUBT_MS = 1_000;
/** After this many texts that cost too much, the walk of a function ends: the rest would only take longer to say the same. */
const REPORTED_MAX = 6;

export interface Look {
  readonly run: (text: string) => void;
  /** What this function looks for at the start of a text or of a line. */
  readonly fronts?: readonly string[];
  /** The larger size, where the function is handed more (or never as much) than LARGE_CHARS. */
  readonly chars?: number;
  /** The function refuses some texts by throwing (a refusal is an answer: what is measured is how long it took). */
  readonly throws?: true;
}

/**
 * The hostile texts for which `look.run` costs far more than sixteen times as much at sixteen times the size, each
 * with what was measured. Empty when the cost is in proportion for all of them.
 */
export function disproportionate(look: Look): string[] {
  const chars = look.chars ?? LARGE_CHARS;
  const run = (text: string) => (): void => {
    if (look.throws !== true) look.run(text);
    else {
      try {
        look.run(text);
      } catch {
        // Refused.
      }
    }
  };
  // On an ordinary text the function answers: a look that only throws would measure nothing.
  if (look.throws !== true) look.run('An ordinary text.');
  const slow: string[] = [];
  for (const text of hostileTexts(look.fronts)) {
    if (slow.length >= REPORTED_MAX) {
      slow.push('(the texts after these were not measured)');
      break;
    }
    const small = run(text.make(Math.floor(chars / TIMES)));
    const large = run(text.make(chars));
    let one = costOf(small, NOISE_MS / AT_MOST_TIMES);
    let many = costOf(large, Math.max(NOISE_MS, one * TIMES));
    const tooMuch = (): boolean => many > Math.max(NOISE_MS, one * AT_MOST_TIMES);
    if (tooMuch() && many < BEYOND_DOUBT_MS) {
      // Said twice before it is believed: a function that makes a lot of garbage is charged for its collection now and then.
      one = costOf(small, 0, 5);
      many = costOf(large, Math.max(NOISE_MS, one * TIMES), 5);
    }
    if (tooMuch() && many < BEYOND_DOUBT_MS) {
      // Still close to the line (a loaded machine): a third size settles it. Four times the text again costs about
      // four times as much when the cost is in proportion, sixteen times as much when it grows with the square.
      const most = costOf(run(text.make(chars * 4)), 0, 3);
      if (most <= many * 8) continue;
    }
    if (tooMuch()) slow.push(`${text.name}: ${one.toFixed(2)} ms for ${Math.floor(chars / TIMES)} characters, ${many.toFixed(0)} ms for ${chars}`);
  }
  return slow;
}

// ---- what the sources hold

/** A regular expression in a line of source: a literal after something a value can follow, or `new RegExp(`. */
const EXPRESSION = /(?:^|[=(,:?!&|[{;>]|\breturn|\btypeof)\s*\/(?![/*\s>])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuvy]*(?=\s*[.,;)\]}\n]|\s*$)|new RegExp\(/gm;
/** What compares or orders text at a cost of its own: `normalize`, a collation, a sort. */
const ORDERING = /\.normalize\(|\.localeCompare\(|Intl\.Collator|\.sort\(|\.toSorted\(/g;
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

/** Whether a file below a package's `src` is one of its sources (`.ts` or `.mjs`, not a test). */
export function isSourceName(name: string): boolean {
  return (name.endsWith('.ts') || name.endsWith('.mjs')) && !name.endsWith('.test.ts');
}

export interface SourceCounts {
  /** How many regular expressions each source file holds (files with none are left out). */
  readonly expressions: Record<string, number>;
  /** How many calls of `normalize`, `localeCompare`, a collator or a sort each source file holds. */
  readonly orderings: Record<string, number>;
}

/** Counts them in `sources`: the text of each source file by its path below `src` (with `/`). Comment lines are not read. */
export function countInSources(sources: Readonly<Record<string, string>>): SourceCounts {
  const expressions: Record<string, number> = {};
  const orderings: Record<string, number> = {};
  for (const name of Object.keys(sources).sort()) {
    let found = 0;
    let ordered = 0;
    for (const line of (sources[name] as string).split('\n')) {
      if (COMMENT.test(line)) continue;
      found += [...line.matchAll(EXPRESSION)].length;
      ordered += [...line.matchAll(ORDERING)].length;
    }
    if (found > 0) expressions[name] = found;
    if (ordered > 0) orderings[name] = ordered;
  }
  return { expressions, orderings };
}
