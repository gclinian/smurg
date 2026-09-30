// zh-TW labels and tones of merge-request and changed-file states.
import type { MergeRequest } from '@smurg/protocol';
import type { Tone } from '../../ui/index.ts';
import type { MergeDiffFile } from './diff-model.ts';
import { t } from './strings.ts';

export type MergeRequestStatus = MergeRequest['status'];

const STATUS_LABEL: Record<MergeRequestStatus, () => string> = {
  pending: () => t('status.pending'),
  merged: () => t('status.merged'),
  rejected: () => t('status.rejected'),
  conflict: () => t('status.conflict'),
};

const STATUS_TONE: Record<MergeRequestStatus, Tone> = {
  pending: 'info',
  merged: 'success',
  rejected: 'neutral',
  conflict: 'warning',
};

export function requestStatusLabel(status: MergeRequestStatus): string {
  return STATUS_LABEL[status]();
}

export function requestStatusTone(status: MergeRequestStatus): Tone {
  return STATUS_TONE[status];
}

/** Whether the host can still decide (approve / reject): pending, or a merge that stopped on a conflict. */
export function isDecidable(status: MergeRequestStatus): boolean {
  return status === 'pending' || status === 'conflict';
}

const FILE_STATUS_LABEL: Record<MergeDiffFile['status'], () => string> = {
  added: () => t('file.status.added'),
  modified: () => t('file.status.modified'),
  deleted: () => t('file.status.deleted'),
  renamed: () => t('file.status.renamed'),
  copied: () => t('file.status.copied'),
  'type-changed': () => t('file.status.type-changed'),
  unmerged: () => t('file.status.unmerged'),
  unknown: () => t('file.status.unknown'),
};

export function fileStatusLabel(status: MergeDiffFile['status']): string {
  return FILE_STATUS_LABEL[status]();
}
