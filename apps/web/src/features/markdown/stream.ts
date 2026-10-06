// A streaming block grows by a few words at a time, and parsing all of it again for every piece costs more the longer
// it gets. The part before a STABLE CUT never parses differently however the text continues, so it is parsed once.
//
// A cut is the start of a line that
//   - is not inside a fenced code block,
//   - follows a blank line,
//   - and starts a block of its own: not white space (a list item's continuation, indented code), not a list marker,
//     a quote or a table row (those may still be continued by the line itself or belong to the block above).
// The line may be unfinished (it is the one being written), so a line whose first characters could still become a
// list marker (digits, "-", "*", "+") is never a cut until it is complete.

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  readonly char: string;
  readonly length: number;
}

function fenceOpening(line: string): Fence | null {
  const match = FENCE.exec(line);
  if (!match) return null;
  const marks = match[1] as string;
  // An opening line of backticks may not hold another backtick (that is inline code).
  if (marks[0] === '`' && (match[2] as string).includes('`')) return null;
  return { char: marks[0] as string, length: marks.length };
}

function closesFence(line: string, open: Fence): boolean {
  const match = FENCE.exec(line);
  if (!match) return false;
  const marks = match[1] as string;
  return marks[0] === open.char && marks.length >= open.length && (match[2] as string).trim() === '';
}

/** A complete line that continues, or could continue, the block above it. */
const CONTINUES = /^(?:[ \t]|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|\|)/;
/** An unfinished line: anything that may still turn into one of the above. */
const MAY_CONTINUE = /^(?:[ \t>|]|[-*+]|\d)/;

/**
 * The length of the longest prefix of `text` that ends at a stable cut. `from` is an earlier result for a prefix of
 * the same text (scanning starts there); 0 means nothing is known. The result is never smaller than `from`.
 */
export function stableLength(text: string, from = 0): number {
  let cut = from;
  let fence: Fence | null = null;
  let previousBlank = false;
  let index = from;
  while (index < text.length) {
    const newline = text.indexOf('\n', index);
    const complete = newline !== -1;
    const end = complete ? newline : text.length;
    const line = text.slice(index, end);
    if (fence !== null) {
      if (complete && closesFence(line, fence)) fence = null;
      previousBlank = false;
    } else {
      const blank = line.trim() === '';
      if (!blank) {
        if (previousBlank && index > cut && !(complete ? CONTINUES : MAY_CONTINUE).test(line)) cut = index;
        // An unfinished line is the last one: whether it opens a fence no longer matters to this scan.
        if (complete) fence = fenceOpening(line);
      }
      previousBlank = blank;
    }
    if (!complete) break;
    index = end + 1;
  }
  return cut;
}
