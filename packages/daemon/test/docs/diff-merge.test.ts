// The differ (smartDiffer3), the three-way merge and the op helpers (ported from the verified spike; yjs-monaco.md
// Q4, Q5, V1, V4). Exactness and surrogate safety are fuzzed on a real Y.Doc and a peer.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyCompactOps, inverseOfDelta, type TextDeltaItem } from '../../src/docs/apply-ops.ts';
import { applyCompactOpsToString, coarseOps, coarsenOps, compactOps, smartDiff } from '../../src/docs/diff.ts';
import { threeWayReconcile } from '../../src/docs/merge.ts';

/** Deterministic PRNG (tests must be reproducible). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ALPHABET = ['a', 'b', 'c', ' ', '\n', '中', '文', '界', '測', '😀', '🎉', '👍🏽', '👨‍👩‍👧', '𠮷', 'é'];

function randomText(next: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

function mutate(next: () => number, text: string): string {
  const points = [...text];
  const edits = 1 + Math.floor(next() * 6);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(next() * (points.length + 1));
    if (next() < 0.5 && points.length > 0) points.splice(at, 1 + Math.floor(next() * 3));
    else points.splice(at, 0, ...[...randomText(next, 1 + Math.floor(next() * 4))]);
  }
  return points.join('');
}

function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

describe('smartDiff (smartDiffer3)', { timeout: 30_000 }, () => {
  it('is exact on a Y.Text and on a peer, never splits a surrogate pair (CJK, emoji, ZWJ, skin tones) — fuzz', () => {
    const next = rng(42);
    for (let round = 0; round < 400; round++) {
      const a = randomText(next, 5 + Math.floor(next() * 60));
      const b = mutate(next, a);
      const doc = new Y.Doc();
      const peer = new Y.Doc();
      doc.on('update', (u: Uint8Array) => Y.applyUpdate(peer, u));
      doc.getText('content').insert(0, a);
      applyCompactOps(doc.getText('content'), compactOps(smartDiff(a, b)), 'disk');
      expect(doc.getText('content').toString()).toBe(b);
      expect(peer.getText('content').toString()).toBe(b);
      expect(hasLoneSurrogate(peer.getText('content').toString())).toBe(false);
    }
  });

  it('stays exact on the line-level path (large middle) and on the pairwise path after a timeout', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `  const v${i} = compute(${i}, "測試 ${i}"); // 😀`);
    const a = `${lines.join('\n')}\n`;
    const reindented = `${lines.map((l) => `    ${l.trim()}`).join('\n')}\n`;
    const inserted = a.replace('v1500 =', 'v1500 =\n// agent line\n');
    for (const b of [reindented, inserted]) {
      expect(applyCompactOpsToString(a, compactOps(smartDiff(a, b)))).toBe(b);
      // A 1 ms line budget forces the timeout: equal line counts are paired, unequal ones replaced coarsely.
      expect(applyCompactOpsToString(a, compactOps(smartDiff(a, b, { lineTimeoutMs: 1 })))).toBe(b);
    }
  });

  it('keeps a remote cursor on its character through a formatter-style rewrite (V1: 測試 250 does not jump to the file start)', () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `  const value${i} = compute(${i}, "測試 ${i}");`);
    const a = `${lines.join('\n')}\n`;
    const b = `${lines.map((l) => `\t${l.trim().replace('const', 'let')}`).join('\n')}\n`;
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, a);
    const at = a.indexOf('測試 250"');
    const cursor = Y.createRelativePositionFromTypeIndex(text, at);
    applyCompactOps(text, compactOps(smartDiff(a, b, { lineTimeoutMs: 1 })), 'disk');
    expect(text.toString()).toBe(b);
    const moved = Y.createAbsolutePositionFromRelativePosition(cursor, doc);
    expect(moved && text.toString().slice(moved.index, moved.index + 6)).toBe('測試 250');
  });
});

describe('compact ops', () => {
  it('coarseOps and coarsenOps give the same result with fewer operations', () => {
    const next = rng(7);
    for (let round = 0; round < 200; round++) {
      const a = randomText(next, 200);
      const b = mutate(next, mutate(next, a));
      const ops = compactOps(smartDiff(a, b));
      expect(applyCompactOpsToString(a, coarseOps(a, b))).toBe(b);
      const fewer = coarsenOps(a, ops, 6);
      expect(applyCompactOpsToString(a, fewer)).toBe(b);
      expect(fewer.length).toBeLessThanOrEqual(Math.max(ops.length, 6));
    }
  });

  it('inverseOfDelta undoes a Yjs transaction exactly (inserts, deletes, a replaced range)', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'hello 世界 😀 world');
    const before = text.toString();
    let delta: TextDeltaItem[] = [];
    text.observe((event) => {
      delta = event.delta as TextDeltaItem[];
    });
    doc.transact(() => {
      text.insert(2, 'XX');
      text.delete(10, 3);
      text.insert(text.length, '!!');
    }, 'human');
    applyCompactOps(text, inverseOfDelta(delta, before), 'revert');
    expect(text.toString()).toBe(before);
  });
});

describe('threeWayReconcile (base = lockBase, V4)', () => {
  const lockBase = 'a\nb\nc\n';
  const ours = 'a\nHUMAN LINE\nb\nc\n';

  it('keeps both sides when they do not overlap', () => {
    expect(threeWayReconcile(lockBase, ours, 'a\nb\nc // agent\n')).toMatchObject({ merged: 'a\nHUMAN LINE\nb\nc // agent\n', conflicts: [] });
  });

  it('keeps the human text and reports the agent text when they overlap', () => {
    const result = threeWayReconcile(lockBase, ours, 'a\nAGENT LINE\nb\nc\n');
    expect(result.merged).toBe(ours);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ ours: 'HUMAN LINE', theirs: 'AGENT LINE', mergedStartLine: 1 });
  });

  it('keeps autosaved human text when a write built from a stale copy reverts it (git checkout -- f)', () => {
    expect(threeWayReconcile(lockBase, ours, lockBase)).toMatchObject({ merged: ours, conflicts: [] });
  });

  it('round-trips CRLF and a missing trailing newline exactly', () => {
    const base = 'x\r\ny\r\nm\r\nz';
    expect(threeWayReconcile(base, 'x\r\nY!\r\nm\r\nz', 'x\r\ny\r\nm\r\nz2')).toMatchObject({ merged: 'x\r\nY!\r\nm\r\nz2', conflicts: [] });
  });

  it('treats edits on adjacent lines as a conflict (as git does) and keeps the human line', () => {
    const result = threeWayReconcile('x\ny\nz', 'x\nY!\nz', 'x\ny\nz2');
    expect(result.merged).toBe('x\nY!\nz');
    expect(result.conflicts).toHaveLength(1);
  });

  it('never loses a human line and places every agent line in the result or a conflict — fuzz', () => {
    const next = rng(99);
    for (let round = 0; round < 300; round++) {
      const baseLines = Array.from({ length: 8 + Math.floor(next() * 10) }, (_, i) => `line ${i}`);
      const oursLines = [...baseLines];
      const theirsLines = [...baseLines];
      const human = `HUMAN ${round}`;
      const agent = `AGENT ${round}`;
      oursLines.splice(Math.floor(next() * (oursLines.length + 1)), 0, human);
      theirsLines.splice(Math.floor(next() * (theirsLines.length + 1)), 0, agent);
      const result = threeWayReconcile(baseLines.join('\n'), oursLines.join('\n'), theirsLines.join('\n'));
      expect(result.merged.split('\n')).toContain(human);
      const agentKept = result.merged.split('\n').includes(agent) || result.conflicts.some((c) => c.theirs.split('\n').includes(agent));
      expect(agentKept).toBe(true);
    }
  });
});
