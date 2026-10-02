// R7.2 measurement page (dev only, never part of the build: nothing imports it and index.html does not reference it).
// Open through the Vite dev server: http://localhost:5173/src/features/transfer/dev/measure.html?ws=<workspaceId>
//
// Uploads `gib` GiB from a synthetic source through the REAL transfer Worker (the engine's measure mode: TransferManager
// .measure → UploadJob → FileUpload with the window and the bufferedAmount guard, Noise, the TransferDO, the daemon).
// No file of that size exists anywhere on the client. While it runs the page samples:
//   - main-thread timer drift every 50 ms (what typing in this tab would feel),
//   - this page's JS heap every second (performance.memory, Chromium only; the Worker's heap is not visible here),
//   - optionally the round trip of `file.stat` on an interactive connection every 500 ms (what a terminal or an
//     editor waits for while the upload runs).
// Results: <pre id=out>, window.__smurgMeasure, and body[data-measure-state] = running | done | failed.
import { MAIN_ROOT } from '@smurg/protocol';
import { browserConnect, createBrowserConnectionDeps } from '../../../lib/connection/browser-deps.ts';
import { createTransfersArea } from '../../../lib/stores/transfers.ts';
import { TransferClient, browserWorkerFactory } from '../client/transfer-client.ts';
import type { MeasureResult } from '../engine/manager.ts';

const GiB = 1024 ** 3;

interface Series {
  count: number;
  max: number;
  values: number[];
}

const series = (): Series => ({ count: 0, max: 0, values: [] });

function record(s: Series, value: number): void {
  s.count++;
  s.max = Math.max(s.max, value);
  // Bounded memory for a long run: keep a uniform sample of at most 20,000 values.
  if (s.values.length < 20_000) s.values.push(value);
  else s.values[Math.floor(Math.random() * s.count) % 20_000] = value;
}

function percentile(s: Series, p: number): number | null {
  if (s.values.length === 0) return null;
  const sorted = [...s.values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

function summary(s: Series) {
  return { samples: s.count, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.max };
}

interface MeasureReport {
  readonly params: { workspaceId: string; bytes: number; path: string; finalize: string; probe: boolean };
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  progress: { doneBytes: number; totalBytes: number | null; status: string; bytesPerSecond: number };
  engine: MeasureResult | null;
  timerDriftMs: ReturnType<typeof summary>;
  heapBytes: { first: number | null; min: number | null; max: number | null; last: number | null };
  interactiveRttMs: ReturnType<typeof summary> & { failures: number };
  error: string | null;
}

const out = document.getElementById('out') as HTMLPreElement;
const form = document.getElementById('form') as HTMLFormElement;
const params = new URLSearchParams(window.location.search);
for (const name of ['ws', 'gib', 'path', 'finalize', 'probe']) {
  const value = params.get(name);
  const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
  if (value !== null && field) field.value = value;
}

function heapNow(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

async function run(workspaceId: string, bytes: number, path: string, finalize: 'abort' | 'commit', probe: boolean): Promise<void> {
  const drift = series();
  const rtt = series();
  let rttFailures = 0;
  const report: MeasureReport = {
    params: { workspaceId, bytes, path, finalize, probe },
    state: 'running',
    startedAt: Date.now(),
    progress: { doneBytes: 0, totalBytes: bytes, status: 'queued', bytesPerSecond: 0 },
    engine: null,
    timerDriftMs: summary(drift),
    heapBytes: { first: heapNow(), min: heapNow(), max: heapNow(), last: heapNow() },
    interactiveRttMs: { ...summary(rtt), failures: 0 },
    error: null,
  };
  (window as unknown as { __smurgMeasure: MeasureReport }).__smurgMeasure = report;
  document.body.dataset['measureState'] = 'running';
  const render = (): void => {
    report.timerDriftMs = summary(drift);
    report.interactiveRttMs = { ...summary(rtt), failures: rttFailures };
    out.textContent = JSON.stringify(report, null, 2);
  };

  // Main-thread responsiveness: how late a 50 ms timer fires.
  let expected = performance.now() + 50;
  const driftTimer = setInterval(() => {
    const now = performance.now();
    record(drift, Math.max(0, now - expected));
    expected = now + 50;
  }, 50);
  const heapTimer = setInterval(() => {
    const heap = heapNow();
    if (heap === null) return;
    report.heapBytes.last = heap;
    report.heapBytes.min = Math.min(report.heapBytes.min ?? heap, heap);
    report.heapBytes.max = Math.max(report.heapBytes.max ?? heap, heap);
    render();
  }, 1_000);

  // Interactive latency on a separate (interactive) connection of this browser.
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let interactive: ReturnType<ReturnType<typeof browserConnect>> | null = null;
  if (probe) {
    interactive = browserConnect(createBrowserConnectionDeps())(workspaceId, {});
    interactive.start();
    await interactive.whenOnline({ timeoutMs: 30_000 });
    let inFlight = false;
    probeTimer = setInterval(() => {
      if (inFlight || !interactive) return;
      inFlight = true;
      const t0 = performance.now();
      interactive
        .request('file.stat', { root: MAIN_ROOT, path: '' }, { timeoutMs: 10_000 })
        .then(
          () => record(rtt, performance.now() - t0),
          () => rttFailures++,
        )
        .finally(() => {
          inFlight = false;
        });
    }, 500);
  }

  const transfers = createTransfersArea().store;
  const client = new TransferClient({ workspaceId, transfers, createWorker: browserWorkerFactory(), save: () => {} });
  const id = client.measure({ root: MAIN_ROOT, path, size: bytes, finalize });
  const renderTimer = setInterval(render, 1_000);
  await new Promise<void>((resolve) => {
    const off = client.store.subscribe(() => {
      const state = client.store.getState();
      const job = state.jobs.get(id);
      if (job) report.progress = { doneBytes: job.doneBytes, totalBytes: job.totalBytes, status: job.status, bytesPerSecond: job.bytesPerSecond };
      if (state.worker === 'failed' || state.worker === 'no-storage' || state.worker === 'unavailable') {
        report.error = `worker: ${state.worker} ${state.workerError ?? ''}`;
        off();
        resolve();
        return;
      }
      const result = state.measured.get(id);
      if (result) {
        report.engine = result;
        if (job?.failure) report.error = JSON.stringify(job.failure);
        off();
        resolve();
      }
    });
  });

  clearInterval(renderTimer);
  clearInterval(driftTimer);
  clearInterval(heapTimer);
  if (probeTimer) clearInterval(probeTimer);
  interactive?.close();
  client.dispose();
  report.state = report.engine?.status === 'done' && report.error === null ? 'done' : 'failed';
  report.heapBytes.last = heapNow();
  render();
  document.body.dataset['measureState'] = report.state;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const workspaceId = String(data.get('ws') ?? '').trim();
  const bytes = Math.round(Number(data.get('gib') ?? '10') * GiB);
  const path = String(data.get('path') ?? 'smurg-measure.bin').trim();
  const finalize = data.get('finalize') === 'commit' ? 'commit' : 'abort';
  const probe = data.get('probe') !== '0';
  (document.getElementById('start') as HTMLButtonElement).disabled = true;
  run(workspaceId, bytes, path, finalize, probe).catch((error: unknown) => {
    out.textContent = `Measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    document.body.dataset['measureState'] = 'failed';
  });
});

if (params.get('autostart') === '1') form.requestSubmit();
