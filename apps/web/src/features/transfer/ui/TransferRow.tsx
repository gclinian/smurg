// One job of the transfers panel: what it is, where it goes, progress (bytes, files, speed, time left), its state,
// what went wrong in words, and the actions that make sense in that state.
import type { ReactNode } from 'react';
import { Badge, Button, IconDownload, IconUpload, type Tone } from '../../../ui/index.ts';
import type { TransferJob } from '../../../lib/stores/transfers.ts';
import type { JobSnapshot } from '../engine/types.ts';
import { t } from '../strings.ts';
import { describeFailure, describeProgress, describeRejected, describeSkip, describeStatus, describeTarget } from './describe.ts';

export interface RowActions {
  pause(id: string): void;
  resume(id: string): void;
  cancel(id: string): void;
  retry(id: string): void;
  dismiss(id: string): void;
  save(id: string): void;
  pickFiles(id: string, folder: boolean): void;
  reauthorize(id: string): void;
}

export interface RowExtras {
  readonly hasOutput: boolean;
  /** Interrupted by a reload: waiting for its files to be chosen again. */
  readonly interrupted: boolean;
  /** The interrupted upload came from a folder (choose a folder, not files). */
  readonly folder: boolean;
  /** Chromium kept handles: 「允許讀取並繼續」 without a picker. */
  readonly handles: boolean;
}

const STATUS_TONE: Record<JobSnapshot['status'], Tone> = {
  queued: 'neutral',
  preparing: 'info',
  running: 'info',
  paused: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** The shared store's record of a job the Worker has not reported yet (just queued). */
export function snapshotOf(job: TransferJob): JobSnapshot {
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    root: job.root,
    path: job.path,
    totalBytes: job.totalBytes,
    doneBytes: job.doneBytes,
    files: job.files,
    filesDone: 0,
    status: job.status,
    pause: null,
    verifying: false,
    bytesPerSecond: 0,
    failure: null,
    fileFailures: [],
    rejected: [],
    conflict: null,
    download: null,
    startedAt: job.startedAt,
  };
}

function ActionButton({ label, name, onClick, variant = 'secondary' }: { label: string; name: string; onClick(): void; variant?: 'secondary' | 'ghost' | 'danger' | 'primary' }) {
  return (
    <Button size="sm" variant={variant} onClick={onClick} aria-label={t('action.forName', { action: label, name })}>
      {label}
    </Button>
  );
}

export function TransferRow({ job, extras, actions }: { job: JobSnapshot; extras: RowExtras; actions: RowActions }) {
  const progress = describeProgress(job);
  const finished = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
  const barClass =
    job.status === 'done' ? 'transfer-progress--done' : job.status === 'failed' ? 'transfer-progress--failed' : progress.percent === null ? 'transfer-progress--indeterminate' : '';
  const buttons: ReactNode[] = [];
  if (extras.interrupted) {
    if (extras.handles) buttons.push(<ActionButton key="auth" label={t('action.reauthorize')} name={job.name} variant="primary" onClick={() => actions.reauthorize(job.id)} />);
    buttons.push(
      <ActionButton key="pick" label={extras.folder ? t('action.pickFolder') : t('action.pickFiles')} name={job.name} variant={extras.handles ? 'secondary' : 'primary'} onClick={() => actions.pickFiles(job.id, extras.folder)} />,
      <ActionButton key="discard" label={t('action.discard')} name={job.name} variant="ghost" onClick={() => actions.dismiss(job.id)} />,
    );
  } else {
    if (job.kind === 'upload' && (job.status === 'running' || job.status === 'preparing' || job.status === 'queued')) {
      buttons.push(<ActionButton key="pause" label={t('action.pause')} name={job.name} onClick={() => actions.pause(job.id)} />);
    }
    if (job.kind === 'upload' && job.status === 'paused' && job.pause === 'user') {
      buttons.push(<ActionButton key="resume" label={t('action.resume')} name={job.name} variant="primary" onClick={() => actions.resume(job.id)} />);
    }
    if (job.status === 'failed') buttons.push(<ActionButton key="retry" label={t('action.retry')} name={job.name} variant="primary" onClick={() => actions.retry(job.id)} />);
    if (job.status === 'done' && extras.hasOutput) buttons.push(<ActionButton key="save" label={t('action.save')} name={job.name} onClick={() => actions.save(job.id)} />);
    if (!finished) buttons.push(<ActionButton key="cancel" label={t('action.cancel')} name={job.name} variant="ghost" onClick={() => actions.cancel(job.id)} />);
    else buttons.push(<ActionButton key="dismiss" label={t('action.dismiss')} name={job.name} variant="ghost" onClick={() => actions.dismiss(job.id)} />);
  }

  const outcome = job.download;
  return (
    <li className="transfer-item" data-testid="transfer-item" data-status={job.status}>
      <span className="transfer-item__icon" aria-hidden="true">
        {job.kind === 'upload' ? <IconUpload /> : <IconDownload />}
      </span>
      <div className="transfer-item__head">
        <span className="transfer-item__name" title={job.name}>
          <span className="ui-visually-hidden">{t(`kind.${job.kind}`)}：</span>
          {job.name}
        </span>
        <Badge tone={STATUS_TONE[job.status]}>{describeStatus(job)}</Badge>
      </div>
      <div className="transfer-item__body">
        <span className="transfer-item__target" title={describeTarget(job)}>
          {describeTarget(job)}
        </span>
        <div
          className={`transfer-progress ${barClass}`}
          role="progressbar"
          aria-label={t('progress.label', { name: job.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(progress.percent !== null ? { 'aria-valuenow': progress.percent } : {})}
          aria-valuetext={progress.bytes}
        >
          <div className="transfer-progress__bar" style={progress.percent !== null ? { width: `${progress.percent}%` } : undefined} />
        </div>
        <div className="transfer-stats">
          <span>{progress.bytes}</span>
          {progress.files ? <span>{progress.files}</span> : null}
          {progress.speed ? <span>{progress.speed}</span> : null}
          {progress.remaining ? <span>{progress.remaining}</span> : null}
        </div>

        {job.failure ? (
          <p className="transfer-message transfer-message--danger" role="alert">
            {describeFailure(job.failure)}
          </p>
        ) : null}
        {job.fileFailures.length > 0 ? (
          <details className="transfer-details">
            <summary>{t('fail.files', { count: job.fileFailures.length })}</summary>
            <ul>
              {job.fileFailures.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>：{describeFailure(f.failure)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {job.rejected.length > 0 ? (
          <details className="transfer-details">
            <summary>{t('rejected.title', { count: job.rejected.length })}</summary>
            <ul>
              {job.rejected.map((r) => (
                <li key={r.path}>
                  <code>{r.path}</code>：{describeRejected(r.problem)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {outcome && job.status === 'done' ? (
          <>
            <p className="transfer-message">{outcome.savedAs === 'picker' ? t('download.savedPicker') : t('download.savedBlob')}</p>
            {outcome.zip64 ? <p className="transfer-message transfer-message--warning">{t('download.zip64')}</p> : null}
            {outcome.skipped.length > 0 ? (
              <details className="transfer-details" open>
                <summary>{t('download.skipped', { count: outcome.skipped.length })}</summary>
                <ul>
                  {outcome.skipped.map((s) => (
                    <li key={s.path}>
                      <code>{s.path}</code>：{describeSkip(s.reason)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
        <div className="transfer-actions">{buttons}</div>
      </div>
    </li>
  );
}
