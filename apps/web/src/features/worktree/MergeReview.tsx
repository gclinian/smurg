// The review of one merge request (SPEC R9: the host sees the full diff and merges after confirming; on a conflict the files in conflict are listed).
//
// The host sees the COMPLETE change list with additions / deletions and each file's diff. When worktree.merge.diff was
// cut (1 MiB) the files it could not show completely are marked "Open separately" and fetched one by one with
// worktree.merge.fileDiff; "Merge into the main workspace" stays disabled until every one of them was opened (diff-model.ts decides
// which, failing closed). The worktree owner may open the same view read-only (the daemon allows owner or host).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MergeRequest } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Badge, Banner, Button, Dialog, Input, Spinner, useToast } from '../../ui/index.ts';
import { buildReviewModel, hasInvisible, parseDiffLines, revealInvisible, shortCommit, unopenedPaths, type MergeDiff, type MergeFileDiff, type ReviewFile } from './diff-model.ts';
import { fileStatusLabel, isDecidable, requestStatusLabel } from './labels.ts';
import { ConflictDetails } from './MergeRequestItem.tsx';
import { t } from './strings.ts';
import { reasonProblem } from './text-check.ts';

type Load<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly message: string };

/** Lines of one file's diff rendered at first; "Show more" adds this many again (a 1 MiB diff is ~30,000 lines). */
export const DIFF_LINES_STEP = 2_000;

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

type Mode = 'idle' | 'confirm-approve' | 'reject';

function MergeReview({ requestId, onClose }: { requestId: string; onClose(): void }) {
  const stores = useStores();
  const toast = useToast();
  const hintId = useId();
  const canDecide = useCan('worktree.merge.decide');
  const request = useStore(stores.worktrees, (state) => state.mergeRequests.get(requestId) ?? null);
  const worktree = useStore(stores.worktrees, (state) => (request ? (state.worktrees.get(request.worktreeId) ?? null) : null));
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load<MergeDiff>>({ status: 'loading' });
  const [fileDiffs, setFileDiffs] = useState<ReadonlyMap<string, Load<MergeFileDiff>>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    stores.worktrees.diff(requestId).then(
      (value) => {
        if (current) setLoad({ status: 'ready', value });
      },
      (failure: unknown) => {
        if (current) setLoad({ status: 'error', message: describeError(failure) });
      },
    );
    return () => {
      current = false;
    };
  }, [stores.worktrees, requestId, attempt]);

  const model = useMemo(() => (load.status === 'ready' ? buildReviewModel(load.value) : null), [load]);

  const fetchFile = (path: string): void => {
    requested.current.add(path);
    setFileDiffs((previous) => new Map(previous).set(path, { status: 'loading' }));
    const settle = (next: Load<MergeFileDiff>): void => {
      if (alive.current) setFileDiffs((previous) => new Map(previous).set(path, next));
    };
    stores.worktrees.fileDiff(requestId, path).then(
      (value) => {
        // Only the file that was asked for counts as opened (fail closed on a mismatched answer).
        if (value.path === path) {
          settle({ status: 'ready', value });
          return;
        }
        requested.current.delete(path);
        settle({ status: 'error', message: tApp('error.generic') });
      },
      (failure: unknown) => {
        requested.current.delete(path);
        settle({ status: 'error', message: describeError(failure) });
      },
    );
  };

  const select = (entry: ReviewFile): void => {
    const path = entry.file.path;
    setSelected(path);
    if (entry.section === null && !requested.current.has(path)) fetchFile(path);
  };

  // Show the first file as soon as the list is there.
  useEffect(() => {
    const first = model?.files[0];
    if (first && selected === null) select(first);
    // `select` is stable enough: it only reads refs and setters.
  }, [model]);

  const opened = useMemo(() => {
    const set = new Set<string>();
    for (const [path, state] of fileDiffs) if (state.status === 'ready') set.add(path);
    return set;
  }, [fileDiffs]);
  const remaining = model ? unopenedPaths(model, opened) : [];
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
        toast.show({ tone: 'success', title: t('review.merged', { name: request.requestedBy.displayName }) });
        onClose();
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
      toast.show({ tone: 'success', title: t('review.rejected', { name: request.requestedBy.displayName }) });
      onClose();
    } catch (failure) {
      if (alive.current) setError(t('review.failed', { message: describeError(failure) }));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const name = request?.requestedBy.displayName ?? '';
  const selectedEntry = model?.files.find((entry) => entry.file.path === selected) ?? null;
  const nextUnopened = remaining.find((path) => fileDiffs.get(path)?.status !== 'loading');

  const footer = !decidable ? (
    <Button variant="ghost" onClick={onClose}>
      {tApp('common.close')}
    </Button>
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
        label={t('review.rejectReason', { name })}
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
      <Button variant="ghost" onClick={onClose}>
        {tApp('common.close')}
      </Button>
      <Button variant="danger" onClick={() => setMode('reject')}>
        {t('review.reject')}
      </Button>
      <Button variant="primary" disabled={blocked} aria-describedby={remaining.length > 0 ? hintId : undefined} onClick={() => setMode('confirm-approve')}>
        {request?.status === 'conflict' ? t('review.retryApprove') : t('review.approve')}
      </Button>
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      className="worktree-review-dialog"
      title={canDecide ? t('review.title', { name }) : t('review.titleReadOnly', { name })}
      footer={footer}
    >
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
          <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('review.reload')}</Button>}>
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
          <span className="worktree-review__message-label">{t('review.message', { name: request.requestedBy.displayName })}</span>
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

function FileDiffView({ entry, fetched, onRetry }: { entry: ReviewFile; fetched: Load<MergeFileDiff> | undefined; onRetry(): void }) {
  const path = entry.file.path;
  const [limit, setLimit] = useState(DIFF_LINES_STEP);
  const source: { text: string; truncated: boolean; binary: boolean } | null =
    entry.section !== null
      ? { text: entry.section, truncated: false, binary: entry.file.binary === true }
      : fetched?.status === 'ready'
        ? { text: fetched.value.diff, truncated: fetched.value.truncated, binary: fetched.value.binary || entry.file.binary === true }
        : null;
  const lines = useMemo(() => (source ? parseDiffLines(source.text) : []), [source?.text]);
  const hidden = useMemo(() => lines.some((line) => hasInvisible(line.text)), [lines]);

  if (!source) {
    if (fetched?.status === 'error') {
      return (
        <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={onRetry}>{tApp('common.retry')}</Button>}>
          {t('review.fileFailed', { path, message: fetched.message })}
        </Banner>
      );
    }
    return (
      <p className="worktree-review__loading">
        <Spinner size={14} decorative /> {t('review.fileLoading', { path })}
      </p>
    );
  }
  const hasHunks = lines.some((line) => line.kind === 'hunk');
  const shown = lines.slice(0, limit);
  return (
    <section className="worktree-diff" aria-label={t('review.diffLabel', { path })}>
      {source.truncated ? (
        <Banner tone="warning" live="none">
          {t('review.fileTruncated')}
        </Banner>
      ) : null}
      {hidden ? (
        <Banner tone="warning" live="none">
          {t('review.hiddenChars')}
        </Banner>
      ) : null}
      {source.binary ? <p className="worktree-diff__note">{t('review.binary')}</p> : !hasHunks ? <p className="worktree-diff__note">{t('review.noTextChange')}</p> : null}
      <pre className="worktree-diff__code">
        {shown.map((line, index) => (
          <span key={index} className={`worktree-diff__line worktree-diff__line--${line.kind}`}>
            <span className="worktree-diff__num" aria-hidden="true">
              {line.oldLine ?? ''}
            </span>
            <span className="worktree-diff__num" aria-hidden="true">
              {line.newLine ?? ''}
            </span>
            <span className="worktree-diff__text">
              {revealInvisible(line.text).map((piece, at) =>
                piece.codePoint !== undefined ? (
                  <span key={at} className="worktree-diff__hidden" title={t('review.hiddenChar', { code: piece.codePoint })}>
                    {`⟨${piece.codePoint}⟩`}
                  </span>
                ) : (
                  piece.text
                ),
              )}
            </span>
            {'\n'}
          </span>
        ))}
      </pre>
      {lines.length > limit ? (
        <Button size="sm" onClick={() => setLimit((n) => n + DIFF_LINES_STEP)}>
          {t('review.showMore', { count: lines.length - limit })}
        </Button>
      ) : null}
    </section>
  );
}
