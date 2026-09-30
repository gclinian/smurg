// Maps whatever a transfer threw to the structured TransferFailure the UI describes (engine/types.ts).
import { diskReportOfError, errorReasonOf, isSmurgError } from '@smurg/protocol';
import { LinkEndedError } from './link.ts';
import { SourceUnreadableError } from './source.ts';
import type { TransferFailure } from './types.ts';

/** A browser-storage problem of a download writer (OPFS quota, short write, in-memory limit). */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly reason: Extract<TransferFailure, { kind: 'storage' }>['reason'];
  readonly neededBytes: number | null;
  readonly availableBytes: number | null;

  constructor(reason: StorageError['reason'], details: { neededBytes?: number | null; availableBytes?: number | null; cause?: unknown } = {}) {
    super(`download storage: ${reason}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.reason = reason;
    this.neededBytes = details.neededBytes ?? null;
    this.availableBytes = details.availableBytes ?? null;
  }
}

export function toFailure(error: unknown, path = ''): TransferFailure {
  if (isSmurgError(error)) {
    if (error.code === 'insufficient_disk') return { kind: 'disk', disk: diskReportOfError(error), midway: errorReasonOf(error) === 'disk-full' };
    if (error.code === 'conflict' && errorReasonOf(error) === 'changed') return { kind: 'changed-on-host' };
    return { kind: 'daemon', error: error.toPayload() };
  }
  if (error instanceof SourceUnreadableError) {
    return error.name === 'SourceChangedError' ? { kind: 'source-changed', path } : { kind: 'source-unreadable', path };
  }
  if (error instanceof LinkEndedError) return { kind: 'connection-ended', state: error.state.kind === 'closed' ? `closed:${error.state.reason}` : error.state.kind };
  if (error instanceof StorageError) return { kind: 'storage', reason: error.reason, neededBytes: error.neededBytes, availableBytes: error.availableBytes };
  return { kind: 'internal', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}
