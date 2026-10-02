// One upload the person started (a drop, a picker selection, or a resumed journal entry): SPEC R7 upload bullets,
// ARCHITECTURE §5.2, transfer.md §1.3.
//
//   plan (folder drops and multi-file selections; ≤ 10,000 entries per request): ONE disk check for the batch,
//        every folder created (empty ones too). A name that exists ⇒ the person chooses overwrite / keep both / cancel.
//   files: each through FileUpload (begin → chunks → commit), at most `fileSlots` files at once across ALL jobs of
//        the connection, inside the connection's byte budget.
//   offline: every file waits for the transfer socket and resumes from the daemon's bitmap; the job shows 'paused'.
//   pause / resume / cancel: pause stops after the chunks in flight; cancel also aborts the partial uploads on the host.
import { UPLOAD_PLAN_MAX_ENTRIES, errorReasonOf, isSmurgError, joinRelPath, type RootRef } from '@smurg/protocol';
import { DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, MIN_CHUNK_SIZE } from '@smurg/protocol';
import { toFailure } from './failures.ts';
import type { JournalRecord, UploadJournal } from './journal.ts';
import type { Budget, Semaphore } from './limits.ts';
import {
  LinkEndedError,
  TransferCancelledError,
  TransferInterruptedError,
  abortReason,
  isConnectivityError,
  waitForOnline,
  type TransferLink,
} from './link.ts';
import { RateMeter } from './rate.ts';
import { anySignal } from './signals.ts';
import type { ChunkHasher, UploadSourceFile } from './source.ts';
import { MAX_LISTED_CONFLICTS, type ConflictQuestion, type FileFailure, type JobSnapshot, type PauseCause, type TransferFailure, type UploadConflictPolicy } from './types.ts';
import { FileUpload } from './upload-file.ts';
import type { TransferStatus } from '../../../lib/stores/transfers.ts';

export interface UploadItem {
  /** Relative to the target directory, NFC. */
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly file?: UploadSourceFile;
}

export interface UploadJobSpec {
  readonly id: string;
  readonly workspaceId: string;
  readonly root: RootRef;
  readonly targetDir: string;
  readonly name: string;
  readonly items: readonly UploadItem[];
  readonly rejected?: readonly { readonly path: string; readonly problem: string }[];
  readonly handles?: Readonly<Record<string, FileSystemHandle>>;
  /** Resuming a journal entry after a reload: the recorded plan (targets, chunk size, policy, committed files). */
  readonly resume?: JournalRecord;
  /** 'abort' instead of committing (the measurement page leaves nothing on the host). */
  readonly finalize?: 'commit' | 'abort';
}

export interface UploadJobDeps {
  readonly link: TransferLink;
  readonly budget: Budget;
  /** Files in progress at once, shared by every job of the connection. */
  readonly fileSlots: Semaphore;
  readonly hasher: ChunkHasher;
  readonly journal: UploadJournal | null;
  readonly now?: () => number;
  /** The snapshot changed (the manager throttles what it posts). */
  readonly onChange: (job: UploadJob) => void;
  /** Journal writes are batched this long (default 1 s). */
  readonly journalDelayMs?: number;
}

/** The person answered "Cancel upload" to a name conflict. */
export class ConflictDeclinedError extends Error {
  override readonly name = 'ConflictDeclinedError';
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super('upload cancelled at a name conflict');
    this.paths = paths;
  }
}

interface FileState {
  readonly item: UploadItem & { readonly file: UploadSourceFile };
  target: string;
  upload: FileUpload | null;
  done: boolean;
  uploadId?: string;
  failure: TransferFailure | null;
}

/** Refusals that stop the whole job (every other file would get the same answer). */
function isJobFatal(error: unknown): boolean {
  if (error instanceof LinkEndedError) return true;
  if (!isSmurgError(error)) return false;
  if (error.code === 'insufficient_disk' || error.code === 'forbidden' || error.code === 'unauthorized' || error.code === 'host_only') return true;
  return error.code === 'conflict' && errorReasonOf(error) === 'too-many-uploads';
}

function isExists(error: unknown): boolean {
  return isSmurgError(error) && error.code === 'conflict' && errorReasonOf(error) === 'exists';
}

/** `detail.paths` of a plan refusal: `{ path, reason }[]` (at most 100). */
function conflictPaths(error: unknown): string[] {
  if (!isSmurgError(error)) return [];
  const paths = error.detail?.['paths'];
  if (!Array.isArray(paths)) return [];
  return paths.flatMap((p: unknown) => (typeof p === 'object' && p !== null && typeof (p as { path?: unknown }).path === 'string' ? [(p as { path: string }).path] : []));
}

export function clampChunkSize(size: number | undefined): number {
  if (size === undefined || !Number.isSafeInteger(size)) return DEFAULT_CHUNK_SIZE;
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, size));
}

export class UploadJob {
  readonly spec: UploadJobSpec;
  private readonly deps: UploadJobDeps;
  private readonly now: () => number;
  private readonly files: FileState[] = [];
  private readonly dirs: string[] = [];
  private readonly rate: RateMeter;
  private readonly startedAt: number;
  private status: TransferStatus = 'queued';
  private pause: PauseCause | null = null;
  private failure: TransferFailure | null = null;
  private conflict: ConflictQuestion | null = null;
  private answerQuestion: ((policy: UploadConflictPolicy | null) => void) | null = null;
  private questionChain: Promise<unknown> = Promise.resolve();
  private policy: UploadConflictPolicy;
  /** The person already chose a policy for this job: later conflicts use it without asking again. */
  private policyChosen: boolean;
  private planned: boolean;
  private chunkSize: number | null;
  private verifying = false;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private journalTimer: ReturnType<typeof setTimeout> | null = null;
  private journalWrite: Promise<void> = Promise.resolve();
  private offlineUnsubscribe: (() => void) | null = null;

  constructor(spec: UploadJobSpec, deps: UploadJobDeps) {
    this.spec = spec;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.rate = new RateMeter({ now: this.now });
    this.startedAt = this.now();
    const resume = spec.resume;
    this.policy = resume?.policy ?? 'fail';
    this.policyChosen = resume !== undefined && resume.policy !== 'fail';
    this.planned = resume !== undefined;
    this.chunkSize = resume?.chunkSize ?? null;
    const recorded = new Map((resume?.files ?? []).map((f) => [f.path, f]));
    for (const item of spec.items) {
      const target = joinRelPath(spec.targetDir, item.path);
      if (target === null) continue; // collect.ts already refused such names
      if (item.kind === 'dir') {
        this.dirs.push(target);
        continue;
      }
      if (!item.file) continue;
      const entry = recorded.get(item.path);
      // A journalled file counts as the same file only with the same identity; otherwise it is uploaded fresh.
      const same = entry !== undefined && entry.size === item.file.size && entry.lastModified === Math.floor(item.file.lastModified);
      this.files.push({
        item: item as FileState['item'],
        target: same ? entry.target : target,
        upload: null,
        done: same ? entry.done : false,
        ...(same && entry.uploadId !== undefined ? { uploadId: entry.uploadId } : {}),
        failure: null,
      });
    }
  }

  get id(): string {
    return this.spec.id;
  }

  get finished(): boolean {
    return this.status === 'done' || this.status === 'failed' || this.status === 'cancelled';
  }

  /** Resolves when the current run ends (tests). */
  whenSettled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  snapshot(): JobSnapshot {
    let doneBytes = 0;
    let totalBytes = 0;
    let filesDone = 0;
    for (const f of this.files) {
      totalBytes += f.item.file.size;
      if (f.done) {
        filesDone++;
        doneBytes += f.item.file.size;
      } else if (f.upload) {
        doneBytes += f.upload.doneBytes;
      }
    }
    const offline = (this.status === 'running' || this.status === 'preparing') && this.deps.link.getState().kind !== 'online';
    return {
      id: this.spec.id,
      kind: 'upload',
      name: this.spec.name,
      root: this.spec.root,
      path: this.spec.targetDir,
      totalBytes,
      doneBytes,
      files: this.files.length,
      filesDone,
      status: offline ? 'paused' : this.status,
      pause: offline ? 'offline' : this.pause,
      verifying: this.verifying && this.status === 'running',
      bytesPerSecond: this.status === 'running' && !offline ? this.rate.bytesPerSecond : 0,
      failure: this.failure,
      fileFailures: this.files.flatMap((f): FileFailure[] => (f.failure ? [{ path: f.target, failure: f.failure }] : [])),
      rejected: this.spec.rejected ?? [],
      conflict: this.conflict,
      download: null,
      startedAt: this.startedAt,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------------------------------------------------

  /** Starts (or resumes) the job. No-op while it runs or once it is finished. */
  start(): void {
    if (this.running !== null || this.finished) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(controller.signal).finally(() => {
      if (this.controller === controller) this.controller = null;
      this.running = null;
    });
  }

  /** Stops after the chunks in flight; `start()` continues from the daemon's bitmap. */
  pauseJob(): void {
    if (this.finished || this.status === 'paused') return;
    this.controller?.abort(new TransferInterruptedError('paused'));
    this.setStatus('paused', 'user');
  }

  /** Retry after a failure: files that failed are tried again, the committed ones are kept. */
  retry(): void {
    if (this.status !== 'failed') return;
    for (const f of this.files) f.failure = null;
    this.failure = null;
    this.status = 'queued';
    this.start();
  }

  /** Stops the job and removes its partial uploads from the host (best effort; the host also sweeps after 48 h). */
  async cancel(): Promise<void> {
    if (this.finished) return;
    this.controller?.abort(new TransferCancelledError('cancelled'));
    this.answerQuestion?.(null);
    await this.running;
    this.setStatus('cancelled');
    await this.abortPartials();
    await this.forgetJournal();
  }

  /** The person's answer to the name-conflict question (null = cancel). */
  answer(policy: UploadConflictPolicy | null): void {
    this.answerQuestion?.(policy);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------------------------------------------

  private async run(signal: AbortSignal): Promise<void> {
    this.failure = null;
    this.setStatus('preparing');
    const link = this.deps.link;
    this.offlineUnsubscribe = link.subscribe(() => this.changed());
    try {
      await this.online(signal);
      this.chunkSize ??= clampChunkSize(link.welcome?.settings.uploadChunkSize);
      if (!this.planned) await this.plan(signal);
      this.scheduleJournal();
      this.setStatus('running');
      await this.uploadFiles(signal);
      if (this.files.some((f) => f.failure !== null)) {
        this.setStatus('failed');
        this.scheduleJournal();
      } else {
        this.setStatus('done');
        await this.forgetJournal();
      }
    } catch (error) {
      if (signal.aborted) {
        const reason = abortReason(signal);
        // cancel() sets 'cancelled' itself after the run settled; a pause keeps 'paused'.
        if (reason instanceof TransferInterruptedError) this.setStatus('paused', 'user');
        return;
      }
      this.failure = error instanceof ConflictDeclinedError ? { kind: 'conflict-declined', paths: error.paths } : toFailure(error);
      this.setStatus('failed');
      this.scheduleJournal();
    } finally {
      this.offlineUnsubscribe?.();
      this.offlineUnsubscribe = null;
      this.verifying = false;
      this.rate.reset();
    }
  }

  /** Waits for the transfer socket (the snapshot shows 'paused' / offline meanwhile). */
  private async online(signal: AbortSignal): Promise<void> {
    if (this.deps.link.getState().kind === 'online') return;
    this.rate.reset();
    this.changed();
    await waitForOnline(this.deps.link, signal);
    this.changed();
  }

  /** Runs `task`, waiting for the socket and trying again whenever it fails for connectivity. */
  private async whileConnected<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      try {
        return await task();
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (!isConnectivityError(error) || error instanceof LinkEndedError) throw error;
        await this.online(signal);
      }
    }
  }

  private async plan(signal: AbortSignal): Promise<void> {
    const pendingFiles = this.files.filter((f) => !f.done);
    // A single file into an existing folder needs no plan: its begin does the disk check.
    if (this.dirs.length === 0 && pendingFiles.length <= 1) {
      this.planned = true;
      return;
    }
    const entries: { path: string; kind: 'file' | 'dir'; size?: number; state?: FileState }[] = [
      ...this.dirs.map((path) => ({ path, kind: 'dir' as const })),
      ...pendingFiles.map((state) => ({ path: state.target, kind: 'file' as const, size: state.item.file.size, state })),
    ];
    for (let from = 0; from < entries.length; from += UPLOAD_PLAN_MAX_ENTRIES) {
      const batch = entries.slice(from, from + UPLOAD_PLAN_MAX_ENTRIES);
      const payloadEntries = batch.map((e) => (e.kind === 'dir' ? { path: e.path, kind: e.kind } : { path: e.path, kind: e.kind, size: e.size as number }));
      for (;;) {
        try {
          const result = await this.whileConnected(
            () => this.deps.link.request('file.upload.plan', { root: this.spec.root, entries: payloadEntries, onConflict: this.policy }, { signal }),
            signal,
          );
          const renamed = new Map(result.renamed.map((r) => [r.from, r.to]));
          for (const entry of batch) if (entry.state) entry.state.target = renamed.get(entry.path) ?? entry.path;
          break;
        } catch (error) {
          if (!isExists(error) || this.policy !== 'fail') throw error;
          this.policy = await this.ask(conflictPaths(error), signal);
          this.policyChosen = true;
        }
      }
    }
    this.planned = true;
  }

  /** Asks the person (one question at a time per job) and resolves with the chosen policy; throws on cancel. */
  private ask(paths: readonly string[], signal: AbortSignal): Promise<UploadConflictPolicy> {
    const next = this.questionChain.then(async () => {
      if (this.policyChosen && this.policy !== 'fail') return this.policy;
      if (signal.aborted) throw abortReason(signal);
      const answer = await new Promise<UploadConflictPolicy | null>((resolve) => {
        this.conflict = { paths: paths.slice(0, MAX_LISTED_CONFLICTS), more: Math.max(0, paths.length - MAX_LISTED_CONFLICTS) };
        this.answerQuestion = resolve;
        const onAbort = (): void => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
        this.changed();
      });
      this.conflict = null;
      this.answerQuestion = null;
      this.changed();
      if (signal.aborted) throw abortReason(signal);
      if (answer === null || answer === 'fail') throw new ConflictDeclinedError(paths);
      return answer;
    });
    this.questionChain = next.catch(() => {});
    return next;
  }

  private async uploadFiles(signal: AbortSignal): Promise<void> {
    const todo = this.files.filter((f) => !f.done);
    // A refusal that concerns the whole job (disk, permission, connection ended) stops its other files too.
    const stop = new AbortController();
    const combined = anySignal(signal, stop.signal);
    let fatal: { readonly error: unknown } | null = null;
    try {
      await Promise.allSettled(
        todo.map(async (state) => {
          let release: (() => void) | null = null;
          try {
            release = await this.deps.fileSlots.enter(combined.signal);
            await this.uploadOne(state, combined.signal);
          } catch (error) {
            if (!combined.signal.aborted) {
              fatal ??= { error };
              stop.abort(new TransferInterruptedError('paused'));
            }
          } finally {
            release?.();
          }
        }),
      );
    } finally {
      combined.dispose();
    }
    if (signal.aborted) throw abortReason(signal);
    if (fatal !== null) throw (fatal as { readonly error: unknown }).error;
  }

  private fileUpload(state: FileState): FileUpload {
    state.upload ??= new FileUpload({
      root: this.spec.root,
      path: state.target,
      source: state.item.file,
      chunkSize: this.chunkSize ?? DEFAULT_CHUNK_SIZE,
      onConflict: this.policy === 'fail' ? 'fail' : this.policy,
      uploadId: state.uploadId,
      ...(this.spec.finalize ? { finalize: this.spec.finalize } : {}),
    });
    return state.upload;
  }

  private async uploadOne(state: FileState, signal: AbortSignal): Promise<void> {
    const upload = this.fileUpload(state);
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      try {
        await upload.run(
          {
            link: this.deps.link,
            budget: this.deps.budget,
            hasher: this.deps.hasher,
            onBegin: ({ uploadId }) => {
              state.uploadId = uploadId;
              this.scheduleJournal();
            },
            onProgress: (_bytes, phase) => {
              this.verifying = phase === 'verifying';
              this.rate.sample(this.snapshotBytes());
              this.changed();
            },
          },
          signal,
        );
        state.done = true;
        state.failure = null;
        this.scheduleJournal();
        this.changed();
        return;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof TransferInterruptedError) {
          await this.online(signal);
          continue;
        }
        if (isExists(error)) {
          try {
            const policy = await this.ask([state.target], signal);
            upload.spec.onConflict = policy;
            this.policy = policy;
            this.policyChosen = true;
            continue;
          } catch (declined) {
            if (!(declined instanceof ConflictDeclinedError)) throw declined;
            state.failure = { kind: 'conflict-declined', paths: [state.target] };
            this.changed();
            return;
          }
        }
        if (isJobFatal(error)) throw error;
        state.failure = toFailure(error, state.target);
        this.changed();
        return;
      }
    }
  }

  private snapshotBytes(): number {
    let bytes = 0;
    for (const f of this.files) bytes += f.done ? f.item.file.size : (f.upload?.doneBytes ?? 0);
    return bytes;
  }

  private async abortPartials(): Promise<void> {
    const link = this.deps.link;
    const pending = this.files.filter((f) => !f.done && f.upload !== null);
    await Promise.all(pending.map((f) => (f.upload as FileUpload).cancel(link).catch(() => {})));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Journal (best effort: a failed write never fails the upload)
  // ---------------------------------------------------------------------------------------------------------------

  private journalRecord(): JournalRecord {
    return {
      v: 1,
      jobId: this.spec.id,
      workspaceId: this.spec.workspaceId,
      root: this.spec.root,
      targetDir: this.spec.targetDir,
      name: this.spec.name,
      chunkSize: this.chunkSize ?? DEFAULT_CHUNK_SIZE,
      policy: this.policy,
      createdAt: this.spec.resume?.createdAt ?? this.startedAt,
      dirs: this.dirs,
      files: this.files.map((f) => ({
        path: f.item.path,
        target: f.target,
        size: f.item.file.size,
        lastModified: Math.floor(f.item.file.lastModified),
        done: f.done,
        ...(f.uploadId !== undefined ? { uploadId: f.uploadId } : {}),
      })),
      ...(this.spec.handles ? { handles: this.spec.handles } : {}),
    };
  }

  private scheduleJournal(): void {
    const journal = this.deps.journal;
    if (!journal || this.spec.finalize === 'abort' || !this.planned || this.journalTimer !== null) return;
    this.journalTimer = setTimeout(() => {
      this.journalTimer = null;
      if (this.status === 'cancelled' || this.status === 'done') return;
      const record = this.journalRecord();
      this.journalWrite = this.journalWrite.then(() => journal.put(record)).catch(() => {});
    }, this.deps.journalDelayMs ?? 1_000);
  }

  private async forgetJournal(): Promise<void> {
    if (this.journalTimer !== null) clearTimeout(this.journalTimer);
    this.journalTimer = null;
    const journal = this.deps.journal;
    if (!journal) return;
    this.journalWrite = this.journalWrite.then(() => journal.remove(this.spec.id)).catch(() => {});
    await this.journalWrite;
  }

  /** Writes the journal now (the manager calls it before the Worker is terminated). */
  async flushJournal(): Promise<void> {
    if (this.journalTimer === null) return this.journalWrite;
    clearTimeout(this.journalTimer);
    this.journalTimer = null;
    const journal = this.deps.journal;
    if (journal) this.journalWrite = this.journalWrite.then(() => journal.put(this.journalRecord())).catch(() => {});
    return this.journalWrite;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private setStatus(status: TransferStatus, pause: PauseCause | null = null): void {
    this.status = status;
    this.pause = status === 'paused' ? pause : null;
    if (status !== 'running') this.rate.reset();
    this.changed();
  }

  private changed(): void {
    this.deps.onChange(this);
  }
}
