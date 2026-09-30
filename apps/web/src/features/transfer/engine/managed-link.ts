// A stable TransferLink for the jobs of a TransferManager: it forwards to the manager's current TransferConnection,
// which the manager closes when nothing needs it and opens again for the next job. Jobs keep this object across
// those replacements (a paused or failed job resumed an hour later must not hold a closed socket).
import type { ActiveDownload, BufferedAmountOptions, ConnectionState, DownloadOptions, RequestOptions, TransferNotifyType, TransferRequestType } from '@smurg/protocol/client';
import { ClientRequestError } from '@smurg/protocol/client';
import type { PayloadInputOf, ResultOf, Welcome } from '@smurg/protocol';
import type { TransferLink } from './link.ts';

const IDLE: ConnectionState = Object.freeze({ kind: 'idle' });

export class ManagedLink implements TransferLink {
  private current: TransferLink | null = null;
  private currentOff: (() => void) | null = null;
  private readonly listeners = new Set<(state: ConnectionState) => void>();

  /** The socket in use, or null between two runs. */
  get connection(): TransferLink | null {
    return this.current;
  }

  /** Makes `link` the current socket (the previous one, if any, is closed first). */
  attach(link: TransferLink): void {
    this.detach();
    this.current = link;
    this.currentOff = link.subscribe((state) => this.broadcast(state));
    this.broadcast(link.getState());
  }

  /** Closes the current socket; jobs see state 'idle' until the next attach. */
  detach(): void {
    const link = this.current;
    if (!link) return;
    this.currentOff?.();
    this.currentOff = null;
    this.current = null;
    link.close();
    this.broadcast(IDLE);
  }

  private broadcast(state: ConnectionState): void {
    for (const listener of [...this.listeners]) listener(state);
  }

  start(): this {
    this.current?.start();
    return this;
  }

  close(): void {
    this.detach();
  }

  getState(): ConnectionState {
    return this.current?.getState() ?? IDLE;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get welcome(): Welcome | null {
    return this.current?.welcome ?? null;
  }

  get bufferedAmount(): number {
    return this.current?.bufferedAmount ?? 0;
  }

  request<T extends TransferRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>> {
    if (!this.current) return Promise.reject(new ClientRequestError('not-connected'));
    return this.current.request(type, payload, options);
  }

  notify<T extends TransferNotifyType>(type: T, payload: PayloadInputOf<T>): boolean {
    return this.current?.notify(type, payload) ?? false;
  }

  download(payload: PayloadInputOf<'file.download.begin'>, options: DownloadOptions): Promise<ActiveDownload> {
    if (!this.current) return Promise.reject(new ClientRequestError('not-connected'));
    return this.current.download(payload, options);
  }

  waitForDrain(options?: BufferedAmountOptions): Promise<void> {
    return this.current ? this.current.waitForDrain(options) : Promise.resolve();
  }
}
