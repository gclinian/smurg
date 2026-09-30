// The compute worker (ARCHITECTURE §0 rule 5, §7.5 "run them off the main thread"): diff and merge of a large file
// run on a worker thread while the event loop keeps ticking, and the resulting Yjs update merges with human typing
// that happened while the job ran.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { silentLogger } from '../../src/core/logger.ts';
import { INLINE_BUDGETS, MAX_APPLY_OPS, runComputeJob, type ComputeJob } from '../../src/docs/compute-job.ts';
import { DocCompute } from '../../src/docs/compute.ts';

const pools: DocCompute[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
});

function pool(workerUrl?: URL | null): DocCompute {
  const created = new DocCompute({ log: silentLogger, ...(workerUrl !== undefined ? { workerUrl } : {}) });
  pools.push(created);
  return created;
}

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return doc;
}

/** ~1.3 MB of code-like text in which every line differs between the two versions (a formatter run). */
function bigRewrite(): { a: string; b: string } {
  const lines = Array.from({ length: 20_000 }, (_, i) => `  const value${i} = compute(${(i * 7919) % 100_003}, "測試 ${i}"); // ${i % 97}`);
  return { a: `${lines.join('\n')}\n`, b: `${lines.map((l) => `\t${l.trim().replace('const', 'let')}`).join('\n')}\n` };
}

describe('DocCompute', { timeout: 30_000 }, () => {
  it('runs a multi-megabyte merge + diff on the worker while the event loop keeps ticking (measured)', async () => {
    const { a, b } = bigRewrite();
    const doc = docWith(a);
    // Two-way (no human lock): the line diff times out (every line changed) and the lines are paired.
    const job: ComputeJob = { mode: 'reconcile', snapshot: Y.encodeStateAsUpdate(doc), diskText: a, lockBase: null, theirs: b };
    const compute = pool();
    // Inline, the same job blocks the loop for its whole duration.
    const inlineStart = performance.now();
    runComputeJob(job, INLINE_BUDGETS);
    const inlineMs = performance.now() - inlineStart;

    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    const started = performance.now();
    const result = await compute.run(job);
    const workerMs = performance.now() - started;
    histogram.disable();
    const maxStallMs = histogram.max / 1e6;
    console.log(`compute: inline ${inlineMs.toFixed(0)} ms blocking; worker ${workerMs.toFixed(0)} ms wall, max event-loop stall ${maxStallMs.toFixed(1)} ms, ${result.ops} ops`);
    expect(compute.stats.worker).toBe(1);
    expect(inlineMs).toBeGreaterThan(100);
    // Generous for a shared, loaded machine: far below the inline blocking time, and well under the 1 s budget.
    expect(maxStallMs).toBeLessThan(Math.max(60, inlineMs / 2));
    expect(result.update).not.toBeNull();
    Y.applyUpdate(doc, result.update as Uint8Array);
    expect(doc.getText('content').toString()).toBe(b);
  });

  it('a three-way merge whose diff times out keeps all human text as one conflict (nothing applied)', () => {
    const { a, b } = bigRewrite();
    const result = runComputeJob({ mode: 'reconcile', snapshot: Y.encodeStateAsUpdate(docWith(a)), diskText: a, lockBase: a.replace('value5 ', 'HUMAN5 '), theirs: b }, { ...INLINE_BUDGETS, mergeTimeoutMs: 50 });
    expect(result).toMatchObject({ update: null, mergeTimedOut: true, mergedIsTheirs: false });
    expect(result.conflicts).toHaveLength(1);
  });

  it('merges human typing that happened while the job ran instead of overwriting it', async () => {
    const disk = 'one\ntwo\nthree\n';
    const doc = docWith(disk);
    const snapshot = Y.encodeStateAsUpdate(doc);
    const pending = pool().run({ mode: 'reconcile', snapshot, diskText: disk, lockBase: null, theirs: 'one\ntwo\nthree\nfour (agent)\n' });
    doc.getText('content').insert(0, 'typed-while-computing ');
    const result = await pending;
    Y.applyUpdate(doc, result.update as Uint8Array, 'disk');
    expect(doc.getText('content').toString()).toBe('typed-while-computing one\ntwo\nthree\nfour (agent)\n');
  });

  it('falls back to inline when no worker can be started, and when the worker entry is missing', async () => {
    const disk = 'a\n';
    const job: ComputeJob = { mode: 'replace', snapshot: Y.encodeStateAsUpdate(docWith(disk)), diskText: disk, lockBase: null, theirs: 'b\n' };
    const inline = pool(null);
    expect((await inline.run(job)).update).not.toBeNull();
    expect(inline.stats).toEqual({ worker: 0, inline: 1 });
    const broken = pool(new URL('./does-not-exist-worker.ts', import.meta.url));
    const result = await broken.run(job);
    expect(result.update).not.toBeNull();
    expect(broken.stats.inline).toBe(1);
  });

  it(`coarsens a diff above ${MAX_APPLY_OPS} operations and stays exact`, () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `v${i} = ${i};`);
    const a = `${lines.join('\n')}\n`;
    const b = `${lines.map((l) => l.replace('=', ':=')).join('\n')}\n`;
    const doc = docWith(a);
    const result = runComputeJob({ mode: 'replace', snapshot: Y.encodeStateAsUpdate(doc), diskText: a, lockBase: null, theirs: b });
    expect(result.coarse).toBe(true);
    expect(result.ops).toBeLessThanOrEqual(MAX_APPLY_OPS);
    const started = performance.now();
    Y.applyUpdate(doc, result.update as Uint8Array);
    console.log(`apply of a ${result.ops}-op update on the main thread: ${(performance.now() - started).toFixed(1)} ms`);
    expect(doc.getText('content').toString()).toBe(b);
  });
});
