// Labels (in the viewer's language) and tones of merge-request and changed-file states.
import type { MergeRequest } from '@smurg/protocol';
import type { Tone } from '../../ui/index.ts';
import type { MergeDiffFile } from './diff-model.ts';
import { t } from './strings.ts';

export type MergeRequestStatus = MergeRequest['status'];

// A `draft` is the snapshot behind a result report: nobody asked to merge it yet (the host may merge it directly).
const STATUS_LABEL: Record<MergeRequestStatus, () => string> = {
  draft: () => t('status.draft'),
  pending: () => t('status.pending'),
  merged: () => t('status.merged'),
  rejected: () => t('status.rejected'),
  conflict: () => t('status.conflict'),
};

const STATUS_TONE: Record<MergeRequestStatus, Tone> = {
  draft: 'neutral',
  pending: 'info',
  merged: 'success',
  rejected: 'neutral',
  conflict: 'warning',
};

/** `reviewed`: the request's result report was reviewed (a reviewed draft is ready for the host to merge). */
export function requestStatusLabel(status: MergeRequestStatus, reviewed = false): string {
  return status === 'draft' && reviewed ? t('status.draftReviewed') : STATUS_LABEL[status]();
}

export function requestStatusTone(status: MergeRequestStatus, reviewed = false): Tone {
  return status === 'draft' && reviewed ? 'info' : STATUS_TONE[status];
}

/**
 * Whether the host can still decide (approve / reject): a pending request, a merge that stopped on a conflict, and a
 * draft (the host may merge the changes of a result report without anyone asking).
 */
export function isDecidable(status: MergeRequestStatus): boolean {
  return status === 'pending' || status === 'conflict' || status === 'draft';
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
