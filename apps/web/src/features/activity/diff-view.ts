// The side-by-side view of one conflict hunk (SPEC R8 衝突面板): the human text that was kept on the left, the agent's
// (or another process's) text on the right, lines aligned by a line-level LCS so that unchanged lines sit next to
// each other and changed ones are marked. Pure and bounded: hunk texts are at most 64 KiB each, and a hunk whose LCS
// table would exceed DIFF_MAX_CELLS falls back to pairing lines by position (still exact text, only coarser marks).

export interface DiffCell {
  /** 1-based line number in the document (left side only: the agent's own numbering is not known). */
  readonly line: number | null;
  readonly text: string;
  /** Differs from the other side. */
  readonly changed: boolean;
}

export interface DiffRow {
  readonly human: DiffCell | null;
  readonly agent: DiffCell | null;
}

/** Upper bound of the LCS table (n × m cells after trimming the common prefix and suffix). */
export const DIFF_MAX_CELLS = 400_000;

/** Lines of a hunk text; a final newline does not add an empty last line. CR stays visible as part of the line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

type Op = { readonly kind: 'equal'; readonly h: number; readonly a: number } | { readonly kind: 'human'; readonly h: number } | { readonly kind: 'agent'; readonly a: number };

/** Line operations turning `human` into `agent` (LCS; positional when too large). */
function lineOps(human: readonly string[], agent: readonly string[]): Op[] {
  let start = 0;
  while (start < human.length && start < agent.length && human[start] === agent[start]) start++;
  let endH = human.length;
  let endA = agent.length;
  while (endH > start && endA > start && human[endH - 1] === agent[endA - 1]) {
    endH--;
    endA--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'equal', h: i, a: i });
  const n = endH - start;
  const m = endA - start;
  if (n > 0 && m > 0 && n * m <= DIFF_MAX_CELLS) {
    // lcs[i][j] = LCS length of human[start+i..endH) and agent[start+j..endA), in one flat array.
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          human[start + i] === agent[start + j] ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (human[start + i] === agent[start + j]) {
        ops.push({ kind: 'equal', h: start + i, a: start + j });
        i++;
        j++;
      } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
        ops.push({ kind: 'human', h: start + i });
        i++;
      } else {
        ops.push({ kind: 'agent', a: start + j });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ kind: 'human', h: start + i });
    for (; j < m; j++) ops.push({ kind: 'agent', a: start + j });
  } else {
    for (let i = 0; i < n; i++) ops.push({ kind: 'human', h: start + i });
    for (let j = 0; j < m; j++) ops.push({ kind: 'agent', a: start + j });
  }
  for (let k = 0; k < human.length - endH; k++) ops.push({ kind: 'equal', h: endH + k, a: endA + k });
  return ops;
}

/**
 * Rows for a side-by-side table. Runs of lines only one side has are paired up row by row (a changed line appears
 * next to what replaced it); the longer run leaves empty cells on the other side.
 */
export function sideBySide(humanText: string, agentText: string, startLine: number): DiffRow[] {
  const human = splitLines(humanText);
  const agent = splitLines(agentText);
  const ops = lineOps(human, agent);
  const rows: DiffRow[] = [];
  const cellH = (h: number, changed: boolean): DiffCell => ({ line: startLine + h, text: human[h] ?? '', changed });
  const cellA = (a: number, changed: boolean): DiffCell => ({ line: null, text: agent[a] ?? '', changed });
  let pendingH: number[] = [];
  let pendingA: number[] = [];
  const flush = (): void => {
    const count = Math.max(pendingH.length, pendingA.length);
    for (let k = 0; k < count; k++) {
      const h = pendingH[k];
      const a = pendingA[k];
      rows.push({ human: h === undefined ? null : cellH(h, true), agent: a === undefined ? null : cellA(a, true) });
    }
    pendingH = [];
    pendingA = [];
  };
  for (const op of ops) {
    if (op.kind === 'equal') {
      flush();
      rows.push({ human: cellH(op.h, false), agent: cellA(op.a, false) });
    } else if (op.kind === 'human') pendingH.push(op.h);
    else pendingA.push(op.a);
  }
  flush();
  return rows;
}
