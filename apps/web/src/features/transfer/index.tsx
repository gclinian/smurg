// The transfers panel (bottom drawer tab) and the handlers of the `startUpload` and `download` commands (SPEC R7
// upload / download, D15). The work itself runs in the transfer Worker (client/transfer-client.ts); jobs belong to
// the workspace session, so they keep running while the person navigates inside the app.
import { useMemo, useRef, type ChangeEvent } from 'react';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectTransferList } from '../../lib/stores/transfers.ts';
import { useCommand, useCommandHandler, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { Banner, Button, ChunkNotice, EmptyState, IconUpload, chunkToast, useToast, type ToastInput } from '../../ui/index.ts';
import { transferClientFor, type TransferClient, type TransferClientState } from './client/transfer-client.ts';
import type { JobSnapshot } from './engine/types.ts';
import { t } from './strings.ts';
import './transfer.css';
import { ConflictDialog } from './ui/ConflictDialog.tsx';
import { TransferRow, snapshotOf, type RowActions } from './ui/TransferRow.tsx';

export type TransfersPanelProps = Record<never, never>;

type SaveFilePicker = (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;

function workerProblem(state: TransferClientState): string | null {
  switch (state.worker) {
    case 'unavailable':
      return t('worker.unavailable');
    case 'no-storage':
      return t('worker.noStorage');
    case 'failed':
      return t('worker.failed', { message: state.workerError ?? '' });
    default:
      return null;
  }
}

/**
 * What an upload or a download that cannot start says, or null when it can. A Worker whose file did not come (gone
 * after a deploy, offline) says what a chunk says, with "Reload the page"; anything else keeps its own words.
 */
function cannotStart(state: TransferClientState): ToastInput | null {
  if (state.workerFile !== null) return chunkToast(state.workerFile);
  const problem = workerProblem(state);
  return problem === null ? null : { tone: 'danger', title: problem };
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Registers the command handlers of the feature (the files panel dispatches them). */
function useTransferCommands(client: TransferClient): void {
  const toast = useToast();
  const showPanel = useCommand('showPanel');
  const reveal = (): void => {
    showPanel({ panel: 'transfers' }).catch(() => {});
  };

  useCommandHandler('startUpload', async ({ root, targetDir, source }) => {
    const problem = cannotStart(client.store.getState());
    if (problem) {
      toast.show(problem);
      return;
    }
    const started = await client.upload(root, targetDir, source);
    if (started.id === null) {
      toast.show({ tone: 'warning', title: t('toast.nothingToUpload') });
      return;
    }
    reveal();
  });

  useCommandHandler('download', async ({ file, zip }) => {
    // FIRST, synchronously inside the click that dispatched the command: the save picker needs the user activation
    // (transfer.md §1.7). Chromium only; elsewhere the Worker stages in OPFS or memory.
    const pick = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    const problem = cannotStart(client.store.getState());
    if (problem) {
      toast.show(problem);
      return;
    }
    let picker: FileSystemFileHandle | undefined;
    if (typeof pick === 'function') {
      const base = file.path === '' ? t('target.downloadRoot') : (file.path.split('/').at(-1) ?? file.path);
      try {
        picker = await pick.call(window, { suggestedName: zip === true ? `${base}.zip` : base });
      } catch (error) {
        if (isAbort(error)) return; // the person closed the dialog: no download
        // No activation any more (e.g. dispatched later) or not allowed: fall back to staging in the Worker.
      }
    }
    client.download(file, zip === true, picker);
    reveal();
  });
}

export function TransfersPanel(_props: TransfersPanelProps) {
  const session = useWorkspaceSession();
  const client = useMemo(() => transferClientFor(session), [session]);
  const list = useStore(session.stores.transfers, selectTransferList, shallowEqual);
  const state = useStore(client.store);
  const toast = useToast();
  useTransferCommands(client);

  const pickingFor = useRef<string | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const resumeWith = async (id: string, files: File[]): Promise<void> => {
    const matched = await client.resumeInterrupted(id, { kind: 'files', files });
    if (matched === 0) toast.show({ tone: 'warning', title: t('toast.resumeMismatch') });
  };

  const onPicked = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    const id = pickingFor.current;
    pickingFor.current = null;
    if (id !== null && files.length > 0) void resumeWith(id, files);
  };

  const actions: RowActions = {
    pause: (id) => client.pause(id),
    resume: (id) => client.resume(id),
    cancel: (id) => client.cancel(id),
    retry: (id) => client.retry(id),
    dismiss: (id) => client.dismiss(id),
    save: (id) => client.saveOutput(id),
    pickFiles: (id, folder) => {
      pickingFor.current = id;
      (folder ? folderInput : filesInput).current?.click();
    },
    reauthorize: (id) => {
      const handles = state.interrupted.get(id)?.handles;
      if (!handles) return;
      void (async () => {
        // requestPermission is the first await: it still has the click's user activation.
        for (const handle of Object.values(handles)) {
          const request = (handle as FileSystemHandle & { requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState> }).requestPermission;
          const granted = request ? await request.call(handle, { mode: 'read' }) : 'denied';
          if (granted !== 'granted') {
            actions.pickFiles(id, true);
            return;
          }
        }
        try {
          const source = await client.sourceFromHandles(handles);
          const matched = await client.resumeInterrupted(id, source);
          if (matched === 0) toast.show({ tone: 'warning', title: t('toast.resumeMismatch') });
        } catch {
          toast.show({ tone: 'warning', title: t('toast.resumeMismatch') });
        }
      })();
    },
  };

  const rows: JobSnapshot[] = orderTransfers(
    list.map((job) => state.jobs.get(job.id) ?? snapshotOf(job)),
    (job) => state.interrupted.has(job.id),
  );
  const conflictJob = rows.find((job) => job.conflict !== null) ?? null;
  const problem = workerProblem(state);
  const anyFinished = rows.some((job) => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled');

  // The Worker's file did not come: nothing here can work until the page is reloaded, and the panel says that in its
  // place, as a column whose chunk did not come does (never "drag files here").
  if (state.workerFile !== null) {
    return (
      <section className="transfer-panel" aria-label={t('panel.label')}>
        <ChunkNotice error={state.workerFile} />
      </section>
    );
  }

  return (
    <section className="transfer-panel" aria-label={t('panel.label')}>
      {problem ? (
        <Banner tone="danger" live="status">
          {problem}
        </Banner>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState compact icon={<IconUpload />} title={t('empty.title')} description={t('empty.hint')} />
      ) : (
        <>
          <div className="transfer-toolbar">
            <span>{t('active', { count: rows.filter((job) => job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled').length })}</span>
            <Button size="sm" variant="ghost" disabled={!anyFinished} onClick={() => client.clearFinished()}>
              {t('action.clear')}
            </Button>
          </div>
          <ul className="transfer-list" aria-label={t('list.label')}>
            {rows.map((job) => {
              const interrupted = state.interrupted.get(job.id);
              return (
                <TransferRow
                  key={job.id}
                  job={job}
                  actions={actions}
                  extras={{
                    hasOutput: state.outputs.has(job.id),
                    interrupted: interrupted !== undefined,
                    folder: interrupted?.files.some((f) => f.path.includes('/')) ?? false,
                    handles: interrupted?.handles !== null && interrupted?.handles !== undefined && Object.keys(interrupted.handles).length > 0,
                  }}
                />
              );
            })}
          </ul>
        </>
      )}
      <input ref={filesInput} className="transfer-hidden-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={onPicked} />
      <input
        ref={folderInput}
        className="transfer-hidden-input"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onPicked}
        {...({ webkitdirectory: '' } as Record<string, string>)}
      />
      <ConflictDialog job={conflictJob} onAnswer={(id, policy) => client.answer(id, policy)} />
    </section>
  );
}

const FINISHED: ReadonlySet<JobSnapshot['status']> = new Set(['done', 'failed', 'cancelled']);

/**
 * Running, waiting and interrupted transfers first, then the finished ones; newest first within each group (review
 * The active upload sat below the finished rows, out of view in the 220 px panel).
 */
export function orderTransfers(rows: readonly JobSnapshot[], interrupted: (job: JobSnapshot) => boolean): JobSnapshot[] {
  const rank = (job: JobSnapshot): number => (interrupted(job) || !FINISHED.has(job.status) ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}
