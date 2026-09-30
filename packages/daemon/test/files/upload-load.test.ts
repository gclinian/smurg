// SPEC R7 acceptance 「上傳 10 GB 檔案時，瀏覽器記憶體用量保持穩定，其他人打字和終端機沒有明顯延遲」 — the DAEMON side:
// a 200 MiB upload in 4 MiB chunks (ack window of 4) must not block the interactive channel, and the daemon's memory
// must not grow with the upload (chunks are written through, never collected). The browser half (10 GB, browser
// memory) needs a real browser and is verified separately (docs/ACCEPTANCE.md R7.2); no multi-gigabyte file here.
//
// Client and daemon share this process, so latencies include the client's own hashing and encryption. The latency
// bounds are RELATIVE to a control run (the same typing loop, no upload, measured right before under the same machine
// load) plus a fixed allowance for the work of the chunks in flight. Fixed bounds in milliseconds failed in the full
// gate on a busy machine (a single 1043 ms sample against "max < 1000"), although what they measured then was the
// machine, not the upload. On an idle machine the relative bounds are tighter than the old fixed ones.
// The measured values are printed for the record. The in-memory relay's R3 byte tap keeps every frame it forwards; it
// is drained while measuring (a harness artifact, not daemon memory).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT } from '@smurg/protocol';
import { MiB, patternSource, sha256Hex, sourceHash, startFilesDaemon, upload, type FilesTest } from './helpers.ts';

let ft: FilesTest | null = null;

afterEach(async () => {
  await ft?.t.cleanup();
  ft = null;
});

function gcFunction(): () => void {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as (() => void) | undefined;
  return typeof gc === 'function' ? gc : () => {};
}

/** Several collections with pauses: external (Buffer) memory is released only after finalizers ran. */
async function settleGc(gc: () => void): Promise<void> {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

describe('R7.2 上傳 10 GB 檔案時，瀏覽器記憶體用量保持穩定，其他人打字和終端機沒有明顯延遲 (daemon side)', () => {
  it('上傳 10 GB 檔案時…其他人打字和終端機沒有明顯延遲 — a 200 MiB upload does not block the interactive channel, and the daemon memory stays flat', { timeout: 180_000 }, async () => {
    ft = await startFilesDaemon({ project: { files: { 'notes.md': '# notes\n' } }, files: { watch: false }, settings: { uploadChunkSize: 4 * MiB } });
    const amy = await ft.t.connect({ userId: 'dev:amy', role: 'editor' });
    const bob = await ft.t.connect({ userId: 'dev:bob', role: 'editor' });
    const xfer = await amy.transfer();
    const gc = gcFunction();

    // Bob "types": small interactive requests on the other socket, back to back, the whole time.
    const ping = async (): Promise<number> => {
      const start = performance.now();
      await bob.conn.request('file.stat', { root: MAIN_ROOT, path: 'notes.md' });
      return performance.now() - start;
    };
    // Control: the same loop as during the upload (a request, 10 ms pause), without an upload, for 3 s.
    const baseline: number[] = [];
    const controlUntil = performance.now() + 3_000;
    while (performance.now() < controlUntil || baseline.length < 30) {
      baseline.push(await ping());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const relayFrames = ft.t.relay.frames;
    const heapAndBuffers = (): number => {
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    relayFrames.length = 0;
    await settleGc(gc);
    const rssBefore = process.memoryUsage().rss;
    const heldBefore = heapAndBuffers();
    let rssPeak = rssBefore;
    let heldPeak = heldBefore;
    const sampler = setInterval(() => {
      relayFrames.length = 0;
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      heldPeak = Math.max(heldPeak, heapAndBuffers());
    }, 20);

    const size = 200 * MiB;
    const source = patternSource('r7.2');
    const during: number[] = [];
    let uploading = true;
    const typing = (async () => {
      while (uploading) {
        during.push(await ping());
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const started = performance.now();
    let acked = 0;
    const run = await upload(xfer, { path: 'big.bin', size, chunkSize: 4 * MiB, source, onAck: () => acked++ });
    const seconds = (performance.now() - started) / 1000;
    uploading = false;
    await typing;
    clearInterval(sampler);
    relayFrames.length = 0;
    await settleGc(gc);
    const rssAfter = process.memoryUsage().rss;
    const heldAfter = heapAndBuffers();

    expect(run.entry).toMatchObject({ path: 'big.bin', size });
    expect(acked).toBe(50);
    expect(sha256Hex(await readFile(join(ft.t.root, 'big.bin')))).toBe(sourceHash(source, size, 4 * MiB));

    const report = {
      uploadMiBps: +(200 / seconds).toFixed(1),
      baselineSamples: baseline.length,
      baselineP50: +percentile(baseline, 50).toFixed(1),
      baselineP95: +percentile(baseline, 95).toFixed(1),
      baselineMax: +Math.max(...baseline).toFixed(1),
      duringSamples: during.length,
      duringP50: +percentile(during, 50).toFixed(1),
      duringP95: +percentile(during, 95).toFixed(1),
      duringMax: +Math.max(...during).toFixed(1),
      rssBeforeMiB: +(rssBefore / MiB).toFixed(1),
      rssPeakGrowthMiB: +((rssPeak - rssBefore) / MiB).toFixed(1),
      rssAfterGrowthMiB: +((rssAfter - rssBefore) / MiB).toFixed(1),
      heapAndBuffersPeakGrowthMiB: +((heldPeak - heldBefore) / MiB).toFixed(1),
      heapAndBuffersAfterGrowthMiB: +((heldAfter - heldBefore) / MiB).toFixed(1),
    };
    console.log(`R7.2 daemon side: ${JSON.stringify(report)}`);

    // Interactive requests kept flowing while the upload ran, without long stalls: compared with the control run
    // under the same load. The allowances are the work of the ack window (at most 4 chunks of 4 MiB in flight, each
    // hashed, encrypted, decrypted and written in this one process): what an upload may add, however busy the machine.
    expect(during.length).toBeGreaterThanOrEqual(20);
    expect(percentile(during, 95)).toBeLessThan(percentile(baseline, 95) * 3 + 150);
    expect(Math.max(...during)).toBeLessThan(Math.max(...baseline) * 3 + 750);
    // Memory: bounded by the ack window (a few 4 MiB chunks in flight, each in several copies: client read, msgpack,
    // ciphertext, plaintext), not by the upload size; nothing of the upload is kept once it is on disk.
    // The peak includes garbage V8 has not collected yet; it stays well below the 200 MiB that went through.
    expect(heldPeak - heldBefore).toBeLessThan(160 * MiB);
    expect(heldAfter - heldBefore).toBeLessThan(16 * MiB);
    expect(rssPeak - rssBefore).toBeLessThan(192 * MiB);
  });
});
