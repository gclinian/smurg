// One download (SPEC R7 「下載：單一檔案，或由 daemon 以串流方式把資料夾打包成 zip」, ARCHITECTURE §5.2,
// transfer.md §1.6–§1.7).
//
// The SDK's TransferConnection.download() delivers chunks in order and acknowledges each one (one chunk of credit back
// to the daemon) only after onChunk resolved, i.e. after the writer stored it: a slow disk slows the sender down.
// A dropped socket: a single file resumes by offset + etag (a file changed on the host meanwhile is refused), a zip
// restarts from zero. Cancel sends file.download.cancel and discards the partial result.
import type { FileRef, PayloadInputOf } from '@smurg/protocol';
import type { ActiveDownload } from '@smurg/protocol/client';
import type { TransferStatus } from '../../../lib/stores/transfers.ts';
import { toFailure } from './failures.ts';
import type { Semaphore } from './limits.ts';
import { LinkEndedError, TransferCancelledError, abortReason, isConnectivityError, waitForOnline, type TransferLink } from './link.ts';
import { RateMeter } from './rate.ts';
import type { DownloadOutcome, JobSnapshot, PauseCause, TransferFailure } from './types.ts';
import { PickerWriter, openAutoWriter, type DownloadOutput, type DownloadWriter, type SaveHandleLike, type WriterEnv } from './writers.ts';

export interface DownloadJobSpec {
  readonly id: string;
  readonly file: FileRef;
  readonly zip: boolean;
  /** Shown until `file.download.begin` names the file. */
  readonly name: string;
  /** Chromium: where the person chose to save (showSaveFilePicker in the click handler). */
  readonly picker?: SaveHandleLike;
}

export interface DownloadJobDeps {
  readonly link: TransferLink;
  /** Downloads in progress at once, shared by the connection. */
  readonly slots: Semaphore;
  readonly writers: WriterEnv;
  readonly now?: () => number;
  readonly onChange: (job: DownloadJob) => void;
  /** A finished download that the page must hand to the browser (`<a download>` of a blob URL). */
  readonly onOutput: (job: DownloadJob, output: Extract<DownloadOutput, { kind: 'blob' }>) => void;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export class DownloadJob {
  readonly spec: DownloadJobSpec;
  private readonly deps: DownloadJobDeps;
  private readonly now: () => number;
  private readonly rate: RateMeter;
  private readonly startedAt: number;
  private name: string;
  private size: number | null = null;
  private etag: string | undefined;
  private writer: DownloadWriter | null = null;
  private status: TransferStatus = 'queued';
  private failure: TransferFailure | null = null;
  private outcome: DownloadOutcome | null = null;
  private active: ActiveDownload | null = null;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  /** Bytes the current zip attempt produced (a zip restarts, so its progress restarts too). */
  private restarts = 0;

  constructor(spec: DownloadJobSpec, deps: DownloadJobDeps) {
    this.spec = spec;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.rate = new RateMeter({ now: this.now });
    this.startedAt = this.now();
    this.name = spec.name;
  }

  get id(): string {
    return this.spec.id;
  }

  get finished(): boolean {
    return this.status === 'done' || this.status === 'failed' || this.status === 'cancelled';
  }

  /** How many times a zip download started over after a reconnect (tests, the UI note). */
  get zipRestarts(): number {
    return this.restarts;
  }

  whenSettled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  snapshot(): JobSnapshot {
    const offline = (this.status === 'running' || this.status === 'preparing') && this.deps.link.getState().kind !== 'online';
    return {
      id: this.spec.id,
      kind: 'download',
      name: this.name,
      root: this.spec.file.root,
      path: this.spec.file.path,
      totalBytes: this.outcome?.totalBytes ?? this.size,
      doneBytes: this.outcome?.totalBytes ?? this.writer?.written ?? 0,
      files: null,
      filesDone: 0,
      status: offline ? 'paused' : this.status,
      pause: offline ? ('offline' satisfies PauseCause) : null,
      verifying: false,
      bytesPerSecond: this.status === 'running' && !offline ? this.rate.bytesPerSecond : 0,
      failure: this.failure,
      fileFailures: [],
      rejected: [],
      conflict: null,
      download: this.outcome,
      startedAt: this.startedAt,
    };
  }

  start(): void {
    if (this.running !== null || this.finished) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(controller.signal).finally(() => {
      if (this.controller === controller) this.controller = null;
      this.running = null;
    });
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    this.controller?.abort(new TransferCancelledError('cancelled'));
    this.active?.cancel();
    await this.running;
    await this.writer?.abort();
    this.setStatus('cancelled');
  }

  /** Retry after a failure (a single file continues from what was saved, a zip starts over). */
  retry(): void {
    if (this.status !== 'failed') return;
    this.failure = null;
    this.status = 'queued';
    this.start();
  }

  private async run(signal: AbortSignal): Promise<void> {
    const offState = this.deps.link.subscribe(() => this.changed());
    let release: (() => void) | null = null;
    try {
      this.setStatus('preparing');
      release = await this.deps.slots.enter(signal);
      for (;;) {
        try {
          await waitForOnline(this.deps.link, signal);
          await this.attempt(signal);
          break;
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          if (!isConnectivityError(error) || error instanceof LinkEndedError) throw error;
          this.rate.reset();
          this.changed();
        }
      }
      this.setStatus('done');
    } catch (error) {
      if (signal.aborted) return; // cancel() reports 'cancelled'
      this.failure = toFailure(error);
      this.setStatus('failed');
      // A failed download keeps nothing half-written (OPFS copy removed, memory freed, the picker's writable
      // discarded so the file is not left locked); a retry starts over.
      await this.writer?.abort();
      this.writer = null;
    } finally {
      release?.();
      offState();
    }
  }

  private async attempt(signal: AbortSignal): Promise<void> {
    const writer = this.writer;
    const resumeAt = !this.spec.zip && writer !== null && writer.written > 0 ? writer.written : null;
    if (this.spec.zip && writer !== null && writer.written > 0) {
      // Zips are never resumable: start over, into the same writer.
      this.restarts++;
      await writer.reset();
      this.rate.reset();
    }
    const payload: PayloadInputOf<'file.download.begin'> =
      resumeAt !== null
        ? { file: this.spec.file, offset: resumeAt, ...(this.etag !== undefined ? { ifMatch: this.etag } : {}) }
        : this.spec.zip
          ? { file: this.spec.file, zip: true }
          : { file: this.spec.file };
    // Chunks can arrive right behind begin.ok, before the writer knows the size: onChunk waits until it is ready.
    const ready = deferred();
    const active = await this.deps.link.download(payload, {
      signal,
      onChunk: async (chunk) => {
        await ready.promise;
        await (this.writer as DownloadWriter).write(chunk.offset, chunk.data);
        this.rate.sample(this.writer?.written ?? 0);
        this.changed();
      },
    });
    this.active = active;
    try {
      const { info } = active;
      this.name = info.name;
      if (!info.zip) this.size = info.size ?? null;
      this.etag = info.etag;
      if (this.writer === null) {
        this.writer = this.spec.picker ? new PickerWriter(this.spec.picker) : await openAutoWriter(this.deps.writers, `${this.spec.id}-${info.name}`, info.zip ? null : (info.size ?? null));
        if (this.spec.picker) await this.writer.prepare(this.size);
      }
      ready.resolve();
      this.setStatus('running');
      const end = await active.done;
      const total = this.spec.zip ? end.totalBytes : (this.size ?? (resumeAt ?? 0) + end.totalBytes);
      const output = await (this.writer as DownloadWriter).finish(total);
      this.outcome = { savedAs: (this.writer as DownloadWriter).savedAs, skipped: end.skipped, zip64: end.zip64, totalBytes: total };
      if (output.kind === 'blob') this.deps.onOutput(this, output);
    } catch (error) {
      ready.reject(error);
      active.cancel();
      throw error;
    } finally {
      this.active = null;
    }
  }

  private setStatus(status: TransferStatus): void {
    this.status = status;
    if (status !== 'running') this.rate.reset();
    this.changed();
  }

  private changed(): void {
    this.deps.onChange(this);
  }
}
