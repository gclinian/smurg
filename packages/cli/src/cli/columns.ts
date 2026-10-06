// Columns of the lists the CLI prints (`smurg attach`): padding and clipping by DISPLAY width, not by string length.
// A Chinese label, topic name or title takes two terminal cells per character; counted by `String.length` a column of
// such cells drifts away from its header. This is the usual East Asian Width approximation (wide and fullwidth forms
// are two cells, combining marks and joiners none); it is for alignment only, never for security.

/** Code point ranges a terminal draws two cells wide (CJK, Hangul, kana, fullwidth forms, emoji). */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Code point ranges that take no cell of their own (combining marks, zero-width characters, variation selectors). */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

const within = (ranges: readonly (readonly [number, number])[], code: number): boolean => ranges.some(([from, to]) => code >= from && code <= to);

function cellsOf(code: number): number {
  if (within(ZERO, code)) return 0;
  return within(WIDE, code) ? 2 : 1;
}

/** How many terminal cells `text` takes. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += cellsOf(char.codePointAt(0) as number);
  return width;
}

/** `text` followed by spaces up to `width` cells (a longer text is returned as it is). */
export function padColumn(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** `text` cut to at most `width` cells; a cut text ends with `...` (ASCII, as all of the CLI's own output). */
export function clipColumn(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const mark = '...';
  let out = '';
  let used = 0;
  for (const char of text) {
    const cells = cellsOf(char.codePointAt(0) as number);
    if (used + cells > width - mark.length) break;
    out += char;
    used += cells;
  }
  return out + mark;
}
