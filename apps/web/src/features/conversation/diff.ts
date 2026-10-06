// A unified diff as lines for the diff view of a tool card and of a permission card (a person never allows an edit
// they cannot see). The daemon sends the diff as text: with hunk headers (`@@ -41,3 +41,4 @@`) the lines get their
// numbers; without any header (a new file, a short result) they are counted from 1; under a header that has no
// numbers (`@@ replacement 1 of 2 @@`: the file could not be read or diffed) they have none.
//
// The file heading is the daemon's own two lines and nothing else: `--- a/<path>` (or `--- /dev/null`) directly
// followed by `+++ b/<path>`, as the FIRST two lines. Everywhere else a line that starts with "+" is an added line and
// one that starts with "-" a removed line, whatever follows the sign: the added line `++n;` arrives as `+++n;` and the
// removed SQL comment `-- old` as `--- old`, and both must be drawn as the changes they are.
export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The line's number in the new file (for a removed line: in the old file); null for headers. */
  readonly number: number | null;
  readonly text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** A heading the daemon wrote where it had no line numbers. */
const PLAIN_HUNK = /^@@ .* @@$/;

export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let numbered = true;
  const source = diff.endsWith('\n') ? diff.slice(0, -1) : diff;
  if (source === '') return lines;
  const raws = source.split('\n');
  let start = 0;
  if (raws.length >= 2 && (raws[0] as string).startsWith('--- ') && (raws[1] as string).startsWith('+++ ')) {
    lines.push({ kind: 'meta', number: null, text: raws[0] as string }, { kind: 'meta', number: null, text: raws[1] as string });
    start = 2;
  }
  for (let index = start; index < raws.length; index++) {
    const raw = raws[index] as string;
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      numbered = true;
      lines.push({ kind: 'hunk', number: null, text: raw });
    } else if (PLAIN_HUNK.test(raw)) {
      numbered = false;
      lines.push({ kind: 'hunk', number: null, text: raw });
    } else if (raw.startsWith('\\ ')) {
      // "\ No newline at end of file": the only line of a diff's body that has no sign.
      lines.push({ kind: 'meta', number: null, text: raw });
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', number: numbered ? newLine++ : null, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', number: numbered ? oldLine++ : null, text: raw.slice(1) });
    } else {
      lines.push({ kind: 'context', number: numbered ? newLine++ : null, text: raw.startsWith(' ') ? raw.slice(1) : raw });
      oldLine++;
    }
  }
  return lines;
}

/** How many lines a diff adds and removes. */
export function diffStat(lines: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === 'add') additions++;
    else if (line.kind === 'del') deletions++;
  }
  return { additions, deletions };
}
