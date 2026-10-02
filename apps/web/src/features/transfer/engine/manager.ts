// Everything the transfer Worker does, independent of postMessage so it runs in Node tests: one TransferConnection
// (created when the first job needs it, closed a while after the last one ended), the limits shared by every job of
// that connection, the jobs, the journal of interrupted uploads, and throttled progress reports.
import { DEFAULT_CHUNK_SIZE, TRANSFER_WINDOW_CHUNKS, type FileRef, type RootRef } from '@smurg/protocol';
import { DownloadJob } from './download-job.ts';
import type { JournalRecord, UploadJournal } from './journal.ts';
import { Budget, Semaphore } from './limits.ts';
import { waitForOnline, type TransferLink } from './link.ts';
import { ManagedLink } from './managed-link.ts';
import { delay } from './signals.ts';
import type { ChunkHasher, UploadSourceFile } from './source.ts';
import { createSyntheticSource } from './synthetic-source.ts';
import type { JobSnapshot, UploadConflictPolicy } from './types.ts';
import { UploadJob, type UploadItem } from './upload-job.ts';
import type { SaveHandleLike, WriterEnv } from './writers.ts';

/** Files uploading at once across all jobs (transfer.md §1.3: pipeline a few small files, not 3,000 round trips). */
export const FILES_AT_ONCE = 4;
/** Downloads at once. */
export const DOWNLOADS_AT_ONCE = 2;
/** Chunk bytes read but not acknowledged, across every upload of the connection (≈ 4 chunks of 4 MiB). */
export const UPLOAD_BYTES_IN_FLIGHT = TRANSFER_WINDOW_CHUNKS * DEFAULT_CHUNK_SIZE;
/** Progress reports per job at most this often (status changes are reported at once). */
export const SNAPSHOT_INTERVAL_MS = 200;
/** Journal entries older than the host's partial-upload TTL (48 h) are dropped at start. */
export const JOURNAL_TTL_MS = 48 * 60 * 60 * 1000;
/** How long "Discard this upload" waits for the socket to remove partial uploads from the host. */
export const DISCARD_WAIT_MS = 30_000;
/** The transfer socket closes this long after the last job ended. */
export const LINK_IDLE_CLOSE_MS = 60_000;

export type ManagerEvent =
  | { readonly t: 'job'; readonly snapshot: JobSnapshot }
  | { readonly t: 'output'; readonly id: string; readonly blob: Blob }
  | { readonly t: 'link'; readonly state: string }
  | { readonly t: 'interrupted'; readonly snapshot: JobSnapshot; readonly handles: Readonly<Record<string, FileSystemHandle>> | null; readonly files: readonly { readonly path: string; readonly size: number; readonly lastModified: number }[] }
  | { readonly t: 'removed'; readonly id: string }
  | { readonly t: 'measured'; readonly id: string; readonly result: MeasureResult };

export interface MeasureResult {
  readonly bytes: number;
  readonly durationMs: number;
  readonly bytesPerSecond: number;
  readonly maxBufferedAmount: number;
  readonly peakBytesInFlight: number;
  readonly status: string;
}

export interface ManagerDeps {
  readonly workspaceId: string;
  readonly createLink: () => TransferLink;
  readonly journal: UploadJournal | null;
  readonly hasher: ChunkHasher;
  readonly writers: WriterEnv;
  readonly emit: (event: ManagerEvent) => void;
  readonly now?: () => number;
  readonly snapshotIntervalMs?: number;
  readonly linkIdleCloseMs?: number;
  readonly journalDelayMs?: number;
}

export interface UploadRequest {
  readonly id: string;
  readonly root: RootRef;
  readonly targetDir: string;
  readonly name: string;
  readonly items: readonly UploadItem[];
  readonly rejected?: readonly { readonly path: string; readonly problem: string }[];
  readonly handles?: Readonly<Record<string, FileSystemHandle>>;
}

export interface DownloadRequest {
  readonly id: string;
  readonly file: FileRef;
  readonly zip: boolean;
  readonly name: string;
  readonly picker?: SaveHandleLike;
}

export interface MeasureRequest {
  readonly id: string;
  readonly root: RootRef;
  readonly path: string;
  readonly size: number;
  readonly seed?: number;
  /** 'abort' (default) leaves nothing on the host. */
  readonly finalize?: 'commit' | 'abort';
}

type Job = UploadJob | DownloadJob;

interface Throttle {
  lastAt: number;
  lastStatus: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TransferManager {
  private readonly deps: ManagerDeps;
  private readonly now: () => number;
  /** Stable for the jobs; the socket behind it is opened for work and closed when idle. */
  private readonly link = new ManagedLink();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly budget = new Budget(UPLOAD_BYTES_IN_FLIGHT);
  private readonly fileSlots = new Semaphore(FILES_AT_ONCE);
  private readonly downloadSlots = new Semaphore(DOWNLOADS_AT_ONCE);
  private readonly jobs = new Map<string, Job>();
  private readonly interrupted = new Map<string, JournalRecord>();
  private readonly throttles = new Map<string, Throttle>();
  private disposed = false;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.link.subscribe((state) => this.deps.emit({ t: 'link', state: state.kind }));
  }

  /** Reports the uploads a previous page left unfinished (they wait for their files to be chosen again). */
  async restore(): Promise<void> {
    const journal = this.deps.journal;
    if (!journal) return;
    let records: JournalRecord[];
    try {
      records = await journal.list(this.deps.workspaceId);
    } catch {
      return;
    }
    for (const record of records) {
      if (this.jobs.has(record.jobId)) continue;
      // The host sweeps partial uploads untouched for 48 h: an older entry could only resume from nothing, and it
      // keeps file names in this browser for no purpose.
      if (this.now() - record.createdAt > JOURNAL_TTL_MS) {
        await journal.remove(record.jobId).catch(() => {});
        continue;
      }
      this.interrupted.set(record.jobId, record);
      this.deps.emit({
        t: 'interrupted',
        snapshot: interruptedSnapshot(record),
        handles: record.handles ?? null,
        files: record.files.filter((f) => !f.done).map((f) => ({ path: f.path, size: f.size, lastModified: f.lastModified })),
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------------------------

  upload(request: UploadRequest): void {
    if (this.disposed || this.jobs.has(request.id)) return;
    const job = new UploadJob(
      {
        id: request.id,
        workspaceId: this.deps.workspaceId,
        root: request.root,
        targetDir: request.targetDir,
        name: request.name,
        items: request.items,
        ...(request.rejected ? { rejected: request.rejected } : {}),
        ...(request.handles ? { handles: request.handles } : {}),
      },
      this.uploadDeps(),
    );
    this.add(job);
  }

  /** Continues an upload from the journal with the files chosen again (matched by path, size and date). */
  resumeUpload(id: string, items: readonly UploadItem[]): void {
    const record = this.interrupted.get(id);
    if (this.disposed || !record) return;
    this.interrupted.delete(id);
    const job = new UploadJob(
      {
        id,
        workspaceId: this.deps.workspaceId,
        root: record.root,
        targetDir: record.targetDir,
        name: record.name,
        items: [...record.dirs.map((path): UploadItem => ({ path: relativeTo(record.targetDir, path), kind: 'dir' })), ...items],
        resume: record,
        ...(record.handles ? { handles: record.handles } : {}),
      },
      this.uploadDeps(),
    );
    this.add(job);
  }

  download(request: DownloadRequest): void {
    if (this.disposed || this.jobs.has(request.id)) return;
    const job = new DownloadJob(
      { id: request.id, file: request.file, zip: request.zip, name: request.name, ...(request.picker ? { picker: request.picker } : {}) },
      {
        link: this.ensureLink(),
        slots: this.downloadSlots,
        writers: this.deps.writers,
        now: this.now,
        onChange: (changed) => this.report(changed),
        onOutput: (done, output) => this.deps.emit({ t: 'output', id: done.id, blob: output.blob }),
      },
    );
    this.add(job);
  }

  pause(id: string): void {
    const job = this.jobs.get(id);
    if (job instanceof UploadJob) job.pauseJob();
  }

  resume(id: string): void {
    const job = this.jobs.get(id);
    if (job instanceof UploadJob && job.snapshot().status === 'paused') {
      this.ensureLink();
      job.start();
      this.watch(job);
    }
  }

  retry(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.ensureLink();
    job.retry();
    this.watch(job);
  }

  answer(id: string, policy: UploadConflictPolicy | null): void {
    const job = this.jobs.get(id);
    if (job instanceof UploadJob) job.answer(policy);
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      await job.cancel();
      this.scheduleIdleClose();
      return;
    }
    await this.discard(id);
  }

  /** Gives up an interrupted upload: its partial uploads are removed from the host when the socket is up. */
  async discard(id: string): Promise<void> {
    const record = this.interrupted.get(id);
    if (!record) return;
    this.interrupted.delete(id);
    await this.deps.journal?.remove(id).catch(() => {});
    this.deps.emit({ t: 'removed', id });
    const ids = record.files.flatMap((f) => (f.done || f.uploadId === undefined ? [] : [f.uploadId]));
    if (ids.length === 0) return;
    const link = this.ensureLink();
    // Best effort, bounded: the host sweeps abandoned partial uploads after 48 h anyway.
    const giveUp = new AbortController();
    const online = await Promise.race([
      waitForOnline(link, giveUp.signal).then(
        () => true,
        () => false,
      ),
      delay(DISCARD_WAIT_MS, giveUp.signal).then(
        () => false,
        () => false,
      ),
    ]);
    giveUp.abort();
    if (online) for (const uploadId of ids) await link.request('file.upload.abort', { uploadId }).catch(() => {});
    this.scheduleIdleClose();
  }

  /** Forget a finished job (the panel's "Clear finished"). */
  forget(id: string): void {
    const job = this.jobs.get(id);
    if (job && !job.finished) return;
    this.jobs.delete(id);
    const throttle = this.throttles.get(id);
    if (throttle?.timer) clearTimeout(throttle.timer);
    this.throttles.delete(id);
  }

  /**
   * R7.2 measurement: uploads `size` bytes from a synthetic source (nothing is read from or written to the local
   * disk) with the real engine, and reports throughput and the flow-control peaks. `finalize: 'abort'` (default)
   * removes the upload from the host at the end instead of committing it.
   */
  measure(request: MeasureRequest): void {
    const source: UploadSourceFile = createSyntheticSource({ size: request.size, seed: request.seed ?? 1, name: request.path.split('/').at(-1) ?? 'measure.bin', lastModified: this.now() });
    const parent = request.path.includes('/') ? request.path.slice(0, request.path.lastIndexOf('/')) : '';
    const name = request.path.slice(parent === '' ? 0 : parent.length + 1);
    const job = new UploadJob(
      {
        id: request.id,
        workspaceId: this.deps.workspaceId,
        root: request.root,
        targetDir: parent,
        name,
        items: [{ path: name, kind: 'file', file: source }],
        finalize: request.finalize ?? 'abort',
      },
      { ...this.uploadDeps(), journal: null },
    );
    const link = this.ensureLink();
    let maxBuffered = 0;
    const sampler = setInterval(() => {
      maxBuffered = Math.max(maxBuffered, link.bufferedAmount);
    }, 20);
    const startedAt = this.now();
    this.add(job);
    void job.whenSettled().then(() => {
      clearInterval(sampler);
      const durationMs = Math.max(1, this.now() - startedAt);
      const snapshot = job.snapshot();
      this.deps.emit({
        t: 'measured',
        id: request.id,
        result: {
          bytes: snapshot.doneBytes,
          durationMs,
          bytesPerSecond: (snapshot.doneBytes * 1000) / durationMs,
          maxBufferedAmount: maxBuffered,
          peakBytesInFlight: this.budget.peakInUse,
          status: snapshot.status,
        },
      });
    });
  }

  /** Writes pending journal entries and closes the socket (the page is going away or the workspace was closed). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.jobs.values()].map((job) => (job instanceof UploadJob ? job.flushJournal() : Promise.resolve())));
    for (const throttle of this.throttles.values()) if (throttle.timer) clearTimeout(throttle.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.link.detach();
  }

  // ---------------------------------------------------------------------------------------------------------------

  private uploadDeps() {
    return {
      link: this.ensureLink(),
      budget: this.budget,
      fileSlots: this.fileSlots,
      hasher: this.deps.hasher,
      journal: this.deps.journal,
      now: this.now,
      onChange: (job: UploadJob) => this.report(job),
      ...(this.deps.journalDelayMs !== undefined ? { journalDelayMs: this.deps.journalDelayMs } : {}),
    };
  }

  private add(job: Job): void {
    this.jobs.set(job.id, job);
    this.report(job, true);
    job.start();
    this.watch(job);
  }

  /** Closes the socket a while after the last job of a run settled. */
  private watch(job: Job): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void job.whenSettled().then(() => {
      this.report(job, true);
      this.scheduleIdleClose();
    });
  }

  /** Busy = a job that will still use the socket: running, preparing, queued, or paused only because offline. */
  private busy(): boolean {
    return [...this.jobs.values()].some((job) => {
      if (job.finished) return false;
      const snapshot = job.snapshot();
      return !(snapshot.status === 'paused' && snapshot.pause === 'user');
    });
  }

  private scheduleIdleClose(): void {
    if (this.disposed || this.link.connection === null || this.idleTimer !== null || this.busy()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.busy()) this.link.detach();
    }, this.deps.linkIdleCloseMs ?? LINK_IDLE_CLOSE_MS);
  }

  /** The socket for new work: opened (and started) if it was closed. Jobs hold the ManagedLink, never the socket. */
  private ensureLink(): TransferLink {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.link.connection === null) {
      const connection = this.deps.createLink();
      this.link.attach(connection);
      connection.start();
    }
    return this.link;
  }

  private report(job: Job, force = false): void {
    const snapshot = job.snapshot();
    let throttle = this.throttles.get(job.id);
    if (!throttle) {
      throttle = { lastAt: 0, lastStatus: null, timer: null };
      this.throttles.set(job.id, throttle);
    }
    const t = throttle;
    const due = force || snapshot.status !== t.lastStatus || snapshot.conflict !== null || this.now() - t.lastAt >= (this.deps.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS);
    if (due) {
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = null;
      }
      t.lastAt = this.now();
      t.lastStatus = snapshot.status;
      this.deps.emit({ t: 'job', snapshot });
      return;
    }
    t.timer ??= setTimeout(() => {
      t.timer = null;
      this.report(job, true);
    }, this.deps.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS);
  }
}

function relativeTo(dir: string, path: string): string {
  return dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

/** How an upload left by a reload looks until its files are chosen again. */
export function interruptedSnapshot(record: JournalRecord): JobSnapshot {
  let totalBytes = 0;
  let doneBytes = 0;
  let filesDone = 0;
  for (const f of record.files) {
    totalBytes += f.size;
    if (f.done) {
      doneBytes += f.size;
      filesDone++;
    }
  }
  return {
    id: record.jobId,
    kind: 'upload',
    name: record.name,
    root: record.root,
    path: record.targetDir,
    totalBytes,
    doneBytes,
    files: record.files.length,
    filesDone,
    status: 'paused',
    pause: 'reload',
    verifying: false,
    bytesPerSecond: 0,
    failure: null,
    fileFailures: [],
    rejected: [],
    conflict: null,
    download: null,
    startedAt: record.createdAt,
  };
}
