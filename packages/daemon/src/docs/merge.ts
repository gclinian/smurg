// Line-based three-way merge for the R8 fallback (ARCHITECTURE §7.5; ported from the verified spike
// yjs-monaco/src/diff3.ts + threeWayReconcile.ts, yjs-monaco.md Q5 + V4).
//
//   base   = lockBase while a human edit lock is held (the disk text when the lock was taken), else the last text
//            known to be on disk
//   ours   = the current Y.Text (the humans' text, possibly unsaved)
//   theirs = the new disk text (agent, sed, formatter, git checkout)
//
// Non-overlapping hunks of both sides are combined; hunks that overlap OR touch (adjacent lines) are conflicts, as in
// git. A conflict keeps OUR (human) lines; the agent's lines go to the conflict panel. So the human's text is never
// lost (R8.4), including when a Bash write was built from a stale copy (V4, why `base` is lockBase).
//
// The region algorithm is node-diff3's diff3MergeRegions, re-implemented on jsdiff's O(ND) Myers `diffArrays` with a
// timeout (node-diff3's LCS takes 154 s on 10k repetitive lines, F8). Lines are split on '\n' only, keeping
// everything, so "no trailing newline" and any '\r' round-trip exactly.
//
// Loaded by the compute worker: keep its imports to `diff`.
import { diffArrays } from 'diff';

export interface MergeConflict {
  /** 0-based line range [start, end) in `merged` holding the human text that was kept. */
  readonly mergedStartLine: number;
  readonly mergedEndLine: number;
  /** 0-based line in `theirs` where the agent's version of this region starts. */
  readonly theirsStartLine: number;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

export interface MergeResult {
  readonly merged: string;
  readonly conflicts: MergeConflict[];
  /** A diff timed out: the whole changed middle became one conflict (all human text kept). */
  readonly timedOut: boolean;
}

interface Hunk {
  oStart: number;
  oLength: number;
  xStart: number;
  xLength: number;
}

type Region =
  | { readonly stable: true; readonly lines: readonly string[] }
  | { readonly stable: false; readonly a: readonly string[]; readonly o: readonly string[]; readonly b: readonly string[]; readonly bStart: number };

/** Hunks turning `o` into `x`, or null if the diff timed out. */
function lineHunks(o: readonly string[], x: readonly string[], timeoutMs: number): Hunk[] | null {
  const changes = diffArrays(o as string[], x as string[], { timeout: timeoutMs });
  if (!changes) return null;
  const hunks: Hunk[] = [];
  let oi = 0;
  let xi = 0;
  let current: Hunk | null = null;
  for (const change of changes) {
    const n = change.count ?? change.value.length;
    if (!change.added && !change.removed) {
      if (current) {
        hunks.push(current);
        current = null;
      }
      oi += n;
      xi += n;
      continue;
    }
    if (!current) current = { oStart: oi, oLength: 0, xStart: xi, xLength: 0 };
    if (change.removed) {
      current.oLength += n;
      oi += n;
    } else {
      current.xLength += n;
      xi += n;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Regions of a three-way merge of `a` (ours) and `b` (theirs) against `o` (base), or null on a diff timeout. */
function diff3Regions(a: readonly string[], o: readonly string[], b: readonly string[], timeoutMs: number): Region[] | null {
  const ha = lineHunks(o, a, timeoutMs);
  const hb = ha && lineHunks(o, b, timeoutMs);
  if (!ha || !hb) return null;
  type SideHunk = Hunk & { readonly side: 'a' | 'b' };
  const hunks: SideHunk[] = [...ha.map((h) => ({ ...h, side: 'a' as const })), ...hb.map((h) => ({ ...h, side: 'b' as const }))].sort(
    (p, q) => p.oStart - q.oStart,
  );
  const out: Region[] = [];
  let cursor = 0;
  const advanceTo = (end: number): void => {
    if (end > cursor) out.push({ stable: true, lines: o.slice(cursor, end) });
    cursor = Math.max(cursor, end);
  };
  let i = 0;
  while (i < hunks.length) {
    const first = hunks[i++] as SideHunk;
    const group: SideHunk[] = [first];
    const regionStart = first.oStart;
    let regionEnd = first.oStart + first.oLength;
    // Hunks that overlap OR touch (start == regionEnd) the region join it: adjacent edits conflict.
    while (i < hunks.length && (hunks[i] as SideHunk).oStart <= regionEnd) {
      const next = hunks[i++] as SideHunk;
      regionEnd = Math.max(regionEnd, next.oStart + next.oLength);
      group.push(next);
    }
    advanceTo(regionStart);
    const sides = new Set(group.map((h) => h.side));
    if (sides.size === 1) {
      const source = first.side === 'a' ? a : b;
      const lo = Math.min(...group.map((h) => h.xStart));
      const hi = Math.max(...group.map((h) => h.xStart + h.xLength));
      out.push({ stable: true, lines: source.slice(lo, hi) });
    } else {
      const span = (side: 'a' | 'b'): readonly [number, number] => {
        const hs = group.filter((h) => h.side === side);
        const oLo = Math.min(...hs.map((h) => h.oStart));
        const oHi = Math.max(...hs.map((h) => h.oStart + h.oLength));
        const xLo = Math.min(...hs.map((h) => h.xStart));
        const xHi = Math.max(...hs.map((h) => h.xStart + h.xLength));
        return [xLo + (regionStart - oLo), xHi + (regionEnd - oHi)];
      };
      const [aLo, aHi] = span('a');
      const [bLo, bHi] = span('b');
      out.push({ stable: false, a: a.slice(aLo, aHi), o: o.slice(regionStart, regionEnd), b: b.slice(bLo, bHi), bStart: bLo });
    }
    cursor = regionEnd;
  }
  advanceTo(o.length);
  return out;
}

export function threeWayReconcile(base: string, ours: string, theirs: string, timeoutMs = 500): MergeResult {
  if (theirs === base || theirs === ours) return { merged: ours, conflicts: [], timedOut: false };
  if (ours === base) return { merged: theirs, conflicts: [], timedOut: false };
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  // Lines common to all three at both ends (cheap, and shrinks the Myers problem).
  let pre = 0;
  const minLen = Math.min(b.length, o.length, t.length);
  while (pre < minLen && b[pre] === o[pre] && b[pre] === t[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && b[b.length - 1 - suf] === o[o.length - 1 - suf] && b[b.length - 1 - suf] === t[t.length - 1 - suf]) suf++;
  const bMid = b.slice(pre, b.length - suf);
  const oMid = o.slice(pre, o.length - suf);
  const tMid = t.slice(pre, t.length - suf);

  const out: string[] = o.slice(0, pre);
  const conflicts: MergeConflict[] = [];
  const pushConflict = (oursLines: readonly string[], baseLines: readonly string[], theirsLines: readonly string[], theirsStart: number): void => {
    const start = out.length;
    for (const line of oursLines) out.push(line); // keep the human text
    conflicts.push({
      mergedStartLine: start,
      mergedEndLine: out.length,
      theirsStartLine: pre + theirsStart,
      base: baseLines.join('\n'),
      ours: oursLines.join('\n'),
      theirs: theirsLines.join('\n'),
    });
  };
  // Argument order (a, o, b) = (ours, base, theirs).
  const regions = diff3Regions(oMid, bMid, tMid, timeoutMs);
  if (regions === null) {
    // Timed out: be conservative, keep all human text; the agent's whole middle goes to the conflict panel.
    pushConflict(oMid, bMid, tMid, 0);
  } else {
    for (const region of regions) {
      if (region.stable) for (const line of region.lines) out.push(line);
      else if (region.a.length === region.b.length && region.a.every((line, k) => line === region.b[k])) {
        for (const line of region.a) out.push(line); // both sides made the same change: not a conflict
      } else pushConflict(region.a, region.o, region.b, region.bStart);
    }
  }
  for (const line of o.slice(o.length - suf)) out.push(line);
  return { merged: out.join('\n'), conflicts, timedOut: regions === null };
}
