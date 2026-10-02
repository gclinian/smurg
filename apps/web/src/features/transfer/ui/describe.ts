// Text for what the engine reports (it reports facts, never sentences: engine/types.ts).
import { renderWireText } from '../../../lib/errors.ts';
import { formatBytes, formatDuration } from '../../../lib/format.ts';
import type { JobSnapshot, TransferFailure } from '../engine/types.ts';
import { remainingMs } from '../engine/rate.ts';
import { MEMORY_DOWNLOAD_LIMIT } from '../engine/writers.ts';
import { t } from '../strings.ts';

export function describeFailure(failure: TransferFailure): string {
  switch (failure.kind) {
    case 'disk': {
      if (failure.midway) return t('fail.diskMidway');
      const disk = failure.disk;
      if (!disk) return t('fail.diskUnknown');
      return t('fail.disk', {
        requested: formatBytes(disk.requestedBytes),
        freeAfter: formatBytes(Math.max(0, disk.freeAfterBytes)),
        reserve: formatBytes(disk.reserveBytes),
        available: formatBytes(disk.availableBytes),
        pending: formatBytes(disk.pendingBytes),
      });
    }
    case 'daemon':
      // The host's own words: its message reference in the viewer's language, else its English message.
      return renderWireText(failure.error.text, failure.error.message);
    case 'source-changed':
      return t('fail.sourceChanged', { path: failure.path });
    case 'source-unreadable':
      return t('fail.sourceUnreadable', { path: failure.path });
    case 'connection-ended':
      if (failure.state === 'closed:kicked') return t('fail.connection.kicked');
      if (failure.state === 'closed:revoked' || failure.state === 'rejected') return t('fail.connection.revoked');
      if (failure.state === 'closed:login-required') return t('fail.connection.login');
      if (failure.state === 'closed:storage-error' || failure.state === 'closed:no-trust') return t('fail.connection.storage');
      if (failure.state === 'key-mismatch') return t('fail.connection.keyMismatch');
      return t('fail.connection');
    case 'conflict-declined':
      return t('fail.conflictDeclined');
    case 'storage':
      switch (failure.reason) {
        case 'quota':
        case 'short-write':
          return failure.neededBytes !== null && failure.availableBytes !== null && failure.reason === 'quota'
            ? t('fail.storage.quota', { needed: formatBytes(failure.neededBytes), available: formatBytes(failure.availableBytes) })
            : t('fail.storage.quotaUnknown');
        case 'too-large-for-memory':
          return failure.neededBytes !== null
            ? t('fail.storage.memory', { limit: formatBytes(failure.availableBytes ?? MEMORY_DOWNLOAD_LIMIT), needed: formatBytes(failure.neededBytes) })
            : t('fail.storage.memoryUnknown', { limit: formatBytes(failure.availableBytes ?? MEMORY_DOWNLOAD_LIMIT) });
        default:
          return t('fail.storage.write');
      }
    case 'changed-on-host':
      return t('fail.changedOnHost');
    case 'internal':
      return t('fail.internal');
  }
}

export function describeStatus(job: JobSnapshot): string {
  if (job.status === 'paused') {
    if (job.pause === 'offline') return t('status.paused.offline');
    if (job.pause === 'reload') return t('status.paused.reload');
    return t('status.paused');
  }
  if (job.status === 'running' && job.verifying) return t('status.verifying');
  return t(`status.${job.status}`);
}

/** "3 minutes" (the caller wraps it: "About 3 minutes left"). */
export function describeDuration(ms: number): string {
  return formatDuration(Math.max(1, ms / 1000));
}

export interface ProgressText {
  readonly bytes: string;
  readonly files: string | null;
  readonly speed: string | null;
  readonly remaining: string | null;
  /** 0–100, null when the total is unknown (a zip in progress). */
  readonly percent: number | null;
}

export function describeProgress(job: JobSnapshot): ProgressText {
  const total = job.totalBytes;
  const running = job.status === 'running' && job.bytesPerSecond > 0;
  const left = running ? remainingMs(total, job.doneBytes, job.bytesPerSecond) : null;
  return {
    bytes: total === null ? t('progress.bytesUnknown', { done: formatBytes(job.doneBytes) }) : t('progress.bytes', { done: formatBytes(job.doneBytes), total: formatBytes(total) }),
    files: job.files !== null && job.files > 1 ? t('progress.files', { done: job.filesDone, total: job.files }) : null,
    speed: running ? t('progress.speed', { speed: formatBytes(job.bytesPerSecond) }) : null,
    remaining: left === null ? null : t('progress.remaining', { time: describeDuration(left) }),
    percent: total === null ? null : total === 0 ? (job.status === 'done' ? 100 : 0) : Math.min(100, Math.floor((job.doneBytes / total) * 100)),
  };
}

export function describeTarget(job: JobSnapshot): string {
  if (job.kind === 'upload') return job.path === '' ? t('target.uploadToRoot') : t('target.uploadTo', { path: job.path });
  return job.path === '' ? t('target.downloadRoot') : t('target.downloadFrom', { path: job.path });
}

export function describeSkip(reason: string): string {
  if (reason.startsWith('open:')) return t('download.skip.empty');
  if (reason === 'special-file' || reason === 'fifo' || reason === 'socket' || reason === 'device') return t('download.skip.special');
  if (reason.startsWith('symlink')) return t('download.skip.link');
  return t('download.skip.other', { reason });
}

export function describeRejected(problem: string): string {
  if (problem === 'duplicate') return t('rejected.duplicate');
  if (problem === 'unreadable') return t('rejected.unreadable');
  return t('rejected.invalid');
}
