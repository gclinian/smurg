// Unicode normalisation at a cost in proportion to the text. THE ONLY PLACE of packages/protocol, packages/daemon
// and packages/cli that calls `String.prototype.normalize` (each package's text-cost test keeps it so).
//
// `normalize` puts every run of combining marks into the canonical order by comparing the marks of the run with each
// other: marks of two combining classes in turn cost the square of the run's length (measured on V8 with ICU 78:
// 60 ms for 16,000 marks, 1 s for 64,000, on the daemon's one thread). A member can put such a run into a message, a
// suggestion, a name or a path, an agent into anything it writes.
//
// So no run of marks longer than MARK_RUN_MAX ever reaches `normalize`: free text is cut (`withFewMarks`), a path is
// refused (`hasLongMarkRun` in schema/paths.ts: cutting a name would name another file). The bound is Unicode's own
// for text that can be normalised as it streams (UAX #15, "Stream-Safe Text Format": at most 30 characters without
// a place of their own in a row, "significantly beyond what is required for any linguistic or technical usage").
//
// Pure, no imports: browser, Worker and Node safe.

/** The longest run of combining marks that is kept. No word of any language has more on one letter. */
export const MARK_RUN_MAX = 30;

// What counts as a mark: every code point of the category Mark (all the characters `normalize` reorders are in it),
// and the two half-width Katakana sound marks, which are letters until a compatibility form (NFKC, NFKD) turns them
// into the combining ones (U+3099, U+309A). The protocol's text-cost test walks every code point to keep this the
// whole list.
const ONE_MARK = /^[\p{M}\uff9e\uff9f]$/u;
const FIRST_MARK_UNIT = 0x300;

/** Which UTF-16 units below U+10000 are marks: read from the engine's own tables at the first use (a few milliseconds). */
let bmpMarks: Uint8Array | null = null;

function bmpMarkTable(): Uint8Array {
  const table = new Uint8Array(0x10000);
  for (let unit = FIRST_MARK_UNIT; unit < 0x10000; unit += 1) {
    if ((unit < 0xd800 || unit > 0xdfff) && ONE_MARK.test(String.fromCharCode(unit))) table[unit] = 1;
  }
  return table;
}

/** The number of UTF-16 units of the mark that starts at `index` (1 or 2), or 0 when no mark starts there. */
function markAt(text: string, index: number, unit: number): 0 | 1 | 2 {
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff && ONE_MARK.test(text.slice(index, index + 2)) ? 2 : 0;
  }
  bmpMarks ??= bmpMarkTable();
  return bmpMarks[unit] === 1 ? 1 : 0;
}

/** Whether `text` holds a run of more than MARK_RUN_MAX combining marks. One pass. */
export function hasLongMarkRun(text: string): boolean {
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < FIRST_MARK_UNIT) {
      run = 0;
      continue;
    }
    const size = markAt(text, index, unit);
    if (size === 0) run = 0;
    else {
      run += 1;
      if (run > MARK_RUN_MAX) return true;
      index += size - 1;
    }
  }
  return false;
}

/** `text` with every run of combining marks cut to its first MARK_RUN_MAX. One pass; the same string when nothing is cut. */
export function withFewMarks(text: string): string {
  let pieces: string[] | null = null;
  let from = 0;
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < FIRST_MARK_UNIT) {
      run = 0;
      continue;
    }
    const size = markAt(text, index, unit);
    if (size === 0) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > MARK_RUN_MAX) {
      pieces ??= [];
      if (index > from) pieces.push(text.slice(from, index));
      from = index + size;
    }
    index += size - 1;
  }
  if (pieces === null) return text;
  pieces.push(text.slice(from));
  return pieces.join('');
}

export type NormalForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

/**
 * `text` in the normal form `form`, with every run of more than MARK_RUN_MAX combining marks cut to that many first.
 * What it costs is in proportion to the text.
 */
export function normalized(text: string, form: NormalForm): string {
  return withFewMarks(text).normalize(form);
}
