// Runs ComputeJobs (merge + diff) on ONE long-lived worker thread, so the daemon's event loop keeps serving terminals,
// the hook socket and srt's proxy while a 5 MiB file is diffed (ARCHITECTURE §0 rule 5, §7.5).
//
// The worker is started lazily and unref()'d (it never keeps the process alive). If it cannot be started at all
// (e.g. a bundle that did not ship compute-worker), jobs fall back to running inline: every algorithm is bounded by
// its own timeouts (smartDiff 300 + 150 ms, merge 2 × 500 ms), so that degrades latency, never correctness. A worker
// that crashes is restarted for the next job; one that does not answer within `timeoutMs` is terminated.
import { Worker } from 'node:worker_threads';
import type { Logger } from '../core/logger.ts';
import { runComputeJob, type ComputeJob, type ComputeResult } from './compute-job.ts';

export interface DocComputeOptions {
  readonly log: Logger;
  /** Worker entry; null = always inline (tests of the fallback). Default: compute-worker.ts next to this file. */
  readonly workerUrl?: URL | null;
  /** A job that takes longer than this terminates the worker and fails. */
  readonly timeoutMs?: number;
}

interface Pending {
  readonly job: ComputeJob;
  readonly resolve: (result: ComputeResult) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** After this many crashes the pool stops trying and runs inline. */
const MAX_WORKER_FAILURES = 3;

/**
 * compute-worker.ts next to this file, or null (inline) where that cannot be expressed: a CJS bundle (the SEA build)
 * has no import.meta.url, and a daemon must still start there. The packaging build ships the worker as its own entry
 * and passes its URL (DocServiceOptions.computeWorkerUrl).
 */
export function defaultComputeWorkerUrl(): URL | null {
  try {
    return new URL('./compute-worker.ts', import.meta.url);
  } catch {
    return null;
  }
}

export class DocCompute {
  private readonly log: Logger;
  private readonly workerUrl: URL | null;
  private readonly timeoutMs: number;
  private worker: Worker | null = null;
  private failures = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** Jobs run so far on the worker / inline (tests, diagnostics). */
  readonly stats = { worker: 0, inline: 0 };

  constructor(options: DocComputeOptions) {
    this.log = options.log;
    this.workerUrl = options.workerUrl === undefined ? defaultComputeWorkerUrl() : options.workerUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  run(job: ComputeJob): Promise<ComputeResult> {
    if (this.closed) return Promise.reject(new Error('compute pool closed'));
    const worker = this.ensureWorker();
    if (worker === null) return this.runInline(job);
    return new Promise<ComputeResult>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.log.warn('document compute job timed out; restarting the worker', { timeoutMs: this.timeoutMs });
        this.failAll(new Error('compute job timed out'), false);
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { job, resolve, reject, timer });
      this.stats.worker += 1;
      worker.postMessage({ id, job });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('compute pool closed'));
    }
    this.pending.clear();
    if (worker) await worker.terminate().catch(() => 0);
  }

  private runInline(job: ComputeJob): Promise<ComputeResult> {
    this.stats.inline += 1;
    try {
      return Promise.resolve(runComputeJob(job));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error('compute failed'));
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workerUrl === null || this.failures >= MAX_WORKER_FAILURES) return null;
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl, { name: 'smurg-doc-compute' });
    } catch (err) {
      this.failures = MAX_WORKER_FAILURES;
      this.log.warn('document compute worker unavailable; diffing inline', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
    worker.unref();
    worker.on('message', (message: { id: number; ok: boolean; result?: ComputeResult; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok && message.result) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? 'compute failed'));
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.log.warn('document compute worker failed', { error: err.name });
      this.failAll(err, true);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (!this.closed && this.pending.size > 0) this.failAll(new Error(`compute worker exited (${code})`), true);
    });
    this.worker = worker;
    return worker;
  }

  /**
   * The worker is gone or stuck: drop it. Jobs it held are re-run inline when the worker CRASHED (a missing or broken
   * worker file must not stop reconciliation), and failed when it merely took too long (inline would block as long).
   */
  private failAll(err: Error, rerunInline: boolean): void {
    const worker = this.worker;
    this.worker = null;
    this.failures += 1;
    if (worker) void worker.terminate().catch(() => 0);
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const pending of jobs) {
      clearTimeout(pending.timer);
      if (rerunInline && !this.closed) this.runInline(pending.job).then(pending.resolve, pending.reject);
      else pending.reject(err);
    }
  }
}
