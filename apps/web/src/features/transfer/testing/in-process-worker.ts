// TEST ONLY. A WorkerLike that runs the real TransferManager in the same thread, over FakeTransferLinks that share one
// fake daemon, and speaks the same message protocol as worker/transfer.worker.ts (dispatchToManager). Messages are
// delivered asynchronously in both directions, like postMessage.
import { createMemoryJournal, type UploadJournal } from '../engine/journal.ts';
import { TransferManager } from '../engine/manager.ts';
import { subtleSha256 } from '../engine/source.ts';
import type { WriterEnv } from '../engine/writers.ts';
import type { WorkerLike } from '../client/transfer-client.ts';
import { dispatchToManager, type FromWorker, type ToWorker } from '../worker/protocol.ts';
import { FakeDaemonState, FakeTransferLink, type FakeLinkOptions } from './fake-link.ts';

export interface InProcessWorkerOptions {
  readonly daemon?: FakeDaemonState;
  readonly journal?: UploadJournal;
  readonly link?: Omit<FakeLinkOptions, 'daemon'>;
  readonly writers?: WriterEnv;
  /** Answer init with this fatal error instead of starting (e.g. no IndexedDB). */
  readonly fatal?: 'no-indexeddb' | 'init-failed';
}

export class InProcessWorker implements WorkerLike {
  readonly daemon: FakeDaemonState;
  readonly journal: UploadJournal;
  readonly links: FakeTransferLink[] = [];
  readonly received: ToWorker[] = [];
  manager: TransferManager | null = null;
  terminated = false;
  private readonly options: InProcessWorkerOptions;
  private readonly messageListeners = new Set<(event: MessageEvent<FromWorker>) => void>();

  constructor(options: InProcessWorkerOptions = {}) {
    this.options = options;
    this.daemon = options.daemon ?? new FakeDaemonState({ downloadChunkSize: 256 * 1024 });
    this.journal = options.journal ?? createMemoryJournal();
  }

  addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent<FromWorker>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent<FromWorker>) => void);
  }

  terminate(): void {
    this.terminated = true;
    void this.manager?.dispose();
  }

  postMessage(message: ToWorker): void {
    if (this.terminated) return;
    this.received.push(message);
    queueMicrotask(() => void this.handle(message));
  }

  private emit(message: FromWorker): void {
    queueMicrotask(() => {
      for (const listener of [...this.messageListeners]) listener({ data: message } as MessageEvent<FromWorker>);
    });
  }

  private async handle(message: ToWorker): Promise<void> {
    if (message.t === 'init') {
      if (this.options.fatal) {
        this.emit({ t: 'fatal', reason: this.options.fatal, message: 'IndexedDB is not available' });
        return;
      }
      this.manager = new TransferManager({
        workspaceId: message.workspaceId,
        createLink: () => {
          const link = new FakeTransferLink({ uploadChunkSize: 1024 * 1024, ...this.options.link, daemon: this.daemon });
          this.links.push(link);
          return link;
        },
        journal: this.journal,
        hasher: subtleSha256,
        writers: this.options.writers ?? { opfs: null },
        emit: (event) => this.emit(event),
        journalDelayMs: 0,
      });
      this.emit({ t: 'ready' });
      await this.manager.restore();
      return;
    }
    if (message.t === 'dispose') {
      await this.manager?.dispose();
      this.emit({ t: 'disposed' });
      return;
    }
    if (this.manager) dispatchToManager(this.manager, message);
  }
}
