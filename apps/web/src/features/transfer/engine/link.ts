// The slice of the SDK's TransferConnection the transfer engine uses (ARCHITECTURE §5.2 "Transfer channel"). The real
// TransferConnection satisfies it; tests drive the engine with a fake daemon behind the same shape
// (testing/fake-link.ts), so the engine never knows whether it runs in a Web Worker, on the main thread or in Node.
import {
  isClientRequestError,
  isTerminalState,
  type ActiveDownload,
  type BufferedAmountOptions,
  type ConnectionState,
  type DownloadOptions,
  type RequestOptions,
  type TransferConnection,
  type TransferNotifyType,
  type TransferRequestType,
} from '@smurg/protocol/client';
import { isSmurgError, type PayloadInputOf, type ResultOf, type Welcome } from '@smurg/protocol';

export interface TransferLink {
  start(): unknown;
  close(): void;
  getState(): ConnectionState;
  subscribe(listener: (state: ConnectionState) => void): () => void;
  readonly welcome: Welcome | null;
  request<T extends TransferRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>>;
  notify<T extends TransferNotifyType>(type: T, payload: PayloadInputOf<T>): boolean;
  download(payload: PayloadInputOf<'file.download.begin'>, options: DownloadOptions): Promise<ActiveDownload>;
  waitForDrain(options?: BufferedAmountOptions): Promise<void>;
  readonly bufferedAmount: number;
}

/** Compile-time proof that the SDK's TransferConnection is a TransferLink (the Worker passes the real one). */
export const asTransferLink = (connection: TransferConnection): TransferLink => connection;

/** The link went away under a running transfer; the transfer resumes when the link is online again. */
export class TransferInterruptedError extends Error {
  override readonly name = 'TransferInterruptedError';
  /** 'paused': the person paused it; 'offline': the transfer socket is not online. */
  readonly why: 'paused' | 'offline';

  constructor(why: 'paused' | 'offline') {
    super(why === 'paused' ? 'transfer paused' : 'transfer connection lost');
    this.why = why;
  }
}

/** The person cancelled the transfer. */
export class TransferCancelledError extends Error {
  override readonly name = 'TransferCancelledError';
}

/** The transfer socket ended for good (kicked, revoked, key mismatch, rejected): nothing will resume. */
export class LinkEndedError extends Error {
  override readonly name = 'LinkEndedError';
  readonly state: ConnectionState;

  constructor(state: ConnectionState) {
    super(`transfer connection ended: ${state.kind}`);
    this.state = state;
  }
}

/**
 * Whether `error` means "the socket dropped or is not up": the request may or may not have reached the daemon, and
 * everything resumes from the daemon's state (bitmap / offset) once the link is online again.
 */
export function isConnectivityError(error: unknown): boolean {
  return (
    isClientRequestError(error, 'connection-lost') ||
    isClientRequestError(error, 'not-connected') ||
    isClientRequestError(error, 'closed') ||
    error instanceof TransferInterruptedError ||
    error instanceof LinkEndedError
  );
}

/** Whether a request failed because our own AbortSignal fired (pause / cancel). */
export function isCancelled(error: unknown): boolean {
  return isClientRequestError(error, 'cancelled') || error instanceof TransferCancelledError;
}

/** Whether a daemon refusal carries `detail.reason === reason` (ARCHITECTURE §4.3: sub-reasons never become codes). */
export function hasReason(error: unknown, code: string, reason: string): boolean {
  return isSmurgError(error) && error.code === code && error.detail?.['reason'] === reason;
}

/**
 * Resolves once the link is online. Rejects with LinkEndedError when it reaches a terminal state, and with
 * TransferInterruptedError('paused') when `signal` fires first.
 */
export function waitForOnline(link: TransferLink, signal?: AbortSignal): Promise<void> {
  const state = link.getState();
  if (state.kind === 'online') return Promise.resolve();
  if (isTerminalState(state)) return Promise.reject(new LinkEndedError(state));
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      off();
      reject(abortReason(signal));
    };
    const off = link.subscribe((next) => {
      if (next.kind === 'online') {
        cleanup();
        resolve();
      } else if (isTerminalState(next)) {
        cleanup();
        reject(new LinkEndedError(next));
      }
    });
    const cleanup = (): void => {
      off();
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The error a job's AbortSignal carries (pause or cancel), or a generic interruption. */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof TransferCancelledError || reason instanceof TransferInterruptedError) return reason;
  return new TransferInterruptedError('paused');
}

/** Throws the signal's reason when it fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}
