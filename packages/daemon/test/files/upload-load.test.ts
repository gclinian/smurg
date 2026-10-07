// SPEC R7 acceptance (while a 10 GB file uploads, the browser's memory stays flat and nobody's typing or terminal
// lags) — the DAEMON side:
// a 200 MiB upload in 4 MiB chunks (ack window of 4) must not block the interactive channel, and the daemon's memory
// must not grow with the upload (chunks are written through, never collected). The browser half (10 GB, browser
// memory) needs a real browser and is verified separately (docs/ACCEPTANCE.md R7.2); no multi-gigabyte file here.
//
// WHAT IS MEASURED, and why not milliseconds. Client and daemon share this process, and the gate runs this file
// beside a hundred others: a bound on the wall-clock time of a request measured the machine, not the upload (a fixed
// "max < 1000 ms" failed once in the full gate; a bound relative to a control run taken right before failed four
// times in whole-project runs on 2026-10-07, whenever another test file started its heavy part after the control).
// What the requirement asks of the daemon does not depend on the machine's speed, and is measured that way:
//   1. ORDER: an interactive request is answered while the chunks are in flight. For every request: how many chunks
//      were acknowledged while it was on its way. A daemon that served the upload first would let a request wait for
//      many of them; no request may wait for more than the ack window (4).
//   2. OUR OWN WORK: the CPU time this process (every thread) spent between a request and its answer. A daemon that
//      blocked its event loop on a chunk would burn that time here whatever else the machine runs, and what other
//      processes do adds nothing to it. The allowance is the work of the chunks in flight.
// The wall-clock values, with a control run before the upload, are printed for the record and not asserted.
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

/** Chunks the client sends ahead of the daemon's acknowledgements (the upload protocol's window). */
const ACK_WINDOW = 4;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

describe('R7.2 a 10 GB upload keeps memory flat and delays nobody\'s typing or terminal (daemon side)', () => {
  it('a large upload delays nobody\'s typing or terminal — a 200 MiB upload does not block the interactive channel, and the daemon memory stays flat', { timeout: 180_000 }, async () => {
    ft = await startFilesDaemon({ project: { files: { 'notes.md': '# notes\n' } }, files: { watch: false }, settings: { uploadChunkSize: 4 * MiB } });
    const amy = await ft.t.connect({ userId: 'dev:amy', role: 'editor' });
    const bob = await ft.t.connect({ userId: 'dev:bob', role: 'editor' });
    const xfer = await amy.transfer();
    const gc = gcFunction();

    // Bob "types": small interactive requests on the other socket, back to back, the whole time.
    /** The CPU time (ms, user + system, all threads of this process) of each request made while the upload ran. */
    const cpuPerRequest: number[] = [];
    let measuringCpu = false;
    const ping = async (): Promise<number> => {
      const start = performance.now();
      const cpu = process.cpuUsage();
      await bob.conn.request('file.stat', { root: MAIN_ROOT, path: 'notes.md' });
      if (measuringCpu) {
        const used = process.cpuUsage(cpu);
        cpuPerRequest.push((used.user + used.system) / 1000);
      }
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
    /** For each of Bob's requests: how many chunks of the upload were acknowledged while it was on its way. */
    const chunksPerRequest: number[] = [];
    let uploading = true;
    let acked = 0;
    measuringCpu = true;
    const typing = (async () => {
      while (uploading) {
        const ackedBefore = acked;
        during.push(await ping());
        chunksPerRequest.push(acked - ackedBefore);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const started = performance.now();
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
      chunksPerRequestMax: Math.max(...chunksPerRequest),
      cpuPerRequestP95: +percentile(cpuPerRequest, 95).toFixed(1),
      cpuPerRequestMax: +Math.max(...cpuPerRequest).toFixed(1),
      rssBeforeMiB: +(rssBefore / MiB).toFixed(1),
      rssPeakGrowthMiB: +((rssPeak - rssBefore) / MiB).toFixed(1),
      rssAfterGrowthMiB: +((rssAfter - rssBefore) / MiB).toFixed(1),
      heapAndBuffersPeakGrowthMiB: +((heldPeak - heldBefore) / MiB).toFixed(1),
      heapAndBuffersAfterGrowthMiB: +((heldAfter - heldBefore) / MiB).toFixed(1),
    };
    console.log(`R7.2 daemon side: ${JSON.stringify(report)}`);

    // 1. Requests kept being answered while the chunks were in flight: more of them than ack windows went by, and
    //    none waited for more of the upload than one window.
    expect(during.length).toBeGreaterThanOrEqual(Math.ceil(acked / ACK_WINDOW));
    expect(Math.max(...chunksPerRequest)).toBeLessThanOrEqual(ACK_WINDOW);
    // 2. What this process did between a request and its answer: at most the work of the chunks in flight (each
    //    hashed, encrypted, decrypted and written here; measured on this machine: 2 ms typical, 30 to 60 ms when a
    //    chunk's turn falls in between). A blocked event loop would show here as CPU time, on any machine.
    expect(percentile(cpuPerRequest, 95)).toBeLessThan(250);
    expect(Math.max(...cpuPerRequest)).toBeLessThan(1_000);
    // Memory: bounded by the ack window (a few 4 MiB chunks in flight, each in several copies: client read, msgpack,
    // ciphertext, plaintext), not by the upload size; nothing of the upload is kept once it is on disk.
    // The peak includes garbage V8 has not collected yet; it stays well below the 200 MiB that went through.
    // Only V8's own accounting (heap + ArrayBuffers) is asserted: it is what a leak of chunks would grow. RSS is
    // reported but not asserted, because it is the allocator's retention policy, not ours: on the 3-core GitHub macOS
    // runner it grew by 248 MiB with the same 91 MiB heap peak and 6 MiB left after GC that this machine shows.
    expect(heldPeak - heldBefore).toBeLessThan(160 * MiB);
    expect(heldAfter - heldBefore).toBeLessThan(16 * MiB);
  });
});
