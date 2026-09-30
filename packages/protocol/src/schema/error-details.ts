import { SmurgError } from '../errors.ts';
import { type DiskReport, diskReportSchema, type LockInfo, lockInfoSchema } from './entities.ts';

// Typed `error.detail` conventions that the UI relies on (ARCHITECTURE §5.2 disk rule, §5.4 locks).

/** `insufficient_disk` with the numbers, so the UI can show them and point the host to the setting (R7). */
export function insufficientDiskError(disk: DiskReport, message?: string): SmurgError {
  return new SmurgError('insufficient_disk', message, { disk });
}

/** `locked` with the lock that blocks the request, so the UI can name the holder. */
export function lockedError(lock: LockInfo, message?: string): SmurgError {
  return new SmurgError('locked', message, { lock });
}

/** The DiskReport of an `insufficient_disk` error, or null. */
export function diskReportOfError(error: SmurgError): DiskReport | null {
  if (error.code !== 'insufficient_disk') return null;
  const parsed = diskReportSchema.safeParse(error.detail?.['disk']);
  return parsed.success ? parsed.data : null;
}

/** The LockInfo of a `locked` error, or null. */
export function lockOfError(error: SmurgError): LockInfo | null {
  if (error.code !== 'locked') return null;
  const parsed = lockInfoSchema.safeParse(error.detail?.['lock']);
  return parsed.success ? parsed.data : null;
}

/** `detail.reason` of an error, when it is a string. */
export function errorReasonOf(error: SmurgError): string | null {
  const reason = error.detail?.['reason'];
  return typeof reason === 'string' ? reason : null;
}
