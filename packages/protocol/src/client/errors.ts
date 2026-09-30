// Errors that originate on the client side. A daemon refusal arrives as a plain SmurgError (from the `error`
// Envelope); these cover everything that fails before or instead of a daemon answer.
import { SmurgError } from '../errors.ts';

export const CLIENT_REQUEST_FAILURES = [
  /** No answer within the request timeout. The daemon may still have processed it. */
  'timeout',
  /** The caller's AbortSignal fired. The daemon may still have processed it if it was already sent. */
  'cancelled',
  /**
   * The channel was re-established without resume (Welcome.resumed = false) or the transfer socket dropped while the
   * request was in flight: it may or may not have been processed. The application resyncs.
   */
  'connection-lost',
  /** The connection is closed for good (close(), kicked, rejected, key mismatch). */
  'closed',
  /** The transfer connection is not online (it has no outbox to queue into). */
  'not-connected',
  /** Too much unacknowledged data is queued; try again later. */
  'overflow',
] as const;
export type ClientRequestFailure = (typeof CLIENT_REQUEST_FAILURES)[number];

const MESSAGES_ZH_TW: Readonly<Record<ClientRequestFailure, string>> = Object.freeze({
  timeout: '請求逾時，主人可能已離線',
  cancelled: '請求已取消',
  'connection-lost': '連線中斷，這個動作可能沒有完成，請重新整理後確認',
  closed: '連線已關閉',
  'not-connected': '目前沒有連線',
  overflow: '待送出的資料太多，請稍後再試',
});

/** A request that was sent and then timed out / was cancelled: it may or may not have happened. */
const OUTCOME_UNKNOWN_ZH_TW: Readonly<Record<'timeout' | 'cancelled', string>> = Object.freeze({
  timeout: '請求逾時：這個動作可能已經完成，也可能沒有，請先確認結果再重試',
  cancelled: '請求已取消：這個動作可能已經完成，也可能沒有，請先確認結果',
});

/**
 * A request that failed locally. It IS a SmurgError (so `catch (e) { if (isSmurgError(e)) … }` shows a zh-TW message
 * either way), with code `internal` and `detail.reason` = the failure; `failure` says which one.
 */
export class ClientRequestError extends SmurgError {
  readonly failure: ClientRequestFailure;

  /**
   * `sent` (timeout / cancelled): whether the request had been transmitted. `detail.sent: true` means the outcome is
   * unknown (the daemon may have processed it); either way it is never re-sent after this error (review REL-03).
   */
  constructor(failure: ClientRequestFailure, message?: string, options?: { cause?: unknown; sent?: boolean }) {
    const sentUnknown = options?.sent === true && (failure === 'timeout' || failure === 'cancelled');
    super(
      'internal',
      message ?? (sentUnknown ? OUTCOME_UNKNOWN_ZH_TW[failure as 'timeout' | 'cancelled'] : MESSAGES_ZH_TW[failure]),
      { reason: failure, local: true, ...(options?.sent === undefined ? {} : { sent: options.sent }) },
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ClientRequestError';
    this.failure = failure;
  }
}

export function isClientRequestError(value: unknown, failure?: ClientRequestFailure): value is ClientRequestError {
  return value instanceof ClientRequestError && (failure === undefined || value.failure === failure);
}

/** An HTTP call to the relay failed. `status` 0 means no HTTP answer (network error, timeout, unreadable body). */
export class RelayApiError extends Error {
  readonly status: number;
  /** The relay's machine-readable `error` field (e.g. 'unauthorized', 'workspace_taken'), or 'network' / 'bad_response'. */
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RelayApiError';
    this.status = status;
    this.code = code;
  }

  /** The session is missing or expired: the person has to log in again. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function isRelayApiError(value: unknown, status?: number): value is RelayApiError {
  return value instanceof RelayApiError && (status === undefined || value.status === status);
}
