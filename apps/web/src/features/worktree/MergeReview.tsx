// The review of one merge request (SPEC R9: the host sees the full diff and merges after confirming; on a conflict the files in conflict are listed).
//
// The host sees the COMPLETE change list with additions / deletions and each file's diff. When worktree.merge.diff was
// cut (1 MiB) the files it could not show completely are marked "Open separately" and fetched one by one with
// worktree.merge.fileDiff; "Merge into the main workspace" stays disabled until every one of them was opened (diff-model.ts decides
// which, failing closed). Every member may open the same view read-only (the daemon withholds host-private files).
//
// Two frames around the same review: a dialog (the host console's list, "Merge…" on a result report) and the body of
// a "Changes" column of the sessions view (a merge request without a report: DESIGN §5.4).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { MergeRequest } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Badge, Banner, Button, Dialog, Input, Spinner, useToast } from '../../ui/index.ts';
import { shortCommit, type ReviewFile } from './diff-model.ts';
import { FileDiffView } from './FileDiff.tsx';
import { fileStatusLabel, isDecidable, requestStatusLabel } from './labels.ts';
import { ConflictDetails } from './MergeRequestItem.tsx';
import { t } from './strings.ts';
import { reasonProblem } from './text-check.ts';
import { useRequestDiff } from './use-request-diff.ts';

export { DIFF_LINES_STEP } from './FileDiff.tsx';

export interface MergeReviewDialogProps {
  /** The request to review; null renders nothing. */
  readonly requestId: string | null;
  onClose(): void;
}

export function MergeReviewDialog({ requestId, onClose }: MergeReviewDialogProps) {
  if (requestId === null) return null;
  // A different request is a different review: nothing (opened files, a typed reason) carries over.
  return <MergeReview key={requestId} requestId={requestId} onClose={onClose} />;
}

export interface MergeReviewPanelProps {
  readonly requestId: string;
  /** Wraps the scrolling part and the decision bar (a column gives its own layout classes). */
  readonly frame: (parts: { readonly body: ReactNode; readonly footer: ReactNode | null }) => ReactNode;
}

/** The same review without a dialog around it: the body of a "Changes" column. */
export function MergeReviewPanel({ requestId, frame }: MergeReviewPanelProps) {
  return <MergeReview key={requestId} requestId={requestId} frame={frame} />;
}

type Mode = 'idle' | 'confirm-approve' | 'reject';

function MergeReview({ requestId, onClose, frame }: { requestId: string; onClose?: () => void; frame?: MergeReviewPanelProps['frame'] }) {
  const stores = useStores();
  const toast = useToast();
  const hintId = useId();
  const canDecide = useCan('worktree.merge.decide');
  const request = useStore(stores.worktrees, (state) => state.mergeRequests.get(requestId) ?? null);
  const worktree = useStore(stores.worktrees, (state) => (request ? (state.worktrees.get(request.worktreeId) ?? null) : null));
  const { load, model, fileDiffs, opened, remaining, open, fetchFile, reload } = useRequestDiff(requestId);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const close = onClose ?? (() => {});

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const select = (entry: ReviewFile): void => {
    setSelected(entry.file.path);
    open(entry);
  };

  // Show the first file as soon as the list is there.
  useEffect(() => {
    const first = model?.files[0];
    if (first && selected === null) select(first);
    // `select` is stable enough: it only reads refs and setters.
  }, [model]);

  const decidable = canDecide && request !== null && isDecidable(request.status);
  const blocked = model === null || remaining.length > 0;

  const approve = async (): Promise<void> => {
    // The button is disabled while blocked; checked again so no other path can approve an unreviewed change.
    if (!request || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await stores.worktrees.approve(request.id);
      if (!alive.current) return;
      if (result.status === 'merged') {
        toast.show({ tone: 'success', title: name === '' ? t('review.mergedDraft') : t('review.merged', { name }) });
        close();
        return;
      }
      if (result.status === 'conflict') toast.show({ tone: 'warning', title: t('review.conflict') });
      setMode('idle');
    } catch (failure) {
      if (alive.current) setError(t('review.failed', { message: describeError(failure) }));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const reasonError = reason === '' ? null : reasonProblem(reason);
  const reject = async (): Promise<void> => {
    if (!request || reasonError) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = reason.trim();
      await stores.worktrees.reject(request.id, trimmed === '' ? undefined : trimmed);
      if (!alive.current) return;
      toast.show({ tone: 'success', title: name === '' ? t('review.rejectedDraft') : t('review.rejected', { name }) });
      setMode('idle');
      close();
    } catch (failure) {
      if (alive.current) setError(t('review.failed', { message: describeError(failure) }));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // A draft (the snapshot of a work item nobody asked to merge yet) has no requester.
  const name = request?.requestedBy?.displayName ?? '';
  const selectedEntry = model?.files.find((entry) => entry.file.path === selected) ?? null;
  const nextUnopened = remaining.find((path) => fileDiffs.get(path)?.status !== 'loading');

  const closeButton = onClose ? (
    <Button variant="ghost" onClick={onClose}>
      {tApp('common.close')}
    </Button>
  ) : null;
  const footer = !decidable ? (
    closeButton
  ) : mode === 'confirm-approve' && request ? (
    <div className="worktree-review__decision">
      <p className="worktree-review__decision-text">{t('review.confirmApprove', { commit: shortCommit(request.commit), count: model?.files.length ?? 0 })}</p>
      <div className="worktree-review__decision-actions">
        <Button variant="ghost" onClick={() => setMode('idle')} disabled={busy}>
          {tApp('common.cancel')}
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void approve()}>
          {t('review.confirm')}
        </Button>
      </div>
    </div>
  ) : mode === 'reject' ? (
    <div className="worktree-review__decision">
      <Input
        label={name === '' ? t('review.rejectReasonDraft') : t('review.rejectReason', { name })}
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
        error={reasonError ?? undefined}
        autoFocus
      />
      <div className="worktree-review__decision-actions">
        <Button variant="ghost" onClick={() => setMode('idle')} disabled={busy}>
          {tApp('common.cancel')}
        </Button>
        <Button variant="danger" loading={busy} disabled={reasonError !== null} onClick={() => void reject()}>
          {t('review.confirmReject')}
        </Button>
      </div>
    </div>
  ) : (
    <div className="worktree-review__decision-actions">
      {closeButton}
      <Button variant="danger" onClick={() => setMode('reject')}>
        {t('review.reject')}
      </Button>
      <Button variant="primary" disabled={blocked} aria-describedby={remaining.length > 0 ? hintId : undefined} onClick={() => setMode('confirm-approve')}>
        {request?.status === 'conflict' ? t('review.retryApprove') : t('review.approve')}
      </Button>
    </div>
  );

  const title = name !== '' ? (canDecide ? t('review.title', { name }) : t('review.titleReadOnly', { name })) : t('review.titleDraft', { branch: worktree?.branch ?? t('item.worktreeGone') });
  const body = (
    <div className="worktree-review">
      {request ? <ReviewHeader request={request} branch={worktree?.branch ?? null} files={model?.files.length ?? null} additions={model?.totalAdditions ?? 0} deletions={model?.totalDeletions ?? 0} /> : null}
      {request && !isDecidable(request.status) ? (
        <Banner tone="info" live="none">
          {t('review.decided', { status: requestStatusLabel(request.status) })}
        </Banner>
      ) : null}
      {request?.status === 'conflict' ? <ConflictDetails request={request} viewerIsHost={canDecide} /> : null}
      {load.status === 'loading' ? (
        <p className="worktree-review__loading">
          <Spinner size={14} decorative /> {t('review.loading')}
        </p>
      ) : null}
      {load.status === 'error' ? (
        <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={reload}>{t('review.reload')}</Button>}>
          {t('review.loadFailed', { message: load.message })}
        </Banner>
      ) : null}
      {model && load.status === 'ready' ? (
        <>
          {load.value.truncated ? (
            <Banner tone="warning" live="none">
              {t('review.truncated')}
            </Banner>
          ) : null}
          {model.mustOpen.length > 0 ? (
            <div className="worktree-review__progress" id={hintId}>
              <span>{remaining.length > 0 ? t('review.remaining', { count: remaining.length }) : t('review.allOpened')}</span>
              {remaining.length > 0 && nextUnopened !== undefined ? (
                <Button
                  size="sm"
                  onClick={() => {
                    const entry = model.files.find((candidate) => candidate.file.path === nextUnopened);
                    if (entry) select(entry);
                  }}
                >
                  {t('review.openNext')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {model.files.length === 0 ? (
            <p className="worktree-review__empty">{t('review.noFiles')}</p>
          ) : (
            <div className="worktree-review__split">
              <nav className="worktree-review__files" aria-label={t('review.files')}>
                <ul>
                  {model.files.map((entry) => (
                    <li key={entry.file.path}>
                      <FileButton
                        entry={entry}
                        selected={entry.file.path === selected}
                        mustOpen={entry.section === null}
                        opened={opened.has(entry.file.path)}
                        onSelect={() => select(entry)}
                      />
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="worktree-review__diff">
                {selectedEntry ? (
                  <FileDiffView key={selectedEntry.file.path} entry={selectedEntry} fetched={fileDiffs.get(selectedEntry.file.path)} onRetry={() => fetchFile(selectedEntry.file.path)} />
                ) : (
                  <p className="worktree-review__empty">{t('review.selectFile')}</p>
                )}
              </div>
            </div>
          )}
        </>
      ) : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
    </div>
  );

  if (frame) return <>{frame({ body, footer })}</>;
  return (
    <Dialog open onClose={close} size="lg" className="worktree-review-dialog" title={title} footer={footer}>
      {body}
    </Dialog>
  );
}

function ReviewHeader({ request, branch, files, additions, deletions }: { request: MergeRequest; branch: string | null; files: number | null; additions: number; deletions: number }) {
  return (
    <div className="worktree-review__meta">
      <p className="worktree-review__summary">
        <span title={request.commit}>
          {t('review.summary', { branch: branch ?? t('item.worktreeGone'), commit: shortCommit(request.commit), files: files === null ? t('review.fileCountUnknown') : t('review.fileCount', { count: files }) })}
        </span>
        {files !== null ? <span className="worktree-review__counts">{t('review.counts', { additions: t('review.linesAdded', { count: additions }), deletions: t('review.linesDeleted', { count: deletions }) })}</span> : null}
        <span className="worktree-review__time">{t('item.requestedAt', { time: formatRelativeTime(request.createdAt) })}</span>
      </p>
      {request.message ? (
        <div className="worktree-review__message">
          <span className="worktree-review__message-label">{request.requestedBy ? t('review.message', { name: request.requestedBy.displayName }) : t('review.messageDraft')}</span>
          <p>{request.message}</p>
        </div>
      ) : null}
    </div>
  );
}

function FileButton({ entry, selected, mustOpen, opened, onSelect }: { entry: ReviewFile; selected: boolean; mustOpen: boolean; opened: boolean; onSelect(): void }) {
  const { file } = entry;
  return (
    <button type="button" className="worktree-review__file" aria-current={selected ? 'true' : undefined} data-status={file.status} onClick={onSelect}>
      <span className="worktree-review__file-status">{fileStatusLabel(file.status)}</span>
      <span className="worktree-review__file-path" title={file.path}>
        {file.path}
      </span>
      {file.oldPath !== undefined ? <span className="worktree-review__file-from">{t('review.renamedFrom', { path: file.oldPath })}</span> : null}
      <span className="worktree-review__file-meta">
        {file.binary ? (
          <Badge>{t('review.binaryBadge')}</Badge>
        ) : (
          <>
            <span className="worktree-review__adds" aria-hidden="true">{`+${file.additions}`}</span>
            <span className="worktree-review__dels" aria-hidden="true">{`−${file.deletions}`}</span>
            <span className="ui-visually-hidden">{t('review.counts.file', { additions: t('review.linesAdded', { count: file.additions }), deletions: t('review.linesDeleted', { count: file.deletions }) })}</span>
          </>
        )}
        {mustOpen ? <Badge tone={opened ? 'success' : 'warning'}>{opened ? t('review.opened') : t('review.mustOpen')}</Badge> : null}
      </span>
    </button>
  );
}
