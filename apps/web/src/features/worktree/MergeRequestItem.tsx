// One merge request in a list, with its status as the requester and the host need to read it (SPEC R9: the requester
// sees the outcome; on a conflict the host sees the conflicting files and what to do next).
import type { MergeRequest, WorktreeInfo } from '@smurg/protocol';
import { formatRelativeTime } from '../../lib/format.ts';
import { Badge, Button } from '../../ui/index.ts';
import { shortCommit } from './diff-model.ts';
import { isDecidable, requestStatusLabel, requestStatusTone } from './labels.ts';
import { t } from './strings.ts';

export interface MergeRequestItemProps {
  readonly request: MergeRequest;
  /** Null once the worktree was removed. */
  readonly worktree: WorktreeInfo | null;
  /** The viewing member. */
  readonly userId: string | null;
  /** The viewer decides merges (the host). */
  readonly isHost: boolean;
  readonly now: number;
  /** Opens the review (the host) or the read-only diff (the requester). */
  onOpen(requestId: string): void;
}

export function MergeRequestItem({ request, worktree, userId, isHost, now, onOpen }: MergeRequestItemProps) {
  const name = request.requestedBy.displayName;
  const mine = userId !== null && (request.requestedBy.userId === userId || worktree?.ownerUserId === userId);
  // worktree.merge.diff is for the worktree's owner and the host (ARCHITECTURE §5.7).
  const canOpen = isHost || mine;
  return (
    <li className="worktree-mr" data-status={request.status}>
      <div className="worktree-mr__head">
        <Badge tone={requestStatusTone(request.status)}>{requestStatusLabel(request.status)}</Badge>
        <span className="worktree-mr__title">{t('item.title', { name })}</span>
        {canOpen ? (
          <Button size="sm" variant={isHost && isDecidable(request.status) ? 'primary' : 'secondary'} className="worktree-mr__open" onClick={() => onOpen(request.id)}>
            {isHost && isDecidable(request.status) ? t('action.review') : t('action.viewDiff')}
          </Button>
        ) : null}
      </div>
      <p className="worktree-mr__meta">
        <span>{worktree ? t('item.branch', { branch: worktree.branch }) : t('item.worktreeGone')}</span>
        <span title={request.commit}>{t('item.commit', { commit: shortCommit(request.commit) })}</span>
        <span>{t('item.requestedAt', { time: formatRelativeTime(request.createdAt, now) })}</span>
      </p>
      {request.message ? <p className="worktree-mr__message">{request.message}</p> : null}
      <StatusDetail request={request} mine={mine} isHost={isHost} now={now} />
    </li>
  );
}

function StatusDetail({ request, mine, isHost, now }: { request: MergeRequest; mine: boolean; isHost: boolean; now: number }) {
  switch (request.status) {
    case 'pending':
      return mine && !isHost ? <p className="worktree-mr__detail">{t('detail.pendingRequester')}</p> : null;
    case 'merged':
      return request.decidedAt !== undefined ? <p className="worktree-mr__detail">{t('detail.merged', { time: formatRelativeTime(request.decidedAt, now) })}</p> : null;
    case 'rejected':
      return (
        <p className="worktree-mr__detail">
          {request.rejectReason ? t('detail.rejected', { reason: request.rejectReason }) : t('detail.rejectedNoReason')}
        </p>
      );
    case 'conflict':
      return <ConflictDetails request={request} viewerIsHost={isHost} />;
  }
}

/** The files a merge stopped on, and what can happen next (different advice for the host and the requester). */
export function ConflictDetails({ request, viewerIsHost }: { request: MergeRequest; viewerIsHost: boolean }) {
  const files = request.conflictFiles ?? [];
  return (
    <div className="worktree-conflict">
      <p className="worktree-conflict__lead">{t('detail.conflict')}</p>
      {files.length > 0 ? (
        <ul className="worktree-conflict__files">
          {files.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="worktree-conflict__next">
        {viewerIsHost ? t('detail.conflictHost', { id: request.id }) : t('detail.conflictRequester')}
      </p>
    </div>
  );
}
