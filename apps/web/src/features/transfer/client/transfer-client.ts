// The page side of transfers: one transfer Worker per open workspace. The page collects what a drop or a picker
// handed over (FileSystemEntry trees exist only here), posts File objects to the Worker, and mirrors the Worker's
// snapshots into the app's transfers store (useStores().transfers: tree badges, the drawer's count) and into its own
// store (speed, conflicts, download notes). It never reads file contents itself.
//
// The client lives as long as the workspace session, not as long as a component: jobs keep running while the person
// moves between the workspace and the host console, and stop (resumable from the journal) when the session ends.
import type { FileRef, RootRef } from '@smurg/protocol';
import { isTerminalState } from '@smurg/protocol/client';
import type { UploadSource } from '../../../lib/commands.ts';
import { describeDevice } from '../../../lib/connection/browser-deps.ts';
import { createStore, type ReadableStore } from '../../../lib/store.ts';
import type { TransferJob, TransfersStore } from '../../../lib/stores/transfers.ts';
import type { WorkspaceSession } from '../../../lib/workspace/session.ts';
import { collectUploadSource, type Collection } from '../engine/collect.ts';
import type { MeasureResult } from '../engine/manager.ts';
import type { JobSnapshot, UploadConflictPolicy } from '../engine/types.ts';
import { t } from '../strings.ts';
import { describeFailure } from '../ui/describe.ts';
import type { FromWorker, ToWorker, WireItem } from '../worker/protocol.ts';

export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
}

export type WorkerFactory = () => WorkerLike;

/** The real Worker (Vite bundles it as its own chunk from this literal `new URL(…)`). Null where there is none. */
export function browserWorkerFactory(): WorkerFactory | null {
  if (typeof Worker === 'undefined') return null;
  return () => new Worker(new URL('../worker/transfer.worker.ts', import.meta.url), { type: 'module', name: 'smurg-transfer' }) as unknown as WorkerLike;
}

export interface InterruptedUpload {
  readonly files: readonly { readonly path: string; readonly size: number; readonly lastModified: number }[];
  readonly handles: Readonly<Record<string, FileSystemHandle>> | null;
}

export interface SavedOutput {
  readonly url: string;
  readonly name: string;
}

export type WorkerStatus = 'starting' | 'ready' | 'unavailable' | 'no-storage' | 'failed';

export interface TransferClientState {
  readonly jobs: ReadonlyMap<string, JobSnapshot>;
  readonly interrupted: ReadonlyMap<string, InterruptedUpload>;
  readonly outputs: ReadonlyMap<string, SavedOutput>;
  readonly measured: ReadonlyMap<string, MeasureResult>;
  readonly worker: WorkerStatus;
  readonly workerError: string | null;
  /** ConnectionState kind of the transfer socket ('idle' while none is open). */
  readonly link: string;
}

export interface TransferClientOptions {
  readonly workspaceId: string;
  readonly transfers: TransfersStore;
  readonly createWorker: WorkerFactory | null;
  readonly deviceName?: string;
  /** Hands a finished download to the browser (default: a temporary `<a download>`). */
  readonly save?: (url: string, name: string) => void;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly randomId?: () => string;
}

export interface UploadStarted {
  readonly id: string | null;
  readonly collection: Collection;
}

function defaultSave(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function randomJobId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `xfer_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const lastSegment = (path: string): string => path.split('/').at(-1) ?? path;

export class TransferClient {
  private readonly options: TransferClientOptions;
  private readonly state = createStore<TransferClientState>({
    jobs: new Map(),
    interrupted: new Map(),
    outputs: new Map(),
    measured: new Map(),
    worker: 'starting',
    workerError: null,
    link: 'idle',
  });
  private worker: WorkerLike | null = null;
  private disposed = false;
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly unloadGuard = (event: BeforeUnloadEvent): void => {
    // A reload would interrupt running transfers (uploads resume from the journal, but only after re-picking files).
    event.preventDefault();
  };
  private unloadGuardOn = false;

  constructor(options: TransferClientOptions) {
    this.options = options;
    this.createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    if (!options.createWorker) {
      this.state.setState((s) => ({ ...s, worker: 'unavailable' }));
      return;
    }
    try {
      this.worker = options.createWorker();
    } catch (error) {
      this.state.setState((s) => ({ ...s, worker: 'failed', workerError: error instanceof Error ? error.message : String(error) }));
      return;
    }
    this.worker.addEventListener('message', (event) => this.onMessage(event.data));
    this.worker.addEventListener('error', () => {
      this.state.setState((s) => ({ ...s, worker: 'failed', workerError: s.workerError ?? 'worker error' }));
    });
    this.post({ t: 'init', workspaceId: options.workspaceId, deviceName: options.deviceName ?? describeDevice(typeof navigator === 'undefined' ? '' : navigator.userAgent) });
  }

  get store(): ReadableStore<TransferClientState> {
    return this.state;
  }

  get available(): boolean {
    const status = this.state.getState().worker;
    return status === 'starting' || status === 'ready';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------------------------------------------

  /** Collects `source` (await it inside the command handler) and queues the upload. */
  async upload(root: RootRef, targetDir: string, source: UploadSource): Promise<UploadStarted> {
    const collection = await collectUploadSource(source);
    if (collection.items.length === 0 || !this.available) return { id: null, collection };
    const id = (this.options.randomId ?? randomJobId)();
    const name = collection.topNames.length > 1 ? t('name.multiple', { first: collection.topNames[0] as string, count: collection.topNames.length }) : (collection.topNames[0] ?? lastSegment(collection.items[0]?.path ?? ''));
    const items: WireItem[] = collection.items.map((item) => (item.kind === 'file' ? { path: item.path, kind: 'file', file: item.file } : { path: item.path, kind: 'dir' }));
    this.register({ id, kind: 'upload', name, root, path: targetDir, totalBytes: collection.totalBytes, files: collection.fileCount });
    const message: ToWorker = {
      t: 'upload',
      id,
      root,
      targetDir,
      name,
      items,
      rejected: collection.rejected.map((r) => ({ path: r.path, problem: r.problem })),
      ...(collection.handles.size > 0 ? { handles: Object.fromEntries(collection.handles) } : {}),
    };
    try {
      this.post(message);
    } catch {
      // Handles are cloneable only in Chromium: without them the upload still resumes by re-picking the files.
      const { handles: _dropped, ...withoutHandles } = message as Extract<ToWorker, { t: 'upload' }>;
      this.post(withoutHandles);
    }
    return { id, collection };
  }

  /**
   * Continues an upload a reload interrupted, with the files chosen again. Only files with the same relative path,
   * size and date are taken (anything else would be a different file). Returns how many matched.
   */
  async resumeInterrupted(id: string, source: UploadSource): Promise<number> {
    const interrupted = this.state.getState().interrupted.get(id);
    if (!interrupted) return 0;
    const collection = await collectUploadSource(source);
    const wanted = new Map(interrupted.files.map((f) => [f.path, f]));
    const matched: WireItem[] = [];
    for (const item of collection.items) {
      if (item.kind !== 'file') continue;
      const expected = wanted.get(item.path);
      if (expected && expected.size === item.file.size && expected.lastModified === Math.floor(item.file.lastModified)) matched.push({ path: item.path, kind: 'file', file: item.file });
    }
    if (matched.length === 0) return 0;
    this.state.setState((s) => {
      const next = new Map(s.interrupted);
      next.delete(id);
      return { ...s, interrupted: next };
    });
    this.post({ t: 'resume-upload', id, items: matched });
    return matched.length;
  }

  /** Walks the stored top-level handles of an interrupted Chromium upload (after the person granted read access). */
  async sourceFromHandles(handles: Readonly<Record<string, FileSystemHandle>>): Promise<UploadSource> {
    const files: File[] = [];
    const walk = async (handle: FileSystemHandle, prefix: string): Promise<void> => {
      const path = prefix === '' ? handle.name : `${prefix}/${handle.name}`;
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        Object.defineProperty(file, 'webkitRelativePath', { value: path });
        files.push(file);
        return;
      }
      const dir = handle as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
      for await (const child of dir.values()) await walk(child, path);
    };
    for (const handle of Object.values(handles)) await walk(handle, '');
    return { kind: 'files', files };
  }

  pause(id: string): void {
    this.post({ t: 'pause', id });
  }

  resume(id: string): void {
    this.post({ t: 'resume', id });
  }

  retry(id: string): void {
    this.post({ t: 'retry', id });
  }

  answer(id: string, policy: UploadConflictPolicy | null): void {
    this.post({ t: 'answer', id, policy });
  }

  cancel(id: string): void {
    this.post({ t: 'cancel', id });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------------------------------------------

  /** `picker`: a handle from showSaveFilePicker (Chromium), picked in the click handler before any await. */
  download(file: FileRef, zip: boolean, picker?: FileSystemFileHandle): string | null {
    if (!this.available) return null;
    const id = (this.options.randomId ?? randomJobId)();
    const base = file.path === '' ? t('target.downloadRoot') : lastSegment(file.path);
    const name = zip ? `${base}.zip` : base;
    this.register({ id, kind: 'download', name, root: file.root, path: file.path, totalBytes: null, files: null });
    this.post({ t: 'download', id, file, zip, name, ...(picker ? { picker } : {}) });
    return id;
  }

  /** Hands a finished download to the browser again (the automatic save may have been blocked). */
  saveOutput(id: string): void {
    const output = this.state.getState().outputs.get(id);
    if (output) (this.options.save ?? defaultSave)(output.url, output.name);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------------------------------------------

  /** Removes a finished job (and frees its downloaded Blob). An interrupted upload is 「放棄」ed instead. */
  dismiss(id: string): void {
    if (this.state.getState().interrupted.has(id)) {
      this.post({ t: 'cancel', id });
      return;
    }
    this.post({ t: 'forget', id });
    this.forgetLocally(id);
  }

  clearFinished(): void {
    for (const [id, job] of this.state.getState().jobs) if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') this.dismiss(id);
    this.options.transfers.clearFinished();
  }

  /** R7.2 measurement page: a synthetic upload through the real Worker engine. */
  measure(request: { readonly root: RootRef; readonly path: string; readonly size: number; readonly seed?: number; readonly finalize?: 'commit' | 'abort' }): string {
    const id = (this.options.randomId ?? randomJobId)();
    this.post({ t: 'measure', request: { id, ...request } });
    return id;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setUnloadGuard(false);
    const worker = this.worker;
    if (worker) {
      // Let the Worker write its journal and close its socket; terminate it if it does not answer.
      const timer = setTimeout(() => worker.terminate(), 3_000);
      worker.addEventListener('message', (event) => {
        if (event.data.t === 'disposed') {
          clearTimeout(timer);
          worker.terminate();
        }
      });
      try {
        worker.postMessage({ t: 'dispose' });
      } catch {
        clearTimeout(timer);
        worker.terminate();
      }
    }
    for (const output of this.state.getState().outputs.values()) this.revokeObjectURL(output.url);
    for (const [id, job] of this.state.getState().jobs) {
      if (job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled') this.options.transfers.update(id, { status: 'paused' });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  private post(message: ToWorker): void {
    if (this.disposed || !this.worker) return;
    this.worker.postMessage(message);
  }

  private register(job: { id: string; kind: TransferJob['kind']; name: string; root: RootRef; path: string; totalBytes: number | null; files: number | null }): void {
    this.options.transfers.add({ ...job, status: 'queued' }, () => this.cancel(job.id));
  }

  private onMessage(message: FromWorker): void {
    switch (message.t) {
      case 'ready':
        this.state.setState((s) => ({ ...s, worker: 'ready' }));
        return;
      case 'fatal':
        this.state.setState((s) => ({ ...s, worker: message.reason === 'no-indexeddb' ? 'no-storage' : 'failed', workerError: message.message }));
        return;
      case 'link':
        this.state.setState((s) => ({ ...s, link: message.state }));
        return;
      case 'job':
        this.applySnapshot(message.snapshot);
        return;
      case 'interrupted': {
        const snapshot = message.snapshot;
        this.state.setState((s) => {
          const interrupted = new Map(s.interrupted);
          interrupted.set(snapshot.id, { files: message.files, handles: message.handles });
          return { ...s, interrupted };
        });
        if (!this.options.transfers.getState().jobs.has(snapshot.id)) {
          this.options.transfers.add({ id: snapshot.id, kind: 'upload', name: snapshot.name, root: snapshot.root, path: snapshot.path, totalBytes: snapshot.totalBytes, files: snapshot.files, doneBytes: snapshot.doneBytes, status: 'paused' }, () => this.dismiss(snapshot.id));
        }
        this.applySnapshot(snapshot);
        return;
      }
      case 'removed':
        this.forgetLocally(message.id);
        this.options.transfers.remove(message.id);
        return;
      case 'output': {
        const job = this.state.getState().jobs.get(message.id);
        const name = job?.name ?? 'download';
        const url = this.createObjectURL(message.blob);
        this.state.setState((s) => {
          const outputs = new Map(s.outputs);
          outputs.set(message.id, { url, name });
          return { ...s, outputs };
        });
        (this.options.save ?? defaultSave)(url, name);
        return;
      }
      case 'measured':
        this.state.setState((s) => {
          const measured = new Map(s.measured);
          measured.set(message.id, message.result);
          return { ...s, measured };
        });
        return;
      case 'disposed':
        return;
    }
  }

  private applySnapshot(snapshot: JobSnapshot): void {
    this.state.setState((s) => {
      const jobs = new Map(s.jobs);
      jobs.set(snapshot.id, snapshot);
      return { ...s, jobs };
    });
    const error = snapshot.failure ? describeFailure(snapshot.failure) : snapshot.fileFailures.length > 0 ? t('fail.files', { count: snapshot.fileFailures.length }) : null;
    this.options.transfers.update(snapshot.id, {
      status: snapshot.status,
      doneBytes: snapshot.doneBytes,
      totalBytes: snapshot.totalBytes,
      files: snapshot.files,
      error,
      name: snapshot.name,
    });
    const active = [...this.state.getState().jobs.values()].some((job) => job.status === 'running' || job.status === 'preparing' || job.status === 'queued');
    this.setUnloadGuard(active);
  }

  private forgetLocally(id: string): void {
    const output = this.state.getState().outputs.get(id);
    if (output) this.revokeObjectURL(output.url);
    this.state.setState((s) => {
      const jobs = new Map(s.jobs);
      const outputs = new Map(s.outputs);
      const interrupted = new Map(s.interrupted);
      jobs.delete(id);
      outputs.delete(id);
      interrupted.delete(id);
      return { ...s, jobs, outputs, interrupted };
    });
    this.options.transfers.remove(id);
  }

  private setUnloadGuard(on: boolean): void {
    if (on === this.unloadGuardOn || typeof window === 'undefined') return;
    this.unloadGuardOn = on;
    if (on) window.addEventListener('beforeunload', this.unloadGuard);
    else window.removeEventListener('beforeunload', this.unloadGuard);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One client per workspace session
// ---------------------------------------------------------------------------------------------------------------

const clients = new WeakMap<WorkspaceSession, TransferClient>();

/**
 * The transfer client of `session`, created on first use. It is disposed when the session's connection ends for
 * good (the workspace was closed after the last page left it, the member was kicked).
 */
export function transferClientFor(
  session: WorkspaceSession,
  overrides: Partial<Pick<TransferClientOptions, 'createWorker' | 'save' | 'createObjectURL' | 'revokeObjectURL' | 'randomId'>> = {},
): TransferClient {
  const existing = clients.get(session);
  if (existing) return existing;
  const createWorker = overrides.createWorker === undefined ? browserWorkerFactory() : overrides.createWorker;
  const client = new TransferClient({ ...overrides, workspaceId: session.workspaceId, transfers: session.stores.transfers, createWorker });
  clients.set(session, client);
  if (isTerminalState(session.connection.getState())) {
    client.dispose();
    return client;
  }
  const off = session.connection.subscribe((state) => {
    if (!isTerminalState(state)) return;
    off();
    client.dispose();
  });
  return client;
}
