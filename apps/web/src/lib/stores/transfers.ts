// Uploads and downloads in progress (SPEC R7, transfer.md). Transfers do not run on the interactive connection: the
// transfer feature runs them on its own TransferConnection (in a Web Worker) and REPORTS progress here, so the
// transfers panel, the file tree and the top bar can show it. This store is the only one not fed by the connection,
// and it survives resyncs (uploads resume from the daemon's bitmap on their own socket).
import { isRelPathWithin, rootRefEquals, type FileRef, type RootRef } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import type { AreaLifecycle } from './base.ts';

export type TransferKind = 'upload' | 'download';

export type TransferStatus =
  /** Accepted, waiting for its turn. */
  | 'queued'
  /** Planning / disk check (uploads) or waiting for file.download.begin. */
  | 'preparing'
  | 'running'
  /** Connection lost; resumes by itself when it comes back. */
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TransferJob {
  readonly id: string;
  readonly kind: TransferKind;
  /** File or folder name shown to the person. */
  readonly name: string;
  /** Upload target directory or download source. */
  readonly root: RootRef;
  readonly path: string;
  /** Unknown for zip downloads until they end. */
  readonly totalBytes: number | null;
  readonly doneBytes: number;
  /** Number of files (folder uploads, zip downloads), if known. */
  readonly files: number | null;
  readonly status: TransferStatus;
  /** A sentence for the person, when failed (e.g. the host's disk check refused an upload). */
  readonly error: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface TransfersState {
  readonly jobs: ReadonlyMap<string, TransferJob>;
}

export type NewTransferJob = Omit<TransferJob, 'doneBytes' | 'status' | 'error' | 'startedAt' | 'updatedAt'> &
  Partial<Pick<TransferJob, 'doneBytes' | 'status'>>;

export interface TransfersStore extends ReadableStore<TransfersState> {
  /** Registers a job; `cancel` is what cancel(id) runs (the transfer feature aborts the upload/download). */
  add(job: NewTransferJob, cancel?: () => void): TransferJob;
  update(id: string, patch: Partial<Pick<TransferJob, 'status' | 'doneBytes' | 'totalBytes' | 'files' | 'error' | 'name'>>): void;
  /** Asks the owner of the job to stop it; the owner then reports status 'cancelled'. */
  cancel(id: string): void;
  remove(id: string): void;
  /** Removes done, failed and cancelled jobs. */
  clearFinished(): void;
}

export const INITIAL_TRANSFERS_STATE: TransfersState = Object.freeze({ jobs: new Map() });

const FINISHED: ReadonlySet<TransferStatus> = new Set(['done', 'failed', 'cancelled']);

export const isTransferFinished = (job: TransferJob): boolean => FINISHED.has(job.status);
/** Oldest first. */
export const selectTransferList = (state: TransfersState): TransferJob[] => [...state.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
export const selectActiveTransfers = (state: TransfersState): TransferJob[] => selectTransferList(state).filter((job) => !isTransferFinished(job));
/** Transfers touching `file` or anything below it (tree badges). */
export function selectTransfersFor(state: TransfersState, file: FileRef): TransferJob[] {
  return selectTransferList(state).filter((job) => rootRefEquals(job.root, file.root) && isRelPathWithin(job.path, file.path));
}

export function createTransfersArea(now: () => number = Date.now): { store: TransfersStore; lifecycle: AreaLifecycle } {
  const state = createStore<TransfersState>(INITIAL_TRANSFERS_STATE);
  const cancellers = new Map<string, () => void>();

  const store: TransfersStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    add(input, cancel) {
      const at = now();
      const job: TransferJob = {
        ...input,
        doneBytes: input.doneBytes ?? 0,
        status: input.status ?? 'queued',
        error: null,
        startedAt: at,
        updatedAt: at,
      };
      if (cancel) cancellers.set(job.id, cancel);
      state.setState((previous) => {
        const jobs = new Map(previous.jobs);
        jobs.set(job.id, job);
        return { jobs };
      });
      return job;
    },
    update(id, patch) {
      state.setState((previous) => {
        const job = previous.jobs.get(id);
        if (!job) return previous;
        const jobs = new Map(previous.jobs);
        jobs.set(id, { ...job, ...patch, updatedAt: now() });
        if (patch.status !== undefined && FINISHED.has(patch.status)) cancellers.delete(id);
        return { jobs };
      });
    },
    cancel(id) {
      const cancel = cancellers.get(id);
      cancellers.delete(id);
      cancel?.();
    },
    remove(id) {
      cancellers.delete(id);
      state.setState((previous) => {
        if (!previous.jobs.has(id)) return previous;
        const jobs = new Map(previous.jobs);
        jobs.delete(id);
        return { jobs };
      });
    },
    clearFinished() {
      state.setState((previous) => ({ jobs: new Map([...previous.jobs].filter(([, job]) => !FINISHED.has(job.status))) }));
    },
  };

  const lifecycle: AreaLifecycle = {
    bind: () => () => {},
    reset() {},
    load: () => Promise.resolve(),
    dispose() {
      for (const cancel of cancellers.values()) cancel();
      cancellers.clear();
    },
  };
  return { store, lifecycle };
}
