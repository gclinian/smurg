// 「匯入個人設定」 (SPEC R4): pick CLAUDE.md and the commands / skills folders from this computer, see what will be
// sent (and what is skipped, and why), send it with session.importConfig in requests under the size cap, and show
// what the host wrote. Files are read only when the person presses 「匯入」, one request's worth at a time.
import { useEffect, useId, useMemo, useState } from 'react';
import { IMPORT_CONFIG_FILE_MAX_BYTES } from '@smurg/protocol';
import { formatBytes } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog } from '../../ui/index.ts';
import { IconFileText, IconFolder } from '../../ui/icons.tsx';
import {
  IMPORT_MAX_TOTAL_BYTES,
  IMPORT_MAX_TOTAL_FILES,
  importPathFor,
  importTooBig,
  screenImport,
  splitImport,
  type ImportGroup,
  type SkipReason,
  type SkippedFile,
} from './import-config.ts';
import { describeSessionError } from './session-info.ts';
import { t } from './strings.ts';

interface PickedFile {
  readonly relPath: string;
  readonly size: number;
  readonly file: File;
}

type Progress =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly done: number; readonly total: number }
  | { readonly kind: 'done'; readonly written: readonly string[]; readonly error: string | null };

const REASON_KEY: Record<SkipReason, Parameters<typeof t>[0]> = {
  'too-large': 'import.reason.tooLarge',
  'not-allowed': 'import.reason.notAllowed',
  system: 'import.reason.system',
  unreadable: 'import.reason.unreadable',
};

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

export interface ImportConfigDialogProps {
  readonly open: boolean;
  onClose(): void;
}

export function ImportConfigDialog({ open, onClose }: ImportConfigDialogProps) {
  const stores = useStores();
  const userId = useStore(stores.workspace, selectUserId);
  // The daemon refuses an import while any of the member's sessions runs (it writes into the guest dir only then).
  const runningMine = useStore(stores.sessions, (state) =>
    userId === null ? 0 : [...state.sessions.values()].filter((session) => session.ownerUserId === userId && session.status !== 'exited').length,
  );
  const ids = { claudeMd: useId(), commands: useId(), skills: useId() };
  const [picked, setPicked] = useState<Record<ImportGroup, readonly File[]>>({ 'claude-md': [], commands: [], skills: [] });
  const [progress, setProgress] = useState<Progress>({ kind: 'idle' });

  useEffect(() => {
    if (open) return;
    setPicked({ 'claude-md': [], commands: [], skills: [] });
    setProgress({ kind: 'idle' });
  }, [open]);

  const plan = useMemo(() => {
    const candidates: PickedFile[] = [];
    for (const group of ['claude-md', 'commands', 'skills'] as const) {
      for (const file of picked[group]) candidates.push({ relPath: importPathFor(group, file), size: file.size, file });
    }
    return screenImport(candidates);
  }, [picked]);

  const totalBytes = plan.accepted.reduce((sum, file) => sum + file.size, 0);
  const tooBig = importTooBig(plan.accepted);
  const batchCount = tooBig ? 0 : splitImport(plan.accepted).length;
  const working = progress.kind === 'working';

  const choose = (group: ImportGroup, files: FileList | null): void => {
    setProgress({ kind: 'idle' });
    setPicked((previous) => ({ ...previous, [group]: files ? [...files] : [] }));
  };

  const run = async (): Promise<void> => {
    if (plan.accepted.length === 0 || tooBig || working || runningMine > 0) return;
    const written: string[] = [];
    const skipped: SkippedFile[] = [];
    // Planned on the sizes the picker reported; the bytes are read one request's worth at a time.
    const batches = splitImport(plan.accepted);
    setProgress({ kind: 'working', done: 0, total: batches.length });
    let error: string | null = null;
    sending: for (const [index, batch] of batches.entries()) {
      const contents: { relPath: string; content: Uint8Array; size: number }[] = [];
      for (const item of batch) {
        try {
          const content = await readBytes(item.file);
          // Sizes are re-checked on the bytes actually read (a file may have changed since it was picked).
          if (content.byteLength > IMPORT_CONFIG_FILE_MAX_BYTES) skipped.push({ relPath: item.relPath, reason: 'too-large' });
          else contents.push({ relPath: item.relPath, content, size: content.byteLength });
        } catch {
          skipped.push({ relPath: item.relPath, reason: 'unreadable' });
        }
      }
      // Split again on the real sizes, so a file that grew since it was picked cannot push a request over the cap.
      for (const part of splitImport(contents)) {
        try {
          written.push(...(await stores.sessions.importConfig(part.map(({ relPath, content }) => ({ relPath, content })))));
        } catch (failure) {
          const view = describeSessionError(failure);
          error = view.hint ? `${view.message} ${view.hint}` : view.message;
          break sending;
        }
      }
      setProgress({ kind: 'working', done: index + 1, total: batches.length });
    }
    if (error === null && skipped.length > 0) {
      error = skipped.map((item) => `${item.relPath}（${t(REASON_KEY[item.reason])}）`).join('、');
    }
    setProgress({ kind: 'done', written, error });
  };

  const picker = (group: ImportGroup, id: string, label: string, directory: boolean) => (
    <div className="agents-import__picker">
      <label htmlFor={id} className="agents-import__pick-label">
        {directory ? <IconFolder /> : <IconFileText />}
        <span>{label}</span>
      </label>
      <input
        id={id}
        type="file"
        className="agents-import__input"
        disabled={working}
        {...(directory ? { multiple: true, webkitdirectory: '' } : { accept: '.md,text/markdown,text/plain' })}
        onChange={(event) => choose(group, event.currentTarget.files)}
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('import.title')}
      description={t('import.lead')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {progress.kind === 'done' ? tApp('common.close') : tApp('common.cancel')}
          </Button>
          <Button variant="primary" loading={working} disabled={plan.accepted.length === 0 || tooBig || runningMine > 0} onClick={() => void run()}>
            {t('import.submit')}
          </Button>
        </>
      }
    >
      <div className="agents-import">
        {runningMine > 0 ? (
          <Banner tone="warning" live="status">
            {t('import.runningBlocked', { count: runningMine })}
          </Banner>
        ) : (
          <p className="agents-fieldset__note">{t('import.runningNote')}</p>
        )}
        <div className="agents-import__pickers">
          {picker('claude-md', ids.claudeMd, t('import.pick.claudeMd'), false)}
          {picker('commands', ids.commands, t('import.pick.commands'), true)}
          {picker('skills', ids.skills, t('import.pick.skills'), true)}
        </div>

        {plan.accepted.length === 0 && plan.skipped.length === 0 ? (
          <p className="agents-fieldset__note">{t('import.empty')}</p>
        ) : (
          <section aria-label={t('import.list', { count: plan.accepted.length, size: formatBytes(totalBytes) })}>
            <h3 className="agents-import__heading">{t('import.list', { count: plan.accepted.length, size: formatBytes(totalBytes) })}</h3>
            <ul className="agents-import__files">
              {plan.accepted.map((item) => (
                <li key={item.relPath}>
                  <code>{item.relPath}</code>
                  <span>{formatBytes(item.size)}</span>
                </li>
              ))}
            </ul>
            {plan.skipped.length > 0 ? (
              <>
                <h3 className="agents-import__heading">{t('import.skipped', { count: plan.skipped.length })}</h3>
                <ul className="agents-import__files agents-import__files--skipped">
                  {plan.skipped.map((item, index) => (
                    <li key={`${item.relPath}-${index}`}>
                      <code>{item.relPath}</code>
                      <span>{t(REASON_KEY[item.reason])}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {batchCount > 1 ? <p className="agents-fieldset__note">{t('import.batches', { count: batchCount })}</p> : null}
          </section>
        )}

        {tooBig ? (
          <Banner tone="warning" live="status">
            {t('import.tooMany', { max: IMPORT_MAX_TOTAL_FILES, size: formatBytes(IMPORT_MAX_TOTAL_BYTES) })}
          </Banner>
        ) : null}

        {progress.kind === 'working' ? (
          <p role="status">{t('import.working', { done: progress.done, total: progress.total })}</p>
        ) : null}
        {progress.kind === 'done' ? (
          <div role="status" className="agents-import__result">
            {progress.written.length > 0 ? (
              <Banner tone="success" live="none" title={t('import.done', { count: progress.written.length })}>
                <ul className="agents-import__files">
                  {progress.written.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </Banner>
            ) : null}
            {progress.error !== null ? (
              <Banner tone={progress.written.length > 0 ? 'warning' : 'danger'} live="none">
                {progress.written.length > 0 ? t('import.partial', { message: progress.error }) : t('import.failed', { message: progress.error })}
              </Banner>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
