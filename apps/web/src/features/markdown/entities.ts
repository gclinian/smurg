// marked's lexer hands out text that is already escaped for an HTML renderer (`&` → `&amp;`, `<` → `&lt;`, …; an
// entity the author wrote, `&copy;`, is left as it is). This renderer builds React text nodes, which escape by
// themselves, so every such text is decoded first: ONE pass, so `&amp;lt;` becomes `&lt;` and not `<`.
//
// A numeric reference never becomes a character a reader cannot see: `&#x202E;` (a bidirectional override),
// `&#8203;` (a zero-width space) or `&#27;` (a control) stay the characters that were typed. What a person wrote is
// cleaned of such characters before it is stored (`agentText`); a reference to one is plain ASCII and passes that
// cleaning, and decoded here it would put on the page what the agent never got.
//
// Nothing here parses HTML and nothing is ever handed to the DOM as markup: the result is a plain string.
import { hasInvisibleCharacters } from '@smurg/protocol';

/** The named references people and agents actually write; any other name stays as it was typed. */
const NAMED: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  times: '×',
  divide: '÷',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  deg: '°',
  micro: 'µ',
  middot: '·',
  bull: '•',
  sect: '§',
  para: '¶',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  check: '✓',
  cross: '✗',
});

const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,15}));/g;

function fromCodePoint(code: number, whole: string): string {
  // Not a character a text may hold (NUL, a surrogate, beyond Unicode): leave what was written.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
  const char = String.fromCodePoint(code);
  return hasInvisibleCharacters(char) ? whole : char;
}

/** The text a character reference stands for; an unknown name is left as typed. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10), whole);
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16), whole);
    const key = name as string;
    return Object.hasOwn(NAMED, key) ? (NAMED[key] as string) : whole;
  });
}
