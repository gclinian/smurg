// Bounded, surrogate-safe, exact character diff for "disk changed from A to B" (ARCHITECTURE §7.5 smartDiffer3;
// ported from the verified spike yjs-monaco-verify/verify/smartDiffer3.ts, yjs-monaco.md Q4 + V1).
//
//  1. Strip the common prefix and suffix without cutting a surrogate pair (Yjs turns a split pair into U+FFFD on
//     every replica, F2).
//  2. A middle of ≤ charDiffLimit (4K) UTF-16 units goes to fast-diff directly (minimal, surrogate-safe, worst case
//     about 75 ms). Larger middles never reach fast-diff whole: it has no time bound (9.3 s for a 64 KB rewrite, F7).
//  3. Otherwise a line-level Myers diff (jsdiff diffArrays WITH a timeout). Each changed block is refined with
//     fast-diff when small, or line pair by line pair when as many lines were removed as added (formatter, re-indent,
//     rename: keeps remote cursors on their characters, V1), within a time budget; the rest is replaced coarsely.
// Applying the result to A always yields B exactly.
//
// This module is loaded by the compute worker (compute-worker.ts): keep its imports to fast-diff and diff.
import fastDiff from 'fast-diff';
import { diffArrays } from 'diff';

/** 0 = keep, -1 = delete, 1 = insert; lengths are UTF-16 code units (= Y.Text indexes). */
export type DiffOp = readonly [-1 | 0 | 1, string];

/**
 * The compact form sent back from the worker and applied to a Y.Text: a positive number keeps that many units, a
 * negative number deletes that many, a string is inserted. Kept text never travels.
 */
export type CompactOp = number | string;

export interface SmartDiffOptions {
  readonly charDiffLimit?: number;
  readonly lineTimeoutMs?: number;
  readonly refineBudgetMs?: number;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Splits into lines that keep their '\n' (the last line may lack one). */
export function splitKeepNewline(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length - 1;
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  return out;
}

export function smartDiff(a: string, b: string, options: SmartDiffOptions = {}): DiffOp[] {
  const charDiffLimit = options.charDiffLimit ?? 4096;
  const lineTimeoutMs = options.lineTimeoutMs ?? 300;
  const refineBudgetMs = options.refineBudgetMs ?? 150;
  if (a === b) return a.length > 0 ? [[0, a]] : [];
  let pre = 0;
  const max = Math.min(a.length, b.length);
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  if (pre > 0 && isHigh(a.charCodeAt(pre - 1))) pre--; // never end the prefix inside a pair
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  if (suf > 0 && isLow(a.charCodeAt(a.length - suf))) suf--; // never start the suffix inside a pair
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const out: DiffOp[] = [];
  if (pre > 0) out.push([0, a.slice(0, pre)]);
  if (am.length + bm.length <= charDiffLimit) {
    for (const op of fastDiff(am, bm)) out.push(op as DiffOp);
  } else {
    for (const op of lineLevel(am, bm)) out.push(op);
  }
  if (suf > 0) out.push([0, a.slice(a.length - suf)]);
  return out;

  function lineLevel(x: string, y: string): DiffOp[] {
    const xl = splitKeepNewline(x);
    const yl = splitKeepNewline(y);
    const changes = diffArrays(xl, yl, { timeout: lineTimeoutMs });
    const result: DiffOp[] = [];
    const deadline = performance.now() + refineBudgetMs;
    if (!changes) {
      // Timed out. jsdiff is O(N·D) and D = 2N when every line changed, so a formatter or re-indent of a few thousand
      // lines always lands here (5,000 lines: 2.3 s). With as many lines on both sides, pair them positionally: exact
      // either way, and it keeps cursors on their characters for exactly those rewrites.
      if (xl.length !== yl.length) return [[-1, x], [1, y]];
      for (let k = 0; k < xl.length; k++) {
        const d = xl[k] as string;
        const i = yl[k] as string;
        if (d === i) result.push([0, d]);
        else if (d.length + i.length <= charDiffLimit && performance.now() < deadline) for (const op of fastDiff(d, i)) result.push(op as DiffOp);
        else {
          result.push([-1, d]);
          result.push([1, i]);
        }
      }
      return result;
    }
    const coarse = (del: string, ins: string): void => {
      if (del) result.push([-1, del]);
      if (ins) result.push([1, ins]);
    };
    let removed: string[] = [];
    let added: string[] = [];
    const flush = (): void => {
      if (removed.length === 0 && added.length === 0) return;
      const del = removed.join('');
      const ins = added.join('');
      if (!del || !ins || performance.now() >= deadline) coarse(del, ins);
      else if (del.length + ins.length <= charDiffLimit) for (const op of fastDiff(del, ins)) result.push(op as DiffOp);
      else if (removed.length === added.length) {
        for (let k = 0; k < removed.length; k++) {
          const d = removed[k] as string;
          const i = added[k] as string;
          if (d.length + i.length <= charDiffLimit && performance.now() < deadline) for (const op of fastDiff(d, i)) result.push(op as DiffOp);
          else coarse(d, i);
        }
      } else coarse(del, ins);
      removed = [];
      added = [];
    };
    for (const change of changes) {
      if (change.added) added.push(...change.value);
      else if (change.removed) removed.push(...change.value);
      else {
        flush();
        result.push([0, change.value.join('')]);
      }
    }
    flush();
    return result;
  }
}

/** DiffOp[] → CompactOp[], merging neighbours of the same kind. */
export function compactOps(ops: readonly DiffOp[]): CompactOp[] {
  const out: CompactOp[] = [];
  for (const [kind, text] of ops) {
    if (text.length === 0) continue;
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (kind === 1) {
      if (typeof last === 'string') out[out.length - 1] = last + text;
      else out.push(text);
    } else {
      const n = kind === 0 ? text.length : -text.length;
      if (typeof last === 'number' && Math.sign(last) === Math.sign(n)) out[out.length - 1] = last + n;
      else out.push(n);
    }
  }
  // A trailing keep carries no information.
  if (out.length > 0 && typeof out[out.length - 1] === 'number' && (out[out.length - 1] as number) > 0) out.pop();
  return out;
}

/** Applies compact ops to a plain string (tests, and the worker's own self-check). */
export function applyCompactOpsToString(text: string, ops: readonly CompactOp[]): string {
  let out = '';
  let index = 0;
  for (const op of ops) {
    if (typeof op === 'string') out += op;
    else if (op > 0) {
      out += text.slice(index, index + op);
      index += op;
    } else index += -op;
  }
  return out + text.slice(index);
}

/**
 * Fewer operations for the same result: consecutive groups of operations become one delete + one insert of their
 * changed span (keeps around the span stay keeps). Cursors inside a replaced span move to its start; everything
 * else stays put. `old` is the text the ops apply to.
 */
export function coarsenOps(old: string, ops: readonly CompactOp[], maxOps: number): CompactOp[] {
  if (ops.length <= maxOps) return [...ops];
  const groupSize = Math.ceil(ops.length / Math.max(1, Math.floor(maxOps / 3)));
  const out: CompactOp[] = [];
  const pushKeep = (n: number): void => {
    if (n <= 0) return;
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (typeof last === 'number' && last > 0) out[out.length - 1] = last + n;
    else out.push(n);
  };
  let pos = 0;
  for (let start = 0; start < ops.length; start += groupSize) {
    const group = ops.slice(start, start + groupSize);
    const first = group.findIndex((op) => !(typeof op === 'number' && op > 0));
    if (first === -1) {
      for (const op of group) pushKeep(op as number);
      pos += group.reduce<number>((sum, op) => sum + (op as number), 0);
      continue;
    }
    let last = group.length - 1;
    while (typeof group[last] === 'number' && (group[last] as number) > 0) last--;
    for (let k = 0; k < first; k++) {
      pushKeep(group[k] as number);
      pos += group[k] as number;
    }
    let del = 0;
    let ins = '';
    for (let k = first; k <= last; k++) {
      const op = group[k] as CompactOp;
      if (typeof op === 'string') ins += op;
      else if (op > 0) {
        ins += old.slice(pos, pos + op);
        del += op;
        pos += op;
      } else {
        del += -op;
        pos += -op;
      }
    }
    if (del > 0) out.push(-del);
    if (ins.length > 0) out.push(ins);
    for (let k = last + 1; k < group.length; k++) {
      pushKeep(group[k] as number);
      pos += group[k] as number;
    }
  }
  return out;
}

/**
 * A single coarse replace of the changed middle (common prefix/suffix kept, surrogate-safe). Used when a fine diff
 * would produce more Y.Text operations than one transaction should carry.
 */
export function coarseOps(a: string, b: string): CompactOp[] {
  if (a === b) return [];
  let pre = 0;
  const max = Math.min(a.length, b.length);
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  if (pre > 0 && isHigh(a.charCodeAt(pre - 1))) pre--;
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  if (suf > 0 && isLow(a.charCodeAt(a.length - suf))) suf--;
  const out: CompactOp[] = [];
  if (pre > 0) out.push(pre);
  if (a.length - suf - pre > 0) out.push(-(a.length - suf - pre));
  if (b.length - suf - pre > 0) out.push(b.slice(pre, b.length - suf));
  return out;
}
